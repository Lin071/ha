"""Sensor entities for the Hoymiles Micro Storage integration.

These entities reproduce the state fields the firmware pushes on
``quick/state`` (1 s, all roles), ``device/state`` (5 min, all roles) and
``system/state`` (5 min, master/single only) plus the TOU ack/status topics.

``soc`` and ``bat_power`` are intentionally *not* re-created here because the
firmware already registers them through MQTT discovery.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Final

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    PERCENTAGE,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
    EntityCategory,
    UnitOfElectricCurrent,
    UnitOfElectricPotential,
    UnitOfEnergy,
    UnitOfFrequency,
    UnitOfPower,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import dt as dt_util

from .const import (
    ALARM_CODE_RANGES,
    ALARM_CODE_RANGES_ZH,
    ALARM_CODES_INVERTER,
    ALARM_CODES_INVERTER_ZH,
    ALARM_CODES_STORAGE,
    ALARM_CODES_STORAGE_ZH,
    ALARM_MAX,
    CONF_DEV_ID,
    DOMAIN,
    MANUFACTURER,
    ROLE_MASTER_SINGLE,
    SANKEY_LOAD_CONS,
    SANKEY_PV_PROD,
    SRC_ALARM,
    SRC_DEVICE,
    SRC_EVENT,
    SRC_QUICK,
    SRC_SANKEY,
    SRC_SYSTEM,
    SRC_TOU_DAY_ACK,
    SRC_TOU_STATUS,
    SRC_TOU_WEEK_ACK,
    TOU_DAY_ACK_STATUS,
    TOU_GET_STATUS,
    TOU_WEEK_ACK_STATUS,
    device_family,
)
from .coordinator import HoymilesCoordinator

# ---------------------------------------------------------------------------
# value_fn helpers
# ---------------------------------------------------------------------------


def _payload(data: dict[str, Any], source: str) -> dict[str, Any]:
    value = data.get(source)
    return value if isinstance(value, dict) else {}


def q(field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read a top level field from quick/state."""

    def _fn(data: dict[str, Any]) -> Any:
        return _payload(data, SRC_QUICK).get(field, default)

    return _fn


def d(field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read a top level field from device/state."""

    def _fn(data: dict[str, Any]) -> Any:
        return _payload(data, SRC_DEVICE).get(field, default)

    return _fn


def ev(field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read a top level field from the §32 state snapshot (``event/state``).

    ``role`` lives there, and it is what tells a slave apart from a master or a
    stand-alone unit - the same field the firmware's own MQTT code uses before
    it publishes any EMS topic.
    """

    def _fn(data: dict[str, Any]) -> Any:
        return _payload(data, SRC_EVENT).get(field, default)

    return _fn


def s(field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read a top level field from system/state."""

    def _fn(data: dict[str, Any]) -> Any:
        return _payload(data, SRC_SYSTEM).get(field, default)

    return _fn


# ``system/state`` counts only the unit's own PV ports.  Protocol §45 reports
# the third-party PV energy as flows of its own - into the battery (``tp2b``)
# and out to the grid (``tp2g``).  There is no ``tp2l``, so the third-party
# energy that reached the load is not in those numbers; ``system/state``
# carries that port's own production as ``pv2_e`` instead.
#
# Hence the rule the dashboard shows (spec from the vendor app):
#
#     own        = e2b + e2g + e2l
#     third      = tp2b + tp2g
#     total      = own + MAX(third, PV2)
#     grid_rate  = (b2g + e2g + tp2g) / total
#     grid_rate >  1 : self_rate = (e2b + tp2b + e2l + pv2_to_load) / total
#     grid_rate <= 1 : self_rate = 1 - grid_rate
#
# ``grid_rate`` counts **everything that left through the meter**, so the
# third-party PV's export (``tp2g``) belongs in it as well: the vendor app's
# ``e2g`` is "PV to grid" for the whole PV side, while protocol §45 splits it
# into the unit's own ``e2g`` and the third-party ``tp2g``.  Leaving ``tp2g``
# out over-reported self-consumption (97 % where the app showed 88.6 % -
# 22/744 vs 85/744 of the day's 744 Wh).
#
# ``MAX`` because the two are two views of the same port: the measured flows
# can miss the part consumed directly, and the reported production can lag.  A
# unit with no third-party input has both at 0 and the total is just its own
# production, so the same formula serves both hardware variants.
THIRD_PARTY_PV_FLOWS: Final = ("tp2b", "tp2g")
# The PV side's own edges, as the documented document carries them.  A later
# firmware revision added two more edges per side (``e2kl`` / ``e2loss`` and
# their third-party twins) that split the house into three sinks; the diagrams
# draw one load node, so those are ignored on purpose - see ``const.py``.
PV_OWN_FLOWS: Final = ("e2l", "e2b", "e2g")


def _sankey_groups(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The two ``sankey/state`` groups, a missing one as an empty dict."""
    raw = _payload(data, SRC_SANKEY)
    groups: dict[str, dict[str, Any]] = {}
    for group in ("pv_prod", "load_cons"):
        value = raw.get(group)
        groups[group] = value if isinstance(value, dict) else {}
    return groups


def _flows_sum(
    flows: dict[str, dict[str, Any]], fields: tuple[str, ...]
) -> float:
    """Sum flow fields whichever group they were published in.

    ``e2b`` lives in ``pv_prod`` and ``e2kl`` in ``load_cons``; a caller asking
    for "the PV side's total" must not have to know which.  A field absent from
    one group contributes that group's 0, so firmware that only publishes the
    old ten fields still adds up.
    """
    total = 0.0
    for field in fields:
        for group in ("pv_prod", "load_cons"):
            try:
                total += float((flows.get(group) or {}).get(field) or 0)
            except (TypeError, ValueError):
                continue
    return total


def _third_party_pv_today(data: dict[str, Any]) -> float:
    """Today's third-party PV energy as measured by its flows.

    ``tp2b`` + ``tp2g`` plus the two edges that reach the separated sinks
    (``tp2kl`` / ``tp2loss``).
    """
    return _flows_sum(_sankey_groups(data), THIRD_PARTY_PV_FLOWS)


def _pv2_today(data: dict[str, Any]) -> float:
    """The second PV input's own production today (``system/state`` ``pv2_e``)."""
    try:
        return float(_payload(data, SRC_SYSTEM).get("pv2_e") or 0)
    except (TypeError, ValueError):
        return 0.0


def _fmt_energy(value: float) -> Any:
    """A whole number when it is one, so ``596`` does not read ``596.0``."""
    return int(value) if float(value).is_integer() else round(value, 3)


def pv_totals(data: dict[str, Any], field: str = "pv_e") -> dict[str, Any] | None:
    """Today's PV production split the way the vendor app counts it.

    ``pv_own`` is the unit's own ports.  It comes from the measured flows
    (:data:`PV_OWN_FLOWS`) when §45 has arrived and from ``pv_e`` otherwise -
    both are the same quantity, and the fallback keeps the tile alive in the
    minutes between a restart and the first history document.  ``pv_extra`` is
    ``MAX(third-party flows, PV2)``; ``pv_total`` is the sum.
    """
    system_pv = _payload(data, SRC_SYSTEM).get(field)
    groups = _sankey_groups(data)
    measured = _flows_sum(groups, PV_OWN_FLOWS)
    if measured > 0:
        own = measured
    elif system_pv is not None:
        # No §45 document yet, or one that only carries zeros (a fresh start, a
        # device that just woke up): the counters in ``system/state`` are the
        # same quantity and must not be replaced by a zero.
        try:
            own = float(system_pv)
        except (TypeError, ValueError):
            return None
    else:
        return None

    third = _flows_sum(groups, THIRD_PARTY_PV_FLOWS)
    pv2 = _pv2_today(data)
    extra = max(third, pv2)
    return {
        "pv_own": _fmt_energy(own),
        "pv_third_party": _fmt_energy(third),
        "pv2_production": _fmt_energy(pv2),
        "pv_extra": _fmt_energy(extra),
        "pv_total": _fmt_energy(own + extra),
    }


def s_pv_total(field: str = "pv_e") -> Callable[[dict], Any]:
    """Today's PV energy per the vendor rule (own ports + ``MAX(tp, PV2)``).

    "PV today" on the dashboard means everything the PV side produced, and the
    sankey's single PV node is that same sum - so a tile showing only ``pv_e``
    contradicted the diagram right next to it.

    ``None`` while neither ``system/state`` nor §45 has arrived: showing only a
    fragment of the day's production is worse than "unknown".
    """

    def _fn(data: dict[str, Any]) -> Any:
        totals = pv_totals(data, field)
        return None if totals is None else totals["pv_total"]

    return _fn


def pv_today_split(data: dict[str, Any]) -> dict[str, Any] | None:
    """The parts of :func:`s_pv_total`, as attributes on the same sensor.

    The tile shows one number; the split stays readable (and loggable) without a
    second entity.
    """
    return pv_totals(data)


def self_consumption(
    flows: dict[str, dict[str, int]], pv2: float
) -> dict[str, Any] | None:
    """The self-consumption figures of the day (vendor rule).

    ``total`` is the day's PV production (see :func:`pv_totals`), ``grid_rate``
    is how much of it left through the meter - own PV, the battery and the
    third-party PV all count, because all three go out the same meter - and
    ``self_rate`` is the share the house kept.

    Above ``grid_rate = 1`` more energy was exported than the PV side produced -
    possible when the battery was charged from the grid and sold on - so the
    ratio alone would go negative.  In that case the self-consumed energy is
    counted directly instead: PV to battery, third-party PV to battery, PV to
    load, plus the third-party energy that went to the load (``pv2_to_load``,
    i.e. the PV2 production that is not visible in the two flows).

    ``None`` when the document is missing or the day has no production at all;
    the card then keeps showing "—" instead of inventing 0 %.

    The function itself does not look at ``has_meter``: the *caller* decides
    whether a rate exists at all, because the flag lives on the coordinator
    (§46) while this helper only sees the two documents.  Without a meter the
    vendor rule has no measurement to divide by.
    """
    pv = flows.get("pv_prod") or {}
    own = _flows_sum(flows, PV_OWN_FLOWS)
    third = _flows_sum(flows, THIRD_PARTY_PV_FLOWS)
    total = own + max(third, pv2)
    if total <= 0:
        return None

    exported = (
        float(pv.get("b2g") or 0)
        + float(pv.get("e2g") or 0)
        + float(pv.get("tp2g") or 0)
    )
    grid_rate = exported / total
    pv2_to_load = max(0.0, pv2 - third)
    if grid_rate > 1:
        consumed = (
            float(pv.get("e2b") or 0)
            + float(pv.get("tp2b") or 0)
            + float(pv.get("e2l") or 0)
            + pv2_to_load
        )
        self_rate = consumed / total
        rule = "consumed/total"
    else:
        consumed = total * (1 - grid_rate)
        self_rate = 1 - grid_rate
        rule = "1-grid_rate"

    self_rate = min(1.0, max(0.0, self_rate))
    return {
        "pv_total": _fmt_energy(total),
        "grid_rate": round(grid_rate, 4),
        "self_rate": round(self_rate, 4),
        # The percentage the gauge prints, one decimal: the same number the
        # vendor app shows, and enough to tell 89.4 % from 89.9 %.
        "self_rate_pct": round(self_rate * 100, 1),
        "self_consumed": _fmt_energy(consumed),
        "pv2_to_load": _fmt_energy(pv2_to_load),
        "self_rate_rule": rule,
    }


# Documented order of the ``grid`` array in device/state (protocol §23).
GRID_TYPES: Final = ("grid_on", "grid_off", "inv")


def grid(index: int, field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read ``grid[index].<field>`` from device/state (0=on, 1=off, 2=inv).

    Entries are matched by their ``type`` field instead of by position, so the
    energy dashboard and the statistics built on these sensors keep working even
    if the firmware ever reorders or filters the array.  The documented order is
    only used as a fallback for entries without a ``type``.
    """

    def _fn(data: dict[str, Any]) -> Any:
        items = _payload(data, SRC_DEVICE).get("grid")
        if not isinstance(items, list):
            return default

        wanted = GRID_TYPES[index] if 0 <= index < len(GRID_TYPES) else None
        if wanted is not None:
            for item in items:
                if isinstance(item, dict) and item.get("type") == wanted:
                    return item.get(field, default)

        if len(items) > index and isinstance(items[index], dict):
            return items[index].get(field, default)

        return default

    return _fn


def pv(index: int, default: Any = None) -> Callable[[dict], Any]:
    """Read the power of PV port ``index`` (0-based) from device/state.

    Ports are matched by ``id`` (1-based in the protocol), so a missing entry
    cannot shift the value of every following port.
    """

    def _fn(data: dict[str, Any]) -> Any:
        items = _payload(data, SRC_DEVICE).get("pvs")
        if not isinstance(items, list):
            return default

        for item in items:
            if isinstance(item, dict) and item.get("id") == index + 1:
                return item.get("p", default)

        if len(items) > index and isinstance(items[index], dict):
            return items[index].get("p", default)

        return default

    return _fn


def pv_live(index: int, default: Any = None) -> Callable[[dict], Any]:
    """PV port power, preferring the **1 s** ``quick/state`` field.

    §24 sends ``pv1_p`` … ``pv4_p`` every second, while ``pvs[].p`` only arrives
    with ``device/state`` every five minutes.  The port power is exactly the
    kind of reading people watch change, so the fast topic wins and the slow
    one is the fallback for a single-phase unit that reports only one of them.
    """
    fast = q(f"pv{index + 1}_p")
    slow = pv(index, default)

    def _fn(data: dict[str, Any]) -> Any:
        value = fast(data)
        return value if value is not None else slow(data)

    return _fn


def pv_field(index: int, field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read ``pvs[index].<field>`` from device/state (``ed``, ``et``)."""

    def _fn(data: dict[str, Any]) -> Any:
        items = _payload(data, SRC_DEVICE).get("pvs")
        if not isinstance(items, list):
            return default

        for item in items:
            if isinstance(item, dict) and item.get("id") == index + 1:
                return item.get(field, default)

        if len(items) > index and isinstance(items[index], dict):
            return items[index].get(field, default)

        return default

    return _fn


def pack(index: int, field: str, default: Any = None) -> Callable[[dict], Any]:
    """Read ``packs[index].<field>`` from device/state (0-based).

    Packs are matched by ``id`` (1-based in the protocol), so a missing pack
    cannot shift the values of the remaining ones.
    """

    def _fn(data: dict[str, Any]) -> Any:
        items = _payload(data, SRC_DEVICE).get("packs")
        if not isinstance(items, list):
            return default

        for item in items:
            if isinstance(item, dict) and item.get("id") == index + 1:
                return item.get(field, default)

        if len(items) > index and isinstance(items[index], dict):
            return items[index].get(field, default)

        return default

    return _fn


def fan_actual(fan: str) -> Callable[[dict], Any]:
    """Read ``fan_actual.<fan>`` from the state event (protocol §32).

    The value is the level the fan is **actually** running at, which is not the
    same thing as `fan_target`: in `auto` the firmware picks the level itself.
    The range is 0..10, and the firmware uses **255** for "this fan is not
    fitted / not enabled" - the battery card hides the indicator for anything
    outside the documented range instead of drawing a fan spinning at 25 times
    full speed.
    """

    def _fn(data: dict[str, Any]) -> Any:
        actual = _payload(data, SRC_EVENT).get("fan_actual")
        if not isinstance(actual, dict):
            return None
        return actual.get(fan)

    return _fn


def _ack(source: str, table: dict[int, str]):
    """Build a value_fn for an ack/status topic (returns a readable string)."""

    def _fn(data: dict[str, Any]) -> str | None:
        payload = _payload(data, source)
        status = payload.get("status")
        if status is None:
            return None
        try:
            code = int(status)
        except (TypeError, ValueError):
            return str(status)
        text = table.get(code, "unknown")
        return f"{code} - {text}"

    return _fn


def _tou_status_value(data: dict[str, Any]) -> str | None:
    payload = _payload(data, SRC_TOU_STATUS)
    status = payload.get("status")
    if status is None:
        return None
    try:
        code = int(status)
    except (TypeError, ValueError):
        return str(status)
    week = payload.get("week")
    day_idx = payload.get("day_idx")
    text = TOU_GET_STATUS.get(code, "unknown")
    if code == 0 and week is not None:
        return f"{week} day{day_idx} - {text}"
    return f"{code} - {text}"


def _tou_attrs(source: str) -> Callable[[dict], dict[str, Any]]:
    def _fn(data: dict[str, Any]) -> dict[str, Any]:
        payload = _payload(data, source)
        attrs: dict[str, Any] = {}
        if payload.get("status") is not None:
            attrs["status"] = payload["status"]
        if payload.get("err_msg") is not None:
            attrs["err_msg"] = payload["err_msg"]
        if isinstance(payload.get("day_plan"), list):
            attrs["day_plan"] = payload["day_plan"]
        if payload.get("week") is not None:
            attrs["week"] = payload["week"]
        if payload.get("day_idx") is not None:
            attrs["day_idx"] = payload["day_idx"]
        return attrs

    return _fn


# ---------------------------------------------------------------------------
# Entity description
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HoymilesSensorDescription(SensorEntityDescription):
    """Sensor description with a value extractor and optional attributes."""

    value_fn: Callable[[dict[str, Any]], Any] | None = None
    attrs_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None
    # Hold the last known value across a restart, see HoymilesSensor.
    restore: bool = False


# Sensors whose topic V0.6.6 defines as 角色: 主机和单机 only.  A **slave** never
# publishes ``system/state`` (§45) or the TOU ack/status topics (§16 / §18 /
# §20), so reading them would show the master's numbers as if they belonged to
# this unit - or, after a restart, nothing at all.  They are reported as
# ``unavailable`` on a slave instead.
#
# ``quick/state`` (§43) is 不限 as a *topic*, but its ``sys_*`` fields are the
# system wide readings and are **only filled in by a master or a stand-alone
# unit**: a slave's payload carries no ``sys_pv_p`` / ``sys_bat_p`` /
# ``sys_soc`` at all (verified on MSA-280577777777, where all of them stay
# ``unknown`` while its own ``pv_p`` / ``bat_p`` / ``soc`` update every second).
# They are deliberately still not gated: an absent field already reads
# ``unknown``, and the cards fall back to the device level value (see
# ``hoymiles-battery.js::_firstRead``).
MASTER_ONLY_KEYS: Final = frozenset({
    "system_pv_energy_today",
    "system_pv2_energy_today",
    "battery_charge_energy_today",
    "battery_discharge_energy_today",
    "plug_output_energy_today",
    "plug_input_energy_today",
    "eps_output_energy_today",
    "eps_input_energy_today",
    "ems_mode_running",
    "tou_plan_status",
    "tou_day_ack",
    "tou_week_ack",
})


# ``device/state`` and ``system/state`` are only pushed every five minutes, and
# ``system/state`` is the only source for the daily energy counters.  Right after
# a Home Assistant restart those entities therefore sit at ``unknown`` for up to
# five minutes, which the dashboard renders as "—".  Restoring the last value
# bridges exactly that gap.  It is deliberately short: the counters start over
# at midnight, so resurrecting yesterday's total would be worse than "—".
RESTORE_MAX_AGE: Final = timedelta(hours=1)
# Alarms are a device-side snapshot, not a counter, so a restored list stays
# useful longer than a restored energy total.  Half an hour is the bound: the
# firmware only publishes ``alarm/state`` when the list changes and the topic is
# not retained, so after a Home Assistant restart the old list is the only thing
# available - but a stale ``4`` sitting there for a day is far more misleading
# than ``unknown``, because the alarms may have been cleared while HA was down.
ALARM_RESTORE_MAX_AGE: Final = timedelta(minutes=30)


_POWER = {
    "device_class": SensorDeviceClass.POWER,
    "native_unit_of_measurement": UnitOfPower.WATT,
    "state_class": SensorStateClass.MEASUREMENT,
}
_ENERGY = {
    "device_class": SensorDeviceClass.ENERGY,
    "native_unit_of_measurement": UnitOfEnergy.WATT_HOUR,
    "state_class": SensorStateClass.TOTAL_INCREASING,
    "restore": True,
}
_VOLTAGE = {
    "device_class": SensorDeviceClass.VOLTAGE,
    "native_unit_of_measurement": UnitOfElectricPotential.VOLT,
    "state_class": SensorStateClass.MEASUREMENT,
}
_CURRENT = {
    "device_class": SensorDeviceClass.CURRENT,
    "native_unit_of_measurement": UnitOfElectricCurrent.AMPERE,
    "state_class": SensorStateClass.MEASUREMENT,
}
_FREQUENCY = {
    "device_class": SensorDeviceClass.FREQUENCY,
    "native_unit_of_measurement": UnitOfFrequency.HERTZ,
    "state_class": SensorStateClass.MEASUREMENT,
}
_TEMPERATURE = {
    "device_class": SensorDeviceClass.TEMPERATURE,
    "native_unit_of_measurement": UnitOfTemperature.CELSIUS,
    "state_class": SensorStateClass.MEASUREMENT,
}
_SOC = {
    "device_class": SensorDeviceClass.BATTERY,
    "native_unit_of_measurement": PERCENTAGE,
    "state_class": SensorStateClass.MEASUREMENT,
}
_REACTIVE_POWER = {
    "device_class": SensorDeviceClass.REACTIVE_POWER,
    "native_unit_of_measurement": "var",
    "state_class": SensorStateClass.MEASUREMENT,
}


SENSOR_DESCRIPTIONS: tuple[HoymilesSensorDescription, ...] = (
    # ---------------- quick/state : device level (1 s) ----------------
    HoymilesSensorDescription(
        key="pv_power", name="PV Power", value_fn=q("pv_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_on_power", name="Grid On Power", value_fn=q("grid_on_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_power", name="Grid Off Power", value_fn=q("grid_off_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="battery_status", name="Battery Status", value_fn=q("bat_sts")
    ),
    # ---------------- quick/state : system level (master/single) ----------------
    HoymilesSensorDescription(
        key="system_pv_power", name="System PV Power", value_fn=q("sys_pv_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_plug_power", name="System Plug Power", value_fn=q("sys_plug_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_battery_power", name="System Battery Power", value_fn=q("sys_bat_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_grid_power", name="System Grid Power", value_fn=q("sys_grid_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_load_power", name="System Load Power", value_fn=q("sys_load_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_smart_plug_power", name="System Smart Plug Power", value_fn=q("sys_sp_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_soc", name="System SOC", value_fn=q("sys_soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="system_pv2_power", name="System PV2 Power", value_fn=q("sys_pv2_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_eps_power", name="System EPS Power", value_fn=q("sys_eps_p"), **_POWER
    ),
    # V0.6.6 added the off-grid port's **input** power in both cadences: §43
    # ``sys_eps_pv_p`` (1 s) and §45 ``eps_pv_p`` (5 min).  Neither the HiFlow
    # models report it, and a unit without a PV input on that port simply sends
    # 0 - so no capability gate is needed.  ``system_eps_power`` above is the
    # port's *output*, this is what arrives on it.
    HoymilesSensorDescription(
        key="system_eps_input_power", name="System EPS Input Power",
        value_fn=q("sys_eps_pv_p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="system_eps_input_power_5m", name="System EPS Input Power (5 min)",
        value_fn=s("eps_pv_p"), **_POWER
    ),
    # ---------------- device/state : battery & signal (5 min) ----------------
    HoymilesSensorDescription(
        key="battery_voltage", name="Battery Voltage", value_fn=d("bat_v"), **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="battery_current", name="Battery Current", value_fn=d("bat_i"), **_CURRENT
    ),
    HoymilesSensorDescription(
        key="battery_temperature", name="Battery Temperature", value_fn=d("bat_temp"), **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="rssi",
        name="RSSI",
        value_fn=d("rssi"),
        device_class=SensorDeviceClass.SIGNAL_STRENGTH,
        native_unit_of_measurement="dBm",
        state_class=SensorStateClass.MEASUREMENT,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    # ---------------- device/state : grid on (index 0) ----------------
    HoymilesSensorDescription(
        key="grid_on_voltage", name="Grid On Voltage", value_fn=grid(0, "v"), **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="grid_on_current", name="Grid On Current", value_fn=grid(0, "i"), **_CURRENT
    ),
    HoymilesSensorDescription(
        key="grid_on_frequency", name="Grid On Frequency", value_fn=grid(0, "f"), **_FREQUENCY
    ),
    HoymilesSensorDescription(
        key="grid_on_power_5m", name="Grid On Power (5 min)", value_fn=grid(0, "p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_on_reactive_power", name="Grid On Reactive Power", value_fn=grid(0, "q"), **_REACTIVE_POWER
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_in_today", name="Grid On Energy In Today", value_fn=grid(0, "ein"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_out_today", name="Grid On Energy Out Today", value_fn=grid(0, "eout"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_in_total", name="Grid On Energy In Total", value_fn=grid(0, "etin"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_on_energy_out_total", name="Grid On Energy Out Total", value_fn=grid(0, "etout"), **_ENERGY
    ),
    # ---------------- device/state : grid off (index 1) ----------------
    HoymilesSensorDescription(
        key="grid_off_voltage", name="Grid Off Voltage", value_fn=grid(1, "v"), **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="grid_off_current", name="Grid Off Current", value_fn=grid(1, "i"), **_CURRENT
    ),
    HoymilesSensorDescription(
        key="grid_off_frequency", name="Grid Off Frequency", value_fn=grid(1, "f"), **_FREQUENCY
    ),
    HoymilesSensorDescription(
        key="grid_off_power_5m", name="Grid Off Power (5 min)", value_fn=grid(1, "p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_reactive_power", name="Grid Off Reactive Power", value_fn=grid(1, "q"), **_REACTIVE_POWER
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_in_today", name="Grid Off Energy In Today", value_fn=grid(1, "ein"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_out_today", name="Grid Off Energy Out Today", value_fn=grid(1, "eout"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_in_total", name="Grid Off Energy In Total", value_fn=grid(1, "etin"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="grid_off_energy_out_total", name="Grid Off Energy Out Total", value_fn=grid(1, "etout"), **_ENERGY
    ),
    # ---------------- device/state : inverter (index 2, no frequency) ----------------
    HoymilesSensorDescription(
        key="inv_voltage", name="Inverter Voltage", value_fn=grid(2, "v"), **_VOLTAGE
    ),
    HoymilesSensorDescription(
        key="inv_current", name="Inverter Current", value_fn=grid(2, "i"), **_CURRENT
    ),
    HoymilesSensorDescription(
        key="inv_power", name="Inverter Power", value_fn=grid(2, "p"), **_POWER
    ),
    HoymilesSensorDescription(
        key="inv_reactive_power", name="Inverter Reactive Power", value_fn=grid(2, "q"), **_REACTIVE_POWER
    ),
    HoymilesSensorDescription(
        key="inv_energy_in_today", name="Inverter Energy In Today", value_fn=grid(2, "ein"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_out_today", name="Inverter Energy Out Today", value_fn=grid(2, "eout"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_in_total", name="Inverter Energy In Total", value_fn=grid(2, "etin"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="inv_energy_out_total", name="Inverter Energy Out Total", value_fn=grid(2, "etout"), **_ENERGY
    ),
    # ---------------- quick/state : PV port power (1 s, §24) ----------------
    # The 1 s topic carries the same reading as ``device/state`` ``pvs[].p`` but
    # ten thousand times more often, so a port that starts producing shows up
    # immediately instead of on the next five minute tick.
    HoymilesSensorDescription(
        key="pv1_power", name="PV1 Power", value_fn=pv_live(0), **_POWER
    ),
    HoymilesSensorDescription(
        key="pv2_power", name="PV2 Power", value_fn=pv_live(1), **_POWER
    ),
    HoymilesSensorDescription(
        key="pv3_power", name="PV3 Power", value_fn=pv_live(2), **_POWER
    ),
    HoymilesSensorDescription(
        key="pv4_power", name="PV4 Power", value_fn=pv_live(3), **_POWER
    ),
    # ---------------- device/state : PV port energy (§25) ----------------
    HoymilesSensorDescription(
        key="pv1_energy_today", name="PV1 Energy Today", value_fn=pv_field(0, "ed"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv2_energy_today", name="PV2 Energy Today", value_fn=pv_field(1, "ed"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv3_energy_today", name="PV3 Energy Today", value_fn=pv_field(2, "ed"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv4_energy_today", name="PV4 Energy Today", value_fn=pv_field(3, "ed"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv1_energy_total", name="PV1 Energy Total", value_fn=pv_field(0, "et"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv2_energy_total", name="PV2 Energy Total", value_fn=pv_field(1, "et"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv3_energy_total", name="PV3 Energy Total", value_fn=pv_field(2, "et"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="pv4_energy_total", name="PV4 Energy Total", value_fn=pv_field(3, "et"), **_ENERGY
    ),
    # ---------------- device/state : packs ----------------
    HoymilesSensorDescription(
        key="pack_count",
        name="Pack Count",
        value_fn=d("pack_num"),
        entity_category=EntityCategory.DIAGNOSTIC,
        # The pack count describes the *hardware*, not a measurement: it does
        # not change minute to minute.  Without the restore a restart (or a
        # device that is briefly silent) turned it ``unknown``, and the
        # dashboard then had to guess how many modules to draw - the battery
        # illustration showed one module while the history chart still drew the
        # four packs the unit really has.  ``device/state`` is only pushed every
        # five minutes, so this is the same "bridge the gap" case the energy
        # counters already use.
        restore=True,
    ),
    HoymilesSensorDescription(
        key="pack1_soc", name="Pack 1 SOC", value_fn=pack(0, "soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="pack1_temperature", name="Pack 1 Temperature", value_fn=pack(0, "temp"), **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack2_soc", name="Pack 2 SOC", value_fn=pack(1, "soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="pack2_temperature", name="Pack 2 Temperature", value_fn=pack(1, "temp"), **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack3_soc", name="Pack 3 SOC", value_fn=pack(2, "soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="pack3_temperature", name="Pack 3 Temperature", value_fn=pack(2, "temp"), **_TEMPERATURE
    ),
    HoymilesSensorDescription(
        key="pack4_soc", name="Pack 4 SOC", value_fn=pack(3, "soc"), **_SOC
    ),
    HoymilesSensorDescription(
        key="pack4_temperature", name="Pack 4 Temperature", value_fn=pack(3, "temp"), **_TEMPERATURE
    ),
    # ``packs[].heat`` is an enum, not a boolean: it tells *why* a pack is cool
    # (``idle`` = nothing to do, ``chg_req`` / ``dchg_req`` = heating was asked
    # for).  The binary sensors above keep the simple "is it heating now", and
    # these carry the reason.
    HoymilesSensorDescription(
        key="pack1_heat_state", name="Pack 1 Heating State", value_fn=pack(0, "heat"),
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    HoymilesSensorDescription(
        key="pack2_heat_state", name="Pack 2 Heating State", value_fn=pack(1, "heat"),
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    HoymilesSensorDescription(
        key="pack3_heat_state", name="Pack 3 Heating State", value_fn=pack(2, "heat"),
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    HoymilesSensorDescription(
        key="pack4_heat_state", name="Pack 4 Heating State", value_fn=pack(3, "heat"),
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    # ---------------- system/state : daily energy (master/single) ----------------
    # ``pv_e`` alone is the unit's own ports; the dashboard's "PV today" tile
    # wants the whole PV side, so the third-party flows from §45 are added on
    # top (see ``s_pv_total``).  The split stays readable as attributes.
    HoymilesSensorDescription(
        key="system_pv_energy_today",
        name="System PV Energy Today",
        value_fn=s_pv_total("pv_e"),
        attrs_fn=pv_today_split,
        **_ENERGY,
    ),
    HoymilesSensorDescription(
        key="system_pv2_energy_today", name="System PV2 Energy Today", value_fn=s("pv2_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="battery_charge_energy_today", name="Battery Charge Energy Today", value_fn=s("chg_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="battery_discharge_energy_today", name="Battery Discharge Energy Today", value_fn=s("dchg_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="plug_output_energy_today", name="Plug Output Energy Today", value_fn=s("plug_out_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="plug_input_energy_today", name="Plug Input Energy Today", value_fn=s("plug_in_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="eps_output_energy_today", name="EPS Output Energy Today", value_fn=s("eps_out_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="eps_input_energy_today", name="EPS Input Energy Today", value_fn=s("eps_in_e"), **_ENERGY
    ),
    HoymilesSensorDescription(
        key="ems_mode_running", name="EMS Mode (Device)", value_fn=s("ems_mode")
    ),
    # ---------------- state event : role and fan levels (§32) ----------------
    # ``role`` is `single` / `master` / `slave`, the same field the firmware
    # checks before it publishes any EMS topic.  It is what the generated
    # dashboard's *visible* condition reads to hide the System tab on a slave:
    # a slave has no system-level measurements of its own (its `system/state`
    # belongs to the master), so that page would only ever show dashes.
    HoymilesSensorDescription(
        key="device_role",
        name="Device Role",
        value_fn=ev("role"),
        icon="mdi:account-supervisor",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    # The level the fan is *actually* running at, which is what the battery
    # card's illustration spins: in `auto` the firmware chooses it, so the
    # target would be the wrong number to draw.  255 = not fitted / not enabled.
    HoymilesSensorDescription(
        key="pcs_fan_level",
        name="PCS Fan Level",
        value_fn=fan_actual("pcs"),
        icon="mdi:fan",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    HoymilesSensorDescription(
        key="battery_fan_level",
        name="Battery Fan Level",
        value_fn=fan_actual("bat"),
        icon="mdi:fan",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    # ---------------- TOU ----------------
    HoymilesSensorDescription(
        key="tou_plan_status",
        name="TOU Plan Status",
        value_fn=_tou_status_value,
        attrs_fn=_tou_attrs(SRC_TOU_STATUS),
    ),
    HoymilesSensorDescription(
        key="tou_day_ack",
        name="TOU Day Plan Ack",
        value_fn=_ack(SRC_TOU_DAY_ACK, TOU_DAY_ACK_STATUS),
        attrs_fn=_tou_attrs(SRC_TOU_DAY_ACK),
    ),
    HoymilesSensorDescription(
        key="tou_week_ack",
        name="TOU Week Plan Ack",
        value_fn=_ack(SRC_TOU_WEEK_ACK, TOU_WEEK_ACK_STATUS),
        attrs_fn=_tou_attrs(SRC_TOU_WEEK_ACK),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the sensors from a config entry.

    Home Assistant resolves a forwarded platform against the integration *root*
    package, so an inverter entry arrives here as well - ``inverter/sensor.py``
    is never imported by Home Assistant on its own.  Hand the entry over before
    touching the storage tables, or a micro inverter would be given the battery
    unit's sensors, which have no ``system_role`` and no ``plant_pv_energy_*``.
    """
    dev_id: str = entry.data.get(CONF_DEV_ID, "")
    if device_family(dev_id) == "inverter":
        from .inverter import sensor as _inverter_sensor  # noqa: PLC0415

        await _inverter_sensor.async_setup_entry(hass, entry, async_add_entities)
        return

    coordinator: HoymilesCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    dev_id = hass.data[DOMAIN][entry.entry_id]["dev_id"]

    async_add_entities(
        [
            *(HoymilesSensor(coordinator, dev_id, description)
              for description in SENSOR_DESCRIPTIONS),
            # V0.6.2 topics.  Both carry a whole document (an alarm list, and ten
            # energy flows), which does not fit an entity description: the value
            # and the attributes are derived, not one field.
            HoymilesAlarmSensor(coordinator, dev_id),
            HoymilesEnergyFlowSensor(coordinator, dev_id),
        ]
    )


class HoymilesSensor(CoordinatorEntity[HoymilesCoordinator], RestoreEntity, SensorEntity):
    """A push-updated sensor fed by the MQTT coordinator."""

    _attr_has_entity_name = True
    entity_description: HoymilesSensorDescription

    def __init__(
        self,
        coordinator: HoymilesCoordinator,
        dev_id: str,
        description: HoymilesSensorDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_{description.key}"
        self._attr_name = description.name
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
        )
        # Filled in by async_added_to_hass; None means "nothing to fall back to".
        self._restored_value: Any = None

    async def async_added_to_hass(self) -> None:
        """Restore the last value so a restart does not blank a slow sensor."""
        await super().async_added_to_hass()

        if not self.entity_description.restore:
            return

        last = await self.async_get_last_state()
        if last is None or last.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
            return

        if dt_util.utcnow() - last.last_updated > RESTORE_MAX_AGE:
            return

        try:
            self._restored_value = float(last.state)
        except (TypeError, ValueError):
            self._restored_value = None

    @property
    def available(self) -> bool:
        """True while the device is pushing data and the role allows it."""
        if not self.coordinator.available:
            return False
        if self.entity_description.key in MASTER_ONLY_KEYS:
            return self.coordinator.allows(ROLE_MASTER_SINGLE)
        return True

    @property
    def native_value(self) -> Any:
        """Return the live value, falling back to the restored one."""
        value_fn = self.entity_description.value_fn
        if value_fn is None:
            return None
        value = value_fn(self.coordinator.data or {})
        if value is None:
            return self._restored_value
        return value

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Return the raw payload fields for ack/status sensors."""
        attrs_fn = self.entity_description.attrs_fn
        if attrs_fn is None:
            return None
        attrs = attrs_fn(self.coordinator.data or {})
        return attrs or None


# ---------------------------------------------------------------------------
# V0.6.2 : alarms (§27)
# ---------------------------------------------------------------------------
# Codes 141-149, 215-219, 231-234 and 311-314 mean different things on a micro
# storage unit and on a micro inverter, so the model decides which table wins.
# The other table is still used as a fallback, because a system alarm can carry
# a code that only appears in the inverter appendix.
INVERTER_MODEL_PREFIX: Final = "hiflow"


def alarm_name(code: int, model: str | None) -> str | None:
    """Return the documented text for one alarm code, or None if unknown."""
    return _alarm_lookup(
        code, model, ALARM_CODES_STORAGE, ALARM_CODES_INVERTER, ALARM_CODE_RANGES
    )


def alarm_name_zh(code: int, model: str | None) -> str | None:
    """The Chinese name of one alarm code, or None when it is untranslated.

    ``None`` rather than the English text on purpose: the caller decides the
    fallback, and the card shows its own "unknown alarm" wording for a code the
    protocol does not document at all. Keeping the two lookups separate also
    means a code missing from the hand-written table simply keeps its English
    name instead of showing a hole.
    """
    return _alarm_lookup(
        code,
        model,
        ALARM_CODES_STORAGE_ZH,
        ALARM_CODES_INVERTER_ZH,
        ALARM_CODE_RANGES_ZH,
    )


def _alarm_lookup(
    code: int,
    model: str | None,
    storage: dict[int, str],
    inverter_table: dict[int, str],
    ranges: tuple[tuple[int, int, str], ...],
) -> str | None:
    """Pick the table by model, then fall back to the other one, then to a range."""
    inverter = bool(model) and str(model).lower().startswith(INVERTER_MODEL_PREFIX)
    primary, secondary = (
        (inverter_table, storage) if inverter else (storage, inverter_table)
    )
    if code in primary:
        return primary[code]
    if code in secondary:
        return secondary[code]
    for low, high, text in ranges:
        if low <= code <= high:
            return text
    return None


def _alarm_code(value: Any) -> int | None:
    """Parse the alarm code, which the firmware sends as a string."""
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


class HoymilesAlarmSensor(
    CoordinatorEntity[HoymilesCoordinator], RestoreEntity, SensorEntity
):
    """The list of alarms that have not ended yet (protocol §27).

    The state is the count, so a simple automation can trigger on
    ``numeric_state above: 0``.  The alarms themselves are attributes: the
    firmware sends at most 20 and replaces the whole list on every change, so
    there is no history to reconstruct - it is a snapshot, and Home Assistant
    records attribute changes in the logbook.

    The device only publishes ``alarm/state`` when the list changes, and the
    topic is **not retained**, so without the restore below the sensor would sit
    at ``unknown`` after every Home Assistant restart until the next alarm
    appeared - possibly for days.  The last list is the device's own snapshot, so
    it is restored and shown until a new one arrives.

    Because the topic is not retained and the device is silent while the list is
    unchanged, silence is ambiguous: it can mean "still alarming" or "cleared
    while Home Assistant was down".  Two rules keep the sensor honest:

    * the restored list expires after :data:`ALARM_RESTORE_MAX_AGE`, and
    * any report that says zero alarms drops it immediately, so a stale list can
      never survive the report that refutes it.

    While a restored list is being shown it carries ``stale: true`` and the time
    it was reported, so a card or an automation can treat it as unconfirmed.
    """

    _attr_has_entity_name = True
    _attr_name = "Active Alarms"
    _attr_icon = "mdi:alert-circle-outline"

    def __init__(self, coordinator: HoymilesCoordinator, dev_id: str) -> None:
        super().__init__(coordinator)
        self._dev_id = dev_id
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_active_alarms"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
        )
        # Filled in by ``async_added_to_hass``: ``None`` means nothing to fall
        # back to, which is the honest "this device never told us" state.
        self._restored: list[dict[str, Any]] | None = None
        self._restored_count: int | None = None
        self._restored_at: datetime | None = None
        self._model_cached: str | None = None

    async def async_added_to_hass(self) -> None:
        """Restore the last alarm list across a restart."""
        await super().async_added_to_hass()

        last = await self.async_get_last_state()
        if last is None or last.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
            return
        if dt_util.utcnow() - last.last_updated > ALARM_RESTORE_MAX_AGE:
            # Old enough that the alarms may have been cleared while Home
            # Assistant was down; unknown is better than a stale list.
            return

        items = last.attributes.get("alarms")
        if not isinstance(items, list):
            return

        self._restored = [item for item in items if isinstance(item, dict)]
        self._restored_at = last.last_updated
        try:
            self._restored_count = int(float(last.state))
        except (TypeError, ValueError):
            self._restored_count = len(self._restored)

    @property
    def available(self) -> bool:
        return self.coordinator.available

    @property
    def _model(self) -> str | None:
        """The product model, used only to pick the right wording of a code.

        Looked up once: this property is read while decoding an alarm report,
        and a report can be decoded several times per coordinator update (state,
        attributes, staleness), each one a device-registry query otherwise.
        """
        if self._model_cached is not None:
            return self._model_cached
        registry = dr.async_get(self.coordinator.hass)
        entry = registry.async_get_device(identifiers={(DOMAIN, self._dev_id)})
        if entry is not None:
            self._model_cached = entry.model
        return entry.model if entry is not None else None

    def _report(self) -> tuple[list[dict[str, Any]], int] | None:
        """Decode the live report, or ``None`` when nothing arrived this start.

        A report of *zero* alarms is a meaningful statement, not silence: the
        firmware keeps a list and replaces it wholesale, so ``alarm_num: 0`` (or
        an empty ``alarm`` array) means everything has ended.  The restored
        snapshot is dropped at that moment, otherwise a list from before a
        restart would survive the very report that refutes it - which is exactly
        how a cleared alarm came back and stayed for hours.
        """
        payload = self.coordinator.data.get(SRC_ALARM)
        if not isinstance(payload, dict):
            return None

        items = payload.get("alarm")
        has_list = isinstance(items, list)
        model = self._model
        decoded: list[dict[str, Any]] = []
        if has_list:
            for item in items[:ALARM_MAX]:
                if not isinstance(item, dict):
                    continue
                code = _alarm_code(item.get("code"))
                if code is None:
                    continue
                entry: dict[str, Any] = {
                    "code": code,
                    "time": item.get("time"),
                    "name": alarm_name(code, model) or f"Unknown alarm {code}",
                }
                # Only when the code is translated: an absent ``name_zh`` is the
                # signal for the card to keep the English name rather than show
                # a blank where the fault should be.
                name_zh = alarm_name_zh(code, model)
                if name_zh:
                    entry["name_zh"] = name_zh
                # §27 makes ``sn`` optional: a single unit omits it, a system
                # with several devices uses it to say which one raised the
                # alarm.  Only carried through when it is actually there, so the
                # attribute does not gain a useless ``null`` on every unit.
                sn = item.get("sn")
                if isinstance(sn, str) and sn:
                    entry["sn"] = sn
                decoded.append(entry)
            # Newest first: the list arrives in the order the device raised
            # them, and the one that just happened is what a user looks for.
            decoded.reverse()

        count = payload.get("alarm_num")
        if not isinstance(count, int) or isinstance(count, bool):
            count = len(decoded)

        if count == 0 or (has_list and not items):
            self._restored = None
            self._restored_count = None
            self._restored_at = None

        return decoded, count

    def _restored_alarms(self) -> list[dict[str, Any]] | None:
        """The restored snapshot, or ``None`` once it is too old to trust.

        Checked on every read, not just at startup: Home Assistant can run for
        weeks while the device says nothing, and a list restored on day one must
        not still be presented as the current alarm state on day three.  The
        bound is the same one used when restoring, so there is a single rule.
        """
        if self._restored is None:
            return None
        if (
            self._restored_at is not None
            and dt_util.utcnow() - self._restored_at > ALARM_RESTORE_MAX_AGE
        ):
            return None
        return self._restored

    @property
    def _alarms(self) -> list[dict[str, Any]] | None:
        """The live list, the restored one, or ``None`` when we never saw one."""
        report = self._report()
        if report is None:
            return self._restored_alarms()
        return report[0]

    @property
    def native_value(self) -> int | None:
        """Number of alarms that have not ended yet, or None before a report."""
        report = self._report()
        if report is None:
            # Nothing since this start: fall back to the restored snapshot.
            # ``None`` (never published, e.g. firmware before V0.6.2, or an
            # expired snapshot) stays ``unknown`` - 0 would claim the device is
            # healthy.
            return None if self._restored_alarms() is None else self._restored_count
        # The count and the list must never disagree: when the firmware sends
        # only ``alarm_num`` the list is empty, and reporting 4 with nothing
        # behind it is worse than reporting what we can actually name.
        named = len(report[0])
        return report[1] if report[1] >= named else named

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        # No list at all (older firmware, or nothing since a restart with no
        # restored snapshot) stays empty: an empty ``alarms`` would read as
        # "nothing is wrong", which is a claim we cannot make.  The card keys
        # off the absence of the attribute and says "no data" instead.
        report = self._report()
        restored = self._restored_alarms()
        stale = report is None and restored is not None
        alarms = restored if report is None else report[0]
        if alarms is None:
            return {}
        attributes: dict[str, Any] = {
            "alarms": alarms,
            "codes": [item["code"] for item in alarms],
            # A single line is what a notification body wants; building it here
            # saves every user from writing the same template.
            "summary": "; ".join(
                f"{item['code']} {item['name']}" for item in alarms
            ),
        }
        # A restored list is shown so the sensor is not blank for the half hour
        # after a restart, but it must say so: it is the last thing the device
        # reported, not necessarily what is true now.
        if stale:
            attributes["stale"] = True
            if self._restored_at is not None:
                attributes["restored_at"] = self._restored_at.isoformat()
        return attributes


# ---------------------------------------------------------------------------
# V0.6.2 : energy flow / sankey (§45)
# ---------------------------------------------------------------------------
# The device computes these itself and pushes today's running totals every five
# minutes; it also clears them at 00:00.  Home Assistant therefore only displays
# them - deriving them from its own history would disagree with the device and
# would keep yesterday's numbers past midnight.
_SANKEY_GROUPS: Final = {
    "pv_prod": SANKEY_PV_PROD,
    "load_cons": SANKEY_LOAD_CONS,
}


class HoymilesEnergyFlowSensor(
    CoordinatorEntity[HoymilesCoordinator], SensorEntity
):
    """Today's energy flows (protocol §48).

    The state is today's total consumption, which is the number the diagram is
    about.  Every individual flow - and the totals that can be derived from
    them - are attributes, so a template sensor or an automation can use them
    without a second round of parsing.

    V0.6.6 changed this topic from 角色: 不限 to 主机和单机, so a **slave** never
    publishes it at all.  The entity is deliberately *not* gated on the role: it
    stays available (its value is simply ``unknown`` on a slave) because the
    power-flow card reads the capability flags off its attributes and falls back
    to the WebSocket answer when they are missing.
    """

    _attr_has_entity_name = True
    _attr_name = "Energy Flow Today"
    _attr_icon = "mdi:chart-sankey"
    _attr_native_unit_of_measurement = UnitOfEnergy.WATT_HOUR
    _attr_device_class = SensorDeviceClass.ENERGY
    # ``total`` rather than ``total_increasing``: the device resets the value to
    # zero at midnight, and ``total`` lets Home Assistant treat that as a real
    # drop instead of inventing a spike.
    _attr_state_class = SensorStateClass.TOTAL

    def __init__(self, coordinator: HoymilesCoordinator, dev_id: str) -> None:
        super().__init__(coordinator)
        self._dev_id = dev_id
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_energy_flow_today"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
        )

    @property
    def available(self) -> bool:
        return self.coordinator.available

    async def async_added_to_hass(self) -> None:
        """Top the archive up from the recorder as soon as the entity id is known.

        Not awaited on purpose: a history query must never delay startup, and the
        live diagram does not depend on the archive.  The sensor exposes the
        archive size as an attribute, so the card notices when the backfill has
        added days and refetches its date picker.
        """
        await super().async_added_to_hass()
        self.hass.async_create_task(
            self.coordinator.async_backfill_sankey(self.entity_id)
        )

    @property
    def _flows(self) -> dict[str, dict[str, int]]:
        """Return ``{group: {field: value}}`` with missing fields as 0."""
        payload = self.coordinator.data.get(SRC_SANKEY)
        raw = payload if isinstance(payload, dict) else {}
        out: dict[str, dict[str, int]] = {}
        for group, fields in _SANKEY_GROUPS.items():
            source = raw.get(group)
            values = source if isinstance(source, dict) else {}
            out[group] = {
                field: int(values.get(field) or 0) for field in fields
            }
        return out

    @property
    def native_value(self) -> int | None:
        """Today's total consumption in Wh.

        The three ``load_cons`` edges are the whole house in the documented
        document: PV to load (``efpv``), battery to load (``efb``) and grid to
        load (``efg``).  Energy that went into the battery is not counted here -
        it is not consumed until it comes back out.
        """
        if not isinstance(self.coordinator.data.get(SRC_SANKEY), dict):
            return None
        load = self._flows["load_cons"]
        return load["efpv"] + load["efb"] + load["efg"]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        flows = self._flows
        pv = flows["pv_prod"]
        load = flows["load_cons"]

        attributes: dict[str, Any] = {
            **{f"pv_{key}": value for key, value in pv.items()},
            **{f"load_{key}": value for key, value in load.items()},
            # Totals the diagram needs and a template would otherwise recompute.
            "pv_production": pv["e2l"] + pv["e2b"] + pv["e2g"],
            "third_party_production": pv["tp2b"] + pv["tp2g"],
            "consumption": load["efpv"] + load["efb"] + load["efg"],
            "grid_import": load["efg"] + load["g2b"],
            "grid_export": pv["e2g"] + pv["b2g"] + pv["tp2g"],
            "battery_in": pv["e2b"] + pv["tp2b"] + load["g2b"],
            "battery_out": pv["b2g"] + load["efb"],
        }
        # The day's PV production and self-consumption, per the vendor rule (see
        # ``self_consumption``).  Exposed here rather than derived in a card
        # because the rule mixes two documents - §45's flows and
        # ``system/state``'s ``pv2_e`` - and both halves have to be read from
        # one snapshot, or the tile and the diagram disagree by a few Wh.
        #
        # The rate only exists when a **grid meter** is part of the system
        # (§46 ``has_meter``): every branch of the rule divides by what the meter
        # saw, so on a unit without one the number would be an artefact of the
        # PV side alone.  ``has_meter`` is ``None`` until the retained state
        # event lands, and that is treated as "no meter known yet" - inventing a
        # figure for the first second after a restart would be wrong for exactly
        # the units this is meant to silence.  With no rate the gauge draws its
        # "—" placeholder, which is the honest answer.
        pv2_today = _pv2_today(self.coordinator.data or {})
        rate = (
            self_consumption(flows, pv2_today)
            if self.coordinator.has_meter is True
            else None
        )
        if rate is not None:
            attributes.update(rate)
        else:
            # No meter, no production today, or no document yet: the ratios are
            # unknown, not zero - a 0 % arc would claim the house used nothing.
            # The PV total itself is independent of the meter, so it stays.
            totals = pv_totals(self.coordinator.data or {})
            if totals is not None:
                attributes["pv_total"] = totals["pv_total"]
            attributes["pv2_production"] = _fmt_energy(pv2_today)
        # The flags the cards need in order to decide what to draw.  A power
        # reading cannot stand in for them: a PV2 inverter or a smart plug
        # that is merely idle reports 0 W, exactly like an absent one.
        # ``None`` (device has not reported a snapshot yet) must stay
        # distinguishable from ``False``; the cards then keep their old
        # "draw it when the entity has a value" behaviour instead of making a
        # device disappear for a second after a restart.
        attributes["has_meter"] = self.coordinator.has_meter
        # The wire field is ``has_solar2`` in V0.6.4 (§32); ``has_pv2`` is kept
        # as an alias because the bundled cards read that name.
        attributes["has_solar2"] = self.coordinator.has_pv2
        attributes["has_pv2"] = self.coordinator.has_pv2
        attributes["has_plug"] = self.coordinator.has_plug
        # Shown from the snapshot the integration cached on disk: the device has
        # not published a new one since this start (it only sends one when the
        # numbers change, and the topic is not retained).  Same convention the
        # alarms use, so an automation can tell it from a live zero.
        restored_at = self.coordinator.sankey_cached_at
        if restored_at is not None:
            attributes["stale"] = True
            attributes["restored_at"] = restored_at.isoformat()
        # How many days the on-disk archive holds.  The sankey card watches this
        # number: it changes when a day is added (or backfilled from the
        # recorder), which is the card's cue to refetch its date picker.  Without
        # it, an archive filled after the card's first fetch would stay invisible
        # until the device published again - possibly hours.
        attributes["history_days"] = len(self.coordinator.sankey_days)
        return attributes

