"""Data coordinator for the Hoymiles Micro Storage integration.

The firmware pushes state over MQTT; this coordinator subscribes to the topics
and fans the decoded JSON out to the entities.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from . import mqtt_util
from .power_repeat import get_manager as get_repeat_manager
from .power_repeat import get_topic_manager
from .dashboard import async_set_system_view
from .const import (
    AVAILABILITY_STARTUP_GRACE_SECONDS,
    AVAILABILITY_WATCHDOG_SECONDS,
    DOMAIN,
    EMS_MODE_ECHO_GUARD_SECONDS,
    EMS_MODE_FINE_CTRL,
    EMS_MODE_METER,
    EMS_MODE_MQTT_CTRL,
    EMS_MODES,
    FAST_SOURCES,
    METER_FIELDS,
    PAYLOAD_AVAILABLE,
    PAYLOAD_NOT_AVAILABLE,
    PHASE_HOUSE_IN_POWER_MIN,
    PHASE_INPUT_POWER_MIN,
    PHASE_POWER_MIN,
    PHASES,
    ROLE_ANY,
    ROLE_MASTER,
    ROLE_MASTER_ONLY,
    ROLE_MASTER_SINGLE,
    ROLE_MULTIPHASE_MASTER,
    ROLE_SCOPE_LABEL,
    ROLE_SINGLE,
    ROLE_SLAVE,
    SANKEY_HISTORY_DAYS,
    SANKEY_LOAD_CONS,
    SANKEY_PV_PROD,
    SOURCE_STALE_SECONDS,
    SRC_ALARM,
    SRC_DEVICE,
    SRC_EVENT,
    SRC_FAN_META,
    SRC_FEED_META,
    SRC_FINE_META,
    SRC_HEAT_META,
    SRC_METER_META,
    SRC_PHASE_HOUSE_IN_META,
    SRC_PHASE_INPUT_META,
    SRC_QUICK,
    SRC_SANKEY,
    SRC_SYSTEM,
    SRC_TOU_DAY_ACK,
    SRC_TOU_STATUS,
    SRC_TOU_WEEK_ACK,
    T_ALARM_STATE,
    T_AVAILABILITY,
    T_DEVICE_STATE,
    T_EMS_MODE_CMD,
    T_EMS_MODE_STATE,
    T_EVENT_STATE,
    T_FAN_META,
    T_FAN_SET,
    T_FEED_POWER_META,
    T_FEED_POWER_SET,
    T_FINE_CTRL_META,
    T_FINE_CTRL_SET,
    T_HEAT_META,
    T_HEAT_SET,
    T_INPUT_POWER_SET,
    T_MASTER_AVAILABILITY,
    T_METER_CTRL_META,
    T_METER_CTRL_SET,
    T_PHASE_AVAILABILITY,
    T_PHASE_HOUSE_IN_META,
    T_PHASE_HOUSE_IN_SET,
    T_PHASE_INPUT_META,
    T_PHASE_INPUT_SET,
    T_PHASE_OUTPUT_POWER_SET,
    T_QUICK_STATE,
    T_ROLE_AVAILABILITY,
    T_SANKEY_STATE,
    T_SOC_H_LIMIT_SET,
    T_SOC_L_LIMIT_SET,
    T_SYSTEM_STATE,
    T_TOU_DAY_ACK,
    T_TOU_STATUS,
    T_TOU_WEEK_ACK,
    ems_modes_for_role,
)

_LOGGER = logging.getLogger(__name__)

# (coordinator data key, topic template, qos)
SUBSCRIPTIONS: tuple[tuple[str, str, int], ...] = (
    (SRC_QUICK, T_QUICK_STATE, 0),
    (SRC_DEVICE, T_DEVICE_STATE, 1),
    (SRC_SYSTEM, T_SYSTEM_STATE, 1),
    (SRC_TOU_STATUS, T_TOU_STATUS, 1),
    (SRC_TOU_DAY_ACK, T_TOU_DAY_ACK, 1),
    (SRC_TOU_WEEK_ACK, T_TOU_WEEK_ACK, 1),
    # V0.6.2 (§32, §27, §45)
    (SRC_EVENT, T_EVENT_STATE, 1),
    (SRC_ALARM, T_ALARM_STATE, 1),
    (SRC_SANKEY, T_SANKEY_STATE, 1),
    # V0.6.4 group descriptions (§37, §39, §41).  Retained, so a subscriber that
    # starts later than the device still receives them.
    (SRC_FAN_META, T_FAN_META, 1),
    (SRC_HEAT_META, T_HEAT_META, 1),
    (SRC_FINE_META, T_FINE_CTRL_META, 1),
    # V0.6.5 §11: the virtual meter joined the same pattern, and with it the two
    # cumulative energy readings that the old single-value topic did not have.
    (SRC_METER_META, T_METER_CTRL_META, 1),
    # V0.6.6 §27 / §31: the two per phase limit groups (a multi phase master
    # only - a unit that does not have them simply never publishes them).
    (SRC_PHASE_INPUT_META, T_PHASE_INPUT_META, 1),
    (SRC_PHASE_HOUSE_IN_META, T_PHASE_HOUSE_IN_META, 1),
    # V0.6.7 §29: the feed-in group (enable + limit behind one object).  Only a
    # master publishes it - §29 is 角色: 仅主机.
    (SRC_FEED_META, T_FEED_POWER_META, 1),
)


class HoymilesCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Push-driven coordinator backed by MQTT subscriptions."""

    def __init__(self, hass: HomeAssistant, dev_id: str) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN}-{dev_id}",
            update_interval=None,
        )
        self.dev_id = dev_id
        self.data = {}
        # Last commanded per phase output limit (protocol §15).  Populated from
        # the command topic itself, so values written by the firmware entity or
        # by any other client are picked up too.
        self.phase_output: dict[str, int] = {}
        # V0.6.6 §27 / §31: the last commanded per phase input / house input
        # limits, keyed by the event field that echoes them (``phase_input_power``
        # / ``phase_house_in_power``).  All three phases always travel together,
        # so this is what lets one slider keep the other two at their known value.
        self.phase_limits: dict[str, dict[str, int]] = {
            "phase_input_power": {},
            "phase_house_in_power": {},
        }
        # Last written virtual meter values (§12 ``power`` / ``eng_out`` /
        # ``eng_in``).  The device never reports them back, so this is the only
        # source of truth for what the simulated meter is showing - and the
        # baseline the lease re-publishes.
        self.meter: dict[str, float] = {}
        # How many times the virtual meter has been *written* since the EMS mode
        # last changed, plus the newest object.  The card shows this so a user
        # can tell "the external meter is posting" from "the last value is just
        # being repeated": the lease re-publishes the same object on its own, and
        # those repeats deliberately do not count here.
        self.meter_rx: dict[str, Any] = {
            "count": 0,
            "at": None,
            "source": None,
            "fields": {},
        }
        # The EMS mode the **device** last reported (`event/state` /
        # `system/state`), as opposed to the one we last commanded.  The virtual
        # meter counter only runs while this says `meter_ctrl`: an external meter
        # posting into a unit that is not in that mode would otherwise accumulate
        # a number that means nothing.
        self._ems_mode_reported: str | None = None
        # Last EMS mode we published, and when a command was issued.  Both drive
        # the state topic of the firmware's (otherwise optimistic) select.
        self._ems_mode_state: str | None = None
        self._ems_mode_command_time = 0.0
        # What the System view of the generated dashboard should look like for
        # this unit: ``True`` to keep it, ``False`` when it is a slave.  ``None``
        # until the device reports `role` (§32) - unknown keeps the page.
        self._system_view_keep: bool | None = None
        # The role the device reported (§32 ``role``): `single` / `master` /
        # `slave`.  ``None`` until the first state event, which is retained, so
        # this is normally known within a second of start-up.
        #
        # Every V0.6.5 topic carries a 角色 line, and a **slave** is excluded from
        # quite a few of them (EMS mode, power control, the virtual meter, TOU,
        # the power ceilings and `system/state`).  The entities and the cards read
        # this to hide or disable what the unit cannot do - and the write helpers
        # below refuse a command anyway, so a stale UI or an automation cannot
        # push a topic the document does not define for a slave.
        self._role: str | None = None
        # §32 only publishes `phase_output_power` on a multi phase master, so its
        # presence is the exact capability test - no model table.  ``None`` until
        # the first state event says either way.
        self._multiphase: bool | None = None
        # Last value published on the two role availability topics, so a state
        # event repeating the same role does not republish them.
        self._published_role_availability: dict[str, bool] = {}
        # Last capability flags the device reported (`has_meter`, `has_solar2`,
        # `has_plug`), kept so an offline unit is still drawn with the branches it
        # has.  Persisted alongside the sankey archive - see `_event_flag`.
        self._last_flags: dict[str, bool] = {}
        self._unsubscribes: list[Any] = []
        self._last_seen: dict[str, float] = {}
        # Wall-clock time of the newest message parsed from this unit, in epoch
        # seconds (0 = nothing yet).  ``_last_seen`` above is monotonic and only
        # exists for the availability windows; this one is answerable to the
        # cards, which use it to tell whether a device that is rebooting has
        # started publishing again.  The entity states cannot answer that:
        # Home Assistant drops a state update that repeats the value it already
        # had, so a unit that returns with the same readings leaves no trace.
        self._last_msg_wall: float = 0.0
        # None = no verdict yet.  Staying available until proven silent keeps a
        # Home Assistant restart from blanking out every entity instantly.
        self._available: bool | None = None
        # Last ``sankey/state`` snapshot, cached on disk.
        #
        # The topic is **not retained** and the firmware only publishes it when
        # the numbers change - on a quiet day (no grid import, no PV, battery
        # idle) that can be hours.  Without this cache the entity sat at
        # ``unknown`` after every Home Assistant restart and the sankey card said
        # "no energy recorded today" even though the device had reported a full
        # snapshot minutes earlier.
        #
        # The same file also carries a **per-day archive** (``_sankey_days``),
        # because these numbers are a daily cumulative: the last snapshot of a
        # day IS that day's final diagram, and the card can draw yesterday's or
        # the day before yesterday's one from it.  Both live in one Store so a
        # single write keeps them consistent.
        self._sankey_store = Store(hass, 1, f"{DOMAIN}.sankey_{dev_id}")
        self._sankey_cached_at: datetime | None = None
        # ``{YYYY-MM-DD: {"payload", "saved_at", "flags"}}``, local dates.
        self._sankey_days: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # availability
    # ------------------------------------------------------------------
    @property
    def available(self) -> bool:
        """Return True unless the device was proven to have gone silent."""
        return self._available is not False

    @property
    def last_message_ms(self) -> int:
        """When the last message from this unit arrived, in epoch milliseconds."""
        return int(self._last_msg_wall * 1000)

    @property
    def availability_topic(self) -> str:
        """Topic the patched discovery payloads subscribe to."""
        return mqtt_util.topic(T_AVAILABILITY, self.dev_id)

    # ------------------------------------------------------------------
    # device role (§32 `role`)
    # ------------------------------------------------------------------
    @property
    def role(self) -> str | None:
        """The role the device last reported: `single` / `master` / `slave`."""
        return self._role

    @property
    def system_view_keep(self) -> bool:
        """Should the generated dashboard keep its System view?

        ``True`` until the unit says it is a **slave**.  Every caller that
        rebuilds the dashboard has to pass this - the bundled template always
        contains the view, so writing the template on a slave puts the tab back
        unless it is removed again afterwards.
        """
        return self._system_view_keep is not False

    @property
    def is_slave(self) -> bool:
        """True only when the unit *said* it is a slave."""
        return self._role == ROLE_SLAVE

    @property
    def multiphase(self) -> bool | None:
        """Whether this unit is a multi phase master (§23/§24 topics)."""
        return self._multiphase

    @property
    def role_availability_topic(self) -> str:
        """`offline` while the unit is a slave - used by §7-§26 discoveries."""
        return mqtt_util.topic(T_ROLE_AVAILABILITY, self.dev_id)

    @property
    def phase_availability_topic(self) -> str:
        """`offline` unless the unit is a multi phase master (§23/§24)."""
        return mqtt_util.topic(T_PHASE_AVAILABILITY, self.dev_id)

    @property
    def master_availability_topic(self) -> str:
        """`offline` unless the unit is a master - a single unit is excluded.

        V0.6.6 §29/§30 (feed-in ceiling) are the first topics defined as 角色:
        仅主机, so "master or single" is too permissive for them.
        """
        return mqtt_util.topic(T_MASTER_AVAILABILITY, self.dev_id)

    def allows(self, scope: str) -> bool:
        """Can this unit use a topic whose 角色 line names ``scope``?

        ``ROLE_ANY`` is always allowed, and so is everything while the role is
        still unknown (a Home Assistant restart must not blank the UI before the
        retained state event lands).
        """
        if scope == ROLE_ANY or self._role is None:
            return True

        if scope == ROLE_MASTER_SINGLE:
            return self._role in (ROLE_MASTER, ROLE_SINGLE)

        if scope == ROLE_MASTER_ONLY:
            # A stand-alone unit is not a master: §29/§30 do not apply to it.
            return self._role == ROLE_MASTER

        if scope == ROLE_MULTIPHASE_MASTER:
            if self._role != ROLE_MASTER:
                return False
            # Still unknown: allow, so a master that has not reported the phase
            # block yet does not lose its per-phase controls.
            return self._multiphase is not False

        return True

    def require_role(self, scope: str, what: str) -> None:
        """Raise unless this unit may use ``what`` (§7-§26, §39)."""
        if self.allows(scope):
            return
        label = ROLE_SCOPE_LABEL.get(scope, scope)
        raise HomeAssistantError(
            f"{what} 仅支持{label}（协议限制），当前设备角色为 "
            f"{self._role or '未知'}，命令未下发。"
            f" / {what} is only defined for {label}; the device reports role "
            f"'{self._role or 'unknown'}', so nothing was sent."
        )

    @property
    def ems_modes(self) -> tuple[str, ...]:
        """The EMS modes this role may select (§7/§8 with the slave subset)."""
        return ems_modes_for_role(self._role)

    def require_ems_mode(self, mode: str) -> None:
        """Raise when this role may not run ``mode``.

        A **slave** may only run `general` (its own regulation) or `fine_ctrl`
        (§13/§14 are 角色: 不限).  The other three write system level setpoints
        that belong to the master, so they are refused here rather than silently
        ignored by a device that will never act on them.
        """
        if mode in self.ems_modes:
            return
        raise HomeAssistantError(
            f"EMS 模式 {mode} 在角色 {self._role or '未知'} 下不可用"
            f"（本机可用：{' / '.join(self.ems_modes)}），命令未下发。"
            f" / EMS mode '{mode}' is not available for role "
            f"'{self._role or 'unknown'}'; nothing was sent."
        )

    async def _async_publish_role_availability(self, force: bool = False) -> None:
        """Mirror the role onto the two availability topics.

        The firmware's own discovery entities cannot be switched off from
        Python, so `discovery_override.py` adds these topics to their
        ``availability`` list.  Publishing ``offline`` is what turns the EMS
        select / power ceilings of a **slave** into unavailable entities, which
        is the only way to keep a user from operating a topic the document does
        not define for that role.
        """
        wanted = {
            self.role_availability_topic: self.allows(ROLE_MASTER_SINGLE),
            self.phase_availability_topic: self.allows(ROLE_MULTIPHASE_MASTER),
            self.master_availability_topic: self.allows(ROLE_MASTER_ONLY),
        }
        for topic, allowed in wanted.items():
            if not force and self._published_role_availability.get(topic) == allowed:
                continue
            self._published_role_availability[topic] = allowed
            try:
                await mqtt_util.async_publish(
                    self.hass,
                    topic,
                    PAYLOAD_AVAILABLE if allowed else PAYLOAD_NOT_AVAILABLE,
                    qos=1,
                    retain=True,
                )
            except Exception:  # noqa: BLE001 - never break the entry on a publish
                _LOGGER.debug("Unable to publish role availability %s", topic, exc_info=True)

    @callback
    def _note_role(self, payload: dict[str, Any], source: str) -> None:
        """Remember the role / phase capability reported by the device."""
        changed = False

        role = payload.get("role")
        if isinstance(role, str) and role in (ROLE_SINGLE, ROLE_MASTER, ROLE_SLAVE):
            if self._role != role:
                became_slave = role == ROLE_SLAVE
                self._role = role
                changed = True
                _LOGGER.info("Device %s reports role %r", self.dev_id, role)
                if became_slave:
                    # A lease armed while the unit was a master must not keep
                    # publishing §10 / §12 topics after it demoted itself.
                    self.hass.async_create_task(self._async_stop_master_jobs())

        # §46 `system/state` has no `role`, but it does prove the unit is a
        # master or single unit (a slave never publishes it).  V0.6.6 added the
        # two per phase limit blocks to `event/state`; either of them is just as
        # good a proof that this unit is a multi phase master (§27 / §31 are
        # 仅多相主机, so only such a unit reports them at all).
        if source == SRC_EVENT:
            value = any(
                isinstance(payload.get(field), dict)
                for field in ("phase_output_power", "phase_input_power",
                              "phase_house_in_power")
            )
            if self._multiphase != value:
                self._multiphase = value
                changed = True

        if changed:
            self._apply_role_to_discovery()
            self.hass.async_create_task(self._async_publish_role_availability())

    @callback
    def _apply_role_to_discovery(self) -> None:
        """Hand the new role to the discovery patcher.

        The patcher owns the EMS option list, and filtering it needs the role:
        a slave sees `general` / `fine_ctrl`, a master or stand-alone unit sees
        all five.  Resolved through ``hass.data`` because the patcher is created
        by ``__init__`` while the coordinator may learn the role later.
        """
        for entry in self.hass.data.get(DOMAIN, {}).values():
            if not isinstance(entry, dict):
                continue
            if entry.get("dev_id") != self.dev_id:
                continue
            patcher = entry.get("patcher")
            if patcher is not None:
                patcher.set_role(self._role)
            return

    async def _async_stop_master_jobs(self) -> None:
        """Cancel the re-publish jobs of topics a slave may not own."""
        try:
            await get_repeat_manager(self.hass).async_stop(self.dev_id)
        except Exception:  # noqa: BLE001 - never break the handler
            _LOGGER.debug("Unable to stop power_ctrl repeat", exc_info=True)
        try:
            await get_topic_manager(self.hass).async_stop(self.dev_id, "meter_ctrl")
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Unable to stop meter_ctrl repeat", exc_info=True)

    async def async_setup(self) -> None:
        """Subscribe to all device topics and start the availability watchdog."""
        for key, template, qos in SUBSCRIPTIONS:
            unsub = await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(template, self.dev_id),
                self._make_handler(key),
                qos,
            )
            self._unsubscribes.append(unsub)

        # Watching our own command topic lets the per phase numbers learn about
        # values produced elsewhere (firmware entity, scripts, ...).
        self._unsubscribes.append(
            await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(T_PHASE_OUTPUT_POWER_SET, self.dev_id),
                self._handle_phase_output,
                1,
            )
        )

        # Likewise for the EMS mode: the select's own state topic is fed from
        # here, so a command must be echoed no matter who sent it.
        self._unsubscribes.append(
            await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(T_EMS_MODE_CMD, self.dev_id),
                self._handle_ems_mode_command,
                1,
            )
        )

        # §12: watch the virtual-meter write topic so a controller that publishes
        # straight to the broker is counted too. Our own publishes (the HTTP
        # endpoint, the entities and the 30 s repeat) are recognised by their
        # echo mark and skipped - see `mqtt_util.is_own_publish`.
        self._unsubscribes.append(
            await mqtt_util.mqtt.async_subscribe(
                self.hass,
                mqtt_util.topic(T_METER_CTRL_SET, self.dev_id),
                self._handle_meter_ctrl_set,
                1,
            )
        )

        self._unsubscribes.append(
            async_track_time_interval(
                self.hass,
                self._async_watchdog,
                timedelta(seconds=AVAILABILITY_WATCHDOG_SECONDS),
            )
        )

        # Mark the coordinator as healthy so CoordinatorEntity is available.
        # Seed the energy-flow snapshot first: it is the one payload the device
        # publishes only when it changes, so a restart in a quiet period would
        # otherwise show an empty sankey for hours.
        await self.async_restore_sankey()
        self.async_set_updated_data(dict(self.data))

        # A unit that was already silent when Home Assistant started must not keep
        # wearing its last readings until the first watchdog tick - the stamps
        # restored above say exactly how long it has been quiet.
        if self._evaluate_availability() is False:
            await self._async_publish_availability(False)
        else:
            # Nothing conclusive yet (no stamp survived, or the unit was alive a
            # minute ago): give it two minutes of grace, then call it offline if
            # not a single message arrived.  The device pushes `quick/state`
            # every second, so silence that long is not a hiccup.
            self._unsubscribes.append(
                async_call_later(
                    self.hass,
                    AVAILABILITY_STARTUP_GRACE_SECONDS,
                    self._async_startup_grace,
                )
            )

    async def async_shutdown(self) -> None:
        """Cancel all subscriptions and leave a usable retained state."""
        for unsub in self._unsubscribes:
            unsub()
        self._unsubscribes.clear()

        # The patched discovery payloads keep pointing at our availability topic
        # even after this entry is gone.  Publishing "online" while the device was
        # online leaves those entities usable instead of stranding them in
        # "unavailable" forever.
        if self._available:
            try:
                await mqtt_util.async_publish(
                    self.hass,
                    self.availability_topic,
                    PAYLOAD_AVAILABLE,
                    qos=1,
                    retain=True,
                )
            except Exception:  # noqa: BLE001
                _LOGGER.debug("Unable to publish final availability", exc_info=True)

        # Same for the two role topics: a leftover "offline" would keep the
        # firmware's own entities unavailable even though the gate is gone.
        for topic in (self.role_availability_topic, self.phase_availability_topic):
            try:
                await mqtt_util.async_publish(
                    self.hass, topic, PAYLOAD_AVAILABLE, qos=1, retain=True
                )
            except Exception:  # noqa: BLE001
                _LOGGER.debug(
                    "Unable to publish final role availability", exc_info=True
                )

    # ------------------------------------------------------------------
    # multi phase output power (protocol §15)
    # ------------------------------------------------------------------
    @callback
    def _handle_phase_output(self, msg: Any) -> None:
        """Track the per phase limits published on the command topic."""
        try:
            payload = json.loads(msg.payload)
        except (ValueError, TypeError):
            return
        if not isinstance(payload, dict):
            return

        updated = False
        for phase in PHASES:
            value = payload.get(phase)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            if self.phase_output.get(phase) != int(value):
                self.phase_output[phase] = int(value)
                updated = True

        if updated:
            self.async_set_updated_data(dict(self.data))

    @callback
    def restore_phase_output(self, phase: str, value: int) -> None:
        """Seed one phase from restored state (no MQTT traffic)."""
        if self.phase_output.get(phase) == value:
            return
        self.phase_output[phase] = value
        self.async_set_updated_data(dict(self.data))

    async def async_set_phase_output(self, phase: str, value: int) -> None:
        """Set one phase, keeping the other two at their last known value."""
        await self.async_set_phase_outputs({phase: value})

    async def async_set_phase_outputs(self, values: dict[str, int]) -> None:
        """Publish a complete phase output power command (protocol §15).

        The firmware rejects a partial payload, so every phase is always sent.
        §23 marks the topic 仅多相主机, so a single phase or slave unit refuses
        the command here instead of pushing a topic it may not own.
        """
        self.require_role(ROLE_MULTIPHASE_MASTER, "分相输出功率上限")
        payload: dict[str, int] = {}
        unknown: list[str] = []

        for phase in PHASES:
            if phase in values:
                payload[phase] = int(values[phase])
                continue
            known = self.phase_output.get(phase)
            if known is None:
                unknown.append(phase)
                payload[phase] = PHASE_POWER_MIN
            else:
                payload[phase] = int(known)

        if unknown:
            _LOGGER.warning(
                "Phase output power: %s had no known value yet and defaults to %s W. "
                "Set all three phases, or use hoymiles.set_phase_output_power, for "
                "full control.",
                ", ".join(unknown),
                PHASE_POWER_MIN,
            )

        await mqtt_util.async_publish(
            self.hass,
            mqtt_util.topic(T_PHASE_OUTPUT_POWER_SET, self.dev_id),
            payload,
        )

        # Optimistic update: the broker echo also lands in _handle_phase_output,
        # but this keeps the UI responsive when the echo is delayed.
        self.phase_output.update(payload)
        self.async_set_updated_data(dict(self.data))

    # ------------------------------------------------------------------
    # EMS mode select state (protocol §3 / §12)
    # ------------------------------------------------------------------
    @callback
    def _handle_ems_mode_command(self, msg: Any) -> None:
        """Echo a commanded EMS mode onto the select's state topic."""
        mode = mqtt_util.payload_to_text(msg.payload)
        if mode is None:
            return

        mode = mode.strip('"')
        if mode not in EMS_MODES:
            return

        # A slave may not run the system level modes.  Somebody publishing
        # straight to the broker can still try, so such a command is not echoed
        # onto the select's state topic - the picker must not show a mode the
        # unit will not enter.
        if mode not in self.ems_modes:
            _LOGGER.warning(
                "Ignoring EMS mode %r on %s: not available for role %r",
                mode, self.dev_id, self._role,
            )
            return

        self.hass.async_create_task(self._async_stop_repeat_if_needed(mode))

        self._ems_mode_command_time = time.monotonic()
        if mode == self._ems_mode_state:
            return

        self.hass.async_create_task(self._async_publish_ems_mode_state(mode))

    # ------------------------------------------------------------------
    # Virtual meter write counter (protocol §12)
    # ------------------------------------------------------------------
    @callback
    def _handle_meter_ctrl_set(self, msg: Any) -> None:
        """Follow a virtual-meter write that did not come from this integration.

        The HTTP endpoint, the ``number`` entities and the services already count
        their own writes where they issue them, and their publish comes back to
        this subscriber as an echo - ``is_own_publish`` filters that out.  What is
        left is a controller publishing straight to the broker (an energy
        manager, a script, a gateway), which is exactly what the card's counter
        is meant to prove.

        The values are mirrored into :attr:`meter` and the listeners are woken up:
        the three ``number`` entities read their state from there, and without
        this the card would keep drawing whatever Home Assistant last *sent*
        while the external controller's numbers never appeared at all.
        """
        text = mqtt_util.payload_to_text(msg.payload)
        if text is None:
            return
        if mqtt_util.is_own_publish(msg.topic, text):
            return
        try:
            payload = json.loads(text)
        except (TypeError, ValueError):
            return
        if not isinstance(payload, dict):
            return

        changed = False
        for key in ("power", "eng_out", "eng_in"):
            value = payload.get(key)
            if value is None:
                continue
            try:
                value = float(value)
            except (TypeError, ValueError):
                continue
            if self.meter.get(key) != value:
                self.meter[key] = value
                changed = True

        self.note_meter_write(payload, "mqtt")
        if changed:
            # Wake the number entities so the three read-outs follow the
            # controller instead of the last value posted from Home Assistant.
            self.async_set_updated_data(dict(self.data))

    async def _async_sync_ems_mode_state(self, mode: str, authoritative: bool = False) -> None:
        """Follow the mode the device actually reports in system/state.

        ``authoritative`` marks the state event (the firmware pushes it when the
        mode really changes) and is kept for the call sites; both kinds of report
        are treated the same now, because either one can have been queued before
        a command we just sent was applied - see the guard below.
        """
        _ = authoritative
        if mode not in EMS_MODES:
            return

        # Remember what the unit says it is running. The virtual meter counter is
        # scoped to `meter_ctrl`, so any other reported mode clears it - and this
        # is the *device's* word, not the last command we sent.
        self._ems_mode_reported = mode
        if mode != EMS_MODE_METER and self.meter_rx.get("count"):
            self.meter_rx = {"count": 0, "at": None, "source": None, "fields": {}}

        if mode == self._ems_mode_state:
            return

        # A report that contradicts the mode we just commanded may be a message
        # the device queued *before* it applied that command.  The five-minute
        # ``system/state`` tick is the obvious case, but the state event is not
        # immune either: measured on 2026-11-18, an ``event/state`` carrying
        # ``general`` arrived right after ``meter_ctrl`` had been commanded, and
        # it stopped the meter lease the caller had armed in the same breath -
        # which is exactly the "switch the mode, then push a setpoint" pattern
        # automations use.  So the echo guard covers both kinds of report, and
        # only reports that agree with the fresh command get through.
        fresh_command = (
            time.monotonic() - self._ems_mode_command_time
        ) < EMS_MODE_ECHO_GUARD_SECONDS
        if (
            fresh_command
            and self._ems_mode_state in EMS_MODES
            and mode != self._ems_mode_state
        ):
            return

        # The device gave up the MQTT setpoint - either because the mode was
        # changed elsewhere or because the lease expired.  Either way the
        # repeat has nothing left to protect.
        await self._async_stop_repeat_if_needed(mode)
        await self._async_publish_ems_mode_state(mode)

    async def _async_stop_repeat_if_needed(self, mode: str) -> None:
        """Drop running setpoint repeats that the new mode just made meaningless.

        ``power_ctrl`` only means anything in ``mqtt_ctrl``, ``fine_ctrl`` only
        in ``fine_ctrl`` and the virtual meter only in ``meter_ctrl``: in any
        other mode the device derives the setpoint itself, so a leftover repeat
        would keep pushing a value the firmware is not using - and, worse,
        silently resume the old setpoint the next time the user switched back.

        §12 and §42 are leases exactly like §10, so they get the same treatment.
        """
        topic_manager = get_topic_manager(self.hass)
        stale = [
            (kind, wanted)
            for kind, wanted in (
                ("meter_ctrl", EMS_MODE_METER),
                ("fine_ctrl", EMS_MODE_FINE_CTRL),
            )
            if mode != wanted
        ]
        for kind, _wanted in stale:
            if topic_manager.active(self.dev_id, kind) is None:
                continue
            await topic_manager.async_stop(self.dev_id, kind)
            _LOGGER.info(
                "EMS mode for %s became %s: stopped the %s repeat",
                self.dev_id,
                mode,
                kind,
            )

        if mode == EMS_MODE_MQTT_CTRL:
            return
        manager = get_repeat_manager(self.hass)
        if manager.active(self.dev_id) is None:
            return
        await manager.async_stop(self.dev_id)
        _LOGGER.info(
            "EMS mode for %s became %s: stopped the power_ctrl repeat",
            self.dev_id,
            mode,
        )

    async def _async_publish_ems_mode_state(self, mode: str) -> None:
        """Publish the EMS mode, retained so it survives a HA restart."""
        self._ems_mode_state = mode
        try:
            await mqtt_util.async_publish(
                self.hass,
                mqtt_util.topic(T_EMS_MODE_STATE, self.dev_id),
                mode,
                qos=1,
                retain=True,
            )
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Unable to publish the EMS mode state", exc_info=True)

    # ------------------------------------------------------------------
    # V0.6.2 state event (protocol §32)
    # ------------------------------------------------------------------
    @property
    def event(self) -> dict[str, Any]:
        """The last full state snapshot the device pushed.

        Every field is always present (§32 forbids sending only what changed),
        so a missing key really means "this firmware does not report it", not
        "it did not change".
        """
        payload = self.data.get(SRC_EVENT)
        return payload if isinstance(payload, dict) else {}

    def event_value(self, field: str, default: Any = None) -> Any:
        """Read one field of the state snapshot."""
        return self.event.get(field, default)

    def _event_flag(self, field: str) -> bool | None:
        """Read one boolean capability flag from the state snapshot.

        ``None`` means the device has never told us - which must not be treated
        as ``False``, or the diagrams would drop their optional nodes for a
        second every time Home Assistant restarts.  The firmware only sends
        ``true`` / ``false``, so anything else is "not reported".

        The last answer is **remembered across restarts** (it is written next to
        the sankey archive).  Which nodes a unit has does not change while it is
        offline, and the diagrams are meant to keep the elements they had: an
        offline unit whose entity attributes went empty used to be drawn without
        its smart plug, its meter or its second PV input, which looked like the
        hardware had been unplugged.
        """
        value = self.event.get(field)
        if isinstance(value, bool):
            return value
        remembered = self._last_flags.get(field)
        return remembered if isinstance(remembered, bool) else None

    @property
    def has_meter(self) -> bool | None:
        """Whether the device has a grid meter attached."""
        return self._event_flag("has_meter")

    @property
    def has_pv2(self) -> bool | None:
        """Whether a grid-tied PV micro-inverter (PV2) is in the system.

        The power reading cannot answer this: an installed inverter that is
        idle, asleep, or simply in the dark also reports 0 W.  Only this flag
        distinguishes "no PV2" from "PV2 with nothing to produce".

        V0.6.4 names the field ``has_solar2`` (§32); it is the same capability
        that earlier drafts called ``has_pv2``.  The integration keeps the old
        *attribute* name on the energy-flow sensor so the cards keep reading one
        key, but the wire field is the documented one.
        """
        return self._event_flag("has_solar2")

    @property
    def has_plug(self) -> bool | None:
        """Whether a smart plug is in the system.

        Same reason as :attr:`has_pv2`: ``sys_sp_p`` is 0 both for "no plug"
        and for "plug installed, nothing plugged in".
        """
        return self._event_flag("has_plug")

    @property
    def sankey_cached_at(self) -> datetime | None:
        """When the energy-flow snapshot on show was received, if cached.

        ``None`` while a snapshot the device sent *this* run is being shown; a
        timestamp means the numbers come from the copy written to disk before
        the restart, and the card marks them as stale.
        """
        return self._sankey_cached_at

    @property
    def sankey_days(self) -> list[dict[str, Any]]:
        """The archived daily snapshots, oldest first.

        Each item is ``{"date", "saved_at", "payload", "flags"}``.  The sankey
        card builds its date picker from this list, so there is no second source
        of truth about which days exist - and no history entity to poll.

        The values are daily cumulatives the device resets at ``00:00``, so the
        entry kept for a past day is that day's **last** report: the diagram as
        it stood when the day ended.
        """
        out: list[dict[str, Any]] = []
        for day in sorted(self._sankey_days):
            entry = self._sankey_days[day]
            payload = entry.get("payload")
            if not isinstance(payload, dict):
                continue
            flags = entry.get("flags")
            out.append({
                "date": day,
                "saved_at": entry.get("saved_at"),
                "payload": payload,
                "flags": flags if isinstance(flags, dict) else {},
            })
        return out

    @staticmethod
    def _decode_sankey_days(stored: dict[str, Any]) -> dict[str, dict[str, Any]]:
        """Read the archive out of the store, migrating the older layout.

        The first version of this cache wrote a single ``{"payload",
        "saved_at"}`` pair.  That snapshot is still a valid day's final diagram,
        so it becomes the entry for the day it was saved instead of being thrown
        away on upgrade.
        """
        days = stored.get("days")
        if isinstance(days, dict):
            out: dict[str, dict[str, Any]] = {}
            for day, entry in days.items():
                if (
                    isinstance(day, str)
                    and isinstance(entry, dict)
                    and isinstance(entry.get("payload"), dict)
                ):
                    out[day] = entry
            return out

        payload = stored.get("payload")
        saved = dt_util.parse_datetime(str(stored.get("saved_at") or ""))
        if isinstance(payload, dict) and saved is not None:
            day = dt_util.as_local(saved).date().isoformat()
            return {day: {"payload": payload, "saved_at": stored["saved_at"], "flags": {}}}
        return {}

    async def async_restore_sankey(self) -> None:
        """Load the archive, and seed today's snapshot when nothing arrived yet.

        The archive is always loaded: the card offers past days even when the
        device has already published a fresh snapshot this run.  Seeding the
        live payload only happens when nothing has arrived, for the reason this
        cache exists at all - the topic is not retained and the device is silent
        while the numbers do not change.
        """
        try:
            cached = await self._sankey_store.async_load()
        except Exception:  # noqa: BLE001 - a broken cache must not block setup
            _LOGGER.debug("Unable to read the cached sankey snapshot", exc_info=True)
            cached = None
        if isinstance(cached, dict):
            self._sankey_days = self._decode_sankey_days(cached)
            flags = cached.get("flags")
            if isinstance(flags, dict):
                self._last_flags = {
                    str(k): v for k, v in flags.items() if isinstance(v, bool)
                }
            self._restore_last_seen(cached.get("last_seen"))
            if not self._last_seen:
                # Store written by an older build: it has no per-source stamps,
                # but its `saved_at` is the last time the unit said anything at
                # all - enough to answer "has it been quiet for hours?" instead
                # of wearing yesterday's readings until the next message.
                saved = dt_util.parse_datetime(str(cached.get("saved_at") or ""))
                if saved is not None:
                    self._restore_last_seen({SRC_SANKEY: saved.isoformat()})

        if not self._last_flags and self._sankey_days:
            # Upgraded from a build that did not keep the top-level copy: the
            # archive already remembers the flags of every day it recorded, so
            # the newest day that has them is the answer.  The archive names them
            # after the card's attributes, hence the one rename.
            for day in sorted(self._sankey_days, reverse=True):
                entry = self._sankey_days.get(day)
                stored = entry.get("flags") if isinstance(entry, dict) else None
                if not isinstance(stored, dict):
                    continue
                found = {
                    ("has_solar2" if key == "has_pv2" else key): value
                    for key, value in stored.items()
                    if isinstance(value, bool)
                }
                if found:
                    self._last_flags = found
                    _LOGGER.debug(
                        "Restored the hardware flags of %s from the %s snapshot",
                        self.dev_id,
                        day,
                    )
                    break

        if isinstance(self.data.get(SRC_SANKEY), dict):
            return

        today = dt_util.now().date().isoformat()
        entry = self._sankey_days.get(today)
        if not isinstance(entry, dict):
            return
        payload = entry.get("payload")
        saved = dt_util.parse_datetime(str(entry.get("saved_at") or ""))
        if not isinstance(payload, dict) or saved is None:
            return

        data = dict(self.data)
        data[SRC_SANKEY] = payload
        self._sankey_cached_at = saved
        self.async_set_updated_data(data)
        _LOGGER.debug("Restored the sankey snapshot saved at %s", entry.get("saved_at"))

    def _restore_last_seen(self, stored: Any) -> None:
        """Put the persisted "last spoke at" stamps back into ``_last_seen``.

        A restart while the unit is switched off must not look like "the device
        was never heard from", which is the case the availability logic treats as
        "no verdict": that left the frozen readings of a powered-off unit on
        screen indefinitely.  Each stamp is converted from wall clock into
        ``time.monotonic()`` terms, which is what the watchdog compares against.
        """
        if not isinstance(stored, dict):
            return
        now_mono = time.monotonic()
        now_wall = dt_util.utcnow()
        for source, raw in stored.items():
            if source not in SOURCE_STALE_SECONDS:
                continue
            when = dt_util.parse_datetime(str(raw or ""))
            if when is None:
                continue
            age = (now_wall - when).total_seconds()
            # Restored whichever way it lands: a stamp that is still inside its
            # window simply keeps the unit available, and one that is not makes
            # the very first evaluation call it offline - which is what a Home
            # Assistant restart while the unit is switched off has to say.  An
            # online unit corrects the verdict with its first message (1 s
            # later), so the worst case is a brief flicker at startup, not a
            # frozen dashboard.
            self._last_seen[str(source)] = now_mono - max(0.0, age)

    async def _async_save_sankey(self, payload: dict[str, Any]) -> None:
        """Archive the snapshot and cache the newest one for restarts.

        Two jobs in one write:

        * ``days`` is the per-day archive the sankey card's date picker reads.
          The value is a daily cumulative, so the last write of a day *is* that
          day's final diagram - nothing is sampled or averaged.
        * the top-level ``payload``/``saved_at`` pair is what a restart restores.

        A payload of all zeros still replaces the entry: it is what the device
        said, and keeping an older non-zero one would draw a flow that had
        already stopped.
        """
        now = dt_util.utcnow()
        day = dt_util.as_local(now).date().isoformat()
        self._sankey_days[day] = {
            "payload": payload,
            "saved_at": now.isoformat(),
            # The three "is this fitted" flags as they stood that day.  The card
            # does not need them to draw a past day (it draws the numbers), but
            # they are what makes an old diagram interpretable later - a unit
            # without a meter produced a different picture - and cost three
            # booleans per day.
            "flags": {
                "has_meter": self.has_meter,
                "has_pv2": self.has_pv2,
                "has_plug": self.has_plug,
            },
        }
        for expired in sorted(self._sankey_days)[:-SANKEY_HISTORY_DAYS]:
            self._sankey_days.pop(expired, None)
        await self._async_write_sankey_store()

    async def _async_write_sankey_store(self) -> None:
        """Persist the archive, with the newest day mirrored at the top level.

        The top-level pair is what a restart restores (see
        :meth:`async_restore_sankey`); keeping it identical to the newest archive
        entry means the two can never disagree.
        """
        days = sorted(self._sankey_days)
        newest = self._sankey_days.get(days[-1]) if days else None
        payload = newest.get("payload") if isinstance(newest, dict) else None
        saved_at = newest.get("saved_at") if isinstance(newest, dict) else None
        try:
            await self._sankey_store.async_save({
                "payload": payload if isinstance(payload, dict) else {},
                "saved_at": saved_at,
                "days": self._sankey_days,
                # Which optional hardware this unit has, as last reported.  The
                # diagrams read it back through `_event_flag` while the device is
                # silent, so an offline unit keeps the nodes it really has.
                "flags": dict(self._last_flags),
                # When each source last spoke, as wall-clock time.  Without it a
                # Home Assistant restart while the unit is switched off starts
                # with an empty `_last_seen`, and the "nothing concluded yet"
                # rule below would show the stale readings for ever.
                "last_seen": self._last_seen_wall(),
            })
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Unable to cache the sankey snapshot", exc_info=True)

    def _last_seen_wall(self) -> dict[str, str]:
        """`_last_seen` as ISO timestamps, for the store.

        The live map is in ``time.monotonic()`` terms, which mean nothing across
        a restart, so each entry is converted back to wall clock here.
        """
        now_mono = time.monotonic()
        wall = dt_util.utcnow()
        return {
            source: (wall - timedelta(seconds=max(0.0, now_mono - seen))).isoformat()
            for source, seen in self._last_seen.items()
        }

    async def async_backfill_sankey(self, entity_id: str | None) -> None:
        """Fill the archive from the recorder with the days it still holds.

        The archive can only start the day this version is installed: the device
        clears these totals at ``00:00`` and never re-sends a past day.  Home
        Assistant, however, has been recording the **entity** - and its
        attributes carry the same nine flows - so the days the recorder has not
        purged yet can be turned back into snapshots.  That is what makes
        "yesterday" available immediately instead of tomorrow.

        Best effort by design: no recorder, no recorded attributes or an entity
        that never reported a snapshot all simply leave the archive as it is.
        Days already archived are never overwritten - the live path is the
        authority for them - so running this on every start only fills gaps
        (days Home Assistant was switched off, for instance).
        """
        if not entity_id or "recorder" not in self.hass.config.components:
            return

        today = dt_util.now().date()
        start = dt_util.start_of_local_day(
            today - timedelta(days=SANKEY_HISTORY_DAYS - 1)
        )
        # Today comes from the live entity, so there is no point in reading it
        # back: it would only duplicate the newest publish with a staler copy.
        end = dt_util.start_of_local_day(today)

        try:
            from homeassistant.components.recorder import get_instance  # noqa: PLC0415
            from homeassistant.components.recorder.history import (  # noqa: PLC0415
                state_changes_during_period,
            )

            rows = await get_instance(self.hass).async_add_executor_job(
                state_changes_during_period, self.hass, start, end, entity_id
            )
        except Exception:  # noqa: BLE001 - history is a bonus, never a blocker
            _LOGGER.debug(
                "Unable to read the sankey history from the recorder", exc_info=True
            )
            return

        states = rows.get(entity_id) if isinstance(rows, dict) else None
        if not states:
            return

        found: dict[str, dict[str, Any]] = {}
        for state in states:
            attrs = getattr(state, "attributes", None) or {}
            # Only a row that actually carries a snapshot counts; an ``unknown``
            # state from before the first report has none.
            if "pv_e2l" not in attrs:
                continue
            day = dt_util.as_local(state.last_updated).date().isoformat()
            # Rows arrive oldest first, so the last one of a day wins - exactly
            # the snapshot the archive would have saved at the time.
            found[day] = {
                "payload": {
                    "pv_prod": {
                        f: int(attrs.get(f"pv_{f}") or 0) for f in SANKEY_PV_PROD
                    },
                    "load_cons": {
                        f: int(attrs.get(f"load_{f}") or 0) for f in SANKEY_LOAD_CONS
                    },
                },
                "saved_at": state.last_updated.isoformat(),
                "flags": {
                    key: attrs.get(key)
                    for key in ("has_meter", "has_pv2", "has_plug")
                },
            }

        added = [
            day
            for day in found
            if day not in self._sankey_days and day <= today.isoformat()
        ]
        if not added:
            return
        for day in added:
            self._sankey_days[day] = found[day]
        for expired in sorted(self._sankey_days)[:-SANKEY_HISTORY_DAYS]:
            self._sankey_days.pop(expired, None)

        _LOGGER.info(
            "Backfilled %s energy-flow day(s) for %s from the recorder: %s",
            len(added),
            self.dev_id,
            ", ".join(sorted(added)),
        )
        await self._async_write_sankey_store()
        # The sensor exposes the archive size, and the card refetches when that
        # number changes - so a listener update here is what makes the date
        # picker of an already open page light up.
        self.async_update_listeners()

    @property
    def is_awake(self) -> bool | None:
        """Whether the unit is awake, from the state event.

        ``None`` when the firmware does not report it.  A sleeping unit reports
        every power as 0 W and runs no TOU plan at all, so the cards need this
        to be able to say why nothing is happening.
        """
        value = self.event.get("switch")
        if value == "ON":
            return True
        if value == "OFF":
            return False
        return None

    @property
    def ems_mode_reported(self) -> str | None:
        """The EMS mode the device says is actually in force."""
        value = self.event.get("ems_mode")
        return value if value in EMS_MODES else None

    # ------------------------------------------------------------------
    # V0.6.4 group descriptions (§37, §39, §41)
    # ------------------------------------------------------------------
    @property
    def fan_meta(self) -> dict[str, Any] | None:
        """The fan group description, or ``None`` when the unit has no fan."""
        payload = self.data.get(SRC_FAN_META)
        return payload if isinstance(payload, dict) else None

    @property
    def heat_meta(self) -> dict[str, Any] | None:
        """The heater group description, or ``None`` when there is no heater."""
        payload = self.data.get(SRC_HEAT_META)
        return payload if isinstance(payload, dict) else None

    @property
    def fine_meta(self) -> dict[str, Any] | None:
        """The fine-grained control description, or ``None`` when unsupported."""
        payload = self.data.get(SRC_FINE_META)
        return payload if isinstance(payload, dict) else None

    @property
    def meter_meta(self) -> dict[str, Any] | None:
        """The virtual meter group description (§11), or ``None`` unsupported."""
        payload = self.data.get(SRC_METER_META)
        return payload if isinstance(payload, dict) else None

    @staticmethod
    def _control(meta: dict[str, Any] | None, key: str) -> dict[str, Any] | None:
        """One entry of ``controls`` from a group description."""
        if not isinstance(meta, dict):
            return None
        controls = meta.get("controls")
        if not isinstance(controls, dict):
            return None
        entry = controls.get(key)
        return entry if isinstance(entry, dict) else None

    def group_control(self, source: str, key: str) -> dict[str, Any] | None:
        """Look up ``controls.<key>`` of one group (fan / heat / fine_ctrl)."""
        meta = self.data.get(source)
        return self._control(meta if isinstance(meta, dict) else None, key)

    # ------------------------------------------------------------------
    # V0.6.4 commands (§33 ~ §44)
    # ------------------------------------------------------------------
    async def _async_number(self, template: str, value: Any) -> None:
        """Publish a scalar or object payload to a number command topic."""
        await mqtt_util.async_publish(
            self.hass, mqtt_util.topic(template, self.dev_id), value
        )

    async def async_set_soc_h(self, value: int) -> None:
        """Charge cut-off SOC (protocol §34) - one scalar, its own topic.

        The firmware validates the pair itself: a value that comes within
        :data:`const.SOC_MIN_GAP` of the discharge cut-off is ignored (§34).
        """
        await self._async_number(T_SOC_H_LIMIT_SET, int(value))

    async def async_set_soc_l(self, value: int) -> None:
        """Discharge cut-off SOC (protocol §36) - one scalar, its own topic."""
        await self._async_number(T_SOC_L_LIMIT_SET, int(value))

    async def async_set_fan(
        self,
        mode: str | None = None,
        pcs: int | None = None,
        bat: int | None = None,
    ) -> None:
        """Fan group write (protocol §38).

        The payload is an object and the document allows a **partial** write:
        fields that are not sent keep their current value.  So changing only the
        mode, or only one fan level, no longer has to guess the other values -
        which is exactly the bug the old split topics had.
        """
        payload: dict[str, Any] = {}
        if mode is not None:
            payload["mode"] = mode
        target: dict[str, int] = {}
        if pcs is not None:
            target["pcs"] = int(pcs)
        if bat is not None:
            target["bat"] = int(bat)
        if target:
            payload["target"] = target
        if not payload:
            return
        await self._async_number(T_FAN_SET, payload)

    async def async_set_heat(
        self,
        mode: str | None = None,
        param: int | None = None,
        pack_ids: list[int] | None = None,
    ) -> None:
        """Heater group write (protocol §40), partial allowed.

        ``param`` means watts when ``mode`` is ``power`` and degrees when it is
        ``temp``, so the caller decides which mode it is writing in; an omitted
        ``mode`` keeps whatever the device is running.
        """
        payload: dict[str, Any] = {}
        if mode is not None:
            payload["mode"] = mode
        if param is not None:
            payload["param"] = int(param)
        if pack_ids is not None:
            payload["pack_ids"] = [int(pack) for pack in pack_ids]
        if not payload:
            return
        await self._async_number(T_HEAT_SET, payload)

    async def async_set_fine_ctrl(self, **fields: Any) -> None:
        """Fine-grained control write (protocol §42), partial allowed.

        ``grid_p`` is a lease like ``power_ctrl``: the device falls back to
        self-consumption unless it is refreshed at least once a minute, which is
        what ``power_repeat`` handles for the card.
        """
        payload = {key: value for key, value in fields.items() if value is not None}
        if not payload:
            return
        await mqtt_util.async_publish(
            self.hass, mqtt_util.topic(T_FINE_CTRL_SET, self.dev_id), payload
        )

    async def async_set_input_power(self, watts: int) -> None:
        """Input power ceiling; 0 forbids drawing power (protocol §44).

        §25/§26 limit the topic to a master or a stand-alone unit.
        """
        self.require_role(ROLE_MASTER_SINGLE, "输入功率限制")
        await self._async_number(T_INPUT_POWER_SET, int(watts))

    # ------------------------------------------------------------------
    # V0.6.6 per phase input / house input limits (§27 - §32)
    # ------------------------------------------------------------------
    def phase_limit(self, group: str, phase: str) -> int | None:
        """Last commanded value of one phase of a V0.6.6 limit group."""
        return self.phase_limits.get(group, {}).get(phase)

    @callback
    def restore_phase_limit(self, group: str, phase: str, value: int) -> None:
        """Seed one phase from restored state (no MQTT traffic)."""
        store = self.phase_limits.setdefault(group, {})
        if store.get(phase) == value:
            return
        store[phase] = value
        self.async_set_updated_data(dict(self.data))

    async def async_set_phase_limit(self, group: str, phase: str, value: int) -> None:
        """Set one phase of a limit group, keeping the other two in force."""
        await self.async_set_phase_limits(group, {phase: value})

    async def async_set_phase_limits(
        self, group: str, values: dict[str, int]
    ) -> None:
        """Publish a complete per phase limit object (protocol §28 / §32).

        Both topics are 仅多相主机 and require **all three** phases in one
        message, so a single slider edit has to carry the other two - they come
        from the last known value, or from the low end of the band when nothing
        has been heard yet (the same rule ``async_set_phase_outputs`` uses).
        """
        topic, default, label = {
            "phase_input_power": (
                T_PHASE_INPUT_SET,
                PHASE_INPUT_POWER_MIN,
                "分相输入功率上限",
            ),
            "phase_house_in_power": (
                T_PHASE_HOUSE_IN_SET,
                PHASE_HOUSE_IN_POWER_MIN,
                "分相入户功率上限",
            ),
        }.get(group, ("", 0, ""))
        if not topic:
            return

        self.require_role(ROLE_MULTIPHASE_MASTER, label)
        store = self.phase_limits.setdefault(group, {})

        payload: dict[str, int] = {}
        unknown: list[str] = []
        for phase in PHASES:
            if phase in values:
                payload[phase] = int(values[phase])
                continue
            known = store.get(phase)
            if known is None:
                unknown.append(phase)
                payload[phase] = int(default)
            else:
                payload[phase] = int(known)

        if unknown:
            _LOGGER.warning(
                "%s: %s had no known value yet and defaults to %s W.",
                label,
                ", ".join(unknown),
                default,
            )

        await mqtt_util.async_publish(
            self.hass, mqtt_util.topic(topic, self.dev_id), payload
        )

        # Optimistic update, matching what the §46 echo will report.
        store.update(payload)
        self.async_set_updated_data(dict(self.data))

    # ------------------------------------------------------------------
    # V0.6.7 feed-in group (§29 / §30)
    # ------------------------------------------------------------------
    async def async_set_feed_power(
        self, enable: bool | None = None, limit: int | None = None
    ) -> None:
        """Feed-in group write (§30), partial allowed.

        V0.6.7 moved the feed-in ceiling out of a scalar firmware entity into a
        ``meta`` group with **two** controls (``enable`` + ``limit``) behind one
        object-taking ``set`` topic.  A partial object keeps the field that was
        not sent, so the enable switch never rewrites the limit, and turning the
        limit down never re-enables export.
        """
        self.require_role(ROLE_MASTER_ONLY, "馈网限值")
        payload: dict[str, Any] = {}
        if enable is not None:
            payload["enable"] = bool(enable)
        if limit is not None:
            payload["limit"] = int(limit)
        if not payload:
            return
        await mqtt_util.async_publish(
            self.hass, mqtt_util.topic(T_FEED_POWER_SET, self.dev_id), payload
        )

    async def async_set_house_in_enable(self, enable: bool) -> None:
        """The enable switch of the multi phase house input group (§32).

        §32 says ``enable`` may be sent **on its own** ("不受三相同时下发约束"),
        which is exactly what the switch does: the three limits stay untouched.
        """
        self.require_role(ROLE_MULTIPHASE_MASTER, "多相入户功率限值")
        await mqtt_util.async_publish(
            self.hass,
            mqtt_util.topic(T_PHASE_HOUSE_IN_SET, self.dev_id),
            {"enable": bool(enable)},
        )

    def note_meter_write(self, fields: dict[str, Any], source: str) -> None:
        """Count one accepted virtual-meter write (§12).

        Called from every path that actually *writes* the simulated meter - the
        HTTP endpoint, the ``number`` entities and the services - and never from
        the repeat job, which re-publishes an object it did not receive.  That is
        what makes the counter on the card mean "updates received", and not
        "messages on the topic".

        ``source`` is ``"http"`` for the external endpoint, ``"entity"`` for a
        write through Home Assistant, ``"mqtt"`` for a controller publishing
        straight to the broker.

        Writes are only counted while the **device reports** ``meter_ctrl``: in
        any other mode a virtual meter reading has no meaning, so the card must
        not claim "N pushes received" for a unit that is merely sitting there.

        A **slave** has no §11/§12 topic at all (§7-§12 are 主机和单机), so a
        stray push is not counted either - the entity, the HTTP endpoint and the
        repeat job are all gated, this is the last line of defence.
        """
        if not self.allows(ROLE_MASTER_SINGLE):
            return
        if self._ems_mode_reported != EMS_MODE_METER:
            return
        count = int(self.meter_rx.get("count") or 0) + 1
        self.meter_rx = {
            "count": count,
            "at": dt_util.utcnow().isoformat(),
            "source": source,
            "fields": {key: value for key, value in fields.items() if value is not None},
        }
    async def async_set_meter_ctrl(self, **fields: Any) -> None:
        """Virtual meter write (§12), partial fields merged into a full object.

        ``power`` is the setpoint; ``eng_out`` / ``eng_in`` are the cumulative
        readings of the simulated meter.  The device accepts a partial object,
        but the *lease* needs the complete thing: a tick that carried only
        ``power`` would still work, yet re-sending all three keeps the simulated
        meter self-consistent and matches what the card promises.

        The last known values are kept in :attr:`meter`, so an entity write and a
        running re-publish job never disagree about the readings.
        """
        self.require_role(ROLE_MASTER_SINGLE, "虚拟电表控制")
        payload = {key: value for key, value in fields.items() if value is not None}
        if not payload:
            return
        self.meter.update(payload)
        full = {key: self.meter[key] for key in METER_FIELDS if key in self.meter}

        # A running lease repeats the object on its own: hand it the merged
        # values instead of publishing behind its back, or the next tick would
        # put the old reading straight back on the wire.
        job = get_topic_manager(self.hass).active(self.dev_id, "meter_ctrl")
        if job is not None:
            self.note_meter_write(full, "entity")
            await get_topic_manager(self.hass).async_set(
                self.dev_id, "meter_ctrl", job.topic, full, job.interval
            )
            return
        await mqtt_util.async_publish(
            self.hass, mqtt_util.topic(T_METER_CTRL_SET, self.dev_id), full
        )
        self.note_meter_write(full, "entity")

    # ------------------------------------------------------------------
    # availability internals
    # ------------------------------------------------------------------
    async def _async_watchdog(self, _now: Any = None) -> None:
        """Mark the device unavailable once every source went stale."""
        if self._evaluate_availability() is False and self._available is not False:
            await self._async_publish_availability(False)

    async def _async_startup_grace(self, _now: Any = None) -> None:
        """Ran out of patience after a restart: not a single message arrived.

        ``_evaluate_availability`` answers ``None`` while nothing has ever been
        heard, on purpose - that protects a device that is merely slow to connect
        from being declared dead the moment Home Assistant starts.  A ``quick``
        topic that fires every second makes two minutes of total silence
decisive.

        """
        if self._last_seen:
            return
        await self._async_publish_availability(False)

    @callback
    def _evaluate_availability(self) -> bool | None:
        """Return True/False, or None when nothing can be concluded yet."""
        now = time.monotonic()

        # A topic that speaks every second decides on its own.  The 5-minute
        # topics have to be given windows of ~11 minutes so that one missed tick
        # is not read as "gone", and while such a window is still open it used to
        # count as "alive" - which is why a unit that was switched off kept
        # showing its last readings for up to 15 minutes.
        for source in FAST_SOURCES:
            last_seen = self._last_seen.get(source)
            if last_seen is not None:
                return (now - last_seen) <= SOURCE_STALE_SECONDS[source]

        for source, window in SOURCE_STALE_SECONDS.items():
            last_seen = self._last_seen.get(source)
            if last_seen is not None and (now - last_seen) <= window:
                return True

        # Never seen anything at all: leave the retained value alone instead of
        # declaring a healthy device offline right after Home Assistant started.
        if not self._last_seen:
            return None

        return False

    async def _async_publish_availability(self, available: bool) -> None:
        """Publish an availability change and refresh the entities."""
        self._available = available
        payload = PAYLOAD_AVAILABLE if available else PAYLOAD_NOT_AVAILABLE

        try:
            await mqtt_util.async_publish(
                self.hass, self.availability_topic, payload, qos=1, retain=True
            )
        except Exception:  # noqa: BLE001
            _LOGGER.debug("Unable to publish availability", exc_info=True)
            return

        _LOGGER.info("Hoymiles %s is now %s", self.dev_id, payload)
        self.async_set_updated_data(dict(self.data))

    # ------------------------------------------------------------------
    # state topics
    # ------------------------------------------------------------------
    @callback
    def _make_handler(self, key: str):
        @callback
        def _handler(msg: Any) -> None:
            try:
                payload = json.loads(msg.payload)
            except (ValueError, TypeError):
                _LOGGER.debug("Invalid JSON on %s: %s", msg.topic, msg.payload)
                return
            if not isinstance(payload, dict):
                return

            # Every payload that parses counts as "the unit spoke": a card waiting
            # for a reboot only needs to know that something arrived after the
            # trigger.  Not tied to `_last_seen` below, which exists only for the
            # availability windows and therefore only lists some of the topics.
            self._last_msg_wall = time.time()

            if key in SOURCE_STALE_SECONDS:
                self._last_seen[key] = time.monotonic()

            # §32 `role` / `phase_output_power`: remember them **before** the
            # data is published, so the entities that are re-evaluated by
            # ``async_set_updated_data`` already see the new role and can flip
            # themselves to unavailable in the same pass.
            if key in (SRC_EVENT, SRC_SYSTEM):
                self._note_role(payload, key)

            data = dict(self.data)
            data[key] = payload
            self.async_set_updated_data(data)

            # A fresh message can only ever flip the verdict to available; the
            # watchdog is responsible for the opposite direction.
            if key in SOURCE_STALE_SECONDS and self._available is not True:
                self.hass.async_create_task(self._async_publish_availability(True))

            if key == SRC_SANKEY:
                # A live snapshot supersedes the cached one, so the sensor stops
                # marking it stale from this point on.
                self._sankey_cached_at = None
                self.hass.async_create_task(self._async_save_sankey(payload))

            if key == SRC_SYSTEM:
                mode = payload.get("ems_mode")
                if isinstance(mode, str):
                    self.hass.async_create_task(self._async_sync_ems_mode_state(mode))

            if key == SRC_EVENT:
                # The state event is authoritative and current - §32 says it is
                # pushed the moment a state changes.  Unlike ``system/state`` it
                # does not lag behind a command, so no echo guard is applied.
                #
                # The capability flags are the one thing worth keeping when the
                # device goes quiet: they describe the hardware, not a reading,
                # and they are what lets the diagrams keep their nodes offline.
                remembered = {
                    flag: payload.get(flag)
                    for flag in ("has_meter", "has_solar2", "has_plug")
                    if isinstance(payload.get(flag), bool)
                }
                if any(self._last_flags.get(k) != v for k, v in remembered.items()):
                    self._last_flags.update(remembered)
                    self.hass.async_create_task(self._async_write_sankey_store())
                mode = payload.get("ems_mode")
                if isinstance(mode, str) and mode in EMS_MODES:
                    self.hass.async_create_task(self._async_sync_ems_mode_state(mode, True))

                # §32 `role` decides whether the generated dashboard keeps its
                # System view: a **slave** has no system-level readings of its
                # own, so that page would show dashes only.  Handled here, on the
                # role the device actually reports, and not with a Lovelace
                # `visible` condition - such a condition is false while the state
                # is `unknown`, which hid the tab on every unit that had not
                # reported its role yet (i.e. most of them, most of the time).
                role = payload.get("role")
                if isinstance(role, str) and role:
                    keep = role != "slave"
                    if self._system_view_keep != keep:
                        self._system_view_keep = keep
                        self.hass.async_create_task(
                            async_set_system_view(self.hass, self.dev_id, keep)
                        )

        return _handler
