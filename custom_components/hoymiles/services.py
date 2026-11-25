"""Service handlers for the Hoymiles Micro Storage integration.

Services publish to the raw MQTT topics defined by《禾迈微储MQTT协议开发指南》.
They are the building block used by the bundled Lovelace card and can also be
called directly from automations / scripts.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.const import ATTR_DEVICE_ID
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr

from . import mqtt_util
from .const import (
    DOMAIN,
    FINE_GRID_MAX,
    FINE_GRID_MIN,
    METER_CTRL_MAX,
    METER_CTRL_MIN,
    METER_ENERGY_MAX,
    METER_ENERGY_MIN,
    METER_FIELDS,
    PHASE_A,
    PHASE_B,
    PHASE_C,
    PHASE_POWER_MAX,
    PHASE_POWER_MIN,
    POWER_CTRL_MAX,
    POWER_CTRL_MIN,
    POWER_CTRL_REPEAT_DEFAULT_S,
    POWER_CTRL_REPEAT_MAX_S,
    POWER_CTRL_REPEAT_MIN_S,
    PV_POWER_MAX,
    PV_POWER_MIN,
    ROLE_MASTER_SINGLE,
    ROLE_MULTIPHASE_MASTER,
    T_EMS_MODE_CMD,
    T_FINE_CTRL_SET,
    T_METER_CTRL_SET,
    T_PHASE_OUTPUT_POWER_SET,
    T_REBOOT,
    T_TOU_DAY_SET,
    T_TOU_GET,
    T_TOU_WEEK_SET,
    TOU_DAY_IDX_MAX,
    TOU_MODES,
    TOU_PLAN_MAX,
    TOU_POWER_MIN,
    TOU_SOC_MAX,
    TOU_SOC_MIN,
    TOU_TS_MAX,
    TOU_WEEKDAYS,
)
from .dashboard import RESULT_UNAVAILABLE, async_create_device_dashboard
from .power_repeat import get_manager as get_repeat_manager
from .power_repeat import get_topic_manager as get_topic_repeat_manager

_LOGGER = logging.getLogger(__name__)

ATTR_DEV_ID = "dev_id"

SERVICE_SET_TOU_DAY_PLAN = "set_tou_day_plan"
SERVICE_SET_TOU_WEEK_PLAN = "set_tou_week_plan"
SERVICE_GET_TOU_PLAN = "get_tou_plan"
SERVICE_SET_EMS_MODE = "set_ems_mode"
SERVICE_SET_PHASE_OUTPUT_POWER = "set_phase_output_power"
SERVICE_REBOOT = "reboot"
SERVICE_CREATE_DASHBOARD = "create_dashboard"
SERVICE_SET_POWER_CTRL = "set_power_ctrl"
SERVICE_STOP_POWER_CTRL = "stop_power_ctrl"
SERVICE_GET_POWER_CTRL = "get_power_ctrl"
SERVICE_SET_METER_CTRL = "set_meter_ctrl"
SERVICE_STOP_METER_CTRL = "stop_meter_ctrl"
SERVICE_GET_METER_CTRL = "get_meter_ctrl"
SERVICE_SET_FINE_CTRL = "set_fine_ctrl"
SERVICE_STOP_FINE_CTRL = "stop_fine_ctrl"
SERVICE_GET_FINE_CTRL = "get_fine_ctrl"

DAY_PLAN_ITEM = vol.Schema(
    {
        vol.Required("mode"): vol.In(TOU_MODES),
        vol.Required("ts"): vol.All(vol.Coerce(int), vol.Range(min=0, max=TOU_TS_MAX)),
        vol.Required("te"): vol.All(vol.Coerce(int), vol.Range(min=0, max=TOU_TS_MAX)),
        vol.Optional("sh", default=55): vol.All(
            vol.Coerce(int), vol.Range(min=TOU_SOC_MIN, max=TOU_SOC_MAX)
        ),
        vol.Optional("sl", default=10): vol.All(
            vol.Coerce(int), vol.Range(min=TOU_SOC_MIN, max=TOU_SOC_MAX)
        ),
        vol.Optional("pc", default=1000): vol.All(
            vol.Coerce(int), vol.Range(min=TOU_POWER_MIN)
        ),
        vol.Optional("pd", default=1000): vol.All(
            vol.Coerce(int), vol.Range(min=TOU_POWER_MIN)
        ),
    }
)

WEEK_PLAN_ITEM = vol.Schema(
    {
        vol.Required("week"): vol.All(cv.ensure_list, [vol.In(TOU_WEEKDAYS)]),
        vol.Required("day_idx"): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=TOU_DAY_IDX_MAX)
        ),
    }
)

DEVICE_FIELDS: dict[Any, Any] = {
    vol.Optional(ATTR_DEV_ID): cv.string,
    vol.Optional(ATTR_DEVICE_ID): cv.string,
}

SCHEMA_SET_TOU_DAY_PLAN = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("day_idx"): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=TOU_DAY_IDX_MAX)
        ),
        vol.Required("day_plan"): vol.All(
            cv.ensure_list, vol.Length(min=1, max=TOU_PLAN_MAX), [DAY_PLAN_ITEM]
        ),
    }
)

SCHEMA_SET_TOU_WEEK_PLAN = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("week_plan"): vol.All(
            cv.ensure_list, vol.Length(min=1, max=7), [WEEK_PLAN_ITEM]
        ),
    }
)

SCHEMA_GET_TOU_PLAN = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("week"): vol.In(TOU_WEEKDAYS),
    }
)

SCHEMA_SET_EMS_MODE = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("mode"): vol.In(["general", "mqtt_ctrl", "tou_plan"]),
    }
)

SCHEMA_REBOOT = vol.Schema({**DEVICE_FIELDS})

# ``overwrite`` rebuilds the bundled layout over an existing dashboard; without
# it an existing dashboard (and every edit made to it) is left untouched.
SCHEMA_CREATE_DASHBOARD = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Optional("overwrite", default=False): cv.boolean,
    }
)

_PHASE_POWER = vol.All(
    vol.Coerce(int), vol.Range(min=PHASE_POWER_MIN, max=PHASE_POWER_MAX)
)

# The setpoint is a lease the firmware renews only while it keeps arriving, so
# the service always carries the repeat interval - there is no "send once"
# flavour of it here.  A raw one-off publish is still what `mqtt.publish` is.
SCHEMA_SET_POWER_CTRL = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required("value"): vol.All(
            vol.Coerce(int), vol.Range(min=POWER_CTRL_MIN, max=POWER_CTRL_MAX)
        ),
        vol.Optional(
            "interval", default=POWER_CTRL_REPEAT_DEFAULT_S
        ): vol.All(
            vol.Coerce(int),
            vol.Range(min=POWER_CTRL_REPEAT_MIN_S, max=POWER_CTRL_REPEAT_MAX_S),
        ),
    }
)

SCHEMA_POWER_CTRL_ONLY = vol.Schema({**DEVICE_FIELDS})

# --- the two other leases (see power_repeat.TopicRepeatManager) --------------
# ``meter_ctrl`` is an **object** since V0.6.5 §12: ``power`` plus the two
# cumulative readings of the simulated meter.  Every field is optional and a
# field that is left out keeps the value the device already holds, so the card
# can move one row without wiping the others.  ``value`` stays as an alias of
# ``power`` because every existing automation and the card itself use it.
SCHEMA_SET_METER_CTRL = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Optional("value"): vol.All(
            vol.Coerce(float), vol.Range(min=METER_CTRL_MIN, max=METER_CTRL_MAX)
        ),
        vol.Optional("power"): vol.All(
            vol.Coerce(float), vol.Range(min=METER_CTRL_MIN, max=METER_CTRL_MAX)
        ),
        vol.Optional("eng_out"): vol.All(
            vol.Coerce(int), vol.Range(min=METER_ENERGY_MIN, max=METER_ENERGY_MAX)
        ),
        vol.Optional("eng_in"): vol.All(
            vol.Coerce(int), vol.Range(min=METER_ENERGY_MIN, max=METER_ENERGY_MAX)
        ),
        vol.Optional("interval", default=POWER_CTRL_REPEAT_DEFAULT_S): vol.All(
            vol.Coerce(int),
            vol.Range(min=POWER_CTRL_REPEAT_MIN_S, max=POWER_CTRL_REPEAT_MAX_S),
        ),
    }
)

# `fine_ctrl` is an object whose fields are written by different rows, so the
# service takes any subset of them and the manager merges it into the object it
# keeps re-publishing.  Every field is optional - §42 allows a partial write -
# but a call that carries none of them is rejected below, because an empty
# object would only re-arm the repeat with nothing to say.
#
# Two spellings per field on purpose.  The wire keys are the firmware's own
# (`grid_p`, `pv_power`, `chg_off`, `dchg_off` - §41 `controls.*`), and the card
# and automations that already publish MQTT by hand use them; the long names are
# the ones the entity ids and the labels use, and they are what someone writing
# a service call from the UI thinks of first.  Both land on the same key, so a
# repeat cannot end up carrying `grid_p` *and* `grid_power_setpoint`.
FINE_CTRL_ALIASES: dict[str, str] = {
    "grid_p": "grid_p",
    "grid_power_setpoint": "grid_p",
    "pv_power": "pv_power",
    "pv_power_limit": "pv_power",
    "chg_off": "chg_off",
    "charge_forbid": "chg_off",
    "dchg_off": "dchg_off",
    "discharge_forbid": "dchg_off",
    "eps_relay": "eps_relay",
}
FINE_CTRL_FIELDS = ("grid_p", "pv_power", "chg_off", "dchg_off", "eps_relay")

SCHEMA_SET_FINE_CTRL = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Optional("grid_p"): vol.All(
            vol.Coerce(float), vol.Range(min=FINE_GRID_MIN, max=FINE_GRID_MAX)
        ),
        vol.Optional("grid_power_setpoint"): vol.All(
            vol.Coerce(float), vol.Range(min=FINE_GRID_MIN, max=FINE_GRID_MAX)
        ),
        vol.Optional("pv_power"): vol.All(
            vol.Coerce(int), vol.Range(min=PV_POWER_MIN, max=PV_POWER_MAX)
        ),
        vol.Optional("pv_power_limit"): vol.All(
            vol.Coerce(int), vol.Range(min=PV_POWER_MIN, max=PV_POWER_MAX)
        ),
        vol.Optional("chg_off"): cv.boolean,
        vol.Optional("charge_forbid"): cv.boolean,
        vol.Optional("dchg_off"): cv.boolean,
        vol.Optional("discharge_forbid"): cv.boolean,
        # The protocol spells the relay position `close` / `open`; a boolean is
        # what an automation wants to write, so both are accepted.
        vol.Optional("eps_relay"): vol.Any(cv.boolean, vol.In(["close", "open"])),
        vol.Optional("interval", default=POWER_CTRL_REPEAT_DEFAULT_S): vol.All(
            vol.Coerce(int),
            vol.Range(min=POWER_CTRL_REPEAT_MIN_S, max=POWER_CTRL_REPEAT_MAX_S),
        ),
    }
)

# The firmware only accepts a complete {"phase_a":..,"phase_b":..,"phase_c":..}
# object (protocol §15), so all three phases are mandatory here.
SCHEMA_SET_PHASE_OUTPUT_POWER = vol.Schema(
    {
        **DEVICE_FIELDS,
        vol.Required(PHASE_A): _PHASE_POWER,
        vol.Required(PHASE_B): _PHASE_POWER,
        vol.Required(PHASE_C): _PHASE_POWER,
    }
)


def _find_coordinator(hass: HomeAssistant, dev_id: str) -> Any | None:
    """Return the loaded coordinator for a device id, if there is one."""
    for entry_data in hass.data.get(DOMAIN, {}).values():
        if isinstance(entry_data, dict) and entry_data.get("dev_id") == dev_id:
            return entry_data.get("coordinator")
    return None


def _resolve_dev_id(hass: HomeAssistant, data: dict[str, Any]) -> str:
    """Resolve a device id from ``dev_id`` or a HA device registry id."""
    dev_id = data.get(ATTR_DEV_ID)
    if dev_id:
        return str(dev_id)

    device_id = data.get(ATTR_DEVICE_ID)
    if not device_id:
        raise vol.Invalid(f"Either '{ATTR_DEV_ID}' or '{ATTR_DEVICE_ID}' is required")

    registry = dr.async_get(hass)
    device = registry.async_get(device_id)
    if device is None:
        raise vol.Invalid(f"Unknown device_id: {device_id}")

    domain_data = hass.data.get(DOMAIN, {})
    for entry_id in device.config_entries:
        entry_data = domain_data.get(entry_id)
        if isinstance(entry_data, dict) and entry_data.get("dev_id"):
            return entry_data["dev_id"]

    raise vol.Invalid(f"device_id {device_id} does not belong to a Hoymiles entry")


def _require_role(hass: HomeAssistant, dev_id: str, scope: str, what: str) -> None:
    """Refuse a service call a slave (or a single phase unit) may not make.

    Every V0.6.5 topic names the roles it is defined for.  The entities and the
    cards are already hidden/disabled for the wrong role, but a service can be
    called from an automation or the developer tools - where there is no UI to
    hide.  The check lives here as well so those paths fail loudly instead of
    publishing a topic the unit does not own.

    A device whose coordinator is not loaded (entry removed, or a ``dev_id``
    typed by hand) has no role to check, so the publish is left to the caller.
    """
    coordinator = _find_coordinator(hass, dev_id)
    if coordinator is None:
        return
    coordinator.require_role(scope, what)


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register the integration services once."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_services_registered"):
        return
    domain_data["_services_registered"] = True

    async def _handle_set_tou_day_plan(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_role(hass, dev_id, ROLE_MASTER_SINGLE, "TOU 日计划")
        payload = {
            "day_idx": int(call.data["day_idx"]),
            "day_plan": [
                {
                    "mode": int(item["mode"]),
                    "ts": int(item["ts"]),
                    "te": int(item["te"]),
                    "sh": int(item["sh"]),
                    "sl": int(item["sl"]),
                    "pc": int(item["pc"]),
                    "pd": int(item["pd"]),
                }
                for item in call.data["day_plan"]
            ],
        }
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_TOU_DAY_SET, dev_id), payload
        )

    async def _handle_set_tou_week_plan(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_role(hass, dev_id, ROLE_MASTER_SINGLE, "TOU 周计划")
        payload = {
            "week_plan": [
                {
                    "week": list(item["week"]),
                    "day_idx": int(item["day_idx"]),
                }
                for item in call.data["week_plan"]
            ]
        }
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_TOU_WEEK_SET, dev_id), payload
        )

    async def _handle_get_tou_plan(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_TOU_GET, dev_id), {"week": call.data["week"]}
        )

    async def _handle_set_ems_mode(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        mode = str(call.data["mode"])
        # §7/§8 with the role subset: a **slave** may only run `general` /
        # `fine_ctrl`, so the other three are refused here instead of publishing
        # a mode the unit will never enter.  This replaces the plain "master or
        # stand-alone" gate: the picker itself stays available to a slave.
        coordinator = _find_coordinator(hass, dev_id)
        if coordinator is not None:
            coordinator.require_ems_mode(mode)
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_EMS_MODE_CMD, dev_id), mode
        )

    async def _handle_set_phase_output_power(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_role(hass, dev_id, ROLE_MULTIPHASE_MASTER, "分相输出功率上限")
        values = {
            PHASE_A: int(call.data[PHASE_A]),
            PHASE_B: int(call.data[PHASE_B]),
            PHASE_C: int(call.data[PHASE_C]),
        }

        coordinator = _find_coordinator(hass, dev_id)
        if coordinator is not None:
            await coordinator.async_set_phase_outputs(values)
            return

        # Entry not loaded (or a dev_id typed by hand): publish directly.
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_PHASE_OUTPUT_POWER_SET, dev_id), values
        )

    async def _handle_reboot(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await mqtt_util.async_publish(
            hass, mqtt_util.topic(T_REBOOT, dev_id), "RESTART"
        )

    async def _handle_create_dashboard(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        result = await async_create_device_dashboard(
            hass, dev_id, overwrite=bool(call.data.get("overwrite", False))
        )
        if result == RESULT_UNAVAILABLE:
            _LOGGER.warning("Could not create a dashboard for %s", dev_id)
        else:
            _LOGGER.info("Dashboard for %s: %s", dev_id, result)

    async def _handle_set_power_ctrl(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_role(hass, dev_id, ROLE_MASTER_SINGLE, "功率控制设定值")
        await get_repeat_manager(hass).async_start(
            dev_id, int(call.data["value"]), int(call.data["interval"])
        )

    async def _handle_stop_power_ctrl(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await get_repeat_manager(hass).async_stop(dev_id)

    async def _handle_get_power_ctrl(call: ServiceCall) -> dict[str, Any]:
        """Report the running job so a freshly opened card can restore itself."""
        dev_id = _resolve_dev_id(hass, dict(call.data))
        return get_repeat_manager(hass).snapshot(dev_id)

    async def _handle_set_meter_ctrl(call: ServiceCall) -> dict[str, Any]:
        """§11 / §12 virtual meter, refreshed like `power_ctrl`.

        The payload is an object and the device keeps whatever is not sent, so a
        call may carry one field.  Missing fields are filled in from the last
        known values (`coordinator.meter`) before the job is armed: the lease
        re-publishes the **complete** object, and a tick that silently dropped
        the energy readings would make the simulated meter jump back to zero.
        """
        dev_id = _resolve_dev_id(hass, dict(call.data))
        _require_role(hass, dev_id, ROLE_MASTER_SINGLE, "虚拟电表控制")
        data = dict(call.data)

        fields: dict[str, Any] = {}
        if data.get("value") is not None:
            fields["power"] = round(float(data["value"]), 1)
        if data.get("power") is not None:
            fields["power"] = round(float(data["power"]), 1)
        for key in ("eng_out", "eng_in"):
            if data.get(key) is not None:
                fields[key] = int(data[key])
        if not fields:
            raise HomeAssistantError(
                "set_meter_ctrl needs at least one of: value, power, eng_out, eng_in"
            )

        coordinator = _find_coordinator(hass, dev_id)
        if coordinator is not None:
            merged = {
                key: coordinator.meter[key]
                for key in METER_FIELDS
                if key in coordinator.meter
            }
            merged.update(fields)
            fields = merged
            coordinator.meter.update(fields)

        snapshot = await get_topic_repeat_manager(hass).async_set(
            dev_id,
            "meter_ctrl",
            mqtt_util.topic(T_METER_CTRL_SET, dev_id),
            fields,
            int(data["interval"]),
        )
        if coordinator is not None:
            # This path publishes the object itself (not through the coordinator),
            # so the card's write counter has to be told here - the broker echo it
            # causes is filtered out by `mqtt_util.is_own_publish`.
            coordinator.note_meter_write(fields, "entity")
        return snapshot
    async def _handle_stop_meter_ctrl(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await get_topic_repeat_manager(hass).async_stop(dev_id, "meter_ctrl")

    async def _handle_get_meter_ctrl(call: ServiceCall) -> dict[str, Any]:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        return get_topic_repeat_manager(hass).snapshot(dev_id, "meter_ctrl")

    async def _handle_set_fine_ctrl(call: ServiceCall) -> dict[str, Any]:
        """§42 fine control, merged and refreshed like `power_ctrl`.

        The fields a call carries are merged into the object the repeat already
        holds, so moving one row cannot wipe the others.  ``eps_relay`` is
        translated here: the protocol wants the strings ``close`` / ``open``
        while the card and automations speak booleans.
        """
        dev_id = _resolve_dev_id(hass, dict(call.data))
        fields: dict[str, Any] = {}
        for given, wire in FINE_CTRL_ALIASES.items():
            if given not in call.data:
                continue
            value = call.data[given]
            if wire == "eps_relay":
                fields[wire] = "close" if value in (True, "close") else "open"
            else:
                fields[wire] = value
        if not fields:
            raise vol.Invalid(
                "set_fine_ctrl needs at least one of: " + ", ".join(FINE_CTRL_FIELDS)
            )
        return await get_topic_repeat_manager(hass).async_set(
            dev_id,
            "fine_ctrl",
            mqtt_util.topic(T_FINE_CTRL_SET, dev_id),
            fields,
            int(call.data["interval"]),
        )

    async def _handle_stop_fine_ctrl(call: ServiceCall) -> None:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        await get_topic_repeat_manager(hass).async_stop(dev_id, "fine_ctrl")

    async def _handle_get_fine_ctrl(call: ServiceCall) -> dict[str, Any]:
        dev_id = _resolve_dev_id(hass, dict(call.data))
        return get_topic_repeat_manager(hass).snapshot(dev_id, "fine_ctrl")

    hass.services.async_register(
        DOMAIN, SERVICE_SET_TOU_DAY_PLAN, _handle_set_tou_day_plan, SCHEMA_SET_TOU_DAY_PLAN
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_TOU_WEEK_PLAN, _handle_set_tou_week_plan, SCHEMA_SET_TOU_WEEK_PLAN
    )
    hass.services.async_register(
        DOMAIN, SERVICE_GET_TOU_PLAN, _handle_get_tou_plan, SCHEMA_GET_TOU_PLAN
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_EMS_MODE, _handle_set_ems_mode, SCHEMA_SET_EMS_MODE
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_PHASE_OUTPUT_POWER,
        _handle_set_phase_output_power,
        SCHEMA_SET_PHASE_OUTPUT_POWER,
    )
    hass.services.async_register(DOMAIN, SERVICE_REBOOT, _handle_reboot, SCHEMA_REBOOT)
    hass.services.async_register(
        DOMAIN,
        SERVICE_CREATE_DASHBOARD,
        _handle_create_dashboard,
        SCHEMA_CREATE_DASHBOARD,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_POWER_CTRL,
        _handle_set_power_ctrl,
        SCHEMA_SET_POWER_CTRL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_STOP_POWER_CTRL,
        _handle_stop_power_ctrl,
        SCHEMA_POWER_CTRL_ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_POWER_CTRL,
        _handle_get_power_ctrl,
        SCHEMA_POWER_CTRL_ONLY,
        supports_response=SupportsResponse.ONLY,
    )
    # ---- the other two lease-style setpoints (meter_ctrl, fine_ctrl) --------
    hass.services.async_register(
        DOMAIN, SERVICE_SET_METER_CTRL, _handle_set_meter_ctrl, SCHEMA_SET_METER_CTRL,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_STOP_METER_CTRL, _handle_stop_meter_ctrl, SCHEMA_POWER_CTRL_ONLY,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_GET_METER_CTRL, _handle_get_meter_ctrl, SCHEMA_POWER_CTRL_ONLY,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_SET_FINE_CTRL, _handle_set_fine_ctrl, SCHEMA_SET_FINE_CTRL,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_STOP_FINE_CTRL, _handle_stop_fine_ctrl, SCHEMA_POWER_CTRL_ONLY,
    )
    hass.services.async_register(
        DOMAIN, SERVICE_GET_FINE_CTRL, _handle_get_fine_ctrl, SCHEMA_POWER_CTRL_ONLY,
        supports_response=SupportsResponse.ONLY,
    )
