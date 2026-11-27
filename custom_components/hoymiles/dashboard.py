"""Auto generated Lovelace dashboard for a Hoymiles micro storage device.

One device publishes roughly 80 entities, which is far too many to lay out by
hand.  This module builds a three view dashboard - System, Device and Control -
out of the cards that ship with the integration, and installs it as a regular
*storage* dashboard so the user can keep editing it afterwards.

The generated layout is a **template**: every device gets the same views and the
same cards, and only the entity ids differ.  A dashboard is a snapshot, though -
Lovelace copies the config into ``.storage/lovelace.<id>`` and the integration is
never asked again - so a template change would silently leave older devices on
the old layout.  ``TEMPLATE_VERSION`` plus the per-device hash recorded in
``.storage/hoymiles.dashboard_meta`` close that gap: a dashboard whose content
still matches what was generated for it is upgraded on setup, and one that has
been edited by hand is left alone.

Nothing here is mandatory: the integration works fine without a dashboard.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.util import slugify

from .const import (
    DASHBOARD_ICON,
    DASHBOARD_TITLE_PREFIX,
    DASHBOARD_URL_PREFIX,
    DOMAIN,
    model_has_pv,
)

_LOGGER = logging.getLogger(__name__)

VIEW_ICON_SYSTEM = "mdi:home-analytics"
VIEW_ICON_DEVICE = "mdi:home-battery"
VIEW_ICON_CONTROL = "mdi:tune"

# Path of the view that only a device with system-level readings of its own may
# keep.  See `async_set_system_view`.
SYSTEM_VIEW_PATH = "system"

# Protocol V0.6.2 publishes the device's own daily energy flows, so the sankey
# no longer has to estimate the routing from long-term statistics - it draws
# exactly what the unit measured.  The card hides itself on a device without a
# grid meter, which is why the section is always emitted.
SHOW_SANKEY = True

# Bump this whenever ``build_dashboard_config`` changes shape (a new view, a
# renamed card, different colours).  Dashboards the user has not touched are
# then rebuilt on the next setup; edited ones keep their layout.
#
# 12: the system power chart carries the split grid / load curves (gated on
#     ``has_meter``) next to the combined one.
# 13: the PV-today tile reads the vendor's self-consumption rule (published as
#     ``self_rate_pct`` on the energy-flow sensor) and totals PV as
#     own + MAX(third-party, PV2).
# 14: the system view is hidden on a slave unit (``device_role`` sensor), and
#     the control view carries the virtual-meter HTTP help block.
# 15: the Slave check points at the role sensor's **current** entity id (looked
#     up in the entity registry) instead of the one derived from the device id.
#     v14 hard-coded ``sensor.<slug>_device_role``, so a renamed device - whose
#     entities all carry the new name prefix - had a condition on a nonexistent
#     entity, i.e. a condition that is always false, i.e. no System tab at all.
# 16: that client-side condition is gone again.  A Lovelace state condition is
#     false for `unknown` / `unavailable`, so "not slave" silently meant "hide
#     unless the role is known" - which hid the tab on every offline unit and
#     every unit whose firmware does not publish `role`.  The view is now added
#     and removed by the integration from the role the device reports; the
#     template itself carries no condition at all.
# 17: the three SOC scopes are named apart.  The system view plots `sys_soc`
#     ("系统电量") and the device view's per-pack chart gained the device line,
#     because "电池电量" alone left the user unable to tell which of the three
#     was on screen.
# 18: the system view keeps **only** `sys_soc`.  A system can be several devices
#     in parallel, so this unit's own `soc` next to it only invited the same
#     confusion; the device curve stays on the Device page, with the packs.
# 19: the device line on the device view is marked `always`, so it is not counted
#     as one of the battery packs - `count_entity: pack_count` had dropped 电池 1
#     on a one-pack unit.
# 20: the **system** power chart reads the `system_*` entities only.  It used the
#     device level `pv_power` / `bat_power` / `grid_on_power`, i.e. this unit's
#     own ports, which on a master that has slaves is not what the page is about
#     (the battery curve in particular disagreed with `sys_bat_p` the moment a
#     slave started charging).  The device view is unchanged - that page *is*
#     this unit.
# 21: the layout follows the **product model**.  A `HiBattery 4020 AC` has no PV
#     input of its own, so the PV curves, the PV-by-port chart and the PV-today
#     tile are not generated for it, and the cards that draw the hardware are
#     told `show_pv: false`.
# 22: the device view's SOC chart is the **packs only** again.  Version 17-19
#     added this unit's own `soc` as a slate line so a lagging pack was visible;
#     in practice it read as one more pack and made "which curve is a module?"
#     ambiguous, so the pane drops it and is named after what it shows
#     (各电池包电量).  The device total is still on the System page.
TEMPLATE_VERSION = 22

# Return values of ``async_create_device_dashboard``.
RESULT_CREATED = "created"
RESULT_EXISTS = "exists"
RESULT_UPDATED = "updated"
RESULT_UNAVAILABLE = "unavailable"

# Per-device bookkeeping for the template upgrade: ``{"MSA-...": {template_version,
# config_hash, auto_update}}``.  Kept in its own store file so a Lovelace config
# stays a pure Lovelace config.
_META_KEY = "hoymiles.dashboard_meta"


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------
def serial_of(dev_id: str) -> str:
    """Return the SN part of ``client_prefix-SN``."""
    return dev_id.rsplit("-", 1)[-1]


def dashboard_url_path(dev_id: str) -> str:
    """Return the ``url_path`` used for the device's dashboard."""
    return f"{DASHBOARD_URL_PREFIX}{slugify(serial_of(dev_id))}"


def dashboard_title(dev_id: str) -> str:
    """Return the sidebar title of the device's dashboard.

    The title is the serial the device reports **with its client prefix**
    (``MSA-280577777777``).  That is the string the RMI carries and the one the
    user sees on the device itself; the bare digits cannot tell an ``MSA`` from
    a ``MAW``.  An entry that reports digits only keeps the ``G3_`` marker, so
    it is still recognisable among the other dashboards.
    """
    if "-" in dev_id:
        return dev_id
    return f"{DASHBOARD_TITLE_PREFIX}{dev_id}"


# Protocol key -> entity id suffix, for the few entities the integration does
# not create itself.  Home Assistant names a discovery entity after its
# ``name``, and the firmware's name for §36 ``bat_p`` is "Battery Power".
_ENTITY_SUFFIX_ALIASES = {
    "bat_power": "battery_power",
}


def _entity_id(dev_id: str, suffix: str) -> str:
    """Return the entity id the platform created for ``suffix``.

    ``sensor.py`` builds its entity ids from ``slugify(dev_id)``, so
    ``MSA-280577777777`` becomes ``sensor.msa_280577777777_<suffix>``.

    **Exception: the battery power entity comes from the firmware's own MQTT
    discovery (§36 ``sensor/<dev_id>/bat_p/config``)**, and Home Assistant
    derives its entity id from the payload's ``name`` (``"Battery Power"``), not
    from the object id. That makes the id ``..._battery_power``, so the raw
    suffix ``bat_power`` pointed at an entity that does not exist - the history
    chart then dropped the battery curve (``skip_empty``) and the power chart
    showed PV + grid only. The card also accepts either spelling, so an already
    generated dashboard keeps working.
    """
    suffix = _ENTITY_SUFFIX_ALIASES.get(suffix, suffix)
    return f"sensor.{slugify(dev_id)}_{suffix}"


# ---------------------------------------------------------------------------
# Config builder
# ---------------------------------------------------------------------------
def _section(*cards: dict[str, Any]) -> dict[str, Any]:
    return {"type": "grid", "column_span": 4, "cards": list(cards)}


def _label(en: str, zh: str, de: str | None = None) -> dict[str, str]:
    """A three-language label map for a card option.

    The bundled cards resolve these against the reader's choice from the
    language dropdown, so the dashboard follows the person looking at it rather
    than whoever happened to set the interface language.  ``de`` may be omitted,
    in which case the cards fall back to ``en`` - that keeps a partial
    translation readable rather than blank.
    """
    return {"en": en, "zh": zh, "de": de if de is not None else en}


_VIEW_TITLES = {
    "system": {"en": "System", "zh": "系统", "de": "System"},
    "device": {"en": "Device", "zh": "设备", "de": "Ger\u00e4t"},
    "control": {"en": "Control", "zh": "控制", "de": "Steuerung"},
}


def _view_title(key: str, lang: str) -> str:
    return _VIEW_TITLES[key].get(lang) or _VIEW_TITLES[key]["en"]


def _series(
    entity: str,
    name_en: str,
    name_zh: str,
    color: str,
    name_de: str | None = None,
) -> dict[str, Any]:
    """One curve of a history chart."""
    return {
        "entity": entity,
        "name": _label(name_en, name_zh, name_de),
        "color": color,
    }


def _history(
    title_en: str,
    title_zh: str,
    series: list[dict[str, Any]],
    title_de: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """A history chart; ``series`` is mandatory, the card rejects a config without it."""
    return {
        "type": "custom:hoymiles-history-chart",
        "title": _label(title_en, title_zh, title_de),
        "range": "day",
        "series": series,
        "grid_options": {"columns": "full"},
        **extra,
    }


def _gauge(
    entity: str,
    name_en: str,
    name_zh: str,
    icon: str,
    name_de: str | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {
        "type": "custom:hoymiles-gauge",
        "entity": entity,
        "name": _label(name_en, name_zh, name_de),
        "unit": "kWh",
        "scale": 0.001,
        "max": 10,
        "decimals": 2,
        "icon": icon,
        **extra,
    }


# ---------------------------------------------------------------------------
# Chart palette
# ---------------------------------------------------------------------------
# The colours follow the vendor app so a screenshot from one is readable in the
# other: yellow production, green battery, blue grid & load.
#
# The three power curves are stacked and overlap for most of the day, so the
# hues still have to be far apart - yellow / green / blue sit roughly 120
# degrees from each other, and each also differs in lightness, which keeps them
# separable for the common forms of colour blindness. (An earlier trio of
# #22c55e / #4a90d9 / #22d3ee collapsed into one ribbon: the last two are 40
# degrees apart and the lighter one vanished under the darker one at 32 % fill.)
COLOR_PV = "#f59e0b"        # amber/yellow - production
COLOR_PV2 = "#f97316"       # orange       - the second PV branch (grid-connected MI)
COLOR_BATTERY = "#22c55e"   # green         - charge / discharge, and SOC
COLOR_GRID = "#3b82f6"      # blue         - grid & load (system view)
COLOR_SOC = COLOR_BATTERY   # battery SOC uses the battery colour

# Three SOC levels can be on screen at once - the system (every unit in
# parallel), one device (its own packs summed) and each pack's own BMS reading.
# The device view shows only the packs now (version 22), so the two scopes that
# are drawn get one colour each: the system keeps the battery green, the packs
# keep their own palette below.

# The device view splits what the system view folds together, so it needs two
# more slots: the on-grid port in slate grey, the off-grid (EPS) port in the same
# blue the system view uses for the combined reading.
COLOR_GRID_PORT = "#64748b"
COLOR_OFFGRID = COLOR_GRID

# With a grid meter the system chart splits the combined curve in two: the grid
# itself in slate grey (a metered utility, not a colour of its own - the same
# choice the sankey card makes) and the house load in blue.
COLOR_LOAD = COLOR_GRID

# Four-slot palette for the per-PV-port chart (yellow / green / grey / blue).
COLOR_SERIES_4 = (COLOR_PV, COLOR_BATTERY, "#64748b", COLOR_GRID)

# Per-pack palette. With the usual single pack only the first slot is ever
# drawn; the rest only matter on multi-pack units, where the extra hues have to
# stay distinguishable from each other on the same 0..100 % axis.
COLOR_PACKS = (COLOR_BATTERY, "#0ea5e9", COLOR_PV, "#a855f7")


def _power_series(
    dev_id: str,
    grid_name_en: str,
    grid_name_zh: str,
    grid_name_de: str | None = None,
) -> list[dict[str, Any]]:
    """The curves of the **system** power chart (§37 ``sys_*`` / §39).

    This chart belongs to the System view, which describes the whole installation
    - this unit plus every slave it aggregates.  Every curve therefore comes from
    a ``system_*`` entity, i.e. the ``sys_*`` fields of the 1 s state or the
    ``system/state`` snapshot.  The device level `pv_power` / `bat_power` /
    `grid_on_power` look like the same numbers while every slave is idle and then
    silently disagree the moment one of them charges, which is exactly the
    confusion this page must not create.  The Device view keeps those.

    Naming note: §37/§39 call ``sys_pv_p`` **系统离网微逆光伏功率** and
    ``sys_pv2_p`` **系统并网微逆光伏功率** - the PV of micro inverters in the
    network, not the storage units' own PV ports.  That is what the protocol
    offers at system scope, so the chart draws those two branches as they are.

    **With a grid meter the grid and the load are two different measurements**,
    so the combined curve is replaced by the two of them.  Which pair is drawn is
    decided by the card, not here: the template is written once and carries both,
    gated on ``has_meter`` of the energy-flow sensor (``while`` / ``unless``).

    Without a meter ``sys_grid_p`` stays 0 - there is nothing measuring the grid,
    and ``sys_load_p`` carries the whole house consumption, which is the same
    number the device reports for its on-grid port.  The combined curve is
    therefore ``system_load_power``, not ``system_grid_power``.

    **No per-model switch here.**  Even on an AC coupled unit (which has no MPPT
    input of its own) this page can carry real PV: `sys_pv_p` is the PV of the
    micro inverters in the *system*, so a 4020 AC that sits next to PV
    micro inverters still reports production.  This is why the model only ever
    trims the Device and Control pages.
    """
    meter = {
        "entity": _entity_id(dev_id, "energy_flow_today"),
        "attribute": "has_meter",
    }
    # ``sys_pv2_p`` is published as 0 on every unit, even with no micro inverter
    # attached, so it would be drawn as a flat line and add a legend entry that
    # means nothing.  §32's ``has_solar2`` flag says whether the branch exists at
    # all - the same flag the power-flow card uses for its PV2 node.
    solar2 = {
        "entity": _entity_id(dev_id, "energy_flow_today"),
        "attribute": "has_solar2",
    }
    pv_series: list[dict[str, Any]] = [
        _series(
            _entity_id(dev_id, "system_pv_power"),
            "PV power",
            "光伏功率",
            COLOR_PV,
            "PV-Leistung",
        ),
        {
            **_series(
                _entity_id(dev_id, "system_pv2_power"),
                "PV2 power",
                "光伏2功率",
                COLOR_PV2,
                "PV2-Leistung",
            ),
            "while": solar2,
        },
    ]
    return [
        *pv_series,
        _series(
            _entity_id(dev_id, "system_battery_power"),
            "Battery",
            "电池",
            COLOR_BATTERY,
            "Batterie",
        ),
        {
            **_series(
                _entity_id(dev_id, "system_grid_power"),
                "Grid",
                "电网",
                COLOR_GRID_PORT,
                "Netz",
            ),
            "while": meter,
        },
        {
            **_series(
                _entity_id(dev_id, "system_load_power"),
                "Load",
                "用电功率",
                COLOR_LOAD,
                "Last",
            ),
            "while": meter,
        },
        {
            **_series(
                _entity_id(dev_id, "system_load_power"),
                grid_name_en,
                grid_name_zh,
                COLOR_GRID,
                grid_name_de,
            ),
            "unless": meter,
        },
    ]


def _sankey_section(dev_id: str) -> list[dict[str, Any]]:
    """The energy-flow section, or nothing while ``SHOW_SANKEY`` is off.

    Returned as a list so the caller can spread it into its ``sections`` and
    the layout stays identical whether or not the card is emitted.

    No model-dependent switch is needed here: the card drops every node whose
    flows add up to zero, so an AC coupled unit (whose PV readings are a hard 0)
    simply never draws a PV source.
    """
    if not SHOW_SANKEY:
        return []
    return [
        _section(
            {
                "type": "custom:hoymiles-energy-sankey",
                "dev_id": dev_id,
                "title": _label(
                    "Energy flow", "能量流", "Energiefluss"
                ),
                # No icon: the card draws a full sankey diagram right below the
                # title, so a glyph there was one symbol too many - it repeated
                # "this is a flow" next to the flow itself.
                "grid_options": {"columns": "full"},
            }
        )
    ]


def _alarm_card(dev_id: str) -> dict[str, Any]:
    """The active-alarm list (protocol V0.6.2 §27).

    It sits next to the device illustration on the Device page: an alarm is
    something you want to see while looking at the hardware, not a detail
    hidden at the bottom of a history page.  The card keeps its own scroll area,
    so the device can report up to 20 without stretching the page.

    The card collapses itself when the device reports no alarms (it sets
    ``hidden`` on its own element, which makes Home Assistant hide the wrapper),
    so the illustration gets the whole row instead of being squeezed to half of
    it beside a box that would only say "no alarms".
    """
    return {
        "type": "custom:hoymiles-alarms",
        "dev_id": dev_id,
        "title": _label("Active alarms", "当前告警", "Aktive Alarme"),
    }


def _model_of(hass: HomeAssistant, dev_id: str) -> str | None:
    """The product model from the device registry, or ``None`` when unknown.

    ``discovery_override`` backfills the model the firmware announces in its MQTT
    discovery payload, so by the time a dashboard is generated (or regenerated)
    this is normally filled in.  ``None`` stays a valid answer: the layout then
    keeps every curve, and ``_async_apply_model`` regenerates the dashboard once
    the model arrives.
    """
    try:
        registry = dr.async_get(hass)
    except Exception:  # noqa: BLE001 - a missing registry must not break setup
        return None
    entry = registry.async_get_device(identifiers={(DOMAIN, dev_id)})
    if entry is not None and entry.model:
        return entry.model
    return None


def build_dashboard_config(
    dev_id: str, lang: str = "en", model: str | None = None
) -> dict[str, Any]:
    """Return the Lovelace config for one device.

    A plain ``dict`` rather than YAML: the Lovelace storage format is JSON and
    going through YAML would only add a round trip.  All user visible strings
    are ``{en, zh, de}`` maps - the bundled cards pick the one matching the
    reader's choice from the language dropdown (English unless they picked
    something else), so the dashboard follows the person looking at it instead
    of being frozen in one language.

    ``lang`` only affects the **view titles**: a Lovelace view title is a plain
    string rather than a language map, and nothing on the client can rewrite it
    when the dropdown changes, so the titles stay English.

    ``model`` is the product model from the device registry.  It is the only
    thing that can tell an AC coupled unit (no PV input at all, PV comes from
    micro inverters on the AC side) from one with an MPPT input: the firmware
    publishes every PV entity on every model, so the AC unit's PV readings are a
    hard 0 rather than missing.  ``None`` means "not known yet" and keeps every
    curve - hiding a real branch is worse than drawing a flat line, and the
    dashboard is regenerated once the model has been backfilled.
    """
    has_pv = model_has_pv(model)
    pv_today = _entity_id(dev_id, "system_pv_energy_today")
    slug = slugify(dev_id)
    sync_system = f"{slug}-system"
    sync_device = f"{slug}-device"

    # ⚠️ The **System** page deliberately keeps every PV widget, whatever the
    # model is: that page describes the whole installation, and an AC coupled
    # storage unit can perfectly well sit next to PV micro inverters whose
    # production the master aggregates.  Only the Device and Control pages -
    # which describe *this unit's own hardware* - follow the model.

    system_view = {
        "title": _view_title("system", lang),
        "path": SYSTEM_VIEW_PATH,
        "icon": VIEW_ICON_SYSTEM,
        "type": "sections",
        # A **slave** has no system page: every number on it (`system/state`,
        # the energy flows, the system power readings) is measured by the master
        # and published on the master's topics, so the page would show dashes
        # from top to bottom.
        #
        # ⚠️ The tab is NOT hidden with a view-level `visible` condition.
        # That was v14, and it was a trap: a Lovelace state condition evaluates
        # to **false** for an entity whose state is `unknown` or `unavailable`,
        # so the condition `state_not: slave` did not mean "hide only slaves" -
        # it hid the tab on every unit that had not reported its role yet (an
        # offline device, older firmware without a `role` field, or the seconds
        # after a restart), i.e. on most devices, always.
        #
        # The view is added and removed by `async_set_system_view` instead, from
        # the role the unit actually publishes in `event/state`.  Not knowing the
        # role therefore keeps the page, which is the safe direction.
        "max_columns": 4,
        "show_icon_and_title": True,
        "sections": [
            _section(
                {
                    "type": "grid",
                    "columns": 2,
                    "square": False,
                    # A grid card that sits directly in a section only takes two
                    # of the section's columns unless it asks for all of them.
                    # Without this the power flow and the gauges end up squeezed
                    # into the left half of the page.
                    "grid_options": {"columns": "full"},
                    "cards": [
                        {
                            "type": "custom:hoymiles-power-flow",
                            "dev_id": dev_id,
                            "title": _label("My home", "我的家", "Mein Zuhause"),
                            "max_width": 700,
                            "show_title": False,
                            "grid_options": {"columns": "full"},
                        },
                        {
                            "type": "grid",
                            "columns": 2,
                            "square": False,
                            "cards": [
                                _gauge(
                                    pv_today,
                                    "PV today",
                                    "今日发电",
                                    "panel",
                                    "PV heute",
                                    label=_label(
                                        "Self-consumption rate",
                                        "自发自用率",
                                        "Eigenverbrauchsquote",
                                    ),
                                    # The vendor's self-consumption rule branches
                                    # on the export ratio and mixes §45's flows
                                    # with `system/state`'s PV2 production, so it
                                    # cannot be written as one fraction.  The
                                    # integration computes it and exposes
                                    # `self_rate_pct`; the arc only scales it.
                                    percent_entity=_entity_id(dev_id, "energy_flow_today"),
                                    percent_attribute="self_rate_pct",
                                ),
                                {
                                    "type": "grid",
                                    "columns": 1,
                                    "square": False,
                                    "cards": [
                                        _gauge(
                                            _entity_id(
                                                dev_id,
                                                "battery_discharge_energy_today",
                                            ),
                                            "Discharged today",
                                            "今日放电",
                                            "cycle",
                                            "Entladen heute",
                                            show_arc=False,
                                        ),
                                        _gauge(
                                            _entity_id(
                                                dev_id,
                                                "battery_charge_energy_today",
                                            ),
                                            "Charged today",
                                            "今日充电",
                                            "battery",
                                            "Geladen heute",
                                            show_arc=False,
                                        ),
                                    ],
                                },
                            ],
                        },
                    ],
                }
            ),
            _section(
                {
                    "type": "custom:hoymiles-history-chart",
                    "title": _label("History Data", "历史数据", "Verlauf"),
                    "range": "day",
                    "sync_group": sync_system,
                    # Two charts, one time window.  Drawn as separate cards they
                    # each carried their own date picker, which made the second
                    # one look like it kept a period of its own.
                    "panes": [
                        {
                            "title": _label("Power", "功率", "Leistung"),
                            "series": _power_series(
                                dev_id,
                                "Grid & load",
                                "电网与负载",
                                "Netz & Last",
                            ),
                            "unit": "W",
                            "height": 330,
                            # Overlay, do not stack.  PV, battery and grid are
                            # three *independent* measurements of the same flow,
                            # not parts of a sum: stacking them drew the battery
                            # at 0..88 W and the grid at 88..176 W even when the
                            # two readings were identical, so the curves sat one
                            # above the other instead of on top of each other.
                            "stack": False,
                            # No `span`: the y axis fits whatever the day
                            # actually contains.  A fixed +-2500 W range
                            # flattened a 90 W idle evening into a hairline.
                        },
                        {
                            # Only the system reading belongs here.  This page
                            # describes the whole system, which may be several
                            # devices in parallel, so plotting this unit's own
                            # `soc` next to it invited exactly the confusion this
                            # naming was meant to remove.  The device curve lives
                            # on the Device page, where the packs are.
                            "title": _label(
                                "System SOC", "系统电量", "System-Batteriestand"
                            ),
                            "series": [
                                _series(
                                    _entity_id(dev_id, "system_soc"),
                                    "System SOC",
                                    "系统电量",
                                    COLOR_SOC,
                                    "System-Batteriestand",
                                ),
                            ],
                            "unit": "%",
                            "height": 250,
                            "symmetric": False,
                            "min": 0,
                            "max": 100,
                        },
                    ],
                    "grid_options": {"columns": "full"},
                }
            ),
            *_sankey_section(dev_id),
        ],
    }
    device_view = {
        "title": _view_title("device", lang),
        "path": "device",
        "icon": VIEW_ICON_DEVICE,
        "type": "sections",
        "max_columns": 4,
        "show_icon_and_title": True,
        "sections": [
            _section(
                {
                    # The illustration and the alarm list share the top row: the
                    # Device page is where you look at the hardware, and an
                    # alarm is a fact about that hardware. Side by side also
                    # keeps the page short - stacking them pushed every history
                    # chart below the fold.
                    #
                    # A horizontal stack rather than a 2-column grid: the alarm
                    # card hides itself when there is nothing to report, and only
                    # a flex row hands the freed width to the illustration.  A
                    # grid keeps its columns whatever happens and leaves half the
                    # row blank - which is exactly what it looked like.
                    "type": "horizontal-stack",
                    "grid_options": {"columns": "full"},
                    "cards": [
                        {
                            "type": "custom:hoymiles-battery",
                            "dev_id": dev_id,
                            "max_width": 620,
                            "show_history": False,
                            # The illustration draws the PV corner (sun, "PV"
                            # caption, its readout) and the PV inflow; on an AC
                            # coupled unit that branch does not exist, so the
                            # card is told to leave it out instead of showing a
                            # permanent 0 W port.
                            **({} if has_pv else {"show_pv": False}),
                        },
                        _alarm_card(dev_id),
                    ],
                }
            ),
            _section(
                _history(
                    "Pack SOC",
                    "各电池包电量",
                    [
                        # Only the packs themselves: the device total is the
                        # average of these curves, and a reader who wants it
                        # finds it on the System page.  Leaving it in this pane
                        # drew one line that was NOT a pack next to the ones that
                        # are, which is why the pane is now named after what it
                        # really shows.
                        *[
                            _series(
                                _entity_id(dev_id, f"pack_{idx}_soc"),
                                f"Battery {idx}",
                                f"电池 {idx}",
                                color,
                                f"Batterie {idx}",
                            )
                            for idx, color in enumerate(COLOR_PACKS, start=1)
                        ],
                    ],
                    "Modulstand",
                    unit="%",
                    height=300,
                    symmetric=False,
                    min=0,
                    max=100,
                    sync_group=sync_device,
                    # The list is written for the largest unit (four packs), but
                    # a pack that does not exist reports nothing, and the card
                    # drops such a series instead of drawing it as a flat 0 %
                    # line.  One pack in, one green curve out.
                    skip_empty=True,
                    # ...and the *number* of packs comes from the device itself,
                    # not from this template. `skip_empty` alone was not enough:
                    # the recorder keeps values for packs a unit had before it was
                    # re-configured, so a one-pack device kept drawing four stale
                    # curves next to a power-flow card that drew one module.
                    count_entity=_entity_id(dev_id, "pack_count"),
                ),
                # A unit with no PV input has no per-port PV chart at all: its
                # pv*_power entities stay `unknown` for ever, so the card would
                # draw an empty frame with a legend of four ports that do not
                # exist.  Spread conditionally so the section keeps its shape.
                *([_history(
                    "PV power by port",
                    "各光伏端口功率",
                    [
                        _series(
                            _entity_id(dev_id, f"pv{idx}_power"),
                            f"PV{idx}",
                            f"光伏{idx}",
                            color,
                            f"PV{idx}",
                        )
                        for idx, color in enumerate(COLOR_SERIES_4, start=1)
                    ],
                    "PV-Leistung je Anschluss",
                    unit="W",
                    height=240,
                    sync_group=sync_device,
                    # Here stacking *is* meaningful: the ports are parts of one
                    # total, so the top of the stack reads as the whole array.
                    stack=True,
                    # Only the ports that exist report; unused ones are dropped
                    # by the card rather than drawn as a 0 W line.
                    skip_empty=True,
                )] if has_pv else []),
            ),
            _section(
                _history(
                    "Power curve",
                    "功率曲线",
                    # The device view is per *port*, not per meter: a unit without
                    # a grid meter still reports its on-grid and off-grid ports
                    # separately, so these four curves are four independent
                    # measurements. The system view instead folds the ports into
                    # one "Grid & load" reading.
                    [
                        # No PV input: no PV curve.  The port would read a hard
                        # 0 W all year, which is a legend entry that lies about
                        # the hardware.
                        *([_series(
                            _entity_id(dev_id, "pv_power"),
                            "PV power",
                            "光伏功率",
                            COLOR_PV,
                            "PV-Leistung",
                        )] if has_pv else []),
                        _series(
                            _entity_id(dev_id, "bat_power"),
                            "Battery",
                            "电池",
                            COLOR_BATTERY,
                            "Batterie",
                        ),
                        _series(
                            _entity_id(dev_id, "grid_on_power"),
                            "Grid port",
                            "并网端口",
                            COLOR_GRID_PORT,
                            "Netzanschluss",
                        ),
                        _series(
                            _entity_id(dev_id, "grid_off_power"),
                            "Off-grid port",
                            "离网端口",
                            COLOR_OFFGRID,
                            "Inselanschluss",
                        ),
                    ],
                    "Leistungsverlauf",
                    unit="W",
                    height=300,
                    sync_group=sync_device,
                    # Independent readings: overlay, never stack.
                    stack=False,
                ),
            ),
        ],
    }

    control_view = {
        "title": _view_title("control", lang),
        "path": "control",
        "icon": VIEW_ICON_CONTROL,
        "type": "sections",
        "max_columns": 4,
        "show_icon_and_title": True,
        "sections": [
            # One card only: `<hoymiles-control>` hosts the TOU editor inside
            # its EMS card when the device is in tou_plan, so the plan is never
            # a separate block further down the page.
            _section(
                {
                    "type": "custom:hoymiles-control",
                    "dev_id": dev_id,
                    "subtitle": False,
                    "grid_options": {"columns": "full"},
                }
            ),
        ],
    }

    # Two pages only. The diagnostics page used to hold the MQTT log, but that
    # is a switch on the control page now, and a whole page whose single card was
    # usually off read as an empty tab in the sidebar.
    return {"views": [system_view, device_view, control_view]}


# ---------------------------------------------------------------------------
# Lovelace plumbing
# ---------------------------------------------------------------------------
def _lovelace_data(hass: HomeAssistant) -> Any:
    """Return ``hass.data[LOVELACE_DATA]`` or None when Lovelace is missing."""
    try:
        from homeassistant.components.lovelace.const import (  # noqa: PLC0415
            LOVELACE_DATA,
        )
    except ImportError:  # pragma: no cover - Lovelace ships with Home Assistant
        return None
    return hass.data.get(LOVELACE_DATA)


def _dashboards(hass: HomeAssistant) -> dict[str, Any] | None:
    """Return the ``url_path -> LovelaceConfig`` mapping.

    Home Assistant has exposed this container as a mapping and, in newer
    releases, as an attribute of a dataclass.  Both shapes are supported.
    """
    data = _lovelace_data(hass)
    if data is None:
        return None
    if isinstance(data, dict):
        return data.get("dashboards")
    return getattr(data, "dashboards", None)


def _dashboards_collection(hass: HomeAssistant) -> Any:
    """Return the dashboards storage collection when the release exposes it."""
    data = _lovelace_data(hass)
    if data is None:
        return None
    if isinstance(data, dict):
        return data.get("dashboards_collection")
    return getattr(data, "dashboards_collection", None)


def _entry_spec(url_path: str, title: str) -> dict[str, Any]:
    return {
        "url_path": url_path,
        "title": title,
        "icon": DASHBOARD_ICON,
        "show_in_sidebar": True,
        "require_admin": False,
        "mode": "storage",
    }


async def _async_register_fallback(hass: HomeAssistant, item: dict[str, Any]) -> None:
    """Publish a dashboard the running instance does not know about yet.

    Only used when neither the collection nor the WebSocket command could be
    reached.  The entry is already persisted by then; this adds the in-memory
    object and the sidebar panel so the dashboard is usable without a restart.
    """
    try:
        from homeassistant.components.lovelace.const import (  # noqa: PLC0415
            MODE_STORAGE,
        )
        from homeassistant.components.lovelace.dashboard import (  # noqa: PLC0415
            LovelaceStorage,
        )
    except ImportError:  # pragma: no cover
        return

    url_path = item["url_path"]
    dashboards = _dashboards(hass)
    if dashboards is not None and url_path not in dashboards:
        dashboards[url_path] = LovelaceStorage(hass, item)

    try:
        from homeassistant.components import frontend  # noqa: PLC0415

        frontend.async_register_built_in_panel(
            hass,
            "lovelace",
            frontend_url_path=url_path,
            config={"mode": MODE_STORAGE},
            require_admin=bool(item.get("require_admin", False)),
            sidebar_title=item.get("title"),
            sidebar_icon=item.get("icon"),
            update=False,
        )
    except Exception:  # noqa: BLE001 - the entry is saved, the panel is a bonus
        _LOGGER.debug("Unable to register the dashboard panel %s", url_path, exc_info=True)


class _StubUser:
    """Minimal user object; the create command is admin only."""

    is_admin = True


class _StubConnection:
    """Collect the result of a WebSocket command run in-process."""

    user = _StubUser()

    def __init__(self) -> None:
        self.result: Any = None
        self.error: tuple[str, str] | None = None

    def send_result(self, msg_id: int, result: Any = None) -> None:
        self.result = result

    def send_error(self, msg_id: int, code: str, message: str, **_: Any) -> None:
        self.error = (code, message)

    def send_message(self, msg: dict[str, Any]) -> None:  # pragma: no cover
        pass


async def _async_create_via_command(
    hass: HomeAssistant, spec: dict[str, Any]
) -> dict[str, Any] | None:
    """Run Home Assistant's own ``lovelace/dashboards/create`` command.

    Recent releases keep the dashboards collection private, so this is the only
    way to create an entry that the running instance fully knows about: it goes
    through the same validation, persists the item and fires the listener that
    registers the sidebar panel.  Returns the created item, or None.
    """
    try:
        from homeassistant.components import websocket_api  # noqa: PLC0415

        handlers = hass.data.get(websocket_api.DOMAIN)
        entry = handlers.get("lovelace/dashboards/create") if handlers else None
    except ImportError:  # pragma: no cover
        return None

    # The registry holds either the bare handler or a (handler, schema) tuple,
    # depending on the release.
    handler = None
    if callable(entry):
        handler = entry
    elif isinstance(entry, tuple):
        handler = next((part for part in entry if callable(part)), None)
    if handler is None:
        return None

    connection = _StubConnection()
    try:
        await handler(hass, connection, {"id": 1, "type": "lovelace/dashboards/create", **spec})
    except Exception:  # noqa: BLE001 - fall through to the next strategy
        _LOGGER.debug("lovelace/dashboards/create failed", exc_info=True)
        return None

    if connection.error is not None:
        _LOGGER.debug("lovelace/dashboards/create: %s", connection.error)
        return None
    return connection.result if isinstance(connection.result, dict) else {}


async def _async_registry_items(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Return the dashboard items Lovelace has persisted.

    The registry file - not the in-memory container - is the source of truth for
    a dashboard's ``id``.  The object handed back right after creation still
    carries its pre-create state, which is how a config once ended up under
    ``lovelace.g3-...`` while Lovelace read ``lovelace.g3_...`` and showed an
    empty page.
    """
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return []
    try:
        data = await Store(hass, 1, "lovelace_dashboards").async_load()
    except Exception:  # noqa: BLE001 - an unreadable registry is an empty one
        return []
    if not isinstance(data, dict):
        return []
    payload = data.get("data")
    if not isinstance(payload, dict):
        return []
    items = payload.get("items")
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


async def _async_ensure_registry_entry(
    hass: HomeAssistant, spec: dict[str, Any]
) -> bool:
    """Add the item to the persisted registry when nothing else could.

    ``lovelace/dashboards/create`` is a WebSocket command and recent releases
    keep the collection private, so an integration has no supported way to add
    an entry.  Writing the same store file Home Assistant writes is the last
    resort: it is exactly what the next restart would produce anyway, and the
    sidebar panel is registered in memory so the dashboard is usable at once.
    """
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return False

    url_path = str(spec["url_path"])
    store = Store(hass, 1, "lovelace_dashboards")
    try:
        data = await store.async_load()
    except Exception:  # noqa: BLE001
        data = None
    if not isinstance(data, dict):
        data = {"version": 1, "minor_version": 1, "key": "lovelace_dashboards"}

    payload = data.get("data")
    if not isinstance(payload, dict):
        payload = {}
        data["data"] = payload
    items = payload.get("items")
    if not isinstance(items, list):
        items = []
    if any(isinstance(i, dict) and i.get("url_path") == url_path for i in items):
        return True

    payload["items"] = [*items, dict(spec)]
    payload.setdefault("deleted_items", [])
    try:
        await store.async_save(data)
    except Exception:  # noqa: BLE001
        _LOGGER.warning(
            "Unable to add %s to the dashboards registry", url_path, exc_info=True
        )
        return False

    await _async_register_fallback(hass, dict(spec))
    _LOGGER.info("Added the dashboard entry %s to the registry", url_path)
    return True


async def _async_ensure_entry(hass: HomeAssistant, url_path: str, title: str) -> bool:
    """Create the dashboard entry unless it is already there.

    Tried in order of preference: the storage collection, Home Assistant's own
    ``lovelace/dashboards/create`` command, and finally the registry file.  Each
    step re-checks the registry instead of trusting the return value - the
    in-process connection used for the command can add the item and still report
    a failure while replying to a stub that is not a real client.
    """
    dashboards = _dashboards(hass)
    if dashboards is None:
        return False
    if url_path in dashboards:
        return True

    spec = _entry_spec(url_path, title)

    collection = _dashboards_collection(hass)
    if collection is not None:
        try:
            await collection.async_create_item(dict(spec))
        except Exception:  # noqa: BLE001 - never break the caller over a panel
            _LOGGER.debug(
                "dashboards collection rejected %s", url_path, exc_info=True
            )
        if url_path in (_dashboards(hass) or {}):
            return True

    item = await _async_create_via_command(hass, spec)
    persisted = any(
        entry.get("url_path") == url_path
        for entry in await _async_registry_items(hass)
    )

    if persisted or item is not None:
        # Either the command replied normally or it added the item first and
        # then failed to talk to our stub connection.  The registry decides.
        if url_path not in (_dashboards(hass) or {}):
            await _async_register_fallback(hass, {**spec, **dict(item or {})})
        return True

    return await _async_ensure_registry_entry(hass, spec)




async def _async_item_id(hass: HomeAssistant, dashboard: Any, url_path: str) -> str:
    """Return the ``id`` Lovelace stores this dashboard's config under.

    Resolved in this order, because only the first one is authoritative:

    1. the persisted registry item whose ``url_path`` matches,
    2. the ``id`` carried by the in-memory dashboard object,
    3. Home Assistant's own rule, ``slugify(url_path)``.

    Step 3 is what ``lovelace/dashboards/create`` would have produced, so it is
    the right answer for a dashboard that was created but never loaded.  Step 1
    matters for older dashboards whose id kept the dash (``g3-280577777777``):
    guessing would write a second file that the real one then shadows.
    """
    for entry in await _async_registry_items(hass):
        if entry.get("url_path") != url_path:
            continue
        item_id = entry.get("id")
        if isinstance(item_id, str) and item_id:
            return item_id

    current = getattr(dashboard, "config", None)
    if isinstance(current, dict):
        item_id = current.get("id")
        if isinstance(item_id, str) and item_id:
            return item_id

    return slugify(url_path)


async def _async_write_entry_title(
    hass: HomeAssistant, url_path: str, title: str
) -> None:
    """Persist a new sidebar title straight into the dashboards registry file.

    Last resort for ``_async_rename_entry``: the registry file is what the
    sidebar is built from at the next start, so the name is right even when the
    ``lovelace/dashboards/update`` command cannot be reached.
    """
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return

    store = Store(hass, 1, "lovelace_dashboards")
    try:
        data = await store.async_load()
    except Exception:  # noqa: BLE001 - an unreadable registry is left alone
        return
    if not isinstance(data, dict):
        return
    payload = data.get("data")
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return

    changed = False
    for item in items:
        if not isinstance(item, dict) or item.get("url_path") != url_path:
            continue
        if item.get("title") == title:
            return
        item["title"] = title
        changed = True
    if not changed:
        return

    try:
        await store.async_save(data)
        _LOGGER.info("Renamed the dashboard entry %s to %s", url_path, title)
    except Exception:  # noqa: BLE001 - the title is cosmetic
        _LOGGER.debug("Unable to rename %s", url_path, exc_info=True)


def _live_entry(collection: Any, item_id: str) -> dict[str, Any] | None:
    """Return the item the running Lovelace collection holds for ``item_id``.

    The persisted file and the in-memory collection can disagree - writing the
    file behind the collection's back is exactly how a rename gets lost on the
    next save - so the *live* item is what a rename has to be compared with.
    """
    getter = getattr(collection, "async_items", None)
    if getter is None:
        return None
    try:
        for entry in getter():
            if isinstance(entry, dict) and entry.get("id") == item_id:
                return entry
    except Exception:  # noqa: BLE001 - an unknown API shape is not fatal
        return None
    return None


async def _async_rename_entry(hass: HomeAssistant, url_path: str, title: str) -> None:
    """Give an existing dashboard the sidebar title its device serial implies.

    The dashboard entry is created once and never rewritten - that is what keeps
    a user's own edits - but the **title** is derived, not configured.  A
    release that used the bare digits (``G3_280577777777``) would therefore pin
    that name forever, while the device reports ``MSA-280577777777``.

    The field is updated through the dashboards storage collection, which is
    the same path the frontend uses and which fires the listener that relabels
    the sidebar panel without a restart.  ``async_update_item`` replaces the
    item, so the current one is merged rather than sending a bare title.
    """
    item = next(
        (
            entry
            for entry in await _async_registry_items(hass)
            if entry.get("url_path") == url_path
        ),
        None,
    )
    collection = _dashboards_collection(hass)

    item_id = item.get("id") if isinstance(item, dict) else None
    if not isinstance(item_id, str) or not item_id:
        item_id = await _async_item_id(
            hass, (_dashboards(hass) or {}).get(url_path), url_path
        )

    live = _live_entry(collection, item_id) if collection is not None else None
    if item is None and live is None and url_path not in (_dashboards(hass) or {}):
        # Nothing exists yet: the create path is about to set the right title.
        return
    if (live or item or {}).get("title") == title:
        return

    if collection is not None and (live is not None or item is not None):
        merged = {**(live or item or {}), "id": item_id, "title": title}
        try:
            result = collection.async_update_item(item_id, merged)
            if inspect.isawaitable(result):
                await result
            _LOGGER.info("Renamed the dashboard %s to %s", url_path, title)
            return
        except Exception:  # noqa: BLE001 - fall back to the command below
            _LOGGER.debug(
                "dashboards collection refused the rename of %s",
                url_path,
                exc_info=True,
            )

    try:
        from homeassistant.components import websocket_api  # noqa: PLC0415

        handlers = hass.data.get(websocket_api.DOMAIN)
        entry = handlers.get("lovelace/dashboards/update") if handlers else None
    except ImportError:  # pragma: no cover
        entry = None

    handler = None
    if callable(entry):
        handler = entry
    elif isinstance(entry, tuple):
        handler = next((part for part in entry if callable(part)), None)

    if handler is not None:
        connection = _StubConnection()
        message = {
            "id": 1,
            "type": "lovelace/dashboards/update",
            "dashboard_id": item_id,
            "title": title,
        }
        try:
            result = handler(hass, connection, message)
            if inspect.isawaitable(result):
                await result
        except Exception:  # noqa: BLE001 - fall through to the registry file
            _LOGGER.debug("lovelace/dashboards/update failed", exc_info=True)
            connection.error = ("unknown_error", "update failed")
        if connection.error is None:
            _LOGGER.info("Renamed the dashboard %s to %s", url_path, title)
            return

    await _async_write_entry_title(hass, url_path, title)


async def _async_has_config(hass: HomeAssistant, dashboard: Any, url_path: str) -> bool:
    """Return whether the dashboard already has a usable config on disk."""
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return False

    key = await _async_item_id(hass, dashboard, url_path)
    try:
        data = await Store(hass, 1, f"lovelace.{key}").async_load()
    except Exception:  # noqa: BLE001 - a missing or corrupt file is "empty"
        return False
    if not isinstance(data, dict):
        return False
    config = data.get("config")
    return isinstance(config, dict) and bool(config.get("views"))


async def _async_write_config(
    hass: HomeAssistant,
    dashboard: Any,
    url_path: str,
    config: dict[str, Any],
) -> bool:
    """Write the config straight into its own ``lovelace.<id>`` store file.

    ``LovelaceConfig.async_save`` is the documented path, but on some releases
    the write never reaches the disk: the storage key is derived from the item
    id, which differs from the url path, and the object handed out right after
    the entry was created still carries the pre-create state.  The dashboard
    then looks fine until the next restart and is empty afterwards.  Writing
    the file Lovelace loads at startup closes that gap.
    """
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return False

    key = await _async_item_id(hass, dashboard, url_path)
    store = Store(hass, 1, f"lovelace.{key}")
    try:
        existing = await store.async_load()
        if isinstance(existing, dict) and existing.get("config") == config:
            return True
        await store.async_save({"config": config})
    except Exception:  # noqa: BLE001
        _LOGGER.warning("Unable to write lovelace.%s", key, exc_info=True)
        return False
    _LOGGER.debug("Wrote lovelace.%s", key)
    return True


async def _async_read_config(
    hass: HomeAssistant, dashboard: Any, url_path: str
) -> dict[str, Any] | None:
    """Return the config Lovelace will load for this dashboard, or None."""
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return None

    key = await _async_item_id(hass, dashboard, url_path)
    try:
        data = await Store(hass, 1, f"lovelace.{key}").async_load()
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(data, dict):
        return None
    config = data.get("config")
    return config if isinstance(config, dict) else None


def _config_hash(config: dict[str, Any] | None) -> str:
    """Fingerprint a dashboard config, independent of key order.

    Recorded with every dashboard this module writes, so the meta file says
    which build produced the one on disk.  It is **not** what decides an
    upgrade: a re-serialised file, a reordered key or a changed colour would
    all look like a hand edit through a hash (see
    ``_template_owns_layout``).
    """
    blob = json.dumps(config if isinstance(config, dict) else {}, sort_keys=True,
                      separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _known_hashes(record: dict[str, Any]) -> list[str]:
    """Every hash this integration is known to have written for a device.

    Kept as a short history next to the record: it answers "did an older build
    of this module write this?" when someone debugs a dashboard, and it is what
    the bounded ``config_hashes`` list in the meta file is for.
    """
    hashes: list[str] = []
    listed = record.get("config_hashes")
    if isinstance(listed, list):
        hashes = [h for h in listed if isinstance(h, str) and h]
    latest = record.get("config_hash")
    if isinstance(latest, str) and latest and latest not in hashes:
        hashes.append(latest)
    return hashes


async def _async_meta(hass: HomeAssistant) -> dict[str, Any]:
    """Load the per-device template bookkeeping."""
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return {}
    try:
        data = await Store(hass, 1, _META_KEY).async_load()
    except Exception:  # noqa: BLE001
        return {}
    if not isinstance(data, dict):
        return {}
    entries = data.get("entries")
    return entries if isinstance(entries, dict) else {}


async def _async_record_template(
    hass: HomeAssistant,
    dev_id: str,
    config: dict[str, Any],
    *,
    auto_update: bool = True,
) -> None:
    """Remember which template produced this dashboard."""
    try:
        from homeassistant.helpers.storage import Store  # noqa: PLC0415
    except ImportError:  # pragma: no cover
        return

    entries = await _async_meta(hass)
    new_hash = _config_hash(config)
    previous = entries.get(dev_id) if isinstance(entries.get(dev_id), dict) else {}
    history = _known_hashes(previous)
    if new_hash in history:
        history.remove(new_hash)
    history.append(new_hash)
    entries[dev_id] = {
        "template_version": TEMPLATE_VERSION,
        "config_hash": new_hash,
        # Bounded: a keep-forever list would grow on every template bump and
        # nothing needs more than the last handful of generations.
        "config_hashes": history[-8:],
        "auto_update": auto_update,
    }
    try:
        await Store(hass, 1, _META_KEY).async_save({"entries": entries})
    except Exception:  # noqa: BLE001 - bookkeeping must never break setup
        _LOGGER.debug("Unable to save the dashboard template meta", exc_info=True)


def _layout_kinds(config: Any) -> set[str]:
    """Every view path and card type one dashboard contains.

    This is the question an upgrade has to answer: *could the bundled template
    have produced this layout?*  Card **types**, not values - a template release
    adds or removes cards, while recolouring a curve or pointing a gauge at
    another entity does not make the dashboard someone else's work.
    """
    kinds: set[str] = set()
    if not isinstance(config, dict):
        return kinds
    stack: list[Any] = []
    for view in config.get("views") or []:
        if not isinstance(view, dict):
            continue
        kinds.add(f"view:{view.get('path') or ''}")
        for key in ("cards", "sections"):
            body = view.get(key)
            if isinstance(body, list):
                stack.extend(body)
    while stack:
        card = stack.pop()
        if not isinstance(card, dict):
            continue
        kinds.add(str(card.get("type") or "?"))
        nested = card.get("cards")
        if isinstance(nested, list):
            stack.extend(nested)
    return kinds


def _template_owns_layout(stored: Any, expected: dict[str, Any]) -> bool:
    """Return True when the stored dashboard draws nothing the template does not.

    The template only ever adds or removes **its own** cards, so a stored layout
    whose views and card types are a subset of what the current template
    generates is an older generation of it.  Anything extra - an extra tab, a
    hand-added card, or a card this release removed - means the user has made the
    dashboard their own, and it is left alone.
    """
    return _layout_kinds(stored) <= _layout_kinds(expected)


async def async_upgrade_dashboard_template(
    hass: HomeAssistant, dev_id: str
) -> str | None:
    """Bring a generated dashboard up to the bundled template.

    The dashboard this integration writes is a **template**, not a document: it
    is regenerated when ``TEMPLATE_VERSION`` moves on, so every device keeps the
    layout the release ships and a new card reaches dashboards that already
    exist.  The decision is structural:

    * the stored layout contains only views and card types the template
      generates -> it is an older generation of it, so rebuild it when the
      version moved on;
    * the stored layout contains something the template never generates -> the
      user has made it their own, so it is left alone and recorded as opted out.

    Comparing *structure* instead of the serialised bytes is what makes that
    work.  A Lovelace round-trip, a reordered key or a changed colour used to
    look exactly like a hand edit, and one false positive opted a dashboard out
    of every later upgrade for good - which is how a device kept a template from
    two releases ago while its neighbours moved on.
    """
    url_path = dashboard_url_path(dev_id)
    dashboards = _dashboards(hass) or {}
    dashboard = dashboards.get(url_path)
    if dashboard is None:
        return None

    stored = await _async_read_config(hass, dashboard, url_path)
    if not isinstance(stored, dict) or not stored.get("views"):
        return None  # the empty case is handled by the create path

    expected = build_dashboard_config(dev_id, model=_model_of(hass, dev_id))
    meta = await _async_meta(hass)
    record = meta.get(dev_id) if isinstance(meta.get(dev_id), dict) else None

    if not _template_owns_layout(stored, expected):
        # A tab or a card the template never draws: the user built this page.
        if record is None:
            await _async_record_template(hass, dev_id, stored, auto_update=False)
        elif record.get("auto_update") is not False:
            meta[dev_id] = {**record, "auto_update": False}
            try:
                from homeassistant.helpers.storage import Store  # noqa: PLC0415

                await Store(hass, 1, _META_KEY).async_save({"entries": meta})
            except Exception:  # noqa: BLE001
                _LOGGER.debug("Unable to record the edit for %s", url_path, exc_info=True)
        _LOGGER.debug("Dashboard %s was customised, leaving it alone", url_path)
        return None

    if record is None:
        # Generated before this module kept bookkeeping.  The layout is ours, so
        # adopt it; identical content means nothing to do, different content
        # means it came from an older template.
        if stored == expected:
            await _async_record_template(hass, dev_id, stored)
            return None
        _LOGGER.info(
            "Dashboard %s was built by an older template, rebuilding it with v%s",
            url_path,
            TEMPLATE_VERSION,
        )
        return await async_create_device_dashboard(hass, dev_id, overwrite=True)

    version = record.get("template_version")
    version_ok = isinstance(version, int) and version >= TEMPLATE_VERSION
    if version_ok and record.get("config_hash") == _config_hash(expected):
        return None

    if version_ok:
        # Same template generation, different content: a **fact the template is
        # built from** changed.  The product model is the usual one - it arrives
        # from the firmware's discovery payload a moment after setup, and it
        # decides whether this unit has PV curves at all.  The dashboard would
        # otherwise keep whatever was generated while the model was still null.
        _LOGGER.info(
            "Dashboard %s no longer matches what the template generates "
            "(device model or capabilities changed), rebuilding it",
            url_path,
        )
    else:
        _LOGGER.info(
            "Dashboard %s still uses template v%s, rebuilding it with v%s",
            url_path,
            version,
            TEMPLATE_VERSION,
        )
    return await async_create_device_dashboard(hass, dev_id, overwrite=True)


def _device_allows_system_view(hass: HomeAssistant, dev_id: str) -> bool:
    """Whether this unit may keep the System view, per the role it reports.

    Looked up through ``hass.data`` rather than by importing the coordinator:
    ``coordinator.py`` imports this module, so the dependency has to stay one
    way.  ``True`` when nothing is known (no entry, still loading, role not
    reported yet) - not knowing the role must never hide the page.
    """
    try:
        for entry in hass.data.get(DOMAIN, {}).values():
            if not isinstance(entry, dict) or entry.get("dev_id") != dev_id:
                continue
            coordinator = entry.get("coordinator")
            keep = getattr(coordinator, "system_view_keep", None)
            if isinstance(keep, bool):
                return keep
    except Exception:  # noqa: BLE001 - a tab must never break setup
        _LOGGER.debug("Unable to read the role of %s", dev_id, exc_info=True)
    return True


async def async_create_device_dashboard(
    hass: HomeAssistant,
    dev_id: str,
    *,
    overwrite: bool = False,
) -> str:
    """Create the dashboard for ``dev_id`` and return what was done.

    ``overwrite=False`` leaves an existing dashboard untouched, so a user's own
    edits survive every restart.  Passing ``overwrite=True`` (the service, the
    options flow) rebuilds the bundled layout from scratch.
    """
    url_path = dashboard_url_path(dev_id)
    title = dashboard_title(dev_id)

    dashboards = _dashboards(hass)
    if dashboards is None:
        _LOGGER.warning(
            "Lovelace is not set up, skipping the dashboard for %s", dev_id
        )
        return RESULT_UNAVAILABLE

    # Rename before the "already exists" shortcut below: an existing dashboard
    # is returned early, and a release that titled it after the bare digits
    # would otherwise keep that name forever.  Best effort - a sidebar label
    # must never break a setup.
    try:
        await _async_rename_entry(hass, url_path, title)
    except Exception:  # noqa: BLE001
        _LOGGER.debug("Unable to rename %s", url_path, exc_info=True)

    existed = url_path in dashboards
    current = dashboards.get(url_path) if existed else None

    # A dashboard entry can exist and still be empty: the sidebar item is
    # created first, and the config write is a separate step that may not have
    # happened (an interrupted setup, or an entry made before this integration
    # wrote a dashboard at all).  Treating that as "exists" left the user with a
    # blank page and no way to tell why, so an empty config is filled in.
    if existed and not overwrite:
        if await _async_has_config(hass, current, url_path):
            return RESULT_EXISTS
        _LOGGER.info(
            "Dashboard %s exists but has no config, writing the bundled layout",
            url_path,
        )

    if not await _async_ensure_entry(hass, url_path, title):
        return RESULT_UNAVAILABLE

    dashboard = (_dashboards(hass) or {}).get(url_path)
    if dashboard is None:
        # The registry has the item but this release did not hand out a config
        # object for it.  The file below is what Lovelace reads at startup, so
        # writing it still leaves a working dashboard instead of a blank page.
        _LOGGER.debug(
            "Dashboard %s has no config object, writing the file directly", url_path
        )

    config = build_dashboard_config(dev_id, model=_model_of(hass, dev_id))
    # A **slave** has no system level readings of its own, so the bundled
    # System view is written out without it.  Doing it here covers every caller
    # (setup, the `create_dashboard` service, the options flow and a template
    # rebuild), which is what a hard-coded `keep=True` after the write got wrong.
    if not _device_allows_system_view(hass, dev_id):
        config = {
            **config,
            "views": [
                view
                for view in config.get("views", [])
                if not (isinstance(view, dict)
                        and view.get("path") == SYSTEM_VIEW_PATH)
            ],
        }
    if dashboard is not None:
        try:
            await dashboard.async_save(config)
        except Exception:  # noqa: BLE001 - e.g. a YAML mode dashboard
            _LOGGER.warning(
                "Lovelace rejected the dashboard %s", url_path, exc_info=True
            )

    if not await _async_write_config(hass, dashboard, url_path, config):
        return RESULT_UNAVAILABLE

    # ``async_save`` updates the in-memory copy only when it got that far, and a
    # freshly created storage dashboard starts out with nothing loaded.  A
    # ``force=True`` load re-reads the file written above, so the copy the
    # frontend is served matches the disk from the very first request.  Without
    # this, a dashboard created while Home Assistant is running could show the
    # \"add card\" placeholder until the next restart, even though the config was
    # already on disk.
    if dashboard is not None:
        try:
            await dashboard.async_load(force=True)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - the file is the source of truth
            _LOGGER.debug("Unable to reload %s after writing", url_path, exc_info=True)

    # Record what was generated, so a later template change can tell an untouched
    # dashboard from one the user has made their own.
    await _async_record_template(hass, dev_id, config, auto_update=True)

    _LOGGER.info(
        "%s dashboard %s for %s",
        "Updated" if existed else "Created",
        url_path,
        dev_id,
    )
    return RESULT_UPDATED if existed else RESULT_CREATED


def device_dashboard_exists(hass: HomeAssistant, dev_id: str) -> bool:
    """Return whether the device already has a dashboard."""
    dashboards = _dashboards(hass) or {}
    return dashboard_url_path(dev_id) in dashboards


# ---------------------------------------------------------------------------
# Slave units have no System view
# ---------------------------------------------------------------------------
def _is_role_condition(visible: Any) -> bool:
    """Is this the ``visible`` list an older template used to hide the tab?

    v14/v15 emitted exactly one ``state`` condition on the role sensor.  It has
    to be recognised to be removed: the condition is **always false** for a unit
    that has not reported its role yet, so leaving one behind keeps the tab
    hidden forever.
    """
    if not isinstance(visible, list) or len(visible) != 1:
        return False
    condition = visible[0]
    if not isinstance(condition, dict) or condition.get("condition") != "state":
        return False
    return str(condition.get("entity") or "").endswith("_device_role")


async def async_set_system_view(
    hass: HomeAssistant, dev_id: str, keep: bool
) -> bool:
    """Add or remove the System view, following the role the unit reports.

    ``keep`` is ``role != "slave"``.  The decision is made here, in Python,
    rather than by a Lovelace ``visible`` condition, because such a condition
    cannot express "not a slave" once the state is `unknown` or `unavailable`:
    the frontend refuses to evaluate a state condition for those, so the tab
    disappears on every unit that never publishes `role` (older firmware) or is
    simply offline.  That turned a "hide it on slaves" request into "hide it
    everywhere".

    Three things happen on every setup, in this order:

    1. a leftover condition from v14/v15 is stripped - always, even on a
       dashboard the user has customised, because it is a bug this integration
       put there;
    2. the System view is removed when the unit is a slave;
    3. when it is not a slave and the view is missing, the bundled one is put
       back in front.

    Steps 2 and 3 are skipped for a dashboard the user has made their own
    (``auto_update: false``), with one exception: if the unit is a slave, the
    removal still happens, because that page would only show dashes.

    Returns whether the stored config was rewritten.
    """
    url_path = dashboard_url_path(dev_id)
    dashboard = (_dashboards(hass) or {}).get(url_path)
    if dashboard is None:
        return False

    stored = await _async_read_config(hass, dashboard, url_path)
    if not isinstance(stored, dict) or not isinstance(stored.get("views"), list):
        return False
    views: list[Any] = stored["views"]

    meta = await _async_meta(hass)
    record = meta.get(dev_id) if isinstance(meta.get(dev_id), dict) else None
    customised = bool(record and record.get("auto_update") is False)

    template_view = build_dashboard_config(
        dev_id, model=_model_of(hass, dev_id)
    )["views"][0]
    index = next(
        (
            i
            for i, view in enumerate(views)
            if isinstance(view, dict) and view.get("path") == SYSTEM_VIEW_PATH
        ),
        None,
    )
    changed = False

    # 1. Drop the stale condition (v14/v15), whatever the role is.
    if index is not None:
        view = views[index]
        if _is_role_condition(view.get("visible")):
            view.pop("visible", None)
            changed = True
            _LOGGER.info(
                "Removed the always-false Slave condition from the System view of %s",
                url_path,
            )

    if keep:
        # 3. Put the view back.  Only when it is missing, so a user who reordered
        #    their tabs keeps that order.
        if index is None and not customised:
            views.insert(0, template_view)
            changed = True
            _LOGGER.info("Restored the System view on %s", url_path)
    elif index is not None:
        # 2. Remove it - but only when the view is still the bundled one.  A view
        #    the user has added cards to is their work, and stripping it would
        #    lose it for good.
        ours = _template_owns_layout(
            {"views": [views[index]]}, {"views": [template_view]}
        )
        if ours:
            views.pop(index)
            changed = True
            _LOGGER.info("Removed the System view from %s (the unit is a slave)", url_path)
        else:
            _LOGGER.debug(
                "System view of %s was customised, leaving it in place", url_path
            )

    if not changed:
        return False

    try:
        await dashboard.async_save(stored)
    except Exception:  # noqa: BLE001 - e.g. a YAML mode dashboard
        _LOGGER.warning("Lovelace rejected the dashboard %s", url_path, exc_info=True)
        return False
    if not await _async_write_config(hass, dashboard, url_path, stored):
        return False
    try:
        await dashboard.async_load(force=True)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - the file is the source of truth
        _LOGGER.debug("Unable to reload %s after the view change", url_path, exc_info=True)

    # Keep the recorded fingerprint in step with what is on disk, otherwise the
    # next template bump would read the file as a hand edit.
    await _async_record_template(
        hass, dev_id, stored, auto_update=not customised
    )
    return True


__all__ = [
    "RESULT_CREATED",
    "RESULT_EXISTS",
    "RESULT_UNAVAILABLE",
    "RESULT_UPDATED",
    "SYSTEM_VIEW_PATH",
    "TEMPLATE_VERSION",
    "async_create_device_dashboard",
    "async_set_system_view",
    "async_upgrade_dashboard_template",
    "build_dashboard_config",
    "dashboard_title",
    "dashboard_url_path",
    "device_dashboard_exists",
    "serial_of",
]
