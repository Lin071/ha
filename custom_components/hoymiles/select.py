"""Select entities for the Hoymiles Micro Storage integration.

V0.6.4 describes the fan and the heater with a ``meta`` topic that lists the
control items the unit actually has (protocol §37 / §39).  Their mode is an
enum, and the option list is part of that description - it is not a constant in
this integration, because the firmware is the only thing that knows which modes
a given model supports.

So each select is created **when its meta topic arrives**, and its option list is
read from the same payload.  That also keeps the entities off a unit that has no
fan or heater at all, instead of offering a control that silently does nothing.

The current value is read from the state event (§32) rather than remembered
locally, so a mode changed by another client or by the device itself shows up
here as well.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from homeassistant.components.select import SelectEntity, SelectEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    DOMAIN,
    FAN_MODES,
    HEAT_MODES,
    MANUFACTURER,
    SRC_FAN_META,
    SRC_HEAT_META,
)
from .coordinator import HoymilesCoordinator


@dataclass(frozen=True)
class HoymilesSelectDescription(SelectEntityDescription):
    """Select description bound to one ``controls`` entry of a meta group."""

    # Which ``meta`` source announces this control.
    meta_source: str = ""
    # Which ``controls`` entry of that payload it is.
    control: str = ""
    # Fallback options when the payload omits them.
    fallback_options: tuple[str, ...] = ()
    # Reads the mode the device reports from the state event.
    value_fn: Callable[[HoymilesCoordinator], str | None] | None = None


def _fan_mode(coordinator: HoymilesCoordinator) -> str | None:
    value = coordinator.event_value("fan_mode")
    return value if isinstance(value, str) else None


def _heat_mode(coordinator: HoymilesCoordinator) -> str | None:
    heat = coordinator.event_value("heat")
    if not isinstance(heat, dict):
        return None
    value = heat.get("mode")
    return value if isinstance(value, str) else None


SELECT_DESCRIPTIONS: tuple[HoymilesSelectDescription, ...] = (
    HoymilesSelectDescription(
        key="fan_mode",
        name="Fan Mode",
        meta_source=SRC_FAN_META,
        control="mode",
        fallback_options=FAN_MODES,
        value_fn=_fan_mode,
        icon="mdi:fan",
    ),
    HoymilesSelectDescription(
        key="heat_mode",
        name="Heating Mode",
        meta_source=SRC_HEAT_META,
        control="mode",
        fallback_options=HEAT_MODES,
        value_fn=_heat_mode,
        icon="mdi:radiator",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create a select as soon as its group description arrives."""
    coordinator: HoymilesCoordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    dev_id: str = hass.data[DOMAIN][entry.entry_id]["dev_id"]

    added: set[str] = set()

    def _sync() -> None:
        pending = [
            description
            for description in SELECT_DESCRIPTIONS
            if description.key not in added
            and coordinator.data.get(description.meta_source) is not None
        ]
        if not pending:
            return
        for description in pending:
            added.add(description.key)
        async_add_entities(
            [HoymilesSelect(coordinator, dev_id, description) for description in pending]
        )

    entry.async_on_unload(coordinator.async_add_listener(_sync))
    _sync()


class HoymilesSelect(CoordinatorEntity[HoymilesCoordinator], SelectEntity):
    """One enum control of a meta-described group."""

    _attr_has_entity_name = True
    entity_description: HoymilesSelectDescription

    def __init__(
        self,
        coordinator: HoymilesCoordinator,
        dev_id: str,
        description: HoymilesSelectDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._dev_id = dev_id
        self._attr_unique_id = f"{DOMAIN}_{dev_id}_{description.key}"
        self._attr_name = description.name
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, dev_id)},
            name=dev_id,
            manufacturer=MANUFACTURER,
        )

    @property
    def available(self) -> bool:
        return self.coordinator.available

    @property
    def options(self) -> list[str]:
        """The options the **device** declared for this control.

        ``controls.mode.options`` is authoritative; the fallback only covers a
        payload that omits it, so the entity never ends up with an empty list
        (Home Assistant refuses to render a select without options).
        """
        control = self.coordinator.group_control(
            self.entity_description.meta_source, self.entity_description.control
        )
        options = control.get("options") if control else None
        if isinstance(options, list) and options:
            return [str(option) for option in options]
        return list(self.entity_description.fallback_options)

    @property
    def current_option(self) -> str | None:
        value_fn = self.entity_description.value_fn
        return value_fn(self.coordinator) if value_fn else None

    async def async_select_option(self, option: str) -> None:
        """Write only the mode; §38 / §40 keep the rest of the group as it is."""
        if option not in self.options:
            return
        if self.entity_description.key == "fan_mode":
            await self.coordinator.async_set_fan(mode=option)
        else:
            await self.coordinator.async_set_heat(mode=option)
