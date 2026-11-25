/* ============================================================================
 * Hoymiles Micro Storage — Battery (HiBattery X) card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-battery`
 *
 * Renders the physical battery stack of a Hoymiles micro storage device the
 * way the vendor app does:
 *
 *   - the stack is drawn module by module, so the picture always matches how
 *     many battery packs are actually installed (1 – 4, driven by the
 *     `pack_count` sensor and cross-checked against `packN_soc`);
 *   - every module gets a callout with its own SOC and temperature, the
 *     callouts alternate left / right like in the app;
 *   - the unit itself is drawn like the product photos: one body with a
 *     single light-to-dark gradient, thin seams between the modules, and a
 *     dark head carrying the status display (signal, battery, SOC);
 *   - PV / grid-on / battery / grid-off powers frame the picture;
 *   - an optional history section plots the pack SOC and the charged /
 *     discharged energy for 日 / 月 / 年 / 总 (from long term statistics).
 *
 * Everything is hand-rolled SVG (no chart library, no CDN).
 *
 * Card config:
 *   type: custom:hoymiles-battery
 *   dev_id: MSA-280520260806     # required
 *   title: HiBattery X           # optional, overrides the detected model
 *   show_title: false            # optional, hide the header title
 *   language: en                 # optional (en|zh|de); omit to follow Home Assistant
 *   show_history: true           # optional (default true)
 *   max_width: 560               # optional px for the illustration
 *   alarm_entity: binary_sensor.x # optional, overrides the alarm badge source
 *   entities:                    # optional entity id overrides
 *     pack_count: sensor.my_pack_count
 *     pv: sensor.my_pv_power
 *     grid_on: sensor.my_grid_on_power
 *     grid_off: sensor.my_grid_off_power
 *     battery: sensor.my_battery_power
 *     battery_status: sensor.my_battery_status
 *     soc: sensor.my_soc
 *     pack1_soc: sensor.my_pack1_soc
 *     pack1_temperature: sensor.my_pack1_temperature
 *     battery_temperature: sensor.my_battery_temperature
 * ========================================================================== */

function _hmBatteryRegister() {
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
    "Battery": "Batterie",
    "Battery ": "Batterie ",
    "Active alarms": "Aktive Alarme",
    "No active alarms": "Keine aktiven Alarme",
    "Wi-Fi signal": "WLAN-Signal",
    "Excellent": "Sehr gut",
    "Good": "Gut",
    "Fair": "Mäßig",
    "Weak": "Schwach",
    "No signal": "Kein Signal",
    "Host": "Hauptgerät",
    "PV": "PV",
    "Grid port": "Netzanschluss",
    "Off-grid port": "Inselanschluss",
    "Loading…": "Wird geladen…",
    "No statistics recorded for this range (the recorder must be enabled).": "Für diesen Zeitraum keine Statistiken aufgezeichnet (der Recorder muss aktiviert sein).",
    "Charged": "Geladen",
    "Discharged": "Entladen",
    "Packs": "Pakete",
    "History": "Verlauf",
    "No statistics source found for this device.": "Keine Statistikquelle für dieses Gerät gefunden.",
    "Statistics are unavailable — is the recorder enabled?": "Statistiken sind nicht verfügbar – ist der Recorder aktiviert?",
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
   *     en: HiBattery X
   *     zh: 电池组
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

  /* ------------------------------------------------------------------ *
   * Drawing constants
   * ------------------------------------------------------------------ */
  const VB_W = 620;
  const PACK_MAX = 4;

  /* Entity ids the firmware names differently from the protocol field.
   *
   * `bat_p` (§43) is published with the name "Battery Power" by the newer
   * firmware and with "Bat Power" by the older one, so the entity id that comes
   * out of MQTT discovery is `…_battery_power` on one unit and `…_bat_power` on
   * another - the same value under two ids.  The dashboards' chart series
   * already carry this alias (`dashboard._ENTITY_SUFFIX_ALIASES`); the card
   * needs it as well, or the head readout of a unit that chose the long name
   * silently falls back to 0 W.
   */
  const SUFFIX_ALIASES = {
    bat_power: ["battery_power"],
    battery_power: ["bat_power"],
  };

  /* Models built as one wide box rather than a head plus battery modules.
     Matched case-insensitively, the same way ``const.MODELS_WITHOUT_PV`` does
     on the Python side.  The 1920 AC is the second generation of the AC
     coupled unit and the only one of these so far. */
  const FLAT_CHASSIS = ["hibattery 1920 ac"];

  const TOP_H = 66;      // dark head module (BMS / PCS)
  const MOD_H = 158;     // one battery module
  const HEAD_TOP = 96;   // y of the top of the stack
  const FRONT_W = 300;   // front face width
  const FRONT_X = 130;   // x of the left edge of the front face
  const CALLOUT_W = 140;
  const CALLOUT_H = 54;
  /* A pack that is heating (or waiting to) grows its callout by one row: the
     pill has to sit somewhere, and widening the callout instead would push it
     over the module it points at.  MOD_H is 158, so a 72 px callout still leaves
     clear space between two neighbours. */
  const CALLOUT_H_HEAT = 72;

  /* Amber, the colour every heater in this integration uses (see the control
     card's flame). Kept as constants so the pill, its dot and its text cannot
     drift apart.  The requests share one colour - they describe the same thing
     ("this pack is cold"), and it is the arrow that says which way the energy
     wants to go; a second colour only made the diagram louder. */
  const HEAT_INK = "#FBBF24";
  const HEAT_FILL = "rgba(245,158,11,0.26)";
  const HEAT_LINE = "rgba(245,158,11,0.62)";
  /* Ice, not sky blue: the requests are about a pack that is too cold, and a
     pale frozen cyan reads as "cold" where the saturated blue read as "link".
     Light enough to glow on the dark callout, and it keeps the snowflake and
     the label on the same ink, so the pill reads as one object. */
  const COLD_INK = "#BAE6FD";        // charge and discharge requests alike
  const COLD_LINE = "rgba(186,230,253,0.5)";

  /**
   * The three *active* heating states of §32 `packs[].heat`.
   *
   * `idle` is deliberately absent: a pack with nothing to do keeps the plain
   * callout, which is what "空闲保持默认" means.
   *
   * `heating` keeps the heater glyph - the heater really is running.  The two
   * requests do not show a heater at all: what they report is **a pack that is
   * too cold**, so they show a snowflake in the ice colour.  One glyph, one
   * colour, two labels: an arrow on top of that said the same thing twice and
   * cluttered a pill this small - which direction the energy waits for is what
   * the words "charge" / "discharge" already say.  The fill still separates the
   * two situations: filled = running now, outline = still waiting.
   */
  const HEAT_KINDS = {
    heating: {
      en: "Heating", zh: "加热中", lit: true, req: false, icon: "heat",
      ink: HEAT_INK, line: HEAT_LINE,
      whyEn: "The heater is on now; nothing is waiting for it.",
      whyZh: "正在加热，没有等待中的动作。",
    },
    chg_req: {
      en: "Charge heat", zh: "充电加热请求", lit: false, req: true,
      icon: "snow", ink: COLD_INK, line: COLD_LINE,
      whyEn: "Too cold to charge - heat the pack up first.",
      whyZh: "温度偏低，需要先加热才能充电。",
    },
    dchg_req: {
      en: "Discharge heat", zh: "放电加热请求", lit: false, req: true,
      icon: "snow", ink: COLD_INK, line: COLD_LINE,
      whyEn: "Too cold to discharge - heat the pack up first.",
      whyZh: "温度偏低，需要先加热才能放电。",
    },
  };

  /**
   * The classic six fold snowflake, as the inside of a 15 x 15 box.
   *
   * Six spokes, each carrying a V of two branches in its outer third - the
   * crystal everyone draws.  One arm is written out and rotated every 60
   * degrees, which is also why it stays symmetric to the sub-pixel.
   *
   * Strokes, not a filled silhouette: the two earlier attempts (a hand drawn
   * asterisk, then `mdi:snowflake`) both filled a six pointed star, and at
   * roughly 14 px on screen a filled star is read as `*`, not as snow.  Thin
   * branched lines are what the eye recognises, even this small.
   */
  const SNOW_ARM = "M7.5 7.5V1.3M7.5 3.3 8.85 1.69M7.5 3.3 6.15 1.69";
  function snowflakeArms() {
    let out = "";
    for (let a = 0; a < 360; a += 60) {
      out += `<g transform="rotate(${a} 7.5 7.5)"><path d="${SNOW_ARM}"/></g>`;
    }
    return out;
  }

  /**
   * One heating pill inside a pack callout, at `x` (left) and `y` (top).
   *
   * `label` is the already-localised state name and `hint` the one-line reason
   * (shown as an SVG title); both are resolved by the caller because this runs
   * outside the element and has no `_t`.
   */
  function heatPill(x, y, kind, label, hint) {
    const text = label || kind.zh;
    /* The glyph slot is 15 units wide plus a 4 unit gap, and the width follows.
       The estimate is per script (a CJK glyph is about 11.9 units wide at 12 px,
       a Latin one about 6.4), and the result is clamped to the callout: an
       English label is long enough to overflow a 140 px callout otherwise, and a
       pill sticking out of its own callout is worse than a slightly compressed
       word. */
    const gap = 25;
    const per = /[\u3000-\u9fff\uff00-\uffef]/.test(text) ? 11.9 : 6.4;
    const maxW = CALLOUT_W - 24;
    let w = gap + text.length * per + 6;
    let fit = "";
    if (w > maxW) {
      w = maxW;
      fit = ` textLength="${(w - gap - 4).toFixed(1)}"`
        + " lengthAdjust=\"spacingAndGlyphs\"";
    }
    const h = 22;
    /* The heater glyph: a base line with three vertical wave lines rising off
       it - heat leaving a radiator, the way every appliance UI draws it.  Drawn
       as strokes rather than an emoji so it looks the same on every platform;
       the `q`/`t` pairs make each line a proper sine, not a zig-zag. */
    const waves = `<g stroke="${kind.ink}" stroke-width="1.5" fill="none"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M0.8 11.8H10.2"/>
        <path d="M2.4 8.9q-1.15-1.15 0-2.3t0-2.3t0-2.3"/>
        <path d="M5.6 8.9q-1.15-1.15 0-2.3t0-2.3t0-2.3"/>
        <path d="M8.8 8.9q-1.15-1.15 0-2.3t0-2.3t0-2.3"/>
      </g>`;
    /* The snowflake: one shared drawing, stroked in the ice colour, in a 15 unit
       box - the label sits right after it. */
    const snow = `<g stroke="${kind.ink}" stroke-width="1.2" fill="none"
        stroke-linecap="round" stroke-linejoin="round">${snowflakeArms()}</g>`;
    const glyph = kind.icon === "snow" ? snow : waves;
    const why = hint ? `<title>${esc(hint)}</title>` : "";
    return `<g class="bat-heat">${why}
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9"
        fill="${kind.lit ? HEAT_FILL : "none"}"
        stroke="${kind.line}" stroke-width="1"/>
      <g transform="translate(${x + 6} ${y + 3.5})">${glyph}</g>
      <text x="${x + gap}" y="${y + 15.6}" font-size="12" font-weight="600"${fit}
        fill="${kind.ink}">${esc(text)}</text>
    </g>`;
  }
  const LEFT_BOX_X = 2;
  /* Right edge of a right hand callout.  Inset from the viewBox edge so the
     off-grid connector's vertical (at VB_W - 30) can run past the labels
     instead of through them - without the inset the line had to duck below
     the lowest label, which put its start halfway down the body. */
  const RIGHT_BOX_X = VB_W - 42;
  const LEFT_DOT_X = FRONT_X + FRONT_W * 0.40;
  const RIGHT_DOT_X = FRONT_X + FRONT_W * 0.62;
  const DOT_COLOR = "#22c55e";

  /* ------------------------------------------------------------------ *
   * Fan speed indicators
   *
   * Two fans, each bolted to the part it cools: the PCS fan against the head's
   * right face (the PCS lives there), the battery fan at the lower-left corner
   * of the first module.  They are not captioned - sitting on the part IS the
   * label, and a caption in the margin read as a corner readout instead of as
   * hardware.  The name survives in the `title` tooltip.
   *
   * The rotor is five swept blades, the same shape the control card's fan card
   * uses: at this size three blades read as a pinwheel and six blur into a
   * disc.  Black on a light card, with the rounded-square frame the vendor app
   * puts around it.
   *
   * Levels come from `fan_actual` (§32): 0..10, and **255** means "this fan is
   * not fitted / not enabled".  Anything outside the range means the indicator
   * is left out entirely - printing 255 would claim a fan running at 25x full
   * speed.  The speed is linear in the level (`FAN_DPS_PER_LEVEL` degrees per
   * second), so a higher level visibly spins faster; level 0 is a still rotor.
   * ------------------------------------------------------------------ */
  const FAN_LEVEL_MAX = 10;
  const FAN_DPS_PER_LEVEL = 70;           // degrees per second at level 1
  const FAN_SIZE = 30;                    // frame size, user units
  const FAN_BLADE =
    "M-0.53-2.14C-1.5-4.6-2.4-6.6-2.84-7.8C-0.53-8.64 2.03-8.42 4.15-7.19"
    + "C3.5-5.4 2-2.9 0.96-1.98Z";
  /* Where each indicator sits: `cx` is its column, `cy` its rotor centre, and
     the frame is 23.75 units square centred on that point.

     Both fans are bolted to the part they cool rather than parked in the
     margin, so the position is the label and no caption is needed.  The PCS fan
     sits against the head's right face, just below the output connector (the
     off-grid line leaves the head at y 120); the battery fan sits at the
     lower-left corner of module 1, flush with both the left edge and that
     module's bottom seam (worked out from `bodyTop` + `MOD_H` in
     `stackMarkup`, so it follows the head height). */
  const PCS_FAN_SPOT = { cx: FRONT_X + FRONT_W + 14, cy: 137 };
  const BAT_FAN_SPOT = { cx: FRONT_X - 14, cy: 0 };   // cy is per module, see below


  /* Energy flow on the branch connectors.  The battery is drawn inside the
   * unit, so only PV, the on-grid port and the off-grid port get a line.
   *
   * The connector keeps its own grey colour; what travels along it is **one**
   * streak of light, sent from one end to the other.  Its dash gap is several
   * times the branch, so only one can be on the line at a time - a repeating
   * pattern put two or three of them on a long connector, which reads as
   * decoration rather than as something being sent.
   *
   * The streak is drawn as a run of **slices** with a colour and an opacity each,
   * which is what makes the fade smooth: white and opaque at the head, the flow
   * colour and nearly nothing at the tail.  Stacking four strokes of different
   * length instead (the previous attempt) gave a stepped tail, because a
   * gradient cannot be built out of a handful of nested outlines.
   *
   * The streak is a CSS animation of `stroke-dashoffset`, which is also what
   * fixed the freeze: the old dots were moved by a requestAnimationFrame loop,
   * and a card that had been detached and re-attached (switching dashboard tabs
   * does that) was never re-rendered, so nothing restarted the loop and the dots
   * stood still.
   *
   * The three keyframe stops are handed to the CSS as variables, because they
   * depend on the length of the connector.  A negative `animation-delay` puts a
   * rebuilt path back at the phase it had reached.
   */
  const FLOW_COLOR = "#22c55e";
  const FLOW_IDLE_W = 5;         // below this a branch carries nothing
  const FLOW_SHARE = 0.34;       // streak length, as a fraction of the branch
  const FLOW_MIN = 30;           // units; below this a short stub barely reads
  const FLOW_MAX = 80;           // units; a long branch must not carry a bar
  const FLOW_SLICES = 14;        // how many steps the fade is cut into
  const FLOW_WIDTH = 3.6;        // width at the head, in user units
  const FLOW_TIP = 2.1;          // width at the tail
  /* Share of the cycle spent travelling.  The rest is the pause after the streak
     has left, and it **must match the 72% stop in the keyframes**. */
  const FLOW_TRAVEL = 0.72;
  const FLOW_SPEED_MIN = 55;     // units/s just above the threshold
  const FLOW_SPEED_RANGE = 175;  // extra units/s at FLOW_SPEED_FULL_W
  const FLOW_SPEED_FULL_W = 1500;

  /* Battery corner icon: the drawing follows the state, the way the vendor app
   * does it - a battery that fills while charging, the two-arrow cycle while
   * discharging, a muted hourglass when idle. */
  const CHARGE_COLOR = "#22c55e";
  const DISCHARGE_COLOR = "#4a90d9";
  const IDLE_COLOR = "#9aa4af";
  // Material "sync": two arrows chasing each other round a circle.
  const SYNC_PATH = "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8"
    + "l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6"
    + " 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z";
  // Material "hourglass_empty"
  const HOURGLASS_PATH = "M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16"
    + "l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5l-4-4V4h8v3.5l-4 4z";

  /* The PV and port corners, drawn rather than pasted in.
   *
   * The PV corner used to be the ☀️ emoji, which sat next to flat single-colour
   * status glyphs and looked like it came from another app; it is now the same
   * sun, but drawn as one colour with round-capped rays, so it belongs to the
   * same family.  The port keeps the plate-and-plug drawing it always had -
   * it was simply too small to read, so its optical size went up instead of
   * its shape changing.
   *
   * Each builder draws inside a 24 x 24 box; `_cornerGlyph` scales and centres
   * it on the readout. */
  const CORNER_GLYPH = {
    /* A sun: solid disc, eight round-capped rays.
     *
     * Ray geometry, so the numbers stay checkable: the disc is r 4.6, the rays
     * run from r 7 to r 10, which leaves 2.4 units between the disc and the
     * ray tips - enough that the eight arms stay separate at 28 units wide
     * instead of merging into a blob. */
    sun: (c) => `
      <g stroke="${c}" stroke-width="1.9" stroke-linecap="round">
        <path d="M12 2v3"/><path d="M12 19v3"/>
        <path d="M2 12h3"/><path d="M19 12h3"/>
        <path d="M4.93 4.93 7.05 7.05"/><path d="M16.95 16.95 19.07 19.07"/>
        <path d="M19.07 4.93 16.95 7.05"/><path d="M7.05 16.95 4.93 19.07"/>
      </g>
      <circle cx="12" cy="12" r="4.6" fill="${c}"/>`,

    /* The plate-and-plug drawing, unchanged: a light rounded square with the
     * dark body and stem on it.  Kept in its own two colours on purpose - it is
     * the one glyph that reads as hardware rather than as a symbol. */
    socket: () => `
      <rect x="0" y="0" width="24" height="24" rx="6" fill="#cfd4da"/>
      <circle cx="12" cy="10" r="4.2" fill="#3b4149"/>
      <rect x="10" y="14" width="4" height="7" rx="2" fill="#3b4149"/>`,
  };

  /* Colour and optical size per corner icon.  Sizes are the side of the box in
     viewBox units - the port is deliberately larger than the sun because its
     plate and stem have to stay apart at the size the card actually draws. */
  const CORNER_COLORS = {
    sun: "#f5a623",
    socket: "#cfd4da",
  };
  const CORNER_SIZE = {
    sun: 31,
    socket: 36,
  };

  /* Vertical nudge per corner icon, in viewBox units.
   *
   * The sun is a disc with rays all the way round, so its ink is symmetric but
   * its optical weight sits high: beside a 24 px figure whose baseline the row
   * uses, a perfectly centred sun looks like it is floating.  Two and a half
   * units down puts it on the same visual line as the number.  The socket needs
   * nothing - it is a solid square, so geometric centring already reads right. */
  const CORNER_DY = {
    sun: 2.5,
    socket: 0,
  };

  const HEADER_GAP = 84;   // space between the stack and the bottom row
  const TAIL_GAP = 30;

  const RANGES = [
    { id: "day", en: "Day", zh: "日", period: "hour", days: 1 },
    { id: "month", en: "Month", zh: "月", period: "day", days: 30 },
    { id: "year", en: "Year", zh: "年", period: "month", days: 365 },
    { id: "total", en: "Total", zh: "总", period: "month", days: 365 * 6 },
  ];
  const HIST_TTL_MS = 5 * 60 * 1000;

  const STATUS = {
    charge: { cls: "ok", en: "Charging", zh: "充电" },
    discharge: { cls: "warn", en: "Discharging", zh: "放电" },
    lock: { cls: "warn", en: "Locked", zh: "锁定" },
    standby: { cls: "", en: "Standby", zh: "待机" },
  };

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  /**
   * Collapse a name to its alphanumeric characters so `pack_1_soc` and
   * `pack1_soc` compare equal.  The integration's entity ids slugify the
   * entity *name* (`Pack 1 SOC` -> `pack_1_soc`), which does not match the
   * raw description key, so suffix matching is done normalized.
   */
  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Wi-Fi strength, drawn the way a phone draws it: four bars, one per 10 dBm.
   *
   * dBm is logarithmic and each 10 dBm is a factor of ten in power, so an even
   * ladder is the only mapping that puts equal visual weight on equal steps. A
   * handset uses the same rule (full bars down to about -50, then one bar per
   * further -10); below -80 the link is unusable in practice and nothing is lit.
   *
   * | bars | reading (dBm) | stands for |
   * |------|---------------|------------|
   * | 4    | >= -50        | excellent  |
   * | 3    | -50 .. -60    | good       |
   * | 2    | -60 .. -70    | fair       |
   * | 1    | -70 .. -80    | weak       |
   * | 0    | < -80         | no usable signal |
   */
  function rssiBars(rssi) {
    if (rssi === null || !Number.isFinite(rssi)) return 0;
    if (rssi >= -50) return 4;
    if (rssi >= -60) return 3;
    if (rssi >= -70) return 2;
    if (rssi >= -80) return 1;
    return 0;
  }

  function clampNum(value, lo, hi) {
    if (!Number.isFinite(value)) return lo;
    return Math.min(Math.max(value, lo), hi);
  }

  /** "#rrggbb" (or "#rgb") -> [r, g, b], 0..255. */
  function hexRgb(hex) {
    const raw = String(hex).replace("#", "");
    const full = raw.length === 3
      ? raw.split("").map((ch) => ch + ch).join("")
      : raw;
    const value = parseInt(full, 16);
    if (!Number.isFinite(value)) return [0, 0, 0];
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  /**
   * Blend two colours, `t` = 0 gives `from` and `t` = 1 gives `to`.
   *
   * Used to walk the streak from white at its head to the flow colour at its
   * tail.  Interpolating in sRGB is not colour correct, but the two ends are
   * close enough in lightness that the difference is invisible here - and it
   * needs no colour space machinery.
   */
  function mixHex(from, to, t) {
    const a = hexRgb(from);
    const b = hexRgb(to);
    const k = clampNum(t, 0, 1);
    const parts = a.map((v, i) => Math.round(v + (b[i] - v) * k));
    return `rgb(${parts[0]},${parts[1]},${parts[2]})`;
  }

  /**
   * Length of one of the branch paths, in user units.
   *
   * The branch connectors are plain `M / L` polylines, so summing the segments
   * is enough - and doing that here keeps the streak animation from having to
   * call `getTotalLength()` on a live element, which would force a layout on
   * every render.
   *
   * `M` is a *move*, not a segment: it places the pen and contributes nothing.
   * Treating it as a line from (0, 0) made every branch look several hundred
   * units long, which in turn stretched the streak cycle to its ten second cap.
   */
  function pathLen(d) {
    const tokens = String(d).match(/[MLHV]|-?\d*\.?\d+/gi) || [];
    let x = 0;
    let y = 0;
    let cmd = "";
    let i = 0;
    let total = 0;
    const next = () => num(tokens[i++]);
    while (i < tokens.length) {
      if (/^[MLHV]$/i.test(tokens[i])) {
        cmd = tokens[i].toUpperCase();
        i += 1;
      }
      if (i >= tokens.length) break;
      if (cmd === "M") {
        x = next();
        y = next();
      } else if (cmd === "L") {
        const nx = next();
        const ny = next();
        total += Math.hypot(nx - x, ny - y);
        x = nx;
        y = ny;
      } else if (cmd === "H") {
        const nx = next();
        total += Math.abs(nx - x);
        x = nx;
      } else if (cmd === "V") {
        const ny = next();
        total += Math.abs(ny - y);
        y = ny;
      } else {
        break;
      }
    }
    return total;
  }

  /**
   * The same polyline walked the other way, so a reverse flow can reuse the
   * forward animation.
   *
   * The branch connectors are written corner first and unit last, so a negative
   * reading has to travel from the unit back to the corner.  Animating that by
   * negating the dash offset does not work: on a reverse trip the leading edge is
   * the dash's *start*, so each slice's "further back" shift moved it *forward*
   * instead - the streak ran tail first, with the faded end in front.  Reversing
   * the points keeps a single set of keyframe values for both directions.
   *
   * Only `M` / `L` appear in these paths, which is all this handles; anything
   * else is returned untouched.
   */
  function reversePoly(d) {
    const tokens = String(d).match(/[MLHV]|-?\d*\.?\d+/gi) || [];
    const pts = [];
    let cmd = "";
    let i = 0;
    let x = 0;
    let y = 0;
    const next = () => num(tokens[i++]);
    while (i < tokens.length) {
      if (/^[MLHV]$/i.test(tokens[i])) {
        cmd = tokens[i].toUpperCase();
        i += 1;
      }
      if (i >= tokens.length) break;
      if (cmd === "M" || cmd === "L") {
        x = next();
        y = next();
        pts.push({ x, y });
      } else if (cmd === "H") {
        x = next();
        pts.push({ x, y });
      } else if (cmd === "V") {
        y = next();
        pts.push({ x, y });
      } else {
        return d;
      }
    }
    if (pts.length < 2) return d;
    const back = pts.slice().reverse();
    return `M${back[0].x} ${back[0].y}`
      + back.slice(1).map((p) => ` L${p.x} ${p.y}`).join("");
  }

  function group(value) {
    const parts = String(value).split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  function fmtW(value) {
    const abs = Math.abs(num(value));
    const text = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
    return `${group(text)} W`;
  }

  function fmtEnergy(kwh) {
    const v = num(kwh);
    const abs = Math.abs(v);
    if (abs >= 1000) return `${(v / 1000).toFixed(2)} MWh`;
    if (abs >= 1) return `${v.toFixed(2)} kWh`;
    return `${(v * 1000).toFixed(0)} Wh`;
  }

  function dayStart(date, offsetDays = 0) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offsetDays);
    return d;
  }

  /* ------------------------------------------------------------------ *
   * The head module's status display
   *
   * The hardware's display bar, keeping only the five readings that matter on
   * a dashboard: the power symbol, the PV reading with its SOLAR caption, the
   * SOC between two chevrons, and the battery reading with its BATTERY
   * caption.  The hardware's small status icon cluster and the Wi-Fi / eco
   * symbols are deliberately left out - they carry no dashboard information
   * and only made the bar busy.
   *
   * The readings are plain (zero padded, monospaced) text rather than literal
   * seven-segment strokes: at this size stroked digits read as scratchy, while
   * text keeps the panel legible and matches the callout style used elsewhere
   * in the card.
   * ------------------------------------------------------------------ */

  /* The readings sit a shade below pure white: on the near black panel a full
   * white figure glares and fights the body gradient. */
  const PANEL_INK = "#c9d1d9";
  const PANEL_DIM = "rgba(201,209,217,0.55)";
  /* The direction arrow is lit in plain white - it is the one element that has
   * to read at a glance, so it sits above the (deliberately dimmer) figures. */
  const PANEL_ARROW = "#ffffff";
  const PANEL_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const PANEL_MIN_W = 5;                  // below this the battery is idle

  /**
   * A watt reading as the hardware would show it: the real value, no zero
   * padding, clamped to what four digits can hold.
   */
  function watt(value) {
    return String(Math.min(9999, Math.round(Math.abs(num(value)))));
  }

  /**
   * The status display on the head module.  `pv` and `battery` are watts and
   * `soc` a percentage; both readings are the *device's own* values, because
   * the head depicts this unit rather than the whole system.
   *
   * Layout: the SOC owns the middle of the panel - it and its two arrows are
   * centred on the panel's own centre line - and the two watt groups mirror
   * outwards from it (the power symbol, with no counterpart on the right, hangs
   * off the left end).  Every element on the top line shares one horizontal
   * centre, and each watt reading carries its `W` as a subscript at its bottom
   * right.
   *
   * All of it is derived from the panel centre, so changing a font size or the
   * number of digits only means re-checking the few widths above.
   */
  function headDisplay(pv, battery, soc, hasPv = true) {
    const ink = PANEL_INK;
    const dim = PANEL_DIM;
    // The head band is HEAD_TOP..HEAD_TOP+TOP_H (96..162), so 129 is its middle.
    const cy = HEAD_TOP + 33;
    // Baselines that put each font's *glyph box* on `cy`: the digits of a 13px
    // value sit 4.4 above their baseline, an 18px SOC 6.0.
    const valueY = cy + 4.4;
    const unitY = valueY + 3.6;           // the W, tucked into the bottom right
    const capY = cy + 14;                 // SOLAR / BATTERY captions

    const mid = FRONT_X + FRONT_W / 2;    // 280 - the panel's centre line
    const socHalf = 14.9;                 // half of the widest SOC ("100", 18px)
    const arrowGap = 9;
    const arrowW = 5;
    const groupGap = 10;
    const unitW = 8;                      // the "W" at 8px
    const unitGap = 2;
    // Width of one mono digit at 13px with the letter spacing used below; the
    // readings are NOT zero padded, so their width follows the value.
    const digitW = 7.45;
    const maxValueW = 4 * digitW;         // 29.8 - what four digits occupy
    // Distance from the centre line out to the inner edge of each watt value.
    // The readings are right aligned, so their inner edge is what is fixed -
    // a shorter number simply leaves more room towards the arrow.
    const inner = socHalf + arrowGap + arrowW + groupGap + unitW + unitGap;

    const pvText = watt(pv);
    const batText = watt(battery);

    const pvValueRight = mid - inner;               // 231.1
    const pvUnit = pvValueRight + unitGap;          // 233.1 - its own bottom right
    const pvCaption = pvValueRight - pvText.length * digitW / 2;
    // The battery group ALWAYS occupies the right hand slot, exactly where the
    // hardware puts it and where it has always been on this card.  A unit with
    // no PV input does not shuffle the remaining reading into the empty left
    // slot: it simply has nothing on the left, so the panel reads
    // "power symbol ... SOC ... BATTERY", which is the 4020 X panel minus the
    // solar figure.  Moving the battery left was tried and looked wrong - the
    // BATTERY caption ended up where SOLAR belongs.
    const batGroupRight = mid + inner + maxValueW;  // 368.4
    const batUnit = batGroupRight - unitW;          // 360.4
    const batValueRight = batUnit - unitGap;        // 358.4
    const batCaption = batValueRight - batText.length * digitW / 2;
    // The power symbol has no counterpart on the right, so it stays put: it is
    // anchored to where the widest battery/PV number would reach, not to the
    // current digits (otherwise it would jitter as the reading changes).
    const powerCx = pvValueRight - maxValueW - 14 - 6.5;  // 180.8

    const parts = [];
    const charging = num(battery) < -PANEL_MIN_W;
    const discharging = num(battery) > PANEL_MIN_W;

    // power symbol: the ring opens at the top, the stem drops through the gap
    parts.push(`<path d="M${(powerCx - 4.43).toFixed(2)} ${(cy - 4.76).toFixed(2)}
        A6.5 6.5 0 1 0 ${(powerCx + 4.43).toFixed(2)} ${(cy - 4.76).toFixed(2)}"
        fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="${powerCx.toFixed(2)}" y1="${cy - 7}" x2="${powerCx.toFixed(2)}" y2="${cy + 1}"
        stroke="${ink}" stroke-width="1.5" stroke-linecap="round"/>`);

    // PV reading (right aligned so the "W" never moves) + its caption
    if (hasPv) {
      parts.push(`<text x="${pvValueRight.toFixed(1)}" y="${valueY}" text-anchor="end" font-size="13"
        font-weight="600" letter-spacing="0.3" font-family="${PANEL_MONO}"
        fill="${ink}">${pvText}</text>
      <text x="${pvUnit.toFixed(1)}" y="${unitY}" font-size="8" font-weight="600"
        fill="${dim}">W</text>
      <text x="${pvCaption.toFixed(1)}" y="${capY}" text-anchor="middle" font-size="6.5"
        letter-spacing="1" fill="${dim}">SOLAR</text>`);
    }

    // SOC dead centre, flanked by whichever direction arrow applies
    const socText = soc == null
      ? "--"
      : String(Math.max(0, Math.min(100, Math.round(soc))));
    parts.push(`<text x="${mid}" y="${cy + 6}" text-anchor="middle" font-size="18"
        font-weight="600" font-family="${PANEL_MONO}"
        fill="${ink}">${socText}</text>`);
    if (charging) {
      parts.push(`<path d="M${(mid - socHalf - arrowGap).toFixed(1)} ${cy - 6}
        l-${arrowW} 6 ${arrowW} 6" fill="none"
        stroke="${PANEL_ARROW}" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round"/>`);
    } else if (discharging) {
      parts.push(`<path d="M${(mid + socHalf + arrowGap).toFixed(1)} ${cy - 6}
        l${arrowW} 6 -${arrowW} 6" fill="none"
        stroke="${PANEL_ARROW}" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round"/>`);
    }

    // battery reading + its caption
    parts.push(`<text x="${batValueRight.toFixed(1)}" y="${valueY}" text-anchor="end" font-size="13"
        font-weight="600" letter-spacing="0.3" font-family="${PANEL_MONO}"
        fill="${ink}">${batText}</text>
      <text x="${batUnit.toFixed(1)}" y="${unitY}" font-size="8" font-weight="600"
        fill="${dim}">W</text>
      <text x="${batCaption.toFixed(1)}" y="${capY}" text-anchor="middle" font-size="6.5"
        letter-spacing="1" fill="${dim}">BATTERY</text>`);

    return parts.join("");
  }

  /**
   * One fan speed indicator: the framed rotor plus its level and caption.
   *
   * The rotor is a `<g>` carrying `data-hm-fan` / `data-cx` / `data-cy` /
   * `data-dps`; the card's rAF loop rotates it.  It is driven by script rather
   * than a CSS animation because the whole drawing is rebuilt whenever a
   * reading changes - a CSS animation would restart from zero every second,
   * which reads as a stutter.  The loop keeps one angle per fan in `_fanDeg`,
   * so a rebuild resumes where the previous rotor was.
   */
  function fanIndicator(key, spot, level, caption) {
    const s = FAN_SIZE / 24;
    const blades = [0, 72, 144, 216, 288]
      .map((angle) => `<path d="${FAN_BLADE}" transform="rotate(${angle})"/>`)
      .join("");
    const title = esc(`${caption} · ${level}/${FAN_LEVEL_MAX}`);
    return `<g class="bat-fan">
        <title>${title}</title>
        <g transform="translate(${spot.cx} ${spot.cy}) scale(${s.toFixed(4)}) translate(-12 -12)">
          <rect x="2.5" y="2.5" width="19" height="19" rx="5"
                fill="rgba(255,255,255,0.92)" stroke="#1f2933" stroke-width="1.5"/>
          <g data-hm-fan="${key}" data-cx="12" data-cy="12"
             data-dps="${level * FAN_DPS_PER_LEVEL}"
             transform="rotate(0 12 12)" fill="#1f2933">
            <g transform="translate(12 12)">${blades}</g>
          </g>
          <circle cx="12" cy="12" r="2.4" fill="#ffffff"
                  stroke="#1f2933" stroke-width="1.15"/>
          <circle cx="12" cy="12" r="0.6" fill="#1f2933"/>
        </g>
        <text class="bat-fan-l" x="${spot.cx}" y="${spot.cy + 28}"
              text-anchor="middle">${level}</text>
      </g>`;
  }

  /* ------------------------------------------------------------------ *
   * The stack itself
   *
   * Drawn the way the product photo looks: one tall body, a single gradient
   * that runs light at the top to almost black at the foot, thin seams marking
   * the modules, a dark head carrying the status display, and a small
   * connector tab on the head's right shoulder.  There is deliberately no
   * full-height side panel: the real unit is a flat front face.
   * ------------------------------------------------------------------ */
  function stackMarkup(packs, active, soc, pv, battery, fans, hasPv = true) {
    const count = Math.max(packs, 1);
    const stackH = TOP_H + count * MOD_H;
    const bottom = HEAD_TOP + stackH;
    const bodyTop = HEAD_TOP + TOP_H;
    const cx = FRONT_X + FRONT_W / 2;

    const parts = [];

    // The whole unit in one piece, painted with a single top-to-bottom
    // gradient (`hm-bat-body` is a userSpaceOnUse gradient built from the same
    // `bodyTop` / `bottom`, so it scales with the pack count).  The modules are
    // marked by thin seams only - not by shading each one separately.
    parts.push(`<rect x="${FRONT_X}" y="${HEAD_TOP}" width="${FRONT_W}"
        height="${stackH}" rx="7" fill="url(#hm-bat-body)"/>`);

    // seams + the wordmark at the foot of every module
    for (let i = 0; i < count; i += 1) {
      const y = bodyTop + i * MOD_H;
      if (i > 0) {
        parts.push(`<rect x="${FRONT_X}" y="${(y - 1.2).toFixed(1)}" width="${FRONT_W}"
          height="1.6" fill="rgba(255,255,255,0.30)"/>
        <rect x="${FRONT_X}" y="${(y + 0.6).toFixed(1)}" width="${FRONT_W}"
          height="1" fill="rgba(0,0,0,0.20)"/>`);
      }
      parts.push(`<text x="${FRONT_X + 16}" y="${y + MOD_H - 14}"
          font-size="12" letter-spacing="0.4"
          fill="rgba(255,255,255,0.55)">Hoymiles</text>`);
    }

    // The brand badge sits on the first module - the head carries the status
    // display instead of a logo, exactly like the hardware.
    const badgeCy = bodyTop + MOD_H / 2;
    parts.push(`<circle cx="${cx}" cy="${badgeCy}" r="25" fill="none"
        stroke="rgba(255,255,255,0.7)" stroke-width="1.8"/>
      <text x="${cx}" y="${badgeCy + 9}" text-anchor="middle" font-size="26"
        font-weight="600" fill="rgba(255,255,255,0.8)">H</text>
      <text x="${cx}" y="${badgeCy + 48}" text-anchor="middle" font-size="13"
        letter-spacing="0.6" fill="rgba(255,255,255,0.78)">Hoymiles</text>`);

    // dark head module on top
    parts.push(`<path d="M${FRONT_X + 7} ${HEAD_TOP} h${FRONT_W - 14}
        a7 7 0 0 1 7 7 v${TOP_H - 7} h-${FRONT_W} v-${TOP_H - 7}
        a7 7 0 0 1 7 -7 z" fill="url(#hm-bat-top)"/>`);

    // status display, and the shadow line where the head meets the body.
    // A faint highlight along the top edge keeps the panel reading as glass.
    parts.push(`<line x1="137" y1="96.7" x2="423" y2="96.7"
        stroke="rgba(255,255,255,0.10)" stroke-width="1.4"/>`);
    parts.push(headDisplay(pv, battery, soc, hasPv));
    parts.push(`<rect x="${FRONT_X}" y="${bodyTop - 3}" width="${FRONT_W}"
        height="3" fill="rgba(0,0,0,0.35)"/>`);

    // Module callouts: strictly alternating left / right down the stack, like
    // the vendor app.  The first pack starts on the left now that the head unit
    // readout is gone - it used to start on the right so it would not sit in the
    // same column as that readout.
    for (let i = 0; i < count; i += 1) {
      const cy = bodyTop + i * MOD_H + MOD_H / 2;
      const onLeft = i % 2 === 0;
      const dotX = onLeft ? LEFT_DOT_X : RIGHT_DOT_X;
      const boxX = onLeft ? LEFT_BOX_X : RIGHT_BOX_X - CALLOUT_W;
      const edgeX = onLeft ? LEFT_BOX_X + CALLOUT_W : RIGHT_BOX_X - CALLOUT_W;

      const soc = i < active.length ? active[i].soc : null;
      const temp = i < active.length ? active[i].temp : null;
      /* §32 `packs[].heat` is a four state flag, not a boolean: `idle` (nothing
         to do), `heating`, and the two requests that come before it.  Only the
         three active states add anything to the callout - an idle pack keeps the
         callout it has always had, so a unit that never heats looks unchanged. */
      const heat = i < active.length ? HEAT_KINDS[active[i].heat] : null;
      const calloutH = heat ? CALLOUT_H_HEAT : CALLOUT_H;
      const top = cy - calloutH / 2;
      const titleY = heat ? top + 17 : cy - 6;
      const valueY = heat ? top + 38 : cy + 15;

      parts.push(`<line x1="${edgeX}" y1="${cy}" x2="${dotX}" y2="${cy}"
        stroke="${DOT_COLOR}" stroke-width="1.8"/>`);
      parts.push(`<circle cx="${dotX}" cy="${cy}" r="5" fill="${DOT_COLOR}"
        stroke="#fff" stroke-width="1.6"/>`);
      parts.push(`<g class="bat-call">
        <rect x="${boxX}" y="${top}" width="${CALLOUT_W}"
          height="${calloutH}" rx="11" fill="rgba(56,61,70,0.88)"/>
        <text x="${boxX + 14}" y="${titleY}" class="bat-call-t">${esc(active[i].label)}</text>
        <text x="${boxX + 14}" y="${valueY}" class="bat-call-v">${soc == null ? "--" : `${soc.toFixed(2)}%`}<tspan
          class="bat-call-temp" dx="9">${temp == null ? "--" : `${temp.toFixed(1)}°C`}</tspan></text>
        ${heat ? heatPill(boxX + 14, top + 46, heat,
          active[i].heatText, active[i].heatHint) : ""}
      </g>`);
    }

    /* Fan speeds, bolted to the part each one cools.  A fan whose level is
       outside 0..10 (255 = not fitted / not enabled, §32) is left out       entirely: drawing it would claim a speed the device never reported.

       The battery fan's row is derived from the stack, not hard coded: it sits
       in module 1's lower-left corner, its frame flush with the left face and
       with that module's bottom seam.  That corner is free whatever the pack
       count and whether or not the host callout is drawn - the per-pack
       callouts on the left are all at y <= 268 for module 1, and any later left
       hand one is a full module lower down. */
    if (fans) {
      if (fans.pcs != null) {
        parts.push(fanIndicator("pcs", PCS_FAN_SPOT, fans.pcs, fans.pcsCaption));
      }
      if (fans.bat != null) {
        const batSpot = {
          cx: BAT_FAN_SPOT.cx,
          cy: bodyTop + MOD_H - 12,          // flush with module 1's foot
        };
        parts.push(fanIndicator("bat", batSpot, fans.bat, fans.batCaption));
      }
    }

    return { markup: parts.join(""), bodyTop, bottom };
  }

  /* ------------------------------------------------------------------ *
   * The flat chassis (HiBattery 1920 AC)
   *
   * A different product rather than a 4020 with parts missing.  Drawn art was
   * tried twice and never survived the shrink to ~190 px, so the case here is
   * the **product photo** itself (`hibattery-1920ac.png`, transparent outside
   * the moulding), and only the display is drawn on top of it: the real unit
   * shows its state of charge on that panel, so the card paints the green level
   * bar and the percentage over the photo's own black screen.
   *
   * The photo is measured once (860 x 420) and the panel box is expressed as
   * fractions, so the overlay follows if the artwork is ever replaced:
   *
   *   display   x 268..590   y 144..218   ->  FLAT_DISP below
   *
   * The photo's studio backdrop has been keyed out, so nothing may be painted
   * underneath it: a fallback box would simply show through the transparent
   * corners as the grey shadow the photo was cleared of.  The asset is part of
   * `FRONTEND_IMAGES`, so it is always deployed next to these scripts.
   *
   * The image starts on the stack's left edge (`FRONT_X`) and its connectors
   * attach at the same heights, so the branch lines, the corner readouts and
   * the pack callout keep their geometry - only the chassis itself differs.
   * ------------------------------------------------------------------ */
  const FLAT_W = 380;          // drawn width; 380 x 190 matches the photo
  const FLAT_H = 190;
  const FLAT_IMAGE = "/hoymiles_static/hibattery-1920ac.png";
  // The black screen, as a fraction of the photo.  Measured, not guessed.
  const FLAT_DISP = { x0: 0.3116, x1: 0.6860, y0: 0.3429, y1: 0.5190 };
  // Where the front face starts (lid + black band, from the photo).  Only used
  // to place the pack callout and the optional fan, whose positions were tuned
  // against the earlier drawing and still line up with the artwork.
  const FLAT_FACE_TOP = 43;

  /* ------------------------------------------------------------------ *
   * The MS-A2 cabinet
   *
   * A **portrait** cabinet photographed at a slight angle, so it cannot reuse
   * the 1920 AC artwork: the body is drawn as the photo (`hibattery-msa2.png`,
   * already keyed out by the vendor) and only the level is painted on it.
   *
   * The unit shows its state of charge in the black strip on the front face,
   * and unlike the 1920 AC that strip fills **upward** - so the overlay is a
   * vertical bar, not a horizontal one.  No number is painted on the body: the
   * pack callout on the left already carries the state of charge, and a second,
   * much larger figure two centimetres away only competes with it.
   *
   * Measured from the 634 x 652 source:
   *   strip    x 200..273   y  92..319   (the whole dark panel)
   *   socket   x 511..616   y 110..240   (on the angled side face)
   *
   * The level fills the **whole** dark panel, not just the part of it below the
   * two buttons: on this unit the entire black strip is the gauge, so a bar that
   * stopped under the buttons left two thirds of it unused and the reading read
   * far too low.
   * ------------------------------------------------------------------ */
  const MSA2_W = 224;          // 634 x 652 scaled to the stack's height
  const MSA2_H = 230;
  const MSA2_IMAGE = "/hoymiles_static/hibattery-msa2.png";
  // The level bar, as fractions of the photo.  Measured, not guessed.
  const MSA2_BAR = { x0: 0.3155, x1: 0.4306, y0: 0.1411, y1: 0.4893 };
  // Where the two right-hand connectors plug into the side face.  The AC socket
  // spans y 135..181 in this box, so both lines land inside it, 12 apart.
  const MSA2_AC_Y = 148;
  const MSA2_OFF_Y = 160;

  /* The card rebuilds its whole drawing whenever a reading changes, and the
     device pushes one every second, so the <image> carrying the case is
     re-created constantly.  Warming the browser's image cache once here means
     those rebuilds reuse the already decoded bitmap instead of paying for it
     again, which is what made a page refresh feel slow. */
  if (typeof Image === "function") {
    for (const src of [FLAT_IMAGE, MSA2_IMAGE]) {
      const warm = new Image();
      warm.src = src;
      if (typeof warm.decode === "function") warm.decode().catch(() => {});
    }
  }

  function flatMarkup(active, soc, fans) {
    const x = FRONT_X;
    const top = HEAD_TOP;
    const bottom = top + FLAT_H;
    const parts = [];

    const faceTop = top + FLAT_FACE_TOP;

    // ---- the case: the photo alone, its backdrop already transparent ----
    parts.push(`<image href="${FLAT_IMAGE}" x="${x}" y="${top}"
        width="${FLAT_W}" height="${FLAT_H}"
        preserveAspectRatio="none"/>`);

    // The display. `soc` is the unit's own state of charge; a missing reading
    // draws the empty track and "--" rather than a bar at zero, because those
    // two mean different things.  Everything below sits inside the screen the
    // photo already has, so no frame is drawn - only what the panel would show.
    const dispX = x + FLAT_W * FLAT_DISP.x0;
    const dispY = top + FLAT_H * FLAT_DISP.y0;
    const dispW = FLAT_W * (FLAT_DISP.x1 - FLAT_DISP.x0);
    const dispH = FLAT_H * (FLAT_DISP.y1 - FLAT_DISP.y0);
    const pct = soc == null ? null : Math.max(0, Math.min(100, num(soc)));
    const barX = dispX + 7;
    const barY = dispY + 4.5;
    const barW = dispW - 14;
    const barH = 10;
    // Clipped to the track so the fill's right end stays square - a rounded
    // end on both sides reads as a slider, not as a level.  The empty part of
    // the track is a very dark green, not grey: that is how the panel itself
    // shows it, and the two tones then read as one bar instead of a bar on a
    // separate background.
    parts.push(`<clipPath id="hm-flat-bar"><rect x="${barX}" y="${barY}"
        width="${barW}" height="${barH}" rx="2.5"/></clipPath>`);
    parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}"
        rx="2.5" fill="#0e2a1c"/>`);
    if (pct) {
      parts.push(`<g clip-path="url(#hm-flat-bar)">
        <rect x="${barX}" y="${barY}" width="${(barW * pct / 100).toFixed(1)}"
          height="${barH}" fill="url(#hm-flat-bar-fill)"/>
      </g>`);
    }
    parts.push(`<text x="${dispX + dispW / 2}" y="${dispY + dispH - 4.5}"
        text-anchor="middle" font-size="13.5" font-weight="600"
        font-family="${PANEL_MONO}" fill="#f2f6fa">${pct == null ? "--" : `${pct.toFixed(1)}%`}</text>`);

    /* The single pack callout, on the left.  The dot is placed 60 units in from
       the left face: far enough that the leader line reads as a leader rather
       than a stub through the cap, still well clear of the display. */
    const pack = active && active[0];
    if (pack) {
      const cy = faceTop + (bottom - faceTop) * 0.44;
      const dotX = x + 62;
      const edgeX = LEFT_BOX_X + CALLOUT_W;
      const heat = HEAT_KINDS[pack.heat] || null;
      const calloutH = heat ? CALLOUT_H_HEAT : CALLOUT_H;
      const boxY = cy - calloutH / 2;
      const titleY = heat ? boxY + 17 : cy - 6;
      const valueY = heat ? boxY + 38 : cy + 15;
      parts.push(`<line x1="${edgeX}" y1="${cy}" x2="${dotX}" y2="${cy}"
        stroke="${DOT_COLOR}" stroke-width="1.8"/>`);
      parts.push(`<circle cx="${dotX}" cy="${cy}" r="5" fill="${DOT_COLOR}"
        stroke="#fff" stroke-width="1.6"/>`);
      parts.push(`<g class="bat-call">
        <rect x="${LEFT_BOX_X}" y="${boxY}" width="${CALLOUT_W}"
          height="${calloutH}" rx="11" fill="rgba(56,61,70,0.88)"/>
        <text x="${LEFT_BOX_X + 14}" y="${titleY}" class="bat-call-t">${esc(pack.label)}</text>
        <text x="${LEFT_BOX_X + 14}" y="${valueY}" class="bat-call-v">${pack.soc == null ? "--" : `${pack.soc.toFixed(2)}%`}<tspan
          class="bat-call-temp" dx="9">${pack.temp == null ? "--" : `${pack.temp.toFixed(1)}°C`}</tspan></text>
        ${heat ? heatPill(LEFT_BOX_X + 14, boxY + 46, heat,
          pack.heatText, pack.heatHint) : ""}
      </g>`);
    }

    /* A fan, if this unit ever reports one: against the right face, below the
       two connectors.  The model drawn here has none (its `fan_actual` is 255),
       so this is only to keep the drawing honest if that changes. */
    if (fans && fans.pcs != null) {
      parts.push(fanIndicator("pcs", { cx: x + FLAT_W + 10, cy: top + 58 },
        fans.pcs, fans.pcsCaption));
    }

    return { markup: parts.join(""), bodyTop: faceTop, bottom };
  }

  function msa2Markup(active, soc, fans) {
    const x = FRONT_X;
    const top = HEAD_TOP;
    const bottom = top + MSA2_H;
    const parts = [];

    // ---- the cabinet: the photo alone, its backdrop already transparent ----
    parts.push(`<image href="${MSA2_IMAGE}" x="${x}" y="${top}"
        width="${MSA2_W}" height="${MSA2_H}"
        preserveAspectRatio="none"/>`);

    /* The level.  It rises from the base of the strip instead of running
       left to right, because that is how this unit shows it.  Clipped to the
       track so the fill's leading edge stays square - a round end on both
       sides reads as a slider rather than a level.  A missing reading draws
       the empty track only. */
    const barX = x + MSA2_W * MSA2_BAR.x0;
    const barW = MSA2_W * (MSA2_BAR.x1 - MSA2_BAR.x0);
    const barTop = top + MSA2_H * MSA2_BAR.y0;
    const barBot = top + MSA2_H * MSA2_BAR.y1;
    const barH = barBot - barTop;
    const pct = soc == null ? null : Math.max(0, Math.min(100, num(soc)));
    parts.push(`<clipPath id="hm-msa2-bar"><rect x="${barX}" y="${barTop}"
        width="${barW}" height="${barH}" rx="3"/></clipPath>`);
    parts.push(`<rect x="${barX}" y="${barTop}" width="${barW}" height="${barH}"
        rx="3" fill="#0e2a1c"/>`);
    if (pct) {
      const fillH = barH * pct / 100;
      parts.push(`<g clip-path="url(#hm-msa2-bar)">
        <rect x="${barX}" y="${(barBot - fillH).toFixed(1)}" width="${barW}"
          height="${fillH.toFixed(1)}" fill="url(#hm-msa2-bar-fill)"/>
      </g>`);
    }

    /* The single pack callout, on the left.  The dot sits inside the front
       face and clear of the strip, so the leader line never crosses the
       display. */
    const pack = active && active[0];
    if (pack) {
      const cy = top + MSA2_H * 0.52;
      const dotX = x + 46;
      const edgeX = LEFT_BOX_X + CALLOUT_W;
      const heat = HEAT_KINDS[pack.heat] || null;
      const calloutH = heat ? CALLOUT_H_HEAT : CALLOUT_H;
      const boxY = cy - calloutH / 2;
      const titleY = heat ? boxY + 17 : cy - 6;
      const valueY = heat ? boxY + 38 : cy + 15;
      parts.push(`<line x1="${edgeX}" y1="${cy}" x2="${dotX}" y2="${cy}"
        stroke="${DOT_COLOR}" stroke-width="1.8"/>`);
      parts.push(`<circle cx="${dotX}" cy="${cy}" r="5" fill="${DOT_COLOR}"
        stroke="#fff" stroke-width="1.6"/>`);
      parts.push(`<g class="bat-call">
        <rect x="${LEFT_BOX_X}" y="${boxY}" width="${CALLOUT_W}"
          height="${calloutH}" rx="11" fill="rgba(56,61,70,0.88)"/>
        <text x="${LEFT_BOX_X + 14}" y="${titleY}" class="bat-call-t">${esc(pack.label)}</text>
        <text x="${LEFT_BOX_X + 14}" y="${valueY}" class="bat-call-v">${pack.soc == null ? "--" : `${pack.soc.toFixed(2)}%`}<tspan
          class="bat-call-temp" dx="9">${pack.temp == null ? "--" : `${pack.temp.toFixed(1)}°C`}</tspan></text>
        ${heat ? heatPill(LEFT_BOX_X + 14, boxY + 46, heat,
          pack.heatText, pack.heatHint) : ""}
      </g>`);
    }

    if (fans && fans.pcs != null) {
      parts.push(fanIndicator("pcs", { cx: x + MSA2_W + 10, cy: top + 58 },
        fans.pcs, fans.pcsCaption));
    }

    return { markup: parts.join(""), bodyTop: top + MSA2_H * 0.1, bottom };
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesBattery extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _range: { type: String },
        _history: { type: Object },
        _histLoading: { type: Boolean },
        _histError: { type: String },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._cache = new Map();
      this._range = RANGES[0].id;
      this._history = null;
      this._histLoading = false;
      this._histError = null;
      this._histFetchedAt = 0;
      this._histToken = 0;
      // Flow animation state.  The phases are keyed by branch name rather than
      // by element: the SVG is rebuilt whenever a reading changes, and starting
      // every streak over from the near end each second reads as a stutter.
      this._flowPhase = new Map();
      this._flowClock = 0;
      this._spinEl = null;
      this._pulseEls = [];
      this._fanEls = [];
      /* One angle per fan, kept across the rebuilds the readings cause - the
         rotor then resumes where it was instead of snapping back to 0. */
      this._fanDeg = new Map();
      this._flowRaf = 0;
      this._flowLast = 0;
      this._spinDeg = 0;
      this._pulsePhase = 0;
      this._flowTick = this._flowTick.bind(this);
      /* The "the packs are cold" banner.  It has no clock: it stays up for as
         long as a pack keeps asking for heat, and only the user closes it. */
      this._heatNotice = null;
      this._heatNoticeKey = "";
      /* The request set the user closed by hand.  Kept so the same situation
         does not raise the banner again on the next reading - it comes back only
         when the requests themselves change (or clear and return). */
      this._heatDismissed = "";
    }

    /**
     * Collect the parts that a requestAnimationFrame loop drives.
     *
     * The status glyph (its ring and the segments that fill while charging) and
     * the two fan rotors.  The branch flow is a CSS animation and needs nothing
     * here.
     */
    _syncAnimation() {
      const root = this.renderRoot;
      if (!root) return;
      this._spinEl = root.querySelector("[data-hm-spin]");
      this._pulseEls = Array.from(root.querySelectorAll("[data-hm-pulse]"));
      this._fanEls = Array.from(root.querySelectorAll("[data-hm-fan]"));
      /* The SVG was just rebuilt, so every rotor starts at 0: put each one back
         at the angle its fan had reached. */
      for (const el of this._fanEls) {
        const key = el.getAttribute("data-hm-fan") || "";
        const deg = this._fanDeg.get(key) || 0;
        el.setAttribute("transform", `rotate(${deg.toFixed(1)} 12 12)`);
      }
      if (!this._flowRaf
        && (this._spinEl || this._pulseEls.length || this._fanEls.length)) {
        this._flowLast = 0;
        this._flowRaf = requestAnimationFrame(this._flowTick);
      }
    }

    updated() {
      this._syncAnimation();
      this._checkHeatRequest();
    }

    /**
     * Which packs are asking for heat right now (``"1:chg_req|2:dchg_req"``).
     *
     * Only the two requests count: `heating` already has its pill and needs no
     * advice, and `idle` is not a problem.
     */
    _heatRequestKey() {
      const out = [];
      for (let i = 1; i <= PACK_MAX; i += 1) {
        const state = (this._readText(`pack${i}_heating_state`) || "").toLowerCase();
        const kind = HEAT_KINDS[state];
        if (kind && kind.req) out.push(`${i}:${state}`);
      }
      return out.join("|");
    }

    /**
     * Raise the banner while (and only while) a pack is asking for heat.
     *
     * A request is a condition, not an event: it can last for hours, so there is
     * no timer.  The banner is up whenever the request set is non-empty, and it
     * goes away for two reasons only - the requests are gone, or the user closed
     * it.  Closing it is remembered per request set, so the next reading does not
     * bring it straight back.
     */
    _checkHeatRequest() {
      const key = this._heatRequestKey();
      if (!key) {
        this._heatNoticeKey = "";
        this._heatDismissed = "";
        if (this._heatNotice) {
          this._heatNotice = null;
          this.requestUpdate();
        }
        return;
      }
      if (key === this._heatDismissed) return;
      if (key === this._heatNoticeKey) return;
      this._heatNoticeKey = key;
      this._heatNotice = key;
      this.requestUpdate();
    }

    /**
     * Closing is an act of the user, not a timeout: the requests are still there,
     * so the card remembers this exact set and stays quiet until it changes.
     */
    _dismissHeatNotice() {
      this._heatDismissed = this._heatNoticeKey;
      this._heatNotice = null;
      this.requestUpdate();
    }

    /**
     * The banner itself: a floating strip inside the device page, near the top
     * but over the drawing - not part of the card's flow, and not fixed to the
     * viewport (that put it on top of the dashboard header and its view tabs).
     */
    _heatNoticeMarkup() {
      if (!this._heatNotice) return "";
      const icon = `<svg viewBox="0 0 15 15" width="18" height="18" fill="none"
        stroke="currentColor" stroke-width="1.2" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">${snowflakeArms()}</svg>`;
      return html`<div class="heat-note" role="status">
        <span class="bi">${this._untrusted(icon)}</span>
        <span class="bt">${this._t(
          "The batteries are cold. Turning heating on restores the usable "
          + "capacity at low temperature and extends their life "
          + "(Control -> Heating).",
          "电池温度偏低，建议开启加热：低温下可用容量与充放电能力都会受限，"
          + "开启加热可提升可用容量并延长电池寿命（控制 → 加热控制）。",
        )}</span>
        <button class="bx" @click=${() => this._dismissHeatNotice()}
          aria-label=${this._t("Dismiss", "关闭")}>×</button>
      </div>`;
    }

    /**
     * Language changes are announced on `window`; re-rendering is all a card
     * has to do, because the wording is chosen while it renders.
     */
    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
      /* Lit does not re-render when an element is re-attached, so the glyph
         would stay frozen after a tab switch: restart its loop here.  The flow
         pulse is a CSS animation and takes care of itself.  The clock is
         forgotten so the first render after coming back does not add the whole
         time away to the phase. */
      this._flowClock = 0;
      this._syncAnimation();
    }

    disconnectedCallback() {
      window.removeEventListener(LANG_EVENT, this._onLangChange);
      super.disconnectedCallback();
      if (this._flowRaf) cancelAnimationFrame(this._flowRaf);
      this._flowRaf = 0;
      this._flowLast = 0;
      this._flowClock = 0;
    }

    /** Advance the status glyph and the fan rotors.  The branch flow is CSS. */
    _flowTick(ts) {
      if (!this._spinEl && !this._pulseEls.length && !this._fanEls.length) {
        this._flowRaf = 0;
        return;
      }
      if (!this._flowLast) this._flowLast = ts;
      const dt = Math.min(80, ts - this._flowLast);
      this._flowLast = ts;

      // Discharging: the two arrows chase each other round the ring.
      if (this._spinEl) {
        this._spinDeg = (this._spinDeg + dt * 0.16) % 360;
        const cx = this._spinEl.getAttribute("data-cx");
        const cy = this._spinEl.getAttribute("data-cy");
        this._spinEl.setAttribute(
          "transform", `rotate(${this._spinDeg.toFixed(1)} ${cx} ${cy})`,
        );
      }

      // Charging: the battery fills one segment at a time.
      if (this._pulseEls.length) {
        this._pulsePhase = (this._pulsePhase + dt) % 1320;
        const level = Math.floor(this._pulsePhase / 440);
        for (const el of this._pulseEls) {
          const index = Number(el.getAttribute("data-hm-pulse"));
          el.style.opacity = index <= level ? "1" : "0.24";
        }
      }

      // Fans: the speed comes from the level, so a higher level spins faster.
      // Level 0 carries `data-dps="0"` and is left where it is - a stopped fan.
      for (const el of this._fanEls) {
        const dps = Number(el.getAttribute("data-dps")) || 0;
        if (!(dps > 0)) continue;
        const key = el.getAttribute("data-hm-fan") || "";
        const deg = ((this._fanDeg.get(key) || 0) + (dt * dps) / 1000) % 360;
        this._fanDeg.set(key, deg);
        el.setAttribute("transform", `rotate(${deg.toFixed(1)} 12 12)`);
      }

      this._flowRaf = requestAnimationFrame(this._flowTick);
    }

    static getConfigElement() {
      return document.createElement("hoymiles-battery-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
    }

    static get styles() {
      return css`
        :host { display: block; position: relative; }
        ha-card { padding: 12px 14px 14px; overflow: hidden; }
        .head { display: flex; align-items: center; gap: 10px;
                justify-content: space-between; }
        .htitle { flex: 1; text-align: center; font-size: 19px;
                  font-weight: 600; color: var(--primary-text-color); }
        .hstat { display: flex; align-items: center; gap: 10px; min-width: 40px;
                 justify-content: flex-end; }
        /* The alert badge is the first thing in the head, so it has to hug the
           left edge instead of being pushed right like the signal bars. */
        .hstat.left { justify-content: flex-start; }
        .hstat svg { display: block; }
        /* The reading sits to the right of the bars, small and grey so the
           numbers never compete with the power figures in the drawing. */
        .hsig { display: inline-flex; align-items: center; gap: 6px;
                font-size: 12.5px; color: var(--secondary-text-color);
                font-variant-numeric: tabular-nums; }
        /* Offline: the bars go grey and the text takes the error colour, so the
           head band states the fact instead of just losing its signal meter. */
        .hsig.off .hsig-v { color: var(--error-color, #db4437);
                            font-weight: 600; }
        .wrap { display: flex; justify-content: center;
                /* max_width caps the illustration, and the dashboard column is
                   usually wider than that - without auto margins the leftover
                   space piles up on the right and the unit looks shoved left. */
                margin: 0 auto; }
        .wrap svg { display: block; width: 100%; height: auto; }

        .bat-v { font-size: 24px; font-weight: 600;
                 fill: var(--primary-text-color); }
        .bat-c { font-size: 13px; fill: var(--secondary-text-color); }
        .bat-call-t { font-size: 11px; fill: rgba(255,255,255,0.66); }
        .bat-call-v { font-size: 17.8px; font-weight: 600; fill: #ffffff; }
        .bat-call-temp { font-size: 13.5px; font-weight: 500;
                         fill: rgba(255,255,255,0.82); }
        /* The fan level.  The fan has no caption - it is drawn against the part
           it cools, so the number alone is enough.  Sized between the corner
           figures (24px) and their captions (13px) so the annotation reads as
           belonging to the drawing, not as a corner readout of its own. */
        .bat-fan-l { font-size: 17px; font-weight: 600;
                     fill: var(--primary-text-color); }

        /* The branch flow is one streak of light sent along the connector.  The
           three stops are CSS variables because they depend on the length of the
           branch, which the keyframes cannot know: a custom property inside a
           keyframe is substituted per element, so this is how every path gets
           its own travel distance while all of them share one animation.  The
           72% stop must stay in step with FLOW_TRAVEL.

           The distance is in px, which inside an SVG is user units; a bare
           number is not valid in a CSS declaration, only in a presentation
           attribute. */
        .hm-beam path {
          pointer-events: none;
          animation-name: hm-flow-run;
          animation-timing-function: linear;
          animation-iteration-count: infinite;
        }
        @keyframes hm-flow-run {
          0% { stroke-dashoffset: var(--hm-a, 40px); }
          72% { stroke-dashoffset: var(--hm-b, 0px); }
          100% { stroke-dashoffset: var(--hm-c, -40px); }
        }

        .hist { margin-top: 10px; border-top: 1px solid var(--divider-color);
                padding-top: 10px; }
        .hhead { display: flex; flex-wrap: wrap; gap: 6px 12px;
                 align-items: center; justify-content: space-between; }
        .hlabel { font-size: 15px; font-weight: 600;
                  color: var(--primary-text-color); }
        .pills { display: flex; gap: 4px; }
        .pill { padding: 3px 14px; border-radius: 999px; font-size: 12.5px;
                cursor: pointer; border: 1px solid transparent;
                background: var(--secondary-background-color, rgba(127,127,127,0.12));
                color: var(--secondary-text-color); }
        .pill.on { background: var(--primary-color); color: var(--text-primary-color, #fff);
                   border-color: var(--primary-color); }
        .chart { margin-top: 6px; }
        .chart svg { display: block; width: 100%; height: auto; }
        .soc-axis { font-size: 11px; fill: var(--secondary-text-color); }
        .soc-line { fill: none; stroke: var(--primary-color); stroke-width: 2.2;
                    stroke-linejoin: round; stroke-linecap: round; }
        .soc-last { font-size: 12.5px; font-weight: 600;
                    fill: var(--primary-text-color); }
        .summary { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px;
                   color: var(--secondary-text-color); margin-top: 4px;
                   font-variant-numeric: tabular-nums; }
        .summary b { color: var(--primary-text-color); font-weight: 600; }
        .msg { font-size: 12.5px; color: var(--secondary-text-color);
               padding: 10px 0 2px; }

        /* ================================================================== *
         * Cold-battery banner
         *
         * A heating request is a condition, not a click: it has to be noticed
         * without hunting through the callouts.
         *
         * It floats **at the top of the device page**, in the strip just below the
         * view tabs and over the card's head band - not in the card's flow
         * (pushing the drawing down for minutes is worse than a floating strip)
         * and not fixed to the viewport either (that put it on top of the
         * dashboard header and covered the very view tabs it asks the user to
         * click).  The host element is the device page area, so absolute
         * positioning against it keeps the banner inside it and lets it scroll
         * away with the card.
         *
         * It has no clock - it stays while a pack keeps asking for heat, and only
         * the close button (or the request going away) removes it.  Opaque card
         * colour plus a shadow, because it is drawn over the illustration.
         * ================================================================== */
        .heat-note {
          position: absolute; top: -14px; left: 50%; z-index: 6;
          transform: translateX(-50%);
          display: flex; align-items: center; gap: 10px;
          width: min(470px, calc(100% - 28px));
          padding: 9px 6px 9px 12px; border-radius: 11px;
          background-color: var(--card-background-color, #fff);
          background-image: linear-gradient(
            rgba(125, 211, 252, 0.10), rgba(125, 211, 252, 0.10));
          color: var(--primary-text-color);
          border: 1px solid rgba(125, 211, 252, 0.5);
          border-left: 4px solid #7DD3FC;
          box-shadow: 0 6px 22px rgba(15, 23, 42, 0.18);
          animation: hm-heat-in 0.3s cubic-bezier(0.2, 0.9, 0.3, 1);
        }
        .heat-note .bi { display: inline-flex; flex: 0 0 auto; color: #7DD3FC; }
        .heat-note .bi svg { display: block; }
        .heat-note .bt { font-size: 13px; line-height: 1.45; }
        .heat-note .bx { flex: 0 0 auto; border: none; background: none;
                         color: var(--secondary-text-color); font-size: 17px;
                         line-height: 1; padding: 2px 6px; cursor: pointer; }
        @keyframes hm-heat-in {
          from { opacity: 0; transform: translate(-50%, -12px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-battery: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache.clear();
      if (config.range) this._range = config.range;
      this._history = null;
      this._histFetchedAt = 0;
      // `hass` may already be set when the dashboard is edited in place.
      this._maybeFetchHistory();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (first) this._maybeFetchHistory();
      this.requestUpdate();
    }

    getCardSize() {
      return 12;
    }

    /**
     * Only re-render when something the drawing depends on changed. The device
     * pushes state every second, and the illustration is a few hundred SVG
     * nodes — no reason to rebuild it when the numbers are identical.
     */
    shouldUpdate() {
      if (!this._config || !this._hass) return true;
      const signature = this._signature();
      if (signature === this._signatureCache) return false;
      this._signatureCache = signature;
      return true;
    }

    _signature() {
      const packs = [];
      for (let i = 1; i <= PACK_MAX; i += 1) {
        /* The heating state is part of the per-pack signature: it changes on its
           own (the heater starts while the SOC and temperature stand still), and
           without it here the pill would only appear on the next SOC tick. */
        packs.push(`${this._read(`pack${i}_soc`, null)}:${this._read(`pack${i}_temperature`, null)}`
          + `:${this._readText(`pack${i}_heating_state`)}`);
      }
      const alarms = this._alarms();
      return [
        hmLang(this._hass, this._config),
        this._config.max_width, this._title(),
        this._config.show_title, this._config.alarm_entity, this._range,
        // The PV corner, the PV connector and the SOLAR readout are all part of
        // the drawing, so a card told there is no PV input has to redraw.
        this._hasPv(),
        // The model arrives with the device registry, which can load after the
        // first render, so it has to be part of what triggers a rebuild.
        this._title(),
        // The chassis drawing follows the model as well (the 1920 AC is a wide
        // single box, not a stack), and a custom `title` would hide that, so
        // the model is carried explicitly.
        this._model(),
        this._read("rssi", null), `${alarms.known}:${alarms.count}`,
        // The badge wording follows the language switch, so a language change
        // has to redraw it even while the readings are unchanged.
        this._t("No active alarms", "当前无告警"),
        this._read("pv_power", 0), this._read("grid_on_power", 0),
        this._read("grid_off_power", 0),
        // The head display and the bottom-left readout use the system level
        // values when they exist, so both have to be in the signature or the
        // drawing would go stale while the device is grouped.
        this._read("system_pv_power", null), this._read("system_battery_power", null),
        this._read("bat_power", null),
        this._packCount(), packs.join(","),
        this._readText("battery_status"), this._readText("bat_sts"),
        this._read("soc", null),
        // The fan indicators are part of the drawing, so their levels have to
        // be in the key: a fan that starts or stops has to redraw even though
        // no power reading changed.
        this._fanLevel("pcs_fan_level"), this._fanLevel("battery_fan_level"),
        // The cold-battery banner is not derived from a reading, so its state
        // has to be part of the key - otherwise `requestUpdate()` would be
        // swallowed and the banner would never appear or disappear.
        this._heatNotice ? "notice" : "",
        this._history ? `${this._history.soc.length}:${this._history.charge}:${this._history.discharge}` : "none",
        this._histError || "",
      ].join("\u0001");
    }

    /* ----------------------------- lookup ----------------------------- */

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
     * The device the card is looking at, from the device registry.
     *
     * `dev_id` is the integration/DNS identifier the firmware publishes, which
     * is exactly what the device's `identifiers` carry, so no entity lookup is
     * needed.  A device may be registered more than once (the MQTT discovery
     * device and the integration's own), and only some of those entries know
     * the model, so prefer whichever one has it.
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
      if (fallback) return fallback;

      // No identifier matched (renamed by hand, unusual setup): fall back to
      // the device one of our own entities belongs to.
      const entityId = this._resolveEntity("soc") || this._resolveEntity("bat_power");
      const entry = entityId && hass.entities ? hass.entities[entityId] : null;
      return entry && entry.device_id ? (hass.devices[entry.device_id] || null) : null;
    }

    /** Model as reported by the device ("HiBattery 4020 X"), or null. */
    _model() {
      const device = this._device();
      return device && device.model ? String(device.model) : null;
    }

    /**
     * Whether this unit has a PV input at all.
     *
     * `show_pv: false` in the config is what the generated dashboard sends for
     * an **AC coupled** model (HiBattery 4020 AC): that unit has no MPPT port,
     * yet the firmware still publishes every PV topic as a hard 0, so the card
     * cannot tell from the data.  The model lives in the device registry, which
     * the dashboard generator reads - see ``const.MODELS_WITHOUT_PV``.
     *
     * The portrait MS-A2 cabinet has no PV input either, and a card configured
     * by hand has no `show_pv` key at all, so the chassis decides in that case:
     * an explicit `show_pv` still wins, but the MS-A2 does not need to be told.
     */
    _hasPv() {
      const configured = (this._config || {}).show_pv;
      if (configured !== undefined) return configured !== false;
      return this._chassis() !== "msa2";
    }

    /**
     * Which chassis drawing this unit needs.
     *
     *   "msa2"  the portrait MS-A2 cabinet - photo, vertical level strip,
     *           percentage printed on the body;
     *   "flat"  the wide 1920 AC - photo, level bar on its own screen;
     *   "stack" everything else: a head module plus battery modules.
     *
     * Matched on the model with punctuation removed, so "MS-A2", "MSA2" and
     * "HiBattery MS-A2" all land on the same chassis.  The model is the only
     * reliable source: the entity names differ per firmware, the cabinet does
     * not.
     */
    _chassis() {
      const model = this._model();
      if (!model) return "stack";
      const raw = String(model).trim().toLowerCase();
      const key = raw.replace(/[\s_-]+/g, "");
      if (key === "msa2" || key === "hibatterymsa2") return "msa2";
      if (FLAT_CHASSIS.includes(raw)) return "flat";
      return "stack";
    }

    /**
     * Header title: explicit config wins, then what the device says it is, and
     * only then a generic placeholder — a hard-coded name goes stale as soon as
     * the hardware changes.
     */
    _title() {
      const configured = this._text(this._config && this._config.title);
      if (typeof configured === "string" && configured) return configured;
      return this._model() || "HiBattery X";
    }

    _showTitle() {
      const config = this._config || {};
      return config.show_title !== false && config.title !== false;
    }

    _resolveEntity(suffix, domain = "sensor") {
      const found = this._resolveExact(suffix, domain);
      if (found) return found;
      for (const alias of (SUFFIX_ALIASES[suffix] || [])) {
        const alt = this._resolveExact(alias, domain);
        if (alt) return alt;
      }
      return null;
    }

    _resolveExact(suffix, domain = "sensor") {
      const overrides = (this._config.entities || {});
      if (overrides[suffix]) return overrides[suffix];

      const hass = this._hass;
      if (!hass || !hass.states) return null;

      const cacheKey = `${domain}:${suffix}`;
      const cached = this._cache.get(cacheKey);
      if (cached && hass.states[cached]) return cached;

      const dev = slug(this._dev());
      const conventional = `${domain}.${dev}_${suffix}`;
      let found = hass.states[conventional] ? conventional : null;

      if (!found) {
        // Normalized exact match on the part after `<domain>.<dev>_`, so both
        // `pack1_soc` and the slugified `pack_1_soc` resolve.
        const prefix = `${domain}.${dev}`;
        const wanted = norm(suffix);
        for (const entityId of Object.keys(hass.states)) {
          if (!entityId.startsWith(prefix)) continue;
          if (norm(entityId.slice(prefix.length + 1)) !== wanted) continue;
          if (!found || entityId.length < found.length) found = entityId;
        }
      }

      if (!found) {
        // A renamed device keeps all of its entities but changes their entity
        // ids: renaming the device to "G3" turns `sensor.msa_2805..._pv_power`
        // into `sensor.g3_msa_2805..._pv_power`, which defeats both the
        // conventional name and the prefix match above.  The serial is still in
        // the id, so match on "serial, then exactly the suffix" - an exact tail
        // comparison, because a loose `endsWith` would confuse `pv_power` with
        // `system_pv_power`.
        const serial = String(this._dev() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const wanted = norm(suffix);
        if (serial) {
          for (const entityId of Object.keys(hass.states)) {
            if (!entityId.startsWith(`${domain}.`)) continue;
            const normed = norm(entityId);
            const at = normed.indexOf(serial);
            if (at < 0) continue;
            if (normed.slice(at + serial.length) !== wanted) continue;
            if (!found || entityId.length < found.length) found = entityId;
          }
        }
      }

      if (!found && hass.entities) {
        const uniqueSuffix = `hoymiles_${this._dev()}_${suffix}`;
        for (const [entityId, entry] of Object.entries(hass.entities)) {
          // The registry keeps entries for entities a platform no longer creates
          // (a renamed or removed entity); those have no state, and picking one
          // would hide the live replacement.
          if (entry && entry.unique_id === uniqueSuffix && hass.states[entityId]) {
            found = entityId;
            break;
          }
        }
      }

      if (found) this._cache.set(cacheKey, found);
      return found;
    }

    _stateOf(suffix, domain = "sensor") {
      const entityId = this._resolveEntity(suffix, domain);
      if (!entityId || !this._hass) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const value = String(state.state);
      if (value === "" || value === "unavailable" || value === "unknown") return null;
      return state;
    }

    _read(suffix, fallback = 0, domain = "sensor") {
      const state = this._stateOf(suffix, domain);
      if (!state) return fallback;
      const value = Number(state.state);
      return Number.isFinite(value) ? value : fallback;
    }

    _readText(suffix) {
      const state = this._stateOf(suffix);
      return state ? String(state.state) : "";
    }

    /**
     * The first suffix that actually **has a value**, in priority order.
     *
     * A **slave** publishes none of the `sys_*` fields of `quick/state`: the
     * system level readings belong to the master, so the entities this
     * integration creates for them exist but stay `unknown` for ever.  Picking
     * the source by "does the entity exist" therefore locked the drawing to the
     * fallback - `_read()` on an unknown entity returns its fallback, and the
     * device level `bat_p` / `pv_p` was never consulted.  The symptom was a
     * slave that charged at 1001 W while the diagram said "0.0 W".
     *
     * `_stateOf()` already answers `null` for `unknown` / `unavailable`, so the
     * first non-null reading is the first one that is real.  A genuine `0` is a
     * value like any other and stops the search, which is what a master at rest
     * needs.
     */
    _firstRead(suffixes, fallback = 0) {
      for (const suffix of suffixes) {
        const value = this._read(suffix, null);
        if (value !== null) return value;
      }
      return fallback;
    }

    /**
     * Is the device itself offline?
     *
     * Same rule as the control card: the integration marks the fast topics'
     * entities `unavailable` once nothing has arrived for a minute, and a fresh
     * Home Assistant shows `unknown` until the first payload lands.  The first
     * entity that exists decides - a *missing* entity (older firmware) is not
     * an offline device.
     */
    _deviceOffline() {
      if (!this._hass) return false;
      for (const suffix of ["soc", "system_pv_power", "pv_power", "battery_status"]) {
        const entityId = this._resolveEntity(suffix, "sensor");
        if (!entityId) continue;
        const state = (this._hass.states || {})[entityId];
        if (!state) continue;
        return state.state === "unavailable" || state.state === "unknown";
      }
      return false;
    }

    /* ---------------------------- the data ---------------------------- */

    /**
     * How many battery modules to draw.
     *
     * `pack_count` is authoritative, but it is a diagnostic entity and may be
     * hidden or missing on older firmware, so the count of packs that actually
     * report a SOC is used as a cross-check (and as the fallback).
     */
    _packCount() {
      let reported = 0;
      for (let i = 1; i <= PACK_MAX; i += 1) {
        if (this._stateOf(`pack${i}_soc`)) reported = i;
      }

      const declared = Math.round(this._read("pack_count", 0));
      const count = declared > 0 ? declared : reported;
      return Math.max(1, Math.min(count, PACK_MAX));
    }

    /**
     * The level a fan is actually running at, or `null` when the drawing must
     * leave it out.
     *
     * `fan_actual` (§32) reports 0..10 and uses **255** for "not fitted / not
     * enabled".  Anything outside the documented range therefore means "no
     * indicator", not "a very fast fan" - and a missing entity (older firmware,
     * or a model without fans) reads as `null` for the same reason.
     */
    _fanLevel(suffix) {
      const value = this._read(suffix, null);
      if (value === null) return null;
      const level = Math.round(value);
      return level >= 0 && level <= FAN_LEVEL_MAX ? level : null;
    }

    _batteryStatus(battery) {
      const raw = (this._readText("battery_status") || this._readText("bat_sts"))
        .toLowerCase();
      let key = raw;
      if (!STATUS[key]) {
        if (Math.abs(battery) < 5) key = "standby";
        else key = battery < 0 ? "charge" : "discharge";
      }
      const entry = STATUS[key] || STATUS.standby;
      return { key, cls: entry.cls, text: this._t(entry.en, entry.zh) };
    }

    /* ----------------------------- render ----------------------------- */

    render() {
      if (!this._config) return html``;

      /* The system level reading wins **when it has a value** - a master reports
         `sys_bat_p` / `sys_pv_p`, while a slave reports only its own `bat_p` /
         `pv_p` and leaves the `sys_*` entities at `unknown`.  Testing "does the
         entity exist" instead froze a charging slave at 0.0 W, because the
         entity does exist there and simply never gets a value.

         **The battery reading is device level first, though.**  This drawing
         depicts *this unit*, and the corner callout prints `bat_sts` - also this
         unit's own state - right next to the number.  Taking the system total
         there made a master that was merely standing by read "365 W ·
         battery standby": the 365 W was its slave charging, while the caption
         came from the master's own `bat_sts`.  `sys_bat_p` is only the safety
         net, for a firmware that does not publish the device level field. */
      let battery = this._firstRead(["bat_power", "system_battery_power"], 0);
      let pv = this._firstRead(["system_pv_power", "pv_power"], 0);

      const gridOn = this._read("grid_on_power", 0);
      const gridOff = this._read("grid_off_power", 0);
      const status = this._batteryStatus(battery);

      const count = this._packCount();
      /* A one-pack unit has nothing to be numbered against: "Battery 1" there
         implies a second pack that does not exist, so the callout just says
         "Battery".  With two or more the number is what tells them apart. */
      const packName = (i) => (count === 1
        ? this._t("Battery", "电池")
        : `${this._t("Battery", "电池")} ${i + 1}`);
      const packs = [];
      for (let i = 0; i < PACK_MAX; i += 1) {
        /* §32 `packs[].heat`: idle / heating / chg_req / dchg_req.  Read as text
           because it is an enum, not a number; an unavailable entity reads as
           "" and simply leaves the callout as it was. */
        const heat = (this._readText(`pack${i + 1}_heating_state`) || "").toLowerCase();
        const kind = HEAT_KINDS[heat] || null;
        packs.push({
          label: packName(i),
          soc: this._read(`pack${i + 1}_soc`, null),
          temp: this._read(`pack${i + 1}_temperature`, null),
          heat,
          /* The pill is built by a plain function outside the class, so the two
             strings it shows have to be resolved here, where `_t` exists. */
          heatText: kind ? this._t(kind.en, kind.zh) : "",
          heatHint: kind ? this._t(kind.whyEn, kind.whyZh) : "",
        });
      }
      const batteryCaption = this._t("Battery ", "电池") + status.text;
      // The head's status display shows the device level SOC (1 s), the same
      // reading the power flow card and the SOC gauges use, plus this unit's
      // own PV and battery power.
      const soc = this._read("soc", null);
      const pvDev = this._read("pv_power", 0);
      const batDev = this._read("bat_power", 0);

      /* Fan speeds (§32 `fan_actual`).  `null` means "do not draw one": the
         level is out of 0..10, which is how the firmware says the fan is not
         fitted or not enabled (255). */
      const fans = {
        pcs: this._fanLevel("pcs_fan_level"),
        bat: this._fanLevel("battery_fan_level"),
        pcsCaption: this._t("PCS fan", "PCS 风扇"),
        batCaption: this._t("Battery fan", "电池风扇"),
      };

      return html`
        ${this._heatNoticeMarkup()}
        <ha-card>
          <div class="head">
            <div class="hstat left">${this._untrusted(this._alarmBadge())}</div>
            ${this._showTitle()
              ? html`<div class="htitle">${esc(this._title())}</div>`
              : html`<div class="htitle"></div>`}
            <div class="hstat">${this._untrusted(this._signal())}</div>
          </div>
          <div class="wrap" style=${this._wrapStyle()}>
            ${this._untrusted(this._svg({
              count, packs, pv, gridOn, gridOff, battery, status, batteryCaption,
              soc, pvDev, batDev, fans,
            }))}
          </div>
          ${this._config.show_history === false ? "" : this._historySection()}
        </ha-card>
      `;
    }

    _wrapStyle() {
      const width = num(this._config.max_width);
      return width > 0 ? `max-width:${width}px` : "max-width:560px";
    }

    /**
     * The alarm state, as the device reports it.
     *
     * `known: false` means nothing was ever published - firmware before V0.6.2
     * has no alarm topic at all, and this card draws nothing in that case.  A
     * green tick would be a claim it cannot back up; a red triangle would be a
     * false alarm.
     */
    _alarms() {
      const configured = this._config && this._config.alarm_entity;
      if (configured && this._hass) {
        const state = (this._hass.states || {})[configured];
        if (state) {
          return {
            known: state.state !== "unavailable",
            count: state.state === "on" ? 1 : 0,
          };
        }
      }
      const entityId = this._resolveEntity("active_alarms");
      const state = entityId && this._hass ? (this._hass.states || {})[entityId] : null;
      const items = state && state.attributes && state.attributes.alarms;
      if (!Array.isArray(items)) return { known: false, count: 0 };
      return { known: true, count: items.length };
    }

    /**
     * The head-band badge: a red triangle while alarms are active, a green
     * circle with a tick when the device reports none, nothing when it never
     * says.  Built as markup because `_untrusted()` injects it - a lit template
     * cannot create `<path>` nodes inside an inline `<svg>`.
     */
    _alarmBadge() {
      const alarms = this._alarms();
      if (!alarms.known) return "";

      if (alarms.count > 0) {
        const title = esc(`${alarms.count} · ${this._t("Active alarms", "当前告警")}`);
        // The stroke is the same colour as the fill and exists only to round
        // the three corners; a plain path has needle-sharp ones.
        return `<svg width="22" height="22" viewBox="0 0 22 22" role="img"`
          + ` aria-label="${title}"><title>${title}</title>`
          + `<path d="M11 3.1 20 18.6H2Z" fill="var(--error-color, #db4437)"`
          + ` stroke="var(--error-color, #db4437)" stroke-width="2.6"`
          + ` stroke-linejoin="round"/>`
          + `<rect x="10.05" y="8.2" width="1.9" height="5.2" rx="0.95" fill="#ffffff"/>`
          + `<circle cx="11" cy="15.6" r="1.1" fill="#ffffff"/></svg>`;
      }

      const title = esc(this._t("No active alarms", "当前无告警"));
      return `<svg width="22" height="22" viewBox="0 0 22 22" role="img"`
        + ` aria-label="${title}"><title>${title}</title>`
        + `<circle cx="11" cy="11" r="8.6" fill="none" stroke="#2f9e63" stroke-width="2"/>`
        + `<path d="M7 11.3 9.9 14.2 15.1 8.3" fill="none" stroke="#2f9e63"`
        + ` stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }

    /**
     * Wi-Fi signal: four bars plus the raw reading, the way a phone shows it.
     *
     * Returns "" when the device reports no `rssi` at all (older firmware, or a
     * unit that is not connected), so the head band is never decorated with a
     * meaningless 0 dBm.
     */
    _signal() {
      /* An offline unit reports no `rssi` at all, so the head band would be
         empty exactly when the user is wondering what happened.  Say it there
         instead - this card is the only "device" view a slave has, and a slave
         is the unit most likely to drop off without anything else changing. */
      if (this._deviceOffline()) {
        const title = esc(this._t("The device is offline", "设备离线"));
        return `<span class="hsig off" title="${title}">`
          + `${this._signalBars(0)}<span class="hsig-v">${this._t("Offline", "离线")}</span></span>`;
      }
      const rssi = this._read("rssi", null);
      if (rssi === null) return "";

      const bars = rssiBars(rssi);
      const quality = bars === 4 ? this._t("Excellent", "优秀")
        : bars === 3 ? this._t("Good", "良好")
          : bars === 2 ? this._t("Fair", "一般")
            : bars === 1 ? this._t("Weak", "较弱")
              : this._t("No signal", "无信号");
      const dbm = `${rssi.toFixed(0)} dBm`;
      const title = esc(`${this._t("Wi-Fi signal", "Wi-Fi 信号")}: ${quality} · ${dbm}`);

      return `<span class="hsig" title="${title}">`
        + `${this._signalBars(bars)}<span class="hsig-v">${dbm}</span></span>`;
    }

    /** The four bars; geometry matches what the header has always drawn. */
    _signalBars(bars) {
      const color = bars === 0
        ? "var(--disabled-text-color, #b6bcc4)"
        : "var(--primary-color)";
      let out = `<svg width="22" height="18" viewBox="0 0 22 18" aria-hidden="true">`;
      for (let i = 0; i < 4; i += 1) {
        const h = 4 + i * 3.4;
        out += `<rect x="${1 + i * 5}" y="${16 - h}" width="3.4" height="${h}" rx="1.4"`
          + ` fill="${i < bars ? color : "var(--divider-color, #dcdfe4)"}"/>`;
      }
      return `${out}</svg>`;
    }

    /* --------------------------- the diagram --------------------------- */

    _svg(d) {
      // The head shows this unit's own readings, the corner callouts the system
      // level ones - the panel draws the device itself, not the whole system.
      //
      // `_hasPv()` is false on an AC coupled model: the unit has no PV input, so
      // its sun corner, its PV readout and its PV connector are all left out
      // instead of showing a port that can only ever read 0 W.
      const hasPv = this._hasPv();
      // A photo chassis is a different product - one 1920 AC box, or the
      // portrait MS-A2 cabinet - so each gets its own drawing, with the state
      // of charge on the unit itself.  See `flatMarkup` / `msa2Markup`.
      const chassis = this._chassis();
      const { markup, bodyTop, bottom } = chassis === "msa2"
        ? msa2Markup(d.packs, d.soc, d.fans)
        : chassis === "flat"
          ? flatMarkup(d.packs, d.soc, d.fans)
          : stackMarkup(d.count, d.packs, d.soc, d.pvDev, d.batDev, d.fans, hasPv);
      const bottomY = bottom + HEADER_GAP;
      const totalH = bottomY + TAIL_GAP;

      /* Only the gradients the chassis in use references.  Both are painted in
         `userSpaceOnUse` coordinates taken from the body the caller just built,
         so the fall-off follows the real height instead of a hard-coded 0..1.
         The photo chassis are transparent outside the moulding, so the only
         thing left to paint is the level bar - horizontal on the 1920 AC,
         vertical on the MS-A2. */
      const defs = chassis === "msa2"
        ? `
          <linearGradient id="hm-msa2-bar-fill" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stop-color="#22c55e"/>
            <stop offset="1" stop-color="#4ade80"/>
          </linearGradient>`
        : chassis === "flat"
          ? `
          <linearGradient id="hm-flat-bar-fill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#4ade80"/>
            <stop offset="1" stop-color="#22c55e"/>
          </linearGradient>`
          : `
          <linearGradient id="hm-bat-top" x1="0" y1="0" x2="0.25" y2="1">
            <stop offset="0" stop-color="#333a42"/>
            <stop offset="1" stop-color="#14181c"/>
          </linearGradient>
          <linearGradient id="hm-bat-body" x1="0" y1="${bodyTop}" x2="0" y2="${bottom}"
              gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#d2d7dc"/>
            <stop offset="0.32" stop-color="#bcc2c9"/>
            <stop offset="0.58" stop-color="#949ba3"/>
            <stop offset="0.82" stop-color="#4a5058"/>
            <stop offset="1" stop-color="#16181b"/>
          </linearGradient>`;

      return `<svg viewBox="0 0 ${VB_W} ${totalH}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        <defs>${defs}</defs>
        ${this._flowPaths(d, bottom, bottomY)}
        ${markup}
        ${hasPv ? this._row(30, 62, "sun", fmtW(d.pv), this._t("PV", "光伏"), "start") : ""}
        ${this._row(VB_W - 30, VB_W - 58, "socket", fmtW(d.gridOn),
          this._t("Grid port", "并网端口"), "end")}
        ${this._row(30, 62, `status:${d.status.key}`, fmtW(d.battery),
          d.batteryCaption, "start", bottomY)}
        ${this._row(VB_W - 24, VB_W - 58, "dot", fmtW(d.gridOff),
          this._t("Off-grid port", "离网端口"), "end", bottomY)}
      </svg>`;
    }

    /**
     * The three branch connectors, and the flow that runs along them.
     *
     * Only PV, the on-grid port and the off-grid port get one.  The battery
     * lives inside the unit, so its corner is a readout rather than a port -
     * a line there would suggest energy leaving the box, which it does not.
     *
     * Every branch is drawn once in its own grey, and a branch that carries
     * power gets one streak of light sent along it: a white head with a tail
     * that fades out behind it.  The streak is a CSS animation, so the flow keeps
     * running across a detach / re-attach of the card; the phase it has already
     * reached is carried in `_flowPhase` and handed to the new elements through a
     * negative `animation-delay`, which is why a rebuild (about once a second)
     * does not restart it.  The path is written corner first, unit last, so
     * `into` decides the direction rather than the geometry.
     *
     * These are emitted *before* the unit in `_svg`, so the housing paints over
     * them.  Each connector therefore runs `BURY` units past the face it plugs
     * into: the tail disappears behind the body and the line reads as going
     * under the housing.  Drawn the other way round, the round line cap sat on
     * top of the dark head and the connection looked like it floated above the
     * device instead of entering it.
     */
    _flowPaths(d, bottom, bottomY) {
      // The photo chassis are narrower / wider than the stack, so the branch
      // connectors end at whatever the drawing's right face is.  The MS-A2 is a
      // portrait cabinet, so its two right-hand ports also plug in much lower:
      // its AC socket sits on the angled side face, not under the top edge.
      const chassis = this._chassis();
      const headRight = chassis === "msa2" ? FRONT_X + MSA2_W
        : chassis === "flat" ? FRONT_X + FLAT_W
          : FRONT_X + FRONT_W;
      const acY = chassis === "msa2" ? MSA2_AC_Y : 108;
      const portX = VB_W - 30;               // 590, shared by both right ports
      const topY = 60;                       // just under the top readouts
      const BURY = 12;                       // how far a connector hides in the body

      // The off-grid line always leaves the head 12 units below the on-grid
      // line, so the two right hand ports read as one column split in two -
      // with a deliberate gap, because they are different ports.
      //
      // It used to duck below the lowest right hand callout instead, which
      // meant that with more than one pack the line started halfway down the
      // body instead of at the PCS.  The callouts are now inset from the right
      // edge (RIGHT_BOX_X) so the vertical at `portX` runs past them, and the
      // branch can stay where it belongs whatever the pack count is.
      const offY = chassis === "msa2" ? MSA2_OFF_Y : 120;

      // An AC coupled model has no PV input, so there is no connector to draw.
      // Everything else keeps its geometry: the remaining branches are anchored
      // to fixed coordinates, not to the list length.
      const branches = [];
      if (this._hasPv()) {
        branches.push({
          key: "pv",
          // down from the sun, then right, behind the head's left face
          path: `M30 ${topY} L30 112 L${FRONT_X + BURY} 112`,
          value: d.pv,
          // PV can only ever feed the unit
          intoWhenPositive: true,
        });
      }
      branches.push(
        {
          key: "gridOn",
          // down from the socket, then left, behind the head's right face
          path: `M${portX} ${topY} L${portX} ${acY} L${headRight - BURY} ${acY}`,
          value: d.gridOn,
          // positive: the port is delivering to the load / grid
          intoWhenPositive: false,
        },
        {
          key: "gridOff",
          // from behind the head, right, then straight down to its own dot.  The
          // vertical shares the grid port's x so the two read as one column,
          // with a deliberate gap between them: they are different ports.
          path: `M${headRight - BURY} ${offY} L${portX} ${offY}`
            + ` L${portX} ${bottomY - 33}`,
          value: d.gridOff,
          // positive: the backup port is feeding its load
          intoWhenPositive: false,
        },
      );

      /* How far each streak has got, 0..1 of one trip.  Advanced here because
         the speed depends on the power, which is only known while the branches
         are being built; the CSS animation carries it from this phase to the
         phase of the next render. */
      const now = (typeof performance !== "undefined"
        && typeof performance.now === "function")
        ? performance.now()
        : Date.now();
      const last = this._flowClock || now;
      this._flowClock = now;
      const dt = Math.min(Math.max((now - last) / 1000, 0), 5);

      return branches
        .map(({ key, path, value, intoWhenPositive }) => {
          const base = `<path d="${path}" fill="none" stroke="#cfd4da"
            stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
          const magnitude = Math.abs(num(value));
          if (magnitude < FLOW_IDLE_W) return base;

          const into = value > 0 === intoWhenPositive;
          /* Travel along the geometry in its own direction instead of animating
             the original path backwards; see `reversePoly`. */
          const travel = into ? path : reversePoly(path);
          const len = pathLen(travel);
          if (!(len > 0)) return base;

          /* `flowSpeed` is the speed while travelling; a trip also has to get
             off the far end, and the cycle ends with a short pause. */
          const speed = FLOW_SPEED_MIN
            + Math.min(1, magnitude / FLOW_SPEED_FULL_W) * FLOW_SPEED_RANGE;
          const duration = clampNum(len / (speed * FLOW_TRAVEL), 0.8, 10);
          const known = this._flowPhase.get(key);
          const phase = dt > 0 && Number.isFinite(known)
            ? (known + dt / duration) % 1
            : (Number.isFinite(known) ? known : 0);
          this._flowPhase.set(key, phase);

          const streak = clampNum(len * FLOW_SHARE, FLOW_MIN, Math.min(FLOW_MAX, len));
          const delay = (-phase * duration).toFixed(2);
          const slice = streak / FLOW_SLICES;
          /* Wide enough that the pattern cannot repeat on the branch: exactly
             one streak is ever on the wire. */
          const gap = 2 * len + slice;

          /* A run of slices with a colour and an opacity each - that is what
             makes the fade smooth.  Slice `i` sits `i * slice` further back than
             the head, and because the geometry has already been turned to face
             the direction of travel, "back" is simply a larger offset for both
             directions: `dashoffset = size - front`. */
          let band = "";
          for (let i = 0; i < FLOW_SLICES; i += 1) {
            /* 0 at the head, 1 at the tail. */
            const t = i / (FLOW_SLICES - 1);
            const shift = i * slice;
            const vars = `--hm-a:${(slice + shift).toFixed(2)}px;`
              + `--hm-b:${(slice - len + shift).toFixed(2)}px;`
              + `--hm-c:${(slice - len - streak + shift).toFixed(2)}px;`;
            const width = (FLOW_WIDTH - (FLOW_WIDTH - FLOW_TIP) * t).toFixed(2);
            const opacity = (1 - 0.94 * t).toFixed(3);
            const colour = mixHex("#ffffff", FLOW_COLOR, Math.min(1, t * 1.7));
            band += `<path d="${travel}" fill="none" stroke="${colour}"
              stroke-width="${width}" stroke-opacity="${opacity}"
              stroke-linecap="${i === 0 ? "round" : "butt"}"
              stroke-linejoin="round"
              stroke-dasharray="${slice.toFixed(2)} ${gap.toFixed(2)}"
              style="${vars}`
              + `animation-duration:${duration.toFixed(2)}s;`
              + `animation-delay:${delay}s"/>`;
          }

          return `${base}<g class="hm-beam">${band}</g>`;
        })
        .join("");
    }

    /**
     * The battery corner icon, which doubles as the state indicator.
     *
     * One fixed drawing would leave the animation with nothing to say, so the
     * glyph follows the state the way the vendor app does: a battery whose
     * segments fill one after another while charging, the two-arrow cycle
     * while discharging, and a muted hourglass while idle.
     *
     * The moving parts are animated by `_flowTick` rather than CSS, because the
     * illustration is rebuilt whenever a reading changes - a CSS animation
     * would restart every second.
     */
    _statusGlyph(iconX, y, key) {
      // The three drawings share one optical size: a battery 30 wide, the
      // arrow ring 28 across, the hourglass 26.  All of them are centred on
      // the readout's power figure, which is 24px tall.
      const cx = iconX + 1;
      const cy = y - 30;

      if (key === "charge") {
        const bx = cx - 15;
        const by = cy - 9;
        const bars = [0, 1, 2].map((i) => `<rect data-hm-pulse="${i}"
            x="${(bx + 1.5 + i * 8.5).toFixed(1)}" y="${cy - 6}"
            width="6" height="12" rx="1.5" fill="${CHARGE_COLOR}"/>`).join("");
        return `<rect x="${bx}" y="${by}" width="26" height="18" rx="4"
            fill="none" stroke="${CHARGE_COLOR}" stroke-width="2.2"/>
          <rect x="${(bx + 26.5).toFixed(1)}" y="${cy - 4}" width="4.2"
            height="8" rx="1.6" fill="${CHARGE_COLOR}"/>
          ${bars}`;
      }

      if (key === "discharge") {
        /* The ring spins clockwise (`_flowTick` adds to the angle), so the
           arrow heads have to point clockwise or the graphic argues with its
           own motion. Material's "sync" is drawn the other way round - its heads
           point anticlockwise - so the glyph is mirrored inside the spinning
           group. Mirroring only the drawing leaves the rotation untouched: the
           mirror sits INSIDE `rotate()`, so it flips the arrows without
           reversing the spin. */
        return `<g data-hm-spin="1" data-cx="${cx}" data-cy="${cy}"
            transform="rotate(0 ${cx} ${cy})">
            <g transform="translate(${cx} ${cy}) scale(-1 1) translate(${-cx} ${-cy})">
              <g transform="translate(${(cx - 14).toFixed(1)} ${(cy - 14).toFixed(1)}) scale(${(28 / 24).toFixed(4)})">
                <path fill="${DISCHARGE_COLOR}" d="${SYNC_PATH}"/>
                <circle cx="12" cy="12" r="2.8" fill="${DISCHARGE_COLOR}"/>
              </g>
            </g>
          </g>`;
      }

      // standby / locked
      return `<g opacity="0.55">
          <g transform="translate(${(cx - 13).toFixed(1)} ${(cy - 13).toFixed(1)}) scale(${(26 / 24).toFixed(4)})">
            <path fill="${IDLE_COLOR}" d="${HOURGLASS_PATH}"/>
          </g>
        </g>`;
    }

    /**
     * One of the flat corner icons, scaled and centred on a readout.
     *
     * The optical centre is (`iconX` + 1, `y` - 30) - the same point the
     * battery-status glyphs and the 24 px figure are centred on, so a corner
     * never sits off the line of its own number.  The old socket was drawn
     * 16 units lower than the status glyphs, which is why it looked like it
     * was floating above the caption.
     */
    _cornerGlyph(iconX, y, key, size) {
      const build = CORNER_GLYPH[key];
      if (!build) return "";
      const s = size / 24;
      const x = (iconX + 1 - 12 * s).toFixed(2);
      const yy = (y - 30 + (CORNER_DY[key] || 0) - 12 * s).toFixed(2);
      return `<g transform="translate(${x} ${yy}) scale(${s.toFixed(4)})">`
        + build(CORNER_COLORS[key] || "#46505c") + `</g>`;
    }

    /**
     * One corner readout: icon, power value and caption.
     * `anchor` is "start" (icon on the left) or "end" (icon on the right).
     */
    _row(iconX, textX, icon, value, caption, anchor, y = 46) {
      let glyph;
      if (icon.startsWith("status:")) {
        glyph = this._statusGlyph(iconX, y, icon.slice(7));
      } else if (icon in CORNER_GLYPH) {
        glyph = this._cornerGlyph(iconX, y, icon, CORNER_SIZE[icon]);
      } else if (icon === "dot") {
        glyph = `<circle cx="${iconX - 6}" cy="${y - 27}" r="5.5" fill="#f5a623"/>`;
      } else {
        glyph = `<text x="${iconX - 12}" y="${y - 22}" font-size="20">${icon}</text>`;
      }
      return `${glyph}
        <text class="bat-v" x="${textX}" y="${y - 22}" text-anchor="${anchor}">${value}</text>
        <text class="bat-c" x="${textX}" y="${y}" text-anchor="${anchor}">${esc(caption)}</text>`;
    }

    /* -------------------------- history section -------------------------- */

    _historySection() {
      const pills = RANGES.map((r) => `
        <button class="pill ${r.id === this._range ? "on" : ""}"
                data-range="${r.id}">${esc(this._t(r.en, r.zh))}</button>`).join("");

      let body;
      if (this._histError) {
        body = html`<div class="msg">${esc(this._histError)}</div>`;
      } else if (!this._history) {
        body = html`<div class="msg">${this._t("Loading…", "加载中…")}</div>`;
      } else if (!this._history.soc.length) {
        body = html`<div class="msg">${this._t(
          "No statistics recorded for this range (the recorder must be enabled).",
          "该时间段没有统计数据（需要启用 recorder）。",
        )}</div>`;
      } else {
        body = html`
          ${this._untrusted(this._socChart(this._history.soc))}
          <div class="summary">
            <span>${this._t("Charged", "充电")} <b>${fmtEnergy(this._history.charge)}</b></span>
            <span>${this._t("Discharged", "放电")} <b>${fmtEnergy(this._history.discharge)}</b></span>
            <span>${this._t("Packs", "电池数量")} <b>${this._packCount()}</b></span>
          </div>`;
      }

      return html`
        <div class="hist">
          <div class="hhead">
            <div class="hlabel">${this._t("History", "历史数据")}</div>
            <div class="pills">${this._untrusted(pills)}</div>
          </div>
          ${body}
        </div>`;
    }

    _socChart(points) {
      const W = VB_W;
      const H = 150;
      const L = 34;
      const R = W - 14;
      const T = 12;
      const B = H - 24;

      const xs = (i) => L + (R - L) * (points.length === 1 ? 0.5 : i / (points.length - 1));
      const ys = (v) => B - (B - T) * (Math.max(0, Math.min(100, v)) / 100);

      const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${xs(i).toFixed(1)} ${ys(p).toFixed(1)}`).join(" ");
      const area = `${line} L${xs(points.length - 1).toFixed(1)} ${B} L${xs(0).toFixed(1)} ${B} Z`;

      let grid = "";
      for (const v of [0, 25, 50, 75, 100]) {
        grid += `<line x1="${L}" y1="${ys(v).toFixed(1)}" x2="${R}" y2="${ys(v).toFixed(1)}"
          stroke="var(--divider-color)" stroke-width="1" stroke-dasharray="3 4"/>
        <text class="soc-axis" x="${L - 6}" y="${(ys(v) + 4).toFixed(1)}"
          text-anchor="end">${v}</text>`;
      }

      const last = points[points.length - 1];
      const lastX = xs(points.length - 1);
      const lastY = ys(last);

      return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        <defs>
          <linearGradient id="hm-bat-areafill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="var(--primary-color)" stop-opacity="0.32"/>
            <stop offset="1" stop-color="var(--primary-color)" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#hm-bat-areafill)" stroke="none"/>
        <path class="soc-line" d="${line}" fill="none"/>
        <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4"
          fill="var(--primary-color)" stroke="#fff" stroke-width="1.6"/>
        <text class="soc-last" x="${Math.min(lastX + 8, R).toFixed(1)}"
          y="${Math.max(lastY - 8, T + 12).toFixed(1)}"
          text-anchor="${lastX > R - 60 ? "end" : "start"}">${last.toFixed(2)}%</text>
      </svg>`;
    }

    /* ---------------------------- statistics ---------------------------- */

    _rangeDef() {
      return RANGES.find((r) => r.id === this._range) || RANGES[0];
    }

    _maybeFetchHistory() {
      if (!this._hass || !this._config) return;
      if (this._config.show_history === false) return;
      if (this._history && Date.now() - this._histFetchedAt < HIST_TTL_MS) return;
      this._fetchHistory();
    }

    async _fetchHistory() {
      if (!this._hass || !this._config) return;
      if (typeof this._hass.callWS !== "function") return;

      // Same as the power flow card: the device level `soc` (1 s, average of
      // this unit's packs) keeps every SOC on the dashboard consistent.
      const socEntity = this._resolveEntity("soc") || this._resolveEntity("system_soc");
      const chgEntity = this._resolveEntity("battery_charge_energy_today");
      const dchgEntity = this._resolveEntity("battery_discharge_energy_today");
      const ids = [socEntity, chgEntity, dchgEntity].filter(Boolean);

      if (!ids.length) {
        this._histError = this._t(
          "No statistics source found for this device.",
          "未找到该设备的统计数据源。",
        );
        return;
      }

      const def = this._rangeDef();
      const token = ++this._histToken;
      this._histLoading = true;
      this._histError = null;

      const end = new Date();
      const start = def.id === "year"
        ? new Date(end.getFullYear(), 0, 1)
        : dayStart(end, def.days - 1);

      try {
        const result = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          statistic_ids: ids,
          period: def.period,
          types: ["mean", "change"],
        });
        if (token !== this._histToken) return; // a newer request won

        const socRows = (result && result[socEntity]) || [];
        const soc = socRows
          .map((row) => (row.mean == null ? null : num(row.mean)))
          .filter((value) => value !== null);

        const sum = (rows) => (rows || []).reduce((acc, row) => acc + num(row.change), 0);
        this._history = {
          soc,
          charge: sum(chgEntity ? result[chgEntity] : null) / 1000,
          discharge: Math.abs(sum(dchgEntity ? result[dchgEntity] : null)) / 1000,
        };
        this._histFetchedAt = Date.now();
      } catch (err) {
        if (token !== this._histToken) return;
        this._histError = this._t(
          "Statistics are unavailable — is the recorder enabled?",
          "统计数据不可用 —— 是否启用了 recorder？",
        );
        this._history = null;
      } finally {
        if (token === this._histToken) {
          this._histLoading = false;
          this.requestUpdate();
        }
      }
    }

    /* ---------------------------- interaction ---------------------------- */

    _handleClick(event) {
      const pill = event.target.closest("[data-range]");
      if (!pill) return;
      const range = pill.getAttribute("data-range");
      if (!range || range === this._range) return;
      this._range = range;
      this._history = null;
      this._histFetchedAt = 0;
      this._fetchHistory();
    }

    firstUpdated() {
      this.shadowRoot.addEventListener("click", (event) => this._handleClick(event));
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
  class HoymilesBatteryEditor extends LitElement {
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

    static get styles() {
      return css`
        .row { padding: 8px; }
        ha-textfield { display: block; width: 100%; margin-bottom: 8px; }
      `;
    }

    render() {
      const config = this._config || {};
      return html`
        <div class="row">
          <ha-textfield label="dev_id (required)" .value=${config.dev_id || ""}
            @change=${this._changed("dev_id")}></ha-textfield>
          <ha-textfield label="title (defaults to the device model; accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="show_title (false = hide the heading)"
            .value=${config.show_title === false ? "false" : ""}
            @change=${this._changed("show_title")}></ha-textfield>
          <ha-textfield label="max_width (px)" .value=${config.max_width || ""}
            @change=${this._changed("max_width")}></ha-textfield>
          <ha-textfield label="alarm_entity" .value=${config.alarm_entity || ""}
            @change=${this._changed("alarm_entity")}></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-battery-editor")) {
    customElements.define("hoymiles-battery-editor", HoymilesBatteryEditor);
  }
  if (!customElements.get("hoymiles-battery")) {
    customElements.define("hoymiles-battery", HoymilesBattery);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-battery")) {
    window.customCards.push({
      type: "hoymiles-battery",
      name: "Hoymiles Battery",
      description:
        "Battery stack of a Hoymiles micro storage device with per-pack SOC / "
        + "temperature callouts, scaled to the number of installed packs.",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmBatteryRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmBatteryRegister());
}
