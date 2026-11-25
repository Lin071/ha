"""Server side repeat of the MQTT power setpoint.

Why the timer lives here and not in the card
--------------------------------------------
``power_ctrl`` is a lease, not a setting: the firmware drops it unless the same
value is re-published at least once a minute (protocol §14), and then goes back
to regulating the charge and discharge power on its own.

The bundled card used to own that timer - a ``setTimeout`` inside the web
component.  Every navigation in Lovelace throws the view's elements away, so
``disconnectedCallback()`` cleared the timeout and the setpoint died with the
card, while the switch on screen still said "on".  The same happened whenever
the browser throttled a background tab, which it does to every timer of a page
that is not visible.

Keeping the timer next to the state it protects fixes all of that: it survives
page changes, a closed browser and a sleeping phone, and it is the same for
every client that looks at the dashboard.

Deliberately **not** restored across a Home Assistant restart.  The device does
not keep the setpoint across one either, so resurrecting a stale value would
command hardware the user can no longer see - after a restart the switch reads
"off" and the setpoint has to be sent again on purpose.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable

from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from . import mqtt_util
from .const import DOMAIN, T_POWER_CTRL_SET

_LOGGER = logging.getLogger(__name__)

# Stored in ``hass.data[DOMAIN]`` next to the ``_services_registered`` flags.
DATA_KEY: str = "_power_ctrl_repeat"


@dataclass
class PowerRepeat:
    """One device's re-publish job."""

    dev_id: str
    value: int
    interval: int
    last_sent: datetime
    cancel: Callable[[], None] | None = None


class PowerRepeatManager:
    """One re-publish job per device, keyed by ``dev_id``."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._items: dict[str, PowerRepeat] = {}

    # ------------------------------------------------------------------ query

    def active(self, dev_id: str) -> PowerRepeat | None:
        """The running job for a device, if any."""
        return self._items.get(dev_id)

    def snapshot(self, dev_id: str) -> dict[str, Any]:
        """Everything the card needs to draw the countdown.

        ``next_in`` is computed here rather than in the browser: it is the only
        place that knows when the last publish really happened, and a countdown
        derived from a timestamp the client guesses is exactly how the old
        version ended up saying "next in 0 s" while nothing was running.
        """
        item = self._items.get(dev_id)
        if item is None:
            return {"active": False, "dev_id": dev_id}
        due = item.last_sent + timedelta(seconds=item.interval)
        remaining = (due - dt_util.utcnow()).total_seconds()
        return {
            "active": True,
            "dev_id": dev_id,
            "value": item.value,
            "interval": item.interval,
            "next_in": max(0, int(remaining + 0.999)),
            "last_sent": item.last_sent.isoformat(),
        }

    # ------------------------------------------------------------------ write

    async def async_start(self, dev_id: str, value: int, interval: int) -> None:
        """Start (or restart) the repeat, publishing ``value`` once right away."""
        await self.async_stop(dev_id)

        item = PowerRepeat(
            dev_id=dev_id,
            value=value,
            interval=interval,
            last_sent=dt_util.utcnow(),
        )
        self._items[dev_id] = item

        # Send before arming: a user pressing Send expects the value on the
        # broker now, not one interval from now.
        await self._async_publish(item)

        async def _tick(_now: datetime) -> None:
            await self._async_tick(item)

        item.cancel = async_track_time_interval(
            self.hass, _tick, timedelta(seconds=interval)
        )
        _LOGGER.debug(
            "power_ctrl %s W for %s will be re-published every %s s",
            value,
            dev_id,
            interval,
        )

    async def async_stop(self, dev_id: str) -> bool:
        """Cancel the job for one device; returns whether one was running."""
        item = self._items.pop(dev_id, None)
        if item is None:
            return False
        if item.cancel is not None:
            item.cancel()
            item.cancel = None
        _LOGGER.debug("power_ctrl repeat for %s stopped", dev_id)
        return True

    async def async_stop_all(self) -> None:
        """Cancel every job (integration unload)."""
        for dev_id in list(self._items):
            await self.async_stop(dev_id)

    # ---------------------------------------------------------------- private

    async def _async_tick(self, item: PowerRepeat) -> None:
        # The entry may have been replaced by a newer start already; publishing
        # a superseded value would fight the job that replaced it.
        if self._items.get(item.dev_id) is not item:
            return
        await self._async_publish(item)

    async def _async_publish(self, item: PowerRepeat) -> None:
        try:
            await mqtt_util.async_publish(
                self.hass,
                mqtt_util.topic(T_POWER_CTRL_SET, item.dev_id),
                str(item.value),
            )
        except Exception:  # noqa: BLE001 - a failed tick must not kill the job
            # Keep the job alive: the next tick retries. `last_sent` is left
            # alone so the countdown shows the value as overdue instead of
            # pretending it went out.
            _LOGGER.warning(
                "Could not publish power_ctrl %s W for %s",
                item.value,
                item.dev_id,
                exc_info=True,
            )
            return
        item.last_sent = dt_util.utcnow()


def get_manager(hass: HomeAssistant) -> PowerRepeatManager:
    """Return the manager for this Home Assistant instance, creating it once."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    manager = domain_data.get(DATA_KEY)
    if not isinstance(manager, PowerRepeatManager):
        manager = PowerRepeatManager(hass)
        domain_data[DATA_KEY] = manager
    return manager


# ---------------------------------------------------------------------------
# Generic lease repeats: `meter_ctrl` and `fine_ctrl`
# ---------------------------------------------------------------------------
# `power_ctrl` is not the only field the firmware treats as a lease.  §42's fine
# control block and §12's virtual meter behave the same way: stop
# refreshing them and the device drops back to self-consumption, which looks
# exactly like "the automation stopped working" from the outside.
#
# The difference from `power_ctrl` is the *shape* of the payload: `meter_ctrl`
# is one bare number, while `fine_ctrl` is an object whose fields are written by
# different rows of the card.  So this manager keeps the last object it sent and
# **merges** a new field into it before re-publishing - otherwise the row that
# just moved would silently wipe the fields the other rows had set.

TOPIC_REPEAT_KEY: str = "_topic_repeat"


@dataclass
class TopicRepeat:
    """One device's re-publish job for a non-`power_ctrl` lease."""

    dev_id: str
    kind: str
    topic: str
    payload: Any                    # dict -> JSON, anything else -> str()
    interval: int
    last_sent: datetime | None = None
    cancel: Callable[[], None] | None = None


class TopicRepeatManager:
    """Re-publish jobs keyed by ``(dev_id, kind)``."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._items: dict[tuple[str, str], TopicRepeat] = {}

    # ------------------------------------------------------------------ query

    def active(self, dev_id: str, kind: str) -> TopicRepeat | None:
        return self._items.get((dev_id, kind))

    def snapshot(self, dev_id: str, kind: str) -> dict[str, Any]:
        """The job's state, in the same shape the power_ctrl card already reads."""
        item = self._items.get((dev_id, kind))
        if item is None:
            return {"active": False, "dev_id": dev_id, "kind": kind}
        next_in = 0
        if item.last_sent is not None:
            due = item.last_sent + timedelta(seconds=item.interval)
            next_in = max(0, int((due - dt_util.utcnow()).total_seconds() + 0.999))
        return {
            "active": True,
            "dev_id": dev_id,
            "kind": kind,
            "payload": item.payload,
            "interval": item.interval,
            "next_in": next_in,
            "last_sent": item.last_sent.isoformat() if item.last_sent else None,
        }

    # ------------------------------------------------------------------ write

    async def async_set(
        self,
        dev_id: str,
        kind: str,
        topic: str,
        fields: Any,
        interval: int,
    ) -> dict[str, Any]:
        """Arm (or re-arm) the repeat and publish the merged payload once now.

        ``fields`` is merged into whatever the job already holds, so a card row
        can send only the field it changed (§42 allows a partial write) and the
        repeat still carries the complete object.
        """
        item = self._items.get((dev_id, kind))
        if item is not None and item.topic == topic and isinstance(item.payload, dict) \
                and isinstance(fields, dict):
            payload: Any = {**item.payload, **fields}
        else:
            payload = dict(fields) if isinstance(fields, dict) else fields

        await self.async_stop(dev_id, kind)
        job = TopicRepeat(
            dev_id=dev_id,
            kind=kind,
            topic=topic,
            payload=payload,
            interval=interval,
        )
        self._items[(dev_id, kind)] = job

        # Publish before arming: pressing Send means "send it now".
        await self._async_publish(job)

        async def _tick(_now: datetime) -> None:
            await self._async_tick(job)

        job.cancel = async_track_time_interval(
            self.hass, _tick, timedelta(seconds=interval)
        )
        _LOGGER.debug(
            "%s for %s will be re-published every %s s", kind, dev_id, interval
        )
        return self.snapshot(dev_id, kind)

    async def async_stop(self, dev_id: str, kind: str | None = None) -> bool:
        """Cancel one job, or every job of a device when ``kind`` is None."""
        kinds = [kind] if kind else [k for (d, k) in self._items if d == dev_id]
        stopped = False
        for name in kinds:
            item = self._items.pop((dev_id, name), None)
            if item is None:
                continue
            if item.cancel is not None:
                item.cancel()
                item.cancel = None
            stopped = True
            _LOGGER.debug("%s repeat for %s stopped", name, dev_id)
        return stopped

    async def async_stop_all(self) -> None:
        for (dev_id, kind) in list(self._items):
            await self.async_stop(dev_id, kind)

    # ---------------------------------------------------------------- private

    async def _async_tick(self, item: TopicRepeat) -> None:
        if self._items.get((item.dev_id, item.kind)) is not item:
            return
        await self._async_publish(item)

    async def _async_publish(self, item: TopicRepeat) -> None:
        payload = item.payload
        text = json.dumps(payload) if isinstance(payload, dict) else str(payload)
        try:
            await mqtt_util.async_publish(self.hass, item.topic, text)
        except Exception:  # noqa: BLE001 - a failed tick must not kill the job
            _LOGGER.warning(
                "Could not publish %s for %s", item.kind, item.dev_id, exc_info=True
            )
            return
        item.last_sent = dt_util.utcnow()


def get_topic_manager(hass: HomeAssistant) -> TopicRepeatManager:
    """Return the generic repeat manager, creating it once."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    manager = domain_data.get(TOPIC_REPEAT_KEY)
    if not isinstance(manager, TopicRepeatManager):
        manager = TopicRepeatManager(hass)
        domain_data[TOPIC_REPEAT_KEY] = manager
    return manager
