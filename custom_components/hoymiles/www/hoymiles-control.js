/* ============================================================================
 * Hoymiles Micro Storage — Control panel card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-control`
 *
 * Every command from《禾迈微储与微逆MQTT协议开发指南》V0.6.5, as buttons /
 * inputs:
 *
 *   §4  switch      homeassistant/switch/<dev_id>/set                 ON | OFF
 *   §6  reboot      homeassistant/button/<dev_id>/reboot/trigger      RESTART
 *   §8  ems mode    homeassistant/select/<dev_id>/ems_mode/command    general |
 *                                                                     mqtt_ctrl |
 *                                                                     fine_ctrl |
 *                                                                     tou_plan |
 *                                                                     meter_ctrl
 *   §10 power ctrl  homeassistant/number/<dev_id>/power_ctrl/set      float (W)
 *   §11 meter meta  homeassistant/<dev_id>/meter_ctrl/meta            object (group)
 *   §12 meter ctrl  homeassistant/number/<dev_id>/meter_ctrl/set
 *                   {"power":..,"eng_out":..,"eng_in":..}   (partial allowed)
 *   §22 output pwr  homeassistant/number/<dev_id>/output_power/set    int (W)
 *   §24 phase pwr   homeassistant/number/<dev_id>/phase_output_power/set
 *                   {"phase_a":..,"phase_b":..,"phase_c":..}
 *   §19 tou get     homeassistant/sensor/<dev_id>/tou_plan/get        {"week":..}
 *   §28 soc_h       homeassistant/number/<dev_id>/soc_h_limit/set     scalar (%)
 *   §30 soc_l       homeassistant/number/<dev_id>/soc_l_limit/set     scalar (%)
 *   §32 fan         homeassistant/<dev_id>/fan/set
 *                   {"mode":..,"target":{"pcs":..,"bat":..}}  (partial allowed)
 *   §34 heat        homeassistant/<dev_id>/heat/set
 *                   {"mode":..,"param":..,"pack_ids":[..]}     (partial allowed)
 *   §42 fine ctrl   homeassistant/<dev_id>/fine_ctrl/set
 *                   {"grid_p":..,"pv_power":..,"chg_off":..,"dchg_off":..,
 *                    "eps_relay":"close"}
 *   §44 input power homeassistant/number/<dev_id>/input_power/set     int (W)
 *
 * V0.6.4 replaced the per-control topics with grouped ``set`` topics that take
 * an object and may be written partially. That is why the fan, heater and fine
 * control rows publish objects instead of single numbers: the device keeps
 * whatever a message leaves out.
 *
 * The fan / heater / fine rows appear only on a device that advertises them in
 * its ``meta`` topic - the protocol gives them to different model ranges, and a
 * row that cannot work is worse than no row.
 *
 * Commands are published straight to those topics (qos 1, retain false), which
 * keeps the card working even when a discovery entity is missing or has a
 * narrower option list than the protocol allows. Current values are read back
 * from the matching entities when they exist.
 *
 * Card config:
 *   type: custom:hoymiles-control
 *   dev_id: MSA-280520260806
 *   title: Device control
 *   show_phase: true            # optional, default true
 *   show_power_ctrl: true       # optional, default true
 *   show_topics: true           # optional, default false; show the MQTT topic
 *                               # of every row (engineering detail)
 *   subtitle: false             # optional; hide the grey line under the title
 *
 * The layout follows the iOS settings idiom: small grey section headers, one
 * rounded group per section, rows of icon + name + right-aligned control, and
 * hairline separators that stop short of the card edge. The MQTT topic paths
 * are hidden by default - they are useful while debugging but noisy in use.
 *
 * The MQTT log used to live here; it is now its own card,
 * `custom:hoymiles-diagnostics`, which can be added to any dashboard by hand.
 * The generated dashboard no longer gives it a page of its own: a whole tab
 * holding one usually-off card read as an empty page in the sidebar.
 * ========================================================================== */

function _hmControlRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Language
   *
   * Three languages: English, Simplified Chinese and German.
   *
   * Resolution order, first hit wins:
   *   1. `language:` on the card - an explicit choice, and what an older
   *      dashboard may already carry;
   *   2. the Home Assistant user's language, so the cards follow the UI like
   *      every built-in one does;
   *   3. English.
   *
   * `zh-Hans` / `zh-Hant` / `zh-CN` all collapse to `zh`: the wording is the
   * same in either script, and the card has no Traditional translation to
   * offer.  `de-AT` / `de-CH` collapse to `de` for the same reason.
   * ------------------------------------------------------------------ */
  /* German wording, keyed by the English string.

     Keyed by English on purpose: the call sites pass English and Chinese
     only, so they needed no third argument when German was added, and a
     missing entry falls back to English instead of leaving a blank. */
  const T_DE = {
    "No Home Assistant connection.": "Keine Verbindung zu Home Assistant.",
    "The command failed.": "Der Befehl ist fehlgeschlagen.",
    "Yes": "Ja",
    "Cancel": "Abbrechen",
    "Publish the command to the broker": "Befehl an den Broker senden",
    "Wait for the device to confirm the new state": "Warten, bis das Gerät den neuen Zustand bestätigt",
    "The device does not report this state back": "Das Gerät meldet diesen Zustand nicht zurück",
    "Command sent.": "Befehl gesendet.",
    "It may still be switching - check the card again in a few seconds.": "Es schaltet eventuell noch um – schau in ein paar Sekunden noch einmal nach.",
    "The device confirmed the new state.": "Das Gerät hat den neuen Zustand bestätigt.",
    "EMS mode": "EMS-Modus",
    "Wait for the device to switch": "Warten, bis das Gerät umschaltet",
    "Invalid value": "Ungültiger Wert",
    "Target power": "Zielleistung",
    "Turn the timer off?": "Timer ausschalten?",
    "the charge and discharge power on its own within about 60 seconds.": "die Lade- und Entladeleistung innerhalb von etwa 60 Sekunden selbst.",
    "Turn it off": "Ausschalten",
    "Keep it on": "Eingeschaltet lassen",
    "Max output": "Max. Ausgabe",
    "Output power limit": "Ausgangsleistungsgrenze",
    "Input power limit": "Eingangsleistungsgrenze",
    "Per-phase output power limit": "Grenze je Phase (Ausgang)",
    "Heating control": "Heizungssteuerung",
    "not reported": "nicht gemeldet",
    "Power controls": "Leistungsgrenzen",
    "Per-phase limit": "Grenze je Phase",
    "Reboot the device now?": "Gerät jetzt neu starten?",
    "Reboot": "Neustart",
    "Publish the reboot trigger": "Neustart auslösen",
    "Wait for the device to come back": "Warten, bis das Gerät wieder da ist",
    "The device is publishing again": "Das Gerät meldet sich wieder",
    "The device has restarted": "Das Gerät wurde neu gestartet",
    "This unit reports no fast readings to watch": "Dieses Gerät liefert keine schnellen Messwerte zum Beobachten",
    "The trigger was sent. This card cannot tell when the device is back - reload in a minute to check.": "Der Auslöser wurde gesendet. Die Karte kann nicht erkennen, wann das Gerät zurück ist – lade die Seite in einer Minute neu.",
    "No gap in the data was seen": "Es war keine Unterbrechung der Daten zu sehen",
    "The trigger was sent but no interruption was seen. If the device is still answering, the restart may already be over - check the Device page.": "Der Auslöser wurde gesendet, aber es war keine Unterbrechung zu sehen. Wenn das Gerät noch antwortet, ist der Neustart vielleicht schon vorbei – prüfe die Geräteseite.",
    "The device did not come back": "Das Gerät ist nicht zurückgekommen",
    "The device stopped publishing but never came back. Check that it is powered on.": "Das Gerät hat aufgehört zu senden und ist nicht zurückgekommen. Prüfe die Stromversorgung.",
    "Power": "Leistung",
    "Temperature": "Temperatur",
    "Target packs": "Zielmodule",
    "Heating is off": "Die Heizung ist aus",
    "Heating is off. Pick Power to send a wattage, or Temperature to heat the packs up to a target.": "Die Heizung ist aus. Wähle „Leistung“ für eine Wattzahl oder „Temperatur“, um die Module auf eine Zieltemperatur zu heizen.",
    "Keep at least one pack selected": "Mindestens ein Modul ausgewählt lassen",
    "all packs": "alle Module",
    "packs": "Module",
    "plan to follow a schedule.": "Plan nach Zeitprogramm.",
    "below change with the selected mode.": "unten ändern sich mit dem gewählten Modus.",
    "Please wait…": "Bitte warten…",
    "Close": "Schließen",
    "Awake - normal operation": "Wach – Normalbetrieb",
    "Asleep - press Awake to resume": "Schlafmodus – zum Fortsetzen „Wach“ drücken",
    "Sleep": "Schlafen",
    "Awake": "Wach",
    "Asleep": "Schlafmodus",
    "Not available while an on-grid micro inverter is present.": "Nicht verfügbar, solange ein netzgeführter Mikro-Wechselrichter vorhanden ist.",
    "+ discharge, − charge": "+ Entladen, − Laden",
    "switch EMS to mqtt_ctrl first": "zuerst EMS auf mqtt_ctrl stellen",
    "Send": "Senden",
    "Every": "Alle",
    "s": "s",
    "Send all": "Alle senden",
    "Takes about a minute": "Dauert etwa eine Minute",
    "Open the off-grid relay?": "Off-Grid-Relais \u00f6ffnen?",
    ["Once opened, the relay stays locked for a while before it accepts "
      + "`close` again: about 10 minutes the first time, and 10 minutes "
      + "longer each further time (20, 30\u2026). The off-grid port has no "
      + "output during that wait."]:
      "Nach dem \u00d6ffnen bleibt das Relais eine Weile gesperrt, bevor es "
      + "`close` wieder annimmt: beim ersten Mal etwa 10 Minuten, und jedes "
      + "weitere Mal 10 Minuten l\u00e4nger (20, 30\u2026). Der Inselausgang "
      + "hat in dieser Zeit keine Ausgabe.",
    "Got it": "Verstanden",
    "Cancelled - the relay stays closed.": "Abgebrochen - das Relais bleibt geschlossen.",
    ["The relay is now locked - it will accept close again in about "
      + "10 minutes at the earliest."]:
      "Das Relais ist jetzt gesperrt und nimmt fr\u00fchestens in etwa "
      + "10 Minuten wieder `close` an.",
  };

  /** Map any Home Assistant language tag to one of the three card languages. */
  function hmNormalise(value) {
    const raw = String(value == null ? "" : value).toLowerCase();
    if (raw.startsWith("zh")) return "zh";
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("en")) return "en";
    return "";
  }

  /* ------------------------------------------------------------------ *
   * The language the user picked
   *
   * The choice belongs to the viewer, not to the dashboard: it lives in one
   * localStorage key and is announced with one window event, so the dropdown
   * on any card switches every card on the page at once, and the choice
   * survives a reload.
   *
   * The order is: the reader's own pick, then `language:` on the card, then the
   * Home Assistant UI language, then English.  Following the UI language is
   * what makes an unconfigured card match the page it sits on - the earlier
   * "English unless picked" rule left the cards as the only English thing on a
   * Chinese dashboard.
   * ------------------------------------------------------------------ */
  const LANG_KEY = "hoymiles.language";
  const LANG_EVENT = "hoymiles-language";
  const LANG_CHOICES = [["en", "English"], ["zh", "\u4e2d\u6587"], ["de", "Deutsch"]];

  /** The stored choice, or "" when nothing has been picked (or no storage). */
  function hmStored() {
    try {
      return hmNormalise(window.localStorage.getItem(LANG_KEY));
    } catch (err) {
      return ""; // private mode / storage disabled: fall back to the default
    }
  }

  /** Remember a choice and tell every card about it. */
  function hmSetLang(value) {
    const lang = hmNormalise(value) || "en";
    try {
      window.localStorage.setItem(LANG_KEY, lang);
    } catch (err) {
      /* nothing to remember it with; the event still switches this page */
    }
    window.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: lang }));
  }

  function hmLang(hass, config) {
    const locale = hass && hass.locale;
    const ui = (locale && locale.language) || (hass && hass.language);
    return hmStored()
      || hmNormalise(config && config.language)
      || hmNormalise(ui)
      || "en";
  }

  /**
   * One of the three wordings.
   *
   * German comes from the card's own dictionary, keyed by the English string -
   * that is why `_t()` call sites did not have to change when the third
   * language was added.  A missing entry falls back to English, so an
   * untranslated string shows English rather than nothing.
   */
  function hmPick(lang, en, zh) {
    if (lang === "zh") return zh;
    if (lang === "de") {
      const de = T_DE[en];
      return de == null ? en : de;
    }
    return en;
  }

  /* (hmLang defined above, with the dictionary.) */

  /* ------------------------------------------------------------------ *
   * Localised config strings
   *
   * A config value may be a plain string (used as-is, so every existing
   * dashboard keeps working) or a language map:
   *
   *   title:
   *     en: Device control
   *     zh: 设备控制
   *
   * That is what lets the text *you* write follow the language the reader
   * picked, instead of pinning a dashboard to one language. A map missing the current language
   * falls back to `en`, then to whichever entry exists.
   * ------------------------------------------------------------------ */
  function hmText(value, lang) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const hit = value[lang];
      if (hit != null) return hit;
      if (value.en != null) return value.en;
      const first = Object.values(value)[0];
      return first == null ? "" : first;
    }
    return value;
  }

  /** A text field can only hold a plain string, so a language map shows empty. */
  function hmField(value) {
    return typeof value === "string" ? value : "";
  }

  const EMS_MODES = [
    { id: "general", en: "General", zh: "自发自用" },
    { id: "mqtt_ctrl", en: "MQTT ctrl", zh: "MQTT 功率控制" },
    { id: "fine_ctrl", en: "Fine ctrl", zh: "精准控制" },
    { id: "tou_plan", en: "TOU plan", zh: "分时计划" },
    { id: "meter_ctrl", en: "Meter ctrl", zh: "虚拟电表" },
  ];

  /* What a **slave** may select (§7/§8 with the system level modes belonging to
     the master): its own regulation, and the device level precise control block
     whose topics §13/§14 mark as 角色: 不限.  `mqtt_ctrl`, `tou_plan` and
     `meter_ctrl` write system level setpoints, so a slave is never offered them. */
  const EMS_MODES_SLAVE = ["general", "fine_ctrl"];
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  /* Protocol V0.6.2 §35: how the two fans are driven. `disable` stops them, and
     `manual` is the only mode where `fan_speed` has any effect - the speed row
     only exists in that mode instead of being sent to a firmware that ignores it.
     Listed from the most common state to the one that needs the most attention:
     off, then the firmware-managed auto, then manual with its speed levels.

     The first position is labelled 关闭 / Off, not 停转 / Stop: it is the same
     three-way choice the heater card above uses, and "stop" reads like a button
     that stops the fans once, while this is a mode the unit stays in. */
  const FAN_MODES = [
    { id: "disable", en: "Off", zh: "关闭" },
    { id: "auto", en: "Auto", zh: "自动" },
    { id: "manual", en: "Manual", zh: "手动" },
  ];

  /* What an unreported mode is displayed as. Explicit, not "the last entry",
     so reordering the picker cannot silently change the default state. */
  const FAN_MODE_UNKNOWN = "disable";

  /* §39: the heater's single ``param`` means watts in ``power`` mode and degrees
     in ``temp`` mode, so the mode is a real choice and not a label.  The third
     position is ``disable`` (the heater off).  Ordered like the fan picker, off
     first: that is the state a unit normally sits in, and the two working modes
     only matter once it is switched on. */
  const HEAT_MODES = [
    { id: "disable", label: "Off", zh: "关闭" },
    { id: "power", label: "Power", zh: "功率" },
    { id: "temp", label: "Temperature", zh: "温度" },
  ];
  /* What an unreported heater mode is displayed as. Kept as ``power`` rather
     than ``disable`` so a unit that has not published its mode yet still shows
     its setpoint instead of claiming the heater is off. */
  const HEAT_MODE_OFF = "disable";

  /* Ranges from the protocol, used when the entity that would report them is
     missing (an older firmware has no such entity at all). */
  const FAN_SPEED = { lo: 0, hi: 10 };
  const HEAT_POWER = { lo: 20, hi: 175 };  // §39: mode=power, watts
  const HEAT_TEMP = { lo: 10, hi: 25 };    // §39: mode=temp, °C
  const HEAT_PACK_MAX = 4;                 // §39: ``pack_ids`` covers packs 1..4
  const PV_POWER = { lo: 0, hi: 2500 };    // §13 controls.pv_power (V0.6.6)
  const GRID_POWER = { lo: -2500, hi: 2500 }; // §13 controls.grid_p (V0.6.6)
  /* §11: the fallback band of the virtual meter power.  The entity's own
     `min`/`max` win when it exists: since V0.6.5 the device states the band in
     ``meter_ctrl/meta`` and the number entity republishes it as an attribute,
     so the slider follows the unit instead of a constant. */
  const METER_CTRL = { lo: -5000, hi: 5000 };
  /* §11: the two cumulative readings are Wh, 0 .. 4294967295 (a uint32), one
     watt-hour per step - the same band the meta topic declares. */
  const METER_ENERGY = { lo: 0, hi: 4294967295 };
  /* How often the virtual meter's telemetry (write counter + newest object) is
     re-read while `meter_ctrl` is on screen.  An external controller typically
     posts every few seconds, so a one second poll keeps the counter and the
     three read-outs within a second of what was written. */
  const VM_POLL_MS = 1000;
  /* §44: the range is [100, 2500] - there is no 0 W. Unlike the output ceiling,
     `input_power` cannot forbid input outright, so the row must not advertise
     "0 = off"; §43 publishes exactly this min/max in the config payload. */
  const INPUT_POWER = { lo: 100, hi: 2500 };

  /* §29/§30: the feed-in ceiling.  Unlike `input_power` the 0 end is meaningful
     - 0 forbids exporting to the grid.  V0.6.7 turned the topic into a group
     (an `enable` switch + this limit behind one object) that only a **master**
     publishes, so `_allowMasterOnly()` still decides whether the group is drawn. */
  const FEED_POWER = { lo: 0, hi: 2500 };

  /* V0.6.7 §29/§30 and §31/§32: the two groups that gained an `enable` switch.
     The switch writes ONLY that field - both topics accept a partial object, so
     toggling it must not rewrite the limits, and editing a limit must not turn
     the feature back on.

     While the switch is off the group's sliders are **not drawn at all**: the
     numbers do nothing until the device enforces them, so showing them invited
     edits that could not take effect.  `offEn` / `offZh` is the sentence the
     collapsed row says instead, and the switch itself sits at the end of the
     row's label line, beside the range text (`_enableSwitch` + `.r-end`). */
  const FEED_ENABLE = {
    key: "feed_power_enable",
    icon: "gridTower",
    en: "Feed-in enable", zh: "馈网使能",
    offEn: "Feed-in is off - switch it on to set a limit.",
    offZh: "馈网未使能——开启后才能设置限值。",
    topic: "number/<dev_id>/feed_power/set",
    field: "enable",
  };
  const HOUSE_ENABLE = {
    key: "house_input_enable",
    icon: "houseLimit",
    en: "House input limit enable", zh: "入户限值使能",
    offEn: "The house input limit is off - switch it on to set the three limits.",
    offZh: "入户限值未使能——开启后才能设置三相限值。",
    topic: "number/<dev_id>/phase_house_in_power/set",
    field: "enable",
  };

  /* §23/§24, §27/§28 and §31/§32: three groups that all send **all three phases
     in one object**, each with three number entities.  One renderer serves all
     three, so only the entity keys, the set topic, the draft field and the
     wording differ.  V0.6.6 added the last two. */
  const PHASE_LIMITS = [
    {
      id: "output",
      keys: ["phase_a_output_power", "phase_b_output_power", "phase_c_output_power"],
      topic: "number/<dev_id>/phase_output_power/set",
      draft: "_phase",
      icon: "phaseLimit",
      en: "Per-phase output power limit",
      zh: "分相输出功率上限",
    },
    {
      id: "input",
      /* The entity ids are slugified from the *names* this integration gives
         them ("Phase A Input Limit" -> `phase_a_input_limit`), not from the
         protocol key (`phase_a_input_power`).  Matching the protocol spelling
         found nothing and silently hid the whole row. */
      keys: ["phase_a_input_limit", "phase_b_input_limit", "phase_c_input_limit"],
      topic: "number/<dev_id>/phase_input_power/set",
      draft: "_phaseInput",
      icon: "phaseInput",
      en: "Per-phase input limit",
      zh: "分相输入功率上限",
    },
    {
      id: "house",
      /* "House A Input Limit" -> `house_a_input_limit`, same story. */
      keys: ["house_a_input_limit", "house_b_input_limit", "house_c_input_limit"],
      topic: "number/<dev_id>/phase_house_in_power/set",
      draft: "_phaseHouse",
      icon: "houseLimit",
      en: "Per-phase house input limit",
      zh: "分相入户功率上限",
    },
  ];
  const PHASE_BAND = { lo: 100, hi: 2500 };

  /* The two cut-offs are NOT the same band, and they are not the entity's band
   * either.
   *
   * Keeping the battery between these two numbers is what the whole setting is
   * for: charging stops at `soc_h`, discharging stops at `soc_l`. A charge
   * cut-off below 50 % would advertise a battery that never gets meaningfully
   * full, and a discharge cut-off above 70 % would run it down to a level the
   * cells do not like.
   *
   * Both handles live on ONE track (10..100 %), discharge on the left and charge
   * on the right, so "charge stops above discharge" is true by construction
   * instead of being checked after the fact. The two still may not meet: a gap of
   * `SOC_MIN_GAP` points is kept so a cycle always has room to work with, which
   * is also why the left handle stops ten points before the right one instead of
   * passing it.
   */
  const SOC_DISCHARGE = { lo: 10, hi: 70 };
  const SOC_CHARGE = { lo: 50, hi: 100 };
  const SOC_MIN_GAP = 10;

  /* Order in which the firmware publishes its `number` discovery configs. HA
   * decorates the duplicate entity ids with `_2`, `_3`, ... so this order is
   * what maps `number.<dev>_2` back to `output_power`. */
  const NUMBER_ORDER = ["power_ctrl", "output_power", "phase_output_power"];

  /* Domains where the firmware publishes exactly one entity, so "the only one on
   * this device" is a sound answer. The number domain is excluded on purpose:
   * it has several entities and a wrong pick would show - and send - the value
   * of a different setting. */
  const SINGLE_ENTITY_DOMAINS = ["select", "switch"];

  /* Explicit name hints, tried before the "only entity of this domain" guess.
   *
   * `select` used to hold exactly one entity per device (the EMS mode), so the
   * guess was all that was needed.  V0.6.2 adds `fan_mode` to the same domain,
   * which makes the guess ambiguous - and picking the wrong one would put the
   * fan options in the EMS picker.  Matching is normalised ("MQTT Select" ->
   * "mqttselect"), so a fragment is enough. */
  const RESOLVE_HINTS = {
    select: {
      ems_mode: ["mqtt", "ems"],
      fan_mode: ["fan"],
    },
  };

  /* Protocol key -> the entity-id tails it can appear as.
   *
   * The protocol key is what the MQTT topic uses (`heat_power`), while the
   * entity id is slugified from the friendly **name** ("Heating Power" ->
   * `heating_power`, "Charge Cut-off SOC" -> `charge_cut_off_soc`). They are
   * not always the same word, and a plain "ends with the key" match silently
   * missed those rows. Listing the known spellings keeps this deterministic -
   * a "does the name contain these words" guess would happily pick a
   * neighbour's entity. */
  const ENTITY_ALIASES = {
    // The protocol name comes first: it is what the firmware's own discovery
    // entities use, and the legacy spelling only exists for a dashboard that
    // still points at the integration's old entity.
    charge_soc_limit: ["charge_soc_limit", "charge_cut_off_soc"],
    discharge_soc_limit: ["discharge_soc_limit", "discharge_cut_off_soc"],
    heat_param: ["heating_setpoint", "heat_param"],
    heat_mode: ["heating_mode", "heat_mode"],
    input_power: ["input_power_limit", "input_power"],
    /* V0.6.6 §29/§30: the firmware's discovery name is "Feed Power Limit", so
       the entity id ends in `feed_power_limit`, not `feed_power`. */
    feed_power: ["feed_power_limit", "feed_power"],
    /* V0.6.7 §29/§30 and §31/§32: the two group enable switches the integration
       creates from the meta payloads. */
    feed_power_enable: ["feed_power_enable"],
    house_input_enable: ["house_input_enable", "phase_house_in_enable"],
    /* The power switch: "Power" on the current firmware (`<dev>_power`), "MQTT
       Switch" on older ones. Without the alias the resolver found four switch
       entities on a master (power + the three fine-control ones), refused to
       guess, and the row fell back to "asleep" no matter what the device said. */
    mqtt_switch: ["mqtt_switch", "power"],
    pv_power_limit: ["pv_power_limit"],
    fine_grid_power: ["grid_power_setpoint", "fine_grid_power"],
    pcs_fan_speed: ["pcs_fan_speed"],
    battery_fan_speed: ["battery_fan_speed"],
    fan_mode: ["fan_mode"],
    ems_mode: ["mqtt_select", "ems_mode"],
    charge_forbid: ["charge_forbidden"],
    discharge_forbid: ["discharge_forbidden"],
    eps_relay: ["off_grid_relay", "eps_relay"],
  };

  const PING_MS = 8000; // how long the "sent" confirmation stays visible

  /* How long a command may hold the progress dialog before it is treated as
     dead. A publish either answers or rejects in well under a second, so an
     action still "running" after a few seconds is a stuck one - and it must not
     be allowed to swallow every later click in silence. The sleep / reboot
     commands are the exception: they legitimately wait for the device, so they
     are started with `longRun` and get their own, much larger limit. */
  const STALE_ACTION_MS = 8000;
  const LONG_ACTION_MS = 120000;

  /* Bounds of the repeat-interval input, in seconds. The firmware's power
     control has to be refreshed at least once a minute, so anything slower is
     allowed but 1 s is the floor - faster would flood both the broker and the
     device's command queue. */
  const REPEAT_MIN_S = 1;
  const REPEAT_MAX_S = 3600;
  const REPEAT_DEFAULT_S = 30;

  /* How long the top banner stays.  Long enough to be read while looking at the
     rows it talks about, short enough that it never becomes furniture. */
  const BANNER_MS = 12000;

  /* How often an open card re-reads the server state while nothing is running.
     The repeat lives in the integration, so another browser (or an automation)
     may have started one; a slow poll keeps the row from lying about it. */
  const REPEAT_IDLE_POLL_S = 30;

  /* The other two leases. `power_ctrl` (§14) is not the only field the firmware
     drops without a refresh: the fine control object (§42) and the virtual meter
     setpoint (§12) behave the same way, so both are re-published by the same
     server-side machinery - see `power_repeat.TopicRepeatManager`.
     `field` is the service name stem; `topic` is only used for the "timer off"
     path, where the card publishes straight to the broker like it used to. */
  const LEASES = {
    meter_ctrl: {
      set: "set_meter_ctrl",
      stop: "stop_meter_ctrl",
      get: "get_meter_ctrl",
      topic: "number/<dev_id>/meter_ctrl/set",
      en: "Meter setpoint",
      zh: "虚拟电表",
    },
    fine_ctrl: {
      set: "set_fine_ctrl",
      stop: "stop_fine_ctrl",
      get: "get_fine_ctrl",
      topic: "<dev_id>/fine_ctrl/set",
      en: "Fine control",
      zh: "精细控制",
    },
  };

  /* Power on/off is slow: the firmware has to bring the PCS (and the packs)
     down or up again, so the card shows the requested state as pending until
     the device reports it (or gives up after this long). */
  const SWITCH_PENDING_MS = 5000;
  const SWITCH_CONFIRM_MS = 2500; // how long the tick after confirmation stays

  /* How long a command may take to come back from the device before the
     progress dialog reports it as failed. The firmware is not chatty: mode
     changes in particular can take several seconds. */
  const SWITCH_CONFIRM_TIMEOUT_MS = 15000;
  /* The unit does not apply an EMS mode change on the spot: it takes the new
     mode on its next control cycle and only then publishes the state event, and
     the measured delay runs up to about 100 s. A 20 s window made a working
     command look broken, so the card no longer blocks on it - it shows the
     requested mode as pending for this long and reconciles it from the state
     event when it finally arrives. */
  const EMS_CONFIRM_TIMEOUT_MS = 150000;

  /* Reboot.

     The rule is the user's: **the first message that arrives after the restart
     proves the unit is back, and one minute is the longest the card waits.**
     So it records the newest message timestamp before publishing and resolves as
     soon as that timestamp moves - no two-phase "wait for silence, then wait for
     it to resume", and no 4.5-minute ceiling.

     Two details make that reliable:

     * the timestamp is the one the *backend* keeps: the coordinator stamps
       every message it parses. The entities cannot carry it, because Home
       Assistant drops a state update that repeats the value it already has, so
       a unit that comes back reporting the same 0 W it went away with leaves
       `hass.states` untouched - which is exactly how a successful restart ended
       up as an error. The entity stamps are only a fallback for a backend that
       does not answer the question.
     * the first few seconds are ignored: a message that was already in flight
       when the trigger went out is not evidence that the unit rebooted. */
  const REBOOT_TIMEOUT_MS = 60000;  // the whole wait, start to finish
  const REBOOT_GRACE_MS = 6000;     // pushes still in flight are not "it is back"
  const REBOOT_POLL_MS = 3000;      // how often the backend is asked

  /* The entities the firmware pushes every second.  The newest `last_updated`
     among them is the card's heartbeat while it waits for a reboot; `[key,
     domain]`, resolved like every other entity here. */
  const REBOOT_HEARTBEAT = [
    ["system_grid_power", "sensor"],
    ["system_load_power", "sensor"],
    ["system_battery_power", "sensor"],
    ["system_pv_power", "sensor"],
    ["pv_power", "sensor"],
    ["soc", "sensor"],
  ];

  /* The icon set, as finished SVG markup.

     Lit cannot build these: a `<path>` written inside `${...}` is parsed in the
     HTML namespace and never paints. Injecting a complete SVG string with
     `_untrusted()` goes through the HTML parser instead, which does handle SVG
     foreign content - so gradients, fills and multi-colour shapes all work.

     Each entry receives a unique id prefix `u`, because several cards can be on
     the page at once and two gradients sharing an id would clash.

     The colours are the card's own vocabulary, so an icon says what the control
     beside it says: orange / green / blue are the three EMS modes, amber is
     power, indigo is sleep, teal is a limit, slate is a neutral part (a battery
     shell, a ceiling bar). */
  const ICON_SVG = {
    /* ---- offline: a wifi fan cut by a slash, in currentColor ----
       The bolt that used to sit here said "power", which is the wrong story:
       the unit is not switched off, it has lost its network.  The slash is drawn
       in two pieces with a gap across the middle, the way every "no signal"
       glyph does it - one continuous line would just look like a crossed-out
       cloud at 16 px. */
    wifiOff: () => `
      <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none">
        <path d="M3.2 8.4a13.2 13.2 0 0 1 17.6 0"/>
        <path d="M6.4 12a8.6 8.6 0 0 1 11.2 0"/>
        <path d="M9.5 15.5a4.1 4.1 0 0 1 5 0"/>
        <circle cx="12" cy="19" r="1.35" fill="currentColor" stroke="none"/>
        <path d="M4.3 4.3 10.9 10.9"/>
        <path d="M13.1 13.1 19.7 19.7"/>
      </g>`,

    /* ---- power: a filled amber bolt ---- */
    bolt: (u) => `
      <defs><linearGradient id="${u}b" x1=".15" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient></defs>
      <path fill="url(#${u}b)"
        d="M13.9 1.6 4.6 13.3a.7.7 0 0 0 .55 1.15h4.7l-1.4 7a.7.7 0 0 0 1.23.55
           l9.4-11.7a.7.7 0 0 0-.55-1.15h-4.75l1.35-6.9a.7.7 0 0 0-1.23-.55z"/>`,

    /* ---- EMS mode: three faders, one per control strategy ---- */
    faders: (u) => `
      <g stroke-linecap="round">
        <path d="M5.4 4.4v15.2" stroke="#e2e8f0" stroke-width="2.5"/>
        <path d="M12 4.4v15.2" stroke="#e2e8f0" stroke-width="2.5"/>
        <path d="M18.6 4.4v15.2" stroke="#e2e8f0" stroke-width="2.5"/>
      </g>
      <circle cx="5.4" cy="14.2" r="3.25" fill="#ea580c"/>
      <circle cx="5.4" cy="14.2" r="1.1" fill="#fff"/>
      <circle cx="12" cy="9.1" r="3.25" fill="#16a34a"/>
      <circle cx="12" cy="9.1" r="1.1" fill="#fff"/>
      <circle cx="18.6" cy="16.4" r="3.25" fill="#2563eb"/>
      <circle cx="18.6" cy="16.4" r="1.1" fill="#fff"/>`,

    /* ---- sleep: an indigo crescent with a small star ---- */
    moon: (u) => `
      <defs><linearGradient id="${u}m" x1=".2" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#a5b4fc"/><stop offset="1" stop-color="#4f46e5"/>
      </linearGradient></defs>
      <path fill="url(#${u}m)"
        d="M20.1 14.6A9 9 0 0 1 9.3 3.8a9.15 9.15 0 1 0 10.8 10.8z"/>
      <circle cx="17.4" cy="5.1" r="1.45" fill="#c7d2fe"/>
      <circle cx="20.6" cy="8.6" r=".95" fill="#c7d2fe"/>`,

    /* ---- target power: a reticle around a bolt ----
       The row is a *setpoint*: one number the unit is told to aim at, in either
       direction. The old drawing was a grey battery beside a green / orange
       arrow pair, which said "the battery is going up or down" - two states, not
       a target. A ring with a bolt in the middle says "power, aimed": the bolt
       carries the subject and the ring carries "target", and neither half works
       alone. The signed range is already written out in the row's subtitle
       (+ discharge, − charge), so the icon does not have to show both arrows. */
    target: (u) => `
      <defs><linearGradient id="${u}pt" x1=".15" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#0d9488"/>
      </linearGradient></defs>
      <circle cx="12" cy="12" r="9.2" fill="none" stroke="url(#${u}pt)"
        stroke-width="1.8"/>
      <path fill="#f59e0b"
        d="M13.55 5.4 8.4 13.05h3.05l-.95 5.55 5.15-7.65h-3.05z"/>`,

    /* ---- max output: an arrow rising until it meets a ceiling ----
       It is a limit, not a flow, so the arrow stops at the bar. */
    ceiling: (u) => `
      <defs><linearGradient id="${u}c" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#16a34a"/>
      </linearGradient></defs>
      <path d="M3.4 4.1h17.2" stroke="#0d9488" stroke-width="2.5"
        stroke-linecap="round"/>
      <path fill="url(#${u}c)"
        d="M12 7 7.1 12.9h3.3v7.4h3.2v-7.4h3.3z"/>`,

    /* ---- per-phase limit: three bars capped by one shared ceiling ----
       Kept close to the old three-bar icon on purpose: it is the same subject
       (the phases), now clearly bounded from above. */
    phaseLimit: (u) => `
      <path d="M3.4 4.1h17.2" stroke="#94a3b8" stroke-width="2.2"
        stroke-linecap="round"/>
      <g stroke-linecap="round">
        <path d="M6.2 20V10.4" stroke="#ea580c" stroke-width="3.1"/>
        <path d="M12 20V7.4" stroke="#16a34a" stroke-width="3.1"/>
        <path d="M17.8 20V13.2" stroke="#2563eb" stroke-width="3.1"/>
      </g>`,

    /* ---- per-phase input limit: the output icon, mirrored ----
       Same three bars in the same phase colours and the same grey limit line as
       `phaseLimit`; the only difference is which side the line is on - output
       rises to a CEILING, input drops to a FLOOR. Drawn as an exact vertical
       mirror (line 4.1 -> 19.9, bars 20 -> 4, tips 10.4/7.4/13.2 ->
       13.6/16.6/10.8) so the two rows read as one pair at a glance.

       An earlier draft used three downward ARROWS. It was wrong twice: an arrow
       says "energy is flowing", while the row is a static ceiling, and the
       arrow heads made the block look nothing like its output sibling - the
       user read them as two unrelated drawings. */
    phaseInput: (u) => `
      <path d="M3.4 19.9h17.2" stroke="#94a3b8" stroke-width="2.2"
        stroke-linecap="round"/>
      <g stroke-linecap="round">
        <path d="M6.2 4v9.6" stroke="#ea580c" stroke-width="3.1"/>
        <path d="M12 4v12.6" stroke="#16a34a" stroke-width="3.1"/>
        <path d="M17.8 4v6.8" stroke="#2563eb" stroke-width="3.1"/>
      </g>`,

    /* ---- per-phase house input limit: the house itself ----
       The row caps what the house may draw, so the picture is the thing being
       fed rather than a plug. Blue is the colour the power flow card gives the
       house, and the meter reading card draws the same silhouette (with a bolt
       inside), so a "house" looks like a house on every page. */
    houseLimit: (u) => `
      <path d="M2.9 11.4 12 3.6l9.1 7.8" fill="none" stroke="#0284c7"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5.3 10.6v9.8h13.4v-9.8" fill="none" stroke="#0284c7"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M10.2 20.6v-5.2a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v5.2z"
        fill="#0284c7"/>`,

    /* ---- feed-in limit: the grid pylon ----
       §29/§30 is the ceiling on what may be exported TO THE GRID, so the symbol
       is the grid itself. `powerPlug` was wrong twice over: it already stands
       for the fine control's grid setpoint, and a plug says "something is
       connected", not "this is the grid".

       The drawing is **copied verbatim** from the energy sankey card
       (`hoymiles-energy-sankey.js` GLYPH_PYLON): cage on top, one cross-arm
       whose tips run past the legs, two splayed legs and the big X brace. It is
       so exactly the same pylon that the two pages read as one product; the
       only change is the stroke, white there (it sits on a dark plate) and the
       power-flow grid blue here. */
    gridTower: (u) => `
      <g fill="none" stroke="#f59e0b" stroke-width="1.9"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.4 4.4h5.2l1.3 3.2H8.1z"/>
        <path d="M2.8 9.6h18.4"/>
        <path d="M8.1 7.6 5.2 9.6M15.9 7.6l2.9 2"/>
        <path d="M7.2 9.6 4.6 20.4M16.8 9.6l2.6 10.8"/>
        <path d="M6.2 11.6 17.8 18.2M17.8 11.6 6.2 18.2"/>
      </g>`,

    /* ---- power controls: a bolt above a fader ----
       One glyph per word in the card's name: the amber bolt is "power", the
       track and its knob are "control". The card used to borrow the ceiling
       arrow that its own "max output" row draws, so the card header and a row
       inside it carried the same picture - and a limit (an arrow stopped by a
       bar) is a different idea from a set of limits you set yourself.
       The knob sits right of centre because that is the direction the sliders
       in that card travel. */
    powerLimit: (u) => `
      <defs><linearGradient id="${u}p" x1=".15" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient></defs>
      <path fill="url(#${u}p)"
        d="M12.6 1.7 6.4 8.9 H12.0 L11.4 13.7 17.6 6.5 H12.0 Z"/>
      <path d="M4.4 19.4h15.2" stroke="#cbd5e1" stroke-width="2.4"
        stroke-linecap="round"/>
      <circle cx="14.9" cy="19.4" r="3.05" fill="#0d9488"/>
      <circle cx="14.9" cy="19.4" r="1.05" fill="#fff"/>`,

    /* ---- reboot: a teal circular arrow ---- */
    reboot: (u) => `
      <defs><linearGradient id="${u}r" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#0d9488"/>
      </linearGradient></defs>
      <path fill="none" stroke="url(#${u}r)" stroke-width="2.5" stroke-linecap="round"
        d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4"/>
      <path fill="#0d9488" d="M13.4 4.1h6.2v6.2l-6.2-6.2z"/>`,

    /* ---- fan: the classic framed fan, monochrome ----
       A rounded square frame around a FIVE-blade rotor, with a hub ring. Five
       blades rather than three because that is what the fans on these units look
       like, and five is also the count that reads as "fan" at 18 px: three fat
       blades looked like a propeller, six thin ones turned into a disc.

       Each blade is a swept wedge: narrow at the hub, widening outward, with a
       curved leading edge, an outer arc, and a concave trailing edge. The hub is
       drawn as a white disc with a ring on top, so the blade roots are covered
       and the middle reads as a hub instead of a hole.

       Drawn in `currentColor` instead of a fixed black: the card can sit on a
       light or a dark theme, and a hard-coded colour disappears on one of them.
       Black IS what this renders as on a light theme, which is the look it is
       going for. */
    fan: (u) => `
      <rect x="2.5" y="2.5" width="19" height="19" rx="5"
        fill="none" stroke="currentColor" stroke-width="1.5"/>
      <g transform="translate(12 12)" fill="currentColor">
        <path d="M-0.53-2.14C-1.5-4.6-2.4-6.6-2.84-7.8C-0.53-8.64 2.03-8.42 4.15-7.19
                 C3.5-5.4 2-2.9 0.96-1.98Z"/>
        <path d="M-0.53-2.14C-1.5-4.6-2.4-6.6-2.84-7.8C-0.53-8.64 2.03-8.42 4.15-7.19
                 C3.5-5.4 2-2.9 0.96-1.98Z" transform="rotate(72)"/>
        <path d="M-0.53-2.14C-1.5-4.6-2.4-6.6-2.84-7.8C-0.53-8.64 2.03-8.42 4.15-7.19
                 C3.5-5.4 2-2.9 0.96-1.98Z" transform="rotate(144)"/>
        <path d="M-0.53-2.14C-1.5-4.6-2.4-6.6-2.84-7.8C-0.53-8.64 2.03-8.42 4.15-7.19
                 C3.5-5.4 2-2.9 0.96-1.98Z" transform="rotate(216)"/>
        <path d="M-0.53-2.14C-1.5-4.6-2.4-6.6-2.84-7.8C-0.53-8.64 2.03-8.42 4.15-7.19
                 C3.5-5.4 2-2.9 0.96-1.98Z" transform="rotate(288)"/>
      </g>
      <circle cx="12" cy="12" r="2.35" fill="var(--card-background-color, #fff)"
        stroke="currentColor" stroke-width="1.15"/>
      <circle cx="12" cy="12" r="0.6" fill="currentColor"/>`,

    /* ---- heating: an amber flame, drawn with a filled outer and a pale core ---- */
    heat: (u) => `
      <defs><linearGradient id="${u}h" x1=".2" y1="0" x2=".9" y2="1">
        <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#ea580c"/>
      </linearGradient></defs>
      <path fill="url(#${u}h)"
        d="M12.6 2.4c3 3.4 5.6 6 5.6 9.4a6.2 6.2 0 1 1-12.4 0c0-2 .9-3.6 2.4-4.9.3 1.7 1.2 2.9 2.5 3.3-.6-2.7-.3-5 1.9-7.8z"/>
      <path fill="#fde68a"
        d="M12.1 12.4c1.4 1.5 2.4 2.6 2.4 4a2.6 2.6 0 1 1-5.2 0c0-1.4 1.4-2.7 2.8-4z"/>`,

    /* ---- heating power: a flame beside a rising level ----
       The heating card's header is the plain flame, so the power row must not
       reuse it: the flame says *what* heats, the ascending bars say *how much*.
       Two bars instead of three because the row is drawn at 18 px and three read
       as a bar chart; two read as "a level being raised". */
    heatPower: (u) => `
      <defs><linearGradient id="${u}hw" x1=".2" y1="0" x2=".9" y2="1">
        <stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#ea580c"/>
      </linearGradient></defs>
      <g transform="translate(-1.6 1.3) scale(0.78)">
        <path fill="url(#${u}hw)"
          d="M12.6 2.4c3 3.4 5.6 6 5.6 9.4a6.2 6.2 0 1 1-12.4 0c0-2 .9-3.6 2.4-4.9.3 1.7 1.2 2.9 2.5 3.3-.6-2.7-.3-5 1.9-7.8z"/>
        <path fill="#fde68a"
          d="M12.1 12.4c1.4 1.5 2.4 2.6 2.4 4a2.6 2.6 0 1 1-5.2 0c0-1.4 1.4-2.7 2.8-4z"/>
      </g>
      <g stroke="#f59e0b" stroke-width="2.4" stroke-linecap="round">
        <path d="M15.8 19.4v-3.9"/>
        <path d="M19.4 19.4v-7.7"/>
      </g>`,

    /* ---- heating target: a thermometer with its scale ----
       Degrees are the other unit this one field can carry, so the row says
       "temperature" with a tool of its own rather than borrowing the flame a
       second time. Red bulb, amber ticks: the same warm palette as the card.
       Shifted left by 0.85 units so the thermometer plus its ticks are centred
       on the 24 grid (ink 6.55..17.65, centre 12.1). */
    heatTemp: (u) => `
      <g transform="translate(-0.85 0)">
        <path d="M11.6 3.5a2.15 2.15 0 0 1 2.15 2.15v6.9a4.3 4.3 0 1 1-4.3 0v-6.9A2.15 2.15 0 0 1 11.6 3.5z"
          fill="none" stroke="#dc2626" stroke-width="1.9"/>
        <circle cx="11.6" cy="16.3" r="2.55" fill="#ef4444"/>
        <path d="M11.6 16.3V8.6" stroke="#ef4444" stroke-width="2.2"
          stroke-linecap="round"/>
        <g stroke="#f59e0b" stroke-width="1.6" stroke-linecap="round">
          <path d="M16.1 7.6h2.3"/>
          <path d="M16.1 10.7h2.3"/>
          <path d="M16.1 13.8h1.6"/>
        </g>
      </g>`,

    /* ---- target packs: three battery modules stacked ----
       "Which packs does the heater act on" is a question about modules, not
       about heat, so the row gets its own artwork: green modules (the battery
       colour used everywhere else) rather than a second flame. */
    heatPacks: (u) => `
      <g stroke="#16a34a" stroke-width="1.6" stroke-linejoin="round">
        <rect x="3.4" y="4.4" width="17.2" height="4.3" rx="1.5"
          fill="rgba(22,163,74,.16)"/>
        <rect x="3.4" y="10" width="17.2" height="4.3" rx="1.5"
          fill="rgba(22,163,74,.16)"/>
        <rect x="3.4" y="15.6" width="17.2" height="4.3" rx="1.5"
          fill="rgba(22,163,74,.16)"/>
      </g>`,

    /* ---- PV limit: a sun ---- */
    sun: (u) => `
      <defs><radialGradient id="${u}s" cx=".5" cy=".42" r=".62">
        <stop offset="0" stop-color="#fde68a"/><stop offset="1" stop-color="#f59e0b"/>
      </radialGradient></defs>
      <circle cx="12" cy="12" r="4.5" fill="url(#${u}s)"/>
      <g stroke="#f59e0b" stroke-width="1.9" stroke-linecap="round">
        <path d="M12 2.5v2.3"/><path d="M12 19.2v2.3"/>
        <path d="M2.5 12h2.3"/><path d="M19.2 12h2.3"/>
        <path d="M5.3 5.3 6.9 6.9"/><path d="M17.1 17.1l1.6 1.6"/>
        <path d="M18.7 5.3 17.1 6.9"/><path d="M6.9 17.1 5.3 18.7"/>
      </g>`,

    /* ---- input limit: an arrow coming down onto a floor ----
       Input is power flowing *into* the unit, hence the downward arrow. */
    plug: (u) => `
      <defs><linearGradient id="${u}i" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#0284c7"/>
      </linearGradient></defs>
      <path d="M12 3.1v9.4" stroke="url(#${u}i)" stroke-width="2.6"
        stroke-linecap="round"/>
      <path fill="url(#${u}i)" d="M12 17.6 6.9 12.4h3.4V9.8h3.4v2.6h3.4z"/>
      <path d="M4.1 20.6h15.8" stroke="#94a3b8" stroke-width="2.4"
        stroke-linecap="round"/>`,

    /* ---- cut-off SOC: the two batteries of the dual-handle slider ----
       Same body, two levels of charge, standing on end. Portrait rather than
       landscape because the bars have to stack: a battery lying on its side was
       both flat-looking at 20 px and gave the bars nowhere to go.

       The bars fill from the BOTTOM like a real state of charge, so the reading
       is the picture: one bar means nearly empty, and the empty slot on top is
       what says "not full yet". They stop short of the rim on purpose - a fill
       that touches the outline reads as a solid block, not as a level.

       Amber is the card's word for "out" (where DISCHARGING stops) and green for
       "in" (where CHARGING stops). */
    batteryOut: (u) => `
      <rect x="9.7" y="2.4" width="4.6" height="2.8" rx="1.1" fill="#f59e0b"/>
      <rect x="6.3" y="5" width="11.4" height="16.6" rx="2.8" fill="none"
        stroke="#f59e0b" stroke-width="1.9"/>
      <rect x="8.6" y="15.9" width="6.8" height="4" rx="1.1" fill="#f59e0b"/>`,

    batteryIn: (u) => `
      <rect x="9.7" y="2.4" width="4.6" height="2.8" rx="1.1" fill="#16a34a"/>
      <rect x="6.3" y="5" width="11.4" height="16.6" rx="2.8" fill="none"
        stroke="#16a34a" stroke-width="1.9"/>
      <rect x="8.6" y="15.9" width="6.8" height="4" rx="1.1" fill="#16a34a"/>
      <rect x="8.6" y="11.4" width="6.8" height="4" rx="1.1" fill="#16a34a"/>`,

    /* ---- forbidden: the battery of that direction, with a red "no" sign ----
       The battery keeps the card's colour for the direction (green = in, amber =
       out), and the red ring with its slash says the other half: the device is
       **refusing** that flow, which is a stronger statement than "idle".

       The ring is CENTRED ON the battery, not parked beside it: "forbidden" is a
       property of this battery, so the badge is stamped over the body the way the
       sign on a no-parking plate sits on the space it cancels. The battery keeps
       its full size and about 3 units of head and foot stay outside the ring, so
       the tile still reads as a battery rather than as a red circle. A pale halo
       is drawn under the ring and its slash because the red lines cross the green
       / amber strokes and bars and would otherwise turn into mud at 20 px. */
    noCharge: (u) => `
      <rect x="9.7" y="2.4" width="4.6" height="2.8" rx="1.1" fill="#16a34a"/>
      <rect x="6.3" y="5" width="11.4" height="16.6" rx="2.8" fill="none"
        stroke="#16a34a" stroke-width="1.9"/>
      <rect x="8.6" y="15.9" width="6.8" height="4" rx="1.1" fill="#16a34a"/>
      <rect x="8.6" y="11.4" width="6.8" height="4" rx="1.1" fill="#16a34a"/>
      <g stroke="#f8fafc" stroke-width="3.9" fill="none" stroke-linecap="round">
        <circle cx="12" cy="12" r="5.6"/>
        <path d="M8.04 15.96 15.96 8.04"/>
      </g>
      <circle cx="12" cy="12" r="5.6" fill="none" stroke="#dc2626"
        stroke-width="1.9"/>
      <path d="M8.04 15.96 15.96 8.04" stroke="#dc2626" stroke-width="1.9"
        stroke-linecap="round"/>`,

    noDischarge: (u) => `
      <rect x="9.7" y="2.4" width="4.6" height="2.8" rx="1.1" fill="#f59e0b"/>
      <rect x="6.3" y="5" width="11.4" height="16.6" rx="2.8" fill="none"
        stroke="#f59e0b" stroke-width="1.9"/>
      <rect x="8.6" y="15.9" width="6.8" height="4" rx="1.1" fill="#f59e0b"/>
      <g stroke="#f8fafc" stroke-width="3.9" fill="none" stroke-linecap="round">
        <circle cx="12" cy="12" r="5.6"/>
        <path d="M8.04 15.96 15.96 8.04"/>
      </g>
      <circle cx="12" cy="12" r="5.6" fill="none" stroke="#dc2626"
        stroke-width="1.9"/>
      <path d="M8.04 15.96 15.96 8.04" stroke="#dc2626" stroke-width="1.9"
        stroke-linecap="round"/>`,

    /* ---- grid setpoint: a plug ----
       The row decides how much power crosses the grid port, so it gets the thing
       that goes into the socket. Distinct from `plug`, which is the arrow
       dropping onto a floor that the *input* ceiling uses - that one is about
       power coming in and stopping, this one is about the grid connection. */
    powerPlug: (u) => `
      <defs><linearGradient id="${u}pl" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#0284c7"/>
      </linearGradient></defs>
      <path d="M8.7 2.9v4.4M15.3 2.9v4.4" stroke="url(#${u}pl)" stroke-width="2.2"
        stroke-linecap="round"/>
      <path d="M5.9 7.3h12.2v3.9a4.6 4.6 0 0 1-4.6 4.6h-3a4.6 4.6 0 0 1-4.6-4.6z"
        fill="rgba(2,132,199,.15)" stroke="url(#${u}pl)" stroke-width="2"
        stroke-linejoin="round"/>
      <path d="M12 15.8v2.6a2.5 2.5 0 0 0 2.5 2.5H17" fill="none"
        stroke="url(#${u}pl)" stroke-width="2" stroke-linecap="round"/>`,

    /* ---- off-grid relay: a three-hole socket ----
       The row is about the off-grid *outlet* going live, so the symbol is the
       outlet itself; a plug would have said "something is plugged in", which the
       relay cannot know. */
    socket: (u) => `
      <rect x="2.7" y="2.7" width="18.6" height="18.6" rx="5.6" fill="none"
        stroke="#0d9488" stroke-width="1.9"/>
      <g fill="#0d9488">
        <rect x="7.2" y="6.9" width="2.3" height="5.6" rx="1.15"/>
        <rect x="14.5" y="6.9" width="2.3" height="5.6" rx="1.15"/>
        <rect x="9.9" y="14.9" width="4.2" height="2.3" rx="1.15"/>
      </g>`,

    /* ---- virtual meter setpoint: the meter itself ----
       That row is a simulated utility meter, so the symbol is the thing on the
       wall: a dial window with its needle, on a round-cornered case. The plug it
       used before belongs to the fine control grid row, and two rows wearing the
       same icon - one of them wrong - is worse than a busier drawing. */
    meterDial: (u) => `
      <rect x="2.7" y="3.4" width="18.6" height="17.2" rx="3.4" fill="none"
        stroke="#0284c7" stroke-width="1.9"/>
      <path d="M6.6 14.6a5.4 5.4 0 0 1 10.8 0" fill="none" stroke="#0284c7"
        stroke-width="1.7" stroke-linecap="round"/>
      <path d="M12 14.6 15.3 10.9" stroke="#0284c7" stroke-width="1.9"
        stroke-linecap="round"/>
      <circle cx="12" cy="14.6" r="1.15" fill="#0284c7"/>
      <path d="M6.3 18.3h3M14.7 18.3h3" stroke="#0284c7" stroke-width="1.7"
        stroke-linecap="round"/>`,

    /* ---- meter readings: what the emulated meter counted ----
       A solar panel is what feeds the grid and a house is what draws from it, so
       the two readings say *where the energy went* instead of borrowing the
       battery (which means "a stored level" and belongs to the SOC rows).

       The panel is the **same drawing** the gauge card uses for its PV-today
       card (hoymiles-gauge.js `panel`): a 2x2 module on a stand, amber gradient
       fill, equal 1.5 gaps between the four cells. It is copied rather than
       shared because the two files are separate bundles with no common module,
       and a mismatch between the two panels would be worse than the duplication.
       Blue for consumption, the colour the power flow card gives the house. */
    meterGen: (u) => `
      <defs><linearGradient id="${u}pg" x1=".15" y1="0" x2=".85" y2="1">
        <stop offset="0" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/>
      </linearGradient></defs>
      <g fill="url(#${u}pg)">
        <rect x="2.9" y="2.6" width="8.4" height="5.4" rx="1.5"/>
        <rect x="12.7" y="2.6" width="8.4" height="5.4" rx="1.5"/>
        <rect x="2.9" y="9.5" width="8.4" height="5.4" rx="1.5"/>
        <rect x="12.7" y="9.5" width="8.4" height="5.4" rx="1.5"/>
      </g>
      <g stroke="#f59e0b" stroke-width="1.9" stroke-linecap="round">
        <path d="M12 15.8v3.5"/>
        <path d="M8.3 19.9h7.4"/>
      </g>`,

    meterUse: (u) => `
      <path d="M3.4 11.4 12 4.3l8.6 7.1" fill="none" stroke="#0284c7"
        stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5.7 10.6v9.1h12.6v-9.1" fill="none" stroke="#0284c7"
        stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M13.2 12.6 10.8 16.2h2.4l-1.6 3.3" fill="none" stroke="#0284c7"
        stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,

    /* The card's own badge: the SAME battery as the two column icons (same
       proportions, same bar spacing - that is what makes the three look like one
       family) BESIDE the up / down arrow pair this card has always used for "an
       upper AND a lower limit". The battery says "a level", the arrows say "two
       limits"; either half alone loses part of the meaning. Amber points down
       (the discharge cut-off), green points up (the charge cut-off), matching the
       two columns below.
       The body was squeezed once to make room for the arrows and stopped looking
       like its siblings, so the arrows sit beside a full-width battery now. The
       whole composite is centred on the 24 grid: ink runs 1.55 -> 22.0, i.e. a
       centre of 11.8, and the gap between the two parts is a little over 2 units
       so they read as two objects rather than one smudge. */
    socBattery: (u) => `
      <rect x="5.75" y="2.2" width="4.5" height="2.6" rx="1" fill="#94a3b8"/>
      <rect x="2.4" y="4.6" width="11.2" height="16.2" rx="2.6" fill="none"
        stroke="#94a3b8" stroke-width="1.7"/>
      <rect x="4.7" y="15.9" width="6.6" height="3.9" rx="1.1" fill="#16a34a"/>
      <rect x="4.7" y="11.5" width="6.6" height="3.9" rx="1.1" fill="#22c55e"/>
      <rect x="4.7" y="7.1" width="6.6" height="3.9" rx="1.1" fill="#cbd5e1"/>
      <path d="M19.3 10.9V6.4" stroke="#16a34a" stroke-width="1.9"
        stroke-linecap="round"/>
      <path fill="#16a34a" d="M19.3 3.4 16.6 7.4h5.4z"/>
      <path d="M19.3 13.1v4.5" stroke="#f59e0b" stroke-width="1.9"
        stroke-linecap="round"/>
      <path fill="#f59e0b" d="M19.3 20.6 16.6 16.6h5.4z"/>`,

    dot: () => `<circle cx="12" cy="12" r="4" fill="currentColor"/>`,
  };


  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  /**
   * The SN part of `<prefix>-<SN>`.
   *
   * The integration names its own entities after the **device name**, so a
   * device renamed to "G3" gets `number.g3_msa_..._charge_cut_off_soc` while the
   * firmware's MQTT entities stay `number.msa_...`. Matching the SN anywhere in
   * the id covers both; `unique_id` is not available to the frontend any more.
   */
  function serialOf(devId) {
    const parts = String(devId == null ? "" : devId).split("-");
    return parts[parts.length - 1].toLowerCase();
  }

  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  /* `esc()` is only for markup strings handed to `_untrusted()` (they go through
   * `innerHTML`). Lit templates escape their own bindings, so a `${...}` inside a
   * `html` template must keep the value raw. */

  class HoymilesControl extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _powerCtrl: { type: String },
        _outputPower: { type: String },
        _phase: { type: Object },
        _week: { type: String },
        _toast: { type: String },
        _toastError: { type: Boolean },
        _optimistic: { type: Object },
        _repeatOn: { type: Boolean },
        _repeatEvery: { type: String },
        _busy: { type: Object },
        _confirm: { type: Object },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._powerCtrl = "";
      this._outputPower = "";
      this._phase = { a: "", b: "", c: "" };
      /* V0.6.6 §27 / §31: the same three boxes for the per phase input limit and
         the per phase house input limit.  Kept apart from `_phase` because each
         group is a different topic with a different value in force. */
      this._phaseInput = { a: "", b: "", c: "" };
      this._phaseHouse = { a: "", b: "", c: "" };
      this._feedPower = "";
      /* Which category of the power controls card is open. Empty means "the
         first one the device supports", so a role that only offers one category
         needs no picker at all (see `_powerLimitsCard`). */
      this._plimTab = "";
      /* Protocol V0.6.2 controls. Every one of them is a draft plus a Send
         button, like the power rows above: the firmware applies a setting when
         it arrives, so publishing on every keystroke would chase the slider
         across the broker. */
      this._fanPcs = "";
      this._fanBat = "";
      this._heatPower = "";
      /* Which packs the heater acts on (§39 ``controls.pack_ids``): a set, held
         as sorted numbers. Empty until the first seed or a click, which is why
         `_heatPackRow` must not assume it is filled. */
      this._heatPacks = [];
      this._pvPower = "";
      this._inputPower = "";
      this._gridP = "";
      this._meterP = "";
      this._meterOut = "";
      this._meterIn = "";
      this._socH = "";
      this._socL = "";
      this._socDirty = false;
      this._seenDraft = {};
      this._fanModePending = null;
      this._heatModePending = null;
      this._week = "Mon";
      this._toast = "";
      this._toastError = false;
      this._optimistic = {};
      this._cache = new Map();
      this._initialised = false;
      this._toastTimer = null;
      /* A banner across the top of the page, for a note that has to outlive the
         success dialog: "the heater's real state only arrives with the next
         5-minute report" used to be step 2 of that dialog, which vanished the
         moment it was dismissed.  It slides in, sits for a while and goes away
         on its own (or on the close button). */
      this._banner = "";
      this._bannerTimer = null;
      /* Periodic re-send of the power control value.

         The repeat itself runs in the integration, **not here**: ``power_ctrl``
         is a lease the firmware renews only while it keeps arriving, and a
         ``setTimeout`` inside this card died with the card on every page change
         (Lovelace destroys the view's elements), leaving the switch on screen
         saying "on" while nothing was being sent. ``hoymiles.set_power_ctrl``
         schedules the publish in Home Assistant instead, so navigation, a
         closed tab and a throttled background tab no longer matter.

         The card keeps three things: the switch position (the user's intent,
         ``_repeatOn``), the last state the server reported (``_repeatState``)
         and a display-only countdown derived from it. */
      this._repeatOn = true;
      this._repeatEvery = String(REPEAT_DEFAULT_S);
      this._repeatState = null; // {value, interval, nextIn, at} or null
      this._repeatSynced = false; // the restore query already ran for this instance
      this._repeatSeeded = false; // the inputs were filled from the server once
      this._repeatSyncTimer = null; // next resync, arrives with the server state
      this._repeatUiTimer = null; // once-a-second countdown refresh
      /* The same bookkeeping for the two other leases, keyed by `LEASES` kind:
         `_leaseStates[kind]` is what the server last reported (null when nothing
         is running), `_leaseOn[kind]` the switch position and `_leaseEvery[kind]`
         the interval draft. Kept per kind because the modes are exclusive: the
         card only ever shows one of them at a time. */
      this._leaseStates = {};
      this._leaseOn = {};
      this._leaseEvery = {};
      this._leaseTimers = {}; // next resync, one per kind
      this._leaseQueried = {}; // the first restore query already ran
      /* The virtual meter's HTTP endpoint details (URL, key, range), fetched
         over WebSocket while `meter_ctrl` is on screen - see `_meterHttpBlock`.
         The same call carries the write counter the card shows under the
         setpoint, so it is re-read on a timer, not once. */
      this._vmInfo = null;
      this._vmLoading = false;
      this._vmAt = 0;
      /* Last EMS mode this card rendered. Drives the "left / re-entered MQTT
         control" reset - see `_watchEmsMode`. */
      this._lastEmsMode = undefined;
      /* Power switch: the requested target while it is in flight, and the time
         the device confirmed it (drives the tick + spinner). */
      this._switchPending = null;
      this._switchConfirmedAt = 0;
      this._pendingTimer = null;
      /* Progress dialog. Every command that reaches the broker - or that the
         device has to answer - runs through it, so the user always sees which
         step is in flight instead of a banner that says "sent" after the fact. */
      this._busy = null;
      this._busyTimer = null;
      /* Yes/no question (currently: switching the timer off). */
      this._confirm = null;
      /* Cut-off SOC card: the header word that replaces its Send button, and
         the pair it last published (null until the first release, so `_socCommit`
         can tell a click from a drag). */
      this._socSent = "";
      this._socSentErr = false;
      this._socSentTimer = null;
      this._socSentKey = null;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-control-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
    }

    static get styles() {
      return css`
        /* iOS-style settings layout: grouped cards, right-aligned controls,
           hairline separators that stop short of the card edge. */
        :host { display: block; }
        ha-card { padding: 14px 16px 16px; }
        .head { display: flex; align-items: baseline; gap: 10px;
                flex-wrap: wrap; margin-bottom: 12px; }
        .head .title { font-size: 17px; font-weight: 600;
                       color: var(--primary-text-color); }
        .head .sub { font-size: 12.5px; color: var(--secondary-text-color); }

        .group { background: var(--secondary-background-color, rgba(120,120,128,.08));
                 border-radius: 14px; overflow: hidden; margin-bottom: 14px; }
        .group-title { font-size: 12.5px; font-weight: 500;
                       color: var(--secondary-text-color);
                       padding: 0 6px 6px; }
        .group-wrapper:not(:first-of-type) { margin-top: 16px; }

        .item { display: flex; align-items: center; gap: 12px;
                padding: 11px 14px; min-height: 52px;
                box-sizing: border-box; position: relative; }
        /* The group clips its content (overflow: hidden), so a row that does not
           fit has to wrap instead of spilling: when the card is narrow the
           control moves to its own line below the label. Without this the
           segmented control was cut off once the dashboard column shrank. */
        .item:not(.stack) { flex-wrap: wrap; }
        .item + .item::before {
          content: ""; position: absolute; top: 0; left: 14px; right: 0;
          height: 1px; background: var(--divider-color); opacity: .7;
        }
        .item .ico { flex: 0 0 auto; width: 24px; text-align: center;
                     font-size: 16px; line-height: 1; }
        .item .nm { flex: 1 1 auto; min-width: 0; font-size: 15px;
                    color: var(--primary-text-color); line-height: 1.3; }
        /* Row layout only: giving the label a real basis keeps it readable and
           makes the control wrap first instead of squeezing the label to 0. */
        .item:not(.stack) .nm { flex: 1 1 7.5em; }
        .item .nm small { display: block; font-size: 12px; font-weight: 400;
                          color: var(--secondary-text-color); margin-top: 2px;
                          line-height: 1.35; }
        .item .nm code { font-size: 11px; color: var(--secondary-text-color);
                         word-break: break-all; }
        .item .ctrl { flex: 0 1 auto; display: flex; align-items: center;
                      gap: 8px; margin-left: auto;
                      flex-wrap: wrap; justify-content: flex-end;
                      max-width: 100%; }
        .item.stack { flex-direction: column; align-items: stretch; gap: 8px; }
        .item.stack .ctrl { margin-left: 0; flex: 0 0 auto;
                            flex-wrap: wrap; justify-content: flex-start; }
        .item .ctrl .unit { font-size: 13px; color: var(--secondary-text-color); }

        /* Periodic send, as a second line under the sliders. It is a plain row
           rather than another slider so it reads as a setting *of* the power
           control, and its switch lines up with "Send" above it. */
        .repeat-row { display: flex; align-items: center; gap: 7px;
                      width: 100%; margin-top: 6px; }
        .repeat-row .repeat-ico { display: inline-flex; flex: 0 0 auto;
                                  color: var(--secondary-text-color); }
        .repeat-row .cap { font-size: 12.5px;
                           color: var(--secondary-text-color);
                           white-space: nowrap; }
        .repeat-row input[type="number"] {
          width: 56px; flex: 0 0 auto; text-align: center;
          font-size: 13.5px; padding: 6px 4px; border-radius: 9px;
        }
        .repeat-row .spacer { flex: 1 1 auto; min-width: 4px; }
        .repeat-row ha-switch { flex: 0 0 auto; }
        /* While it runs, the row is tinted so "this is live" is visible without
           reading the countdown. */
        .repeat-row.on .cap { color: var(--primary-color); }
        .repeat-row.on .repeat-ico { color: var(--primary-color); }

        /* segmented control (the iOS signature control) */
        .seg { display: inline-flex; padding: 2px; gap: 2px;
               max-width: 100%; flex-wrap: wrap;
               background: var(--secondary-background-color, rgba(120,120,128,.16));
               border-radius: 10px; }
        .seg button {
          border: none; background: none; font: inherit; font-size: 13px;
          padding: 5px 12px; border-radius: 8px; cursor: pointer;
          color: var(--primary-text-color); white-space: nowrap;
          transition: background .15s, box-shadow .15s;
        }
        .seg button.on {
          background: var(--card-background-color, #fff);
          box-shadow: 0 1px 3px rgba(0,0,0,.14); font-weight: 600;
        }
        .seg button:disabled { opacity: .4; cursor: not-allowed; }
        .seg.danger button.on { color: var(--error-color); }

        /* In-flight power on/off: the pressed option spins a ring until the
           device reports the new state. The spinner lives in the button's own
           ::after, so no extra markup is needed over the segment. */
        .seg button.pending { padding-right: 24px; position: relative; }
        .seg button.pending::after {
          content: ""; position: absolute; top: 50%; right: 7px;
          width: 9px; height: 9px; margin-top: -5.5px; border-radius: 50%;
          border: 2px solid currentColor; border-top-color: transparent;
          opacity: .75; animation: hm-spin .7s linear infinite;
        }
        @keyframes hm-spin { to { transform: rotate(360deg); } }

        /* The sub-line carries the progress, so a slow power cycle still has
           visible feedback right where the user is looking. */
        .item .nm small.busy { color: var(--primary-color);
                               animation: hm-pulse 1.3s ease-in-out infinite; }
        .item .nm small.done { color: var(--success-color, #0da035);
                               font-weight: 500; }
        /* The periodic send is running: the sub-line carries the countdown, so
           it is tinted to sit apart from a plain description. */
        .item .nm small.live { color: var(--primary-color); font-weight: 500; }
        @keyframes hm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

        /* plain pill button */
        .btn {
          font: inherit; font-size: 13.5px; font-weight: 500;
          padding: 8px 15px; border-radius: 10px; border: none;
          cursor: pointer; background: var(--secondary-background-color, rgba(120,120,128,.16));
          color: var(--primary-text-color); transition: filter .15s;
        }
        .btn:active { filter: brightness(.94); }
        .btn.primary { background: var(--primary-color);
                       color: var(--text-primary-color, #fff); font-weight: 600; }
        /* A grouped send (fan speeds, SOC pair) is one action for a block of
           values, not the main action of the card. Filled blue made it the
           loudest thing on the page, so it is a quiet text button. The three
           phase limits are the exception: their Send is filled, because it is
           the only way to tell three stacked sliders apart from the action. */
        .btn.ghost { background: none; color: var(--primary-color);
                     font-weight: 600; padding: 6px 6px; }
        .btn.danger { background: none; color: var(--error-color); padding: 8px 10px; }
        /* The repeat toggle while it is running: red reads as "press to stop". */
        .btn.stop { background: var(--error-color);
                    color: var(--text-primary-color, #fff); font-weight: 600; }
        .btn:disabled { opacity: .45; cursor: not-allowed; }

        /* editable read-out next to a slider */
        input[type="number"] {
          font: inherit; font-size: 15px; width: 64px; text-align: right;
          padding: 6px 8px; border-radius: 10px;
          border: 1px solid transparent;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color); outline: none;
          font-variant-numeric: tabular-nums;
        }
        input[type="number"]:focus { border-color: var(--primary-color); }
        input[type="number"].narrow { width: 52px; }
        /* The virtual meter's cumulative readings: a counter, not a slider - a
           0 ~ 4 294 967 295 handle is unusable, a number box is not. */
        .energy-set { display: flex; align-items: center; gap: 8px;
                      justify-content: flex-end; }
        .energy-set input[type="number"] { width: 130px; }
        .energy-set .unit { flex: 0 0 auto; font-size: 12px;
                            color: var(--primary-color); opacity: .75; }
        .energy-set .btn { flex: 0 0 auto; padding: 6px 11px; font-size: 13px;
                           border-radius: 9px; }
        /* The two meter readings share one line. Two fixed columns at every
           width, for the same reason as the fine control switch row: a column
           that collapses would change the card height with the window. */
        .me-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 10px 18px; }
        .me-cell { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
        .me-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .me-head .fic { display: inline-flex; flex: 0 0 auto; }
        .me-head .ft { font-size: 12.5px; line-height: 1.25; min-width: 0;
                       overflow-wrap: anywhere; }
        .me-cell .energy-set { justify-content: flex-start; }
        .me-cell .energy-set input[type="number"] { width: auto; flex: 1 1 auto;
                                                   min-width: 0; }
        /* Live counter of the virtual meter's external writes. One quiet line
           under the setpoint: it is telemetry, not a control, and it must stay
           readable at every width (it wraps rather than changes the height of
           anything else). */
        .meter-rx { display: flex; flex-wrap: wrap; align-items: baseline;
                    gap: 4px 12px; padding: 9px 12px; border-radius: 12px;
                    background: var(--secondary-background-color, rgba(120,120,128,.10));
                    font-size: 12px; line-height: 1.45;
                    color: var(--secondary-text-color); }
        .meter-rx .rx-count { font-weight: 600; color: var(--primary-text-color);
                              font-variant-numeric: tabular-nums; }
        .meter-rx.live .rx-count { color: var(--primary-color); }
        .meter-rx .rx-latest { font-variant-numeric: tabular-nums; }
        .meter-rx .rx-state { margin-left: auto; white-space: nowrap; }
        /* The unit is a label, not a field: it keeps its own width so the row
           can never be pushed wider than the card. */
        .slider .unit { flex: 0 0 auto; font-size: 12px; white-space: nowrap;
                        color: var(--primary-color); opacity: .75; }
        /* Compact send buttons: a full-size pill per slider row made the cards
           tall and loud. Same colour, two thirds of the area. */
        .slider .btn { flex: 0 0 auto; padding: 6px 11px; font-size: 13px;
                       border-radius: 9px; }

        /* ================================================================== *
         * Sliders
         *
         * One shape for every slider on the page: a thick rounded track, a fill
         * in the primary colour, a round knob, and a plain read-out on the
         * right. The read-out is TEXT, not a field - the value is only ever
         * changed by dragging, and an editable box was a second way in that
         * could disagree with the knob.
         *
         * The real input is laid over the track and made transparent: dragging,
         * the keyboard and touch stay native, while the visible fill and knob
         * are siblings that follow ONE number (--frac, 0..1). It is a number
         * rather than a percentage because the knob needs it inside a calc()
         * that mixes px and %.
         *
         * ONE LINE, ALWAYS: the track gives up width and everything else keeps
         * its size, so shrinking the window cannot turn a row into two, which
         * is what used to make the same card look different at a resolution.
         *
         * NOTE: never write a backtick inside this css template (not even in a
         * comment) - it would terminate the template string.
         * ================================================================== */
        .slider { display: flex; align-items: center; gap: 8px;
                  width: 100%; flex-wrap: nowrap; }
        .slider .tag { flex: 0 0 auto; min-width: 12px; font-size: 12.5px;
                       white-space: nowrap;
                       color: var(--secondary-text-color); }
        .slider .bar { position: relative; flex: 1 1 auto; min-width: 24px;
                       height: 12px; border-radius: 999px;
                       background: var(--divider-color); }
        .slider .bar .ffill { position: absolute; top: 0; bottom: 0; left: 0;
                              width: calc(var(--frac, 0) * 100%);
                              border-radius: 999px;
                              background: var(--primary-color); opacity: .55; }
        /* 16 px knob on an 12 px track. The earlier 20 px knob on an 18 px
           track read as a thick pill rather than a slider, especially with four
           of them stacked in one card - and the knob is what the eye measures,
           not the track. The offsets keep the knob inside the track at both
           ends: half its width at each end, the rest spread over the travel. */
        .slider .bar .fknob { position: absolute; top: 50%; z-index: 2;
                              left: calc(8px + (100% - 16px) * var(--frac, 0));
                              transform: translate(-50%, -50%);
                              width: 16px; height: 16px; border-radius: 50%;
                              pointer-events: none;
                              background: var(--primary-color);
                              box-shadow: 0 1px 3px rgba(0,0,0,.26); }
        .slider .bar input[type="range"] {
          position: absolute; inset: 0; z-index: 3;
          width: 100%; height: 100%; margin: 0;
          opacity: 0; cursor: pointer;
          -webkit-appearance: none; appearance: none;
        }
        .slider .bar input[type="range"]:disabled { cursor: not-allowed; }
        /* Read-out: plain text, blue, right aligned on a fixed width so the
           numbers of stacked rows line up. */
        .slider .val { flex: 0 0 auto; min-width: 30px; text-align: right;
                       font-size: 13.5px; font-weight: 600;
                       color: var(--primary-color);
                       font-variant-numeric: tabular-nums; }
        select {
          font: inherit; font-size: 15px; padding: 7px 10px;
          border-radius: 10px; border: 1px solid transparent;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color); outline: none; cursor: pointer;
        }
        select:focus { border-color: var(--primary-color); }
        .state { font-size: 13px; color: var(--secondary-text-color);
                 white-space: nowrap; }
        .state.live { color: var(--primary-color); font-weight: 500; }

        .btn.small { padding: 5px 10px; font-size: 12.5px; }
        .toast { margin-top: 12px; font-size: 13px; padding: 10px 13px;
                 border-radius: 12px;
                 background: var(--secondary-background-color, rgba(120,120,128,.12)); }
        .toast.err { color: var(--error-color); }

        /* ================================================================== *
         * Board layout
         *
         * ONE three-track grid, and every card is an item in it:
         *
         *   +-----------+-----------+-----------+
         *   | Power     | Cut-off   | Fan       |  band 1 (auto flow)
         *   +-----------+-----------+-----------+
         *   | Power controls (2 tracks)| Heater  |  band 2
         *   +-----------+-----------+-----------+
         *   | EMS mode (2 tracks)     |           |  band 3
         *   +-----------+-----------+-----------+
         *
         * The power controls card is two tracks wide so it lines up with the
         * power and cut-off cards directly above it, and the heater sits in the
         * last track under the fan card. The EMS card shares the power card's
         * two tracks one band lower, so the page reads top to bottom instead of
         * having a wide card next to a column of narrow ones.
         *
         * The board is a single flowing grid whose track count follows its own
         * width (repeat(auto-fit, minmax(300px, 1fr))), so the placement rules
         * below only use spans and the "last track" negative line - never a
         * hard-coded track number. At one column (a phone) every span falls back
         * to auto in the container query further down.
         *
         * NOTE: never write a backtick inside this css template (not even in a
         * comment) - it would terminate the template string.
         * ================================================================== */
        /* Layout decisions are made against the width the BOARD actually got,
           not against the width of the window. That difference is the whole
           reason the page looked broken on one screen and fine on another:
           the HA sidebar takes ~256 px, the dashboard padding takes a bit
           more, and Windows scaling changes the CSS pixel width of a monitor,
           so the same board width can arrive from two very different window
           widths. A media query measured the window and therefore missed the
           breakpoint exactly when the cards were too narrow. The wrapper is a
           container query target so .board itself can react to its own space.
           (It has to be a wrapper rather than .board: a container query only
           answers for DESCENDANTS of the container, never for the container
           element itself.) */
        .wrap { container-type: inline-size; }
        /* ONE flowing grid, sized the way a card dashboard is normally sized:
           a MINIMUM and a MAXIMUM card width, with as many equal tracks as fit
           in between. This is the pattern Omnibattery's control tab uses
           (repeat(auto-fit, minmax(300px, 1fr))) - the column count is not
           fixed, the space is.
           The max half of a minmax is NOT the way to do the ceiling: Chrome
           counts auto-fit repetitions from the track's MAX when it is definite,
           so minmax(300px, 400px) produced only two columns on a 1142 px board
           (2 x 400 + gap) and left 164 px of empty margin. The ceiling is
           therefore applied to the BOARD (max-width), which keeps the count
           driven by the 300 px floor: 3 x 400 plus the two gaps is the widest
           this five-card page should ever get, and a wider window just gets
           bigger margins instead of ribbon-thin cards.
           justify-content: center keeps a row that cannot fill its width
           centred instead of pinned left. */
        /* The dense flow is what makes a missing card disappear cleanly instead
           of leaving a hole: the flow back-fills the empty cell with whatever
           later card fits it. A model with no fan (a HiBattery 1920 AC) simply
           has one card fewer, the heater slides up into the cell it left, and
           the rest keep their order. Nothing is stretched to fill anything.

           ⚠️ auto-FILL, not auto-fit. auto-fit collapses a track that no card
           ever lands in and hands its width to the others, which is exactly the
           opposite of "the cards keep their own size". A HiBattery MS-A2 has
           only four cards - power, cut-off, power controls (2 tracks) and EMS
           (2 tracks) - so the THIRD track is never used by anything, auto-fit
           folded it away, the board fell back to two tracks of 607 px and every
           card grew by half. auto-fill keeps the empty track, so the board
           stays at three tracks of 400 px and the unused column simply stays
           empty. Same reason it must not be auto-fit on a wider window: the
           track count follows the 300 px floor, never the content. */
        .board { display: grid; gap: 14px;
                 align-items: stretch;
                 grid-auto-flow: row dense;
                 grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                 justify-content: center;
                 max-width: 1228px; margin-inline: auto; }
        /* Both wrappers dissolved because the three cards of the first band used
           to be wrapped in them; the template now lists the cards directly, so
           the grid tracks are decided once by the board and every card obeys. */
        /* Cards that share a line share its height: the tallest decides it and
           the spare room is spread BETWEEN the controls (space-evenly) rather
           than piled under them. Centring the whole block was tried and read as
           a mistake; spreading it reads as spacing. A card with a single
           control in its body simply centres that row. */
        .board > .c > .c-body { flex: 1 1 auto; justify-content: space-evenly; }
        /* Only the SPANS are declared; where a card lands is the flow's job.

             power | cut-off | fan          band 1
             power controls (2 tracks)| heat  band 2
             EMS (2 tracks)                  band 3

           The power controls card is two tracks wide, so it is exactly as wide
           as the power and cut-off cards above it - that alignment is the whole
           point. Every card is listed in that order by the template, so plain
           auto flow reproduces the layout on a unit that has all of them, and a
           unit that is missing one just closes up.

           WARNING - do not pin grid-row or "grid-column: -2 / -1" on the
           heater. That was tried: on a fanless model the pinned row left the
           card stranded under a hole, and every workaround for it (stretching
           the heater over two bands, widening the power controls card to full
           width) distorted the layout the user asked to keep. */
        .board > .c.plim { grid-column: span 2; }
        /* The heater keeps its OWN height. The board stretches every card in a
           row to the tallest one, which is right for the three small cards of
           band 1 - but in band 2 the power controls card can be much taller
           (it grows a category picker when the unit has more than one group of
           ceilings), and stretching the heater to match turned three buttons and
           a sentence into a tall empty box. So the heater opts out.
           This rule is older than the auto-flow rewrite; it was dropped in that
           rewrite and the heater grew back - do not remove it again. */
        .board > .c.heat { align-self: start; }
        /* The EMS card is ONE track unless it needs two (the wide class). A
           slave offers two modes, and two buttons stretched over two tracks read
           as a card that ran out of content; at one track it lines up under the
           power card instead. */
        .board > .c.ems { align-self: start; }
        .board > .c.ems.wide { grid-column: span 2; }
        /* One track: the cards would otherwise be clamped to 400 px and sit in
           the middle of a phone screen with margins on both sides. The two spans
           have to be released here - a span of two tracks in a one column grid
           creates an implicit second track and pushes the board off screen. */
        @container (max-width: 640px) {
          .board { grid-template-columns: minmax(0, 1fr); max-width: none; }
          .board > .c.plim,
          .board > .c.ems.wide { grid-column: auto; }
        }

        /* The controls inside the wide card: one control per line, read top to
           bottom. A two-column split was tried and rejected - at this width the
           Send button of each row wrapped onto a line of its own, which turned
           four compact rows into eight ragged ones. One column keeps every row
           a single line: label, range, slider, value, Send.
           No gap here: the generic "row + row" rule already draws the divider
           and the space around it. */
        .pc-list { display: flex; flex-direction: column; }

        /* The cut-off SOC card is one of the narrow ones, so its read-out width
           comes from the compact rule below rather than from the default.
           The card is a column: the head stays put and the body takes the rest,
           which is what lets a short card share its row's height instead of
           leaving a hole under itself. */
        ha-card.c { padding: 14px 16px 15px; border-radius: 16px;
                    container-type: inline-size;
                    display: flex; flex-direction: column; }
        .c-body { display: flex; flex-direction: column; min-width: 0; }
        ha-card.c > .c-head { flex: 0 0 auto; }

        /* Separator between the mode picker and whatever the mode adds. */
        .sep { height: 1px; background: var(--divider-color); margin: 13px 0; }

        /* The embedded <hoymiles-tou-editor> is a card of its own everywhere
           else; here it is just the bottom half of this one, so it gets no
           extra background and no border of its own. */
        .tou-host { margin-top: 2px; }
        .tou-host hoymiles-tou-editor { display: block; }

        .c-head { display: flex; align-items: center; gap: 9px; margin: 0 0 12px; }
        .c-head .ci { flex: 0 0 auto; display: inline-flex;
                      align-items: center; justify-content: center;
                      line-height: 1; }
        .c-head .ct { font-size: 12.5px; font-weight: 600; line-height: 1.25;
                      letter-spacing: .05em; text-transform: uppercase;
                      color: var(--primary-text-color); }
        .c-head .cs { display: block; margin-top: 3px; font-size: 12px;
                      font-weight: 400; letter-spacing: 0; text-transform: none;
                      color: var(--secondary-text-color); }

        /* ================================================================== *
         * Icon set
         *
         * Filled, multicolour SVG. Not a nested lit template (a path written
         * inside an interpolation is parsed in the HTML namespace and paints
         * nothing), but a plain SVG string injected with _untrusted(), which
         * the HTML parser puts in the SVG namespace correctly.
         *
         * The colours are the card's own vocabulary, so an icon says the same
         * thing as the control next to it: orange / green / blue are the three
         * EMS modes, amber is power, indigo is sleep, teal is a setpoint.
         * ================================================================== */
        .ic { display: inline-flex; flex: 0 0 auto;
              align-items: center; justify-content: center; line-height: 1; }
        .ic svg { display: block; }
        .c-head .ci .ic { color: inherit; }
        .r-label .ri .ic { color: inherit; }

        .c-head .sp { flex: 1 1 auto; }
        /* A card that has exactly one action (the cut-off SOC pair) keeps it in
           the header, where it belongs, instead of adding a footer row under a
           panel that is otherwise just one track. */
        .c-head .act { flex: 0 0 auto; display: inline-flex; }
        .c-head .act .btn { padding: 4px 8px; font-size: 12.5px; }
        /* The cut-off card's header word, where its Send button used to be.
           Same slot, same height, so the header does not resize when the text
           changes from the idle hint to "sent". */
        .soc-flag { font-size: 12px; line-height: 1.3; white-space: nowrap;
                    color: var(--secondary-text-color); }
        .soc-flag.ok { color: var(--success-color, #0da035); font-weight: 500; }
        .soc-flag.err { color: var(--error-color); font-weight: 500; }
        .c-head .info { flex: 0 0 auto; display: inline-flex; cursor: help;
                        color: var(--secondary-text-color); opacity: .7; }

        /* one labelled control inside a card */
        .r + .r { margin-top: 12px; padding-top: 12px;
                  border-top: 1px solid var(--divider-color); }
        .r-main { min-width: 0; }
        .r-label { display: flex; align-items: center; gap: 8px;
                   font-size: 14px; line-height: 1.3; flex-wrap: wrap;
                   color: var(--primary-text-color); }
        /* The range sits on the label line, pushed to the right: it is a fact
           about the control, not a heading of its own. */
        .r-hint { margin-left: auto; font-size: 11.5px; line-height: 1.4;
                  color: var(--secondary-text-color); white-space: nowrap; }
        /* A toggle that belongs to the whole row rather than to one field (the
           V0.6.7 group enables) sits at the very end of the label line, so the
           title, the range and the switch are read in one pass. The range gives
           up the gap it used to take from the switch, not the other way round. */
        .r-end { flex: 0 0 auto; display: inline-flex; align-items: center;
                 margin-left: 4px; }
        /* Without a range to sit behind, the switch takes the right end itself:
           the collapsed (disabled) row would otherwise tuck the toggle right
           against the label, at a different place from every other row. */
        .r-end.right { margin-left: auto; }
        .r-end ha-switch { margin: 0; }
        .r-label .ri { flex: 0 0 auto; display: inline-flex; justify-content: center;
                       align-items: center; line-height: 1;
                       color: var(--secondary-text-color); }
        .r-sub { margin: 4px 0 0 25px; font-size: 12px; line-height: 1.45;
                 color: var(--secondary-text-color); }
        .r-sub code { font-size: 11px; word-break: break-all; }
        /* A bare row has no label to indent against, and its subtitle sits
           directly above the control. */
        .r.bare > .r-sub { margin: 0 0 8px; }
        /* Without a row icon there is nothing to indent the subtitle under. */
        .r-main.noicon .r-sub { margin-left: 0; }
        .r-ctrl { margin-top: 10px; }
        .r.bare .r-ctrl { margin-top: 0; }
        .r.inline { display: flex; align-items: center; gap: 12px; }
        .r.inline .r-main { flex: 1 1 auto; }
        .r.inline .r-ctrl { flex: 0 0 auto; margin-top: 0; }
        /* A collapsed gated row (switch off) keeps the toggle on the label line
           and has nothing for the control column: hiding the empty box as well
           drops the flex gap, so that switch lines up with the one the same row
           shows when the group is on. */
        .r.inline > .r-ctrl:empty { display: none; }

        /* The on/off fields of §42 (forbid charge, forbid discharge, the
           off-grid relay) share one line: they are independent fields of ONE
           object and the things a user flips while watching the power flow, so
           three full rows pushed both sliders a screen down.

           The column count is FIXED per model, not per window: it comes from
           the number of tiles in the row (two forbid flags exist only on the
           4020 X), passed in as a variable. A container query that changed the
           column count with the window would change the card's HEIGHT with the
           window, and that is exactly the "looks different on every monitor"
           bug this card was rewritten to remove. The tiles shrink instead. */
        .fs-row { display: grid;
                  grid-template-columns: repeat(var(--fs-n, 3), minmax(0, 1fr));
                  gap: 8px; }
        .fs-row .fst { display: flex; flex-direction: column; align-items: center;
                       gap: 3px; padding: 9px 6px 7px; border-radius: 12px;
                       text-align: center; min-width: 0;
                       background: var(--secondary-background-color,
                                   rgba(127, 127, 127, 0.10)); }
        .fs-row .fst .fic { display: inline-flex; }
        .fs-row .fst .ft { font-size: 12.5px; line-height: 1.25; min-width: 0;
                           color: var(--primary-text-color); }
        .fs-row .fst .fss { font-size: 11px; line-height: 1.3; min-width: 0;
                            color: var(--secondary-text-color); }
        .fs-row .fst ha-switch { margin-top: 3px; }

        .r-sub.busy { color: var(--primary-color);
                      animation: hm-pulse 1.3s ease-in-out infinite; }
        .r-sub.done { color: var(--success-color, #0da035); font-weight: 500; }
        .r-sub.live { color: var(--primary-color); font-weight: 500; }

        /* explanatory block used when a mode has nothing to configure */
        .note { font-size: 12.5px; line-height: 1.55;
                color: var(--secondary-text-color); padding: 11px 13px;
                border-radius: 12px;
                background: var(--secondary-background-color, rgba(120,120,128,.10)); }
        .note b { color: var(--primary-text-color); font-weight: 600; }
        .note + .note { margin-top: 10px; }

        /* ================================================================== *
         * Offline notice
         *
         * A switched-off unit answers nothing, but an MQTT publish to it
         * "succeeds" - so the card says up front that nothing can be sent, dims
         * the controls and stops accepting input altogether.  Offline means the
         * unit has lost its network: no command can reach it, not even Wake,
         * because Sleep only changes what the firmware does, not whether it is
         * connected.  The refusal is also enforced in _publishRaw and
         * _callService - this is the explanation and the mechanism.
         * ================================================================== */
        .offline-note { display: flex; align-items: flex-start; gap: 8px;
                        margin: 0 0 12px; padding: 9px 12px; border-radius: 11px;
                        font-size: 12.5px; line-height: 1.5;
                        color: var(--secondary-text-color);
                        background: rgba(148, 163, 184, 0.16);
                        border-left: 3px solid rgba(148, 163, 184, 0.85); }
        .offline-note .oi { flex: 0 0 auto; display: inline-flex; margin-top: 1px;
                            color: var(--secondary-text-color); }
        /* Nothing inside the board reacts to the mouse, so a dimmed control can
           no longer be clicked "just to see" - the click used to end in a
           refusal dialog, which read as if something had been sent. */
        .wrap.offline .board { opacity: 0.6; pointer-events: none; }

        /* ================================================================== *
         * Top banner
         *
         * A note that has to outlive the success dialog - the heater's state
         * only comes back with the device's 5-minute report.  Fixed to the top
         * of the page so it is seen no matter which card the eye was on, sliding
         * down from above and leaving by itself. 
         * ================================================================== */
        .banner {
          position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
          z-index: 9999; display: flex; align-items: center; gap: 10px;
          max-width: min(720px, calc(100vw - 28px));
          padding: 10px 8px 10px 14px; border-radius: 12px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          border-left: 4px solid #f59e0b;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24), 0 0 0 1px rgba(0, 0, 0, 0.06);
          animation: hm-banner-in 0.28s cubic-bezier(0.2, 0.9, 0.3, 1);
        }
        .banner .bi { display: inline-flex; flex: 0 0 auto; color: #f59e0b; }
        .banner .bt { font-size: 13px; line-height: 1.45; }
        .banner .bx { flex: 0 0 auto; border: none; background: none;
                      color: var(--secondary-text-color); font-size: 17px;
                      line-height: 1; padding: 2px 6px; cursor: pointer; }
        @keyframes hm-banner-in {
          from { transform: translate(-50%, -160%); opacity: 0; }
          to { transform: translate(-50%, 0); opacity: 1; }
        }

        .btn-row { display: flex; flex-wrap: wrap; gap: 8px; }

        /* ================================================================== *
         * Virtual meter HTTP endpoint (§11 / §12, reachable from outside the LAN)
         *
         * Deliberately a quiet block under the setpoint: it is not a control,
         * it is the recipe for driving this card from somewhere else. Handing
         * out a URL and a secret is also the one thing on this page that must
         * look deliberate, hence the monospace key and the explicit rotate.
         *
         * Folded by default (a details element): seven lines of recipe under a
         * slider made the card read like a manual, and none of it is needed
         * once the endpoint is wired up. Closed it is one line - the same
         * pattern the TOU editor uses for its explanation.
         * ================================================================== */
        .vm-api { padding: 0; border-radius: 12px;
                  background: var(--secondary-background-color, rgba(120,120,128,.10)); }
        .vm-api > summary { display: flex; align-items: center; gap: 8px;
                            padding: 11px 13px; cursor: pointer;
                            list-style: none; font-size: 12.5px;
                            font-weight: 600; color: var(--primary-text-color); }
        .vm-api > summary::-webkit-details-marker { display: none; }
        .vm-api > summary::before { content: "\u25B8"; font-size: 11px;
                                    font-weight: 700;
                                    color: var(--secondary-text-color); }
        .vm-api[open] > summary::before { content: "\u25BE"; }
        .vm-api > summary .vm-hint { margin-left: auto; font-weight: 500;
                                     font-size: 11.5px;
                                     color: var(--secondary-text-color); }
        .vm-api .vm-body { display: flex; flex-direction: column; gap: 7px;
                           padding: 0 13px 12px; }
        .vm-api .vm-sub { font-size: 12px; line-height: 1.5;
                          color: var(--secondary-text-color); }
        .vm-api code { font-family: var(--code-font-family, monospace);
                       font-size: 11.5px; word-break: break-all; }
        .vm-api .vm-url { color: var(--primary-text-color); }
        .vm-api .vm-row { display: flex; align-items: center; gap: 8px;
                          flex-wrap: wrap; }
        .vm-api .vm-key { flex: 1 1 180px; color: var(--secondary-text-color); }
        .vm-api .vm-range { font-size: 11.5px;
                            color: var(--secondary-text-color); }
        .vm-api pre { margin: 0; padding: 8px 10px; border-radius: 9px;
                      font-family: var(--code-font-family, monospace);
                      font-size: 11px; line-height: 1.5; white-space: pre-wrap;
                      word-break: break-all; overflow-x: auto;
                      background: var(--card-background-color, #fff);
                      color: var(--primary-text-color); }

        /* ================================================================== *
         * Grouped sliders
         *
         * Some values travel in ONE message - both fan speeds, both cut-off
         * SOCs, the three phases - so they share a single Send. That button
         * hangs off the RIGHT of the block, vertically centred, which is where
         * every per-row Send sits in the power card: the eye then reads
         * "controls, then the action" in the same order everywhere, instead of
         * meeting a footer button at the bottom of two narrow cards.
         *
         * The button column is reserved on both lines, so the two tracks stay
         * exactly the same length; the read-out gives up a few pixels to make
         * room for it.
         *
         * NOTE: never write a backtick inside this css template (not even in a
         * comment) - it would terminate the template string.
         * ================================================================== */
        .slider-group { display: grid; gap: 8px; align-items: center;
                        grid-template-columns: minmax(0, 1fr) auto; }
        /* The stacked sliders share one grid, and each row melts into it, so the
           track of the second slider starts where the first one does even when
           the two tags have different widths (Charge / Discharge). */
        .slider-group .sg-rows { min-width: 0; display: grid; align-items: center;
                                 column-gap: 6px; row-gap: 6px;
                                 grid-template-columns:
                                   auto minmax(0, 1fr) auto auto; }
        .slider-group .sg-rows > .slider { display: contents; }
        .slider-group > .btn, .slider-group > .sg-act > .btn {
                               justify-self: end; padding: 6px 4px;
                               font-size: 12.5px; }
        /* A filled Send needs real horizontal padding: 4 px leaves the label
           touching both edges of its own blue rectangle. */
        .slider-group > .btn.primary, .slider-group > .sg-act > .btn.primary {
                               padding: 6px 13px; }
        /* V0.6.7: a gated group (feed-in, per-phase house input) keeps its
           enable switch on the LABEL line (see the r-end rule above), not here:
           a switch governs the whole group, so it belongs beside the heading.
           What stays in this column is the Send button alone, centred against
           the sliders exactly like every other row's Send. */
        .sg-act { display: grid; gap: 6px; justify-items: end;
                  align-content: center; }
        .sg-act ha-switch { margin: 0; }
        /* Stacked values inside the narrow cards sit a little tighter. */
        .slider.compact { gap: 6px; }

        /* Target packs of the heater: one chip per pack the unit actually has.
           Several can be on at once, so these are toggles, not the exclusive
           mode picker - they only reuse the .seg look because they are the same
           kind of control. A selected chip gets a tick, which is what tells a
           multi-select apart from a one-of-N picker at a glance.
           The row carries no Send of its own, so the chips span the full card
           width and the card's single Send sits on the setpoint below. */
        .heat-packs { flex-wrap: wrap; width: 100%; }
        .heat-packs button { flex: 1 1 0; min-width: 44px; padding: 6px 8px;
                             text-align: center; }
        .heat-packs button.on::before { content: "✓"; margin-right: 4px;
                                        font-size: 11px; opacity: .85; }

        /* The fan card keeps the mode picker at the top and gives everything
           below it to what the mode means: the speed sliders in manual, an
           explanation otherwise.
           The two blocks are ONE control, not two separate controls: the picker
           chooses which body the card shows. So the generic row separator is
           switched off here - it was adding 12 px of padding plus a 1 px rule on
           top of the body's own 12 px gap, which is what opened a 24 px band
           between the picker and the sliders (with a stray hairline inside it)
           and made this card read as taller than the two beside it.
           This rule has to be more specific than ".r + .r", hence the full
           ha-card.c.fan > .c-body path. */
        ha-card.c.fan > .c-body { justify-content: flex-start; gap: 12px; }
        ha-card.c.fan > .c-body > .r + .r { margin-top: 0; padding-top: 0;
                                           border-top: 0; }
        /* The heating card has exactly the same shape - a mode picker that
           chooses the body under it (watts or degrees) - so it shares the rule
           rather than carrying a copy of this comment and these numbers. */
        ha-card.c.heat > .c-body { justify-content: flex-start; gap: 12px; }
        ha-card.c.heat > .c-body > .r + .r { margin-top: 0; padding-top: 0;
                                            border-top: 0; }
        .c-hint { flex: 1 1 auto; display: flex; align-items: center;
                  font-size: 12.5px; line-height: 1.55;
                  color: var(--secondary-text-color); }

        /* ================================================================== *
         * Cut-off SOC: one track, two handles
         *
         * Discharging stops on the LEFT, charging on the RIGHT, on a single
         * 10..100 % track - so "charge stops above discharge" is true by
         * construction rather than something the card has to police. The stretch
         * between the two handles is painted, because THAT is the live band the
         * battery actually uses, and seeing it is the whole point of the design.
         *
         * Two native <input type="range"> elements are stacked on the same rail.
         * Each one is fully transparent and pointer-events: none, except for its
         * thumb: that keeps dragging, the keyboard and touch native, while the
         * browser provides the thumb hit areas. No JS pointer maths, no custom
         * drag code to get wrong.
         *
         * --lo and --hi are unitless 0..1 fractions; the positions use the same
         * px/percent mix as the single slider, with a 22 px thumb.
         *
         * NOTE: never write a backtick inside this css template (not even in a
         * comment) - it would terminate the template string.
         * ================================================================== */
        .duo-cols { display: grid; align-items: center;
                    grid-template-columns: minmax(0, 1fr) 1px minmax(0, 1fr); }
        .duo-col { display: flex; flex-direction: column; align-items: center;
                   gap: 2px; min-width: 0; }
        .duo-col.lo { padding-right: 9px; }
        .duo-col.hi { padding-left: 9px; }
        .duo-div { width: 1px; align-self: stretch; margin: 5px 0;
                   background: var(--divider-color); }
        .duo-num { display: inline-flex; align-items: baseline; gap: 4px;
                   font-size: 22px; font-weight: 600; line-height: 1.1;
                   font-variant-numeric: tabular-nums; }
        .duo-num .ic { align-self: center; margin-right: 1px; }
        .duo-num .u { font-size: 14px; font-weight: 600; opacity: .95; }
        .duo-col.lo .duo-num { color: #f59e0b; }
        .duo-col.hi .duo-num { color: #16a34a; }
        .duo-cap { font-size: 11.5px; line-height: 1.25; text-align: center;
                   color: var(--secondary-text-color); }

        .duo-track { position: relative; height: 26px; margin: 7px 0 0; }
        .duo-rail, .duo-band { position: absolute; top: 50%; height: 6px;
                               border-radius: 3px; transform: translateY(-50%); }
        .duo-rail { left: 0; right: 0; background: var(--divider-color); }
        .duo-band { left: calc(11px + (100% - 22px) * var(--lo, 0));
                    width: calc((var(--hi, 1) - var(--lo, 0)) * (100% - 22px));
                    background: var(--primary-color); }
        .duo-track input[type="range"] {
          position: absolute; left: 0; top: 0; width: 100%; height: 100%;
          margin: 0; background: none; pointer-events: none;
          -webkit-appearance: none; appearance: none;
        }
        .duo-track input[type="range"]::-webkit-slider-runnable-track {
          height: 6px; background: none; border: none;
        }
        .duo-track input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none; pointer-events: auto;
          width: 22px; height: 22px; margin-top: -8px; border-radius: 50%;
          border: 3px solid var(--primary-color); cursor: grab;
          background: var(--card-background-color, #fff);
          box-shadow: 0 1px 4px rgba(0, 0, 0, .22);
        }
        .duo-track input[type="range"]::-webkit-slider-thumb:active { cursor: grabbing; }
        .duo-track input[type="range"]::-moz-range-track {
          height: 6px; background: none; border: none;
        }
        .duo-track input[type="range"]::-moz-range-thumb {
          pointer-events: auto; width: 16px; height: 16px; border-radius: 50%;
          border: 3px solid var(--primary-color); cursor: grab;
          background: var(--card-background-color, #fff);
          box-shadow: 0 1px 4px rgba(0, 0, 0, .22);
        }
        .duo-scale { display: flex; justify-content: space-between;
                     margin-top: 1px; font-size: 11.5px;
                     color: var(--secondary-text-color);
                     font-variant-numeric: tabular-nums; }

        /* In a three-up row the card can be only ~200 px wide even on a wide
           screen, which leaves ~60 px per side. The number then has to give up
           some size, or the two halves collide over the divider. The caption is
           allowed to wrap instead of pushing the columns apart.
           MUST stay after the base rules: a container query adds no specificity,
           so source order is what makes it win. */
        @container (max-width: 219px) {
          .duo-col.lo { padding-right: 5px; }
          .duo-col.hi { padding-left: 5px; }
          .duo-num { font-size: 18px; gap: 3px; }
          .duo-num .u { font-size: 12px; }
          .duo-num .ic svg { width: 16px; height: 16px; }
          /* The caption is two lines at this width, and sometimes only one
             wraps - a fixed two-line box keeps the two halves level either
             way. */
          .duo-cap { min-height: 2.5em; }
        }

        /* A three-up row can leave a card only ~200 px wide even on a wide
           screen, and there is no room for a button beside a slider then: the
           track would collapse to nothing. The grouped rows react to the width
           of the CARD (container query, see container-type on ha-card) rather
           than of the window, and in that case the one shared button drops under
           the sliders, right aligned, exactly as it used to be. The threshold is
           the card's CONTENT width: below ~215 px the tag, read-out, unit and
           button no longer leave room for a usable track.
           This block MUST stay after the base rules above: a container query
           does not raise specificity, so source order is what makes it win. */
        @container (max-width: 214px) {
          .slider-group { grid-template-columns: minmax(0, 1fr); }
          /* Same reason: the sleep row keeps its buttons on the right only
             while there is a text column left to describe them. Narrower than
             this the two buttons eat the whole line, so they stack. */
          .r.inline { display: block; }
          .r.inline .r-ctrl { margin-top: 10px; }
        }

        /* The mode selector fills the card, so three long labels never spill. */
        .seg.fluid { display: flex; width: 100%; flex-wrap: nowrap; }
        .seg.fluid button { flex: 1 1 0; min-width: 0; text-align: center;
                            overflow: hidden; text-overflow: ellipsis; }
        /* A three-option picker is ALWAYS one row, at every width (the five-way
           EMS picker is the one exception, see ems5 below - it has labels that
           do not fit at 50 px each). A rule that wrapped the three-way pickers
           to two rows below 330 px of card content was tried and removed: it
           made the card's HEIGHT depend on the window width, so the same page
           grew a second row of buttons - and a band of empty space under it -
           when the window happened to be a few pixels narrower. That is the
           exact class of bug this page exists to avoid (one monitor fine, the
           other one broken). Below ~305 px of content the longest label is
           truncated to "M..." instead; a truncated label is a smaller problem
           than a card whose height changes with the window. */

        /* ------------------------------------------------------------------ *
         * EMS mode picker: five labels, and one of them is long
         *
         * Five equal buttons in a 300 px card leave about 50 px each, which
         * truncates every label to two characters - the user cannot tell which
         * mode is which. So this ONE picker wraps into 3 + 2 instead.
         *
         * A plain flex-wrap would leave the second line ragged (two buttons at
         * a third of the width, half the row empty). A six-track grid fixes
         * that without any width maths: the first three buttons take two tracks
         * each (three per line) and the last two take three each, so the second
         * line fills the row exactly. Source order is preserved, so the picker
         * still reads in protocol order.
         *
         * Wrapping is NOT a window-width accident here: the card itself grows
         * when the selected mode adds controls (the .wide class spans two
         * tracks), and a card with room puts the five back on one line. That is
         * a container query, so it follows the card and not the monitor.
         * ------------------------------------------------------------------ */
        .seg.fluid.ems5 { display: grid; flex-wrap: nowrap;
                          grid-template-columns: repeat(6, minmax(0, 1fr)); }
        .seg.fluid.ems5 button { min-width: 0; padding: 5px 4px; font-size: 12.5px; }
        .seg.fluid.ems5 button:nth-child(-n+3) { grid-column: span 2; }
        .seg.fluid.ems5 button:nth-child(n+4) { grid-column: span 3; }
        /* Width of the CARD's content box. Below this the five cannot be shown
           in full; above it one line fits and the extra row would be waste.
           :nth-child(n) is there for specificity only - it matches every
           button, exactly like the span rules above, so this later rule wins
           without an !important. */
        @container (min-width: 520px) {
          .seg.fluid.ems5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
          .seg.fluid.ems5 button:nth-child(n) { grid-column: span 1; }
        }

        /* ================================================================== *
         * Progress dialog
         *
         * Rendered outside the grid (fixed overlay) so it is never clipped by a
         * card and never affected by the card grid's layout. One step per thing
         * the command has to do; the dialog closes itself once every step is
         * done, and stays open with the reason when one fails.
         * ================================================================== */
        .overlay { position: fixed; inset: 0; z-index: 9999;
                   display: flex; align-items: center; justify-content: center;
                   padding: 20px; background: rgba(0,0,0,.34);
                   backdrop-filter: blur(3px);
                   -webkit-backdrop-filter: blur(3px); }
        .modal { width: min(430px, 100%); box-sizing: border-box;
                 padding: 20px 22px 18px; border-radius: 18px;
                 background: var(--card-background-color, #fff);
                 color: var(--primary-text-color);
                 box-shadow: 0 18px 48px rgba(0,0,0,.28); }
        .modal .m-title { display: flex; align-items: center; gap: 9px;
                          font-size: 15px; font-weight: 600; }
        .modal .m-sub { margin-top: 4px; font-size: 12.5px; line-height: 1.45;
                        color: var(--secondary-text-color); }
        .pbar { position: relative; height: 5px; margin: 14px 0 12px;
                border-radius: 999px; overflow: hidden;
                background: var(--secondary-background-color, rgba(120,120,128,.18)); }
        .pbar .pfill { height: 100%; width: 0; border-radius: 999px;
                       background: var(--primary-color);
                       transition: width .28s ease; }
        .modal.err .pbar .pfill { background: var(--error-color); }
        .modal.ok .pbar .pfill { background: var(--success-color, #0da035); }

        .steps { display: flex; flex-direction: column; gap: 7px;
                 font-size: 13px; line-height: 1.4; }
        .steps .st { display: flex; align-items: flex-start; gap: 9px;
                     color: var(--secondary-text-color); }
        .steps .st .mk { flex: 0 0 16px; display: inline-flex;
                         justify-content: center; font-size: 12px;
                         line-height: 1.5; }
        .steps .st.active { color: var(--primary-text-color); font-weight: 500; }
        .steps .st.done { color: var(--primary-text-color); }
        .steps .st.done .mk { color: var(--success-color, #0da035); }
        .steps .st.failed { color: var(--error-color); }
        .steps .st .spin { width: 12px; height: 12px; margin-top: 1px;
                           border-radius: 50%;
                           border: 2px solid var(--primary-color);
                           border-right-color: transparent;
                           animation: hm-spin .8s linear infinite; }

        .m-msg { margin-top: 14px; font-size: 12.5px; line-height: 1.5;
                 padding: 10px 12px; border-radius: 11px;
                 background: var(--secondary-background-color, rgba(120,120,128,.12)); }
        .modal.err .m-msg { color: var(--error-color);
                            background: rgba(219, 68, 55, .12); }
        .m-foot { display: flex; justify-content: flex-end; gap: 8px;
                 margin-top: 14px; }
        /* A confirmation is not a progress dialog: no bar, just the question. */
        .modal.confirm .m-msg { margin-top: 10px; }

        @keyframes hm-spin { to { transform: rotate(360deg); } }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-control: 'dev_id' is required");
      }
      this._config = { ...config };
      /* A new config may point at another device, so the resolved entities have
         to be looked up again. */
      this._cache.clear();
      this._initialised = false;
      /* The V0.6.2 drafts belong to the old device: another unit has other
         limits, and re-seeding only works from an empty draft. */
      this._fanPcs = "";
      this._fanBat = "";
      this._heatPower = "";
      this._heatPacks = [];
      this._pvPower = "";
      this._inputPower = "";
      this._gridP = "";
      this._meterP = "";
      this._meterOut = "";
      this._meterIn = "";
      this._socH = "";
      this._socL = "";
      this._socDirty = false;
      this._seenDraft = {};
      this._fanModePending = null;
      this._heatModePending = null;
      this._emsPending = null;
      this._clearRepeatTimers();
      this._repeatSynced = false;
      this._repeatSeeded = false;
      this._repeatState = null;
      this._lastEmsMode = undefined;
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._initialised) this._seedInputs();
      /* The V0.6.2 entities show up a few seconds after the first state event
         (the firmware publishes their discovery configs on connect, right after
         the retained state). Retry for a short while, then stop: an entity that
         is still missing after that belongs to a device that does not have it,
         and every retry is a scan over the whole state machine. */
      this._seedTries = (this._seedTries || 0) + 1;
      if (this._seedTries <= 20) this._seedLimits();
      /* Seeding only runs for the first few updates, so it cannot be what keeps
         a draft in step with the device - see `_syncDrafts`. */
      this._syncDrafts();
      /* Ask the integration whether a setpoint is still being re-published.
         This is what makes the card survive a page change: a fresh instance
         has no memory of its own, but the timer kept running on the server. */
      if (!this._repeatSynced) {
        this._repeatSynced = true;
        this._syncRepeat();
      }
      this._reconcileSwitch();
      this._reconcileEmsMode();
      this.requestUpdate();
    }

    getCardSize() {
      /* A grid of independent cards: roughly two columns of three rows on a
         desktop dashboard. Lovelace only uses this as a hint. */
      return 10;
    }

    /**
     * Language changes are announced on `window`; re-rendering is all a card
     * has to do, because the wording is chosen while it renders.
     */
    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
    }

    disconnectedCallback() {
      window.removeEventListener(LANG_EVENT, this._onLangChange);
      super.disconnectedCallback();
      if (this._toastTimer) clearTimeout(this._toastTimer);
      if (this._bannerTimer) clearTimeout(this._bannerTimer);
      if (this._pendingTimer) clearTimeout(this._pendingTimer);
      if (this._busyTimer) clearTimeout(this._busyTimer);
      if (this._socSentTimer) clearTimeout(this._socSentTimer);
      /* Only the local display timers are cleared here. The repeat runs in the
         integration and must outlive the card - that is the whole point. */
      this._clearRepeatTimers();
      this._clearLeaseTimers();
      this._repeatSynced = false;
      this._leaseQueried = {};
    }

    updated() {
      /* The TOU editor is a real custom element hosted inside the EMS card, so
         it needs its config and the current `hass` handed over by hand: Lit
         binds properties, but this one is a Lovelace card with `setConfig`.
         Done here (not in render) because the element only exists after the
         template has been committed. */
      this._syncTouEditor();
      this._watchEmsMode();
      /* The setpoint block of the active mode asks the server once per
         connection whether a repeat is still running - see `_watchLease`. */
      this._watchLease();
      /* Same idea for the virtual meter's HTTP recipe, which only exists in
         `meter_ctrl`. */
      this._watchVmInfo();
      /* While a countdown is actually running, wake up once a second so the
         sub-line stays honest. One timer at a time; the timeout is what keeps a
         hidden tab from queuing thousands of frames.  `meter_ctrl` is included
         unconditionally: its read-outs and push counter come from the server and
         would otherwise only refresh on a device message. */
      if (this._repeatActive() || this._leaseRunning("meter_ctrl")
        || this._leaseRunning("fine_ctrl") || this._emsMode() === "meter_ctrl") {
        if (this._repeatUiTimer) clearTimeout(this._repeatUiTimer);
        this._repeatUiTimer = setTimeout(() => {
          this._repeatUiTimer = null;
          if (this.isConnected) this.requestUpdate();
        }, 1000);
      }
    }

    /**
     * Follow EMS mode changes and reset the setpoint accordingly.
     *
     * `mqtt_ctrl` is the only mode where a setpoint means anything, so leaving
     * it ends the repeat (the integration does that itself the moment the mode
     * is published - see `coordinator._async_stop_repeat_if_needed`). Coming
     * back therefore starts from a blank slate: keeping the previous draft
     * would look like the old setpoint was still in force and, worse, one press
     * of Send would silently resume it.
     */
    _watchEmsMode() {
      const mode = this._emsMode();
      const prev = this._lastEmsMode;
      if (mode === prev) return;
      this._lastEmsMode = mode;

      /* Only a real switch between two known modes counts. Before the select
         entity has a state the mode reads "" and then arrives as whatever the
         device reports - treating that as a return to MQTT control would reset
         the draft on every page reload. */
      if (prev !== "mqtt_ctrl" && prev !== "general" && prev !== "tou_plan") return;

      /* §12 / §42 are leases too, and the integration stops them the moment
         their mode is left (`coordinator._async_stop_repeat_if_needed`). Drop the
         local mirror at the same time so the block cannot come back showing a
         countdown for a job that no longer exists. */
      if (mode !== "meter_ctrl") this._dropLease("meter_ctrl");
      if (mode !== "fine_ctrl") this._dropLease("fine_ctrl");

      if (mode !== "mqtt_ctrl") {
        /* Leaving MQTT control. Drop the local mirror so the row cannot claim a
           countdown that the server no longer runs. */
        this._repeatState = null;
        this._clearRepeatTimers();
        this.requestUpdate();
        return;
      }

      /* Back in MQTT control: default draft, nothing running. */
      this._repeatState = null;
      this._repeatSeeded = false;
      this._repeatOn = true;
      this._powerCtrl = "0";
      this._repeatEvery = String(REPEAT_DEFAULT_S);
      /* Keep `_seedInputs` from putting the stale entity value back. */
      this._initialised = true;
      this._clearRepeatTimers();
      this._syncRepeat();
      this.requestUpdate();
    }

    /* ----------------------------- lookups ----------------------------- */

    _t(en, zh) {
      return hmPick(hmLang(this._hass, this._config), en, zh);
    }

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, hmLang(this._hass, this._config));
    }

    _dev() {
      return this._config.dev_id;
    }

    /**
     * Resolve an entity by protocol key.
     *
     * The firmware's MQTT discovery uses `<dev_id>_<key>` unique ids, while the
     * integration's own entities use `hoymiles_<dev_id>_<key>`; entity ids are
     * slugified from the *name*, so they are matched normalized.
     */
    _resolve(key, domain = "number", strict = false) {
      const overrides = this._config.entities || {};
      if (overrides[key]) return overrides[key];

      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const cacheKey = `${domain}:${key}`;
      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached]) return cached;

      let found = null;
      const wantUid = new Set([
        `${this._dev()}_${key}`,
        `hoymiles_${this._dev()}_${key}`,
      ]);
      for (const [entityId, entry] of Object.entries(hass.entities || {})) {
        if (!entry || !entityId.startsWith(`${domain}.`)) continue;
        // A unique_id match is only useful when the entity still exists: the
        // registry keeps entries for entities a platform no longer creates
        // (removed by an upgrade), and those have no state at all.  Picking one
        // made a perfectly good replacement look "unknown".
        if (!hass.states[entityId]) continue;
        if (wantUid.has(entry.unique_id)) { found = entityId; break; }
      }

      // The integration's own entities are named after the *device name*, which
      // the user may have renamed to anything (`number.g3_msa_...`). Match on
      // the SN inside the id, which survives a rename, and try every spelling
      // the key is known to take.
      //
      // The tail after the SN must equal the alias EXACTLY (normalized). A plain
      // `endsWith("_output_power")` looked right until a device also published
      // `phase_a_output_power` - which ends with the very same characters, and
      // being picked as "output power" made the row read the per-phase entity
      // (state `unknown`), fall back to the protocol defaults (100 ~ 2000 W) and
      // seed the slider at 100 W instead of the 492 W the device actually
      // reports on `event/state`.
      if (!found) {
        const serial = serialOf(this._dev());
        const candidates = Object.keys(hass.states).filter(
          (entityId) => entityId.startsWith(`${domain}.`) && entityId.includes(serial)
        );
        for (const alias of ENTITY_ALIASES[key] || [key]) {
          const want = norm(alias);
          const hit = candidates.find((entityId) => {
            const at = entityId.indexOf(serial);
            if (at < 0) return false;
            return norm(entityId.slice(at + serial.length)) === want;
          });
          if (hit) { found = hit; break; }
        }
      }

      if (!found) {
        const prefix = `${domain}.${slug(this._dev())}`;
        const wanted = norm(key);
        for (const entityId of Object.keys(hass.states)) {
          if (!entityId.startsWith(prefix)) continue;
          const tail = norm(entityId.slice(prefix.length + 1));
          if (tail !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      // The firmware's own number entities are unhelpfully named: the MQTT
      // discovery topics carry the object id (power_ctrl / output_power /
      // phase_output_power) but HA names all three after the device, so their
      // entity ids collapse to `number.<dev>`, `number.<dev>_2`, `_3 ...` and
      // neither the friendly name nor the registry snapshot distinguishes them
      // (HA does not expose unique_id to the frontend). They are published in a
      // fixed order, so fall back to the index. `entities` in the card config
      // overrides this when a deployment ever differs.
      if (!found && domain === "number") {
        const index = NUMBER_ORDER.indexOf(key);
        if (index >= 0) {
          const base = `${domain}.${slug(this._dev())}`;
          // `number.<dev>`, `number.<dev>_2`, `number.<dev>_3`, ...
          // The device SN is numeric too, so the duplicate suffix must be short
          // (`_2`), never the SN itself (`number.<dev>_280520260806`).
          const numbered = Object.keys(hass.states).filter((entityId) => {
            if (entityId === base) return true;
            return new RegExp(`^${base.replace(/\./g, "\\.")}_\\d{1,2}$`).test(entityId);
          });
          const order = (entityId) => {
            if (entityId === base) return 0;
            const m = entityId.match(/_(\d+)$/);
            return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
          };
          numbered.sort((a, b) => order(a) - order(b));
          if (numbered[index]) found = numbered[index];
        }
      }

      // Last resort for the single-instance domains: the discovery name does not
      // always map back to the protocol key (`ems_mode` is published as
      // `select.<dev>_mqtt_select`, and the switch as `<dev>_mqtt_switch`). Those
      // domains carry exactly one entity per device, so there is nothing to guess.
      // `number` is deliberately excluded - it has several entities and a wrong
      // pick would display (and send) a different setting's value.
      const hints = (RESOLVE_HINTS[domain] || {})[key];
      if (!found && hints) {
        const prefix = `${domain}.${slug(this._dev())}`;
        const candidates = Object.keys(hass.states)
          .filter((entityId) => entityId.startsWith(prefix));
        for (const hint of hints) {
          const hit = candidates.find((entityId) =>
            norm(entityId.slice(prefix.length + 1)).includes(norm(hint)));
          if (hit) { found = hit; break; }
        }
      }

      if (!found && !strict && SINGLE_ENTITY_DOMAINS.includes(domain)) {
        const prefix = `${domain}.${slug(this._dev())}`;
        const candidates = Object.keys(hass.states)
          .filter((entityId) => entityId.startsWith(prefix));
        if (candidates.length === 1) found = candidates[0];
      }

      if (found) this._cache.set(cacheKey, found);
      return found;
    }

    _state(key, domain = "number") {
      const entityId = this._resolve(key, domain);
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const value = String(state.state);
      if (value === "" || value === "unknown" || value === "unavailable") return null;
      return state;
    }

    /**
     * Is the device itself offline?
     *
     * Same rule as the power-flow card: the integration marks the fast topics'
     * entities `unavailable` once nothing has arrived for a minute, and a freshly
     * started Home Assistant shows `unknown` until the first payload lands.
     * The first entity that exists decides - a *missing* entity (older firmware)
     * is not an offline device.
     *
     * This matters for more than cosmetics: nothing stops an MQTT publish to a
     * powered-off unit, so without this check the card happily "sends" a fan
     * setting into the void and reports success.
     */
    _deviceOffline() {
      if (!this._hass) return false;
      for (const [key, domain] of [
        ["soc", "sensor"],
        ["system_pv_power", "sensor"],
        ["pv_power", "sensor"],
        ["battery_status", "sensor"],
      ]) {
        const entityId = this._resolve(key, domain);
        if (!entityId) continue;
        const state = (this._hass.states || {})[entityId];
        if (!state) continue;
        return state.state === "unavailable" || state.state === "unknown";
      }
      return false;
    }

    /* ---------------------------- device model --------------------------- */

    /**
     * The device this card looks at, from the device registry.
     *
     * `dev_id` is the identifier the firmware publishes, which is exactly what
     * the device's `identifiers` carry, so no entity lookup is needed.  A unit
     * can be registered twice (the MQTT discovery device and the integration's
     * own) and only one of them knows the model, so prefer whichever has it.
     */
    _device() {
      const hass = this._hass;
      if (!hass || !hass.devices) return null;
      const wanted = String(this._dev() || "").toLowerCase();
      if (!wanted) return null;

      let fallback = null;
      for (const device of Object.values(hass.devices)) {
        if (!device) continue;
        const hit = (device.identifiers || []).some(
          (pair) => pair && String(pair[1] || "").toLowerCase() === wanted);
        if (!hit) continue;
        if (device.model) return device;
        if (!fallback) fallback = device;
      }
      return fallback;
    }

    /** Model as reported by the device ("HiBattery 4020 X"), or null. */
    _model() {
      const device = this._device();
      return device && device.model ? String(device.model) : null;
    }

    /**
     * Whether this unit implements the **extra** fine control fields (§41/§42).
     *
     * The block itself is on every model, but the PV ceiling and the two forbid
     * flags are only implemented on the `HiBattery 4020 X`.  The AC coupled
     * cabinets (`4020 AC`, `1920 AC`) have no MPPT input of their own to put a
     * ceiling on, and the `MS-A2` cabinet does not implement either flag - a
     * control that the firmware ignores is worse than no control, because it
     * looks like a setting that was accepted.
     *
     * Matched on the model with punctuation removed, like `_chassis()` in the
     * battery card, and an **unknown** model keeps every row: hiding a control
     * that really exists is the worse mistake, and the registry entry is not
     * always backfilled yet when the page first renders.
     */
    _allowFineExtras() {
      const model = this._model();
      if (!model) return true;
      const key = String(model).toLowerCase().replace(/[\s_-]+/g, "");
      if (key.indexOf("4020x") >= 0) return true;
      const without = [
        "msa2",
        "hibatterymsa2",
        "hibattery1920ac",
        "hibattery4020ac",
      ];
      return without.indexOf(key) < 0;
    }

    /* ---------------------------- device role ---------------------------- */

    /**
     * The role the device reports (§32 `role`): `single`, `master` or `slave`.
     *
     * Every V0.6.5 topic carries a 角色 line, and a **slave** is excluded from a
     * large group of them.  The integration already turns those entities
     * `unavailable`; this card additionally stops *showing* controls that cannot
     * work, because an unavailable slider still looks like a slider.
     *
     * An empty string means "not reported yet".  Everything is shown in that
     * case: hiding a whole page until the retained state event lands would be
     * worse than briefly offering a control the unit then turns out not to own.
     */
    _role() {
      const state = this._state("device_role", "sensor");
      return state ? String(state.state) : "";
    }

    /** True only when the unit says it is a slave. */
    _isSlave() {
      return this._role() === "slave";
    }

    /** May this unit use the 角色: 主机和单机 topics (§9-§12, §15-§22, §25, §26, §45)? */
    _allowMaster() {
      return !this._isSlave();
    }

    /**
     * May it use a 角色: 仅主机 topic (§29/§30)?
     *
     * Stricter than `_allowMaster()`: a **single** unit is excluded too.  An
     * unreported role stays allowed, like everywhere else on this card, so the
     * row does not flicker while the state event is still on its way.
     */
    _allowMasterOnly() {
      const role = this._role();
      return role === "" || role === "master";
    }

    /**
     * May it use the 角色: 仅多相主机 topic (§23/§24)?
     *
     * §32 publishes `phase_output_power` only on a multi phase master, and the
     * integration mirrors it onto the three phase numbers - so "reported" is the
     * exact capability test, not a model name.
     */
    _allowPhase() {
      if (!this._allowMaster()) return false;
      return ["a", "b", "c"].some(
        (p) => this._state(`phase_${p}_output_power`) != null
      );
    }

    _number(key) {
      const state = this._state(key, "number");
      return state ? num(state.state) : null;
    }

    _attr(key, domain, name) {
      const state = this._state(key, domain);
      return state && state.attributes ? state.attributes[name] : null;
    }

    _topic(suffix) {
      return `homeassistant/${suffix.replace("<dev_id>", this._dev())}`;
    }

    /** Pre-fill the inputs from the device the first time we see it.
     *
     * Values are clamped to the entity's own range: an unconfigured entity often
     * reports `0`, which is outside e.g. output_power's `100 ~ 2000 W`. Without
     * the clamp the slider would sit at its minimum while the read-out showed the
     * out-of-range number, and the two would disagree.
     */
    /**
     * Round a number to the resolution the control actually sends.
     *
     * The firmware stores these setpoints as single-precision floats, so a
     * value we sent as `-158.3` comes back in `event/state` as
     * `-158.300003051758` - a float32 rounding artefact, not a different
     * number. Drawing that in the read-out made the card look like it had
     * ignored the input, so every draft read from the device is snapped back to
     * the step it will be sent with (0.1 W for the two power setpoints, whole
     * watts / levels / percent for the rest).
     */
    _round(value, decimals) {
      const v = Number(value);
      if (!Number.isFinite(v)) return value;
      const f = Math.pow(10, decimals || 0);
      return Math.round(v * f) / f;
    }

    _seedInputs() {
      if (!this._hass || !this._hass.states) return;
      const pc = this._number("power_ctrl");
      const op = this._number("output_power");
      if (pc != null) {
        const b = this._bounds("power_ctrl", -1000, 1000);
        this._powerCtrl = String(this._round(this._clamp(pc, b.lo, b.hi), 1));
      }
      if (op != null) {
        const b = this._bounds("output_power", 100, 2000);
        this._outputPower = String(this._clamp(op, b.lo, b.hi));
      }
      const phases = ["a", "b", "c"];
      let any = false;
      for (const p of phases) {
        const value = this._number(`phase_${p}_output_power`)
          ?? this._number("phase_output_power");
        if (value != null) {
          const b = this._bounds("phase_a_output_power", 100, 2500);
          this._phase[p] = String(this._clamp(value, b.lo, b.hi));
          any = true;
        }
      }
      if (pc == null && op == null && !any) return; // nothing to seed yet
      this._initialised = true;
    }

    /**
     * Pre-fill the V0.6.2 drafts from whatever the device reports.
     *
     * Kept apart from `_seedInputs` because it runs on its own schedule: these
     * entities appear a few seconds later than the power ones (the firmware
     * publishes the new discovery configs after the state event), so gating them
     * on the same "already seeded" flag would leave the sliders empty on a unit
     * that is still waking up.
     */
    _seedLimits() {
      if (!this._hass || !this._hass.states) return;
      const put = (field, value, lo, hi, decimals = 0) => {
        if (value == null || this[field] !== "") return;
        this[field] = String(this._round(this._clamp(value, lo, hi), decimals));
      };
      put("_fanPcs", this._number("pcs_fan_speed"), FAN_SPEED.lo, FAN_SPEED.hi);
      put("_fanBat", this._number("battery_fan_speed"), FAN_SPEED.lo, FAN_SPEED.hi);
      /* The heater's range depends on its mode, so seed against the range that
         mode implies instead of clamping a 25 °C target into a 175 W band.  The
         LIVE mode is the one the reported number belongs to. */
      const heatRange = this._heatModeLive() === "temp" ? HEAT_TEMP : HEAT_POWER;
      put("_heatPower", this._number("heat_param"), heatRange.lo, heatRange.hi);
      put("_pvPower", this._number("pv_power_limit"), PV_POWER.lo, PV_POWER.hi);
      put("_gridP", this._number("fine_grid_power"),
        GRID_POWER.lo, GRID_POWER.hi, 1);
      put("_meterP", this._number("meter_power"), METER_CTRL.lo, METER_CTRL.hi, 1);
      /* The entity ids follow the *names* ("Meter Output Energy"), not the
         description keys, so these two are resolved by name. */
      put("_meterOut", this._number("meter_output_energy"),
        METER_ENERGY.lo, METER_ENERGY.hi);
      put("_meterIn", this._number("meter_input_energy"),
        METER_ENERGY.lo, METER_ENERGY.hi);
      put("_inputPower", this._number("input_power"),
        INPUT_POWER.lo, INPUT_POWER.hi);
      put("_feedPower", this._number("feed_power"),
        FEED_POWER.lo, FEED_POWER.hi);
      /* V0.6.6 §27 / §31: the two new per phase groups keep their boxes in an
         object (like `_phase`), so they cannot use `put()`; the output group is
         seeded by `_seedInputs`. */
      for (const spec of PHASE_LIMITS.slice(1)) {
        const draft = this[spec.draft];
        ["a", "b", "c"].forEach((p, i) => {
          const value = this._number(spec.keys[i]);
          if (value == null || draft[p] !== "") return;
          draft[p] = String(this._clamp(value, PHASE_BAND.lo, PHASE_BAND.hi));
        });
      }
      put("_socH", this._number("charge_soc_limit"),
        SOC_CHARGE.lo, SOC_CHARGE.hi);
      put("_socL", this._number("discharge_soc_limit"),
        SOC_DISCHARGE.lo, SOC_DISCHARGE.hi);
    }

    /**
     * Make every draft follow a value the **device** changed.
     *
     * Each control on this card is a draft: the user sets it, then presses Send
     * (or releases a handle), and only then does it reach the device. A draft
     * must therefore not follow the device while it is being edited - but it
     * must follow as soon as the device reports a value the user did not type.
     *
     * That second half was missing. `_seedLimits` fills a draft only while it is
     * still empty and only for the first twenty updates, so after the initial
     * fill nothing ever looked at the device again. Changing the cut-off SOC in
     * the vendor app did update the HA entity (`event/state` is republished, the
     * history shows every step), yet the card kept drawing the old pair - which
     * reads exactly like "HA did not pick it up" even though it had.
     *
     * The rule is a change detector, not a hard sync: the first sighting of a
     * value only fills an empty draft, and after that a draft is replaced only
     * when the device value actually moved. A field held by the user (the SOC
     * handles mid-drag) is skipped entirely until it is released.
     */
    _syncDrafts() {
      if (!this._hass || !this._hass.states) return;

      const track = (field, device, lo, hi, decimals = 0) => {
        if (device == null) return;
        const next = String(this._round(this._clamp(device, lo, hi), decimals));
        const prev = this._seenDraft[field];
        this._seenDraft[field] = next;
        if (prev === undefined) {
          /* First sighting: seeding owns this, only fill an empty draft. */
          if (this[field] === "") this[field] = next;
          return;
        }
        if (prev === next) return;   /* the device did not move */
        this[field] = next;
      };

      /* A handle that is being dragged owns its draft; skip the pair until the
         finger is lifted, otherwise a state update would yank it back mid-drag. */
      if (!this._socDirty) {
        track("_socH", this._number("charge_soc_limit"),
          SOC_CHARGE.lo, SOC_CHARGE.hi);
        track("_socL", this._number("discharge_soc_limit"),
          SOC_DISCHARGE.lo, SOC_DISCHARGE.hi);
      }

      track("_fanPcs", this._number("pcs_fan_speed"), FAN_SPEED.lo, FAN_SPEED.hi);
      track("_fanBat", this._number("battery_fan_speed"), FAN_SPEED.lo, FAN_SPEED.hi);
      track("_pvPower", this._number("pv_power_limit"), PV_POWER.lo, PV_POWER.hi);
      track("_gridP", this._number("fine_grid_power"),
        GRID_POWER.lo, GRID_POWER.hi, 1);
      track("_meterP", this._number("meter_power"), METER_CTRL.lo, METER_CTRL.hi, 1);
      track("_meterOut", this._number("meter_output_energy"),
        METER_ENERGY.lo, METER_ENERGY.hi);
      track("_meterIn", this._number("meter_input_energy"),
        METER_ENERGY.lo, METER_ENERGY.hi);
      track("_inputPower", this._number("input_power"),
        INPUT_POWER.lo, INPUT_POWER.hi);
      track("_feedPower", this._number("feed_power"),
        FEED_POWER.lo, FEED_POWER.hi);
      /* V0.6.6 §27 / §31: the same change detector for the two new per phase
         groups, keyed per phase so one edited box does not drag the others. */
      for (const spec of PHASE_LIMITS.slice(1)) {
        const draft = this[spec.draft];
        ["a", "b", "c"].forEach((p, i) => {
          const value = this._number(spec.keys[i]);
          if (value == null) return;
          const next = String(this._clamp(value, PHASE_BAND.lo, PHASE_BAND.hi));
          const key = `${spec.draft}_${p}`;
          const prev = this._seenDraft[key];
          this._seenDraft[key] = next;
          if (prev === undefined ? draft[p] === "" : prev !== next) draft[p] = next;
        });
      }

      /* The heater's range is decided by its mode, so the draft has to be
         clamped with the range the mode implies, not a fixed one.

         Two rules, and the second one is what makes switching the mode feel
         instant:

         * the range comes from the mode the DEVICE is in, because that is the
           mode the reported number belongs to;
         * while a mode switch is in flight the entity still carries the OLD
           mode's number, so clamping it into the new band would invent a value
           the device never reported (a 120 W reading became "25 °C") - and it
           overwrote whatever the user had already dragged in the new mode. The
           draft is left alone until the device echoes the mode. */
      this._heatMode();          /* also clears the pending flag once echoed */
      if (!this._heatModePending) {
        const live = this._heatModeLive();
        const heatRange = live === "temp" ? HEAT_TEMP : HEAT_POWER;
        track("_heatPower", this._number("heat_param"), heatRange.lo, heatRange.hi);
      }

      /* The heater's target packs follow the same rule, keyed on the whole set
         rather than one number. A device that reports no list at all (`null`)
         is left alone: filling in "all packs" there would claim the unit told
         us something it never said. An empty list means all packs (§40). */
      const reportedPacks = this._heatPackIds();
      if (reportedPacks !== null) {
        const key = reportedPacks.length ? reportedPacks.join(",") : "all";
        const prevPacks = this._seenDraft.packs;
        this._seenDraft.packs = key;
        /* An empty list stays empty on purpose: it means "all packs", and
           `_heatPackSel` expands it against the pack count *at render time*.
           Storing the expanded list here froze the answer to whatever the count
           was when the first state event arrived - and at HA startup that is
           often "unknown", which left one chip selected on a four-pack unit. */
        if (prevPacks === undefined) {
          if (!this._heatPacks.length) this._heatPacks = reportedPacks.slice();
        } else if (prevPacks !== key) {
          this._heatPacks = reportedPacks.slice();
        }
      }

      /* The power setpoint and the per-phase limits are seeded once by
         `_seedInputs`; they are re-tracked here so a change made from the app
         (or by another client) shows up in the boxes too. */
      track("_powerCtrl", this._number("power_ctrl"), -1000, 1000);
      track("_outputPower", this._number("output_power"), 100, 2500);
      /* The per-phase boxes live in `_phase`, not in a top-level draft. */
      for (const p of ["a", "b", "c"]) {
        const value = this._number(`phase_${p}_output_power`)
          ?? this._number("phase_output_power");
        if (value == null) continue;
        const next = String(this._clamp(value, 100, 2500));
        const key = `phase_${p}`;
        const prev = this._seenDraft[key];
        this._seenDraft[key] = next;
        if (prev === undefined ? this._phase[p] === "" : prev !== next) {
          this._phase[p] = next;
        }
      }
    }

    /* ------------------------------ sending ------------------------------ */

    /**
     * Publish one message and *throw* on failure.
     *
     * The explicit commands run through `_runAction`, which turns an exception
     * into the reason shown in the progress dialog. The automatic re-send calls
     * this directly and stays silent on purpose: a banner every few seconds
     * would be noise, and a failed tick is simply retried on the next one.
     */
    async _publishRaw(topic, payload) {
      if (!this._hass || typeof this._hass.callService !== "function") {
        throw new Error(this._t(
          "No Home Assistant connection.", "没有 Home Assistant 连接。",
        ));
      }
      /* Nothing on the broker stops a publish to a powered-off unit: it just
         disappears. Refusing here is the difference between "sent" and "sent
         nowhere" - every caller already knows how to show the reason.

         There is no exception. Offline means the unit has lost its network, so
         the wake message cannot reach it either - waking only changes what the
         firmware does while it is connected. */
      if (this._deviceOffline()) {
        throw new Error(this._t(
          "The device is offline - nothing was sent.",
          "设备离线，命令未下发。",
        ));
      }
      await this._hass.callService("mqtt", "publish", {
        topic,
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
        qos: 1,
        retain: false,
      });
    }

    /* -------------------------- progress dialog -------------------------- */

    /**
     * Start a dialog. `steps` is a list of plain strings; every step starts as
     * "todo" and is moved to active / done / failed by the action that owns it.
     */
    _busyStart(title, steps, longRun, limitMs) {
      if (this._busyTimer) {
        clearTimeout(this._busyTimer);
        this._busyTimer = null;
      }
      this._busy = {
        title,
        steps: (steps || []).map((text) => ({ text, state: "todo" })),
        state: "running",
        /* `started` tells a live action from one that died; `long` marks the two
           commands that are allowed to wait for the device. */
        started: Date.now(),
        long: longRun === true,
        /* An action can bring its own deadline: the reboot waits for a real
           restart, which may take minutes, while a mode change is stuck after
           a few seconds. */
        limit: limitMs > 0
          ? limitMs
          : (longRun === true ? LONG_ACTION_MS : STALE_ACTION_MS),
        message: "",
      };
      this.requestUpdate();
    }

    _busySet(index, state, text) {
      const busy = this._busy;
      if (!busy || !busy.steps[index]) return;
      busy.steps[index].state = state;
      if (text) busy.steps[index].text = text;
      this._busy = { ...busy };
      this.requestUpdate();
    }

    /**
     * Mark every step done and close the dialog on its own.
     *
     * `holdMs` lengthens the pause before it closes for actions whose result
     * the user has been waiting a long time for (the reboot can take minutes, so
     * a 1.3 s flash of "done" is easy to miss); everything else keeps the
     * short default.
     */
    _busyDone(message, holdMs) {
      const busy = this._busy;
      if (!busy) return;
      for (const step of busy.steps) {
        if (step.state !== "failed") step.state = "done";
      }
      this._busy = { ...busy, state: "ok", message: message || "" };
      this.requestUpdate();
      this._busyTimer = setTimeout(() => {
        this._busyTimer = null;
        this._busy = null;
        this.requestUpdate();
      }, holdMs > 0 ? holdMs : 1300);
    }

    /** Keep the dialog open and show why. The user closes it. */
    _busyFail(message) {
      const busy = this._busy;
      if (!busy) return;
      this._busy = {
        ...busy,
        state: "error",
        message: message || this._t("The command failed.", "命令执行失败。"),
      };
      this.requestUpdate();
    }

    _busyClose() {
      if (this._busyTimer) {
        clearTimeout(this._busyTimer);
        this._busyTimer = null;
      }
      this._busy = null;
      this.requestUpdate();
    }

    /**
     * Ask a yes/no question in the same overlay as the progress dialog.
     *
     * A promise rather than a callback: the caller reads like a normal `if`,
     * and `window.confirm` would look nothing like the rest of the card.
     */
    _askConfirm({ title, message, confirmText, cancelText }) {
      return new Promise((resolve) => {
        this._confirm = {
          title,
          message,
          confirmText: confirmText || this._t("Yes", "确定"),
          cancelText: cancelText || this._t("Cancel", "取消"),
          resolve,
        };
        this.requestUpdate();
      });
    }

    /** Answer the open question; the dialog closes either way. */
    _answerConfirm(ok) {
      const pending = this._confirm;
      if (!pending) return;
      this._confirm = null;
      this.requestUpdate();
      if (typeof pending.resolve === "function") pending.resolve(ok);
    }

    /**
     * Run one explicit command through the dialog.
     *
     * Every failure - a broker error, a device that never answers - ends up as
     * the message of a red dialog, so the user never has to guess whether the
     * command went through.
     */
    async _runAction({ title, steps, run, longRun, limitMs }) {
      /* One action at a time - but an action that never finished (a publish that
         hung and never rejected) must not block the card for ever. Past its own
         limit the old one is abandoned and the new one runs, so the card can
         always be used again; until then the click is ACKNOWLEDGED rather than
         silently dropped, which is what made a stuck card look broken. */
      if (this._busy && this._busy.state === "running") {
        const limit = this._busy.limit
          || (this._busy.long ? LONG_ACTION_MS : STALE_ACTION_MS);
        if (Date.now() - (this._busy.started || 0) < limit) {
          this._showToast(this._t(
            "Please wait - the previous command is still running.",
            "请稍等，上一条命令还在执行中。",
          ));
          return;
        }
      }
      this._busyStart(title, steps, longRun, limitMs);
      try {
        await run();
      } catch (err) {
        const busy = this._busy;
        if (busy) {
          const active = busy.steps.findIndex((s) => s.state === "active");
          if (active >= 0) this._busySet(active, "failed");
        }
        this._busyFail(String((err && err.message) || err || ""));
      }
    }

    /**
     * Poll `predicate` until it is true or the deadline passes.
     *
     * `hass` is pushed on every state change, but a poll is simpler than
     * registering a listener per command and it also works for values that are
     * only echoed once.
     */
    _waitFor(predicate, timeoutMs) {
      return new Promise((resolve) => {
        const started = this._now();
        const tick = () => {
          let hit = false;
          try {
            hit = Boolean(predicate());
          } catch (err) {
            hit = false;
          }
          if (hit) { resolve(true); return; }
          if (this._now() - started >= timeoutMs) { resolve(false); return; }
          setTimeout(tick, 300);
        };
        tick();
      });
    }

    _showToast(message, isError = false) {
      this._toast = message;
      this._toastError = isError;
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        this._toast = "";
        this.requestUpdate();
      }, PING_MS);
    }

    /**
     * A banner across the top of the page that outlives a success dialog.
     *
     * The heater is the one control whose *effect* cannot be confirmed quickly:
     * `heat/set` is applied at once, but the state the device reports back
     * (`heat`, `packs[].heat`) only travels in the device's 5-minute report.
     * That note used to be step 2 of the dialog, which disappeared together with
     * the dialog - so the one piece of timing information the user needed was
     * the first thing to go.  It now slides down from the top, stays for a few
     * seconds and leaves on its own (or on the close button).
     */
    _showBanner(message, seconds = BANNER_MS) {
      this._banner = message;
      if (this._bannerTimer) clearTimeout(this._bannerTimer);
      this._bannerTimer = setTimeout(() => {
        this._banner = "";
        this._bannerTimer = null;
        if (this.isConnected) this.requestUpdate();
      }, seconds);
      this.requestUpdate();
    }

    _dismissBanner() {
      this._banner = "";
      if (this._bannerTimer) {
        clearTimeout(this._bannerTimer);
        this._bannerTimer = null;
      }
      this.requestUpdate();
    }

    /** Clock seam, so the harness can drive the pending timeouts. */
    _now() {
      return Date.now();
    }

    _setSwitch(on) {
      const target = on ? "on" : "off";
      if (this._switchTarget() === target) return; // already on the way there
      /* One command at a time: the other button of the dialog is still in
         flight. Nothing is marked pending either, so the card stays honest. */
      if (this._busy && this._busy.state === "running") return;
      this._optimistic.switch = target;
      this._switchPending = { target, at: this._now() };
      this._switchConfirmedAt = 0;
      // Wake up once the wait is over, so the UI falls back to the real state
      // even when the device never answers (no hass push would do it for us).
      if (this._pendingTimer) clearTimeout(this._pendingTimer);
      this._pendingTimer = setTimeout(() => {
        this._pendingTimer = null;
        this.requestUpdate();
      }, SWITCH_PENDING_MS + 100);
      this.requestUpdate();

      this._runAction({
        title: this._t(on ? "Wake up" : "Sleep", on ? "唤醒" : "休眠"),
        longRun: true,
        steps: [
          this._t("Publish the command to the broker", "向 Broker 下发命令"),
          this._t("Wait for the device to confirm the new state", "等待设备确认新状态"),
        ],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic("switch/<dev_id>/set"), on ? "ON" : "OFF");
          this._busySet(0, "done");
          this._busySet(1, "active");
          /* An optimistic entity can never confirm anything (the firmware does
             not publish a usable state for it), so the wait would always end in
             a false alarm. The requested state stays in force instead. */
          if (this._switchOptimistic()) {
            this._busySet(1, "done", this._t(
              "The device does not report this state back", "设备不上报该状态",
            ));
            this._busyDone(this._t("Command sent.", "命令已下发。"));
            return;
          }
          const confirmed = await this._waitFor(
            () => this._switchReal() === (target === "on"), SWITCH_CONFIRM_TIMEOUT_MS,
          );
          if (!confirmed) {
            throw new Error(this._t(
              "The device did not confirm the new state in time. "
              + "It may still be switching - check the card again in a few seconds.",
              "设备未在预期时间内确认新状态。可能仍在切换，请几秒后再看卡片状态。",
            ));
          }
          this._switchConfirmedAt = this._now();
          this._busySet(1, "done");
          this._busyDone(this._t(
            "The device confirmed the new state.", "设备已确认新状态。",
          ));
        },
      });
    }

    /** The requested target while the command is still in flight. */
    _switchTarget() {
      const pending = this._switchPending;
      if (!pending) return null;
      if (this._now() - pending.at >= SWITCH_PENDING_MS) return null;
      return pending.target;
    }

    /** The device's own state, or null when it does not report one. */
    _switchReal() {
      const state = this._state("mqtt_switch", "switch") || this._state("config", "switch");
      const value = state ? String(state.state) : null;
      if (value === "on" || value === "off") return value === "on";
      return null;
    }

    /**
     * True when the entity cannot confirm its own state.
     *
     * The firmware's discovery switch is patched into an optimistic entity
     * (`assumed_state`, no `state_topic`), because its original state topic is a
     * nested JSON blob that never equals ON/OFF. HA then only remembers the last
     * command *it* sent - it never learns what the device actually did. Waiting
     * for a confirmation would always time out, and falling back to HA's value
     * after the timeout would snap the button back to the previous state, which
     * reads as "the command failed".
     */
    _switchOptimistic() {
      const state = this._state("mqtt_switch", "switch") || this._state("config", "switch");
      return Boolean(state && state.attributes && state.attributes.assumed_state);
    }

    /**
     * Drop the pending marker once the device agrees (or the wait expires).
     *
     * Called from the `hass` setter, i.e. on every push, which is what makes the
     * spinner turn into a tick as soon as the firmware confirms the new state.
     */
    _reconcileSwitch() {
      const pending = this._switchPending;
      if (!pending) return;
      if (this._now() - pending.at >= SWITCH_PENDING_MS) {
        this._switchPending = null;
        return;
      }
      // An optimistic entity cannot confirm anything, so only the timeout ends
      // the pending state (the requested value then simply stays in force).
      if (this._switchOptimistic()) return;
      const real = this._switchReal();
      if (real !== null && real === (pending.target === "on")) {
        this._switchPending = null;
        this._switchConfirmedAt = this._now();
        if (this._pendingTimer) {
          clearTimeout(this._pendingTimer);
          this._pendingTimer = null;
        }
        // Fade the tick away on its own.
        this._pendingTimer = setTimeout(() => {
          this._pendingTimer = null;
          this.requestUpdate();
        }, SWITCH_CONFIRM_MS + 100);
      }
    }

    /** { on, pending, justConfirmed } for the switch row. */
    _switchView() {
      const target = this._switchTarget();
      if (target) return { on: target === "on", pending: target, confirmed: false };
      const real = this._switchReal();
      /* A command issued from this card is authoritative for an optimistic
         entity: HA only remembers the commands it sent itself, so waiting for
         (or falling back to) that value would snap the button back. Before any
         such command the entity's value is still the best thing we have, and for
         a real entity the device always wins. */
      const mine = this._optimistic.switch;
      const commanded = mine === "on" || mine === "off";
      const on = this._switchOptimistic() && commanded
        ? mine === "on"
        : real !== null
          ? real
          : mine === "on";
      const justConfirmed = this._switchConfirmedAt > 0
        && this._now() - this._switchConfirmedAt < SWITCH_CONFIRM_MS;
      if (!justConfirmed) this._switchConfirmedAt = 0;
      return { on, pending: null, confirmed: justConfirmed };
    }

    _isSwitchOn() {
      return this._switchView().on;
    }

    _setEmsMode(mode) {
      if (mode === this._emsMode()) return; // already there
      this._optimistic.ems_mode = mode;
      /* `mqtt_ctrl` is a lease, not a switch (protocol §14): the firmware only
         keeps the mode while a `power_ctrl` setpoint keeps arriving, and without
         one the mode can sit unapplied for minutes - measured on a 4020 X, the
         echo arrived either within 5 s (setpoint sent) or not at all. Since the
         setpoint row only exists while the mode is active, the card used to
         deadlock here. The first setpoint therefore goes out with the mode. */
      const lease = mode === "mqtt_ctrl";
      const steps = [
        this._t(`Publish the mode command (${mode})`, `下发模式命令（${mode}）`),
      ];
      if (lease) {
        steps.push(this._t(
          "Send the first setpoint (0 W)", "下发首个设定值（0 W）",
        ));
      }

      this._runAction({
        title: this._t("EMS mode", "EMS 模式"),
        steps,
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic("select/<dev_id>/ems_mode/command"), mode);
          this._busySet(0, "done");
          /* From here the card owns the display: the requested mode stays
             highlighted until the unit confirms it, so a slow switch does not
             look like a rejected command. */
          this._emsPending = { mode, at: this._now() };

          let seed = 0;
          if (lease) {
            this._busySet(1, "active");
            const bounds = this._bounds("power_ctrl", -1000, 1000);
            /* Keep whatever the user already typed; otherwise start from 0 W -
               "neither charge nor discharge" - and show it in the row, so the
               next step is obvious. */
            seed = this._powerCtrl === ""
              ? 0
              : this._clamp(num(this._powerCtrl), bounds.lo, bounds.hi);
            this._powerCtrl = String(seed);
            await this._publishRaw(
              this._topic("number/<dev_id>/power_ctrl/set"), String(seed),
            );
            this._busySet(1, "done");
          }

          this._busyDone(lease
            ? this._t(
              `Sent: mode mqtt_ctrl and a ${seed} W setpoint. Change the target `
              + "below and press Send - keep the timer on, or the unit goes back "
              + "to its own control about a minute after the last setpoint.",
              `已下发 mqtt_ctrl 与 ${seed} W 设定值。请修改下方目标功率后点「下发」，`
              + "并保持定时开启，否则最后一次下发约一分钟后设备恢复自行控制。",
            )
            : this._t(
              "Sent. The unit takes the new mode on its next control cycle, "
              + "usually within a minute.",
              "命令已下发。设备会在下一个控制周期接受新模式，通常一分钟内生效。",
            ));
        },
      });
    }

    /**
     * Settle the pending EMS mode against what the device reports.
     *
     * Called from the `hass` setter, i.e. on every push: the state event is the
     * only confirmation the firmware gives, and it can arrive a minute after the
     * command. When it does, the pending marker goes away and the picker follows
     * the device. If it never arrives, the marker expires and the picker shows
     * the mode the unit really is in.
     */
    _reconcileEmsMode() {
      const pending = this._emsPending;
      if (!pending) return;
      const state = this._state("ems_mode", "select");
      const live = state ? String(state.state) : "";
      if (live === pending.mode) {
        this._emsPending = null;
        this._optimistic.ems_mode = "";
        return;
      }
      if (this._now() - pending.at >= EMS_CONFIRM_TIMEOUT_MS) {
        this._emsPending = null;
        this._optimistic.ems_mode = "";
        this._showToast(this._t(
          `The device still reports ${live || "an unknown mode"} - the mode `
          + "change was not applied.",
          `设备仍上报 ${live || "未知模式"}，模式未切换。`,
        ), true);
      }
    }

    _emsMode() {
      const pending = this._emsPending;
      if (pending && this._now() - pending.at < EMS_CONFIRM_TIMEOUT_MS) {
        return pending.mode;
      }
      const state = this._state("ems_mode", "select");
      return (state ? String(state.state) : null) || this._optimistic.ems_mode || "";
    }

    _emsOptions() {
      let options = this._attr("ems_mode", "select", "options");
      if (!Array.isArray(options) || !options.length) {
        options = EMS_MODES.map((m) => m.id);
      }
      /* A **slave** only runs its own regulation (`general`) or the device level
         precise control block (`fine_ctrl`, §13/§14 are 角色: 不限).  The three
         system level modes write setpoints that belong to the master, so they
         are not offered here even if the discovered config still lists them
         (the integration narrows that list too, but a cached payload from before
         the role was known must not leak through). */
      if (this._isSlave()) {
        return options.filter((id) => EMS_MODES_SLAVE.includes(id));
      }
      return options;
    }

    _sendPowerCtrl() {
      /* `_repeatValue` rather than `Number(...)`: an empty box parses to 0, and
         publishing 0 W because the field was blank is not what anyone means. */
      const value = this._repeatValue();
      if (value === null) { this._showToast(this._t("Invalid value", "数值无效"), true); return; }
      const every = this._repeatInterval();
      this._runAction({
        title: this._t("Target power", "目标功率"),
        steps: [
          this._t(`Publish ${value} W to the broker`, `向 Broker 下发 ${value} W`),
        ],
        run: async () => {
          this._busySet(0, "active");
          if (this._repeatOn) {
            /* The integration publishes this value and keeps publishing it. The
               slider is only a draft from here on: moving it must not silently
               change what the device is being told. */
            await this._callService("set_power_ctrl", { value, interval: every });
          } else {
            await this._publishRaw(this._topic("number/<dev_id>/power_ctrl/set"), String(value));
          }
          this._busySet(0, "done");
          await this._syncRepeat();
          this._busyDone(this._repeatOn
            ? this._t(
              `Setpoint ${value} W sent. Home Assistant re-sends it every ${every} s, `
              + "even after you leave this page.",
              `设定值 ${value} W 已下发。Home Assistant 会每 ${every} s 重发一次，`
              + "离开本页也照常进行。",
            )
            : this._t(
              `Setpoint ${value} W sent. The timer is off, so it will not be `
              + `repeated - the device drops it after about a minute.`,
              `设定值 ${value} W 已下发。定时已关闭，不会重发——约一分钟后设备会丢弃该设定值。`,
            ));
        },
      });
    }

    /* -------------------- periodic power control send -------------------- */

    /**
     * Call one of the integration's own services; throws on failure.
     *
     * `_publishRaw` cannot be used for this: the repeat has to be scheduled in
     * Home Assistant, because a timer in this card dies with the card.
     */
    async _callService(service, data) {
      if (!this._hass || typeof this._hass.callService !== "function") {
        throw new Error(this._t(
          "No Home Assistant connection.", "没有 Home Assistant 连接。",
        ));
      }
      /* The `get_*` services are read-only and must keep working while the unit
         is away - that is exactly when a card wants to know whether a lease is
         still armed. Writing a lease to an offline device is pointless though:
         it expires before the unit could ever read it. */
      if (!service.startsWith("get_") && this._deviceOffline()) {
        throw new Error(this._t(
          "The device is offline - nothing was sent.",
          "设备离线，命令未下发。",
        ));
      }
      return this._hass.callService("hoymiles", service, {
        dev_id: this._dev(),
        ...(data || {}),
      });
    }

    /**
     * Read back the re-publish job that Home Assistant is running.
     *
     * This is the piece that makes a page change harmless: a brand-new card has
     * no memory of its own, but the server still knows the value, the interval
     * and when the next send is due.
     */
    async _syncRepeat() {
      if (!this._hass || typeof this._hass.callService !== "function") return;
      if (!this._config) return;
      const dev = this._dev();
      if (!dev) return;
      let payload = null;
      try {
        const out = await this._hass.callService(
          "hoymiles", "get_power_ctrl", { dev_id: dev }, undefined, true, true,
        );
        payload = out && out.response ? out.response : out;
      } catch (err) {
        /* A failed query is not worth a banner, but it must be retried: the
           usual cause is a Home Assistant that is still starting up. */
        this._scheduleResync(REPEAT_IDLE_POLL_S);
        return;
      }
      if (!this.isConnected) return;
      this._applyRepeatState(payload);
      this.requestUpdate();
    }

    _applyRepeatState(payload) {
      /* The integration stops the job as soon as the EMS mode leaves
         `mqtt_ctrl`, but a query issued just before that can still come back
         "active". Ignoring it here keeps the row from showing a countdown for a
         setpoint the device has already been released from. */
      const mode = this._emsMode();
      if (mode === "general" || mode === "tou_plan") {
        if (payload && payload.active === true) {
          this._scheduleResync(REPEAT_IDLE_POLL_S);
          return;
        }
      }

      if (!payload || payload.active !== true) {
        this._repeatState = null;
        // Keep looking: a setpoint may be started from another browser, or the
        // one that was running may have gone away with a Home Assistant restart.
        this._scheduleResync(REPEAT_IDLE_POLL_S);
        return;
      }

      const value = Number(payload.value);
      const interval = Number(payload.interval);
      const nextIn = Number(payload.next_in);
      this._repeatState = {
        value: Number.isFinite(value) ? value : null,
        interval: Number.isFinite(interval) && interval > 0 ? interval : REPEAT_DEFAULT_S,
        nextIn: Number.isFinite(nextIn) ? Math.max(0, nextIn) : 0,
        at: Date.now(),
      };

      /* A running setpoint is the value in force, so on the first sync it wins
         over whatever the number entity happens to echo. Only on the first one:
         overwriting the inputs on every resync would wipe what the user is
         typing. */
      if (!this._repeatSeeded && this._repeatState.value !== null) {
        this._repeatSeeded = true;
        this._powerCtrl = String(this._repeatState.value);
        this._repeatEvery = String(this._repeatState.interval);
        this._initialised = true; // keep `_seedInputs` from overwriting it
      }
      this._repeatOn = true;
      this._scheduleResync(this._repeatState.nextIn + 1);
    }

    /** Ask the server again after `seconds`; one timer, always replaced. */
    _scheduleResync(seconds) {
      if (this._repeatSyncTimer) clearTimeout(this._repeatSyncTimer);
      const secs = Number.isFinite(Number(seconds)) ? Number(seconds) : REPEAT_IDLE_POLL_S;
      this._repeatSyncTimer = setTimeout(() => {
        this._repeatSyncTimer = null;
        if (this.isConnected) this._syncRepeat();
      }, Math.max(1, secs) * 1000 + 800);
    }

    /** The interval in effect: the draft, clamped to sane bounds. */
    _repeatInterval() {
      const v = Math.round(num(this._repeatEvery));
      if (!Number.isFinite(v)) return REPEAT_DEFAULT_S;
      return Math.min(Math.max(v, REPEAT_MIN_S), REPEAT_MAX_S);
    }

    /** The value that would be sent, or null when it cannot be read. */
    _repeatValue() {
      const v = Number(this._powerCtrl);
      return Number.isFinite(v) && this._powerCtrl !== "" ? v : null;
    }

    /** True while Home Assistant is really re-publishing a setpoint. */
    _repeatActive() {
      return Boolean(this._repeatState);
    }

    _clearRepeatTimers() {
      if (this._repeatSyncTimer) clearTimeout(this._repeatSyncTimer);
      this._repeatSyncTimer = null;
      if (this._repeatUiTimer) clearTimeout(this._repeatUiTimer);
      this._repeatUiTimer = null;
    }

    /** Countdown to the next automatic send, or null when it is not running. */
    _repeatNextIn() {
      const state = this._repeatState;
      if (!state) return null;
      const elapsed = (Date.now() - state.at) / 1000;
      return Math.max(0, Math.ceil(state.nextIn - elapsed));
    }

    /**
     * Restart the lease with a new interval.
     *
     * The server owns the schedule, so changing the number in the box only takes
     * effect once it is told - otherwise the row would promise "every 5 s" while
     * the job still ran at 30 s.
     */
    async _applyRepeatInterval() {
      const state = this._repeatState;
      if (!state || state.value === null) return;
      try {
        await this._callService("set_power_ctrl", {
          value: state.value,
          interval: this._repeatInterval(),
        });
      } catch (err) {
        this._showToast(String(err && err.message ? err.message : err), true);
      }
      await this._syncRepeat();
    }


    /**
     * Hand the config and `hass` to the embedded TOU editor.
     *
     * `setConfig` runs once: re-running it would reset the draft (and the
     * user's unsaved edits) on every Home Assistant state push. `hass` is the
     * live feed the editor needs to resolve its entities, so that one is passed
     * on whenever the reference changed.
     */
    _syncTouEditor() {
      const root = this.renderRoot;
      const el = root && root.querySelector ? root.querySelector("hoymiles-tou-editor") : null;
      if (!el) return;
      if (el._hmEmbedded !== true) {
        el._hmEmbedded = true;
        if (typeof el.setConfig === "function") {
          el.setConfig({ dev_id: this._dev(), embedded: true });
        }
      }
      const hass = this._hass;
      if (hass && el._hass !== hass) el.hass = hass;
    }

    /**
     * The timer switch.
     *
     * Off -> on with nothing running only records the intent: the first message
     * is always the one the user asked for with Send. Off -> on *while a job is
     * running* restarts the lease, i.e. it re-anchors the countdown at "now".
     *
     * On -> off asks first, because the setpoint dies about a minute later and
     * the device silently goes back to regulating on its own.
     *
     * Returns whether the switch really moved, so the caller can put the knob
     * back when the question is declined.
     */
    async _setRepeat(on) {
      if (on === (this._repeatOn === true)) return true;

      if (on) {
        this._repeatOn = true;
        this.requestUpdate();
        const state = this._repeatState;
        if (state && state.value !== null) {
          try {
            await this._callService("set_power_ctrl", {
              value: state.value,
              interval: this._repeatInterval(),
            });
          } catch (err) {
            this._showToast(String(err && err.message ? err.message : err), true);
          }
          await this._syncRepeat();
        }
        return true;
      }

      // Turning it off: ask, because this loses the setpoint. With nothing
      // running there is nothing to lose, so there is nothing to ask about.
      const ok = !this._repeatActive() || await this._askConfirm({
        title: this._t("Turn the timer off?", "关闭定时下发？"),
        message: this._t(
          "The device drops an MQTT setpoint unless it is refreshed at least "
          + "once a minute. With the timer off, it goes back to controlling "
          + "the charge and discharge power on its own within about 60 seconds.",
          "设备要求至少每分钟刷新一次 MQTT 功率设定值。关闭定时后，约 60 秒内设备会"
          + "丢弃该设定值，恢复为自行控制充放电功率。",
        ),
        confirmText: this._t("Turn it off", "关闭定时"),
        cancelText: this._t("Keep it on", "保持开启"),
      });
      if (!ok) return false;

      this._repeatOn = false;
      try {
        /* Stop it in Home Assistant, not just here: leaving the server job alive
           would keep the device pinned to the setpoint with no way to see it. */
        await this._callService("stop_power_ctrl", {});
      } catch (err) {
        this._showToast(String(err && err.message ? err.message : err), true);
      }
      await this._syncRepeat();
      this.requestUpdate();
      return true;
    }

    /* ------------- periodic send for the other two leases ------------- */

    /**
     * §12 (virtual meter) and §42 (fine control) are leases like §10's
     * `power_ctrl`: the firmware drops the value unless it is refreshed at least
     * once a minute. They get the same treatment — the publish job lives in Home
     * Assistant (`hoymiles.set_meter_ctrl` / `hoymiles.set_fine_ctrl`), the card
     * only shows the switch, the interval and a countdown.
     *
     * One implementation for both because they differ only in the service names
     * and in the payload shape: `meter_ctrl` is one number, `fine_ctrl` an object
     * that the server merges field by field (a row sends just its own field and
     * the repeat still carries the whole object).
     */
    _leaseSpec(kind) {
      return LEASES[kind] || null;
    }

    /** True while Home Assistant is really re-publishing that lease. */
    _leaseRunning(kind) {
      return Boolean(this._leaseStates && this._leaseStates[kind]);
    }

    /** The switch position: the user's intent, not what the server reports. */
    _leaseOnFlag(kind) {
      return !this._leaseOn || this._leaseOn[kind] !== false;
    }

    /** The interval in effect: the draft, clamped to sane bounds. */
    _leaseInterval(kind) {
      const draft = this._leaseEvery ? this._leaseEvery[kind] : undefined;
      /* An empty or never-seeded box is "the default", not "0 s": `num()`
         turns `undefined` into 0 and the clamp would then floor it at 1 s. */
      if (draft == null || draft === "") return REPEAT_DEFAULT_S;
      const v = Math.round(num(draft));
      if (!Number.isFinite(v)) return REPEAT_DEFAULT_S;
      return Math.min(Math.max(v, REPEAT_MIN_S), REPEAT_MAX_S);
    }

    /** What the interval box shows before the server has said anything. */
    _leaseEveryOf(kind) {
      const draft = this._leaseEvery ? this._leaseEvery[kind] : undefined;
      return draft == null ? String(REPEAT_DEFAULT_S) : draft;
    }

    /** Countdown to the next automatic send, or null when nothing is running. */
    _leaseNextIn(kind) {
      const state = this._leaseStates ? this._leaseStates[kind] : null;
      if (!state) return null;
      const elapsed = (Date.now() - state.at) / 1000;
      return Math.max(0, Math.ceil(state.nextIn - elapsed));
    }

    /**
     * The sentence under the row: the range and sign, plus what the timer is
     * doing. Same wording as the `power_ctrl` row so the three blocks read as
     * one control scheme rather than three unrelated switches.
     */
    _leaseClause(kind, base, ready) {
      const every = this._leaseRunning(kind)
        ? this._leaseStates[kind].interval
        : this._leaseInterval(kind);
      const nextIn = this._leaseNextIn(kind);
      const tail = !ready
        ? this._t(
          "the device ignores this value in another mode",
          "其他模式下设备会忽略该值",
        )
        : !this._leaseOnFlag(kind)
          ? this._t(
            "timer off: the device reverts to its own control about a minute "
            + "after the last send",
            "定时已关闭：最后一次下发约一分钟后，设备恢复自行控制",
          )
          : nextIn == null
            ? this._t(
              `press Send to start the ${every} s re-send`,
              `点「下发」后开始每 ${every} s 重发`,
            )
            : this._t(
              `re-sent every ${every} s by Home Assistant, next in ${nextIn} s`,
              `由 Home Assistant 每 ${every} s 重发，${nextIn} s 后发送`,
            );
      return base ? `${base} · ${tail}` : tail;
    }

    /**
     * `_watchLease` runs on every render but queries at most once per
     * connection: the modes are exclusive, so only the block on screen is worth
     * a service call. After that the poll reschedules itself from the answer,
     * which is also how a job started in another browser shows up here.
     */
    _watchLease() {
      if (!this._leaseQueried) this._leaseQueried = {};
      const mode = this._emsMode();
      const kind = mode === "meter_ctrl"
        ? "meter_ctrl"
        : mode === "fine_ctrl" ? "fine_ctrl" : null;      if (!kind || this._leaseQueried[kind]) return;
      this._leaseQueried[kind] = true;
      this._syncLease(kind);
    }

    async _syncLease(kind) {
      const spec = this._leaseSpec(kind);
      if (!spec) return;
      if (!this._hass || typeof this._hass.callService !== "function") return;
      if (!this._config) return;
      const dev = this._dev();
      if (!dev) return;
      let payload = null;
      try {
        const out = await this._hass.callService(
          "hoymiles", spec.get, { dev_id: dev }, undefined, true, true,
        );
        payload = out && out.response ? out.response : out;
      } catch (err) {
        /* A Home Assistant that is still starting up answers with an error, not
           with a failure worth a banner - retry quietly. */
        this._scheduleLeaseSync(kind, REPEAT_IDLE_POLL_S);
        return;
      }
      if (!this.isConnected) return;
      this._applyLeaseState(kind, payload);
      this.requestUpdate();
    }

    _applyLeaseState(kind, payload) {
      if (!this._leaseStates) this._leaseStates = {};
      if (!payload || payload.active !== true) {
        this._leaseStates[kind] = null;
        // Keep looking: an automation or another browser may start one.
        this._scheduleLeaseSync(kind, REPEAT_IDLE_POLL_S);
        return;
      }
      const interval = Number(payload.interval);
      const nextIn = Number(payload.next_in);
      this._leaseStates[kind] = {
        payload: payload.payload === undefined ? null : payload.payload,
        interval: Number.isFinite(interval) && interval > 0 ? interval : REPEAT_DEFAULT_S,
        nextIn: Number.isFinite(nextIn) ? Math.max(0, nextIn) : 0,
        at: Date.now(),
      };
      /* The draft is only seeded when it is still empty: overwriting it on every
         poll would wipe what the user is typing. */
      if (!this._leaseEvery) this._leaseEvery = {};
      if (this._leaseEvery[kind] == null) {
        this._leaseEvery[kind] = String(this._leaseStates[kind].interval);
      }
      if (!this._leaseOn) this._leaseOn = {};
      this._leaseOn[kind] = true;
      this._scheduleLeaseSync(kind, this._leaseStates[kind].nextIn + 1);
    }

    _scheduleLeaseSync(kind, seconds) {
      if (!this._leaseTimers) this._leaseTimers = {};
      if (this._leaseTimers[kind]) clearTimeout(this._leaseTimers[kind]);
      const secs = Number.isFinite(Number(seconds))
        ? Number(seconds) : REPEAT_IDLE_POLL_S;
      this._leaseTimers[kind] = setTimeout(() => {
        this._leaseTimers[kind] = null;
        if (this.isConnected) this._syncLease(kind);
      }, Math.max(1, secs) * 1000 + 800);
    }

    _clearLeaseTimers() {
      const timers = this._leaseTimers || {};
      Object.keys(timers).forEach((kind) => {
        if (timers[kind]) clearTimeout(timers[kind]);
        timers[kind] = null;
      });
    }

    /** Forget a lease locally, e.g. after the mode that owns it was left. */
    _dropLease(kind) {
      if (this._leaseStates) this._leaseStates[kind] = null;
      if (this._leaseTimers && this._leaseTimers[kind]) {
        clearTimeout(this._leaseTimers[kind]);
        this._leaseTimers[kind] = null;
      }
    }

    /** Restart a running lease at the interval currently in the box. */
    async _applyLeaseInterval(kind) {
      const state = this._leaseStates ? this._leaseStates[kind] : null;
      if (!state || state.payload == null) return;
      await this._rearmLease(kind, state.payload);
    }

    /**
     * Re-arm the job with the payload the server already holds.
     *
     * `payload` is what `TopicRepeatManager` kept: since V0.6.5 the virtual meter
     * is an object like `fine_ctrl` (`power` / `eng_out` / `eng_in`), so both are
     * re-armed the same way - spread it back into the service call.
     */
    async _rearmLease(kind, payload) {
      const spec = this._leaseSpec(kind);
      if (!spec) return;
      const interval = this._leaseInterval(kind);
      try {
        const fields = typeof payload === "object" && payload !== null
          ? payload : { value: payload };
        await this._callService(spec.set, { ...fields, interval });
      } catch (err) {
        this._showToast(String(err && err.message ? err.message : err), true);
      }
      await this._syncLease(kind);
    }

    /** The lease switch. Same rules as the power one - see `_setRepeat`. */
    async _setLease(kind, on) {
      if (on === this._leaseOnFlag(kind)) return true;
      if (!this._leaseOn) this._leaseOn = {};

      if (on) {
        this._leaseOn[kind] = true;
        this.requestUpdate();
        const state = this._leaseStates ? this._leaseStates[kind] : null;
        if (state && state.payload != null) await this._rearmLease(kind, state.payload);
        return true;
      }

      const spec = this._leaseSpec(kind);
      const name = spec ? this._t(spec.en, spec.zh) : kind;
      const ok = !this._leaseRunning(kind) || await this._askConfirm({
        title: this._t("Turn the timer off?", "关闭定时下发？"),
        message: this._t(
          `${name} is dropped by the device unless it is refreshed at least `
          + "once a minute. With the timer off it goes back to controlling "
          + "the charge and discharge power on its own within about 60 seconds.",
          `${name}需要至少每分钟刷新一次，否则设备会丢弃该值。关闭定时后，`
          + "约 60 秒内设备会恢复为自行控制充放电功率。",
        ),
        confirmText: this._t("Turn it off", "关闭定时"),
        cancelText: this._t("Keep it on", "保持开启"),
      });
      if (!ok) return false;

      this._leaseOn[kind] = false;
      try {
        await this._callService(spec.stop, {});
      } catch (err) {
        this._showToast(String(err && err.message ? err.message : err), true);
      }
      await this._syncLease(kind);
      this.requestUpdate();
      return true;
    }

    /** The switch is bound one way; put the knob back when a question is declined. */
    async _onLeaseSwitch(kind, event) {
      const knob = event.currentTarget;
      const applied = await this._setLease(kind, knob.checked === true);
      if (!applied) knob.checked = this._leaseOnFlag(kind);
    }

    /**
     * The "every N seconds" strip, identical to the one on the power row.
     *
     * Deliberately at the bottom of the block and not on every row: `fine_ctrl`
     * carries five fields in ONE object, so there is one lease, and one strip
     * that speaks for all of them.
     */
    _leaseStrip(kind, ready) {
      const spec = this._leaseSpec(kind);
      if (!spec) return html``;
      return html`<div class="repeat-row ${this._leaseRunning(kind) ? "on" : ""}">
        <span class="repeat-ico">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
               stroke="currentColor" stroke-width="2.2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/>
            <path d="M20.5 3.5v4.2h-4.2"/>
          </svg>
        </span>
        <span class="cap">${this._t("Every", "每隔")}</span>
        <input type="number" min=${REPEAT_MIN_S} max=${REPEAT_MAX_S} step="1"
          .value=${this._leaseEveryOf(kind)}
          ?disabled=${!ready || !this._leaseOnFlag(kind)}
          @change=${(e) => {
            if (!this._leaseEvery) this._leaseEvery = {};
            this._leaseEvery[kind] = e.target.value;
            this._applyLeaseInterval(kind);
          }} />
        <span class="cap">${this._t("s", "秒")}</span>
        <span class="spacer"></span>
        <ha-switch .checked=${this._leaseOnFlag(kind)} ?disabled=${!ready}
          @change=${(e) => this._onLeaseSwitch(kind, e)}></ha-switch>
      </div>`;
    }

    _sendOutputPower() {
      const value = Number(this._outputPower);
      if (!Number.isFinite(value)) { this._showToast(this._t("Invalid value", "数值无效"), true); return; }
      this._runAction({
        title: this._t("Output power limit", "输出功率上限"),
        steps: [
          this._t(`Publish ${value} W to the broker`, `向 Broker 下发 ${value} W`),
        ],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic("number/<dev_id>/output_power/set"), String(value));
          this._busySet(0, "done");
          this._busyDone(this._t(
            `Output ceiling ${value} W sent.`, `输出上限 ${value} W 已下发。`,
          ));
        },
      });
    }

    /**
     * Publish one of the three per phase limit objects.
     *
     * §28 / §32 reject a partial payload, and the card always shows all three
     * boxes, so the whole object goes on the wire - the same rule the output
     * ceiling has had since §24.
     */
    _sendPhase(spec = PHASE_LIMITS[0]) {
      const draft = this[spec.draft] || {};
      const payload = {
        phase_a: Number(draft.a),
        phase_b: Number(draft.b),
        phase_c: Number(draft.c),
      };
      if (!Object.values(payload).every(Number.isFinite)) {
        this._showToast(this._t("Invalid value", "数值无效"), true);
        return;
      }
      const label = `${payload.phase_a} / ${payload.phase_b} / ${payload.phase_c} W`;
      const title = this._t(spec.en, spec.zh);
      this._runAction({
        title,
        steps: [
          this._t(`Publish ${label} to the broker`, `向 Broker 下发 ${label}`),
        ],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(
            this._topic(spec.topic), payload,
          );
          this._busySet(0, "done");
          this._busyDone(this._t(
            `${title} ${label} sent.`, `${title} ${label} 已下发。`,
          ));
        },
      });
    }

    /* ----------------------- V0.6.2 setting commands ---------------------- */

    /**
     * Publish one plain numeric setting (§40 / §42 / §44).
     *
     * Those three topics take a bare number rather than an object, so the three
     * rows differ only in the topic, the bound and the wording - hence one
     * helper instead of three near-identical methods.
     */
    _sendScalar({ field, topic, lo, hi, unit, label, clampTo }) {
      if (this[field] === "") {
        this._showToast(this._t(
          "No value yet - the device has not reported this setting.",
          "暂无数值——设备尚未上报该设置。",
        ), true);
        return;
      }
      const raw = Number(this[field]);
      if (!Number.isFinite(raw)) {
        this._showToast(this._t("Invalid value", "数值无效"), true);
        return;
      }
      const value = clampTo ? Math.round(this._clamp(raw, lo, hi)) : raw;
      this._runAction({
        title: label,
        steps: [this._t(
          `Publish ${value} to the broker`,
          `向 Broker 下发 ${value}`,
        )],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic(topic), String(value));
          this._busySet(0, "done");
          this._busyDone(this._t(
            `${label}: ${value} ${unit} sent.`,
            `${label}：${value} ${unit} 已下发。`,
          ));
        },
      });
    }

    /**
     * §29/§30: publish the feed-in limit as the `limit` field of the group.
     *
     * The topic takes an object since V0.6.7 (the `enable` switch shares it), so
     * this is no longer `_sendScalar` - a bare number would reach the device as
     * a malformed object.  §30 allows a partial write, so `enable` stays as it
     * is on the device.
     */
    _sendFeedLimit() {
      if (this._feedPower === "") {
        this._showToast(this._t(
          "No value yet - the device has not reported this setting.",
          "暂无数值——设备尚未上报该设置。",
        ), true);
        return;
      }
      const { lo, hi } = this._bounds("feed_power", FEED_POWER.lo, FEED_POWER.hi);
      const value = Math.round(this._clamp(this._feedPower, lo, hi));
      this._runAction({
        title: this._t("Feed-in limit", "馈网功率限值"),
        steps: [this._t(
          `Publish {"limit": ${value}} to the broker`,
          `向 Broker 下发 {"limit": ${value}}`,
        )],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(
            this._topic("number/<dev_id>/feed_power/set"), { limit: value },
          );
          this._busySet(0, "done");
          this._busyDone(this._t(
            `Feed-in limit: ${value} W sent.`,
            `馈网功率限值：${value} W 已下发。`,
          ));
        },
      });
    }

    /**
     * §38: auto / manual / off.
     *
     * `manual` is the one mode where a level matters, so switching into it
     * publishes the mode **and** both fans at full speed in ONE message. The
     * old behaviour sent `{mode}` alone, which left the user in Manual with the
     * device still holding whatever level it had before - to see anything move
     * they had to drag a handle and press a second Send. Sending both halves at
     * once means the unit is already audible when the picker lights up, and the
     * two can never disagree.
     *
     * Measured on 4020 X: `{"mode":"manual","target":{"pcs":10,"bat":10}}` is
     * applied as a whole (`fan_mode=manual`, `fan_target={10,10}`), so a single
     * message is enough. Afterwards the user drags whatever level they want and
     * presses Send, which publishes `target` alone - §38 allows both.
     */
    _setFanMode(mode) {
      if (!mode || mode === this._fanMode()) return;
      this._fanModePending = mode;

      const payload = { mode };
      if (mode === "manual") {
        payload.target = this._fanMax();
        /* Show the levels that were just sent. The device echoes them, but the
           echo rides the next periodic report; until then the handles would
           still read the previous level. */
        this._fanPcs = String(payload.target.pcs);
        this._fanBat = String(payload.target.bat);
      }
      this.requestUpdate();

      const detail = mode === "manual"
        ? this._t(
          `mode manual, PCS ${payload.target.pcs} / battery ${payload.target.bat} (full speed)`,
          `模式 manual，PCS ${payload.target.pcs} / 电池 ${payload.target.bat}（最高转速）`,
        )
        : this._t(`mode ${mode}`, `模式 ${mode}`);
      this._runAction({
        title: this._t("Fan mode", "风扇模式"),
        steps: [this._t(`Publish ${detail}`, `下发 ${detail}`)],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(
            this._topic("<dev_id>/fan/set"), payload,
          );
          this._busySet(0, "done");
          this._busyDone(this._t(
            `Fan mode: ${detail}.`, `风扇：${detail}。`,
          ));
        },
      });
    }

    /** The highest level both fans accept (10 unless the device says less). */
    _fanMax() {
      const pcs = this._bounds("pcs_fan_speed", FAN_SPEED.lo, FAN_SPEED.hi).hi;
      const bat = this._bounds("battery_fan_speed", FAN_SPEED.lo, FAN_SPEED.hi).hi;
      return { pcs: Math.round(pcs), bat: Math.round(bat) };
    }

    /** §38: both fan levels in one partial object. */
    _sendFanSpeed() {
      const pcs = Math.round(this._clamp(this._fanPcs, FAN_SPEED.lo, FAN_SPEED.hi));
      const bat = Math.round(this._clamp(this._fanBat, FAN_SPEED.lo, FAN_SPEED.hi));
      this._runAction({
        title: this._t("Fan speed", "风扇转速"),
        steps: [this._t(
          `Publish PCS ${pcs} / battery ${bat}`,
          `下发 PCS ${pcs} / 电池 ${bat}`,
        )],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(
            this._topic("<dev_id>/fan/set"), { target: { pcs, bat } },
          );
          this._busySet(0, "done");
          this._busyDone(this._t(
            `Fan levels PCS ${pcs} / battery ${bat} sent.`,
            `风扇档位 PCS ${pcs} / 电池 ${bat} 已下发。`,
          ));
        },
      });
    }

    /**
     * §34: charge and discharge cut-off SOC.
     *
     * There is no Send button here, on purpose. The two values are one message
     * that the firmware applies immediately, the handles are the only way to
     * edit them, and the card has no second row for a button to sit in - so a
     * button in the header was a piece of furniture that had to be remembered
     * rather than read. Releasing a handle now publishes the pair, which is the
     * same rule the rest of the card already follows for the sliders it sends
     * on drag, and the header carries a short state word instead: "drag to
     * send" while idle, then what was just sent, or why nothing was.
     *
     * The firmware silently ignores the whole message when `soc_l >= soc_h`, and
     * a pair closer than `SOC_MIN_GAP` leaves no usable cycle. The handles
     * already enforce both, so this is the last line of defence: it turns a
     * stale draft into a message instead of a command the device quietly drops.
     */
    _socCommit() {
      const pair = this._socPair();
      const hi = Math.round(pair.h);
      const lo = Math.round(pair.l);
      if (hi - lo < SOC_MIN_GAP) {
        this._socFlash(this._t(
          `Needs a ${SOC_MIN_GAP} % gap`,
          `相差需 ≥${SOC_MIN_GAP} %`,
        ), true);
        return;
      }
      /* Nothing moved, nothing to publish. The comparison is against the pair
         the device is already running rather than against the draft: `_number`
         still reads the pre-drag value here (the firmware has not echoed the
         new one yet), so a click that ends where it started stays silent while
         a real drag does not. After the first send the same key doubles as the
         record of what was last published, which also swallows a drag that is
         released on a value that was already sent. */
      const key = hi + "/" + lo;
      if (this._socSentKey == null) {
        const devH = this._number("charge_soc_limit");
        const devL = this._number("discharge_soc_limit");
        this._socSentKey = devH == null || devL == null
          ? "" : Math.round(devH) + "/" + Math.round(devL);
      }
      if (key === this._socSentKey) return;
      this._socSentKey = key;
      /* §34 / §36: two independent scalar topics. Both are sent because the two
         numbers only make sense as a pair, and the device validates the gap on
         whichever one arrives second. */
      Promise.all([
        this._publishRaw(this._topic("number/<dev_id>/soc_h_limit/set"), String(hi)),
        this._publishRaw(this._topic("number/<dev_id>/soc_l_limit/set"), String(lo)),
      ]).then(() => {
        this._socFlash(this._t(
          `Sent ${lo}–${hi} %`,
          `已下发 ${lo}–${hi} %`,
        ));
      }).catch((err) => {
        /* A failed publish must not look sent: clear the key so the next
           release retries the same pair. */
        this._socSentKey = "";
        this._socFlash(String(err && err.message ? err.message : err), true);
      });
    }

    /** The header word: idle hint, or the outcome of the last release. */
    _socStatus() {
      if (this._socSent) {
        return html`<span class="soc-flag ${this._socSentErr ? "err" : "ok"}">${this._socSent}</span>`;
      }
      return html`<span class="soc-flag">${this._t("Release to send", "拖动即下发")}</span>`;
    }

    _socFlash(text, isError) {
      this._socSent = text;
      this._socSentErr = isError === true;
      this.requestUpdate();
      if (this._socSentTimer) clearTimeout(this._socSentTimer);
      this._socSentTimer = setTimeout(() => {
        this._socSent = "";
        this._socSentTimer = null;
        this.requestUpdate();
      }, 2400);
    }

    /**
     * Newest `last_updated` (epoch ms) among the entities the firmware pushes
     * every second - the fallback heartbeat when the backend cannot answer.
     *
     * It only moves when a state *value* changes, so it under-reports: a unit
     * that comes back reporting the same readings it went away with looks silent
     * even though it is publishing every second.  `_lastMessageMs()` is
     * therefore the primary source and this is the safety net.
     *
     * `0` means "none of them says anything right now", which during a restart
     * is expected; the caller treats it as "no information" rather than as "the
     * device is gone".
     */
    _newestPublish() {
      let newest = 0;
      for (const [key, domain] of REBOOT_HEARTBEAT) {
        const state = this._state(key, domain);
        if (!state) continue;
        const stamp = Date.parse(
          state.last_reported || state.last_updated || state.last_changed || "",
        );
        if (Number.isFinite(stamp) && stamp > newest) newest = stamp;
      }
      return newest;
    }

    /** Does this unit expose any of the fast entities the reboot wait watches? */
    _hasHeartbeat() {
      return REBOOT_HEARTBEAT.some(([key, domain]) => !!this._resolve(key, domain));
    }

    /**
     * When did the backend last receive a message from this unit (epoch ms)?
     *
     * This is the only reliable "is it publishing" signal: the coordinator
     * counts every message it parses, while `hass.states` stays still when the
     * payload repeats the values already shown.
     *
     * Returns `null` when the answer is not available (an older backend, or no
     * connection), and `0` when this unit has not been heard since Home
     * Assistant started.
     */
    async _lastMessageMs() {
      if (!this._hass || typeof this._hass.callWS !== "function") return null;
      try {
        const out = await this._hass.callWS({
          type: "hoymiles/device/info",
          dev_id: this._dev(),
        });
        if (!out || out.known !== true) return null;
        const ms = Number(out.last_message);
        return Number.isFinite(ms) ? ms : 0;
      } catch (err) {
        return null;
      }
    }

    /** The two stamps the reboot wait compares against, read before the trigger. */
    async _rebootMark() {
      return { msg: await this._lastMessageMs(), state: this._newestPublish() };
    }

    /**
     * Wait for the device to restart and to publish again.
     *
     * One rule, the one the user asked for: **as soon as a message newer than
     * the one that had arrived before the trigger shows up, the unit is back** -
     * and the whole wait is capped at one minute, so a unit that does not return
     * produces an answer instead of a dialog that sits there for minutes.
     *
     * Returns `"recovered"`, `"no-heartbeat"` (nothing to watch) or `"timeout"`.
     */
    async _awaitReboot(mark) {
      const seen = mark || await this._rebootMark();
      if (seen.msg === null && !this._hasHeartbeat()) return "no-heartbeat";

      const startedAt = Date.now();
      for (;;) {
        const elapsed = Date.now() - startedAt;
        /* Messages that were already on their way when the trigger went out are
           not proof that the unit went down and came back. */
        if (elapsed >= REBOOT_GRACE_MS) {
          const ms = await this._lastMessageMs();
          if (ms === null) {
            const now = this._newestPublish();
            if (now > 0 && seen.state > 0 && now > seen.state) return "recovered";
          } else if (ms > seen.msg) {
            return "recovered";
          }
        }
        if (elapsed >= REBOOT_TIMEOUT_MS) return "timeout";
        await new Promise((r) => setTimeout(r, REBOOT_POLL_MS));
      }
    }

    _reboot() {
      const ok = window.confirm(this._t(
        "Reboot the device now?", "确认立即重启设备？",
      ));
      if (!ok) return;
      this._runAction({
        title: this._t("Reboot", "重启"),
        longRun: true,
        limitMs: REBOOT_TIMEOUT_MS + 15000,
        steps: [
          this._t("Publish the reboot trigger", "下发重启指令"),
          this._t("Wait for the device to report again (up to 1 minute)",
            "等待设备重新上报（最长 1 分钟）"),
        ],
        run: async () => {
          /* Both stamps have to be read *before* the trigger: anything that
             arrives after it is, by definition, the device answering. */
          const mark = await this._rebootMark();
          this._busySet(0, "active");
          await this._publishRaw(this._topic("button/<dev_id>/reboot/trigger"), "RESTART");
          this._busySet(0, "done");
          this._busySet(1, "active");

          const outcome = await this._awaitReboot(mark);

          if (outcome === "recovered") {
            this._busySet(1, "done", this._t(
              "The device is publishing again", "设备已重新上报",
            ));
            /* It is back: say so, then let the dialog close itself.  The pause
               is longer than the usual one because this is the end of a wait
               that can last minutes. */
            this._busyDone(this._t(
              "The device has restarted",
              "设备重启完成",
            ), 2600);
            return;
          }
          if (outcome === "no-heartbeat") {
            this._busySet(1, "done", this._t(
              "This unit reports no fast readings to watch",
              "这台设备没有可观察的实时读数",
            ));
            this._busyDone(this._t(
              "The trigger was sent. This card cannot tell when the device is back - reload in a minute to check.",
              "指令已下发。这张卡无法判断设备何时恢复，请一分钟后刷新页面确认。",
            ));
            return;
          }
          this._busySet(1, "failed", this._t(
            "No new report within a minute", "1 分钟内没有收到新上报",
          ));
          this._busyFail(this._t(
            "The trigger was sent but the device has not reported for a minute. "
            + "Check that it is powered on, then reload to see whether it came back.",
            "重启指令已下发，但 1 分钟内没有收到设备的新上报。"
            + "请确认设备已上电，然后刷新页面确认是否已恢复。",
          ));
        },
      });
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const mode = this._emsMode();
      const offline = this._deviceOffline();

      /* Card order is decided in the template and the grid placement in CSS:
         power / cut-off SOC / fan on the first band, then the power controls
         card (two tracks, i.e. the width of the two cards above it), then the
         EMS card under it, while the heater is pinned to the last track so it
         lines up under the fan. A card that does not exist on this model renders
         as an empty string, so the grid simply closes the gap - the explicit
         placement keeps the heater in the right column either way. */
      /* The two dialogs come FIRST on purpose. They are fixed overlays, so their
         position in the template has no visual meaning - but lit commits the
         template top to bottom, and a failure anywhere below used to leave them
         unrendered. A dialog that cannot appear makes every command look dead,
         so it is better for the rest of the card to lag than for the answer to
         a click to disappear. */
      return html`
        ${this._busyDialog()}
        ${this._confirmDialog()}
        ${this._banner ? html`<div class="banner" role="status">
          <span class="bi">${this._icon("heat", 17)}</span>
          <span class="bt">${this._banner}</span>
          <button class="bx" @click=${() => this._dismissBanner()}
            aria-label=${this._t("Dismiss", "关闭")}>×</button>
        </div>` : ""}
        <div class="wrap ${offline ? "offline" : ""}">
          ${offline ? html`<div class="offline-note">
            <span class="oi">${this._icon("wifiOff", 16)}</span>
            <span>${this._t(
              "The device is offline. Controls can be sent again once it is "
              + "back online.",
              "当前设备已离线，待设备恢复在线后可继续下发控制。",
            )}</span>
          </div>` : ""}
          <div class="board">
            ${this._powerCard()}
            ${this._socCard()}
            ${this._fanCard()}
            ${this._powerLimitsCard()}
            ${this._heatCard()}
            ${this._modeCard(mode)}
          </div>
        </div>
        ${this._toast === "" ? "" : html`
          <div class="toast ${this._toastError ? "err" : ""}">${this._toast}</div>`}
      `;
    }

    /* ------------------------------ cards ------------------------------ */

    /**
     * One card: header (icon + title + optional description + tooltip) and the
     * rows underneath. `rows` may contain empty strings, which are dropped - it
     * keeps the call sites readable when a row is conditional.
     */
    _card({ icon, title, sub, info, rows, cls, action }) {
      const body = (rows || []).filter((row) => row !== "" && row != null);
      return html`
        <ha-card class="c ${cls || ""}">
          <div class="c-head">
            <span class="ci">${icon}</span>
            <span class="ct">${title}${sub ? html`<span class="cs">${sub}</span>` : ""}</span>
            <span class="sp"></span>
            ${action ? html`<span class="act">${action}</span>` : ""}
            ${info ? html`<span class="info" title=${info}>
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none"
                   stroke="currentColor" stroke-width="1.9">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 11v5" stroke-linecap="round"/>
                <circle cx="12" cy="7.8" r="1.05" fill="currentColor" stroke="none"/>
              </svg></span>` : ""}
          </div>
          <div class="c-body">${body}</div>
        </ha-card>`;
    }

    /**
     * One labelled control. `inline` keeps a small control (a switch, a pair of
     * buttons) on the same line as its label; everything wider - sliders,
     * segmented pickers - gets its own line underneath.
     *
     * `bare` drops the label row because the card title already says it. A
     * subtitle is still rendered: it carries a rule the user has to know (the
     * SOC ordering, for instance), not a restatement of the title.
     *
     * `hint` is a short grey note on the label line itself - the usable range,
     * typically. It costs no extra height, which is what keeps a card with five
     * sliders readable instead of turning into a column of explanations.
     *
     * `end` is the right end of that same line, for a control that governs the
     * whole row instead of one field - the V0.6.7 group enable switches. Keeping
     * it here rather than above the Send button means the title, the range and
     * the switch are one line, and the slider column no longer has to be tall
     * enough for a switch and a button at once.
     */
    _row({ icon, label, sub, subClass, topic, ctrl, inline, bare, hint, end }) {
      const showTopics = this._config.show_topics === true;
      const note = html`
        ${sub ? html`<div class="r-sub ${subClass || ""}">${sub}</div>` : ""}
        ${showTopics && topic ? html`<div class="r-sub"><code>${topic}</code></div>` : ""}`;
      return html`
        <div class="r ${inline ? "inline" : ""} ${bare ? "bare" : ""}">
          ${bare ? note : html`
            <div class="r-main ${icon ? "" : "noicon"}">
              <div class="r-label">
                ${icon ? html`<span class="ri">${icon}</span>` : ""}<span>${label}</span>
                ${hint ? html`<span class="r-hint">${hint}</span>` : ""}
                ${end ? html`<span class="r-end ${hint ? "" : "right"}">${end}</span>` : ""}
              </div>
              ${note}
            </div>`}
          <div class="r-ctrl">${ctrl}</div>
        </div>`;
    }

    /* ------------------------------ power ------------------------------ */

    /**
     * One icon from the set, as an SVG element.
     *
     * Built as a string and injected with `_untrusted()` on purpose: a nested
     * lit template would parse its `<path>` in the HTML namespace and paint
     * nothing at all. The id prefix is per call so two cards on one page never
     * share a gradient id.
     */
    _icon(name, size = 18) {
      const build = ICON_SVG[name] || ICON_SVG.dot;
      const uid = "hmi" + (this._iconSeq = (this._iconSeq || 0) + 1) + "-";
      const body = build(uid);
      /* fill="none" on the root: the shapes that need a fill set it themselves,
         and the stroke-only ones must not inherit the default black. */
      const svg = "<svg viewBox=\"0 0 24 24\" width=\"" + size + "\" height=\""
        + size + "\" fill=\"none\" aria-hidden=\"true\" focusable=\"false\">"
        + body + "</svg>";
      return html`<span class="ic">${this._untrusted(svg)}</span>`;
    }

    /** Power on/off and the reboot command: both take the unit up or down. */
    _powerCard() {
      return this._card({
        icon: this._icon("bolt"),
        title: this._t("Power", "电源"),
        cls: "power",
        rows: [this._switchRow(), this._rebootRow()],
      });
    }

    /**
     * The EMS card: the mode picker plus whatever the active mode needs.
     *
     * The four modes are alternatives, not layers: in `general` the device
     * regulates on its own, `mqtt_ctrl` takes a setpoint from MQTT, `tou_plan`
     * derives the setpoint from the schedule and `meter_ctrl` follows a virtual
     * meter. Showing them all at once would suggest the device reads them
     * together, which it does not.
     *
     * Only the target power lives here, because it is the one control that means
     * nothing outside `mqtt_ctrl`. Everything else that belongs to a mode lives
     * with that mode: the fine control block (grid setpoint, PV ceiling, the two
     * forbid switches, the off-grid relay) only appears in `fine_ctrl`, and the
     * virtual meter setpoint only in `meter_ctrl`. The mode independent power
     * ceilings - output, input, per-phase - stay in the power controls card, and
     * the heater has a card of its own.
     */
    _modeCard(mode) {
      /* A **slave** keeps this card - it can run its own regulation or the
         device level precise control - but only those two modes are offered
         (§7/§8 with the system level modes belonging to the master).
         `_emsOptions()` is what narrows the picker, so this method never has to
         branch on the role: the fewer buttons are the whole difference, and the
         card width follows them (see `wide` below). */
      const rows = [this._emsRow()];

      if (mode === "mqtt_ctrl") {
        if (this._config.show_power_ctrl !== false) {
          rows.push(html`<div class="sep"></div>`);
          rows.push(this._powerCtrlRow());
        }
      } else if (mode === "tou_plan") {
        rows.push(html`<div class="sep"></div>`);
        /* The plan itself, in the same card. `embedded: true` strips the
           editor's own card chrome, title and heading - all of them are already
           on this card. Read / Send belong to the plan and are rendered by the
           editor itself, directly above the week plan. */
        rows.push(html`
          <div class="tou-host"><hoymiles-tou-editor></hoymiles-tou-editor></div>`);
      } else if (mode === "fine_ctrl") {
        /* §42: the fine control block. Every row writes only its own field into
           the shared object, which the document allows. */
        rows.push(html`<div class="sep"></div>`);
        /* The three on/off fields first, on one line: they are what a user flips
           while watching the power flow, and the two sliders below them are the
           ones that need the room. */
        rows.push(this._fineSwitchRow());
        rows.push(this._fineGridRow());
        /* §42 carries the PV ceiling in the same object, so it is shown here too
           - it is a fine control field and the device ignores it in any other
           mode. Only the 4020 X implements it, though: the AC coupled cabinets
           have no MPPT to limit, so the row is not drawn there at all. */
        if (this._has("pv_power_limit") && this._allowFineExtras()) {
          rows.push(this._pvRow());
        }
        /* One timer for the object, at the bottom where it reads as "all of the
           above", matching the power row's strip. */
        rows.push(this._fineLeaseRow());
      } else if (mode === "meter_ctrl") {
        rows.push(html`<div class="sep"></div>`);
        /* The two cumulative readings come FIRST: they are the two numbers a
           real meter shows, and they are set together, so they share one line
           above the setpoint rather than sitting under it (V0.6.5 §11). */
        rows.push(this._meterEnergyRow());
        rows.push(this._meterRow());
        /* Proof that something outside is driving the meter: how many writes were
           accepted since the mode was entered, plus the newest one. Repeats of
           that same object deliberately do not move the counter. */
        rows.push(this._meterRxRow());
        /* The point of a virtual meter is that something *else* drives it, and
           that something cannot use the WebSocket API - see `http_api.py`. */
        rows.push(this._meterHttpBlock());
      } else {
        rows.push(html`<div class="sep"></div>`);
        /* One sentence for every role, and it never names a mode - but the
           picker above it does, so "another mode" always points at something
           the user can actually see, whether the card carries five buttons or
           two. Naming a mode was tried twice and lost both times: a name that
           is right for a master is wrong for a slave, and picking the one
           remaining mode still hard-codes a sentence per hardware variant.
           "set it manually" says what the user gains instead of a vaguer
           "control how the device runs". */
        rows.push(html`<div class="note">${this._t(
          "Self-consumption: the device decides its operating state on its own. "
          + "To set it manually, switch to another mode.",
          "自发自用：设备运行状态由设备自行决定。如需人为设定，请切换至其他模式。",
        )}</div>`);
      }

      /* `wide` is decided by what the card actually shows: the picker needs two
         tracks once it carries four or five modes, and a setpoint row or the
         plan editor needs two whatever the picker holds. Two modes (a slave)
         fit in one track, so that card is exactly as wide as the cards above
         it instead of stretching over a track it does not use. */
      const wide = mode === "mqtt_ctrl" || mode === "tou_plan"
        || mode === "fine_ctrl" || mode === "meter_ctrl"
        || this._emsOptions().length > 3;

      return this._card({
        /* A battery icon said "this is the battery" - but the card is not about
           the battery, it is about HOW the device decides the charge and
           discharge power. Three faders say "control scheme". */
        icon: this._icon("faders"),
        title: this._t("EMS mode", "EMS 模式"),
        sub: mode || "",
        cls: wide ? "ems wide" : "ems",
        info: this._t(
          "How the device decides the charge and discharge power. The controls "
          + "below change with the selected mode.",
          "设备如何决定充放电功率。下方控件随所选模式变化。",
        ),
        rows,
      });
    }

    /** True when this device publishes any fan entity (protocol §35 - §38). */
    _hasFan() {
      return this._has("fan_mode", "select") || this._has("pcs_fan_speed");
    }

    /**
     * The fan card (protocol §35 - §38).
     *
     * The picker sits at the top of the card and the rest of the card explains
     * the mode it is in: the two speed bars in `manual`, a sentence otherwise.
     * In `auto` the firmware owns the speed and in `off` the fans do not turn at
     * all, so showing bars there would invite edits the device ignores - and the
     * leftover space is a good place to say why nothing is moving.
     */
    _fanCard() {
      if (!this._hasFan()) {
        // No fan on this model: no card at all, so the grid does not keep an
        // empty cell for a row that has nothing to show.
        return "";
      }
      const manual = this._fanMode() === "manual";
      const rows = [];
      if (this._has("fan_mode", "select")) rows.push(this._fanModeRow());
      if (manual && this._has("pcs_fan_speed")) rows.push(this._fanSpeedRow());
      else rows.push(this._fanHintRow());
      return this._card({
        icon: this._icon("fan"),
        title: this._t("Fan", "风扇"),
        cls: "fan",
        info: this._t(
          "Auto lets the firmware regulate the fans from the temperature. "
          + "Manual opens the speed levels below. Off stops the fans entirely.",
          "自动：由固件按温度调节。手动：展开下方转速档位。"
          + "关闭：完全关闭风扇。",
        ),
        rows,
      });
    }

    /**
     * The ceiling categories this unit actually has (protocol §21 - §32).
     *
     * Four groups, and which of them exist is decided by two things only:
     *
     *   io     output / input ceiling  (§21-§26)  master or stand-alone
     *   phase  per-phase output+input  (§23/§28)  multi phase master
     *   house  per-phase house input   (§31/§32)  multi phase master
     *   feed   feed-in ceiling         (§29/§30)  **master only**
     *
     * The picker lists them **in that order**, which is the order of the
     * protocol and the order the limits get tighter in: what the box may put
     * out / take in, then the same per phase, then what the house may draw per
     * phase, and finally what may leave for the grid.  Feed-in used to sit
     * second, which put it before the two groups that are about the same
     * hardware.
     *
     * A per-phase group needs nothing more than the entities the integration
     * creates *from* the group's `meta` topic: a unit that does not publish that
     * topic never gets them, so "does the entity exist" is the exact capability
     * test (unlike a value check, which would also be true on a stale entity).
     */
    _powerLimitGroups() {
      const showPhase = this._config.show_phase !== false;
      const groups = [];

      const io = [];
      if (this._has("output_power")) io.push(this._outputRow());
      if (this._has("input_power")) io.push(this._inputRow());
      if (io.length) {
        groups.push({
          id: "io", en: "Input / output", zh: "输入/输出", rows: io,
        });
      }

      const phase = [];
      /* The per-phase OUTPUT entities exist on every device (number.py creates
         them unconditionally), so "the entity exists" proves nothing there - the
         capability test is whether the device actually reports a phase value
         (§46 `phase_output_power`). The two V0.6.6 groups are only created from
         their `meta` topic, so for them existence IS the test. */
      if (showPhase && this._allowPhase() && this._has(PHASE_LIMITS[0].keys[0])) {
        phase.push(this._phaseRow(PHASE_LIMITS[0]));
      }
      if (showPhase && this._has(PHASE_LIMITS[1].keys[0])) {
        phase.push(this._phaseRow(PHASE_LIMITS[1]));
      }
      if (phase.length) {
        groups.push({
          id: "phase",
          en: "Per-phase input / output",
          zh: "多相输入/输出",
          rows: phase,
        });
      }

      if (showPhase && this._has(PHASE_LIMITS[2].keys[0])) {
        /* V0.6.7 §31: the three limits only mean anything while the group's own
           `enable` is on, so the switch rides in the row and the sliders are
           simply not drawn while it is off (see `_phaseRow`). */
        groups.push({
          id: "house",
          en: "Per-phase house input",
          zh: "多相入户",
          rows: [this._phaseRow(PHASE_LIMITS[2], HOUSE_ENABLE)],
        });
      }

      if (this._has("feed_power") && this._allowMasterOnly()) {
        /* V0.6.7 §29: same shape as the house group - the enable switch decides
           whether the limit exists at all, so an off switch leaves one compact
           row instead of a dead slider. */
        groups.push({
          id: "feed", en: "Feed-in", zh: "馈网", rows: [this._feedRow()],
        });
      }

      return groups;
    }

    /**
     * Every power ceiling in one card (protocol §21 - §32), split into the
     * categories the unit supports.
     *
     * A cap the device enforces no matter which EMS mode is running, so none of
     * these rows belongs inside the EMS card - but a multi phase master has six
     * of them (output, feed-in, input, per-phase output, per-phase input,
     * per-phase house input) and stacking six sliders read as one long wall in
     * which the per-phase ones were easy to miss. They are therefore grouped and
     * the group picker sits on top, exactly like the EMS mode card: one category
     * at a time, and the card header names the open one.
     *
     * The picker only appears when there is something to pick: a **single** unit
     * supports just `io`, and it gets the sliders directly. A unit that supports
     * none of the groups (a slave) hides the card altogether.
     *
     * Each row is a slider with its own Send button, because the groups are
     * separate topics: a shared button would publish values nobody edited. The
     * per-phase rows send all three phases in one message, which is why they
     * have a single joint Send.
     */
    _powerLimitsCard() {
      /* §21-§32: a slave publishes and accepts none of these, so the card would
         be a stack of dead sliders. */
      if (!this._allowMaster()) return "";

      const groups = this._powerLimitGroups();
      if (!groups.length) return "";

      /* The open category: the remembered one when this unit still has it, else
         the first. A role change can remove `feed`/`phase`/`house` while their
         tab was open, and falling back instead of rendering nothing keeps the
         card usable. */
      const picked = groups.find((group) => group.id === this._plimTab) || groups[0];

      const rows = [];
      if (groups.length > 1) {
        rows.push(this._row({
          bare: true,
          topic: "",
          ctrl: this._segment(
            groups.map((group) => ({
              id: group.id,
              label: this._t(group.en, group.zh),
              title: group.id,
            })),
            picked.id,
            (id) => {
              this._plimTab = id;
              this.requestUpdate();
            },
            "fluid",
          ),
        }));
        rows.push(html`<div class="sep"></div>`);
      }
      rows.push(...picked.rows);

      return this._card({
        icon: this._icon("powerLimit"),
        title: this._t("Power controls", "功率控制"),
        /* Only worth repeating in the header when there is a choice: with one
           category the header would say "Input / output" under a title that
           already means exactly that. */
        sub: groups.length > 1 ? this._t(picked.en, picked.zh) : "",
        cls: "plim",
        info: this._t(
          "The ceilings the device enforces, grouped by what they limit. Output "
          + "and the per-phase limits cap how much the unit may deliver; the "
          + "input limits cap how much it may take in; the feed-in limit caps how "
          + "much may be exported. Lowering a ceiling does not change the power "
          + "flowing right now. The per-phase limits are one message - all three "
          + "phases are always sent together.",
          "设备强制执行的功率上限，按限制对象分类。「输出」与「多相输入/输出」"
          + "限制设备可输出的最大功率，「输入」限制可输入的最大功率，"
          + "「馈网」限制可向电网馈电的最大功率；「多相入户」限制每相入户可取的功率。"
          + "改上限不会立即改变当前功率。"
          + "分相项都是同一条报文，三相总是同时下发。",
        ),
        rows: [html`<div class="pc-list">${rows}</div>`],
      });
    }

    /**
     * The heater, on a card of its own (protocol §39 - §40).
     *
     * It used to be a row among the power ceilings, which stopped making sense
     * once the rest of that card became "maximum input / output": the heater is
     * not a ceiling on power, it is an appliance inside the unit, and its one
     * `param` field changes unit (W or °C) with the mode. Giving it its own card
     * also gives the mode picker somewhere to live that does not read as part of
     * the output limit above it.
     *
     * The card follows the fan card's shape: the picker sits on top and the rest
     * of the card explains the mode it is in.  Off shows a sentence (the
     * firmware ignores both `param` and `pack_ids` then, so sliders there would
     * invite edits that do nothing); Power and Temperature show the target packs
     * and the setpoint, in that order - which packs first, then how hard.
     *
     * **One Send for the whole card.**  §40 lets a write be partial, but a
     * partial write is only honest when the card agrees with it: the card shows
     * all three fields, so one button publishes all three and the device ends up
     * in exactly the state on screen.  Two buttons (one for the setpoint, one for
     * the packs) made the user reason about which of the two they needed - and
     * invited a pack change that silently never happened.
     */
    _heatCard() {
      if (!this._has("heat_param")) return "";
      const mode = this._heatModeShown();
      const off = mode === HEAT_MODE_OFF;
      const rows = [];
      if (this._has("heat_mode", "select")) rows.push(this._heatModeRow());
      if (off) {
        rows.push(this._heatHintRow());
      } else {
        /* Packs first: *which* batteries are heated is the broader decision, and
           it reads naturally above the setpoint it applies to. */
        if (this._packCount() > 0) rows.push(this._heatPackRow());
        rows.push(this._heatRow());
        /* The single line that saves a support question: the command is applied
           immediately, but the state the card draws its chips from only arrives
           in the 5-minute `device/state`, so the pack badges can lag behind the
           picker by up to five minutes. */
        rows.push(html`
          <div class="c-hint">${this._t(
            "The packs' heating state appears with the next 5-minute device report.",
            "电池包的加热状态会在下一次 5 分钟实时数据后显示。",
          )}</div>`);
      }
      return this._card({
        icon: this._icon("heat"),
        title: this._t("Heating control", "加热控制"),
        cls: "heat",
        info: this._t(
          "The heater inside the unit. Off stops it; Power sets a wattage; "
          + "Temperature heats the selected packs up to a target. The target "
          + "packs are a multi-select, and only the packs this unit actually has "
          + "are offered.",
          "设备内置的加热。关闭即停止加热；功率模式设定瓦数；"
          + "温度模式把选中的电池包加热到目标温度。"
          + "目标电池包可多选，只列出本机实际安装的电池包。",
        ),
        rows,
      });
    }

    /**
     * The charge / discharge cut-off SOC, on its own card (protocol §34).
     *
     * A card of its own because these two sliders are about the battery rather
     * than about power, and because they have to be set against each other -
     * mixing them in with the wattage rows invited edits that only half made
     * sense.
     */
    _socCard() {
      if (!this._has("charge_soc_limit") && !this._has("discharge_soc_limit")) {
        return "";
      }
      return this._card({
        /* 20 px rather than the default 18: this badge carries a battery AND
           two arrows, and at 18 the arrow heads turned into dots. */
        icon: this._icon("socBattery", 20),
        title: this._t("Cut-off SOC", "截止电量"),
        cls: "soc",
        info: this._t(
          "Where charging stops and where discharging stops. Discharging is the "
          + "left handle, charging the right one, and the charge cut-off must sit "
          + `at least ${SOC_MIN_GAP} % above the discharge cut-off so a cycle `
          + "always has room to work with - the handles stop before they meet.",
          "停止充电与停止放电的位置。左边是放电截止、右边是充电截止；"
          + `充电截止必须比放电截止至少高 ${SOC_MIN_GAP} %，`
          + "给一次充放循环留出余量——两根滑钮会在相遇之前停住。",
        ),
        /* No Send button: releasing a handle publishes the pair, so the header
           carries a state word instead - where a button would have been, so the
           header is the same width either way and nothing shifts when it
           changes from the idle hint to the result. */
        action: this._socStatus(),
        rows: [this._socRow()],
      });
    }

    /* --------------------------- dialog render --------------------------- */

    /** The progress dialog; empty string while nothing is running. */
    _busyDialog() {
      const busy = this._busy;
      if (!busy) return "";
      const steps = busy.steps || [];
      const total = steps.length || 1;
      const done = steps.filter((s) => s.state === "done").length;
      const running = steps.some((s) => s.state === "active") ? 0.5 : 0;
      const pct = busy.state === "ok"
        ? 100
        : Math.min(100, Math.round(((done + running) / total) * 100));
      const failed = busy.state === "error";
      const ok = busy.state === "ok";
      return html`
        <div class="overlay" role="dialog" aria-live="polite">
          <div class="modal ${failed ? "err" : ""} ${ok ? "ok" : ""}">
            <div class="m-title">
              ${failed
                ? html`<span style="color:var(--error-color)">✕</span>`
                : ok
                  ? html`<span style="color:var(--success-color, #0da035)">✓</span>`
                  : html`<span class="spin"></span>`}
              <span>${busy.title}</span>
            </div>

            <div class="pbar"><div class="pfill" style="width:${pct}%"></div></div>

            <div class="steps">
              ${steps.map((step) => html`
                <div class="st ${step.state}">
                  <span class="mk">${step.state === "done"
                    ? "✓"
                    : step.state === "failed"
                      ? "✕"
                      : step.state === "active"
                        ? html`<span class="spin"></span>`
                        : "○"}</span>
                  <span>${step.text}</span>
                </div>`)}
            </div>

            ${busy.message ? html`<div class="m-msg">${busy.message}</div>` : ""}

            ${failed || ok ? "" : html`<div class="m-foot">
              <span class="r-sub">${this._t("Please wait…", "请稍候…")}</span>
            </div>`}
            ${failed ? html`<div class="m-foot">
              <button class="btn" @click=${() => this._busyClose()}>
                ${this._t("Close", "关闭")}
              </button>
            </div>` : ""}
          </div>
        </div>`;
    }

    /**
     * The yes/no dialog. No progress bar and no spinner: nothing is running,
     * the card is waiting for an answer.
     */
    _confirmDialog() {
      const ask = this._confirm;
      if (!ask) return "";
      return html`
        <div class="overlay" role="dialog" aria-modal="true">
          <div class="modal confirm">
            <div class="m-title"><span>⚠️</span><span>${ask.title}</span></div>
            <div class="m-msg">${ask.message}</div>
            <div class="m-foot">
              <button class="btn" @click=${() => this._answerConfirm(false)}>
                ${ask.cancelText}
              </button>
              <button class="btn danger" @click=${() => this._answerConfirm(true)}>
                ${ask.confirmText}
              </button>
            </div>
          </div>
        </div>`;
    }

    /** iOS segmented control. `options` = [{id, label, enabled, title, pending}] */
    _segment(options, current, onPick, extraClass = "") {
      return html`
        <div class="seg ${extraClass}">
          ${options.map((opt) => html`
            <button class=${[
              opt.id === current ? "on" : "",
              opt.pending ? "pending" : "",
            ].filter(Boolean).join(" ")}
              ?disabled=${opt.enabled === false}
              title=${opt.title || ""}
              @click=${() => onPick(opt.id)}>${opt.label}</button>`)}
        </div>`;
    }

    /**
     * One slider: a thick track on the left, a plain read-out and its unit on
     * the right. The read-out is TEXT on purpose - the value is only ever
     * changed by dragging, so an editable box was a second way in that could
     * disagree with the knob.
     *
     * Dragging only updates the draft value; nothing is published until the send
     * button is pressed (the power values have to be re-sent every minute, so
     * publishing on every input event would flood the broker).
     */
    _slider({ value, min, max, step, unit, tag, compact, title, disabled, onInput, onSend, sendLabel }) {
      const lo = num(min);
      const hi = num(max);
      const current = Number(value);
      /* An empty draft is not 0: showing "0" next to a slider that starts at 50
         reads as a real reading. The knob sits at the low end instead and the
         read-out stays blank until the device reports a value. */
      const has = value !== "" && value != null && Number.isFinite(current);
      const safe = has ? current : lo;
      const span = hi - lo;
      const frac = span > 0 ? Math.min(Math.max((safe - lo) / span, 0), 1) : 0;

      /* Painting the bar here is what makes dragging feel immediate.
         Writing the draft field alone does not re-render this element (the draft
         fields are plain instance fields, not reactive properties), so the knob
         moved at once while the fill only jumped to its new size on the next
         state update - a second or two later. Setting --frac on the bar in the
         input handler removes that dependency completely. */
      const paint = (barEl, raw) => {
        if (!barEl || raw === "" || raw == null || span <= 0) return;
        const v = Number(raw);
        if (!Number.isFinite(v)) return;
        const f = Math.min(Math.max((v - lo) / span, 0), 1);
        barEl.style.setProperty("--frac", String(f));
      };
      /* An input handler may RETURN the value it accepted: the two cut-off SOCs
         use that to stop a slider at its neighbour instead of accepting a pair
         the firmware would silently drop. Returning undefined keeps whatever
         the user chose. */
      const settle = (raw) => {
        const fixed = onInput(raw);
        return fixed == null ? raw : String(fixed);
      };
      /* The read-out follows the knob without waiting for a render.
         It is written INTO lit's text node, never by replacing the span's
         children: the span holds a comment marker that lit uses to find its own
         part, and `out.textContent = v` deletes that marker. The next render
         then tries to set `.data` on a node that is gone, throws, and aborts the
         whole update - so everything after the failure point stayed stale. The
         visible symptom was brutal: one drag and the Send button stopped opening
         its dialog, because the dialog sits at the END of the card template. */
      const fromTrack = (e) => {
        const el = e.target;
        const barEl = el.parentElement;
        const v = settle(el.value);
        if (v !== "" && v !== el.value) el.value = v;
        paint(barEl, v);
        const out = barEl.nextElementSibling;
        if (!out) return;
        const node = out.lastChild;
        if (node && node.nodeType === Node.TEXT_NODE) node.data = String(v);
        /* No text node to write into (first interaction of a blank slider):
           let lit draw it, so the span gets its node back. */
        else this.requestUpdate();
      };

      return html`
        <div class=${compact ? "slider compact" : "slider"}>
          ${tag ? html`<span class="tag">${tag}</span>` : ""}
          <div class="bar" style="--frac:${frac.toFixed(3)}" title=${title || ""}>
            <span class="ffill"></span>
            <span class="fknob"></span>
            <input type="range" min=${lo} max=${hi} step=${step}
              .value=${String(safe)} ?disabled=${disabled} @input=${fromTrack} />
          </div>
          <span class="val">${has ? current : ""}</span>
          <span class="unit">${unit}</span>
          ${onSend ? html`
            <button class="btn primary" ?disabled=${disabled}
              @click=${onSend}>${sendLabel}</button>` : ""}
        </div>`;
    }

    /** Slider bounds for a numeric entity, with the protocol defaults. */
    _bounds(key, fallbackLo, fallbackHi) {
      const rawLo = this._attr(key, "number", "min");
      const rawHi = this._attr(key, "number", "max");
      const lo = rawLo != null ? num(rawLo) : fallbackLo;
      const hi = rawHi != null ? num(rawHi) : fallbackHi;
      // A degenerate range would divide by zero in the fill calculation.
      return hi > lo ? { lo, hi } : { lo: fallbackLo, hi: fallbackHi };
    }

    /** Keep a value inside a range (invalid input falls back to the low bound). */
    _clamp(value, lo, hi) {
      const v = num(value);
      if (!Number.isFinite(v)) return lo;
      return Math.min(Math.max(v, lo), hi);
    }

    /**
     * The cut-off pair as it will actually be sent, plus the geometry the
     * dual-handle track needs.
     *
     * `l` and `h` are clamped to their own bands (discharge low, charge high) and
     * kept at least `SOC_MIN_GAP` points apart. Renderer, seeder and sender all
     * go through this, so the numbers on the card can never disagree with the
     * message Send publishes.
     *
     * `tLo`/`tHi` are the ends of the SHARED track: the outermost position either
     * handle can reach, so the two handles never leave the drawn rail. With the
     * default bands that is exactly 10..100 %.
     */
    _socPair() {
      const chg = this._bounds("charge_soc_limit", SOC_CHARGE.lo, SOC_CHARGE.hi);
      const dis = this._bounds("discharge_soc_limit", SOC_DISCHARGE.lo, SOC_DISCHARGE.hi);
      const hLo = Math.max(chg.lo, SOC_CHARGE.lo);
      const hHi = Math.min(chg.hi, SOC_CHARGE.hi);
      const lLo = Math.max(dis.lo, SOC_DISCHARGE.lo);
      const lHi = Math.min(dis.hi, SOC_DISCHARGE.hi);
      /* An empty draft falls back to the edge of its band: the top for the
         charge cut-off (charge as full as allowed) and the bottom for the
         discharge one (run the battery down as far as allowed). */
      const read = (raw, fallback) => {
        const v = Number(raw);
        return raw !== "" && raw != null && Number.isFinite(v) ? v : fallback;
      };
      let h = Math.min(Math.max(read(this._socH, hHi), hLo), hHi);
      let l = Math.min(Math.max(read(this._socL, lLo), lLo), lHi);
      /* The gap has to hold even when the device reports a pair that ignores it.
         The discharge side gives way first - it is the one with room below it -
         and only when it has none does the charge side move up. */
      if (h - l < SOC_MIN_GAP) {
        if (h - SOC_MIN_GAP >= lLo) {
          l = h - SOC_MIN_GAP;
        } else {
          l = lLo;
          h = Math.min(l + SOC_MIN_GAP, hHi);
        }
      }
      return {
        h, l, hLo, hHi, lLo, lHi,
        tLo: Math.min(lLo, hLo),
        tHi: Math.max(lHi, hHi),
      };
    }

    _switchRow() {
      const view = this._switchView();
      /* This switch is NOT a power cut: `ON` wakes the unit and `OFF` puts it
         into standby (firmware `switch` command). Calling it "Power / On / Off"
         suggested a hard power switch and made "standby" look like a fault, so
         the row now says exactly what it does - sleep - and the two buttons
         name the two states instead of On/Off.

         The icon is an inline SVG rather than `⏻` (U+23FB): that code point is
         missing from most system fonts and rendered as an empty box. */
      /* Short on purpose: this line lives in the narrow text column left of the
         two buttons, so it has to stay one line there. The long explanation is
         in the card tooltip. */
      const sub = view.pending
        ? this._t(
          view.pending === "on" ? "Waking…" : "Sleeping…",
          view.pending === "on" ? "正在唤醒…" : "正在休眠…",
        )
        : view.confirmed
          ? this._t(
            view.on ? "Awake ✓" : "Asleep ✓",
            view.on ? "已唤醒 ✓" : "已休眠 ✓",
          )
          : view.on
            ? this._t("Awake", "运行中")
            : this._t("Asleep", "已休眠");
      const subClass = view.pending ? "busy" : view.confirmed ? "done" : "";
      /* `inline`: the two buttons belong on the right, next to what they switch.
         That leaves a ~110 px text column, which is exactly why the subtitle
         above is a word and not a sentence. */
      return this._row({
        icon: this._icon("moon"),
        inline: true,
        label: this._t("Sleep", "休眠"),
        sub,
        subClass,
        topic: this._topic("switch/<dev_id>/set"),
        ctrl: this._segment(
          [
            { id: "on", label: this._t("Awake", "唤醒"),
              pending: view.pending === "on" },
            { id: "off", label: this._t("Asleep", "休眠"),
              pending: view.pending === "off" },
          ],
          view.on ? "on" : "off",
          (id) => this._setSwitch(id === "on"),
        ),
      });
    }

    _emsRow() {
      const current = this._emsMode();
      const supported = this._emsOptions();
      /* Only the offered modes are listed: a **slave** getting two of the five
         is the point, not a gap. Greying out the other three kept explaining
         modes the unit can never enter - and the five-column layout left them
         looking like dropped buttons. */
      const options = EMS_MODES
        .filter((mode) => supported.includes(mode.id))
        .map((mode) => ({
          id: mode.id,
          label: this._t(mode.en, mode.zh),
          enabled: true,
          title: mode.id,
        }));
      /* No label and no subtitle: the card header already reads "EMS mode" and
         repeats the active mode right next to it, so a second heading was three
         lines of the same information stacked on top of a picker that says it
         all by itself. */
      return this._row({
        bare: true,
        topic: this._topic("select/<dev_id>/ems_mode/command"),
        ctrl: this._segment(options, current, (id) => this._setEmsMode(id),
          supported.length <= 2 ? "fluid" : "fluid ems5"),
      });
    }

    _powerCtrlRow() {
      const ready = this._emsMode() === "mqtt_ctrl";
      const { lo, hi } = this._bounds("power_ctrl", -1000, 1000);
      const nextIn = this._repeatNextIn();
      /* While a job is running the server owns the interval; the draft in the box
         only applies once it has been sent there again. */
      const every = this._repeatActive()
        ? this._repeatState.interval
        : this._repeatInterval();
      /* The sign is the whole point of this row and the protocol never says it:
         positive discharges, negative charges. Without it the slider looks like
         a plain 0 ~ N W control and nobody tries the negative half. */
      const sign = this._t("+ discharge, − charge", "+ 放电，− 充电");
      /* The repeat runs in Home Assistant, so it keeps going when the EMS mode is
         switched away (the device then ignores the commands). The row must not
         invite edits that do nothing, so the switch and the interval follow
         `ready` too. */
      const sub = !ready
        ? this._t("switch EMS to mqtt_ctrl first", "需先切到 mqtt_ctrl")
        : !this._repeatOn
          ? this._t(
            `${lo} ~ ${hi} W · ${sign} · timer off: the device reverts to its own `
            + "control about a minute after the last send",
            `${lo} ~ ${hi} W · ${sign} · 定时已关闭：最后一次下发约一分钟后，设备恢复自行控制`,
          )
          : nextIn == null
            ? this._t(
              `${lo} ~ ${hi} W · ${sign} · press Send to start the ${every} s re-send`,
              `${lo} ~ ${hi} W · ${sign} · 点「下发」后开始每 ${every} s 重发`,
            )
            : this._t(
              `${lo} ~ ${hi} W · ${sign} · re-sent every ${every} s by Home `
              + `Assistant, next in ${nextIn} s`,
              `${lo} ~ ${hi} W · ${sign} · 由 Home Assistant 每 ${every} s 重发，`
              + `${nextIn} s 后发送`,
            );
      return this._row({
        icon: this._icon("target"),
        label: this._t("Target power", "目标功率"),
        sub,
        subClass: this._repeatActive() ? "live" : "",
        topic: this._topic("number/<dev_id>/power_ctrl/set"),
        ctrl: html`
          ${this._slider({
            value: this._powerCtrl,
            min: lo,
            max: hi,
            step: 0.1,
            unit: "W",
            disabled: !ready,
            sendLabel: this._t("Send", "下发"),
            onInput: (v) => { this._powerCtrl = v; },
            onSend: () => this._sendPowerCtrl(),
          })}
          <div class="repeat-row ${this._repeatActive() ? "on" : ""}">
            <span class="repeat-ico">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                   stroke="currentColor" stroke-width="2.2"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/>
                <path d="M20.5 3.5v4.2h-4.2"/>
              </svg>
            </span>
            <span class="cap">${this._t("Every", "每隔")}</span>
            <input type="number" min=${REPEAT_MIN_S} max=${REPEAT_MAX_S} step="1"
              .value=${this._repeatEvery}
              ?disabled=${!ready || !this._repeatOn}
              @change=${(e) => {
                this._repeatEvery = e.target.value;
                this._applyRepeatInterval();
              }} />
            <span class="cap">${this._t("s", "秒")}</span>
            <span class="spacer"></span>
            <ha-switch .checked=${this._repeatOn} ?disabled=${!ready}
              @change=${(e) => this._onRepeatSwitch(e)}></ha-switch>
          </div>`,
      });
    }

    /**
     * The switch is bound one way, so a declined question has to be undone by
     * hand: Lit only writes `checked` when the property changed, and here the
     * model never moved (it stayed on).
     */
    async _onRepeatSwitch(event) {
      const knob = event.currentTarget;
      const wanted = knob.checked === true;
      const applied = await this._setRepeat(wanted);
      if (!applied) knob.checked = this._repeatOn;
    }

    _outputRow() {
      const { lo, hi } = this._bounds("output_power", 100, 2000);
      return this._row({
        icon: this._icon("ceiling"),
        label: this._t("Output power limit", "输出功率上限"),
        hint: `${lo} ~ ${hi} W`,
        topic: this._topic("number/<dev_id>/output_power/set"),
        ctrl: this._slider({
          value: this._outputPower,
          min: lo,
          max: hi,
          step: 1,
          unit: "W",
          sendLabel: this._t("Send", "下发"),
          onInput: (v) => { this._outputPower = v; },
          onSend: () => this._sendOutputPower(),
        }),
      });
    }

    /**
     * One "all three phases in one object" row (§23/§24 output, §27/§28 input
     * limit, §31/§32 house input limit).
     *
     * Every one of the three is the same number when the device reports them -
     * §46 echoes the whole object - so the row only makes sense when something
     * has been reported: on a unit that is not a multi phase master the three
     * reads stay `unknown`, and the row says so instead of offering a Send that
     * could only fail on a blank value.
     */
    _phaseRow(spec = PHASE_LIMITS[0], enable = null) {
      const { lo, hi } = this._bounds(spec.keys[0], PHASE_BAND.lo, PHASE_BAND.hi);
      const draft = this[spec.draft] || { a: "", b: "", c: "" };
      const known = spec.keys.some((key) => this._number(key) != null);
      /* V0.6.7: a group with an `enable` control (the house input limit) is
         drawn **only while it is on**.  An off group collapses to its label plus
         the switch, because a slider whose value the device ignores is a trap:
         setting 800 W there looked done and did nothing. */
      const toggle = enable && this._has(enable.key, "switch")
        ? this._enableSwitch(enable)
        : "";
      if (enable && toggle && !this._enableState(enable.key)) {
        return this._row({
          inline: true,
          icon: this._icon(spec.icon),
          label: this._t(spec.en, spec.zh),
          sub: this._t(enable.offEn, enable.offZh),
          topic: this._topic(spec.topic),
          end: toggle,
          ctrl: "",
        });
      }
      const row = (key, label) => this._slider({
        tag: label,
        compact: true,
        value: draft[key],
        min: lo,
        max: hi,
        step: 1,
        unit: "W",
        onInput: (v) => {
          this[spec.draft] = { ...(this[spec.draft] || {}), [key]: v };
        },
      });
      return this._row({
        icon: this._icon(spec.icon),
        label: this._t(spec.en, spec.zh),
        hint: `${this._t(`${lo} ~ ${hi} W each`, `每相 ${lo} ~ ${hi} W`)}`
          + (known ? "" : ` · ${this._t("not reported", "设备未上报")}`),
        topic: this._topic(spec.topic),
        /* The enable switch rides on the label line, not above Send: it governs
           the whole group, and stacking it in the button column pushed the
           range text off to a second visual centre. */
        end: toggle,
        ctrl: html`
          <div class="slider-group">
            <div class="sg-rows">${row("a", "A")}${row("b", "B")}${row("c", "C")}</div>
            <div class="sg-act">
              <button class="btn primary"
                ?disabled=${!known}
                title=${this._t("Sends all three phases in one message",
                  "三相上限一条报文一起下发")}
                @click=${() => this._sendPhase(spec)}>${this._t("Send", "下发")}</button>
            </div>
          </div>`,
      });
    }

    /**
     * V0.6.7: the `enable` switch of a gated limit group.
     *
     * §30 / §32 put this flag in the SAME object as the limits, so it is drawn
     * in the group's own row, at the **end of its label line**, next to the
     * range text - a switch governs the whole group, so it belongs beside the
     * heading rather than in the button column, and the title, the range and the
     * toggle then read as one line.  It writes only this one field:
     * both topics accept a partial object, and the device keeps the limits when
     * the switch is turned off (they are not reset to 0).
     *
     * The value shown is the entity built from the group's `meta` topic, which
     * reads §46's echo; a just-clicked value is held until the device reports
     * it, so the knob does not spring back during the round trip.
     */
    _enableSwitch(spec) {
      const on = this._enableState(spec.key);
      return html`<ha-switch class="gate" .checked=${on}
        title=${this._t(spec.en, spec.zh)}
        @change=${(e) => this._setEnable(spec, e.target.checked)}></ha-switch>`;
    }

    /**
     * The state of one group enable switch: the device's, or the pending click.
     *
     * `_optimistic` is shared with the power switch / EMS picker, so the key is
     * the entity name (`feed_power_enable`).  The pending value is dropped as
     * soon as the entity agrees with it - until then the device's older value
     * would snap the knob back on the next render.
     *
     * **Not reported yet answers `true`.**  A device whose `event/state` has not
     * landed (or a firmware that does not echo the block) must not lose its
     * limit sliders: "unknown" is not "off", and blanking a working control for
     * the first seconds after a restart is worse than showing it a moment early.
     */
    _enableState(key) {
      const state = this._state(key, "switch");
      const live = state ? String(state.state) === "on" : null;
      const pending = this._optimistic[key];
      if (pending === true || pending === false) {
        if (live === pending) {
          delete this._optimistic[key];
          return live;
        }
        return pending;
      }
      return live == null ? true : live;
    }

    /** §30 / §32: publish one `enable` field, nothing else. */
    _setEnable(spec, on) {
      const label = this._t(spec.en, spec.zh);
      const wanted = on === true;
      this._optimistic[spec.key] = wanted;
      this.requestUpdate();
      this._runAction({
        title: label,
        steps: [this._t(
          `Send ${spec.field}: ${wanted ? "true" : "false"}`,
          `下发 ${spec.field}：${wanted ? "true" : "false"}`,
        )],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic(spec.topic), { [spec.field]: wanted });
          this._busySet(0, "done");
          this._busyDone(this._t(
            `${label}: ${wanted ? "enabled" : "disabled"}. The switch follows `
              + "what the device reports.",
            `${label}：已${wanted ? "开启" : "关闭"}。开关状态以设备回报为准。`,
          ));
        },
      });
    }

    /**
     * §29/§30: the feed-in ceiling, gated by its `enable` (V0.6.7).
     *
     * The topic takes an OBJECT (`{"limit": n}`) because the same `set` topic
     * carries the `enable` switch - a bare number would be parsed as a broken
     * object and dropped.  Only `limit` is sent, so turning the number down
     * never re-enables export.
     *
     * While export is **off** the row collapses to its label and the switch: the
     * slider would be a control whose value the device ignores.  With the limit
     * shown the switch sits at the end of the label line (`_enableSwitch`).
     */
    _feedRow() {
      const { lo, hi } = this._bounds("feed_power", FEED_POWER.lo, FEED_POWER.hi);
      const topic = this._topic("number/<dev_id>/feed_power/set");
      const toggle = this._has(FEED_ENABLE.key, "switch")
        ? this._enableSwitch(FEED_ENABLE)
        : "";
      if (toggle && !this._enableState(FEED_ENABLE.key)) {
        return this._row({
          inline: true,
          icon: this._icon("gridTower"),
          label: this._t("Feed-in limit", "馈网功率限值"),
          sub: this._t(FEED_ENABLE.offEn, FEED_ENABLE.offZh),
          topic,
          end: toggle,
          ctrl: "",
        });
      }
      return this._row({
        icon: this._icon("gridTower"),
        label: this._t("Feed-in limit", "馈网功率限值"),
        hint: this._t(`${lo} ~ ${hi} W · 0 = no export`,
          `${lo} ~ ${hi} W · 0 = 禁止馈网`),
        topic,
        end: toggle,
        ctrl: html`
          <div class="slider-group">
            ${this._slider({
              value: this._feedPower,
              min: lo,
              max: hi,
              step: 1,
              unit: "W",
              onInput: (v) => { this._feedPower = v; },
            })}
            <div class="sg-act">
              <button class="btn primary"
                @click=${() => this._sendFeedLimit()}>${this._t("Send", "下发")}</button>
            </div>
          </div>`,
      });
    }

    /* -------------------------- V0.6.2 rows -------------------------- */

    /** True when this device publishes the entity behind a protocol key.
     *
     * **Strict on purpose.**  `_resolve` ends with a "there is only one entity
     * in this domain, so it must be the one" guess, which is fine for reading a
     * value but wrong for deciding whether a feature exists: a device whose only
     * `select` is the EMS mode answered "yes" to `fan_mode` and grew a fan card
     * it cannot drive (an MS-A2).  A capability is only claimed when an entity
     * really carries this key.
     */
    _has(key, domain = "number") {
      return this._resolve(key, domain, true) != null;
    }

    /**
     * The fan mode the device reports, with the just-clicked one in front of it
     * until the device echoes it back. Unlike the EMS picker this one only has
     * a live value: `fan_mode` is published in the periodic state event, so
     * there is no "optimistic" fallback to fall back to.
     *
     * An unreported mode reads as `disable` for **display only** - the card
     * opens with the fans off, which is what a unit without a reported mode is
     * doing anyway.  The pending value is still tracked separately, so clicking
     * Off on a device that has not reported yet does send the command.
     */
    _fanMode() {
      const state = this._state("fan_mode", "select");
      const live = state ? String(state.state) : "";
      if (this._fanModePending) {
        if (live === this._fanModePending) this._fanModePending = null;
        else return this._fanModePending;
      }
      return live;
    }

    /** The mode to highlight in the picker: unknown counts as off. */
    _fanModeShown() {
      return this._fanMode() || FAN_MODE_UNKNOWN;
    }

    /**
     * The mode picker, on its own line and with no label above it: the card is
     * already called `Fan`, and the highlighted button is the state. A title
     * and a repetition of what the buttons say were only making the card tall.
     */
    _fanModeRow() {
      const current = this._fanModeShown();
      const options = FAN_MODES.map((mode) => ({
        id: mode.id,
        label: this._t(mode.en, mode.zh),
      }));
      return this._row({
        bare: true,
        topic: this._topic("<dev_id>/fan/set"),
        ctrl: this._segment(options, current, (id) => this._setFanMode(id), "fluid"),
      });
    }

    /**
     * The speed levels. Only rendered in manual mode - see `_fanCard`.
     *
     * Same slider as everywhere else, with the level as the read-out. The scale
     * is 0..10, so the tag (`PCS fan`, `Battery fan`) sits on the bar line and
     * the unit is the level itself.
     *
     * The two fans are one message (`{pcs, bat}`), so the row sends both at
     * once: a single Send per fan would publish the other one's stale draft.
     */
    _fanSpeedRow() {
      const { lo, hi } = this._bounds("pcs_fan_speed", FAN_SPEED.lo, FAN_SPEED.hi);
      const row = (field, label) => this._slider({
        tag: label,
        compact: true,
        value: this[field],
        min: lo,
        max: hi,
        step: 1,
        unit: this._t("lvl", "档"),
        onInput: (v) => { this[field] = v; },
      });
      return this._row({
        bare: true,
        topic: this._topic("<dev_id>/fan/set"),
        ctrl: html`
          <div class="slider-group">
            <div class="sg-rows">
              ${row("_fanPcs", this._t("PCS fan", "PCS 风扇"))}
              ${row("_fanBat", this._t("Battery fan", "电池风扇"))}
            </div>
            <button class="btn ghost"
              title=${this._t("Sends both fan speeds in one message",
                "两个风扇转速一条报文一起下发")}
              @click=${() => this._sendFanSpeed()}>${this._t("Send", "下发")}</button>
          </div>`,
      });
    }

    /**
     * What the card says when the firmware owns the fans.
     *
     * `off` is the state that confuses people - the unit is awake and the fans
     * stand still - so it names the reason and what to check first. `auto` only
     * needs to say that the temperature is already being handled, so nobody goes
     * looking for a speed control that is not there on purpose.
     */
    _fanHintRow() {
      const auto = this._fanMode() === "auto";
      return html`
        <div class="c-hint">
          ${auto ? this._t(
            "The firmware sets the fan speed from the device temperature. "
            + "Nothing to adjust here - switch to Manual only if you want to "
            + "fix a level yourself.",
            "系统会根据设备温度自动调节风扇转速，这里无需设置。"
            + "只有想自己固定档位时才需要切到「手动」。",
          ) : this._t(
            "The fans only spin while the battery is not in standby. Make sure "
            + "the fans are connected, then switch to Auto or Manual to start them.",
            "风扇只在电池非待机时运行。请确认风扇是否已连接，"
            + "再切换到「自动」或「手动」开启使用。",
          )}
        </div>`;
    }

    /** The heating mode the device reports (``power`` / ``temp``, §32 ``heat``). */
    _heatModeLive() {
      const state = this._state("heat_mode", "select");
      return state ? String(state.state) : "";
    }

    /**
     * The mode the card shows, which is the picked one while a switch is in
     * flight. Kept apart from `_heatModeLive` on purpose: the picker must react
     * to the click, while the slider's RANGE must not follow it until the
     * device has actually moved (see `_heatRange`).
     */
    _heatMode() {
      const live = this._heatModeLive();
      if (this._heatModePending) {
        if (live === this._heatModePending) this._heatModePending = null;
        else return this._heatModePending;
      }
      return live;
    }

    _heatModeShown() {
      return this._heatMode() || "power";
    }

    /** §40: switch the mode, and publish the state that goes with it. */
    _setHeatMode(mode) {
      if (!mode || mode === this._heatMode()) return;
      this._heatModePending = mode;
      /* The same draft means 200 W in one mode and 200 °C in the other, so it
         has to be pulled into the new range before the card redraws - otherwise
         the slider sits past its own maximum and the read-out shows a value the
         firmware would reject. */
      if (mode !== HEAT_MODE_OFF && this._heatPower !== "") {
        const next = mode === "temp" ? HEAT_TEMP : HEAT_POWER;
        this._heatPower = String(this._clamp(this._heatPower, next.lo, next.hi));
      }
      this.requestUpdate();
      /* Switching the mode publishes the whole card, not just `{mode}`.  §40
         would accept the short form (omitted fields keep their current value),
         but the card is showing a setpoint and a pack selection at that moment -
         leaving the device on an invisible older value is what makes "I picked
         Power and nothing happened" possible.  A fresh unit's draft is 0, so
         this sends `param: 0` plus every pack, exactly as one would expect. */
      this._commitHeat(mode, "Heating mode", "加热模式");
    }

    _heatModeRow() {
      const options = HEAT_MODES.map((mode) => ({
        id: mode.id,
        label: this._t(mode.label, mode.zh),
      }));
      return this._row({
        bare: true,
        topic: this._topic("<dev_id>/heat/set"),
        ctrl: this._segment(options, this._heatModeShown(),
          (id) => this._setHeatMode(id), "fluid"),
      });
    }

    /**
     * §40: the heater parameter.
     *
     * One number whose **unit and range follow the mode** (§39): watts in
     * ``power`` mode, degrees in ``temp`` mode. Showing two rows would be two
     * entities for one wire field, and the device would not know which one it
     * received.
     *
     * Its Send is the card's **only** button, and it publishes the mode and the
     * target packs along with the number - see `_heatPayload`.
     */
    /**
     * The range of `heat.param` **in the given mode**.
     *
     * `_bounds()` reads the entity's own `min`/`max`, and the heater entity's
     * range follows the mode the *device* is in (§39: one entity, two meanings).
     * Right after the user switches the picker those two disagree - the card
     * already shows Power while the device is still in Temperature - so taking
     * the entity's 0..25 band there clamped a perfectly good 120 W setpoint down
     * to 25 W. The protocol range is the correct answer for a mode the device
     * has not entered yet; the entity's own band is used only once it has.
     *
     * The comparison is against `_heatModeLive()`, NOT `_heatMode()`: the latter
     * returns the picked mode while the switch is in flight, which made this
     * method take the entity's old band exactly in the window where it is wrong
     * - the slider then showed watts on a degrees scale (and vice versa) until
     * the device echoed the mode a second or two later. That delay was the
     * "range is wrong and fixes itself after a moment" the user saw.
     */
    _heatRange(mode) {
      const fallback = mode === "temp" ? HEAT_TEMP : HEAT_POWER;
      if (this._heatModeLive() === mode) {
        /* The device's meta may advertise a wider band (0 W / 0 °C); the card's
           own limits win, and the usable band is what both agree on. */
        const live = this._bounds("heat_param", fallback.lo, fallback.hi);
        const lo = Math.max(live.lo, fallback.lo);
        const hi = Math.min(live.hi, fallback.hi);
        return hi > lo ? { lo, hi } : fallback;
      }
      return fallback;
    }

    _heatRow() {
      const mode = this._heatModeShown();
      const { lo, hi } = this._heatRange(mode);
      const unit = mode === "temp" ? "°C" : "W";
      return this._row({
        /* The card's own badge is the plain flame; the two modes get their own
           artwork so "power" and "temperature" are told apart at a glance
           instead of repeating the header icon on the row. */
        icon: this._icon(mode === "temp" ? "heatTemp" : "heatPower"),
        label: mode === "temp"
          ? this._t("Heating target", "加热目标温度")
          : this._t("Heating power", "加热功率"),
        hint: `${lo} ~ ${hi} ${unit}`,
        topic: this._topic("<dev_id>/heat/set"),
        ctrl: this._slider({
          value: this._heatPower,
          min: lo,
          max: hi,
          step: 1,
          unit,
          sendLabel: this._t("Send", "下发"),
          onInput: (v) => { this._heatPower = v; },
          onSend: () => this._sendHeat(),
        }),
      });
    }

    /**
     * What the card says with the heater switched off.
     *
     * Off is a real mode of its own (§39 lists `disable` beside `power` and
     * `temp`), not "power at 0 W": the firmware ignores both `param` and
     * `pack_ids` while it is in force, so a slider and a pack row there would
     * accept edits that never reach anything. The sentence names the two ways
     * back instead.
     */
    _heatHintRow() {
      return html`
        <div class="c-hint">
          ${this._t(
            "Heating is off. Pick Power to send a wattage, or Temperature to heat "
            + "the packs up to a target.",
            "加热已关闭。选「功率」下发热功率，或选「温度」让电池加热到设定温度。",
          )}
        </div>`;
    }

    /** How many packs this unit actually has (§27 ``pack_num``). */
    _packCount() {
      const state = this._state("pack_count", "sensor");
      const reported = state ? Math.round(num(state.state)) : 0;
      if (reported >= 1) return Math.min(reported, HEAT_PACK_MAX);
      /* No ``pack_num`` (older firmware): fall back to the highest pack that
         reports a SOC, which is the same inference the battery card uses. */
      let seen = 0;
      for (let i = 1; i <= HEAT_PACK_MAX; i += 1) {
        const soc = this._state(`pack${i}_soc`, "sensor");
        if (soc) seen = i;
      }
      return seen;
    }

    /** Every pack this unit has, as the default selection. */
    _allPacks() {
      const out = [];
      for (let i = 1; i <= this._packCount(); i += 1) out.push(i);
      return out;
    }

    /**
     * The packs the device says it is heating (§32 ``heat.pack_ids``).
     *
     * ``null`` means "the device has not told us", which is different from an
     * empty list: §40 defines an empty list as "every pack". The list arrives as
     * an attribute of the heater entity because Home Assistant has no
     * multi-value entity - see `HoymilesNumber.extra_state_attributes`.
     */
    _heatPackIds() {
      const ids = this._attr("heat_param", "number", "pack_ids");
      if (!Array.isArray(ids)) return null;
      return ids
        .map((pack) => Math.round(Number(pack)))
        .filter((pack) => pack >= 1 && pack <= HEAT_PACK_MAX);
    }

    /**
     * The effective target packs.
     *
     * An empty draft means "all packs", which is exactly what §40 says an empty
     * or omitted ``pack_ids`` means - so the card never has to guess, and the
     * chips open fully selected on a unit that has not reported its list yet.
     */
    _heatPackSel() {
      const count = this._packCount();
      const picked = this._heatPacks.filter((n) => n >= 1 && n <= count);
      return picked.length ? picked : this._allPacks();
    }

    /** Flip one pack in the heater's target selection. */
    _toggleHeatPack(pack) {
      const sel = this._heatPackSel();
      const next = sel.includes(pack)
        ? sel.filter((n) => n !== pack)
        : [...sel, pack].sort((a, b) => a - b);
      /* Zero would mean "all packs" on the wire, the opposite of what a user who
         just unchecked everything intends. Refuse the last one instead. */
      if (!next.length) {
        this._showToast(this._t(
          "Keep at least one pack selected", "至少保留一个电池包",
        ));
        return;
      }
      this._heatPacks = next;
      this.requestUpdate();
    }

    /**
     * §39 ``controls.pack_ids``: which packs the heater acts on.
     *
     * `type: custom, multiple: true` in the meta payload, so this is a set, not
     * a choice - one chip per pack the unit actually has, and any number of them
     * can be on.  It carries **no Send of its own**: the row is a draft like the
     * slider below it, and the card's single Send publishes both (see
     * `_heatPayload`).
     */
    _heatPackRow() {
      const count = this._packCount();
      const packs = this._heatPackSel();
      const chips = [];
      for (let i = 1; i <= count; i += 1) {
        const on = packs.includes(i);
        chips.push(html`
          <button class=${on ? "on" : ""} aria-pressed=${on ? "true" : "false"}
            title=${this._t(`Pack ${i}`, `${i} 号电池包`)}
            @click=${() => this._toggleHeatPack(i)}>${i}</button>`);
      }
      const hint = packs.length === count
        ? this._t("all packs", "全部电池包")
        : this._t(`${packs.length} of ${count}`, `${count} 个中的 ${packs.length} 个`);
      return this._row({
        icon: this._icon("heatPacks"),
        label: this._t("Target packs", "目标电池包"),
        hint,
        topic: this._topic("<dev_id>/heat/set"),
        ctrl: html`<div class="seg fluid heat-packs">${chips}</div>`,
      });
    }

    /**
     * §40: the whole heater state, as shown on the card.
     *
     * One message rather than one per field.  §40 allows a partial write, but a
     * partial write only stays honest while the card shows the fields it leaves
     * out - and this card shows all three (mode, setpoint, target packs).  Since
     * they travel together, the device always ends up in exactly the state on
     * screen instead of in a mix of "what was just clicked" and "whatever it
     * held before".
     *
     * ``disable`` carries nothing else: the firmware ignores both fields in that
     * mode, so sending them would only blur what the button did.
     */
    _heatPayload(mode) {
      const payload = { mode };
      if (mode === HEAT_MODE_OFF) return payload;
      const { lo, hi } = this._heatRange(mode);
      /* An empty draft has never been seeded (fresh unit): it clamps to the low
         end of the band, which is the gentlest setting the card offers. */
      const draft = this._heatPower === "" ? lo : this._heatPower;
      payload.param = Math.round(this._clamp(draft, lo, hi));
      /* `_heatPackSel()` already reads an empty draft as "every pack", and an
         empty list on the wire means the same thing - so a unit whose pack count
         is still unknown simply omits the field instead of claiming one pack. */
      const packs = this._heatPackSel();
      if (packs.length) payload.pack_ids = packs;
      return payload;
    }

    /** One line describing a payload, for the dialog and its steps. */
    _heatSummary(payload) {
      const entry = HEAT_MODES.find((mode) => mode.id === payload.mode);
      const label = entry ? this._t(entry.label, entry.zh) : payload.mode;
      if (payload.mode === HEAT_MODE_OFF) return label;
      const unit = payload.mode === "temp" ? "°C" : "W";
      const packs = payload.pack_ids && payload.pack_ids.length
        ? payload.pack_ids.join(", ")
        : this._t("all packs", "全部电池包");
      return `${label} · ${payload.param} ${unit} · ${this._t("packs", "电池包")} ${packs}`;
    }

    /**
     * Publish a heater state through the dialog.
     *
     * Used by both the mode picker and the Send button so they can never drift
     * apart: the picker sends "this mode with what the card shows", and the
     * button sends "the current mode with what the card shows".
     */
    _commitHeat(mode, titleEn, titleZh) {
      const payload = this._heatPayload(mode);
      const summary = this._heatSummary(payload);
      this._runAction({
        title: this._t(titleEn, titleZh),
        steps: [this._t(`${summary} sent.`, `${summary} 已下发。`)],
        run: async () => {
          this._busySet(0, "active");
          await this._publishRaw(this._topic("<dev_id>/heat/set"), payload);
          this._busySet(0, "done");
          this._busyDone(this._t(`${summary} sent.`, `${summary} 已下发。`));
          /* The heater is the one control whose *effect* cannot be confirmed
             quickly: `heat/set` is applied at once, but the state the device
             reports back (`heat`, `packs[].heat`) only travels in its 5-minute
             report.  That note belongs in a banner of its own - as a second
             dialog step it disappeared together with the dialog, i.e. exactly
             when the user started wondering why nothing changed. */
          this._showBanner(this._t(
            "The packs' heating state is only updated by the next 5-minute device "
            + "report, so the PACK display can lag by up to 5 minutes.",
            "电池包的加热状态要等设备下一次 5 分钟实时数据才会更新，"
            + "所以 PACK 上的显示最多会晚 5 分钟。",
          ));
        },
      });
    }

    /** §40: the card's single Send - mode, setpoint and target packs together. */
    _sendHeat() {
      this._commitHeat(this._heatModeShown(), "Heating", "加热");
    }

    /**
     * §42: the PV ceiling lives in the fine control object, not on its own topic.
     *
     * Shown in the `fine_ctrl` block of the EMS card rather than in the power
     * controls card: §42 requires `ems_mode=fine_ctrl` before the device accepts
     * this field at all, so putting it next to the other fine control numbers
     * (and next to the mode that makes it work) is what keeps the row from
     * looking like a limit that applies all the time. Range [0, 2500], 0 stops
     * PV output (§41) - unlike `input_power`, 0 IS allowed here.
     */
    _pvRow() {
      const { lo, hi } = this._bounds("pv_power_limit", PV_POWER.lo, PV_POWER.hi);
      return this._row({
        icon: this._icon("sun"),
        label: this._t("PV limit", "PV 限值"),
        hint: this._t(`${lo} ~ ${hi} W · 0 = off`, `${lo} ~ ${hi} W · 0 = 禁止`),
        topic: this._topic("<dev_id>/fine_ctrl/set"),
        ctrl: this._slider({
          value: this._pvPower,
          min: lo,
          max: hi,
          step: 1,
          unit: "W",
          sendLabel: this._t("Send", "下发"),
          onInput: (v) => { this._pvPower = v; },
          onSend: () => this._sendFine("pv_power", "_pvPower", PV_POWER,
            this._t("PV power limit", "PV 功率限值")),
        }),
      });
    }

    /**
     * §42: the grid setpoint of the fine control block.
     *
     * Sign convention is the protocol's, not the meter's: positive exports to
     * the grid, negative imports. The hint says so because the slider looks like
     * a plain 0 ~ N W control otherwise.
     */
    _fineGridRow() {
      const { lo, hi } = this._bounds("fine_grid_power",
        GRID_POWER.lo, GRID_POWER.hi);
      const sign = this._t("+ export, − import", "+ 馈网，− 取电");
      return this._row({
        icon: this._icon("powerPlug"),
        label: this._t("Grid setpoint", "并网功率"),
        hint: this._t(`${lo} ~ ${hi} W · ${sign}`, `${lo} ~ ${hi} W · ${sign}`),
        topic: this._topic("<dev_id>/fine_ctrl/set"),
        ctrl: this._slider({
          value: this._gridP,
          min: lo,
          max: hi,
          step: 0.1,
          unit: "W",
          sendLabel: this._t("Send", "下发"),
          onInput: (v) => { this._gridP = v; },
          onSend: () => this._sendFine("grid_p", "_gridP", GRID_POWER,
            this._t("Grid setpoint", "并网功率")),
        }),
      });
    }

    /**
     * The lease strip of the fine control block.
     *
     * One strip for five rows because §42 sends ONE object: the grid setpoint,
     * the PV ceiling, the two forbid flags and the relay are all refreshed
     * together, so a switch per row would be five switches for one timer.
     */
    _fineLeaseRow() {
      const ready = this._emsMode() === "fine_ctrl";
      return this._row({
        bare: true,
        sub: this._leaseClause("fine_ctrl", "", ready),
        subClass: this._leaseRunning("fine_ctrl") ? "live" : "",
        topic: this._topic("<dev_id>/fine_ctrl/set"),
        ctrl: this._leaseStrip("fine_ctrl", ready),
      });
    }

    /**
     * §41 / §42: the three on/off fields of the fine control object, on one line.
     *
     * Charge forbidden, discharge forbidden and the off-grid relay are three
     * independent fields of ONE object, and the three things a user flips while
     * watching the power flow - so they share a row at the top of the block
     * instead of owning three rows and pushing both sliders out of sight. Each
     * tile writes only its own field; the shared lease re-publishes the object.
     *
     * Only the 4020 X implements the two forbid flags, so every other model gets
     * the relay tile alone - and the row's column count follows the number of
     * tiles instead of keeping three tracks with two of them empty.
     */
    _fineSwitchRow() {
      const extras = this._allowFineExtras();
      const tiles = [];
      if (extras && this._has("charge_forbid", "switch")) {
        tiles.push(this._fineSwitchTile({
          icon: "noCharge",
          en: "Charge Forbidden",
          zh: "禁止充电",
          key: "charge_forbid",
          subEn: "on = charging refused",
          subZh: "开启 = 禁止充电",
          write: (on) => this._writeFine("chg_off", on, "Charge Forbidden", "禁止充电"),
        }));
      }
      if (extras && this._has("discharge_forbid", "switch")) {
        tiles.push(this._fineSwitchTile({
          icon: "noDischarge",
          en: "Discharge Forbidden",
          zh: "禁止放电",
          key: "discharge_forbid",
          subEn: "on = discharging refused",
          subZh: "开启 = 禁止放电",
          write: (on) => this._writeFine("dchg_off", on, "Discharge Forbidden", "禁止放电"),
        }));
      }
      if (this._has("eps_relay", "switch")) {
        tiles.push(this._fineSwitchTile({
          icon: "socket",
          en: "Off-grid relay",
          zh: "离网继电器",
          key: "eps_relay",
          subEn: "on = relay closed, port live",
          subZh: "开启 = 端口有输出",
          /* Opening it costs a lock-out, so that direction is questioned; closing
             it is the way back and stays one click. */
          guard: () => this._confirmRelayOpen(),
          /* §41 wants the strings `close` / `open`, not a boolean. */
          write: (on) => this._writeFine(
            "eps_relay", on ? "close" : "open", "Off-grid relay", "离网继电器",
            on ? "" : this._t(
              "The relay is now locked - it will accept close again in about "
              + "10 minutes at the earliest.",
              "继电器已锁定，最早约 10 分钟后才会接受重新吸合。",
            ),
          ),
        }));
      }
      if (!tiles.length) return html``;
      return this._row({
        bare: true,
        topic: this._topic("<dev_id>/fine_ctrl/set"),
        /* A plain style string, not a lit style map: this lit build stringifies
           an object attribute into "[object Object]", which silently left the
           variable unset and kept three columns with two of them empty. */
        ctrl: html`<div class="fs-row" style="--fs-n:${tiles.length}"
          >${tiles}</div>`,
      });
    }

    /** One tile of the §42 switch row: icon, name, rule and the switch. */
    _fineSwitchTile({ icon, en, zh, key, subEn, subZh, write, guard }) {
      const state = this._state(key, "switch");
      const on = !!state && String(state.state) === "on";
      return html`
        <div class="fst">
          <span class="fic">${this._icon(icon, 20)}</span>
          <span class="ft">${this._t(en, zh)}</span>
          <span class="fss">${this._t(subEn, subZh)}</span>
          <ha-switch .checked=${on}
            @change=${async (event) => {
              /* The switch on screen already moved by the time this runs, so a
                 declined question has to put the knob back by hand - otherwise
                 the tile would claim a state the device never got. */
              const knob = event.currentTarget;
              const next = knob.checked === true;
              if (guard && !next && on) {
                const ok = await guard();
                if (!ok) {
                  knob.checked = on;
                  return;
                }
              }
              write(next);
            }}></ha-switch>
        </div>`;
    }

    /**
     * Ask before opening the off-grid relay (§42).
     *
     * The firmware locks the relay after it opens: it refuses `close` for a
     * while, and every further open during the day adds another step to that
     * wait. Nothing in `fine_ctrl` reports the lock or how long is left (the
     * group describes `eps_relay` and nothing else), so the card cannot count
     * down - it can only warn, which is exactly what the question is for.
     * Worded as a rule rather than a number: a guessed "20 min" would be wrong
     * the moment somebody opens the relay from the app instead.
     */
    async _confirmRelayOpen() {
      const ok = await this._askConfirm({
        title: this._t(
          "Open the off-grid relay?", "断开离网继电器？",
        ),
        message: this._t(
          "Once opened, the relay stays locked for a while before it accepts "
          + "`close` again: about 10 minutes the first time, and 10 minutes "
          + "longer each further time (20, 30…). The off-grid port has no "
          + "output during that wait.",
          "断开后，继电器会锁定一段时间才接受重新吸合：第一次约 10 分钟，"
          + "之后每再断开一次就再加 10 分钟（20 分钟、30 分钟…）。"
          + "锁定期间离网端口没有输出。",
        ),
        confirmText: this._t("Got it", "知道了"),
        cancelText: this._t("Cancel", "取消"),
      });
      if (!ok) {
        this._showToast(this._t(
          "Cancelled - the relay stays closed.",
          "已取消，继电器保持吸合。",
        ));
      }
      return ok;
    }

    /** §11 / §12: the virtual meter power setpoint (object payload, one field). */
    _meterRow() {
      const { lo, hi } = this._meterBounds();
      const ready = this._emsMode() === "meter_ctrl";
      const sign = this._t("+ import, − export", "+ 取电，− 馈网");
      return this._row({
        icon: this._icon("meterDial"),
        label: this._t("Meter setpoint", "虚拟电表功率"),
        sub: this._leaseClause(
          "meter_ctrl",
          this._t(`${lo} ~ ${hi} W · ${sign}`, `${lo} ~ ${hi} W · ${sign}`),
          ready,
        ),
        subClass: this._leaseRunning("meter_ctrl") ? "live" : "",
        topic: this._topic("number/<dev_id>/meter_ctrl/set"),
        ctrl: html`
          ${this._slider({
            value: this._meterP,
            min: lo,
            max: hi,
            step: 0.1,
            unit: "W",
            disabled: !ready,
            sendLabel: this._t("Send", "下发"),
            onInput: (v) => { this._meterP = v; },
            onSend: () => this._sendMeter(),
          })}
          ${this._leaseStrip("meter_ctrl", ready)}`,
      });
    }

    /**
     * §11 / §12: live proof that something outside is driving the meter.
     *
     * Hidden until the first write is counted: a user who never wires up an
     * external meter should not see a permanent "0 / waiting" strip in a block
     * they are driving by hand.  Once one arrives it stays visible and shows how
     * many writes were accepted since the unit entered `meter_ctrl`, the newest
     * object, and that it reached the device.
     *
     * The integration's own repeat re-publishes the last object on a timer; those
     * repeats are not counted, so a still counter means "nothing new arrived",
     * not "the card stopped redrawing".
     */
    _meterRxRow() {
      const info = this._vmInfo;
      const rx = (info && info.rx) || null;
      const raw = rx ? Number(rx.count) : 0;
      const count = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
      if (!count) return html``;
      const fields = rx.fields || {};
      const bits = [];
      if (fields.power != null) bits.push(`${fields.power} W`);
      if (fields.eng_out != null) {
        bits.push(`${this._t("feed-in", "馈网")} ${fields.eng_out} Wh`);
      }
      if (fields.eng_in != null) {
        bits.push(`${this._t("import", "用电")} ${fields.eng_in} Wh`);
      }
      return html`
        <div class="meter-rx live">
          <span class="rx-count">${this._t("External pushes", "外部推送")} ${count}</span>
          <span class="rx-latest">${bits.join(" · ")}</span>
          <span class="rx-state">${this._t("pushed", "已推送")} · ${this._ago(rx.at)}</span>
        </div>`;
    }

    /** "12 s ago" / "刚刚", from the ISO stamp the backend produced. */
    _ago(iso) {
      const ms = Date.parse(iso || "");
      if (!Number.isFinite(ms)) return this._t("just now", "刚刚");
      const secs = Math.max(0, Math.round((this._now() - ms) / 1000));
      if (secs < 2) return this._t("just now", "刚刚");
      if (secs < 60) return this._t(`${secs} s ago`, `${secs} 秒前`);
      const mins = Math.round(secs / 60);
      if (mins < 60) return this._t(`${mins} min ago`, `${mins} 分钟前`);
      return new Date(ms).toLocaleTimeString();
    }

    /**
     * §11 / §12: the two cumulative readings, on ONE line at the top.
     *
     * Both are numbers of the same object and are set together in practice, so
     * they share a row: two full "label + input" rows pushed the HTTP recipe off
     * the bottom of the card for nothing.  A handle over 0 .. 4 294 967 295 Wh
     * would be unusable, so each cell is a number box with its own Send.
     */
    _meterEnergyRow() {
      const ready = this._emsMode() === "meter_ctrl";
      return this._row({
        bare: true,
        sub: this._t(
          `${METER_ENERGY.lo} ~ ${METER_ENERGY.hi} Wh · cumulative readings, not increments`,
          `${METER_ENERGY.lo} ~ ${METER_ENERGY.hi} Wh · 累计读数，不是增量`,
        ),
        topic: this._topic("number/<dev_id>/meter_ctrl/set"),
        ctrl: html`
          <div class="me-row">
            ${this._meterEnergyCell("eng_out", "_meterOut", "Meter feed-in energy",
              "累计馈网电量", "meterGen", ready)}
            ${this._meterEnergyCell("eng_in", "_meterIn", "Meter input energy",
              "累计用电量", "meterUse", ready)}
          </div>`,
      });
    }

    /** One cell of the readings row: the name above, the reading and Send below. */
    _meterEnergyCell(field, draftKey, en, zh, icon, ready) {
      const draft = this[draftKey];
      return html`
        <div class="me-cell">
          <div class="me-head">
            <span class="fic">${this._icon(icon, 20)}</span>
            <span class="ft">${this._t(en, zh)}</span>
          </div>
          <div class="energy-set">
            <input type="number" min=${METER_ENERGY.lo} max=${METER_ENERGY.hi}
              step="1" placeholder="0" .value=${draft == null ? "" : String(draft)}
              ?disabled=${!ready}
              @change=${(e) => { this[draftKey] = e.target.value; }} />
            <span class="unit">Wh</span>
            <button class="btn primary" ?disabled=${!ready}
              @click=${() => this._sendMeterEnergy(field, draftKey, en, zh)}>
              ${this._t("Send", "下发")}
            </button>
          </div>
        </div>`;
    }

    /**
     * Write one of the two readings.
     *
     * The object is shared with the power row, so this sends the single field it
     * owns (§12 allows a partial write and the device keeps the rest).  When the
     * lease is running the send goes through the integration instead, so the
     * repeated object carries the new reading rather than the old one.
     */
    _sendMeterEnergy(field, draftKey, en, zh) {
      const raw = Number(this[draftKey]);
      if (!Number.isFinite(raw)) {
        this._showToast(
          this._t("Enter a reading in Wh first.", "请先填入 Wh 读数。"), true,
        );
        return;
      }
      const value = Math.round(this._clamp(raw, METER_ENERGY.lo, METER_ENERGY.hi));
      const every = this._leaseInterval("meter_ctrl");
      const repeat = this._leaseOnFlag("meter_ctrl");
      this._runAction({
        title: this._t(en, zh),
        steps: [this._t(`Send ${value} Wh`, `下发 ${value} Wh`)],
        run: async () => {
          this._busySet(0, "active");
          if (repeat) {
            await this._callService("set_meter_ctrl", {
              [field]: value, interval: every,
            });
          } else {
            await this._publishRaw(
              this._topic("number/<dev_id>/meter_ctrl/set"),
              JSON.stringify({ [field]: value }),
            );
          }
          this._busySet(0, "done");
          await this._syncLease("meter_ctrl");
          this._busyDone(this._t(
            `${value} Wh sent as the meter reading.`,
            `已下发虚拟电表读数 ${value} Wh。`,
          ));
        },
      });
    }

    /** The band the device actually offers, intersected with §11's. */
    _meterBounds() {
      return this._bounds("meter_power", METER_CTRL.lo, METER_CTRL.hi);
    }

    /**
     * The external meter recipe: URL, secret, range and a copy-ready curl line.
     *
     * Read over WebSocket rather than from an entity: the secret is a credential,
     * and an entity state would put it into the recorder and into every export of
     * the database. The command is authenticated, so only a logged-in user sees
     * it - which is the correct audience for "here is the key".
     */
    _meterHttpBlock() {
      const info = this._vmInfo;
      if (!info) {
        return html`<div class="note">${this._t(
          "Reading the external meter endpoint...",
          "正在读取外网电表接口…",
        )}</div>`;
      }
      const range = this._t(
        `power ${info.range.power.min} ~ ${info.range.power.max} W, `
          + `energy ${info.range.eng_out.min} ~ ${info.range.eng_out.max} Wh`,
        `功率 ${info.range.power.min} ~ ${info.range.power.max} W，`
          + `累计电量（eng_out / eng_in）${info.range.eng_in.min} ~ ${info.range.eng_in.max} Wh`,
      );
      return html`
        <details class="vm-api">
          <summary>
            ${this._t("External meter (HTTP)", "外网电表（HTTP）")}
            <span class="vm-hint">${this._t(
              "tap to see how to connect", "点开看怎么接",
            )}</span>
          </summary>
          <div class="vm-body">
            <div class="vm-sub">${this._t(
              "An energy manager POSTs a JSON object to this URL: "
              + '{"power": w, "eng_out": wh, "eng_in": wh}. Any subset is '
              + "allowed - a field that is not sent keeps the value the device "
              + "already holds. power is the setpoint (positive imports, "
              + "negative exports); eng_out / eng_in are the cumulative readings "
              + "the simulated meter reports. Every accepted update is sent to "
              + "the device at once and then re-sent, so the meter does not have "
              + "to keep up with the one-minute lease.",
              "能源管理器向此地址 POST 一个 JSON 对象："
              + '{"power": w, "eng_out": wh, "eng_in": wh}。可以只发其中一部分字段，'
              + "没发的字段设备保持原值。power 是功率设定（正数取电、负数馈网）；"
              + "eng_out / eng_in 是虚拟电表上报的累计读数。每次通过校验的更新都会立即"
              + "下发给设备并持续重发，因此外部电表不必自己顶着 1 分钟的租约。",
            )}</div>
            <div class="vm-sub">${this._t(
              "Send the key in an X-Hoymiles-Key header (or as ?key=). Tap the "
              + "key or the curl line to select all of it.",
              "密钥放在 X-Hoymiles-Key 请求头里（也可以写成 ?key=）。"
              + "点一下密钥或命令行会全选，方便手动复制。",
            )}</div>
            <code class="vm-url">POST ${info.url}</code>
            <div class="vm-row">
              <code class="vm-key" title=${this._t("Click to select all", "点击全选")}
                @click=${this._selectAll}>${info.header}: ${info.key}</code>
              <button class="btn small"
                @click=${() => this._copyKey()}>${this._t("Copy key", "复制密钥")}</button>
              <button class="btn small danger"
                @click=${() => this._rotateVm()}>${this._t("New key", "换新密钥")}</button>
            </div>
            <div class="vm-range">${range}</div>
            <div class="vm-row">
              <span class="vm-sub" style="margin:0">${this._t("curl", "命令行示例")}</span>
              <button class="btn small"
                @click=${() => this._copyCurl()}>${this._t("Copy curl", "复制 curl")}</button>
            </div>
            <pre @click=${this._selectAll}>${info.example_curl}</pre>
          </div>
        </details>`;
    }

    /**
     * Ask for the endpoint details while in the mode, re-reading on a timer.
     *
     * The same answer carries the write counter and the newest object, which is
     * what the strip under the setpoint shows - so this is a poll, not a
     * one-shot. ``VM_POLL_MS`` keeps it at two seconds; renders happen on every
     * device message anyway, so this never runs faster than that.
     */
    _watchVmInfo() {
      if (this._emsMode() !== "meter_ctrl") return;
      if (this._vmLoading) return;
      if (this._vmAt && this._now() - this._vmAt < VM_POLL_MS) return;
      this._loadVmInfo();
    }

    async _loadVmInfo() {
      if (!this._hass || typeof this._hass.callWS !== "function") return;
      this._vmLoading = true;
      this._vmAt = this._now();
      try {
        const out = await this._hass.callWS({
          type: "hoymiles/virtual_meter/info",
          dev_id: this._dev(),
        });
        if (this.isConnected) this._vmInfo = out;
      } catch (err) {
        if (this.isConnected) this._vmInfo = null;
      }
      this._vmLoading = false;
      if (this.isConnected) this.requestUpdate();
    }

    /**
     * Copy text, falling back to the old `execCommand` path.
     *
     * `navigator.clipboard` **does not exist** unless the page is a secure
     * context, and this integration is normally opened over plain HTTP on the
     * LAN (`http://192.168.31.99:8123`), so the modern API throws instead of
     * copying.  The hidden-textarea fallback is therefore the path that
     * actually runs; it is deprecated but every current browser still supports
     * it outside a secure context.
     *
     * Returns whether anything was actually copied, so the caller can show the
     * value instead of lying with a "copied" toast.
     */
    async _copyText(text, okMessage) {
      if (!text) return false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          this._showToast(okMessage);
          return true;
        } catch (err) {
          /* Denied permission (or no user gesture): fall through. */
        }
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, text.length);
        const done = document.execCommand("copy");
        document.body.removeChild(area);
        if (done) {
          this._showToast(okMessage);
          return true;
        }
      } catch (err) {
        /* Nothing else to try. */
      }
      return false;
    }

    /** Select the whole text of the element that was clicked. */
    _selectAll(event) {
      const node = event && event.currentTarget;
      if (!node) return;
      try {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (err) {
        /* Selection is a convenience; never break the card over it. */
      }
    }

    async _copyKey() {
      const info = this._vmInfo;
      if (!info) return;
      const done = await this._copyText(
        info.key,
        this._t("Key copied.", "已复制密钥。"),
      );
      /* No clipboard at all: show the key on its own so it can be typed or
         selected by hand, instead of a toast that claims it worked. */
      if (!done) this._showToast(info.key, true);
    }

    async _copyCurl() {
      const info = this._vmInfo;
      if (!info) return;
      const done = await this._copyText(
        info.example_curl,
        this._t("curl command copied.", "已复制 curl 命令。"),
      );
      if (!done) this._showToast(info.example_curl, true);
    }

    async _rotateVm() {
      if (!this._hass || typeof this._hass.callWS !== "function") return;
      const ok = await this._askConfirm({
        title: this._t("Issue a new key?", "更换新的密钥？"),
        message: this._t(
          "The current key stops working immediately, so whatever is posting to "
          + "this URL has to be updated with the new one.",
          "当前密钥会立即失效，正在向该地址发送数据的设备需要改成新密钥。",
        ),
        confirmText: this._t("Replace it", "更换"),
        cancelText: this._t("Keep the old one", "保留原密钥"),
      });
      if (!ok) return;
      try {
        const out = await this._hass.callWS({
          type: "hoymiles/virtual_meter/rotate",
          dev_id: this._dev(),
        });
        if (this.isConnected) this._vmInfo = out;
        this._showToast(this._t("New key issued.", "已生成新密钥。"));
      } catch (err) {
        this._showToast(String(err && err.message ? err.message : err), true);
      }
      if (this.isConnected) this.requestUpdate();
    }

    _sendMeter() {
      const { lo, hi } = this._meterBounds();
      /* §12 carries ``power`` in watts with a 0.1 W resolution; the two energy
         readings in the same object are whole Wh, and each row rounds its own. */
      const value = Math.round(this._clamp(this._meterP, lo, hi) * 10) / 10;
      const every = this._leaseInterval("meter_ctrl");
      const repeat = this._leaseOnFlag("meter_ctrl");
      this._runAction({
        title: this._t("Meter setpoint", "虚拟电表"),
        steps: [this._t(`Send ${value} W`, `下发 ${value} W`)],
        run: async () => {
          this._busySet(0, "active");
          if (repeat) {
            /* The integration publishes it and keeps publishing it - the same
               path `power_ctrl` takes, for the same reason: a timer in the card
               dies with the card. */
            await this._callService("set_meter_ctrl", { value, interval: every });
          } else {
            await this._publishRaw(
              this._topic("number/<dev_id>/meter_ctrl/set"),
              JSON.stringify({ power: value }),
            );
          }
          this._busySet(0, "done");
          await this._syncLease("meter_ctrl");
          this._busyDone(repeat
            ? this._t(
              `Meter setpoint ${value} W sent. Home Assistant re-sends it every `
              + `${every} s, even after you leave this page.`,
              `虚拟电表 ${value} W 已下发。Home Assistant 会每 ${every} s 重发一次，`
              + "离开本页也照常进行。",
            )
            : this._t(
              `Meter setpoint ${value} W sent. The timer is off, so it will not `
              + "be repeated - the device drops it after about a minute.",
              `虚拟电表 ${value} W 已下发。定时已关闭，不会重发——约一分钟后设备会丢弃该值。`,
            ));
        },
      });
    }

    /**
     * §42: publish one field of the fine control object.
     *
     * ``field`` is the wire key, ``draft`` the instance field holding the value.
     * Sending only the field the row owns is what the document allows and what
     * keeps two rows from overwriting each other - and the service merges it
     * into the object it re-publishes, so the other fields survive either way.
     */
    _sendFine(field, draft, range, label) {
      const raw = this[draft];
      const value = this._clamp(raw, range.lo, range.hi);
      /* `pv_power` is whole watts on the wire (it is a limit, not a setpoint). */
      const wire = field === "pv_power" ? Math.round(value)
        : Math.round(value * 10) / 10;
      this._sendFineField(field, wire, label);
    }

    /**
     * The one path every fine control field takes.
     *
     * With the timer on it goes through `hoymiles.set_fine_ctrl` so Home
     * Assistant owns the repeat; with it off it publishes straight to the
     * broker, exactly what the card used to do. Both branches are needed: a user
     * who switched the timer off is explicitly asking for a one-shot write.
     */
    _sendFineField(field, wire, label, opts) {
      const every = this._leaseInterval("fine_ctrl");
      const repeat = this._leaseOnFlag("fine_ctrl");
      const show = typeof wire === "number" ? `${wire} W` : String(wire);
      const run = async () => {
        if (repeat) {
          await this._callService("set_fine_ctrl", { [field]: wire, interval: every });
        } else {
          await this._publishRaw(
            this._topic("<dev_id>/fine_ctrl/set"), { [field]: wire },
          );
        }
        await this._syncLease("fine_ctrl");
      };

      if (opts && opts.silent) return run();

      this._runAction({
        title: label,
        steps: [this._t(`Send ${show}`, `下发 ${show}`)],
        run: async () => {
          this._busySet(0, "active");
          await run();
          this._busySet(0, "done");
          this._busyDone(repeat
            ? this._t(
              `${label}: ${show} sent. Home Assistant re-sends the whole fine `
              + `control block every ${every} s.`,
              `${label}：${show} 已下发。Home Assistant 会每 ${every} s 重发整个`
              + "精细控制对象。",
            )
            : this._t(
              `${label}: ${show} sent. The timer is off, so it will not be `
              + "repeated.",
              `${label}：${show} 已下发。定时已关闭，不会重发。`,
            ));
        },
      });
    }

    /** §42: write one boolean / relay field without a Send button.
     *
     * Goes through the same dialog as the sliders: these three are the fields a
     * user flips while the machine is running, so the outcome has to be visible
     * where the click was made, not in a toast that disappears before the
     * device has even acknowledged the command.
     */
    _writeFine(field, value, en, zh, note) {
      const label = this._t(en, zh);
      const on = value === true || value === "close";
      const show = this._t(on ? "on" : "off", on ? "开启" : "关闭");
      this._runAction({
        title: label,
        steps: [this._t(`Send ${show}`, `下发：${show}`)],
        run: async () => {
          this._busySet(0, "active");
          /* Through the service even here: the repeat re-publishes the object
             it holds, so a value written straight to the broker would be undone
             by the next tick - the forbid flag would silently switch itself off. */
          await this._sendFineField(field, value, label, { silent: true });
          this._busySet(0, "done");
          this._busyDone(
            this._t(
              `${label}: ${show} sent. The switch follows what the device reports.`,
              `${label}：已下发 ${show}。开关状态以设备回报为准。`,
            ) + (note ? " " + note : ""),
          );
        },
      });
    }

    _inputRow() {
      const { lo, hi } = this._bounds("input_power", INPUT_POWER.lo, INPUT_POWER.hi);
      return this._row({
        icon: this._icon("plug"),
        label: this._t("Input power limit", "输入功率上限"),
        /* §44: [100, 2500] with no 0 - there is no "0 = off" here. */
        hint: `${lo} ~ ${hi} W`,
        topic: this._topic("number/<dev_id>/input_power/set"),
        ctrl: this._slider({
          value: this._inputPower,
          min: lo,
          max: hi,
          step: 1,
          unit: "W",
          sendLabel: this._t("Send", "下发"),
          onInput: (v) => { this._inputPower = v; },
          onSend: () => this._sendScalar({
            field: "_inputPower",
            topic: "number/<dev_id>/input_power/set",
            lo,
            hi,
            unit: "W",
            label: this._t("Input power limit", "输入功率上限"),
            clampTo: true,
          }),
        }),
      });
    }

    /**
     * §34: the two cut-offs, on ONE track.
     *
     * `soc_l` (where discharging stops) owns the left handle and `soc_h` (where
     * charging stops) the right one, on a single 10..100 % rail. Reading the card
     * tells the user what the battery will actually do: the painted stretch
     * between the handles is the band it cycles through.
     *
     * Because the handles live on one scale, "charge stops above discharge" needs
     * no enforcement - and the extra `SOC_MIN_GAP` is kept by stopping each
     * handle at ten points from the other rather than by moving it aside.
     */
    _socRow() {
      const pair = this._socPair();
      const span = pair.tHi - pair.tLo;
      const frac = (v) => (span > 0 ? Math.min(Math.max((v - pair.tLo) / span, 0), 1) : 0);
      const iconOut = this._icon("batteryOut", 20);
      const iconIn = this._icon("batteryIn", 20);

      /* Repainting by hand, for the same reason the single slider does it: the
         drafts are plain instance fields, so nothing re-renders while a handle
         moves and the band would lag a state update behind the finger.
         The numbers are written INTO lit's text node (node.data), never through
         `textContent` - replacing the children would delete the marker lit keeps
         for that expression and the next render would throw, aborting the whole
         update. See the note in `_slider`. */
      const setText = (host, value) => {
        if (!host) return false;
        const node = host.lastChild;
        if (node && node.nodeType === Node.TEXT_NODE) { node.data = String(value); return true; }
        return false;
      };
      const paint = (track, l, h) => {
        track.style.setProperty("--lo", frac(l).toFixed(4));
        track.style.setProperty("--hi", frac(h).toFixed(4));
        const root = track.parentElement;
        const nl = root && root.querySelector(".duo-col.lo .duo-num .n");
        const nh = root && root.querySelector(".duo-col.hi .duo-num .n");
        const okL = setText(nl, Math.round(l));
        const okH = setText(nh, Math.round(h));
        /* No text node (a blank card that was never rendered with a value):
           let lit draw them rather than fabricate the markup. */
        if (nl && !okL) this.requestUpdate();
        if (nh && !okH) this.requestUpdate();
      };
      /* `input` repaints, `change` publishes. A range input fires `input` for
         every pixel of a drag and `change` once, when the finger or key is
         released - which is exactly the split wanted here: the band and the
         numbers follow the handle live, and the broker sees one message per
         gesture instead of forty. Keyboard use fires `change` on key release
         too, so the rule holds without a special case. */
      const release = () => {
        /* The finger is off the handle: the drafts may follow the device again,
           and `_socCommit` publishes the pair the user settled on. */
        this._socDirty = false;
        this._socCommit();
      };
      const move = (which) => (e) => {
        const el = e.target;
        const track = el.parentElement;
        const p = this._socPair();
        const want = Math.round(Number(el.value));
        if (!Number.isFinite(want)) return;
        /* Hold the pair: a state update landing mid-drag must not move the
           handle away from the finger. */
        this._socDirty = true;
        let l = p.l;
        let h = p.h;
        if (which === "lo") {
          /* Stop ten points short of the charge handle, never push it. */
          const top = Math.max(p.lLo, Math.min(p.lHi, h - SOC_MIN_GAP));
          l = Math.min(Math.max(want, p.lLo), top);
        } else {
          const bottom = Math.min(p.hHi, Math.max(p.hLo, l + SOC_MIN_GAP));
          h = Math.min(Math.max(want, bottom), p.hHi);
        }
        this._socL = String(l);
        this._socH = String(h);
        /* The input keeps whatever the browser put there, so a clamped drag has
           to be written back or the handle would sit at a value the card does
           not use. */
        if (el.value !== String(l) && el.value !== String(h)) el.value = String(which === "lo" ? l : h);
        paint(track, l, h);
      };

      const track = html`
        <div class="duo-track" style="--lo:${frac(pair.l).toFixed(4)};--hi:${frac(pair.h).toFixed(4)}"
          title=${this._t(
            `The charge cut-off stays at least ${SOC_MIN_GAP} % above the discharge cut-off.`,
            `充电截止比放电截止至少高 ${SOC_MIN_GAP} %。`)}>
          <span class="duo-rail"></span>
          <span class="duo-band"></span>
          <input type="range" class="lo" aria-label=${this._t("Discharge cut-off", "放电截止电量")}
            min=${pair.tLo} max=${pair.tHi} step="1" .value=${String(pair.l)}
            @input=${move("lo")} @change=${release} />
          <input type="range" class="hi" aria-label=${this._t("Charge cut-off", "充电截止电量")}
            min=${pair.tLo} max=${pair.tHi} step="1" .value=${String(pair.h)}
            @input=${move("hi")} @change=${release} />
        </div>`;

      return this._row({
        bare: true,
        topic: this._topic("number/<dev_id>/soc_h_limit/set"),
        ctrl: html`
          <div class="soc-duo">
            <div class="duo-cols">
              <div class="duo-col lo">
                <span class="duo-num">${iconOut}<span class="n">${Math.round(pair.l)}</span><span class="u">%</span></span>
                <span class="duo-cap">${this._t("Discharge stops at", "放电截止电量")}</span>
              </div>
              <span class="duo-div"></span>
              <div class="duo-col hi">
                <span class="duo-num">${iconIn}<span class="n">${Math.round(pair.h)}</span><span class="u">%</span></span>
                <span class="duo-cap">${this._t("Charge stops at", "充电截止电量")}</span>
              </div>
            </div>
            ${track}
            <div class="duo-scale">
              <span>${Math.round(pair.tLo)}%</span>
              <span>${Math.round(pair.tHi)}%</span>
            </div>
          </div>`,
      });
    }

    _rebootRow() {
      return this._row({
        icon: this._icon("reboot"),
        inline: true,
        label: this._t("Reboot", "重启设备"),
        sub: this._t("Takes about a minute", "约需一分钟"),
        topic: this._topic("button/<dev_id>/reboot/trigger"),
        ctrl: html`
          <button class="btn danger"
            @click=${() => this._reboot()}>${this._t("Reboot", "重启")}</button>`,
      });
    }

    _untrusted(markup) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      return template.content.cloneNode(true);
    }
  }

  /* ------------------------------------------------------------------ *
   * Visual editor
   * ------------------------------------------------------------------ */
  class HoymilesControlEditor extends LitElement {
    static get properties() {
      return { _config: { type: Object }, hass: { type: Object } };
    }

    setConfig(config) {
      this._config = { ...(config || {}) };
    }

    _changed(field) {
      return (event) => {
        const config = { ...(this._config || {}), [field]: event.target.value };
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config } }));
      };
    }

    _toggle(field) {
      return (event) => {
        const config = { ...(this._config || {}), [field]: event.target.checked };
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config } }));
      };
    }

    static get styles() {
      return css`
        .row { padding: 8px; }
        ha-textfield { display: block; width: 100%; margin-bottom: 8px; }
        .sw { display: flex; align-items: center; gap: 10px; padding: 6px 0;
              font-size: 14px; color: var(--primary-text-color); }
      `;
    }

    render() {
      const config = this._config || {};
      return html`
        <div class="row">
          <ha-textfield label="dev_id (required)" .value=${config.dev_id || ""}
            @change=${this._changed("dev_id")}></ha-textfield>
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._changed("title")}></ha-textfield>
          <label class="sw">
            <ha-switch .checked=${config.show_topics === true}
              @change=${this._toggle("show_topics")}></ha-switch>
            <span>show_topics (show the MQTT topic of every row, for debugging)</span>
          </label>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-control-editor")) {
    customElements.define("hoymiles-control-editor", HoymilesControlEditor);
  }
  if (!customElements.get("hoymiles-control")) {
    customElements.define("hoymiles-control", HoymilesControl);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-control")) {
    window.customCards.push({
      type: "hoymiles-control",
      name: "Hoymiles Control",
      description:
        "Buttons and inputs for every control topic of the Hoymiles micro storage "
        + "MQTT protocol (power, EMS mode, output power, phases, TOU, reboot).",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmControlRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmControlRegister());
}
