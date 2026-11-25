"""Switch entities for the Hoymiles Micro Storage integration.

Two families of switches come from a ``meta`` topic:

* the fine-grained control block (protocol §13 / §14), which has three on/off
  controls - ``chg_off``, ``dchg_off`` and ``eps_relay`` (whose wire values are
  ``close`` / ``open`` rather than ``ON`` / ``OFF``);
* the two **group enable** switches added in V0.6.7: ``feed_power.enable``
  (§29 / §30) and ``phase_house_in_power.enable`` (§31 / §32).

Each group is written through one topic that takes an object, so an entity sends
only its own field (the document says a partial payload keeps the others).  They
are created from the group's ``meta`` payload, which states which controls the
unit actually has - offering a switch for a field the device does not implement
would be a no-op that looks like a bug.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from homeassistant.components.switch import SwitchEntity, SwitchEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    DOMAIN,
    MANUFACTURER,
    ROLE_ANY,
    ROLE_MASTER_ONLY,
    ROLE_MULTIPHASE_MASTER,
    SRC_FEED_META,
    SRC_FINE_META,
    SRC_PHASE_HOUSE_IN_META,
)
from .coordinator import HoymilesCoordinator

# ``eps_relay`` is not a boolean on the wire; these are the payload values.
EPS_CLOSED = "close"
EPS_OPEN = "open"


@dataclass(frozen=True)
class HoymilesSwitchDescription(SwitchEntityDescription):
    """Switch description bound to one field of a ``meta`` group."""

    # The ``controls`` entry that must exist for this switch to be created.
    control: str = ""
    # Wire field name inside the group's ``set`` object.
    field: str = ""
    # Which ``meta`` source describes the group (and therefore the capability).
    meta_source: str = SRC_FINE_META
    # Which writer the entity uses: ``fine`` / ``feed`` / ``house``.
    kind: str = "fine"
    # Reads the current state out of the coordinator; None means "not known".
    value_fn: Callable[[HoymilesCoordinator], bool | None] | None = None


def _bool_field(field: str) -> Callable[[HoymilesCoordinator], bool | None]:
    def _fn(coordinator: HoymilesCoordinator) -> bool | None:
        value = coordinator.event_value(field)
        return value if isinstance(value, bool) else None

    return _fn


def _group_enable(field: str) -> Callable[[HoymilesCoordinator], bool | None]:
    """``<field>.enable`` of one of the two V0.6.7 group objects (§46)."""

    def _fn(coordinator: HoymilesCoordinator) -> bool | None:
        value = coordinator.event_value(field)
        if not isinstance(value, dict):
            return None
        flag = value.get("enable")
        return flag if isinstance(flag, bool) else None

    return _fn


def _eps_closed(coordinator: HoymilesCoordinator) -> bool | None:
    """``eps_relay`` as a switch state: on = relay closed = off-grid output on."""
    value = coordinator.event_value("eps_relay")
    if value == EPS_CLOSED:
        return True
    if value == EPS_OPEN:
        return False
    return None


SWITCH_DESCRIPTIONS: tuple[HoymilesSwitchDescription, ...] = (
    HoymilesSwitchDescription(
        key="charge_forbid",
        name="Charge Forbidden",
        control="chg_off",
        field="chg_off",
        value_fn=_bool_field("chg_off"),
        icon="mdi:battery-lock",
    ),
    HoymilesSwitchDescription(
        key="discharge_forbid",
        name="Discharge Forbidden",
        control="dchg_off",
        field="dchg_off",
        value_fn=_bool_field("dchg_off"),
        icon="mdi:battery-lock-open",
    ),
    HoymilesSwitchDescription(
        key="eps_relay",
        name="Off-Grid Relay",
        control="eps_relay",
        field="eps_relay",
        value_fn=_eps_closed,
        icon="mdi:electric-switch",
    ),
    # --- V0.6.7 §29 / §30: is exporting to the grid allowed at all? ---------
    # Kept apart from the limit, which keeps its value while this is off (§29:
    # turning it back on restores the configured ceiling, not 0 W).
    HoymilesSwitchDescription(
        key="feed_power_enable",
        name="Feed Power Enable",
        control="enable",
        field="enable",
        meta_source=SRC_FEED_META,
        kind="feed",
        value_fn=_group_enable("feed_power"),
        icon="mdi:transmission-tower-export",
    ),
    # --- V0.6.7 §31 / §32: is the per phase house input limit in force? -----
    HoymilesSwitchDescription(
        key="house_input_enable",
        name="House Input Enable",
        control="enable",
        field="enable",
        meta_source=SRC_PHASE_HOUSE_IN_META,
        kind="house",
        value_fn=_group_enable("phase_house_in_power"),
        icon="mdi:home-import-outline",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create each switch once its ``meta`` topic lists the control."""
    coordinator: HoymilesCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    dev_id: str = hass.data[DOMAIN][entry.entry_id]["dev_id"]

    added: set[str] = set()

    def _sync() -> None:
        pending = [
            description
            for description in SWITCH_DESCRIPTIONS
            if description.key not in added
            and coordinator.data.get(description.meta_source) is not None
            and coordinator.group_control(
                description.meta_source, description.control
            )
            is not None
        ]
        if not pending:
            return
        for description in pending:
            added.add(description.key)
        async_add_entities(
            [HoymilesSwitch(coordinator, dev_id, description) for description in pending]
        )

    entry.async_on_unload(coordinator.async_add_listener(_sync))
    _sync()


class HoymilesSwitch(CoordinatorEntity[HoymilesCoordinator], SwitchEntity):
    """One field of the fine-grained control block."""

    _attr_has_entity_name = True
    entity_description: HoymilesSwitchDescription

    def __init__(
        self,
        coordinator: HoymilesCoordinator,
        dev_id: str,
        description: HoymilesSwitchDescription,
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

    @property
    def available(self) -> bool:
        if not self.coordinator.available:
            return False
        return self.coordinator.allows(self._role_scope())

    def _role_scope(self) -> str:
        """The 角色 line of the topic this switch writes.

        §13/§14 (fine control) are 角色: 不限; §29/§30 (feed-in) are **仅主机**;
        §31/§32 (per phase house input) are **仅多相主机**.  The entity is created
        from the meta topic the device only publishes for a role that may use it,
        but the role can change while the entry stays loaded, so the gate is
        checked here as well.
        """
        kind = self.entity_description.kind
        if kind == "feed":
            return ROLE_MASTER_ONLY
        if kind == "house":
            return ROLE_MULTIPHASE_MASTER
        return ROLE_ANY

    @property
    def is_on(self) -> bool | None:
        value_fn = self.entity_description.value_fn
        return value_fn(self.coordinator) if value_fn else None

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._write(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._write(False)

    async def _write(self, on: bool) -> None:
        description = self.entity_description
        if description.kind == "feed":
            await self.coordinator.async_set_feed_power(enable=on)
            return
        if description.kind == "house":
            await self.coordinator.async_set_house_in_enable(on)
            return
        field = description.field
        if field == "eps_relay":
            # The relay takes ``close`` / ``open``, not ``ON`` / ``OFF``.
            await self.coordinator.async_set_fine_ctrl(
                eps_relay=EPS_CLOSED if on else EPS_OPEN
            )
            return
        await self.coordinator.async_set_fine_ctrl(**{field: on})
