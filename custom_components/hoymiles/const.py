"""Constants for the Hoymiles Micro Storage integration.

All MQTT topics follow《禾迈微储MQTT协议开发指南》V0.5.1.
``dev_id`` is ``"<client_prefix>-<SN>"`` (or just the SN when no prefix is set).
"""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "hoymiles"
MANUFACTURER: Final = "Hoymiles"
NAME: Final = "Hoymiles Official"

CONF_DEV_ID: Final = "dev_id"

# Stored in the config entry data when the user asked for a dashboard while
# adding the device.  ``dashboard.async_create_device_dashboard`` runs once the
# platforms are set up, because it needs the entity ids to exist.
CONF_CREATE_DASHBOARD: Final = "create_dashboard"

PLATFORMS: Final = ["sensor", "binary_sensor", "number"]

# ---------------------------------------------------------------------------
# Topic templates (device -> HA state, HA -> device command)
# ---------------------------------------------------------------------------
T_QUICK_STATE: Final = "homeassistant/sensor/{dev_id}/quick/state"
T_DEVICE_STATE: Final = "homeassistant/sensor/{dev_id}/device/state"
T_SYSTEM_STATE: Final = "homeassistant/sensor/{dev_id}/system/state"

T_EMS_MODE_CMD: Final = "homeassistant/select/{dev_id}/ems_mode/command"
T_SWITCH_SET: Final = "homeassistant/switch/{dev_id}/set"
T_REBOOT: Final = "homeassistant/button/{dev_id}/reboot/trigger"
T_POWER_CTRL_SET: Final = "homeassistant/number/{dev_id}/power_ctrl/set"
T_OUTPUT_POWER_SET: Final = "homeassistant/number/{dev_id}/output_power/set"
T_PHASE_OUTPUT_POWER_SET: Final = "homeassistant/number/{dev_id}/phase_output_power/set"

T_TOU_DAY_SET: Final = "homeassistant/sensor/{dev_id}/tou_day_plan/set"
T_TOU_WEEK_SET: Final = "homeassistant/sensor/{dev_id}/tou_week_plan/set"
T_TOU_GET: Final = "homeassistant/sensor/{dev_id}/tou_plan/get"
T_TOU_DAY_ACK: Final = "homeassistant/sensor/{dev_id}/tou_day_plan/ack"
T_TOU_WEEK_ACK: Final = "homeassistant/sensor/{dev_id}/tou_week_plan/ack"
T_TOU_STATUS: Final = "homeassistant/sensor/{dev_id}/tou_plan/status"

# Discovery topic used for auto-discovery in the config flow.
T_DISCOVERY: Final = "homeassistant/switch/+/config"

# ---------------------------------------------------------------------------
# Firmware discovery patching (see discovery_override.py)
# ---------------------------------------------------------------------------
DISCOVERY_PREFIX: Final = "homeassistant"

# Catches every discovery config the firmware publishes for one device.
#
# Two patterns are required because the discovery topic depth depends on the
# platform: the "node" level is only present when the payload addresses one
# specific object.
#   homeassistant/<component>/<dev_id>/config           e.g. switch
#   homeassistant/<component>/<dev_id>/<object>/config  e.g. sensor, number
FIRMWARE_DISCOVERY_TOPICS: Final = (
    "homeassistant/+/{dev_id}/config",
    "homeassistant/+/{dev_id}/+/config",
)

# Discovery objects an older firmware used to publish and the current one does
# not.  Their retained configs linger on the broker and Home Assistant rejects
# them on every start (``"mode": "textarea"`` is not a valid TextMode), so they
# are deleted on sight.
#
# Nothing is lost: the TOU plan is exposed through
# ``sensor/<dev_id>/tou_day_plan/set`` and ``sensor/<dev_id>/tou_week_plan/set``
# instead, and Home Assistant never managed to create entities for these
# payloads in the first place.
LEGACY_DISCOVERY_OBJECTS: Final = (
    "text/{dev_id}/tou_day1",
    "text/{dev_id}/tou_day2",
    "text/{dev_id}/tou_day3",
    "text/{dev_id}/tou_day4",
    "text/{dev_id}/tou_day5",
    "text/{dev_id}/tou_day6",
    "text/{dev_id}/tou_day7",
    "text/{dev_id}/tou_day8",
    "text/{dev_id}/tou_week_plan",
)

# Availability topic owned by the integration.  It is only referenced by the
# patched discovery payloads, so it never collides with firmware topics.
T_AVAILABILITY: Final = "hoymiles/{dev_id}/availability"
PAYLOAD_AVAILABLE: Final = "online"
PAYLOAD_NOT_AVAILABLE: Final = "offline"

# State topic owned by the integration for the EMS mode select.  The firmware
# select has no state_topic of its own, so it would read "unknown" after every
# HA restart.  This topic carries the last commanded value (retained) and is
# refined by the mode the device reports in ``system/state``.
#
# It cannot point at ``system/state`` directly: that topic is only pushed every
# 5 minutes, and the bundled TOU card gates its UI on the select state, so a
# freshly issued command would take up to 5 minutes to show up.
T_EMS_MODE_STATE: Final = "hoymiles/{dev_id}/ems_mode/state"

# ---------------------------------------------------------------------------
# Multi phase output power (protocol §8 command, §15 payload)
# ---------------------------------------------------------------------------
PHASE_A: Final = "phase_a"
PHASE_B: Final = "phase_b"
PHASE_C: Final = "phase_c"
PHASES: Final = (PHASE_A, PHASE_B, PHASE_C)
PHASE_POWER_MIN: Final = 100
PHASE_POWER_MAX: Final = 2500
PHASE_POWER_STEP: Final = 1

# ---------------------------------------------------------------------------
# MQTT power setpoint (protocol §14 ``power_ctrl``)
# ---------------------------------------------------------------------------
# The firmware treats this as a lease, not as a setting: it drops the value
# unless it is refreshed at least once a minute and then regulates on its own
# again.  Hence the repeat - see power_repeat.py.
POWER_CTRL_MIN: Final = -1000
POWER_CTRL_MAX: Final = 1000
POWER_CTRL_REPEAT_MIN_S: Final = 1
POWER_CTRL_REPEAT_MAX_S: Final = 3600
POWER_CTRL_REPEAT_DEFAULT_S: Final = 30

# ---------------------------------------------------------------------------
# EMS modes
# ---------------------------------------------------------------------------
EMS_MODE_GENERAL: Final = "general"
EMS_MODE_MQTT_CTRL: Final = "mqtt_ctrl"
EMS_MODE_TOU: Final = "tou_plan"
EMS_MODES: Final = [EMS_MODE_GENERAL, EMS_MODE_MQTT_CTRL, EMS_MODE_TOU]

# ---------------------------------------------------------------------------
# TOU limits (protocol §16)
# ---------------------------------------------------------------------------
TOU_DAY_IDX_MAX: Final = 8
TOU_PLAN_MAX: Final = 12
TOU_TS_MAX: Final = 96
TOU_SOC_MIN: Final = 10
TOU_SOC_MAX: Final = 100
TOU_POWER_MIN: Final = 100
TOU_TS_SLOT_MIN: Final = 15  # one slot == 15 minutes
TOU_MODES: Final = [1, 2, 4]
TOU_WEEKDAYS: Final = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# ---------------------------------------------------------------------------
# Coordinator data keys
# ---------------------------------------------------------------------------
SRC_QUICK: Final = "quick"
SRC_DEVICE: Final = "device"
SRC_SYSTEM: Final = "system"
SRC_TOU_STATUS: Final = "tou_status"
SRC_TOU_DAY_ACK: Final = "tou_day_ack"
SRC_TOU_WEEK_ACK: Final = "tou_week_ack"

# ---------------------------------------------------------------------------
# Availability / staleness (protocol §22 pushes every 1 s, §23/§24 every 5 min)
# ---------------------------------------------------------------------------
# How often the availability watchdog re-evaluates source freshness.
AVAILABILITY_WATCHDOG_SECONDS: Final = 30

# A ``system/state`` report arriving right after an EMS mode command may still
# carry the previous mode (the topic is only pushed every 5 minutes).  Such
# reports are ignored for this long so the select does not flip back.
EMS_MODE_ECHO_GUARD_SECONDS: Final = 30

# A source is alive while its last message is younger than its window.
# Event driven topics (TOU ack/status) are excluded on purpose.
SOURCE_STALE_SECONDS: Final = {
    SRC_QUICK: 120,
    SRC_DEVICE: 660,
    SRC_SYSTEM: 660,
}

# TOU ack status codes (protocol §17 / §19)
TOU_DAY_ACK_STATUS: Final = {
    0: "success",
    1: "general error",
    2: "too many segments",
    3: "time range overlap",
    4: "mode out of range",
    5: "ts/te out of range",
    6: "sh/sl out of range",
    7: "pc/pd out of range",
    8: "day_idx out of range",
    9: "ts greater than te",
    10: "tou_plan not set",
}

TOU_WEEK_ACK_STATUS: Final = {
    0: "success",
    1: "general error",
    2: "week out of range",
    3: "week overlap",
    4: "day_idx out of range",
    5: "day_idx not configured",
    6: "tou_plan not set",
}

TOU_GET_STATUS: Final = {
    0: "success",
    1: "general error",
    2: "week out of range",
}

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------
FRONTEND_URL: Final = "/hoymiles_static"

# Frontend assets bundled in ``www/`` and auto-injected as ES modules.
# Add new cards here; ``__init__._async_register_frontend`` walks this tuple.
CARD_FILENAME: Final = "hoymiles-tou-editor.js"
SANKEY_CARD_FILENAME: Final = "hoymiles-energy-sankey.js"
POWER_FLOW_CARD_FILENAME: Final = "hoymiles-power-flow.js"
BATTERY_CARD_FILENAME: Final = "hoymiles-battery.js"
HISTORY_CHART_CARD_FILENAME: Final = "hoymiles-history-chart.js"
GAUGE_CARD_FILENAME: Final = "hoymiles-gauge.js"
CONTROL_CARD_FILENAME: Final = "hoymiles-control.js"
DIAGNOSTICS_CARD_FILENAME: Final = "hoymiles-diagnostics.js"
PACK_LIST_CARD_FILENAME: Final = "hoymiles-pack-list.js"
# Not a card: it injects the language switch into the Home Assistant toolbar.
LANG_SWITCH_FILENAME: Final = "hoymiles-lang.js"
FRONTEND_ASSETS: Final = (
    CARD_FILENAME,
    SANKEY_CARD_FILENAME,
    POWER_FLOW_CARD_FILENAME,
    BATTERY_CARD_FILENAME,
    HISTORY_CHART_CARD_FILENAME,
    GAUGE_CARD_FILENAME,
    CONTROL_CARD_FILENAME,
    DIAGNOSTICS_CARD_FILENAME,
    PACK_LIST_CARD_FILENAME,
    LANG_SWITCH_FILENAME,
)

CARD_URL: Final = f"{FRONTEND_URL}/{CARD_FILENAME}"

# ---------------------------------------------------------------------------
# Auto generated dashboard (see dashboard.py)
# ---------------------------------------------------------------------------
# A dashboard is created as ``<prefix><serial>`` e.g. ``g3-280520260806``, and
# titled ``G3_280520260806`` - the same naming the integration has always used,
# so existing dashboards are recognised instead of being duplicated.
DASHBOARD_URL_PREFIX: Final = "g3-"
DASHBOARD_TITLE_PREFIX: Final = "G3_"
DASHBOARD_ICON: Final = "mdi:home-battery"

# ---------------------------------------------------------------------------
# Sankey card defaults
# ---------------------------------------------------------------------------
# Statistics query period used by the energy sankey card.
SANKEY_PERIOD: Final = "day"

# ---------------------------------------------------------------------------
# Product families: PID -> which code path serves the device
# ---------------------------------------------------------------------------
# The four digits right after the client prefix are the **PID** - the firmware's
# product identification number - and every discriminating decision is made on
# them rather than on the prefix.
#
# The prefix in front of the serial (``RMI-``, ``MSA-``, ...) is a *user
# setting*: it is the MQTT client prefix and the user may change it to anything.
# So ``RMI-`` cannot be used to recognise a device, and neither can the firmware's
# model string, which names a whole family ("HiFlow" covers both the 1-input 1650
# and the 1-input 4160).  The PID is stable, is present in every spelling of the
# serial, and - unlike ``device/state["pv_num"]`` - is known *before* the first
# payload arrives, which matters because entities are created during setup.
#

# Two families are served by this integration and they share nothing but the
# MQTT transport:
#
#   inverter  1650 / 4160 / 4161 / 4162   grid-tied micro inverters (HiFlow)
#   storage   2800                        battery storage units (HiBattery)
#
# ``inverter/`` implements the first family on its own coordinator, entity
# tables, dashboard engine and cards; ``__init__`` dispatches on the PID before
# anything else happens, so the storage code path - entity set, dashboard,
# services - is byte for byte the one that shipped before the inverters were
# added.
PID_PV_COUNT: Final[dict[str, int]] = {
    "1650": 1,  # HiFlow, single input
    "4160": 1,  # HiFlow Pro 1-in-1
    "4161": 2,  # HiFlow Pro 2-in-1
    "4162": 4,  # HiFlow Pro 4-in-1
}
# Every PID above is a grid-tied micro inverter.  Storage units carry a
# different PID and are recognised by *not* being in this set - the firmware
# reports their port count as ``pv_num`` instead.  ``2800`` is the only storage
# PID seen in the field (``MSA-2800...``); a unit with an unlisted PID can still
# be added by typing its serial, because the config flow accepts custom values.
INVERTER_PIDS: Final[frozenset[str]] = frozenset(PID_PV_COUNT)
STORAGE_PIDS: Final[frozenset[str]] = frozenset({"2800", "2804", "2805", "2806"})
# What the config flow will offer on its own.  Deliberately a closed set: the
# discovery wildcard also matches unrelated devices that publish under
# ``homeassistant/``, and offering those would be noise in the picker.
KNOWN_PIDS: Final[frozenset[str]] = INVERTER_PIDS | STORAGE_PIDS
# Storage units do not publish a fixed port count in their serial; the firmware
# reports ``pv_num`` instead.  Four is the documented maximum, so it is used as
# the default whenever the count cannot be derived up front.
PV_COUNT_MAX: Final = 4

# Kept under its old name because the cards' JS mirrors this table and the docs
# refer to it; it is the same mapping as :data:`PID_PV_COUNT`.
PV_COUNT_BY_CODE: Final[dict[str, int]] = PID_PV_COUNT

def serial_body(dev_id: str) -> str:
    """Return the serial without its (user changeable) client prefix.

    ``RMI-4161A0209FF6`` -> ``"4161A0209FF6"``, and a bare ``4161A0209FF6`` is
    returned unchanged.  Splitting on ``-`` and keeping the last part survives
    any prefix the user configures, including one that itself contains ``-``.
    """
    return dev_id.split("-")[-1].strip()

def serial_pid(dev_id: str) -> str | None:
    """Return the four digit product id at the start of the serial, if any.

    ``RMI-4161A0209FF6`` -> ``"4161"`` and ``MSA-280024180016`` -> ``"2800"``.
    The prefix plays no part: only the serial body is inspected.
    """
    digits = serial_body(dev_id)[:4]
    if len(digits) != 4 or not digits.isdigit():
        return None
    return digits

def is_inverter_dev_id(dev_id: str) -> bool:
    """True when this serial belongs to a grid-tied micro inverter.

    Recognition is by PID, so it works for any client prefix the user chooses.
    A serial whose PID is unknown is treated as storage, which is the
    conservative answer: it is the family this integration has always served.
    """
    pid = serial_pid(dev_id)
    return pid is not None and pid in INVERTER_PIDS

def pv_count_from_dev_id(dev_id: str) -> int | None:
    """Return how many PV inputs this unit has, or ``None`` when unknown.

    ``RMI-4161A0209FF6`` -> ``"4161"`` -> ``2``.  A serial that is not a known
    inverter PID returns ``None`` so the caller can fall back to the firmware's
    own ``pv_num`` or to the maximum.
    """
    pid = serial_pid(dev_id)
    if pid is None:
        return None
    return PID_PV_COUNT.get(pid)

def device_family(dev_id: str) -> str:
    """Return ``"inverter"`` or ``"storage"`` for a config entry's serial."""
    return "inverter" if is_inverter_dev_id(dev_id) else "storage"
