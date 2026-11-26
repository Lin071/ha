"""Constants for the Hoymiles Micro Storage integration.

All MQTT topics follow《禾迈微储与微逆MQTT协议开发指南》V0.6.5.
``dev_id`` is ``"<client_prefix>-<SN>"`` (or just the SN when no prefix is set).

This module tracks the document exactly; the version is not negotiated, so a
device running older firmware simply never publishes the topics it does not
support.  V0.6.4 replaced the per-control topics with grouped ``meta`` /
``set`` topics for the fan, the heater and the fine-grained control block, split
``soc_limit`` into two independent numbers, and moved ``pv_power`` into
``fine_ctrl``; V0.6.5 moved the virtual meter into the same ``meta`` pattern and
gave it two cumulative energy readings next to the power setpoint.
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

PLATFORMS: Final = ["sensor", "binary_sensor", "number", "select", "switch"]

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

# ---------------------------------------------------------------------------
# V0.6.2+ push topics (§24 - §27, §32, §45)
# ---------------------------------------------------------------------------
# State event: a *full* snapshot of every entity's state, published when the
# connection is established and again whenever one of those states changes
# (protocol §32).  It is the only topic that reports the real on/off state and
# the real EMS mode, which is why the switch and the EMS select are driven from
# here instead of from Home Assistant's own optimistic memory.
T_EVENT_STATE: Final = "homeassistant/sensor/{dev_id}/event/state"

# Warnings: the full list of alarms that have not ended yet, at most 20, pushed
# whenever the list changes (protocol §27).
T_ALARM_STATE: Final = "homeassistant/sensor/{dev_id}/alarm/state"

# Sankey: today's energy flows, pushed every five minutes, cleared by the device
# at 00:00 (protocol §45).
T_SANKEY_STATE: Final = "homeassistant/sensor/{dev_id}/sankey/state"

# ---------------------------------------------------------------------------
# V0.6.4 grouped control topics (§37 - §42)
# ---------------------------------------------------------------------------
# The fan, the heater and the fine-grained block are each described by one
# ``meta`` topic and written through one ``set`` topic that takes an **object**.
# The document invites a self-developed integration layer to turn every entry of
# ``controls`` into its own Home Assistant entity, which is what `number.py`,
# `select.py` and `switch.py` do.
#
# ``meta`` deliberately does not end in ``/config``: Home Assistant's MQTT
# discovery subscribes to ``<prefix>/+/+/config`` and ``<prefix>/+/+/+/config``,
# so a ``config`` suffix would make the broker hand the group description to
# MQTT discovery, which would then reject it as an unknown entity schema.
T_FAN_META: Final = "homeassistant/{dev_id}/fan/meta"
T_FAN_SET: Final = "homeassistant/{dev_id}/fan/set"
T_HEAT_META: Final = "homeassistant/{dev_id}/heat/meta"
T_HEAT_SET: Final = "homeassistant/{dev_id}/heat/set"
T_FINE_CTRL_META: Final = "homeassistant/{dev_id}/fine_ctrl/meta"
T_FINE_CTRL_SET: Final = "homeassistant/{dev_id}/fine_ctrl/set"

# ---------------------------------------------------------------------------
# V0.6.4 scalar control topics
# ---------------------------------------------------------------------------
# §33 - §36: the charge and discharge cut-offs are two independent entities,
# each with its own config, its own range and a **scalar** command.
T_SOC_H_LIMIT_SET: Final = "homeassistant/number/{dev_id}/soc_h_limit/set"
T_SOC_L_LIMIT_SET: Final = "homeassistant/number/{dev_id}/soc_l_limit/set"

T_INPUT_POWER_SET: Final = "homeassistant/number/{dev_id}/input_power/set"
T_METER_CTRL_SET: Final = "homeassistant/number/{dev_id}/meter_ctrl/set"

# V0.6.5 §11: the virtual meter became a *group* - one ``meta`` topic describing
# three writable controls (``power``, ``eng_out``, ``eng_in``) and one ``set``
# topic that takes an **object**.  The old ``number/<dev_id>/meter_ctrl/config``
# discovery payload is gone, which is why discovery_override.py deletes it.
T_METER_CTRL_META: Final = "homeassistant/{dev_id}/meter_ctrl/meta"

# ---------------------------------------------------------------------------
# V0.6.6 group / scalar topics (§27 - §32)
# ---------------------------------------------------------------------------
# Two more object-taking groups joined the ``meta`` pattern, both 仅多相主机:
# the per phase **input** limit (§27/§28) and the per phase **house input**
# limit (§31/§32).  Like the meter they are described by a ``meta`` topic and
# carry all three phases in one object, so the integration creates the entities.
T_PHASE_INPUT_META: Final = "homeassistant/{dev_id}/phase_input_power/meta"
T_PHASE_INPUT_SET: Final = "homeassistant/number/{dev_id}/phase_input_power/set"
T_PHASE_HOUSE_IN_META: Final = "homeassistant/{dev_id}/phase_house_in_power/meta"
T_PHASE_HOUSE_IN_SET: Final = "homeassistant/number/{dev_id}/phase_house_in_power/set"

# V0.6.7 §29/§30: the feed-in ceiling stopped being a scalar firmware entity.
# The unit now describes it with a ``meta`` topic and writes **one object** with
# two controls - an enable switch and the limit - so the integration creates the
# entities (a Home Assistant ``number`` cannot carry an object command).
T_FEED_POWER_META: Final = "homeassistant/{dev_id}/feed_power/meta"
T_FEED_POWER_SET: Final = "homeassistant/number/{dev_id}/feed_power/set"

# The device announces which optional controls it has by publishing a discovery
# config for them (protocol §33, §35, §37, §39, §41, §43).  The set of config
# topics that actually arrived is therefore the capability list, and unlike a
# hard-coded model table it stays correct for models that do not exist yet.
T_NUMBER_DISCOVERY: Final = "homeassistant/number/{dev_id}/{object}/config"
T_SELECT_DISCOVERY: Final = "homeassistant/select/{dev_id}/{object}/config"

# Announcement Home Assistant makes when it (re)connects to the broker, so the
# device can rebuild its entities and resync state (protocol §46).
T_HA_STATUS: Final = "homeassistant/status"
PAYLOAD_HA_ONLINE: Final = "online"

DISCOVERY_TOPIC_RE: Final = (
    r"^homeassistant/(?P<component>[a-z_]+)/(?P<dev_id>[^/]+)/(?P<object>[^/]+)/config$"
)

# ---------------------------------------------------------------------------
# Model capabilities
# ---------------------------------------------------------------------------
# An AC-coupled unit has **no MPPT input of its own**: the PV comes from micro
# inverters on the AC side, so the storage unit's `pv_p` / `sys_pv_p` are
# published as a hard 0 on every state message.  They are published, though -
# the firmware sends every PV topic on every model - so neither "the entity
# exists" nor "it reports a value" can decide whether the branch is real.
# The product model is the only source that can, and it is already backfilled
# into the device registry (see ``discovery_override._maybe_backfill_model``).
#
# A model that is *not* listed here keeps everything: drawing a flat 0 W curve
# is a much smaller mistake than hiding a branch that really exists.
#
# ``1920 AC`` is the second generation of the same product line: like the
# ``4020 AC`` it is AC coupled, so it has no MPPT of its own and publishes every
# PV topic as a hard 0.
MODELS_WITHOUT_PV: Final = (
    "hibattery 4020 ac",
    "hibattery 1920 ac",
    # The MS-A2 is a pure AC-coupled cabinet as well: it ships with a single
    # battery port and the AC socket on the side face, no MPPT at all.
    "ms-a2",
    "msa2",
    "hibattery ms-a2",
)


def model_has_pv(model: str | None) -> bool:
    """Return False only for a model known to have no PV input at all.

    Unknown (``None`` / empty) means **yes**: a device whose model has not been
    backfilled yet must keep every curve, and the dashboard is regenerated once
    the model arrives.
    """
    if not model:
        return True
    return str(model).strip().lower() not in MODELS_WITHOUT_PV


# ---------------------------------------------------------------------------
# V0.6.4 control ranges (§33 ~ §44)
# ---------------------------------------------------------------------------
# §33 / §35 give each cut-off its own band, and they are not the same band.
SOC_H_MIN: Final = 50
SOC_H_MAX: Final = 100
SOC_L_MIN: Final = 10
SOC_L_MAX: Final = 70
# The firmware rejects a pair closer than this (§34 / §36).
SOC_MIN_GAP: Final = 10

# ``fan_actual`` uses 255 as "this fan is not fitted / not reportable"; treating
# it as a speed would show a 255 % fan spinning at 25 times full speed.
FAN_LEVEL_MIN: Final = 0
FAN_LEVEL_MAX: Final = 10
FAN_LEVEL_INVALID: Final = 255
FAN_MODES: Final = ("auto", "manual", "disable")

# §39: ``param`` means watts in ``power`` mode and degrees in ``temp`` mode, so
# the range and the unit both depend on the mode the device reports.  ``disable``
# is the third position: the heater is switched off, and both ``param`` and
# ``pack_ids`` are ignored by the firmware while it is in force.
#
# The floors are NOT the firmware's 0: heating at 0 W is the same as off, and a
# 0 °C target is below anything the packs are ever heated to, so the control
# offers the band that is actually usable (20 W .. 175 W, 10 °C .. 25 °C).
HEAT_MODES: Final = ("power", "temp", "disable")
HEAT_POWER_MIN: Final = 20
HEAT_POWER_MAX: Final = 175
HEAT_TEMP_MIN: Final = 10
HEAT_TEMP_MAX: Final = 25
HEAT_PACK_MIN: Final = 1
HEAT_PACK_MAX: Final = 4

# §13 / §14: the fine-grained block writes the grid setpoint and the PV ceiling.
# V0.6.6 widened the grid band to +-2500 W and lowered the PV ceiling to 2500 W
# (§13 keeps "0 = forbid PV output" for the latter).
FINE_GRID_MIN: Final = -2500
FINE_GRID_MAX: Final = 2500
FINE_GRID_STEP: Final = 0.1
PV_POWER_MIN: Final = 0
PV_POWER_MAX: Final = 2500

# §27 / §31: the per phase input limit and the per phase house input limit share
# one band.  ``max`` follows the system type, so the entities read the value the
# meta topic declares and these are only the fallbacks.
PHASE_INPUT_POWER_MIN: Final = 100
PHASE_INPUT_POWER_MAX: Final = 2500
PHASE_HOUSE_IN_POWER_MIN: Final = 100
PHASE_HOUSE_IN_POWER_MAX: Final = 2500
PHASE_LIMIT_STEP: Final = 1

# §29 / §30: 0 forbids feeding the grid, ``max`` also follows the system type.
FEED_POWER_MIN: Final = 0
FEED_POWER_MAX: Final = 2500

INPUT_POWER_MIN: Final = 100
INPUT_POWER_MAX: Final = 2500

# §11 / §12 ``meter_ctrl``: the virtual meter is a write-only simulation of a
# grid meter.  ``power`` is the setpoint in watts (positive = import), while
# ``eng_out`` / ``eng_in`` are the **cumulative readings** the simulated meter
# reports: energy delivered to the grid and energy taken from it, in Wh.
#
# The band below is only a fallback: §11 puts the authoritative ``min`` / ``max``
# / ``step`` on the ``meter_ctrl/meta`` topic, and the entities read them from
# there.  The document's V0.6.5 values are -5000..5000 W (step 0.1) and
# 0..4294967295 Wh (step 1).
METER_CTRL_MIN: Final = -5000
METER_CTRL_MAX: Final = 5000
METER_CTRL_STEP: Final = 0.1
METER_ENERGY_MIN: Final = 0
METER_ENERGY_MAX: Final = 4294967295
METER_ENERGY_STEP: Final = 1
# The three writable fields, in the order the document lists them.  Used to
# build the full object that is re-published on every lease tick.
METER_FIELDS: Final = ("power", "eng_out", "eng_in")

ALARM_MAX: Final = 20

# Sankey field names, in the order they are drawn (protocol §45).
#
# Two groups, ten fields:
#
#     pv_prod    e2l e2b e2g b2g tp2b tp2g                              (6)
#     load_cons  efpv efb efg g2b                                       (4)
#
# ``efpv`` is the load side of ``e2l`` (the device reports both ends of the same
# flow); it is kept in the tuple so the attribute survives, but never drawn - see
# the card's FLOWS table.
#
# A later firmware revision added `e2kl/g2kl/b2kl/tp2kl` (known load) and
# `*loss`, which split one house into three sinks.  They are deliberately NOT
# read here: the diagrams draw the documented ten, where the house is one node.
# The fields on the wire are unaffected - a device that publishes the extra ones
# simply has them ignored.
SANKEY_PV_PROD: Final = ("e2l", "e2b", "e2g", "b2g", "tp2b", "tp2g")
SANKEY_LOAD_CONS: Final = ("efpv", "efb", "efg", "g2b")

# How many days of energy-flow snapshots are kept on disk.
#
# One entry is twelve small integers plus a timestamp (a few hundred bytes), so
# a month of them is nothing - but the point of the archive is "yesterday and the
# day before", so there is no reason to grow it without bound.  The value the
# device publishes is a **daily cumulative**; the snapshot kept for a past day is
# therefore that day's last report, which is the number the sankey drew at
# 23:59.
SANKEY_HISTORY_DAYS: Final = 31

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
# EMS modes (§3, §13)
# ---------------------------------------------------------------------------
EMS_MODE_GENERAL: Final = "general"
EMS_MODE_MQTT_CTRL: Final = "mqtt_ctrl"
EMS_MODE_FINE_CTRL: Final = "fine_ctrl"
EMS_MODE_TOU: Final = "tou_plan"
EMS_MODE_METER: Final = "meter_ctrl"
EMS_MODES: Final = [
    EMS_MODE_GENERAL,
    EMS_MODE_MQTT_CTRL,
    EMS_MODE_FINE_CTRL,
    EMS_MODE_TOU,
    EMS_MODE_METER,
]

# What a **slave** may select.  V0.6.6 opened §7/§8 itself to 角色: 不限 (so the
# picker is offered to every unit), but the two modes a slave can legitimately
# run are still the two whose *set topics* are not tied to the system level: it
# regulates on its own (`general`, the default) or it follows the device level
# precise control block (`fine_ctrl`, §13/§14).  `mqtt_ctrl` (§9/§10),
# `tou_plan` (§15-§20) and `meter_ctrl` (§11/§12) all write system level
# setpoints that belong to the master, so a slave is never offered them.
#
# §7 also narrows the list by **hardware**: when a `HiFlow` / `HiFlow Pro` is
# part of the system only `general` / `tou_plan` / `meter_ctrl` are supported
# (`mqtt_ctrl` and `fine_ctrl` are not).  Those units are served by the separate
# `hoymiles_g2` integration, so no filter is applied here.
EMS_MODES_SLAVE: Final = (EMS_MODE_GENERAL, EMS_MODE_FINE_CTRL)


def ems_modes_for_role(role: str | None) -> tuple[str, ...]:
    """The EMS modes a unit with this role may select.

    ``None`` (nothing heard yet) allows everything: a restart must not blank the
    picker before the retained state event lands.
    """
    if role == ROLE_SLAVE:
        return EMS_MODES_SLAVE
    return tuple(EMS_MODES)
# The two modes whose setpoints are a lease: they must be refreshed at least
# once a minute or the device falls back to self-consumption (§14, §42).
EMS_MODES_LEASE: Final = (EMS_MODE_MQTT_CTRL, EMS_MODE_FINE_CTRL)

# ---------------------------------------------------------------------------
# Device role (§32 ``role``) and the scopes the document allows
# ---------------------------------------------------------------------------
# Every topic carries a 角色 line.  Four values appear (V0.6.6 adds the last):
#
#   · 角色: 不限                -> ROLE_ANY
#   · 角色: 主机和单机          -> ROLE_MASTER_SINGLE   (a **slave** has none of it)
#   · 角色: 仅多相主机          -> ROLE_MULTIPHASE_MASTER
#   · 角色: 仅主机              -> ROLE_MASTER_ONLY     (a single unit has none of it)
#
# A slave therefore has no system level power control (§9/§10), no virtual meter
# (§11/§12), no TOU plan (§15-§20), no output / input / per-phase ceiling
# (§21-§32) and no ``system/state`` (§45) of its own - those all belong to the
# master and are published on the master's topics.
#
# V0.6.6 moved the EMS mode picker (§7/§8) from 主机和单机 to **不限**; what a
# unit may actually *run* is unchanged - ``mqtt_ctrl`` / ``fine_ctrl`` /
# ``meter_ctrl`` are still 主机和单机 for the setpoint they write, which is why
# the picker's options are filtered per role instead of the whole select being
# unavailable (see ``EMS_MODES_SLAVE``).
#
# The role is reported in ``event/state`` (retained), so it is known within a
# second of start-up.  ``None`` (nothing heard yet) deliberately allows
# everything: hiding the whole UI of a unit whose role has not arrived would be
# worse than showing a control that turns out to be unsupported.
ROLE_SINGLE: Final = "single"
ROLE_MASTER: Final = "master"
ROLE_SLAVE: Final = "slave"

ROLE_ANY: Final = "any"
ROLE_MASTER_SINGLE: Final = "master_single"
ROLE_MULTIPHASE_MASTER: Final = "multiphase_master"
ROLE_MASTER_ONLY: Final = "master_only"

# Human readable reason, used by the entities and the cards.
ROLE_SCOPE_LABEL: Final = {
    ROLE_MASTER_SINGLE: "主机和单机",  # §9-§12, §15-§22, §25, §26, §45
    ROLE_MULTIPHASE_MASTER: "仅多相主机",  # §23, §24, §27, §28, §31, §32
    ROLE_MASTER_ONLY: "仅主机",  # §29, §30
}

# ---------------------------------------------------------------------------
# Role availability (integration owned)
# ---------------------------------------------------------------------------
# The firmware registers some of its entities through MQTT discovery, so the
# integration cannot set their ``available`` property.  Instead it appends a
# second availability entry pointing at one of these topics and keeps them in
# sync with the role the unit reports: ``offline`` makes Home Assistant show the
# entity as unavailable, which disables it for the user.
T_ROLE_AVAILABILITY: Final = "hoymiles/{dev_id}/role_availability"
T_PHASE_AVAILABILITY: Final = "hoymiles/{dev_id}/phase_availability"
# V0.6.6 §29/§30 are 角色: 仅主机 - a *single* unit must be excluded too, so the
# "master or single" topic above is not strict enough for them.
T_MASTER_AVAILABILITY: Final = "hoymiles/{dev_id}/master_availability"

# Firmware discovery objects the document restricts by role, and the scope that
# decides whether they are allowed.  ``{dev_id}`` is expanded before lookup.
FIRMWARE_ROLE_GATED: Final = {
    # §9 / §10 system level power control
    "number/{dev_id}/power_ctrl": ROLE_MASTER_SINGLE,
    # §21 / §22 output power ceiling
    "number/{dev_id}/output_power": ROLE_MASTER_SINGLE,
    # §25 / §26 input power ceiling
    "number/{dev_id}/input_power": ROLE_MASTER_SINGLE,
    # §23 / §24 per phase ceiling - a multi phase master only
    "number/{dev_id}/phase_output_power": ROLE_MULTIPHASE_MASTER,
    # §29 / §30 stopped being a firmware entity in V0.6.7 (it is a ``meta``
    # group now, created by number.py / switch.py), so it is no longer gated
    # here.  A retained config from an older firmware is deleted instead - see
    # ``discovery_override.SUPERSEDED_DISCOVERY_OBJECTS``.
    # §7 / §8 the EMS mode picker is **not** gated as a whole: V0.6.6 defines it
    # as 角色: 不限, and a slave still selects `general` / `fine_ctrl`, so only
    # its *options* are narrowed (see `EMS_MODES_SLAVE` and
    # `discovery_override._patch_ems_mode`).
}

# ---------------------------------------------------------------------------
# TOU limits (protocol §18)
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
SRC_EVENT: Final = "event"
SRC_ALARM: Final = "alarm"
SRC_SANKEY: Final = "sankey"
# V0.6.4 group descriptions (§37 / §39 / §41).  Their presence *is* the
# capability: a unit without a fan never publishes ``fan/meta``.
SRC_FAN_META: Final = "fan_meta"
SRC_HEAT_META: Final = "heat_meta"
SRC_FINE_META: Final = "fine_meta"
# V0.6.5 §11: the virtual meter group description.  Its presence means the unit
# supports ``meter_ctrl`` at all (the HiFlow models do not).
SRC_METER_META: Final = "meter_meta"
# V0.6.6 §27 / §31: the two per phase limit groups.  Their presence is again the
# capability: only a multi phase master publishes them at all.
SRC_PHASE_INPUT_META: Final = "phase_input_meta"
SRC_PHASE_HOUSE_IN_META: Final = "phase_house_in_meta"
# V0.6.7 §29: the feed-in group.  Its presence is the capability: a stand-alone
# unit and a slave never publish it (§29 is 角色: 仅主机).
SRC_FEED_META: Final = "feed_meta"

# ---------------------------------------------------------------------------
# Availability / staleness (protocol §22 pushes every 1 s, §23/§24 every 5 min)
# ---------------------------------------------------------------------------
# How often the availability watchdog re-evaluates source freshness.
AVAILABILITY_WATCHDOG_SECONDS: Final = 30

# How long a freshly started Home Assistant waits for the unit to say anything
# before it calls it offline.  ``quick/state`` arrives every second, so two
# minutes of complete silence right after a restart means the unit is switched
# off - and without this the "no last-seen stamp, so no verdict" rule kept a
# powered-off unit looking healthy for ever.
AVAILABILITY_STARTUP_GRACE_SECONDS: Final = 120

# A ``system/state`` report arriving right after an EMS mode command may still
# carry the previous mode (the topic is only pushed every 5 minutes).  Such
# reports are ignored for this long so the select does not flip back.
EMS_MODE_ECHO_GUARD_SECONDS: Final = 30

# A source is alive while its last message is younger than its window.
# Event driven topics (TOU ack/status, alarms, the state event) are excluded on
# purpose: they only speak when something changes, so silence is normal.
#
# ``sankey`` is included even though it is only pushed every 5 minutes: it is a
# fixed-cadence topic like the other two, and its window is wide enough to cover
# one missed tick.
#
# ``quick`` is 1 s, so its window is short: 60 s of silence is 60 missed
# messages, not a hiccup.
SOURCE_STALE_SECONDS: Final = {
    SRC_QUICK: 60,
    SRC_DEVICE: 660,
    SRC_SYSTEM: 660,
    SRC_SANKEY: 900,
}

# The sources that speak every second.  When one of them has ever been seen its
# own window decides on its own, and the slow topics are ignored - they are
# 5-minute cadences, so their window has to be ~11 minutes wide to survive one
# missed tick, and letting them vote "alive" kept a switched-off unit looking
# healthy for 11-15 minutes.  A unit that never publishes ``quick/state`` (older
# firmware) falls back to the slow ones and keeps the old behaviour.
FAST_SOURCES: Final = (SRC_QUICK,)

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

# >>> ALARM CODE TABLES (generated by _preview/gen_alarm_codes.py) >>>

# Protocol §27 alarm codes, appendix 2.  ``ALARM_CODES_STORAGE`` is
# the table used for a micro storage unit, ``ALARM_CODES_INVERTER``
# for a micro inverter (``HiFlow``).  A handful of numbers mean
# different things in the two tables (141-149, 215-219, ...), which is
# why they are kept apart instead of merged: showing the inverter
# wording on a storage unit would name the wrong fault.
ALARM_CODES_STORAGE: Final = {
    62: "System Configuration Parameter Error",
    63: "TW Function Enabled",
    74: "High Temperature Alarm",
    101: "Grid Configuration Parameter Error",
    102: "Firmware Error",
    103: "Hardware Configuration Information Error",
    104: "Abnormal Insulation Impedance",
    105: "Over Temperature Protection",
    106: "PV Input Parallel Abnormality",
    113: "Remote Shutdown",
    114: "Under Temperature Lock",
    116: "Low Power",
    118: "PV1 Over Temperature Protection",
    119: "PV2 Over Temperature Protection",
    120: "PV3 Over Temperature Protection",
    121: "PV4 Over Temperature Protection",
    141: "Grid Over Voltage",
    142: "Grid Overvoltage Ten Minute Mean Value",
    143: "Grid Under Voltage",
    144: "Grid Over Frequency",
    145: "Grid Under Frequency",
    146: "Excessive Grid Frequency Change Rate",
    147: "No Voltage on Grid Port",
    148: "Grid Disconnection",
    149: "Island Detected",
    161: "Over Load",
    162: "Over Load Locked",
    163: "Long-Term Over Voltage",
    164: "Under Voltage",
    165: "Off-Grid Port Over Current",
    167: "Off-Grid Port Device Mismatch",
    168: "Off-Grid Short Time Voltage Abnormal",
    169: "Off-Grid CYC Fault Lock",
    170: "Off-Grid Charge/Discharge Cut Off",
    171: "Off-Grid Short Circuit Lock",
    204: "Battery Over Voltage Protect",
    205: "Battery Under Voltage Protect",
    206: "High Temperature Protect",
    207: "Low Temperature Charge Protect",
    208: "Low Temperature Discharge Protect",
    215: "PV1 Abnormal Wiring",
    216: "PV2 Abnormal Wiring",
    217: "PV1 Input Over Voltage",
    219: "PV2 Input Over Voltage",
    231: "PV3 Abnormal Wiring",
    232: "PV4 Abnormal Wiring",
    233: "PV3 Input Over Voltage",
    235: "PV4 Input Over Voltage",
    239: "PV1 Port Reverse Connection",
    240: "PV2 Port Reverse Connection",
    241: "PV3 Port Reverse Connection",
    242: "PV4 Port Reverse Connection",
    243: "PV1 Arc Protect",
    244: "PV2 Arc Protect",
    245: "PV3 Arc Protect",
    246: "PV4 Arc Protect",
    311: "BMS Lockup",
    312: "Severe Battery Undervoltage",
    314: "Off-Grid Charge Battery Over Ability Failure",
    410: "MS Elec Abnormal",
    411: "MS Network Abnormal",
    412: "MS Comm Abnormal",
    413: "Software Version Mismatch",
    414: "Sys Config Abnormal",
    415: "Sys File Abnormal",
    416: "Sys Phase Abnormal",
    417: "Sys Meter Miss Abnormal",
    1055: "PCS Fan Abnormal",
    1056: "Battery Fan Abnormal",
    1202: "Software Version Mismatch",
    1501: "MS Elec Abnormal",
    1502: "MS Network Abnormal",
    1503: "MS Comm Abnormal",
    1505: "Sys Config Abnormal",
    1506: "Sys File Abnormal",
    1507: "Sys Phase Abnormal",
    2111: "Sys Meter Miss Abnormal",
    2113: "Found the 485 Electricity Meter",
}

ALARM_CODES_INVERTER: Final = {
    121: "Over Temperature Protection",
    123: "Standby Mode Enabled by Remote Control",
    125: "Grid Configuration Parameter Error",
    127: "Firmware Error",
    128: "Hardware Configuration Information Error",
    130: "Offline",
    141: "Grid Overvoltage",
    142: "Grid Overvoltage (10 Min Mean Value)",
    143: "Grid Undervoltage",
    144: "Grid Overfrequency",
    145: "Grid Underfrequency",
    146: "High RoCoF",
    147: "No Voltage on Grid Port",
    148: "Grid Disconnection",
    149: "Island Detected",
    151: "Severe Grid Wave Distortion",
    181: "Abnormal Insulation Impedance",
    183: "Abnormal Relay",
    184: "Abnormal Input Paralleling Wiring",
    205: "MPPT-A Input Overvoltage",
    206: "MPPT-B Input Overvoltage",
    207: "MPPT-A Input Undervoltage",
    208: "MPPT-B Input Undervoltage",
    209: "PV1 No Input",
    210: "PV2 No Input",
    211: "PV3 No Input",
    212: "PV4 No Input",
    213: "PV1 & PV2 Abnormal Wiring",
    214: "PV3 & PV4 Abnormal Wiring",
    215: "PV1 Input Overvoltage",
    216: "PV1 Input Undervoltage",
    217: "PV2 Input Overvoltage",
    218: "PV2 Input Undervoltage",
    219: "PV3 Input Overvoltage",
    220: "PV3 Input Undervoltage",
    221: "PV4 Input Overvoltage",
    222: "PV4 Input Undervoltage",
    229: "Relay Inner Side Overvoltage",
    231: "PV1 Arcing Fault",
    232: "PV2 Arcing Fault",
    233: "PV3 Arcing Fault",
    234: "PV4 Arcing Fault",
    241: "PV Input Wiring Abnormality: PV1 Reverse Connection",
    242: "PV Input Wiring Abnormality: PV2 Reverse Connection",
    243: "PV Input Wiring Abnormality: Cross Connection Case 1",
    244: "PV Input Wiring Abnormality: Cross Connection Case 2",
    301: "Hardware Error Code 301",
    302: "Hardware Error Code 302",
    303: "Hardware Error Code 303",
    304: "Hardware Error Code 304",
    305: "Hardware Error Code 305",
    306: "Hardware Error Code 306",
    307: "Hardware Error Code 307",
    308: "Hardware Error Code 308",
    309: "Hardware Error Code 309",
    310: "Hardware Error Code 310",
    311: "Hardware Error Code 311",
    312: "Hardware Error Code 312",
    313: "Hardware Error Code 313",
    314: "Hardware Error Code 314",
    316: "BOOSTA Internal Short Circuit Failure",
    317: "BOOSTB Internal Short Circuit Failure",
    318: "BOOSTA Overcurrent Protection Failure",
    319: "BOOSTB Overcurrent Protection Failure",
    320: "BOOSTC Internal Short Circuit Failure",
    321: "BOOSTD Internal Short Circuit Failure",
    322: "BOOSTC Overcurrent Protection Failure",
    323: "BOOSTD Overcurrent Protection Failure",
    324: "Arcing Lock-Up",
    413: "Software Version Mismatch",
    414: "Abnormal Master-Slave System Configuration",
    415: "Sys File Abnormal",
}

# Ranges the document describes as a family rather than one code.
ALARM_CODE_RANGES: Final = (
    (400, 409, "Smart Device Offline"),
    (420, 429, "Sys Comm Abnormal"),
    (1055, 1056, "Fan Abnormal"),
    (1511, 1520, "Sys Comm Abnormal"),
    (2101, 2110, "Smart Device Offline"),
)

# <<< ALARM CODE TABLES <<<

# ---------------------------------------------------------------------------
# Alarm names in Chinese
#
# NOT generated: the protocol appendix these codes come from is English-only, so
# these are written by hand. Keys mirror the two tables above exactly; a code
# missing here simply keeps its English name on the card, which is why a partial
# table is safe rather than fatal.
#
# Kept in const.py beside the English table so the two cannot drift apart
# unnoticed, and emitted to the frontend as a second field (`name_zh`) instead of
# pulling 160 strings into the card's JS.
# ---------------------------------------------------------------------------
ALARM_CODES_STORAGE_ZH: Final = {
    62: "系统配置参数错误",
    63: "TW 功能已开启",
    74: "高温告警",
    101: "电网配置参数错误",
    102: "固件错误",
    103: "硬件配置信息错误",
    104: "绝缘阻抗异常",
    105: "过温保护",
    106: "PV 输入并联异常",
    113: "远程关机",
    114: "低温锁定",
    116: "低电量",
    118: "PV1 过温保护",
    119: "PV2 过温保护",
    120: "PV3 过温保护",
    121: "PV4 过温保护",
    141: "电网过压",
    142: "电网过压（10 分钟平均值）",
    143: "电网欠压",
    144: "电网过频",
    145: "电网欠频",
    146: "电网频率变化率过大",
    147: "电网端口无电压",
    148: "电网断开",
    149: "检测到孤岛",
    161: "过载",
    162: "过载锁定",
    163: "长时间过压",
    164: "欠压",
    165: "离网端口过流",
    167: "离网端口设备不匹配",
    168: "离网短时电压异常",
    169: "离网 CYC 故障锁定",
    170: "离网充放电切断",
    171: "离网短路锁定",
    204: "电池过压保护",
    205: "电池欠压保护",
    206: "高温保护",
    207: "低温充电保护",
    208: "低温放电保护",
    215: "PV1 接线异常",
    216: "PV2 接线异常",
    217: "PV1 输入过压",
    219: "PV2 输入过压",
    231: "PV3 接线异常",
    232: "PV4 接线异常",
    233: "PV3 输入过压",
    235: "PV4 输入过压",
    239: "PV1 端口反接",
    240: "PV2 端口反接",
    241: "PV3 端口反接",
    242: "PV4 端口反接",
    243: "PV1 电弧保护",
    244: "PV2 电弧保护",
    245: "PV3 电弧保护",
    246: "PV4 电弧保护",
    311: "BMS 锁死",
    312: "电池严重欠压",
    314: "离网充电超出电池能力故障",
    410: "主从机电力异常",
    411: "主从机网络异常",
    412: "主从机通信异常",
    413: "软件版本不匹配",
    414: "系统配置异常",
    415: "系统文件异常",
    416: "系统相位异常",
    417: "系统电表缺失异常",
    1055: "PCS 风扇异常",
    1056: "电池风扇异常",
    1202: "软件版本不匹配",
    1501: "主从机电力异常",
    1502: "主从机网络异常",
    1503: "主从机通信异常",
    1505: "系统配置异常",
    1506: "系统文件异常",
    1507: "系统相位异常",
    2111: "系统电表缺失异常",
    2113: "发现 485 电表",
}

ALARM_CODES_INVERTER_ZH: Final = {
    121: "过温保护",
    123: "远程控制进入待机模式",
    125: "电网配置参数错误",
    127: "固件错误",
    128: "硬件配置信息错误",
    130: "离线",
    141: "电网过压",
    142: "电网过压（10 分钟平均值）",
    143: "电网欠压",
    144: "电网过频",
    145: "电网欠频",
    146: "频率变化率过高",
    147: "电网端口无电压",
    148: "电网断开",
    149: "检测到孤岛",
    151: "电网波形严重畸变",
    181: "绝缘阻抗异常",
    183: "继电器异常",
    184: "输入并联接线异常",
    205: "MPPT-A 输入过压",
    206: "MPPT-B 输入过压",
    207: "MPPT-A 输入欠压",
    208: "MPPT-B 输入欠压",
    209: "PV1 无输入",
    210: "PV2 无输入",
    211: "PV3 无输入",
    212: "PV4 无输入",
    213: "PV1 与 PV2 接线异常",
    214: "PV3 与 PV4 接线异常",
    215: "PV1 输入过压",
    216: "PV1 输入欠压",
    217: "PV2 输入过压",
    218: "PV2 输入欠压",
    219: "PV3 输入过压",
    220: "PV3 输入欠压",
    221: "PV4 输入过压",
    222: "PV4 输入欠压",
    229: "继电器内侧过压",
    231: "PV1 电弧故障",
    232: "PV2 电弧故障",
    233: "PV3 电弧故障",
    234: "PV4 电弧故障",
    241: "PV 输入接线异常：PV1 反接",
    242: "PV 输入接线异常：PV2 反接",
    243: "PV 输入接线异常：交叉接线情况 1",
    244: "PV 输入接线异常：交叉接线情况 2",
    301: "硬件错误码 301",
    302: "硬件错误码 302",
    303: "硬件错误码 303",
    304: "硬件错误码 304",
    305: "硬件错误码 305",
    306: "硬件错误码 306",
    307: "硬件错误码 307",
    308: "硬件错误码 308",
    309: "硬件错误码 309",
    310: "硬件错误码 310",
    311: "硬件错误码 311",
    312: "硬件错误码 312",
    313: "硬件错误码 313",
    314: "硬件错误码 314",
    316: "BOOSTA 内部短路故障",
    317: "BOOSTB 内部短路故障",
    318: "BOOSTA 过流保护故障",
    319: "BOOSTB 过流保护故障",
    320: "BOOSTC 内部短路故障",
    321: "BOOSTD 内部短路故障",
    322: "BOOSTC 过流保护故障",
    323: "BOOSTD 过流保护故障",
    324: "电弧锁定",
    413: "软件版本不匹配",
    414: "主从系统配置异常",
    415: "系统文件异常",
}

# Same ranges, same order as ``ALARM_CODE_RANGES`` above.
ALARM_CODE_RANGES_ZH: Final = (
    (400, 409, "智能设备离线"),
    (420, 429, "系统通信异常"),
    (1055, 1056, "风扇异常"),
    (1511, 1520, "系统通信异常"),
    (2101, 2110, "智能设备离线"),
)

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
ALARM_CARD_FILENAME: Final = "hoymiles-alarms.js"
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
    ALARM_CARD_FILENAME,
    LANG_SWITCH_FILENAME,
)

# Raster artwork bundled in ``www/``.  These are served under ``FRONTEND_URL``
# like the cards, but they must never be appended with ``add_extra_js_url`` -
# Home Assistant would try to load a PNG as a JavaScript module.
CHASSIS_IMAGE_FILENAME: Final = "hibattery-1920ac.png"
# The MS-A2 is a portrait cabinet shot at a slight angle, so it is a separate
# image rather than a redraw of the 1920 AC artwork.
MSA2_IMAGE_FILENAME: Final = "hibattery-msa2.png"
FRONTEND_IMAGES: Final = (CHASSIS_IMAGE_FILENAME, MSA2_IMAGE_FILENAME)

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
