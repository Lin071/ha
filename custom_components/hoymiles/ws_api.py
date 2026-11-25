"""WebSocket commands served by the Hoymiles integration.

One command so far: ``hoymiles/sankey/history``, which returns the archived
per-day energy-flow snapshots for one device.

Why a WebSocket command and not a sensor attribute: the archive is up to a month
of payloads, and an attribute would put all of them into the state machine and
into every recorder row. The card only needs them when a user opens a past day,
so they are fetched on demand instead.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .coordinator import HoymilesCoordinator

_LOGGER = logging.getLogger(__name__)

# Key in ``hass.data[DOMAIN]`` used to register the commands exactly once, even
# with several config entries loaded.
WS_REGISTERED: str = "_ws_registered"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the integration's WebSocket commands (idempotent)."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(WS_REGISTERED):
        return
    websocket_api.async_register_command(hass, ws_sankey_history)
    websocket_api.async_register_command(hass, ws_device_info)
    websocket_api.async_register_command(hass, ws_virtual_meter_info)
    websocket_api.async_register_command(hass, ws_virtual_meter_rotate)
    domain_data[WS_REGISTERED] = True


@callback
def _coordinator(hass: HomeAssistant, dev_id: str) -> HoymilesCoordinator | None:
    """Find the coordinator of one device.

    ``hass.data[DOMAIN]`` holds one dict per config entry plus a couple of
    registration flags, hence the type check on each value.
    """
    for value in hass.data.get(DOMAIN, {}).values():
        if not isinstance(value, dict):
            continue
        if value.get("dev_id") != dev_id:
            continue
        coordinator = value.get("coordinator")
        if isinstance(coordinator, HoymilesCoordinator):
            return coordinator
    return None


@websocket_api.websocket_command({
    vol.Required("type"): "hoymiles/sankey/history",
    vol.Required("dev_id"): str,
})
@callback
def ws_sankey_history(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return every archived day of energy-flow numbers for one device.

    The whole archive is returned in one message (~a few hundred bytes per day).
    Pagination would only add a state machine to the card for a list that is
    bounded by :data:`const.SANKEY_HISTORY_DAYS`.

    An unknown ``dev_id`` is a normal answer rather than an error: the card may
    be rendered on a dashboard for a device that was removed, and an empty list
    lets it fall back to "today only" instead of showing a failure.
    """
    msg_id = msg["id"]
    coordinator = _coordinator(hass, msg["dev_id"])
    if coordinator is None:
        connection.send_result(msg_id, {"dev_id": msg["dev_id"], "days": []})
        return
    connection.send_result(
        msg_id, {"dev_id": msg["dev_id"], "days": coordinator.sankey_days}
    )


@websocket_api.websocket_command({
    vol.Required("type"): "hoymiles/device/info",
    vol.Required("dev_id"): str,
})
@callback
def ws_device_info(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Which optional hardware this unit has, and whether it is answering.

    The cards need this **while the device is offline**, which is exactly when
    the entity attributes cannot carry it: Home Assistant replaces an
    unavailable entity's attributes with an empty dict, so `has_meter` /
    `has_pv2` / `has_plug` vanish and the power flow falls back to its "assume
    there is a meter" guess - a unit without one then grew a separate grid node
    and lost its smart plug, i.e. the picture changed the moment it went quiet.

    The coordinator keeps those flags (they describe the hardware, not a
    reading) and remembers them across restarts, so this command answers even
    for a device that has been switched off for days.
    """
    coordinator = _coordinator(hass, msg["dev_id"])
    if coordinator is None:
        connection.send_result(msg["id"], {
            "dev_id": msg["dev_id"],
            "known": False,
        })
        return
    connection.send_result(msg["id"], {
        "dev_id": msg["dev_id"],
        "known": True,
        "online": coordinator.available,
        "last_message": coordinator.last_message_ms,
        "role": coordinator.event_value("role"),
        "has_meter": coordinator.has_meter,
        "has_pv2": coordinator.has_pv2,
        "has_plug": coordinator.has_plug,
    })


@websocket_api.websocket_command({
    vol.Required("type"): "hoymiles/virtual_meter/info",
    vol.Required("dev_id"): str,
})
@websocket_api.async_response
async def ws_virtual_meter_info(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return the URL, the shared secret and a copy-ready curl line.

    The control card has no other way to learn the key: it is stored in
    ``.storage`` (``http_api.VirtualMeterKeys``) and deliberately not exposed as
    an entity, because an entity state would end up in the recorder and in every
    long-term statistic.  Only an authenticated WebSocket connection can read it.
    """
    from .http_api import async_key_info  # noqa: PLC0415

    connection.send_result(msg["id"], await async_key_info(hass, msg["dev_id"]))


@websocket_api.websocket_command({
    vol.Required("type"): "hoymiles/virtual_meter/rotate",
    vol.Required("dev_id"): str,
})
@websocket_api.async_response
async def ws_virtual_meter_rotate(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Issue a new key, for when the old one leaked."""
    from .http_api import async_rotate_key  # noqa: PLC0415

    connection.send_result(msg["id"], await async_rotate_key(hass, msg["dev_id"]))
