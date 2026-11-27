"""Adapt the firmware's MQTT discovery payloads to Home Assistant's schemas.

The firmware registers a handful of entities itself through MQTT discovery
(see 《禾迈微储MQTT协议开发指南》§1, §3, §5, §6, §8).  Some of those payloads do
not satisfy Home Assistant's per-domain schema, or they miss keys that are
needed for a good user experience (statistics, availability, ...).

Changing a payload normally means re-flashing the device, but discovery is
nothing more than a **retained payload on a topic**.  The integration therefore
patches the payload in place: it subscribes to the discovery topics of its own
device, rewrites the JSON when something is off and republishes it with
``retain=True``.

Every patch is **idempotent and guarded**: a payload that is already compliant is
left untouched and *not* republished.  That makes this layer a no-op as soon as
the firmware itself is fixed, and it can be deleted then.

Patches
-------
``switch/<dev_id>``
    * add ``command_topic`` when it is missing.  Firmware <= 1.3.101 commented
      the key out, which made Home Assistant reject the whole payload with
      ``required key not provided @ data['command_topic']``.
    * remove ``state_topic`` when there is no ``value_template``.  The referenced
      topic (``device/state``) carries a nested JSON document, so the switch
      could never resolve to ``ON``/``OFF`` and its state stayed ``unknown``
      forever.  The entity becomes optimistic, which matches the hardware:
      ``ON`` wakes the device, ``OFF`` puts it to sleep, and there is no
      readable power state to report.
``select/<dev_id>/ems_mode``
    * add ``state_topic`` pointing at an integration owned topic.  The firmware
      select has no state topic at all, so it read ``unknown`` after every Home
      Assistant restart.  ``coordinator.py`` keeps that topic in sync with the
      last commanded value and with the mode the device reports in
      ``system/state``.
``sensor/<dev_id>/soc``, ``sensor/<dev_id>/bat_p``
    * add ``state_class: measurement`` so Home Assistant records long term
      statistics for them.
``number/<dev_id>/phase_output_power``
    * add ``command_template``.  The firmware expects
      ``{"phase_a":..,"phase_b":..,"phase_c":..}``, but a plain ``number``
      entity can only publish the slider value, which made the entity unusable.
      The template wraps the value and applies it to all three phases; per phase
      control is offered by ``number.py`` and ``hoymiles.set_phase_output_power``.
``number/<dev_id>/power_ctrl``, ``number/<dev_id>/output_power``,
``button/<dev_id>/reboot``
    * functionally untouched, only made availability aware.

Stale configs
    * every discovery object listed in
      :data:`const.LEGACY_DISCOVERY_OBJECTS` is **deleted** (empty retained
      payload) instead of patched.  An older firmware shipped a ``text`` entity
      per TOU day (``tou_day1`` .. ``tou_day8``) plus ``tou_week_plan``, using
      ``"mode": "textarea"`` - not a valid Home Assistant ``TextMode``, so the
      config was rejected on every single start.  The current firmware exposes
      the TOU plan through ``sensor/<dev_id>/tou_day_plan/set`` instead, so
      nothing is lost by removing them.

All patched payloads
    * get ``availability_topic`` + ``payload_available`` /
      ``payload_not_available``.  ``coordinator.py`` keeps that topic in sync
      with the data it receives, so the firmware entities turn ``unavailable``
      when the device stops pushing data instead of showing a stale value.
    * **role gated objects** (``FIRMWARE_ROLE_GATED``) get a second availability
      entry pointing at a role topic instead: §7-§12, §15-§26 and §39 are
      主机和单机 (or, for the per-phase ceiling, 仅多相主机).  ``coordinator.py``
      publishes ``offline`` on that topic when the unit reports ``role: slave``,
      which turns the entity unavailable - the only way to disable a discovery
      entity this integration does not own.  Both entries use the list form with
      ``availability_mode: all``, because a scalar ``availability_topic`` cannot
      be combined with the list.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr

from . import mqtt_util
from .const import (
    DISCOVERY_PREFIX,
    DOMAIN,
    EMS_MODES,
    EMS_MODES_LEGACY_SLAVE,
    FIRMWARE_DISCOVERY_TOPICS,
    FIRMWARE_ROLE_GATED,
    LEGACY_DISCOVERY_OBJECTS,
    PAYLOAD_AVAILABLE,
    PAYLOAD_NOT_AVAILABLE,
    ROLE_MASTER_ONLY,
    ROLE_MASTER_SINGLE,
    ROLE_MULTIPHASE_MASTER,
    T_ATTRIBUTES,
    T_AVAILABILITY,
    T_EMS_MODE_STATE,
    T_GROUP_META,
    T_MASTER_AVAILABILITY,
    T_PHASE_AVAILABILITY,
    T_ROLE_AVAILABILITY,
    T_SWITCH_SET,
)

_LOGGER = logging.getLogger(__name__)

# A ``number`` command template that turns the slider value into the JSON object
# the firmware parses in ``HmMqttApplyPhaseOutputPowerPayload``.
PHASE_COMMAND_TEMPLATE = (
    '{"phase_a":{{ value }},"phase_b":{{ value }},"phase_c":{{ value }}}'
)

# A patch returns True when it modified the payload.
PatchFn = Callable[[str, dict[str, Any]], bool]

# ---------------------------------------------------------------------------
# Capability discovery
# ---------------------------------------------------------------------------
# V0.6.2 does not describe the device's feature set anywhere except in the
# discovery configs it publishes: a unit with no battery fan simply never
# publishes ``fan_mode/config``, and one without a PV limit never publishes
# ``pv_power/config``.  Treating the set of config topics that arrived as the
# capability list is therefore exact, and it keeps working for models that do
# not exist yet - unlike a hard-coded model table.
#
# Keys are the discovery object name, e.g. ``fan_mode``.
CapabilityListener = Callable[[frozenset[str]], None]

# Discovery objects whose firmware entity is replaced by integration entities.
#
# V0.6.2 published one config per control, whose command topic took an object:
#   soc_limit/set  -> {"soc_h": 100, "soc_l": 10}
#   fan_speed/set  -> {"pcs": 5, "bat": 5}
# A Home Assistant ``number`` entity can only publish one scalar, so the
# firmware's own entity sent ``100`` / ``5`` and the firmware's JSON parser then
# found no ``soc_h`` / ``pcs`` key and dropped the command.
#
# V0.6.4 removed those topics: the cut-offs are two scalar numbers (§33 - §36),
# and the fan / heater / fine block are described by a ``meta`` topic with one
# ``set`` topic taking an object (§37 - §42).  Any retained config still on the
# broker for the old objects is therefore deleted, and their entities are
# created by number.py / select.py / switch.py instead.
SUPERSEDED_DISCOVERY_OBJECTS: tuple[str, ...] = (
    "number/{dev_id}/soc_limit",
    "number/{dev_id}/fan_speed",
    "select/{dev_id}/fan_mode",
    "number/{dev_id}/heat_power",
    "number/{dev_id}/pv_power",
    # V0.6.5 §11: the virtual meter stopped being a firmware entity.  The unit
    # now describes it with ``homeassistant/<dev_id>/meter_ctrl/meta`` and the
    # integration creates the three numbers itself (``number.py``), because one
    # ``number`` entity could never carry ``power`` *and* the two cumulative
    # energy readings behind one object-taking ``set`` topic.  The retained
    # ``number/<dev_id>/meter_ctrl/config`` from older firmware is deleted, or
    # Home Assistant keeps a dead fifth entity next to the three real ones.
    "number/{dev_id}/meter_ctrl",
    # V0.6.7 §29/§30: the feed-in ceiling stopped being a scalar firmware entity.
    # It is now a ``meta`` group with an ``enable`` switch and a limit behind one
    # object-taking ``set`` topic, so the entities are created by number.py /
    # switch.py.  The old ``number/<dev_id>/feed_power/config`` (whose scalar
    # command the new firmware would parse as a broken object) is deleted.
    "number/{dev_id}/feed_power",
)


def _patch_switch(dev_id: str, payload: dict[str, Any]) -> bool:
    """Fix the ``switch`` discovery payload (P0-1)."""
    changed = False

    if not payload.get("command_topic"):
        payload["command_topic"] = T_SWITCH_SET.format(dev_id=dev_id)
        changed = True

    # Only drop the state topic when the payload cannot extract ON/OFF from it -
    # if the firmware ever ships a proper value_template we keep it.
    if payload.get("state_topic") and not payload.get("value_template"):
        payload.pop("state_topic", None)
        changed = True

    return changed


def _patch_ems_mode(dev_id: str, payload: dict[str, Any]) -> bool:
    """Make the EMS mode select keep its value across restarts (P1-1)."""
    if payload.get("state_topic") or payload.get("value_template"):
        return False

    payload["state_topic"] = T_EMS_MODE_STATE.format(dev_id=dev_id)
    return True


def _patch_measurement(dev_id: str, payload: dict[str, Any]) -> bool:
    """Enable statistics for soc / bat_p (P1-2)."""
    del dev_id
    if payload.get("state_class"):
        return False

    payload["state_class"] = "measurement"
    return True


def _patch_phase_output(dev_id: str, payload: dict[str, Any]) -> bool:
    """Make the firmware's phase output number usable (P0-2)."""
    del dev_id
    if payload.get("command_template"):
        return False

    payload["command_template"] = PHASE_COMMAND_TEMPLATE
    return True


def _patch_plain(dev_id: str, payload: dict[str, Any]) -> bool:
    """No functional change, only availability is added."""
    del dev_id, payload
    return False


def _patch_availability(dev_id: str, payload: dict[str, Any]) -> bool:
    """Add an availability topic driven by the integration (P1-4)."""
    if payload.get("availability_topic") or payload.get("availability"):
        return False

    payload["availability_topic"] = T_AVAILABILITY.format(dev_id=dev_id)
    payload["payload_available"] = PAYLOAD_AVAILABLE
    payload["payload_not_available"] = PAYLOAD_NOT_AVAILABLE
    return True


# Availability entries are matched by topic, so a stale entry with the wrong
# payload strings is still treated as "already there".
def _entry_topic(entry: Any) -> str | None:
    if isinstance(entry, dict):
        topic = entry.get("topic") or entry.get("availability_topic")
        return topic if isinstance(topic, str) else None
    return None


def _role_availability_topics(dev_id: str, scope: str) -> list[tuple[str, str]]:
    """Topics that must be online for a role gated discovery object.

    Each scope has its own topic, published by the coordinator: ``master_only``
    (V0.6.6 §29/§30) is the strictest and excludes a stand-alone unit too, so it
    cannot use the ``role_availability`` topic that means "master or single".
    """
    if scope == ROLE_MULTIPHASE_MASTER:
        return [(T_PHASE_AVAILABILITY.format(dev_id=dev_id), ROLE_MULTIPHASE_MASTER)]
    if scope == ROLE_MASTER_ONLY:
        return [(T_MASTER_AVAILABILITY.format(dev_id=dev_id), ROLE_MASTER_ONLY)]
    return [(T_ROLE_AVAILABILITY.format(dev_id=dev_id), ROLE_MASTER_SINGLE)]


def _patch_role_availability(
    dev_id: str, path: str, payload: dict[str, Any]
) -> bool:
    """Gate a firmware entity on the role the unit reports.

    §7-§12, §15-§26 and §39 are 主机和单机 (or 仅多相主机): a **slave** must not
    be offered them.  The entities live in the firmware's own MQTT discovery
    payloads, which this integration cannot make `available` from Python, but it
    can extend the payload - ``availability`` accepts a list, and the entity is
    unavailable unless **every** entry (``availability_mode: all``) says online.

    The list form cannot be combined with ``availability_topic``, so the scalar
    form ``_patch_availability`` just added is folded into the first entry.
    """
    scope = None
    for template, template_scope in FIRMWARE_ROLE_GATED.items():
        if template.format(dev_id=dev_id) == path:
            scope = template_scope
            break
    if scope is None:
        # Not gated any more (``ems_mode`` moved to option filtering): drop a
        # role entry an earlier build appended, or the entity would stay
        # ``unavailable`` on a slave for ever.
        return _strip_role_availability(dev_id, payload)

    wanted = _role_availability_topics(dev_id, scope)
    offline = PAYLOAD_NOT_AVAILABLE

    entries: list[dict[str, Any]] = []
    entries.extend(
        {
            "topic": topic,
            "payload_available": PAYLOAD_AVAILABLE,
            "payload_not_available": offline,
        }
        for topic, _scope in wanted
    )

    existing = payload.get("availability")
    if isinstance(existing, list) and existing:
        present = {_entry_topic(entry) for entry in existing}
        if all(topic in present for topic, _scope in wanted) and \
                payload.get("availability_mode") == "all":
            return False
        merged = [entry for entry in existing if isinstance(entry, dict)]
        for topic, _scope in wanted:
            if topic not in present:
                merged.append({
                    "topic": topic,
                    "payload_available": PAYLOAD_AVAILABLE,
                    "payload_not_available": offline,
                })
        payload["availability"] = merged
        payload["availability_mode"] = "all"
        payload.pop("availability_topic", None)
        payload.pop("payload_available", None)
        payload.pop("payload_not_available", None)
        return True

    # Scalar form: move it into the list so the role topic can be appended.
    base_topic = payload.get("availability_topic") or T_AVAILABILITY.format(
        dev_id=dev_id
    )
    entries.insert(0, {
        "topic": base_topic,
        "payload_available": payload.get("payload_available") or PAYLOAD_AVAILABLE,
        "payload_not_available": payload.get("payload_not_available") or offline,
    })

    payload["availability"] = entries
    payload["availability_mode"] = "all"
    payload.pop("availability_topic", None)
    payload.pop("payload_available", None)
    payload.pop("payload_not_available", None)
    return True

def _strip_role_availability(dev_id: str, payload: dict[str, Any]) -> bool:
    """Remove the role topics from an ``availability`` list.

    Used when an object stops being role gated (the EMS mode select is now
    filtered by *options* instead of being switched off), so a payload written by
    an earlier build does not keep the entity unavailable on a slave.
    """
    existing = payload.get("availability")
    if not isinstance(existing, list) or not existing:
        return False

    role_topics = {
        T_ROLE_AVAILABILITY.format(dev_id=dev_id),
        T_PHASE_AVAILABILITY.format(dev_id=dev_id),
        T_MASTER_AVAILABILITY.format(dev_id=dev_id),
    }
    kept = [entry for entry in existing if _entry_topic(entry) not in role_topics]
    if len(kept) == len(existing):
        return False

    if kept:
        payload["availability"] = kept
        payload["availability_mode"] = "all"
    else:
        # Everything was ours: fall back to the plain device availability.
        payload["availability"] = [{
            "topic": T_AVAILABILITY.format(dev_id=dev_id),
            "payload_available": PAYLOAD_AVAILABLE,
            "payload_not_available": PAYLOAD_NOT_AVAILABLE,
        }]
        payload["availability_mode"] = "all"
    return True


def _managed_patches(dev_id: str) -> dict[str, PatchFn]:
    """Discovery object paths (``<component>/<node>/<object>``) we manage."""
    return {
        f"switch/{dev_id}": _patch_switch,
        f"select/{dev_id}/ems_mode": _patch_ems_mode,
        f"sensor/{dev_id}/soc": _patch_measurement,
        f"sensor/{dev_id}/bat_p": _patch_measurement,
        f"number/{dev_id}/phase_output_power": _patch_phase_output,
        f"number/{dev_id}/power_ctrl": _patch_plain,
        f"number/{dev_id}/output_power": _patch_plain,
        f"button/{dev_id}/reboot": _patch_plain,
        # V0.6.4 scalar controls.  Their payloads are already correct (scalar,
        # or a state template pointing at the state event), so they only need
        # the availability topic that makes them go unavailable with the device.
        f"number/{dev_id}/soc_h_limit": _patch_plain,
        f"number/{dev_id}/soc_l_limit": _patch_plain,
        f"number/{dev_id}/input_power": _patch_plain,
    }


def _removed_objects(dev_id: str) -> frozenset[str]:
    """Discovery object paths that are stale and must be deleted."""
    stale = list(LEGACY_DISCOVERY_OBJECTS) + list(SUPERSEDED_DISCOVERY_OBJECTS)
    return frozenset(obj.format(dev_id=dev_id) for obj in stale)


def _object_path(topic: str) -> str | None:
    """Return ``<component>/<node>/<object>`` for a discovery topic."""
    prefix = f"{DISCOVERY_PREFIX}/"
    suffix = "/config"
    if not topic.startswith(prefix) or not topic.endswith(suffix):
        return None
    return topic[len(prefix) : -len(suffix)]


class FirmwareDiscoveryPatcher:
    """Keep the device's retained discovery payloads HA compliant.

    Termination relies on every patch being **idempotent**: republishing a
    corrected payload makes the device echo it back to us, the patch functions
    then find nothing left to do and stay silent.

    Deliberately *no* "already published" cache: the firmware republishes its
    own retained config on every MQTT reconnect, which overwrites the corrected
    payload on the broker. Such a cache would then suppress the repair and leave
    the broker parked on the unpatched version.
    """

    def __init__(self, hass: HomeAssistant, dev_id: str) -> None:
        self.hass = hass
        self.dev_id = dev_id
        self._patches = _managed_patches(dev_id)
        self._removed = _removed_objects(dev_id)
        self._unsubs: list[Callable[[], None]] = []
        # Last model captured from the firmware's discovery payload (or a
        # "claim" while it is being applied).  Used to avoid re-applying the
        # same value on every single discovery message.
        self._model: str | None = None
        # Optional discovery objects this device announced, see the note above
        # ``SUPERSEDED_DISCOVERY_OBJECTS``.
        self._capabilities: set[str] = set()
        self._capability_listeners: list[CapabilityListener] = []
        # Bumped every time the device re-announces its role, so a card can tell
        # "still the same list" from "the list was rebuilt just now".
        self._capability_epoch = 0
        # ``True`` once the unit has told us what it can control at all.  Until
        # then an empty set means "not known yet", never "nothing supported".
        self._capability_ready = False
        # The ``supported_topics`` map of the last ``attributes`` payload, used to
        # recognise a role change.  ``None`` before the first one.
        self._attributes: dict[str, Any] | None = None
        # One resubscribe at a time, so a burst of ``attributes`` messages does
        # not restart the discovery watch over and over.
        self._refreshing = False
        # The role the device reports (§32 ``role``), set by the coordinator.
        # ``None`` leaves every role dependent choice wide open, which is the safe
        # direction right after a restart.
        self._role: str | None = None
        # The last payload this class published for each managed topic, so a stale
        # role narrowed EMS option list can be repaired without waiting for the
        # firmware to republish its config.
        self._payloads: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # capabilities
    # ------------------------------------------------------------------
    @property
    def capabilities(self) -> frozenset[str]:
        """Discovery objects this device announced (``fan_mode``, ...)."""
        return frozenset(self._capabilities)

    @property
    def capability_epoch(self) -> int:
        """How often the capability list was rebuilt from scratch."""
        return self._capability_epoch

    @property
    def capability_ready(self) -> bool:
        """Has the unit described itself yet (``attributes`` received)?"""
        return self._capability_ready

    @callback
    def async_add_capability_listener(self, listener: CapabilityListener) -> Callable[[], None]:
        """Call ``listener`` with the full set whenever a new object appears.

        The listener is invoked immediately with what is known so far, so a
        platform that starts after the retained configs have already arrived
        still sees them.
        """
        self._capability_listeners.append(listener)
        listener(frozenset(self._capabilities))

        @callback
        def _remove() -> None:
            if listener in self._capability_listeners:
                self._capability_listeners.remove(listener)

        return _remove

    @callback
    def _record_capability(self, path: str) -> None:
        """Remember one announced discovery object and notify the listeners.

        Deleted (superseded / legacy) objects never reach here, because they are
        handled before the capability bookkeeping.
        """
        parts = path.split("/")
        if len(parts) < 2:
            return
        name = parts[-1]
        if name == self.dev_id:
            # A four level topic (``switch/<dev_id>/config``) carries no object
            # id - the component itself is the feature, and ``switch`` is what
            # the card checks to decide whether the on/off tile exists.
            name = parts[0]
        self._note_capability(name)

    @callback
    def _note_capability(self, name: str) -> None:
        """Add one capability and hand the new snapshot to the listeners."""
        if not name or name in self._capabilities:
            return
        self._capabilities.add(name)
        snapshot = frozenset(self._capabilities)
        for listener in list(self._capability_listeners):
            listener(snapshot)

    @callback
    def _forget_capabilities(self) -> None:
        """Drop everything learned so far and tell the listeners.

        The device re-announces its whole feature set right after a role change,
        and the configs that are still on the broker describe the role it had
        *before* that change.  Without this reset a unit that stopped being a
        master kept its power ceiling card - and the topics behind it no longer
        accept anything.
        """
        self._capability_epoch += 1
        if not self._capabilities:
            return
        self._capabilities.clear()
        empty = frozenset()
        for listener in list(self._capability_listeners):
            listener(empty)

    @callback
    def _on_attributes_message(self, msg: Any) -> None:
        """The unit described itself: a changed list means the role changed.

        Deliberately *not* a reset on every message.  The payload is retained and
        republished periodically, and a unit that keeps the same capabilities
        would otherwise blink its whole Control page on every repeat.  A genuine
        role change alters ``supported_topics``, and that is what is compared.
        """
        text = mqtt_util.payload_to_text(msg.payload)
        if text is None:
            return
        try:
            payload = json.loads(text)
        except (ValueError, TypeError):
            return
        if not isinstance(payload, dict):
            return
        topics = payload.get("supported_topics")
        if not isinstance(topics, dict) or not topics:
            return

        previous = self._attributes
        self._attributes = topics
        self._capability_ready = True
        if previous is not None and set(previous) != set(topics):
            # The ``supported_topics`` map is by itself proof of what exists: it
            # is the firmware's own answer, and it is already ordered correctly
            # for a role, unlike the retained configs the broker replays.
            self._forget_capabilities()
            for name in topics:
                self._note_capability(str(name))
            _LOGGER.debug(
                "Capabilities of %s reset from attributes: %s",
                self.dev_id,
                sorted(self._capabilities),
            )
            # The retained configs on the broker are the *previous* role's, so the
            # list cannot be rebuilt from them without asking for them again.
            # Unsubscribe + subscribe makes the broker replay every retained
            # payload, which is also the moment the patched EMS options and the
            # role narrowed sections get rebuilt.
            self.hass.async_create_task(self._async_refresh_discovery())

    @callback
    def _on_group_meta_message(self, msg: Any) -> None:
        """A ``meta`` group arrived: that group exists on this unit.

        These groups have no discovery config of their own - `number.py` creates
        the entities from the description - so they would otherwise be missing
        from the capability list and every card that depends on them would hide.
        """
        if not msg.payload:
            return
        parts = msg.topic.split("/")
        if len(parts) >= 4:
            self._note_capability(parts[-2])

    async def async_setup(self) -> None:
        """Subscribe to the discovery topics of this device.

        Both the 4 level (``switch``) and the 5 level (``sensor``, ``number``,
        ``select``, ...) discovery topics are watched - missing one of them
        silently leaves that platform unpatched.
        """
        if mqtt_util.mqtt is None:  # pragma: no cover - mqtt is a dependency
            _LOGGER.warning("MQTT integration unavailable, discovery patching disabled")
            return

        for pattern in FIRMWARE_DISCOVERY_TOPICS:
            topic = pattern.format(dev_id=self.dev_id)
            unsub = await mqtt_util.mqtt.async_subscribe(
                self.hass, topic, self._on_discovery_message, 1
            )
            self._unsubs.append(unsub)
            _LOGGER.debug("Watching firmware discovery topics on %s", topic)

        # The unit's own statement of what it can control, and the ``meta``
        # groups that have no discovery config of their own.  Both are retained,
        # so this also works when Home Assistant starts long after the device.
        extra = (
            (T_ATTRIBUTES.format(dev_id=self.dev_id), self._on_attributes_message),
            (T_GROUP_META.format(dev_id=self.dev_id, group="+"), self._on_group_meta_message),
        )
        for topic, handler in extra:
            unsub = await mqtt_util.mqtt.async_subscribe(self.hass, topic, handler, 1)
            self._unsubs.append(unsub)
            _LOGGER.debug("Watching capability topics on %s", topic)

    async def _async_refresh_discovery(self) -> None:
        """Replay every retained payload after the device changed its role."""
        if self._refreshing:
            return
        self._refreshing = True
        try:
            # Slightly later: the firmware sends ``attributes`` first and its
            # configs right after, so resubscribing too early would race its own
            # republish and leave half the list in place.
            await asyncio.sleep(2)
            self.async_shutdown()
            await self.async_setup()
        finally:
            self._refreshing = False

    @callback
    def async_shutdown(self) -> None:
        """Stop watching discovery topics."""
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()

    @callback
    def _on_discovery_message(self, msg: Any) -> None:
        """Rewrite or delete a firmware discovery payload when it is not right."""
        path = _object_path(msg.topic)
        if path is None:
            return

        # An empty payload is how a retained config gets deleted - either by us
        # a moment ago or by somebody else.  Nothing left to do, and skipping
        # early also keeps the echo of our own deletion out of the JSON parser.
        text = mqtt_util.payload_to_text(msg.payload)
        if text is None:
            return

        if path in self._removed:
            # Still recorded: a superseded object (``soc_limit``, ``fan_speed``)
            # proves the device *has* that feature, it just cannot express it
            # through a scalar.  The integration entities are gated on it.
            self._record_capability(path)
            self.hass.async_create_task(self._async_remove(msg.topic))
            return

        # Every config that describes something this device really has is
        # recorded before the payload is parsed - a config we cannot parse is
        # still proof that the feature exists.
        self._record_capability(path)

        patch = self._patches.get(path)
        if patch is None:
            return

        try:
            payload = json.loads(text)
        except (ValueError, TypeError):
            _LOGGER.warning("Ignoring non JSON discovery payload on %s: %s", msg.topic, text)
            return

        if not isinstance(payload, dict):
            return

        # The firmware is the only source of the product model: copy its
        # ``device.model`` onto our own device registry entry.  See
        # _maybe_backfill_model.  This is what makes a new prefix such as
        # ``RMI-1650`` show its real name without any hard-coded list.
        self._maybe_backfill_model(payload)

        # Both patches must run - no short circuit, they touch different keys.
        changed = patch(self.dev_id, payload)
        changed = _patch_availability(self.dev_id, payload) or changed
        # §7-§26: some of these entities only exist for a master or a
        # stand-alone unit.  Adding the role topic as a second availability
        # entry is what turns them off on a slave.
        changed = _patch_role_availability(self.dev_id, path, payload) or changed
        # The EMS picker is not role gated in either direction (§7/§8 are 角色:
        # 不限): this only repairs an option list a previous build narrowed.
        changed = self._apply_role_filters(path, payload) or changed

        # Remember what this build would publish, so a later role change can
        # rewrite the payload without waiting for the firmware to repeat it.
        self._payloads[msg.topic] = dict(payload)

        if not changed:
            # Already compliant, or this is the echo of our own correction.
            return

        rendered = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        self.hass.async_create_task(self._async_republish(msg.topic, rendered))

    # ------------------------------------------------------------------
    # role dependent filtering
    # ------------------------------------------------------------------
    @callback
    def set_role(self, role: str | None) -> None:
        """Re-apply the payload repairs to every payload we already know.

        Called by the coordinator when ``event/state`` reports a new ``role``.
        The only role dependent rewrite left is the repair of a shortened EMS
        option list, and it has to run here as well as on arrival: the retained
        payload may have been stored by an older build before this process
        started, and the firmware will not repeat it until it reconnects.
        """
        if self._role == role:
            return
        self._role = role

        for topic, stored in list(self._payloads.items()):
            path = _object_path(topic)
            if path is None:
                continue
            payload = dict(stored)
            if not self._apply_role_filters(path, payload):
                continue
            self._payloads[topic] = payload
            rendered = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
            self.hass.async_create_task(self._async_republish(topic, rendered))

    def _apply_role_filters(self, path: str, payload: dict[str, Any]) -> bool:
        """Repair a role-narrowed EMS option list an earlier build wrote.

        V0.6.7 §7 publishes ``options`` as a fixed five (角色: 不限), and the
        **role only decides which of them the UI offers** - see
        ``EMS_MODES_BY_ROLE`` (in ``const.py``) and `_emsOptions()` in
        ``hoymiles-control.js``.  The retained payload therefore has to keep all
        five, or a unit that changes role never gets its modes back: the firmware
        only publishes this discovery object on connect.

        A previous build of this integration rewrote the payload to ``general`` /
        ``fine_ctrl`` for a slave **and republished it retained**, which is why
        the shortened list survived even after the firmware announced all five.
        Recognising that exact legacy tuple (``EMS_MODES_LEGACY_SLAVE``) and
        restoring the full list is the way out; every other list is left
        untouched, which keeps a HiFlow system's three-option payload
        (`general` / `tou_plan` / `meter_ctrl`) exactly as the device sent it.
        """
        if path != f"select/{self.dev_id}/ems_mode":
            return False

        options = payload.get("options")
        if not isinstance(options, list) or not options:
            return False

        if tuple(str(option) for option in options) != EMS_MODES_LEGACY_SLAVE:
            return False

        payload["options"] = list(EMS_MODES)
        return True

    @callback
    def _maybe_backfill_model(self, payload: dict[str, Any]) -> None:
        """Copy the firmware-reported model onto our own device registry entry.

        The integration's entities are created with ``model: null`` because the
        product model is only known once the firmware publishes a discovery
        payload (its ``device.model``).  Backfilling it here means any device
        prefix - ``MSA-2800`` / ``MSA-2804`` / ``MSA-2805`` / ``RMI-1650`` and
        future ones - shows its real name without a hard-coded list.
        """
        device = payload.get("device")
        if not isinstance(device, dict):
            return

        model = device.get("model")
        if not isinstance(model, str) or not model.strip():
            return
        model = model.strip()

        # Claim the value up front so several discovery messages arriving back
        # to back do not each spawn an apply task for the same model.
        if self._model == model:
            return
        self._model = model

        self.hass.async_create_task(self._async_apply_model(model))

    async def _async_apply_model(self, model: str) -> None:
        """Apply the captured model, waiting briefly for our device to exist.

        The device registry entry is only created when an entity is first added,
        which happens *after* this patcher subscribes.  A retained discovery
        message can therefore arrive before the entry exists; a short retry loop
        covers that startup race.
        """
        registry = dr.async_get(self.hass)

        for _ in range(10):
            entry = registry.async_get_device(identifiers={(DOMAIN, self.dev_id)})
            if entry is not None:
                if entry.model != model:
                    registry.async_update_device(entry.id, model=model)
                    _LOGGER.info("Set model %r for device %s", model, self.dev_id)
                # The model decides what the dashboard may draw - an AC coupled
                # unit has no PV branch at all - so the generated layout has to
                # be re-checked now that the model is known.  The call is a no-op
                # when the dashboard already matches what the template draws.
                try:
                    from .dashboard import async_upgrade_dashboard_template  # noqa: PLC0415

                    await async_upgrade_dashboard_template(self.hass, self.dev_id)
                except Exception:  # noqa: BLE001 - never break the setup path
                    _LOGGER.debug(
                        "Unable to refresh the dashboard after learning the model",
                        exc_info=True,
                    )
                return
            await asyncio.sleep(1.0)

        # The entry never appeared (integration torn down mid-startup?).  Clear
        # the claim so a later discovery message retries instead of giving up.
        self._model = None
        _LOGGER.debug(
            "Device %s not registered yet, model backfill deferred", self.dev_id
        )

    async def _async_republish(self, topic: str, payload: str) -> None:
        """Publish the corrected payload, retained so it survives HA restarts."""
        try:
            await mqtt_util.async_publish(self.hass, topic, payload, qos=1, retain=True)
        except Exception:  # noqa: BLE001 - never break the entry on a publish error
            _LOGGER.warning("Unable to patch discovery payload on %s", topic, exc_info=True)
            return

        _LOGGER.info("Patched MQTT discovery payload on %s", topic)

    async def _async_remove(self, topic: str) -> None:
        """Delete a stale retained discovery config.

        An empty retained payload is the documented way to remove a discovery
        message from the broker; the topic then simply does not exist any more
        and drops out of the device's discovery topic set.
        """
        try:
            await mqtt_util.async_publish(self.hass, topic, "", qos=1, retain=True)
        except Exception:  # noqa: BLE001 - never break the entry on a publish error
            _LOGGER.warning("Unable to remove stale discovery config on %s", topic, exc_info=True)
            return

        _LOGGER.info("Removed stale MQTT discovery config on %s", topic)


__all__ = [
    "PHASE_COMMAND_TEMPLATE",
    "SUPERSEDED_DISCOVERY_OBJECTS",
    "FirmwareDiscoveryPatcher",
]
