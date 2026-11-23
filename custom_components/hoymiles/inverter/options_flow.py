"""Options flow for a micro inverter: optional Device-view curves and a restart.

The storage family keeps its own wizard (``custom_components/hoymiles/
options_flow.py``) because it edits a TOU plan and the EMS mode.  A micro
inverter implements neither, so this module only offers what the hardware
actually has.  ``const.device_family`` in the parent package decides which of
the two wizards a config entry gets.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import OptionsFlow
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.selector import (
    BooleanSelector,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from . import mqtt_util, region
from .const import CONF_DEV_ID, CONF_REGION, REGION_CHOICES, T_REBOOT, is_inverter_dev_id

_LOGGER = logging.getLogger(__name__)


class HoymilesOptionsFlow(OptionsFlow):
    """Configure wizard for a HiFlow micro inverter."""

    @property
    def _dev_id(self) -> str:
        return str(self.config_entry.data[CONF_DEV_ID])

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Show the menu.

        A micro inverter has no TOU plan and no EMS mode, so the wizard only
        offers what the hardware actually implements: the optional curves of its
        Device view and a restart.
        """
        return self.async_show_menu(
            step_id="init",
            menu_options=[
                "region",
                "charts",
                "reboot",
            ],
        )

    async def async_step_region(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Choose the time zone this device's day is measured in.

        Same option the toolbar switch writes, offered here as well because a
        wizard is the discoverable place for it and because the toolbar is not
        present on every dashboard.  ``custom_value`` is deliberate: the list is
        a shortlist of common markets, not an enumeration of the tz database, and
        a unit installed somewhere else must still be settable.
        """
        if user_input is not None:
            raw = user_input.get(CONF_REGION)
            wanted = raw.strip() if isinstance(raw, str) else ""
            if wanted and region.resolve(wanted) is None:
                return self.async_show_form(
                    step_id="region",
                    data_schema=self._region_schema(wanted),
                    errors={CONF_REGION: "invalid_region"},
                )

            entry = self.config_entry
            if region.zone_name(entry) != wanted:
                self.hass.config_entries.async_update_entry(
                    entry, options={**entry.options, CONF_REGION: wanted}
                )
                _LOGGER.info(
                    "Hoymiles %s: region changed to %s (options flow)",
                    self._dev_id,
                    wanted or "Home Assistant",
                )

            # The day may already have turned over in the new zone and the
            # midnight timer was armed for the old one.
            coordinator = self.hass.data.get("hoymiles", {}).get(entry.entry_id, {})
            if isinstance(coordinator, dict):
                coord = coordinator.get("coordinator")
                if coord is not None and hasattr(coord, "async_apply_region"):
                    await coord.async_apply_region()
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="region",
            data_schema=self._region_schema(region.zone_name(self.config_entry)),
        )

    def _region_schema(self, current: str) -> vol.Schema:
        """The dropdown, with "follow Home Assistant" as the first choice."""
        options = [SelectOptionDict(value="", label="* 跟随 Home Assistant")]
        options.extend(
            SelectOptionDict(value=value, label=f"{label_en} / {label_zh}")
            for value, label_en, label_zh in REGION_CHOICES
        )
        # A stored zone outside the shortlist must still show up as the selected
        # value, otherwise opening the wizard would silently rewrite it to "".
        if current and all(opt["value"] != current for opt in options):
            options.append(SelectOptionDict(value=current, label=current))
        return vol.Schema(
            {
                vol.Optional(CONF_REGION, default=current): SelectSelector(
                    SelectSelectorConfig(
                        options=options,
                        mode=SelectSelectorMode.DROPDOWN,
                        custom_value=True,
                    )
                )
            }
        )

    async def async_step_charts(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Tick the extra Device-view curves the user wants to keep.

        The device page has drawn a fixed set of curves since the first release;
        ``device/state`` carries more readings than that, so each of the
        remaining ones can be added as a card of its own.  The dashboard is the
        source of truth - the checkboxes are preselected from the cards already
        stored, and a card that stays enabled keeps the instant it was enabled
        (see ``lovelace.OPTIONAL_CHARTS``), which is what makes its curve start
        at that moment instead of at the device's whole recorded history.
        """
        from . import lovelace  # noqa: PLC0415

        dev_id = self._dev_id
        if not is_inverter_dev_id(dev_id):
            # These are the ``grid_on_*`` readings of a micro inverter, and the
            # only layout they belong on is its Device view.
            return self.async_abort(reason="charts_unsupported")

        if user_input is not None:
            wanted = {
                key: bool(user_input.get(key)) for key in lovelace.OPTIONAL_CHARTS
            }
            if not await lovelace.async_set_optional_charts(self.hass, dev_id, wanted):
                return self.async_abort(reason="charts_not_saved")
            return self.async_create_entry(title="", data={})

        current = await lovelace.async_get_optional_charts(self.hass, dev_id)
        schema: dict[Any, Any] = {}
        for key in lovelace.OPTIONAL_CHARTS:
            schema[vol.Optional(key, default=key in current)] = BooleanSelector()
        return self.async_show_form(step_id="charts", data_schema=vol.Schema(schema))

    async def async_step_reboot(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Send ``RESTART`` to the unit; the firmware publishes no ack."""
        if user_input is not None:
            await mqtt_util.async_publish(
                self.hass, mqtt_util.topic(T_REBOOT, self._dev_id), "RESTART"
            )
            return self.async_create_entry(title="", data={})

        return self.async_show_form(
            step_id="reboot",
            data_schema=vol.Schema({vol.Required("confirm", default=False): cv.boolean}),
        )
