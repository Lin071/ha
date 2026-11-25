"""The Hoymiles Micro Storage integration."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    CONF_CREATE_DASHBOARD,
    CONF_DEV_ID,
    DOMAIN,
    FRONTEND_ASSETS,
    FRONTEND_IMAGES,
    FRONTEND_URL,
    PLATFORMS,
)
from .coordinator import HoymilesCoordinator
from .dashboard import (
    RESULT_CREATED,
    RESULT_EXISTS,
    RESULT_UPDATED,
    async_create_device_dashboard,
    async_set_system_view,
    async_upgrade_dashboard_template,
)
from .discovery_override import FirmwareDiscoveryPatcher
from .power_repeat import get_manager as get_repeat_manager
from .power_repeat import get_topic_manager
from .http_api import async_register as async_register_http_api
from .services import async_setup_services
from .ws_api import async_register as async_register_ws_api

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Hoymiles Micro Storage from a config entry."""
    dev_id: str = entry.data[CONF_DEV_ID]

    coordinator = HoymilesCoordinator(hass, dev_id)
    await coordinator.async_setup()

    # Patch the firmware's retained discovery payloads so the entities it
    # registers itself comply with Home Assistant's per-domain schemas.  See
    # discovery_override.py for the list of patches; it is a no-op once the
    # firmware ships compliant payloads.
    patcher = FirmwareDiscoveryPatcher(hass, dev_id)
    await patcher.async_setup()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "coordinator": coordinator,
        "patcher": patcher,
        "dev_id": dev_id,
    }

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    await _async_register_frontend(hass)
    await async_setup_services(hass)
    # The sankey card asks for the archived past days over WebSocket rather than
    # from an entity attribute - see ws_api.py.
    async_register_ws_api(hass)
    # The virtual meter is written by an external controller over plain HTTP,
    # which cannot use either the WebSocket API or the MQTT broker - see
    # http_api.py.
    await async_register_http_api(hass)
    await _async_maybe_create_dashboard(hass, entry, dev_id)
    return True


async def _async_maybe_create_dashboard(
    hass: HomeAssistant, entry: ConfigEntry, dev_id: str
) -> None:
    """Install the device dashboard when the user asked for one.

    Runs after ``async_forward_entry_setups`` because the dashboard references
    entity ids, which only exist once the platforms have been set up.

    The dashboard is a **template**: a dashboard that still has the layout the
    bundled template draws is rebuilt when ``TEMPLATE_VERSION`` moves on, so a
    release that adds a card reaches devices that already have a dashboard.
    Only a dashboard carrying a view or a card type the template never generates
    (a hand-added card, an extra tab) is treated as the user's own and left
    alone - see ``dashboard.async_upgrade_dashboard_template``.

    Entries created before the config flow asked the question have no
    ``create_dashboard`` key at all.  They used to be skipped, which is why a
    device added months ago kept an old layout (or no dashboard) while a new one
    looked completely different.  A missing key therefore means "yes": the
    bundled dashboard is the integration's output for every device.
    """
    if not entry.data.get(CONF_CREATE_DASHBOARD, True):
        return
    try:
        result = await async_create_device_dashboard(hass, dev_id)
        if result == RESULT_EXISTS:
            upgraded = await async_upgrade_dashboard_template(hass, dev_id)
            if upgraded is not None:
                result = upgraded
    except Exception:  # noqa: BLE001 - a dashboard must never break the setup
        _LOGGER.warning(
            "Unable to create the dashboard for %s", dev_id, exc_info=True
        )
        return

    # The System view is only for a unit that measures the system itself; a
    # **slave** (§32 ``role``) has none of those readings, so the view is removed
    # and put back when the unit is promoted.  This call also strips the
    # always-false ``visible`` condition template v14/v15 left behind, which is
    # why it runs on every setup rather than only on a template change - see
    # ``dashboard.async_set_system_view``.
    #
    # ⚠️ The decision comes from the coordinator, **not** a hard-coded ``True``.
    # The bundled template always contains the System view, and the block above
    # may just have rewritten it (a template bump rebuilds the dashboard), so a
    # hard-coded ``True`` put the tab straight back on a slave - and because the
    # coordinator had already recorded the role, it never fired again.
    keep = True
    try:
        coordinator = hass.data.get(DOMAIN, {}).get(entry.entry_id, {}).get(
            "coordinator"
        )
        if coordinator is not None:
            keep = coordinator.system_view_keep
    except Exception:  # noqa: BLE001 - never break the setup over a tab
        _LOGGER.debug("Unable to read the role for %s", dev_id, exc_info=True)

    try:
        await async_set_system_view(hass, dev_id, keep)
    except Exception:  # noqa: BLE001 - never break the setup over a tab
        _LOGGER.debug("Unable to sync the System view for %s", dev_id, exc_info=True)

    if result in (RESULT_CREATED, RESULT_UPDATED):
        _LOGGER.info("Dashboard for %s: %s", dev_id, result)
        return

    # Silence here is what made a half-created dashboard look like a bug in the
    # integration instead of a message the user could act on, so the leftover
    # cases are reported at warning level with the fix spelled out.
    _LOGGER.warning(
        "Dashboard for %s was not built (%s); run the hoymiles.create_dashboard "
        "service for this device to retry",
        dev_id,
        result,
    )


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        entry_data = hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        if entry_data:
            # A running re-publish job for a device that is being removed would
            # keep talking to the broker forever, so it stops with the entry.
            await get_repeat_manager(hass).async_stop(entry_data["dev_id"])
            await get_topic_manager(hass).async_stop(entry_data["dev_id"])
            entry_data["patcher"].async_shutdown()
            await entry_data["coordinator"].async_shutdown()
    return unloaded


async def _async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the bundled Lovelace cards and inject them as frontend modules.

    Every asset listed in ``const.FRONTEND_ASSETS`` is published under
    ``FRONTEND_URL`` and appended with ``add_extra_js_url``, so users never
    have to register the cards manually as Lovelace resources.

    The assets are served with ``Cache-Control: no-cache``: the browser may keep
    them, but it has to revalidate before every use.  Home Assistant's own static
    path helper is not usable here - it either promises a one month cache or
    sends no cache directive at all (``web.FileResponse`` only carries
    ``ETag``/``Last-Modified``), and with no directive a browser is free to reuse
    its copy without asking.  That is what made an updated card keep running the
    old code until the user cleared the cache by hand or restarted Home
    Assistant.  Revalidating costs a 304 when the file is unchanged, and the new
    body as soon as it is.  The ``?v=`` query string is kept as well: it is a
    second line of defence and makes the URL self-documenting.
    """
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get("_frontend_registered"):
        return

    # Reading ``www/`` (existence checks and mtimes) is blocking IO, so it runs
    # in an executor thread instead of on the event loop.
    www_dir = Path(__file__).parent / "www"
    assets: list[tuple[str, str, int]] = await hass.async_add_executor_job(
        _collect_assets, www_dir
    )
    # Images live under the same URL but must never be injected as modules.
    images: list[tuple[str, str, int]] = await hass.async_add_executor_job(
        _collect_assets, www_dir, FRONTEND_IMAGES
    )

    if not assets:
        _LOGGER.warning("No frontend assets found in %s, skipping frontend setup", www_dir)
        return

    routes = assets + images

    http = getattr(hass, "http", None)
    if http is None:
        _LOGGER.debug("No HTTP component available, skipping static path registration")
        return

    if not _register_asset_routes(http, routes):
        # No aiohttp application to attach to (very old or unusual setup); fall
        # back to the helper, which at least serves the files.
        try:
            from homeassistant.components.http import StaticPathConfig  # noqa: PLC0415

            await http.async_register_static_paths(
                [StaticPathConfig(url, path, cache_headers=False) for url, path, _v in routes]
            )
        except ImportError:
            # Home Assistant < 2024.7
            for url, path, _v in routes:
                http.register_static_path(url, path, False)
        except Exception:  # noqa: BLE001 - never break setup because of the cards
            _LOGGER.warning("Unable to serve the Hoymiles frontend cards", exc_info=True)
            return

    try:
        from homeassistant.components.frontend import add_extra_js_url  # noqa: PLC0415

        # The version is only used to bust the browser cache: the route matches
        # on the path and ignores the query string.
        for url, _path, version in assets:
            add_extra_js_url(hass, f"{url}?v={version}")
    except Exception:  # noqa: BLE001 - never break setup because of the card
        _LOGGER.warning("Unable to register the Hoymiles frontend cards", exc_info=True)
        return

    domain_data["_frontend_registered"] = True
    _LOGGER.debug("Registered frontend assets: %s", [url for url, _p, _v in assets])


def _register_asset_routes(http: Any, assets: list[tuple[str, str, int]]) -> bool:
    """Serve each asset with a revalidating cache directive.

    Returns False when there is no aiohttp router to register on, so the caller
    can fall back to Home Assistant's static path helper.
    """
    app = getattr(http, "app", None)
    router = getattr(app, "router", None)
    if router is None:
        return False

    try:
        from aiohttp import web  # noqa: PLC0415
        from aiohttp.hdrs import CACHE_CONTROL  # noqa: PLC0415
    except ImportError:  # pragma: no cover - aiohttp is always there in practice
        return False

    for url, path, _version in assets:

        async def _serve(_request, _path=path):
            return web.FileResponse(_path, headers={CACHE_CONTROL: "no-cache"})

        router.add_get(url, _serve)
    return True


def _collect_assets(
    www_dir: Path, filenames: Sequence[str] = FRONTEND_ASSETS
) -> list[tuple[str, str, int]]:
    """Return ``(url, path, version)`` for every bundled asset that exists.

    Touches the file system, so it must be called through
    ``hass.async_add_executor_job`` rather than from the event loop.
    """
    assets: list[tuple[str, str, int]] = []
    for filename in filenames:
        asset_path = www_dir / filename
        if not asset_path.is_file():
            _LOGGER.warning("Bundled frontend asset %s is missing, skipping", asset_path)
            continue
        assets.append(
            (f"{FRONTEND_URL}/{filename}", str(asset_path), _asset_version(asset_path))
        )
    return assets


def _asset_version(path: Path) -> int:
    """Return a cache-busting token for one bundled asset."""
    try:
        return int(path.stat().st_mtime)
    except OSError:  # pragma: no cover - unreadable file, not worth failing over
        return 0
