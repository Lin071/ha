"""Number entities for the Hoymiles Micro Storage integration.

V0.6.4 writes three of its control groups through one object payload each (§38
fan, §40 heat, §42 fine_ctrl), and describes them in a ``meta`` topic.  A Home
Assistant ``number`` can only publish a scalar, and one entity per *field*
would have to guess the other fields to build a complete object.  The document
therefore invites a self-developed integration layer to map every entry of
``controls`` to its own entity - which is what this module does.  Partial writes
are documented as supported, so each entity sends only the field it owns.

**Per phase output power** (§9 / §17)
    Still an object payload the firmware rejects unless all three phases are
    present, so setting one phase publishes the complete object built from the
    other two last known values.

**Charge / discharge cut-off SOC** (§33 - §36)
    Deliberately **not** re-created: V0.6.4 turned them into two independent
    scalar numbers on their own topics, so the firmware's own discovery entities
    are usable as they are.  (V0.6.2 had one object-taking ``soc_limit`` topic,
    which is why this module used to replace it.)  The bundled card still sends
    both values, because they only make sense as a pair.

**Fan target levels** (§37 / §38) and **heating param** (§39 / §40)
    Created only when the matching ``meta`` topic arrives, because only the
    device knows whether it has a fan or a heater at all.

**Fine-grained control** (§41 / §42)
    ``grid_p`` and ``pv_power`` are numbers here; the three switches live in
    ``switch.py``.

Values the device reports (``soc_h``, ``soc_l``, ``fan_target``, ``heat.mode`` /
``heat.param``, ``grid_p``, ``pv_power``) are read back from the state event
(§32) instead of being remembered locally, so a number always shows what is
actually in force - including changes made by another client or by the device.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable

from homeassistant.components.number import (
    NumberEntity,
    NumberEntityDescription,
    NumberMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfEnergy, UnitOfPower
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    CONF_DEV_ID,
    DOMAIN,
    FAN_LEVEL_MAX,
    FAN_LEVEL_MIN,
    FEED_POWER_MAX,
    FEED_POWER_MIN,
    FINE_GRID_MAX,
    FINE_GRID_MIN,
    FINE_GRID_STEP,
    HEAT_PACK_MAX,
    HEAT_PACK_MIN,
    HEAT_POWER_MAX,
    HEAT_POWER_MIN,
    HEAT_TEMP_MAX,
    HEAT_TEMP_MIN,
    MANUFACTURER,
    METER_CTRL_MAX,
    METER_CTRL_MIN,
    METER_CTRL_STEP,
    METER_ENERGY_MAX,
    METER_ENERGY_MIN,
    METER_ENERGY_STEP,
    PHASE_A,
    PHASE_B,
    PHASE_C,
    PHASE_HOUSE_IN_POWER_MAX,
    PHASE_HOUSE_IN_POWER_MIN,
    PHASE_INPUT_POWER_MAX,
    PHASE_INPUT_POWER_MIN,
    PHASE_LIMIT_STEP,
    PHASE_POWER_MAX,
    PHASE_POWER_MIN,
    PHASE_POWER_STEP,
    PV_POWER_MAX,
    PV_POWER_MIN,
    ROLE_ANY,
    ROLE_MASTER_ONLY,
    ROLE_MASTER_SINGLE,
    ROLE_MULTIPHASE_MASTER,
    SRC_FAN_META,
    SRC_FEED_META,
    SRC_FINE_META,
    SRC_HEAT_META,
    SRC_METER_META,
    SRC_PHASE_HOUSE_IN_META,
    SRC_PHASE_INPUT_META,
    device_family,
)
from .coordinator import HoymilesCoordinator
from .discovery_override import FirmwareDiscoveryPatcher


def _number(value: Any) -> float | None:
    """Return a real number, ignoring None, bools and strings."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


@dataclass(frozen=True)
class HoymilesNumberDescription(NumberEntityDescription):
    """Number description carrying the payload field it controls."""

    # ``phase`` for the multi phase group, ``soc_h`` / ``soc_l`` for the two
    # cut-offs, ``fan`` for the fan levels, ``heat`` / ``fine`` for the groups
    # described by a ``meta`` topic.
    group: str = ""
    # Which field of the published object this entity owns (``phase_a``, ``pcs``).
    field: str = ""
    # Requires this discovery object to exist before the entity is created.
    requires: str = ""
    # Requires this ``meta`` source before the entity is created.
    meta_source: str = ""
    # For a meta group: the ``controls`` entry this entity represents.
    control: str = ""
    # Reads the current value out of the coordinator; None means "not known".
    value_fn: Callable[[HoymilesCoordinator], float | None] | None = None


def _fan_target(fan: str) -> Callable[[HoymilesCoordinator], float | None]:
    """Read ``fan_target.<fan>`` from the state event.

    ``fan_actual`` reports 255 for a fan that is not fitted, but
    ``fan_target`` does not, so no sentinel handling is needed here.
    """

    def _fn(coordinator: HoymilesCoordinator) -> float | None:
        target = coordinator.event_value("fan_target")
        if not isinstance(target, dict):
            return None
        return _number(target.get(fan))

    return _fn


def _heat(coordinator: HoymilesCoordinator) -> dict[str, Any]:
    """The device's current heating setting (§32 ``heat``)."""
    value = coordinator.event_value("heat")
    return value if isinstance(value, dict) else {}


def _heat_param(coordinator: HoymilesCoordinator) -> float | None:
    """``heat.param`` - watts in ``power`` mode, degrees in ``temp`` mode."""
    return _number(_heat(coordinator).get("param"))


def _heat_mode(coordinator: HoymilesCoordinator) -> str | None:
    """``heat.mode``, which decides the unit and range of ``heat.param``."""
    value = _heat(coordinator).get("mode")
    return value if isinstance(value, str) else None


def _fine(coordinator: HoymilesCoordinator, field: str) -> float | None:
    """One field of the fine control block (§32)."""
    return _number(coordinator.event_value(field))


def _phase_limit(group: str, phase: str) -> Callable[[HoymilesCoordinator], float | None]:
    """Read one phase of a V0.6.6 limit group out of the state event.

    §46 republishes ``phase_input_power`` / ``phase_house_in_power`` as objects
    of **configuration values** (they are not live measurements), so the event
    echo wins over whatever was last written here - exactly like
    ``phase_output_power``.
    """

    def _fn(coordinator: HoymilesCoordinator) -> float | None:
        reported = coordinator.event_value(group)
        if isinstance(reported, dict):
            value = _number(reported.get(phase))
            if value is not None:
                return value
        known = coordinator.phase_limit(group, phase)
        return None if known is None else float(known)

    return _fn


def _feed_limit(coordinator: HoymilesCoordinator) -> float | None:
    """``feed_power.limit`` from the state event (§46).

    V0.6.7 made the feed-in ceiling a group: §46 echoes the whole object
    (``enable`` + ``limit``) as **configuration values**, so the device's echo
    is the authority - there is no local copy to fall back to.
    """
    reported = coordinator.event_value("feed_power")
    if isinstance(reported, dict):
        return _number(reported.get("limit"))
    return None


# Entity ``group`` -> the §46 state event field that echoes it.
_PHASE_LIMIT_GROUPS = {
    "phase_input": "phase_input_power",
    "phase_house_in": "phase_house_in_power",
}


NUMBER_DESCRIPTIONS: tuple[HoymilesNumberDescription, ...] = (
    # --- per phase output power (always available) -------------------------
    HoymilesNumberDescription(
        key="phase_a_output_power",
        name="Phase A Output Power",
        group="phase",
        field=PHASE_A,
        native_min_value=PHASE_POWER_MIN,
        native_max_value=PHASE_POWER_MAX,
        native_step=PHASE_POWER_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
    ),
    HoymilesNumberDescription(
        key="phase_b_output_power",
        name="Phase B Output Power",
        group="phase",
        field=PHASE_B,
        native_min_value=PHASE_POWER_MIN,
        native_max_value=PHASE_POWER_MAX,
        native_step=PHASE_POWER_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
    ),
    HoymilesNumberDescription(
        key="phase_c_output_power",
        name="Phase C Output Power",
        group="phase",
        field=PHASE_C,
        native_min_value=PHASE_POWER_MIN,
        native_max_value=PHASE_POWER_MAX,
        native_step=PHASE_POWER_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
    ),
    # --- charge / discharge cut-off SOC (§33 - §36) ------------------------
    # **Not** re-created here.  V0.6.4 made them two independent scalar numbers
    # on their own topics, so the firmware's own discovery entities are already
    # usable - unlike the single object-taking ``soc_limit`` that this module
    # had to replace in V0.6.2.  Duplicating them would only give the dashboard
    # two pairs of identical controls.
    # --- fan target levels (§37 / §38) ------------------------------------
    HoymilesNumberDescription(
        key="pcs_fan_speed",
        name="PCS Fan Speed",
        group="fan",
        field="pcs",
        meta_source=SRC_FAN_META,
        control="target",
        value_fn=_fan_target("pcs"),
        native_min_value=FAN_LEVEL_MIN,
        native_max_value=FAN_LEVEL_MAX,
        native_step=1,
        icon="mdi:fan",
    ),
    HoymilesNumberDescription(
        key="battery_fan_speed",
        name="Battery Fan Speed",
        group="fan",
        field="bat",
        meta_source=SRC_FAN_META,
        control="target",
        value_fn=_fan_target("bat"),
        native_min_value=FAN_LEVEL_MIN,
        native_max_value=FAN_LEVEL_MAX,
        native_step=1,
        icon="mdi:fan",
    ),
    # --- heater parameter (§39 / §40) -------------------------------------
    # One entity, because §39 says ``param`` is a single scalar whose *meaning*
    # is decided by the mode - splitting it would produce two numbers that show
    # the same value and fight over who owns it.
    HoymilesNumberDescription(
        key="heat_param",
        name="Heating Setpoint",
        group="heat",
        field="param",
        meta_source=SRC_HEAT_META,
        control="param",
        value_fn=_heat_param,
        # The range and the unit are switched per mode in the entity below.
        native_min_value=HEAT_POWER_MIN,
        native_max_value=HEAT_POWER_MAX,
        native_step=1,
        icon="mdi:radiator",
    ),
    # --- fine control (§41 / §42) -----------------------------------------
    HoymilesNumberDescription(
        key="fine_grid_power",
        name="Grid Power Setpoint",
        group="fine",
        field="grid_p",
        meta_source=SRC_FINE_META,
        control="grid_p",
        value_fn=lambda c: _fine(c, "grid_p"),
        native_min_value=FINE_GRID_MIN,
        native_max_value=FINE_GRID_MAX,
        native_step=FINE_GRID_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:transmission-tower",
    ),
    HoymilesNumberDescription(
        key="pv_power_limit",
        name="PV Power Limit",
        group="fine",
        field="pv_power",
        meta_source=SRC_FINE_META,
        control="pv_power",
        value_fn=lambda c: _fine(c, "pv_power"),
        native_min_value=PV_POWER_MIN,
        native_max_value=PV_POWER_MAX,
        native_step=1,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:solar-power-variant",
    ),
    # --- virtual meter (§11 / §12, V0.6.5) ---------------------------------
    # Three independent controls behind ONE ``set`` topic that takes an object.
    # The device never reports them back, so the entities show the last value
    # that was written (restored across a restart) - there is no state topic to
    # read a "real" reading from, and the simulated meter has no reality of its
    # own.
    #
    # The range and the step are read from ``controls.<key>`` of the meta topic
    # at runtime, not hard coded: §11 makes the device the authority on the band
    # (a model may offer less than -5000..5000 W).
    HoymilesNumberDescription(
        key="meter_power",
        name="Meter Power",
        group="meter",
        field="power",
        meta_source=SRC_METER_META,
        control="power",
        native_min_value=METER_CTRL_MIN,
        native_max_value=METER_CTRL_MAX,
        native_step=METER_CTRL_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:meter-electric",
    ),
    HoymilesNumberDescription(
        key="meter_eng_out",
        name="Meter Output Energy",
        group="meter",
        field="eng_out",
        meta_source=SRC_METER_META,
        control="eng_out",
        native_min_value=METER_ENERGY_MIN,
        native_max_value=METER_ENERGY_MAX,
        native_step=METER_ENERGY_STEP,
        native_unit_of_measurement=UnitOfEnergy.WATT_HOUR,
        icon="mdi:transmission-tower-export",
    ),
    HoymilesNumberDescription(
        key="meter_eng_in",
        name="Meter Input Energy",
        group="meter",
        field="eng_in",
        meta_source=SRC_METER_META,
        control="eng_in",
        native_min_value=METER_ENERGY_MIN,
        native_max_value=METER_ENERGY_MAX,
        native_step=METER_ENERGY_STEP,
        native_unit_of_measurement=UnitOfEnergy.WATT_HOUR,
        icon="mdi:transmission-tower-import",
    ),
    # --- per phase input limit (§27 / §28, V0.6.6) -------------------------
    # One object, three controls, all three phases in every message - the same
    # shape as the per phase *output* ceiling above, but described by a ``meta``
    # topic (so the entities are created here) and 仅多相主机.
    #
    # §27 says ``max`` follows the system type, hence the range is read from
    # ``controls.<phase>`` at runtime and the constants are only the fallback.
    HoymilesNumberDescription(
        key="phase_a_input_power",
        name="Phase A Input Limit",
        group="phase_input",
        field=PHASE_A,
        meta_source=SRC_PHASE_INPUT_META,
        control=PHASE_A,
        value_fn=_phase_limit("phase_input_power", PHASE_A),
        native_min_value=PHASE_INPUT_POWER_MIN,
        native_max_value=PHASE_INPUT_POWER_MAX,
        native_step=PHASE_LIMIT_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:transmission-tower-import",
    ),
    HoymilesNumberDescription(
        key="phase_b_input_power",
        name="Phase B Input Limit",
        group="phase_input",
        field=PHASE_B,
        meta_source=SRC_PHASE_INPUT_META,
        control=PHASE_B,
        value_fn=_phase_limit("phase_input_power", PHASE_B),
        native_min_value=PHASE_INPUT_POWER_MIN,
        native_max_value=PHASE_INPUT_POWER_MAX,
        native_step=PHASE_LIMIT_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:transmission-tower-import",
    ),
    HoymilesNumberDescription(
        key="phase_c_input_power",
        name="Phase C Input Limit",
        group="phase_input",
        field=PHASE_C,
        meta_source=SRC_PHASE_INPUT_META,
        control=PHASE_C,
        value_fn=_phase_limit("phase_input_power", PHASE_C),
        native_min_value=PHASE_INPUT_POWER_MIN,
        native_max_value=PHASE_INPUT_POWER_MAX,
        native_step=PHASE_LIMIT_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:transmission-tower-import",
    ),
    # --- feed-in limit (§29 / §30, V0.6.7) ---------------------------------
    # The ceiling on what may be exported to the grid.  V0.6.7 turned it into a
    # ``meta`` group with an ``enable`` switch (switch.py) and this limit, both
    # behind one object-taking ``set`` topic - so the entity is created here and
    # publishes an object, never the scalar a firmware entity used to send.
    # Role: 仅主机, so a stand-alone unit and a slave never get it.
    HoymilesNumberDescription(
        key="feed_power_limit",
        name="Feed Power Limit",
        group="feed",
        field="limit",
        meta_source=SRC_FEED_META,
        control="limit",
        value_fn=_feed_limit,
        native_min_value=FEED_POWER_MIN,
        native_max_value=FEED_POWER_MAX,
        native_step=1,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:transmission-tower-export",
    ),
    # --- per phase house input limit (§31 / §32, V0.6.6) -------------------
    # "How much each phase may draw for the house" - the same wire shape as the
    # input limit above, but a separate topic and a separate limit.
    HoymilesNumberDescription(
        key="phase_a_house_in_power",
        name="House A Input Limit",
        group="phase_house_in",
        field=PHASE_A,
        meta_source=SRC_PHASE_HOUSE_IN_META,
        control=PHASE_A,
        value_fn=_phase_limit("phase_house_in_power", PHASE_A),
        native_min_value=PHASE_HOUSE_IN_POWER_MIN,
        native_max_value=PHASE_HOUSE_IN_POWER_MAX,
        native_step=PHASE_LIMIT_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:home-import-outline",
    ),
    HoymilesNumberDescription(
        key="phase_b_house_in_power",
        name="House B Input Limit",
        group="phase_house_in",
        field=PHASE_B,
        meta_source=SRC_PHASE_HOUSE_IN_META,
        control=PHASE_B,
        value_fn=_phase_limit("phase_house_in_power", PHASE_B),
        native_min_value=PHASE_HOUSE_IN_POWER_MIN,
        native_max_value=PHASE_HOUSE_IN_POWER_MAX,
        native_step=PHASE_LIMIT_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:home-import-outline",
    ),
    HoymilesNumberDescription(
        key="phase_c_house_in_power",
        name="House C Input Limit",
        group="phase_house_in",
        field=PHASE_C,
        meta_source=SRC_PHASE_HOUSE_IN_META,
        control=PHASE_C,
        value_fn=_phase_limit("phase_house_in_power", PHASE_C),
        native_min_value=PHASE_HOUSE_IN_POWER_MIN,
        native_max_value=PHASE_HOUSE_IN_POWER_MAX,
        native_step=PHASE_LIMIT_STEP,
        native_unit_of_measurement=UnitOfPower.WATT,
        icon="mdi:home-import-outline",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the numbers, adding the optional ones as they are announced.

    Forwarded platforms resolve against the integration root package, so an
    inverter entry arrives here too; ``inverter/number.py`` is never imported by
    Home Assistant itself.
    """
    dev_id: str = entry.data.get(CONF_DEV_ID, "")
    if device_family(dev_id) == "inverter":
        from .inverter import number as _inverter_number  # noqa: PLC0415

        await _inverter_number.async_setup_entry(hass, entry, async_add_entities)
        return

    coordinator: HoymilesCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    patcher: FirmwareDiscoveryPatcher = hass.data[DOMAIN][entry.entry_id]["patcher"]
    dev_id = hass.data[DOMAIN][entry.entry_id]["dev_id"]

    # Entities that need no capability are created straight away.
    async_add_entities(
        [
            HoymilesNumber(coordinator, dev_id, description)
            for description in NUMBER_DESCRIPTIONS
            if not description.requires and not description.meta_source
        ]
    )

    added: set[str] = set()

    def _add_pending() -> None:
        """Create every entity whose capability is now known.

        Two different kinds of capability are involved and both are checked on
        every trigger, because they arrive independently:

        * the SOC limits come from a discovery config (§33 / §35), recorded by
          the firmware patcher;
        * the fan, heater and fine-control groups come from a ``meta`` topic
          (§37 / §39 / §41), which only says what the unit can actually do.
        """
        capabilities = patcher.capabilities
        pending = [
            description
            for description in NUMBER_DESCRIPTIONS
            if description.key not in added
            and (
                (description.requires and description.requires in capabilities)
                or (
                    description.meta_source
                    and coordinator.data.get(description.meta_source) is not None
                )
            )
        ]
        if not pending:
            return
        for description in pending:
            added.add(description.key)
        async_add_entities(
            [
                HoymilesNumber(coordinator, dev_id, description)
                for description in pending
            ]
        )

    entry.async_on_unload(patcher.async_add_capability_listener(lambda _caps: _add_pending()))
    entry.async_on_unload(coordinator.async_add_listener(_add_pending))
    _add_pending()


class HoymilesNumber(
    CoordinatorEntity[HoymilesCoordinator], NumberEntity, RestoreEntity
):
    """One numeric control of the device."""

    _attr_has_entity_name = True
    # No device_class on purpose: ``NumberDeviceClass`` only exists from Home
    # Assistant 2024.1 and hacs.json keeps 2023.8 as the minimum version.
    _attr_mode = NumberMode.BOX
    entity_description: HoymilesNumberDescription

    def __init__(
        self,
        coordinator: HoymilesCoordinator,
        dev_id: str,
        description: HoymilesNumberDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._dev_id = dev_id
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_{description.key}"
        self._attr_name = description.name
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
        )
        # Only the phase group needs this: the device never reports those back.
        # ``_restored`` also carries the virtual meter readings, which have no
        # state topic either.
        self._restored: float | None = None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """The heater's target packs, so the card can show what it is heating.

        ``heat.pack_ids`` (§32) is a **list**, and Home Assistant has no
        multi-value entity: an exhaustive ``select`` would force a single
        choice, which the protocol explicitly rejects.  The list therefore rides
        along as an attribute of the one heater entity, which is what the
        bundled card reads to seed its pack chips.
        """
        if self.entity_description.group != "heat":
            return None
        packs = _heat(self.coordinator).get("pack_ids")
        if not isinstance(packs, list):
            return None
        ids = sorted(
            int(pack) for pack in packs
            if isinstance(pack, (int, float))
            and HEAT_PACK_MIN <= int(pack) <= HEAT_PACK_MAX
        )
        return {"pack_ids": ids}

    @property
    def available(self) -> bool:
        """True while the device is pushing and the role allows the control."""
        if not self.coordinator.available:
            return False
        return self.coordinator.allows(self._role_scope())

    def _role_scope(self) -> str:
        """The 角色 line of the topic this entity writes.

        §23/§24 (per phase output ceiling), §27/§28 (per phase input limit) and
        §31/§32 (per phase house input limit) are 仅多相主机.  §11/§12 (virtual
        meter) and §25/§26 (input ceiling) are 主机和单机.  §29/§30 (feed-in
        limit, a ``meta`` group since V0.6.7) is **仅主机**.  Everything else
        this platform owns - fan (§37/§38), heater (§39/§40), fine control
        (§13/§14) - is 不限.
        """
        group = self.entity_description.group
        if group in ("phase", "phase_input", "phase_house_in"):
            return ROLE_MULTIPHASE_MASTER
        if group == "meter":
            return ROLE_MASTER_SINGLE
        if group == "feed":
            return ROLE_MASTER_ONLY
        return ROLE_ANY

    # --- heater: the same number means watts or degrees -------------------
    # §39 says ``param`` is one scalar whose unit and range are decided by
    # ``mode``.  Exposing it as one entity is honest to the protocol, so the
    # dynamic properties below switch the range and unit with the mode the
    # device reports rather than shipping two numbers that share a value.
    def _heat_mode(self) -> str | None:
        return _heat_mode(self.coordinator)

    # --- virtual meter / per phase limits: the device owns the band ---------
    # §11 puts ``min`` / ``max`` / ``step`` / unit into ``controls.<key>`` of the
    # meta topic, so the slider follows the device instead of a constant that
    # goes stale the moment a model or a firmware changes it.  §27 / §31 use the
    # same shape for the two per phase limit groups (their ``max`` "随系统类型变化").
    def _meta_bound(self, name: str, fallback: float) -> float:
        entry = self.coordinator.group_control(
            self.entity_description.meta_source, self.entity_description.control
        )
        value = entry.get(name) if isinstance(entry, dict) else None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return float(fallback)
        return float(value)

    def _band_from_meta(self) -> bool:
        """Whether this entity's range is declared by its ``meta`` topic."""
        return self.entity_description.group in (
            "meter", "phase_input", "phase_house_in", "feed"
        )

    @property
    def native_min_value(self) -> float:
        if self.entity_description.group == "heat":
            return HEAT_TEMP_MIN if self._heat_mode() == "temp" else HEAT_POWER_MIN
        if self._band_from_meta():
            return self._meta_bound("min", self.entity_description.native_min_value)
        return self.entity_description.native_min_value

    @property
    def native_max_value(self) -> float:
        if self.entity_description.group == "heat":
            return HEAT_TEMP_MAX if self._heat_mode() == "temp" else HEAT_POWER_MAX
        if self._band_from_meta():
            return self._meta_bound("max", self.entity_description.native_max_value)
        return self.entity_description.native_max_value

    @property
    def native_step(self) -> float | None:
        if self._band_from_meta():
            return self._meta_bound("step", self.entity_description.native_step)
        return self.entity_description.native_step

    @property
    def native_unit_of_measurement(self) -> str | None:
        if self.entity_description.group == "heat":
            return "°C" if self._heat_mode() == "temp" else UnitOfPower.WATT
        if self._band_from_meta():
            entry = self.coordinator.group_control(
                self.entity_description.meta_source, self.entity_description.control
            )
            unit = entry.get("unit_of_measurement") if isinstance(entry, dict) else None
            return unit if isinstance(unit, str) and unit else \
                self.entity_description.native_unit_of_measurement
        return self.entity_description.native_unit_of_measurement

    def _snap(self, value: float) -> float:
        """Round a reported value to the resolution this entity declares.

        The firmware keeps these setpoints as single-precision floats, so a
        value written as ``-158.3`` is reported back as ``-158.300003051758``.
        That is a float32 artefact, not a different reading, and letting it into
        the entity state put six meaningless decimals into the card, the history
        and every template that formatted the number.  ``native_step`` already
        says how coarse the control is (0.1 W for ``grid_p``, whole units for
        the rest), so it is the right thing to round to.
        """
        step = self.entity_description.native_step
        try:
            step = float(step)
        except (TypeError, ValueError):
            return value
        if step <= 0:
            return value
        # 0.1 -> 1 decimal, 1.0 -> 0 decimals, 0.5 -> 1 decimal.
        decimals = max(0, -int(math.floor(math.log10(step)))) if step < 1 else 0
        return round(float(value), decimals)

    @property
    def native_value(self) -> float | None:
        """Return the value the device reports, or the last commanded one."""
        if self.entity_description.value_fn is not None:
            value = self.entity_description.value_fn(self.coordinator)
            if value is not None:
                return self._snap(value)

        if self.entity_description.group == "phase":
            # §32 reports the limits actually in force, so it wins over the last
            # commanded value (which may have been rejected or changed by
            # another client).  The command echo is the fallback for firmware
            # that does not report ``phase_output_power``.
            reported = self.coordinator.event_value("phase_output_power")
            if isinstance(reported, dict):
                value = _number(reported.get(self.entity_description.field))
                if value is not None:
                    return value
            value = self.coordinator.phase_output.get(self.entity_description.field)
            return None if value is None else float(value)

        if self.entity_description.group == "meter":
            # Nothing to read back: the device does not report the simulated
            # meter, so the last written value is the state.
            value = self.coordinator.meter.get(self.entity_description.field)
            if value is not None:
                return float(value)
            return None if self._restored is None else float(self._restored)

        return None

    async def async_added_to_hass(self) -> None:
        """Restore the last value so a restart does not lose the other field."""
        await super().async_added_to_hass()

        last_state = await self.async_get_last_state()
        if last_state is None or last_state.state in ("unknown", "unavailable", ""):
            return

        try:
            number = float(last_state.state)
        except (TypeError, ValueError):
            return

        # The virtual meter's power keeps one decimal (§11 step 0.1); every other
        # control on this platform is a whole unit (watts, levels, percent).
        description = self.entity_description
        if description.group == "meter" and description.field == "power":
            value = round(number, 1)
        else:
            value = int(number)

        self._restored = value
        if description.group == "phase":
            self.coordinator.restore_phase_output(description.field, value)
        elif description.group in ("phase_input", "phase_house_in"):
            # §28 / §32 reject a partial object, so the three phases always travel
            # together - seeding the coordinator keeps the other two at the value
            # they had before the restart instead of dropping to the band's floor.
            self.coordinator.restore_phase_limit(
                _PHASE_LIMIT_GROUPS[description.group], description.field, value
            )
        elif description.group == "meter":
            # Seed the coordinator so the lease re-publishes a complete object
            # right after a restart, instead of only the field that was touched.
            self.coordinator.meter.setdefault(description.field, value)

    # ------------------------------------------------------------------
    # commands
    # ------------------------------------------------------------------
    async def async_set_native_value(self, value: float) -> None:
        """Publish the new value on the topic its group uses.

        Each group now has a payload the document explicitly allows to be
        partial, so only the field this entity owns is sent - the device keeps
        the rest.  The SOC cut-offs are the exception: each is a scalar on its
        own topic, and the *gap* rule is enforced here because the device
        silently drops a value that breaks it (§34 / §36).
        """
        group = self.entity_description.group
        field = self.entity_description.field

        # Refuse a topic the document does not define for this role (§23/§24,
        # §11/§12).  The entity is `unavailable` already, but a service or an
        # automation can still call it, and a slave must not be written to.
        scope = self._role_scope()
        if scope != ROLE_ANY:
            self.coordinator.require_role(scope, self.entity_description.name or "")

        if group == "phase":
            await self.coordinator.async_set_phase_output(field, int(round(value)))
            return

        if group in ("phase_input", "phase_house_in"):
            # §28 / §32: all three phases in one message, the other two taken from
            # the values already in force.
            await self.coordinator.async_set_phase_limit(
                _PHASE_LIMIT_GROUPS[group], field, int(round(value))
            )
            return

        if group == "fan":
            # Only the fan that was edited is sent: §38 accepts a partial target
            # and the other fan keeps its level.
            if field == "pcs":
                await self.coordinator.async_set_fan(pcs=int(round(value)))
            else:
                await self.coordinator.async_set_fan(bat=int(round(value)))
            return

        if group == "heat":
            mode = self._heat_mode()
            param = int(round(value))
            if mode == "temp":
                lo, hi = HEAT_TEMP_MIN, HEAT_TEMP_MAX
            else:
                lo, hi = HEAT_POWER_MIN, HEAT_POWER_MAX
            # ``disable`` carries no usable ``param`` (the firmware ignores it),
            # so the mode is left out of the message: sending it would assert a
            # state the user did not touch, and §40 lets an omitted ``mode``
            # keep whatever the device is running.
            await self.coordinator.async_set_heat(
                mode=None if mode in (None, "disable") else mode,
                param=min(max(param, lo), hi),
            )
            return

        if group == "fine":
            await self.coordinator.async_set_fine_ctrl(**{field: round(value, 1)})
            return

        if group == "feed":
            # §30: the limit rides an object, because the same topic also carries
            # the ``enable`` switch.  A partial object keeps ``enable`` as it is.
            await self.coordinator.async_set_feed_power(limit=int(round(value)))
            return

        if group == "meter":
            # §12 carries an object, and every field has its own resolution:
            # watts are tenths, the two energy readings are whole watt-hours.
            if field == "power":
                await self.coordinator.async_set_meter_ctrl(power=round(value, 1))
            else:
                await self.coordinator.async_set_meter_ctrl(
                    **{field: int(round(value))}
                )

