"""HTTP endpoint for the virtual meter (protocol §11 / §12 ``meter_ctrl``).

Why an HTTP endpoint at all
---------------------------
The bundled card can drive the virtual meter from the dashboard, but the point
of a virtual meter is that *something else* drives it - an energy manager, a
meter emulator, a small script on another machine.  Those cannot speak the
integration's WebSocket API, and most of them cannot publish MQTT either, so the
integration offers one plain HTTP call:

    POST /api/hoymiles/virtual_meter?key=<KEY>
    {"power": 1234.5}
    {"power": 1234.5, "eng_out": 12345, "eng_in": 54321}

Design decisions, all of them driven by "this is reachable from the internet"
-----------------------------------------------------------------------------
* **Its own shared secret, not a Home Assistant token.**  A long-lived access
  token is a full account credential; handing one to a rooftop controller so it
  can set one number is far too much authority.  Each device gets a random key
  (kept in ``.storage/hoymiles.virtual_meter``, so it survives a restart) that
  can do exactly one thing: write the virtual meter of that device.
* **`requires_auth = False`, because the key IS the authentication.**  The view
  compares it in constant time and answers ``401`` otherwise - including for a
  request that carries no key at all, so the endpoint cannot be used to discover
  whether a device exists.
* **Range-checked, never clamped silently.**  A value outside §11's band
  (-5000..5000 W, energy 0..4294967295 Wh) is refused with ``400`` and the
  accepted range in the message.  Clamping would let a controller believe it
  sent -8000 W while the device sat at -5000 W.
* **Partial writes.**  Every field is optional (at least one is required); the
  ones left out keep the value the device already holds, which is exactly what
  §12 allows.
* **The repeat runs server side.**  The device drops a setpoint it has not seen
  for a minute (§12), and an external sender may well be slower than that - or
  send once and expect it to stick.  Every accepted call therefore arms the same
  30 s re-publish job ``set_meter_ctrl`` uses, and a new value replaces the old
  one *and* is sent immediately.
"""

from __future__ import annotations

import hmac
import json
import logging
import secrets
from typing import Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from . import mqtt_util
from .const import (
    DOMAIN,
    METER_CTRL_MAX,
    METER_CTRL_MIN,
    METER_ENERGY_MAX,
    METER_ENERGY_MIN,
    METER_FIELDS,
    POWER_CTRL_REPEAT_DEFAULT_S,
    POWER_CTRL_REPEAT_MAX_S,
    POWER_CTRL_REPEAT_MIN_S,
    ROLE_MASTER_SINGLE,
    T_METER_CTRL_SET,
)
from .power_repeat import get_topic_manager

_LOGGER = logging.getLogger(__name__)

URL_PATH: str = "/api/hoymiles/virtual_meter"
STORAGE_KEY: str = f"{DOMAIN}.virtual_meter"
DATA_KEY: str = "_virtual_meter_keys"
STORE_VERSION: int = 1

KEY_HEADER: str = "X-Hoymiles-Key"
# Where a caller may put the value.  Several names because the callers are other
# people's scripts: `power` is ours, `value` matches the service, `meter`/`p` are
# what a meter emulator tends to send.
POWER_FIELDS = ("power", "value", "meter", "p")
# The two cumulative readings.  They are spelled exactly as §11 / §12 name them,
# because a controller that fills in a meter reading is reading our protocol.
ENERGY_FIELDS = ("eng_out", "eng_in")


def _find_coordinator(hass: HomeAssistant, dev_id: str) -> Any | None:
    """Return the loaded coordinator for a device id, if there is one."""
    for entry_data in hass.data.get(DOMAIN, {}).values():
        if isinstance(entry_data, dict) and entry_data.get("dev_id") == dev_id:
            return entry_data.get("coordinator")
    return None


def _json_response(payload: dict[str, Any], status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, dumps=lambda obj: json.dumps(obj, ensure_ascii=False))


class VirtualMeterKeys:
    """Per-device shared secrets for the HTTP endpoint."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store = Store(hass, STORE_VERSION, STORAGE_KEY)
        self._keys: dict[str, str] = {}
        self._loaded = False

    async def async_load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = await self._store.async_load()
        except Exception:  # noqa: BLE001 - an unreadable file must not break setup
            _LOGGER.warning("Unable to read the virtual meter keys", exc_info=True)
            data = None
        keys = (data or {}).get("keys")
        if isinstance(keys, dict):
            self._keys = {str(k): str(v) for k, v in keys.items() if v}

    async def async_key(self, dev_id: str) -> str:
        """The key of one device, generated on first use."""
        await self.async_load()
        key = self._keys.get(dev_id)
        if key:
            return key
        key = secrets.token_urlsafe(24)
        self._keys[dev_id] = key
        await self._store.async_save({"keys": self._keys})
        _LOGGER.info("Generated a virtual meter key for %s", dev_id)
        return key

    async def async_rotate(self, dev_id: str) -> str:
        """Replace the key, invalidating every caller that still uses the old one."""
        await self.async_load()
        key = secrets.token_urlsafe(24)
        self._keys[dev_id] = key
        await self._store.async_save({"keys": self._keys})
        return key

    async def async_device_for(self, key: str) -> str | None:
        """Reverse lookup, compared in constant time per candidate.

        ``hmac.compare_digest`` on every stored key rather than `dict.get`: a
        plain lookup leaks the key through timing, and this endpoint is meant to
        be reachable from outside the LAN.
        """
        await self.async_load()
        if not key:
            return None
        for dev_id, candidate in self._keys.items():
            if hmac.compare_digest(str(candidate), str(key)):
                return dev_id
        return None


def get_keys(hass: HomeAssistant) -> VirtualMeterKeys:
    """Return the key store for this Home Assistant instance."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    store = domain_data.get(DATA_KEY)
    if not isinstance(store, VirtualMeterKeys):
        store = VirtualMeterKeys(hass)
        domain_data[DATA_KEY] = store
    return store


class HoymilesVirtualMeterView(HomeAssistantView):
    """``POST /api/hoymiles/virtual_meter`` - write the virtual meter setpoint."""

    url = URL_PATH
    name = "api:hoymiles:virtual_meter"
    # The key below is the authentication; a Home Assistant token would grant
    # far more than this endpoint needs.
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _interval(request: web.Request, body: dict[str, Any]) -> int:
        raw = request.query.get("interval", body.get("interval", POWER_CTRL_REPEAT_DEFAULT_S))
        try:
            value = int(float(raw))
        except (TypeError, ValueError):
            return POWER_CTRL_REPEAT_DEFAULT_S
        return max(POWER_CTRL_REPEAT_MIN_S, min(value, POWER_CTRL_REPEAT_MAX_S))

    @staticmethod
    def _power(request: web.Request, body: dict[str, Any]) -> float | None:
        for name in POWER_FIELDS:
            if name in body:
                raw: Any = body[name]
            elif name in request.query:
                raw = request.query[name]
            else:
                continue
            try:
                return float(raw)
            except (TypeError, ValueError):
                return None
        return None

    @staticmethod
    def _help() -> dict[str, Any]:
        return {
            "ok": False,
            "usage": {
                "url": URL_PATH,
                "method": "POST",
                "headers": {KEY_HEADER: "<key from the control card>"},
                "body": {
                    "power": "watts, positive imports, negative exports",
                    "eng_out": "Wh, cumulative export reading of the meter",
                    "eng_in": "Wh, cumulative import reading of the meter",
                },
                "query_fallback": (
                    "?key=<key>&power=<w>&eng_out=<wh>&eng_in=<wh>&interval=<1..3600>"
                ),
                "range": {
                    "power": {"min": METER_CTRL_MIN, "max": METER_CTRL_MAX, "unit": "W"},
                    "eng_out": {
                        "min": METER_ENERGY_MIN, "max": METER_ENERGY_MAX, "unit": "Wh",
                    },
                    "eng_in": {
                        "min": METER_ENERGY_MIN, "max": METER_ENERGY_MAX, "unit": "Wh",
                    },
                },
                "interval_default_s": POWER_CTRL_REPEAT_DEFAULT_S,
                "note": (
                    "At least one field is required; the ones you leave out keep the "
                    "value the device already holds. The object is re-published every "
                    "`interval` seconds because the device drops a setpoint it has not "
                    "seen for a minute. `power` may also arrive as `value`, `meter` or `p`."
                ),
            },
        }

    @staticmethod
    def _energy(request: web.Request, body: dict[str, Any], name: str) -> float | None:
        """One cumulative reading, from the body or the query string."""
        if name in body:
            raw: Any = body[name]
        elif name in request.query:
            raw = request.query[name]
        else:
            return None
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None

    # ------------------------------------------------------------------- verbs

    async def get(self, request: web.Request) -> web.Response:
        """A GET without a value answers with the usage text, not an error.

        Worth it: the first thing anyone does with a new URL is open it in a
        browser, and a 405 there looks like the endpoint is broken.
        """
        key = request.headers.get(KEY_HEADER) or request.query.get("key", "")
        store = get_keys(self.hass)
        if not await store.async_device_for(key):
            return _json_response(
                {**self._help(), "error": "missing or invalid key"}, status=401
            )
        if self._power(request, {}) is None:
            return _json_response({**self._help(), "ok": True})
        return await self.post(request)

    async def post(self, request: web.Request) -> web.Response:
        store = get_keys(self.hass)
        key = request.headers.get(KEY_HEADER) or request.query.get("key", "")
        dev_id = await store.async_device_for(key)
        if not dev_id:
            return _json_response(
                {**self._help(), "error": "missing or invalid key"}, status=401
            )

        body: dict[str, Any] = {}
        raw_body = await request.text()
        if raw_body.strip():
            try:
                parsed = json.loads(raw_body)
            except json.JSONDecodeError:
                # A bare number in the body is what `curl --data 1200` sends, and
                # it is unambiguous - accept it instead of demanding JSON.
                try:
                    parsed = {"power": float(raw_body.strip())}
                except ValueError:
                    return _json_response(
                        {**self._help(), "error": "body must be JSON or a bare number"},
                        status=400,
                    )
            if isinstance(parsed, (int, float)):
                parsed = {"power": parsed}
            if not isinstance(parsed, dict):
                return _json_response(
                    {**self._help(), "error": "body must be a JSON object"}, status=400
                )
            body = parsed

        wanted = body.get("dev_id") or request.query.get("dev_id")
        if wanted and str(wanted) != dev_id:
            # The key already names a device; a different one in the body is a
            # misconfiguration worth reporting rather than silently ignoring.
            return _json_response(
                {
                    **self._help(),
                    "error": f"key belongs to {dev_id}, not {wanted}",
                },
                status=403,
            )

        # §11/§12 are 角色: 主机和单机.  A slave has no virtual meter topic at
        # all, so an external meter pointed at one must be told, not fed a 200
        # for a publish the device will drop.
        role_coordinator = _find_coordinator(self.hass, dev_id)
        if role_coordinator is not None and not role_coordinator.allows(
            ROLE_MASTER_SINGLE
        ):
            return _json_response(
                {
                    **self._help(),
                    "error": (
                        "meter_ctrl is only defined for a master or a stand-alone "
                        "unit (protocol 11/12); this device reports role "
                        f"'{role_coordinator.role or 'unknown'}'"
                    ),
                    "role": role_coordinator.role,
                },
                status=403,
            )

        fields: dict[str, Any] = {}
        power = self._power(request, body)
        if power is not None:
            watts = round(power, 1)
            if not METER_CTRL_MIN <= watts <= METER_CTRL_MAX:
                return _json_response(
                    {
                        **self._help(),
                        "error": (
                            f"power out of range: {watts} W is outside "
                            f"{METER_CTRL_MIN}..{METER_CTRL_MAX} W"
                        ),
                        "received": watts,
                    },
                    status=400,
                )
            fields["power"] = watts

        for name in ENERGY_FIELDS:
            raw = self._energy(request, body, name)
            if raw is None:
                continue
            reading = int(round(raw))
            if not METER_ENERGY_MIN <= reading <= METER_ENERGY_MAX:
                return _json_response(
                    {
                        **self._help(),
                        "error": (
                            f"{name} out of range: {reading} Wh is outside "
                            f"{METER_ENERGY_MIN}..{METER_ENERGY_MAX} Wh"
                        ),
                        "received": reading,
                    },
                    status=400,
                )
            fields[name] = reading

        if not fields:
            return _json_response(
                {**self._help(), "error": "missing 'power' (watts)"}, status=400
            )

        # Fill the gaps from the last known values: the repeat re-publishes the
        # *complete* object, and a tick that carried only ``power`` would make
        # the two energy readings fall back to whatever the device had.
        coordinator = _find_coordinator(self.hass, dev_id)
        if coordinator is not None:
            merged = {
                key: coordinator.meter[key]
                for key in METER_FIELDS
                if key in coordinator.meter
            }
            merged.update(fields)
            fields = merged
            coordinator.meter.update(fields)

        interval = self._interval(request, body)
        snapshot = await get_topic_manager(self.hass).async_set(
            dev_id,
            "meter_ctrl",
            mqtt_util.topic(T_METER_CTRL_SET, dev_id),
            fields,
            interval,
        )
        if coordinator is not None:
            # Only accepted writes are counted, and only here: the repeat job
            # re-publishes the object on its own, so counting topic traffic would
            # turn the card's counter into a clock.
            coordinator.note_meter_write(fields, "http")
        _LOGGER.debug(
            "Virtual meter for %s written by HTTP: %s (repeat %s s)",
            dev_id, fields, interval,
        )
        return _json_response(
            {
                "ok": True,
                "dev_id": dev_id,
                "power": fields.get("power"),
                "eng_out": fields.get("eng_out"),
                "eng_in": fields.get("eng_in"),
                "fields": fields,
                "interval_s": interval,
                "next_in_s": snapshot.get("next_in"),
                "source": "http",
                "received_at": dt_util.utcnow().isoformat(),
            }
        )


def external_url(hass: HomeAssistant) -> str:
    """The base URL an outside caller should use.

    ``external_url`` first: a controller on another network cannot reach the LAN
    address, and that is exactly the case the endpoint exists for.  Falls back to
    ``internal_url`` and then to whatever Home Assistant guesses, so a
    single-LAN setup still gets a usable string.
    """
    base = (
        hass.config.external_url
        or hass.config.internal_url
        or ""
    ).rstrip("/")
    if base:
        return base
    try:
        from homeassistant.helpers.network import get_url  # noqa: PLC0415

        return get_url(hass, allow_internal=True, prefer_external=True).rstrip("/")
    except Exception:  # noqa: BLE001 - the card copes with an empty base
        return ""


async def async_key_info(hass: HomeAssistant, dev_id: str) -> dict[str, Any]:
    """Everything the control card prints in its "external meter" help block."""
    key = await get_keys(hass).async_key(dev_id)
    base = external_url(hass)
    coordinator = _find_coordinator(hass, dev_id)
    # Live telemetry for the card: how many virtual-meter writes have been
    # accepted since the EMS mode last changed, and what the newest one carried.
    # A device without a live coordinator (still loading) answers with zeros
    # rather than failing the whole call.
    rx = (
        dict(coordinator.meter_rx)
        if coordinator is not None and getattr(coordinator, "meter_rx", None)
        else {"count": 0, "at": None, "source": None, "fields": {}}
    )
    return {
        "dev_id": dev_id,
        "key": key,
        "url": f"{base}{URL_PATH}" if base else URL_PATH,
        "path": URL_PATH,
        "header": KEY_HEADER,
        "range": {
            "power": {"min": METER_CTRL_MIN, "max": METER_CTRL_MAX, "unit": "W"},
            "eng_out": {"min": METER_ENERGY_MIN, "max": METER_ENERGY_MAX, "unit": "Wh"},
            "eng_in": {"min": METER_ENERGY_MIN, "max": METER_ENERGY_MAX, "unit": "Wh"},
        },
        # The example carries all three fields: since V0.6.5 the topic takes one
        # object (``power`` + the two cumulative readings), and a controller that
        # only copies the power line would leave the meter reporting a stale
        # energy total.  A subset is allowed, which the body text says.
        "example_curl": (
            f"curl -X POST '{base or ''}{URL_PATH}' "
            f"-H 'Content-Type: application/json' "
            f"-H '{KEY_HEADER}: {key}' "
            '-d \'{"power": -800, "eng_out": 12345, "eng_in": 54321}\''
        ),
        "interval_default_s": POWER_CTRL_REPEAT_DEFAULT_S,
        "rx": rx,
        # The card hides the whole external-meter block on a slave: the endpoint
        # answers 403 there (see ``post``), and offering a URL that cannot work
        # would only send a user chasing a 403.
        "role": coordinator.role if coordinator is not None else None,
        "allowed": (
            coordinator.allows(ROLE_MASTER_SINGLE)
            if coordinator is not None else True
        ),
    }


async def async_rotate_key(hass: HomeAssistant, dev_id: str) -> dict[str, Any]:
    """Issue a new key and return the refreshed info block."""
    await get_keys(hass).async_rotate(dev_id)
    return await async_key_info(hass, dev_id)


async def async_register(hass: HomeAssistant) -> None:
    """Register the view once, however many devices are loaded."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_virtual_meter_view"):
        return
    domain_data["_virtual_meter_view"] = True
    hass.http.register_view(HoymilesVirtualMeterView(hass))
    _LOGGER.debug("Registered %s", URL_PATH)


__all__ = [
    "HoymilesVirtualMeterView",
    "URL_PATH",
    "async_key_info",
    "async_register",
    "async_rotate_key",
    "external_url",
]
