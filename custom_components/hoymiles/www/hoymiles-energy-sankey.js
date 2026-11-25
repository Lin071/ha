/* ============================================================================
 * Hoymiles Micro Storage — Energy flow (Sankey) card
 * ----------------------------------------------------------------------------
 * Lovelace card bundled with the `hoymiles` custom integration.
 *
 * Protocol V0.6.2 §45: the device itself measures where today's energy went and
 * publishes the nine flows it knows about, every five minutes, on
 *
 *     sensor/<dev_id>/sankey/state        (Wh, reset at 00:00)
 *
 *     pv_prod    e2l  pv -> load          e2b  pv -> battery
 *                e2g  pv -> grid          b2g  battery -> grid
 *                tp2b third party -> battery
 *                tp2g third party -> grid
 *     load_cons  efpv pv -> load (same as e2l)
 *                efb  battery -> load     efg  grid -> load
 *                g2b  grid -> battery
 *
 * The integration decodes that into the `Energy Flow Today` sensor, and this
 * card draws those numbers.  Nothing is estimated and nothing is read from the
 * recorder: the diagram matches the one in the vendor app, because it is the
 * same measurement.
 *
 * DAY NAVIGATION: the device clears these totals at 00:00, so a past day's
 * diagram cannot be produced on demand.  The integration therefore keeps one
 * snapshot per day on disk (that day's **last** report, which is the diagram as
 * it stood at 23:59) and this card fetches the archive over the WebSocket
 * command `hoymiles/sankey/history`.  Today still comes from the entity; the
 * picker appears as soon as there are two days to choose from.  The archive
 * starts when this version is installed - days before that are not invented.
 *
 * Card config:
 *   type: custom:hoymiles-energy-sankey
 *   dev_id: MSA-280520260806      # required
 *   title: Energy flow      # optional; accepts an en/zh map
 *   language: en                  # optional (en|zh|de); omit to follow the picker
 *   icon: sankey                  # optional header icon (flow|sankey|swap, or text)
 *   ribbon_gap: 0                 # optional px of white line between ribbons
 *   ribbon_opacity: 0.58          # optional ribbon opacity (0..1)
 *   icons:                        # optional per-node emoji overrides
 *     pv: "sun"
 *
 * HIDDEN WITHOUT A METER: the whole card renders nothing when the device says
 * it has no grid meter (`has_meter` is false or not reported yet), because the
 * grid flows would all be zero and the picture would claim the unit never
 * imports or exports.  The dashboard layout is built with that in mind.
 *
 * Layout: a direct source -> sink sankey.  Four sources on the left, three
 * sinks on the right, and a ribbon for every flow the device reported.
 *
 * Interaction: click a ribbon to highlight that single flow, or click a node
 * box to highlight every ribbon that touches it.  Pure view state - the
 * numbers never change.
 * ========================================================================== */

function _hmSankeyRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Language
   *
   * The choice belongs to the viewer, not to the dashboard: it lives in one
   * localStorage key and is announced with one window event, so the dropdown
   * on any card switches every card on the page at once, and the choice
   * survives a reload.  English is the default.
   *
   * `zh-Hans` / `zh-Hant` / `zh-CN` all collapse to `zh`, `de-AT` / `de-CH` to
   * `de`: the wording is the same in either variant.
   * ------------------------------------------------------------------ */
  const T_DE = {
    "Energy flow": "Energiefluss",
    "Energy flow today": "Energiefluss heute",
    "PV": "PV",
    "Third-party PV": "Drittanbieter-PV",
    "Battery out": "Batterieabgabe",
    "Battery in": "Batterieladung",
    "Grid in": "Netzbezug",
    "Grid out": "Netzeinspeisung",
    "Load": "Last",
    "total": "gesamt",
    "No data yet.": "Noch keine Daten.",
    "No energy recorded today.": "Heute keine Energie aufgezeichnet.",
    "No energy recorded on this day.": "An diesem Tag keine Energie aufgezeichnet.",
    "No energy flow data for this device.": "Keine Energieflussdaten f\u00fcr dieses Ger\u00e4t.",
    "No record for this day.": "F\u00fcr diesen Tag liegt kein Eintrag vor.",
    "No grid meter was connected that day.": "An diesem Tag war kein Netzz\u00e4hler angeschlossen.",
    "Nothing recorded yet today.": "Heute noch nichts aufgezeichnet.",
    "Click again to clear.": "Erneut klicken zum Aufheben.",
    "Tip: click a ribbon or a node box to highlight that part of the flow.": "Tipp: Auf ein Band oder einen Knoten klicken, um diesen Teil des Flusses hervorzuheben.",
    "Today's cumulative values as measured by the device; they reset at 00:00.": "Vom Ger\u00e4t gemessene Tageswerte, um 00:00 zur\u00fcckgesetzt.",
    "The device's last cumulative values of that day, as archived by Home Assistant.": "Die letzten Tageswerte des Ger\u00e4ts an diesem Tag, von Home Assistant archiviert.",
    "Previous day": "Vorheriger Tag",
    "Next day": "N\u00e4chster Tag",
    "Only days since this integration was running are archived.": "Archiviert werden nur Tage, an denen die Integration lief.",
  };

  /** Map any Home Assistant language tag to one of the three card languages. */
  function hmNormalise(value) {
    const raw = String(value == null ? "" : value).toLowerCase();
    if (raw.startsWith("zh")) return "zh";
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("en")) return "en";
    return "";
  }

  const LANG_KEY = "hoymiles.language";
  const LANG_EVENT = "hoymiles-language";

  /** The stored choice, or "" when nothing has been picked (or no storage). */
  function hmStored() {
    try {
      return hmNormalise(window.localStorage.getItem(LANG_KEY));
    } catch (err) {
      return ""; // private mode / storage disabled: fall back to the default
    }
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
   * language was added.  A missing entry falls back to English.
   */
  function hmPick(lang, en, zh) {
    if (lang === "zh") return zh;
    if (lang === "de") {
      const de = T_DE[en];
      return de == null ? en : de;
    }
    return en;
  }

  /* ------------------------------------------------------------------ *
   * Localised config strings
   *
   * A config value may be a plain string (used as-is, so every existing
   * dashboard keeps working) or a language map:
   *
   *   title:
   *     en: Energy flow
   *     zh: 能量流
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
   * Layout constants — the SVG uses a fixed viewBox and is scaled by CSS,
   * so the diagram stays valid on any card width.
   * ------------------------------------------------------------------ */
  const VB_W = 1180;
  const VB_H = 470;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 14;
  const SIDE_PAD = 12;
  const NODE_W = 68;      // width of a node box (icon + value + unit + %)
  const GAP = 7;          // vertical gap between node boxes
  const MIN_NODE_H = 64;  // keep small nodes readable
  const EDGE_GAP = 0;     // ribbons leave the node box flush, no visible slit
  const LABEL_INSET = 12; // label text distance from the edge of its box
  const LEFT_X = SIDE_PAD;                    // left node box
  const RIGHT_X = VB_W - SIDE_PAD - NODE_W;   // right node box
  /* The ribbons run the whole width, straight out of the node boxes, and the
     names are painted on top of them.  Reserving a column for the labels left
     two tall empty strips of card colour down the sides, which the eye reads as
     white slabs no matter what was drawn behind the text. */
  const RIBBON_L = LEFT_X + NODE_W + EDGE_GAP;   // ribbons start here
  const RIBBON_R = RIGHT_X - EDGE_GAP;           // ribbons end here
  const LEFT_CHIP_X = LEFT_X + NODE_W;           // left label anchor
  const RIGHT_CHIP_X = RIGHT_X;                  // right label anchor
  const CHART_H = VB_H - PAD_TOP - PAD_BOTTOM;

  /** The grid pylon, shared by the supply and the feed-in node.  One shape for
     both directions; the plate and the direction of the ribbons already say
     which way the energy goes, so a second pictogram only added noise. */
  const GLYPH_PYLON = `<g fill="none" stroke="#fff" stroke-width="1.9"
      stroke-linecap="round" stroke-linejoin="round">
      <path d="M9.4 4.4h5.2l1.3 3.2H8.1z"/>
      <path d="M2.8 9.6h18.4"/>
      <path d="M8.1 7.6 5.2 9.6M15.9 7.6l2.9 2"/>
      <path d="M7.2 9.6 4.6 20.4M16.8 9.6l2.6 10.8"/>
      <path d="M6.2 11.6 17.8 18.2M17.8 11.6 6.2 18.2"/>
    </g>`;

  /**
   * The glyphs inside a node box.
   *
   * Each one is a WHITE pictogram that says what the node IS (sun = PV,
   * battery = storage, pylon = grid supply and feed-in, house = load), printed
   * straight onto the dark plate at the top of the box.  White rather than
   * coloured: the plate is a translucent black over a saturated node colour, so
   * any hue in the drawing either vanished into that colour or read as a stain -
   * white is the one value that stands off every node colour, and it also
   * matches the light glyphs the vendor app uses.
   *
   * Not emoji: an emoji is rendered by the platform's own font, so it arrived
   * with its own colours and shadows and a different size on every OS, none of
   * which matched the box it sat on.  `icons:` in the card config still
   * overrides one with any text.
   * Each entry is the inner markup of a 24 x 24 viewBox.
   */
  const GLYPH = {
    /* Sun: solid disc with eight rays. The classic PV pictogram. */
    pv: `<circle cx="12" cy="12" r="4.2" fill="#fff"/>
      <g stroke="#fff" stroke-width="2" stroke-linecap="round">
        <path d="M12 2.9v2.5M12 18.6v2.5M2.9 12h2.5M18.6 12h2.5"/>
        <path d="M5.5 5.5 7.3 7.3M16.7 16.7l1.8 1.8M18.5 5.5 16.7 7.3M7.3 16.7l-1.8 1.8"/>
      </g>`,
    /* A second, smaller sun: "another PV source".  No longer used - third-party
       PV is folded into `pv` - but kept so an old dashboard that still passes
       `icons.tp` has something to draw. */
    tp: `<circle cx="10" cy="10" r="3.6" fill="#fff"/>
      <g stroke="#fff" stroke-width="1.7" stroke-linecap="round">
        <path d="M10 2v2M2 10h2M4.6 4.6 6 6M15.4 4.6 14 6M4.6 15.4 6 14"/>
      </g>
      <circle cx="17.4" cy="17.4" r="3" fill="#fff"/>`,
    /* Battery with a bolt: energy is leaving the pack. */
    bat_out: `<rect x="2.6" y="6.4" width="14.6" height="11.2" rx="2.6"
        fill="none" stroke="#fff" stroke-width="1.9"/>
      <path d="M19.6 9.9v4.2" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M13.3 8.4 9.2 13h2.6l-1 3 4.2-4.6h-2.7z" fill="#fff"/>`,
    /* The same battery with a plus: energy is being stored. */
    bat_in: `<rect x="2.6" y="6.4" width="14.6" height="11.2" rx="2.6"
        fill="none" stroke="#fff" stroke-width="1.9"/>
      <path d="M19.6 9.9v4.2" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
      <path d="M8.3 12h6.4M11.5 8.8v6.4" stroke="#fff" stroke-width="2"
        stroke-linecap="round"/>`,
    /* Transmission pylon: a small cage on top, a cross-arm whose tips run past
       the legs, two splayed legs and one big X brace - the shape the vendor app
       uses for the grid, both directions. */
    grid_in: GLYPH_PYLON,
    grid_out: GLYPH_PYLON,
    /* House with a lit window: the load. */
    load: `<path d="M3.3 11.3 12 3.9l8.7 7.4" fill="none" stroke="#fff"
        stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5.7 10.5v8.5a1.2 1.2 0 0 0 1.2 1.2h10.2a1.2 1.2 0 0 0 1.2-1.2v-8.5"
        fill="none" stroke="#fff" stroke-width="1.9" stroke-linejoin="round"/>
      <rect x="10.1" y="13.2" width="3.8" height="4.4" rx=".7" fill="#fff"/>`,
  };

  /** Fallback glyph, so an unknown node id is never invisible. */
  const GLYPH_FALLBACK = `<circle cx="12" cy="12" r="4" fill="#fff"/>`;

  /* ------------------------------------------------------------------ *
   * Node model — four sources on the left, three sinks on the right.
   *
   * Battery and grid appear on both sides on purpose: "battery out" is
   * discharge and "battery in" is charge, and one node cannot be both a
   * source and a sink of the same diagram.
   * ------------------------------------------------------------------ */
  /* Colors follow the reference the user supplied: PV is yellow, battery is
     green (two shades, so charge and discharge stay apart), the grid is grey
     (it is a metered utility, not a colour of its own) and the load is blue.
     The node text is dark (#111), which stays legible on all four. */
  const SOURCES = [
    { id: "pv", side: "src", en: "PV", zh: "光伏供电", color: "#F5C342" },
    { id: "bat_out", side: "src", en: "Battery out", zh: "电池供电", color: "#45C08C" },
    { id: "grid_in", side: "src", en: "Grid in", zh: "电网供电", color: "#A9AEB3" },
  ];

  const SINKS = [
    { id: "load", side: "snk", en: "Load", zh: "负载消耗", color: "#2E90D6" },
    { id: "bat_in", side: "snk", en: "Battery in", zh: "存入电池", color: "#22C55E" },
    { id: "grid_out", side: "snk", en: "Grid out", zh: "馈入电网", color: "#8F959B" },
  ];

  /* ------------------------------------------------------------------ *
   * The nine flows the device reports, and the sensor attribute each one
   * arrives in.  `e2l` and `efpv` are the same quantity seen from the two
   * sides of the topic; the production side (`e2l`) is used, so no flow is
   * counted twice.
   * ------------------------------------------------------------------ */
  const FLOWS = [
    { id: "pv_e2l", from: "pv", to: "load" },
    { id: "pv_e2b", from: "pv", to: "bat_in" },
    { id: "pv_e2g", from: "pv", to: "grid_out" },
    /* Third-party PV is a second PV input on the same unit, not a different
       kind of energy, so the card folds it into the single `pv` node: the
       reference picture has one yellow source on the left.  Its two flows keep
       their own ids (they are separate measurements) and are ADDED to the same
       pv -> bat_in / pv -> grid_out entries - see the accumulation in
       _buildGraph. */
    { id: "pv_tp2b", from: "pv", to: "bat_in" },
    { id: "pv_tp2g", from: "pv", to: "grid_out" },
    { id: "pv_b2g", from: "bat_out", to: "grid_out" },
    { id: "load_efb", from: "bat_out", to: "load" },
    { id: "load_efg", from: "grid_in", to: "load" },
    { id: "load_g2b", from: "grid_in", to: "bat_in" },
  ];

  /* Below this a flow is noise, not a ribbon (kWh).  Shared by `_buildGraph`
     and by the picker, so "this day is empty" means the same thing in both
     places: the date can never stay black over an empty diagram. */
  const EMPTY_EPS = 0.0005;

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  /**
   * The SN part of `<prefix>-<SN>`.
   *
   * The integration names its entities after the **device name**, so renaming a
   * device to "G3" turns `sensor.msa_280577777777_energy_flow_today` into
   * `sensor.g3_msa_280577777777_energy_flow_today`. The SN survives that rename
   * and the frontend no longer exposes `unique_id`, so the SN is what the
   * lookup keys on.
   */
  function serialOf(devId) {
    const parts = String(devId == null ? "" : devId).split("-");
    return parts[parts.length - 1].toLowerCase();
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
   * Zero-pad a number to two digits, for `YYYY-MM-DD` keys.
   */
  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /**
   * Zero-pad a number to two digits, for `YYYY-MM-DD` keys.
   */
  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /**
   * Step a `YYYY-MM-DD` key by whole days.
   *
   * `Date.UTC` on purpose: the key is a calendar date, not an instant, so the
   * browser's time zone must not take part.  Parsing `"2026-11-18"` with `new
   * Date()` reads it as UTC midnight and then shifts it back a day west of
   * Greenwich.
   */
  function shiftDay(key, step) {
    const parts = String(key || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return "";
    const stamp = Date.UTC(parts[0], parts[1] - 1, parts[2]) + step * 86400000;
    return new Date(stamp).toISOString().slice(0, 10);
  }

  /* ------------------------------------------------------------------ *
   * Header icon
   *
   * `icon:` takes one of these names, or any other string, which is rendered
   * as text - that keeps a plain emoji in the config working.
   * ------------------------------------------------------------------ */
  const ICON_SVG = {
    /* Three coloured sources merging into one thick slate line. */
    flow: (u) => `
      <g fill="none" stroke-linecap="round" stroke-width="2.5">
        <path d="M2.2 5.4h3.3l3.7 5.3" stroke="#f59e0b"/>
        <path d="M2.2 12h7" stroke="#22c55e"/>
        <path d="M2.2 18.6h3.3l3.7-5.3" stroke="#3b82f6"/>
        <path d="M10.9 12h10.9" stroke="#94a3b8" stroke-width="3.4"/>
      </g>
      <circle cx="9.9" cy="12" r="1.8" fill="#94a3b8"/>`,

    /* Two source nodes and a sink, joined by ribbons: a sankey diagram. */
    sankey: (u) => `
      <rect x="1.5" y="2.8" width="2.7" height="6.6" rx="1.1" fill="#f59e0b"/>
      <rect x="1.5" y="14.6" width="2.7" height="6.6" rx="1.1" fill="#22c55e"/>
      <rect x="19.8" y="6.2" width="2.7" height="11.6" rx="1.1" fill="#3b82f6"/>
      <g fill="none" stroke-width="1.9" stroke-linecap="round">
        <path d="M4.6 6.1c3.3 0 5.9 4.3 8.6 4.3 2.1 0 3.3-.8 6.1-1.6"
          stroke="#f59e0b" stroke-opacity=".8"/>
        <path d="M4.6 17.9c3.3 0 5.9-4.3 8.6-4.3 2.1 0 3.3.8 6.1 1.6"
          stroke="#22c55e" stroke-opacity=".8"/>
      </g>`,

    /* Two arrows in opposite directions: "in and out", an exchange. */
    swap: (u) => `
      <g stroke-linecap="round" stroke-width="2.1" fill="none">
        <path d="M3 8.4h13.4" stroke="#f59e0b"/>
        <path d="M21 15.6H7.6" stroke="#22c55e"/>
      </g>
      <path fill="#f59e0b" d="M14.9 4.9 20.2 8.4l-5.3 3.5z"/>
      <path fill="#22c55e" d="M9.1 12.1 3.8 15.6L9.1 19.1z"/>`,

    /* A neutral fallback, so an unknown name is never invisible. */
    dot: () => `<circle cx="12" cy="12" r="4.2" fill="currentColor"/>`,
  };

  /* The sensor reports watt-hours; everything below works in kWh, which is
   * what the formatter works with. */
  const WH_PER_KWH = 1000;

  /** Split a kWh value into a readable number + unit (484 Wh / 4.74 kWh). */
  function splitEnergy(kwh) {
    const v = num(kwh);
    const abs = Math.abs(v);
    if (abs >= 1000) return { text: (v / 1000).toFixed(2), unit: "MWh" };
    if (abs >= 1) return { text: v.toFixed(2), unit: "kWh" };
    return { text: (v * 1000).toFixed(0), unit: "Wh" };
  }

  function fmtValue(kwh) {
    return splitEnergy(kwh).text;
  }

  function fmtUnit(kwh) {
    return splitEnergy(kwh).unit;
  }

  function fmtEnergy(kwh) {
    const { text, unit } = splitEnergy(kwh);
    return `${text} ${unit}`;
  }

  /* Two decimals: the node shares and the per-ribbon shares are read against
     each other, and one decimal made small splits collapse onto the same value
     (1.2 % next to 0.0 %). */
  function fmtPct(part, total) {
    if (!total) return "0.00%";
    return `${((part / total) * 100).toFixed(2)}%`;
  }

  /**
   * Smooth sankey ribbon between two vertical segments.
   *
   * The control points sit 0.62 of the span away from each end, i.e. they pass
   * each other slightly in the middle. That makes the band leave and enter the
   * node almost horizontally and do its turning in the middle third - the
   * rounded, unhurried curve the vendor app draws. At 0.5 the two control
   * points meet exactly in the centre and the result is a flat diagonal that
   * reads as a straight stripe rather than as flow.
   */
  function ribbon(x1, y1, h1, x2, y2, h2) {
    const dx = Math.max(12, (x2 - x1) * 0.62);
    return [
      `M ${x1} ${y1}`,
      `C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      `L ${x2} ${y2 + h2}`,
      `C ${x2 - dx} ${y2 + h2}, ${x1 + dx} ${y1 + h1}, ${x1} ${y1 + h1}`,
      "Z",
    ].join(" ");
  }

  /**
   * Find the scale so that `sum(max(minH, value * scale))` fills `avail`.
   * Tiny nodes keep a readable minimum height while the ribbons that leave
   * them stay proportional to their real value.
   */
  function fitScale(values, avail) {
    const n = values.length;
    if (!n) return { scale: 0, minH: MIN_NODE_H };
    const usable = Math.max(8, avail - (n - 1) * GAP);
    const minH = Math.min(MIN_NODE_H, usable / n);
    const sum = (s) => values.reduce((acc, v) => acc + Math.max(minH, v * s), 0);
    let lo = 0;
    let hi = Math.max(1e-6, usable / Math.max(1e-9, Math.min(...values)));
    let guard = 0;
    while (sum(hi) < usable && guard < 80) {
      hi *= 2;
      guard += 1;
    }
    for (let i = 0; i < 48; i += 1) {
      const mid = (lo + hi) / 2;
      if (sum(mid) < usable) lo = mid;
      else hi = mid;
    }
    return { scale: hi, minH };
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesEnergySankey extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _graph: { type: Object },
        _hidden: { type: Boolean },
        _missing: { type: Boolean },
        _selected: { type: Object },
      };
    }

    constructor() {
      super();
      this._graph = null;
      // `true` while the device reports no meter: the card renders nothing.
      this._hidden = false;
      // `true` when the sensor itself is missing (integration not set up).
      this._missing = false;
      // Signature of the numbers the current `_graph` was built from, so a
      // `hass` assignment that changed nothing else does not rebuild it.
      this._sig = null;
      this._entityId = null;
      // Click-to-highlight state. Stored by node id / flow endpoints (not by
      // array index) so it survives a data refresh that rebuilds the graph.
      //   null                                    -> nothing highlighted
      //   { kind: "flow", from, to }              -> one ribbon
      //   { kind: "node", side: "src"|"snk", id } -> every ribbon of a node
      this._selected = null;
      // Which archived day the card is showing; `null` means "today, live".
      this._day = null;
      // Archived days from the integration (`hoymiles/sankey/history`):
      // `[{date, payload, flags, saved_at}]`, oldest first.
      this._days = [];
      // Key of the live numbers the archive was last fetched for: a device
      // publish refreshes it, merely switching days does not.
      this._dayKey = null;
      this._loadingDays = false;
      // `true` once the archive has answered (or there was no way to ask).
      // Until then the card refuses to render: the live entity is `unavailable`
      // while the unit is off and carries no `has_meter`, so drawing immediately
      // meant showing the card and taking it away again a moment later.
      this._daysReady = false;
      // `true` when the selected day has no archived payload (pruned, or never
      // recorded) - which is not the same as "that day used no energy".
      this._dayMissing = false;
      // `true` when the selected day's archive says the unit had **no grid
      // meter** that day: there is no energy flow to draw, meter or not.
      this._noMeterDay = false;
      // Day picker popover: whether it is open and which month it shows.
      this._calOpen = false;
      this._calMonth = null;
      // Last `has_meter` the device reported.  `unavailable` drops the
      // attributes, and without remembering the flag an offline unit would hide
      // the card instead of showing what it last had.
      this._hasMeterKnown = null;
      // Unique prefix so several cards on one page do not clash on <clipPath> ids.
      this._uid = `hm-sk-${Math.random().toString(36).slice(2, 9)}`;
      // Bound here rather than as a class field: the click handler needs `this`
      // however Lit rebinds the listener.
      this._handleClick = (event) => this._onClick(event);
    }

    static getConfigElement() {
      return document.createElement("hoymiles-energy-sankey-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 14px 14px; }
        .head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
                justify-content: space-between; }
        /* The title is a caption, not a heading: at 15px it competed with the
           node numbers, which are the point of the picture. */
        .title { font-size: 13px; font-weight: 500; color: var(--primary-text-color);
                 display: flex; align-items: center; gap: 6px; }
        .title svg { display: block; flex: none; }
        /* Header right side: the date navigator, pushed to the far right. */
        .hright { display: flex; align-items: center; gap: 10px; margin-left: auto; }
        /* Date navigator: the same pill the history card uses - ‹ date ›. */
        .daynav { display: flex; align-items: center; gap: 2px;
                  border: 1px solid var(--divider-color); border-radius: 999px;
                  padding: 2px; background: var(--card-background-color, #fff); }
        .daynav button { width: 26px; height: 26px; border-radius: 50%; border: none;
                         background: none; cursor: pointer; font: inherit;
                         font-size: 15px; line-height: 1;
                         display: inline-flex; align-items: center;
                         justify-content: center; color: var(--primary-text-color); }
        .daynav button:hover:not(:disabled) {
          background: var(--secondary-background-color, rgba(127,127,127,.1)); }
        .daynav button:disabled { opacity: .3; cursor: default; }
        /* A day with nothing to draw: the date itself goes grey, the way a
           disabled field does.  The picture is never greyed - a day that *has*
           an energy flow is drawn at full colour whether the device is online or
           not. */
        .daynav .daybtn.empty { color: var(--disabled-text-color, #b6bcc4); }

        /* ------------------------------------------------------------------ *
         * Day calendar
         *
         * The same widget the history chart uses: the native date input only
         * greys the future, so it cannot answer "which days have something to
         * draw".  This popover can - a day with an energy flow keeps the normal
         * text colour, a day without one is grey, and the legend says so.
         * ------------------------------------------------------------------ */
        .dayhost { position: relative; display: inline-flex; }
        .daybtn { font: inherit; font-size: 12.5px; font-weight: 600;
                  color: var(--primary-text-color); background: none;
                  border: none; outline: none; padding: 4px 6px;
                  text-align: center; cursor: pointer; border-radius: 7px;
                  min-width: 92px; font-variant-numeric: tabular-nums; }
        .daybtn:hover { background: var(--secondary-background-color, rgba(127,127,127,0.1)); }
        .cal {
          position: absolute; top: calc(100% + 6px); right: 0;
          z-index: 60; width: 238px; padding: 8px 9px 7px; box-sizing: border-box;
          border-radius: 12px; background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color);
          box-shadow: 0 10px 26px rgba(0,0,0,.18);
        }
        .cal-head { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
        .cal-month { flex: 1 1 auto; text-align: center; font-size: 12.5px;
                     font-weight: 600; color: var(--primary-text-color); }
        .cal-nav { width: 24px; height: 24px; border: none; background: none;
                   cursor: pointer; border-radius: 50%; font: inherit;
                   font-size: 14px; line-height: 1; color: var(--primary-text-color);
                   display: inline-flex; align-items: center; justify-content: center; }
        .cal-nav:hover:not(:disabled) {
          background: var(--secondary-background-color, rgba(127,127,127,.1)); }
        .cal-nav:disabled { opacity: .3; cursor: default; }
        /* Seven equal columns; the weekday row uses the same grid so the
           columns line up without any width guessing. */
        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; }
        .cal-wd { text-align: center; font-size: 10.5px; padding: 2px 0 3px;
                  color: var(--secondary-text-color); }
        .cal-blank { height: 26px; }
        /* A day cell has three looks, and telling them apart is the point:
             - an energy flow was recorded -> normal text colour
             - nothing to draw              -> muted grey, still clickable (the
               card then says so, which is honest and lets the user go back)
             - future                       -> muted grey and disabled
           The selected day is filled, the current day is outlined. */
        .cal-day {
          height: 26px; border: none; background: none; cursor: pointer;
          font: inherit; font-size: 12px; border-radius: 7px; padding: 0;
          color: var(--primary-text-color); font-variant-numeric: tabular-nums;
        }
        .cal-day:hover:not(:disabled) {
          background: var(--secondary-background-color, rgba(127,127,127,.14)); }
        .cal-day.empty { color: var(--secondary-text-color); opacity: .55; }
        .cal-day.future { opacity: .28; cursor: default; }
        .cal-day.today { box-shadow: inset 0 0 0 1px var(--primary-color); }
        .cal-day.sel { background: var(--primary-color);
                       color: var(--text-primary-color, #fff); font-weight: 600;
                       box-shadow: none; }
        .cal-legend { display: flex; align-items: center; gap: 5px; margin-top: 6px;
                      font-size: 10.5px; color: var(--secondary-text-color); }
        .cal-legend .lg { width: 8px; height: 8px; border-radius: 2px;
                          background: var(--primary-text-color); }
        .cal-legend .lg.empty { background: var(--secondary-text-color); opacity: .55; }
        .cal-legend .lg + .lg { margin-left: 6px; }
        svg { display: block; width: 100%; height: auto; }
        /* Click-to-highlight: the ribbons and node boxes are hit targets. */
        svg .ribbon { cursor: pointer; transition: fill-opacity 0.18s ease; }
        svg .node { cursor: pointer; transition: opacity 0.18s ease; }
        svg .node.dim { opacity: 0.38; }
        /* Shares printed on the highlighted ribbons: a label, not a target. */
        svg text.fpct { pointer-events: none; font-variant-numeric: tabular-nums; }
        .detail { margin-top: 8px; padding: 8px 10px; border-radius: 8px;
                  background: var(--secondary-background-color, rgba(127, 127, 127, 0.12));
                  border: 1px solid var(--divider-color); }
        .dhead { font-size: 12.5px; font-weight: 500; color: var(--primary-text-color); }
        .dflows { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; }
        .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
                color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
        .chip i { width: 8px; height: 8px; border-radius: 2px; display: inline-block;
                  flex: 0 0 auto; }
        .dhint { font-size: 11px; color: var(--secondary-text-color); margin-top: 6px;
                 opacity: 0.8; }
        .msg { padding: 14px 4px; font-size: 13px; color: var(--secondary-text-color);
               line-height: 1.6; }
      `;
    }

    setConfig(config) {
      if (!config || !config.dev_id) {
        throw new Error("hoymiles-energy-sankey: 'dev_id' is required");
      }
      this._config = { ...config };
      this._sig = null;
      this._entityId = null;
      this._graph = null;
      this._selected = null;
      // A new config may point at another device, so the archive is refetched
      // and the selected day drops back to today.
      this._day = null;
      this._days = [];
      this._dayKey = null;
      this._daysReady = false;
      this._dayMissing = false;
      this._noMeterDay = false;
      this._calOpen = false;
      this._calMonth = null;
      /* Another device may have a different hardware set, and the flag below is
         remembered across `unavailable` on purpose - so it has to be forgotten
         here, not just overwritten when the next answer arrives. */
      this._hasMeterKnown = null;
      // setConfig may run after the first `hass` assignment (e.g. when the
      // dashboard is edited in place), so refresh in that case.
      if (this._hass) this._sync();
    }

    set hass(hass) {
      this._hass = hass;
      this._sync();
    }

    getCardSize() { return 6; }

    /* --------------------------- text / config --------------------------- */

    /**
     * Language changes are announced on `window`.  Node labels are baked into
     * the graph when it is built, so the signature in `_sync` carries the
     * language and a switch rebuilds the diagram.
     */
    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => {
        this._sig = null;
        this._sync();
      };
      window.addEventListener(LANG_EVENT, this._onLangChange);
      /* The calendar closes on any press outside the card.  `pointerdown` rather
         than `click`: the opening click happens first, so this listener can
         never close the popover it just opened. */
      this._onWindowDown = (event) => {
        if (this._calOpen && !event.composedPath().includes(this)) {
          this._calOpen = false;
          this.requestUpdate();
        }
      };
      window.addEventListener("pointerdown", this._onWindowDown);
    }

    disconnectedCallback() {
      window.removeEventListener(LANG_EVENT, this._onLangChange);
      if (this._onWindowDown) window.removeEventListener("pointerdown", this._onWindowDown);
      super.disconnectedCallback();
    }

    _t(en, zh) {
      return hmPick(hmLang(this._hass, this._config), en, zh);
    }

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, hmLang(this._hass, this._config));
    }

    _dev() { return this._config.dev_id; }

    _label(def) { return this._t(def.en, def.zh); }

    /**
     * Resolve the energy-flow sensor of this device.
     *
     * Matched by the SN inside the entity id rather than by a fixed prefix: the
     * entity id starts with the *device name* (`sensor.g3_msa_...`), which the
     * user can rename to anything, while the SN stays.  `hass.entities` no
     * longer carries `unique_id`, so there is nothing better to key on.
     */
    _resolveEntity(suffix, domain = "sensor") {
      const hass = this._hass;
      if (!hass) return null;
      const states = hass.states || {};
      const dev = this._dev();
      if (!dev) return null;

      const serial = serialOf(dev);
      const tail = `_${suffix}`;
      let found = null;
      for (const entityId of Object.keys(states)) {
        if (!entityId.startsWith(`${domain}.`)) continue;
        if (!entityId.endsWith(tail)) continue;
        if (!entityId.includes(serial)) continue;
        if (!found || entityId.length < found.length) found = entityId;
      }
      return found;
    }

    /* ------------------------------ reading ------------------------------ */

    /**
     * Read the sensor (or the archive) and rebuild the diagram when it changed.
     *
     * Called from the `hass` setter, which Home Assistant fires for *every*
     * state change on the page, so the cheap signature check comes first: a
     * diagram is only rebuilt when one of the nine flows, the meter flag, the
     * entity, the selected day or the language actually changed.
     *
     * Two sources, one picture:
     *
     * * **today** comes from the entity, because it is the live cumulative the
     *   device keeps updating;
     * * **a past day** comes from the integration's archive, because the device
     *   clears these totals at 00:00 and can no longer reproduce them.
     */
    _sync() {
      const hass = this._hass;
      const cfg = this._config;
      if (!hass || !cfg) return;

      if (!this._entityId || !(hass.states || {})[this._entityId]) {
        this._entityId = this._resolveEntity("energy_flow_today");
      }

      const state = this._entityId ? (hass.states || {})[this._entityId] : null;
      const liveAttrs = state ? state.attributes || {} : null;

      /* Which optional branches exist does NOT depend on the device being
         reachable, and `unavailable` drops the attributes - so the last answer
         is remembered. */
      const liveMeter = liveAttrs ? liveAttrs.has_meter : undefined;
      if (typeof liveMeter === "boolean") this._hasMeterKnown = liveMeter;
      /* Nothing live to read?  The archive recorded `has_meter` with every
         snapshot, so ask it.  Without this a unit that *never* had a grid meter
         grew the card back after every reload: the entity is `unavailable` while
         the unit is off, `unavailable` carries no attributes, and an unknown
         flag was read as "maybe it has one". */
      if (this._hasMeterKnown === null) {
        const flags = this._newestFlags();
        if (flags && typeof flags.has_meter === "boolean") {
          this._hasMeterKnown = flags.has_meter;
        }
      }
      const hasMeter = this._hasMeterKnown === true;
      /* Hide only on a positive "this unit has no grid meter".  An unknown
         answer means nobody has told us yet - after a restart the entity is
         `unknown` and carries a null `has_meter` - and a card that disappears is
         a worse answer than one that says there is no data yet. */
      const hideCard = this._hasMeterKnown === false;

      /* Refresh the archive whenever the LIVE numbers move - that is what "the
         device published" looks like from here - and never merely because the
         user switched days. */
      if (liveAttrs) this._refreshDays(this._liveKey(liveAttrs));

      /* Hold the first paint until the archive answers (or the live attributes
         already gave a definitive flag).  A unit that has never had a meter is
         the case this protects: its entity is `unavailable` while it is off, the
         attributes are empty, and an unknown flag used to be drawn as "maybe it
         has one" - so the card appeared and vanished on every reload. */
      if (!this._daysReady && this._hasMeterKnown === null) {
        /* Waiting for the archive: collapse the box, but keep the element
           mounted.  Setting `hidden` here would make Home Assistant drop the
           card element altogether (`hui-card` unbinds a child that reports
           itself hidden) - and an unbound element never receives the answer,
           so the card could not come back once the archive said it should. */
        this._hidden = false;
        this.style.display = "none";
        return;
      }
      /* Decided (or already known): undo the waiting state. */
      if (this.style.display === "none") this.style.display = "";

      const today = this._today();
      const day = this._day && this._day !== today ? this._day : null;

      /* Availability is deliberately *not* consulted any more.  The diagram is a
         record of what the device measured, so the question is only "do we have
         a record for this day":

         * a past day comes from the archive, because the device clears these
           totals at 00:00 and can no longer reproduce them;
         * today comes from the live attributes while the device is publishing,
           and otherwise from the archive's entry for today - that entry is
           rewritten on every `sankey/state` the device sends, so it *is* the
           last picture it drew.  A unit that goes quiet therefore keeps the
           diagram it had, exactly like the history chart keeps its last point. */
      const archive = this._dayEntry(day || today);
      /* A day the unit spent without a grid meter has no energy flow to draw,
         even if the firmware still published a (zero) snapshot for it.  The
         archive keeps the flags from that day for exactly this question. */
      const dayMeter = archive && archive.flags
        && typeof archive.flags.has_meter === "boolean"
        ? archive.flags.has_meter
        : null;
      const noMeterDay = !!day && dayMeter === false;

      let readings = null;
      if (day) {
        if (archive && !noMeterDay) readings = this._readingsFromPayload(archive.payload);
      } else {
        readings = this._liveReadings();
        if (!readings && archive) readings = this._readingsFromPayload(archive.payload);
      }

      if (!day && !state) {
        if (this._sig !== "missing") {
          this._sig = "missing";
          this._graph = null;
          this._missing = true;
          this._dayMissing = false;
          this._noMeterDay = false;
          this._hidden = false;
          this.requestUpdate();
        }
        return;
      }

      if (!readings) {
        /* Nothing for this day: say so, and leave the date grey so the picker
           shows which days do have a record. */
        const sig = `${day ? `no-archive|${day}|${noMeterDay ? "nm" : ""}` : "no-today"}`
          + `|${hideCard ? "1" : "0"}`;
        if (sig !== this._sig) {
          this._sig = sig;
          this._graph = null;
          this._missing = false;
          this._dayMissing = true;
          this._noMeterDay = noMeterDay;
          this._hidden = hideCard;
          this.requestUpdate();
        }
        return;
      }

      const sig = [
        hmLang(hass, cfg),
        this._entityId,
        day || "today",
        hasMeter ? "1" : "0",
        ...FLOWS.map((f) => num(readings[f.id]).toFixed(4)),
      ].join("|");
      if (sig === this._sig) return;
      this._sig = sig;

      this._missing = false;
      this._dayMissing = false;
      this._noMeterDay = false;
      this._hidden = hideCard;
      this._graph = hideCard ? null : this._buildGraph(readings);
      this.requestUpdate();
    }

    /**
     * Today's nine flows, or ``null`` when the entity is not reporting.
     *
     * `unavailable` / `unknown` only mean "no live reading right now" - they no
     * longer mean "nothing to show", because the archive keeps the last one.
     */
    _liveReadings() {
      const hass = this._hass;
      const state = this._entityId && hass ? (hass.states || {})[this._entityId] : null;
      if (!state) return null;
      if (state.state === "unavailable" || state.state === "unknown") return null;
      return this._readingsFromAttrs(state.attributes || {});
    }

    /** The nine flows, read from the sensor attributes (today). */
    _readingsFromAttrs(attrs) {
      const readings = {};
      for (const flow of FLOWS) readings[flow.id] = num(attrs[flow.id]) / WH_PER_KWH;
      return readings;
    }

    /**
     * The nine flows, read from an archived `sankey/state` payload.
     *
     * The archive stores the device's own document (`pv_prod` / `load_cons`),
     * not the sensor attributes, so one payload keeps its wire meaning and the
     * card can be re-read years later without depending on attribute naming.
     * `pv_e2l` therefore becomes `payload.pv_prod.e2l`.
     */
    _readingsFromPayload(payload) {
      const readings = {};
      for (const flow of FLOWS) {
        const [group, field] = flow.id.split("_");
        const bucket = payload[group === "pv" ? "pv_prod" : "load_cons"] || {};
        readings[flow.id] = num(bucket[field]) / WH_PER_KWH;
      }
      return readings;
    }

    /* ------------------------------ archive ------------------------------ */

    /** Today's date in the Home Assistant time zone, as `YYYY-MM-DD`. */
    _today() {
      const tz = this._hass && this._hass.config && this._hass.config.time_zone;
      try {
        // `sv-SE` formats as YYYY-MM-DD, which is exactly the archive's key.
        // The browser's own zone would disagree with the server whenever the two
        // differ, and the card would then show "today" twice in one list.
        return new Intl.DateTimeFormat("sv-SE", tz ? { timeZone: tz } : undefined)
          .format(new Date());
      } catch (err) {
        return new Date().toISOString().slice(0, 10);
      }
    }

    /**
     * The key the archive fetch is throttled on.
     *
     * It carries the nine flows (so any device publish refetches) plus
     * `history_days`, the size of the integration's archive.  That second part
     * matters on a cold start: the card may fetch before the integration has
     * finished backfilling from the recorder, and without this it would keep its
     * "today only" answer until the device published again - hours on a quiet
     * day.
     */
    _liveKey(attrs) {
      return [
        this._entityId,
        attrs.has_meter === true ? "1" : "0",
        num(attrs.history_days),
        ...FLOWS.map((f) => num(attrs[f.id])),
      ].join("|");
    }

    /** Fetch the archive when the live numbers changed (or on first render). */
    _refreshDays(key) {
      if (this._loadingDays || this._dayKey === key) return;
      this._dayKey = key;
      this._loadDays();
    }

    /**
     * Ask the integration for the archived days.
     *
     * A WebSocket command rather than a sensor attribute: up to a month of
     * payloads on an entity would follow every state write into the recorder.
     * An integration older than the command simply answers with an error, and
     * the card then behaves exactly as it did before - today only, no picker.
     */
    async _loadDays() {
      const hass = this._hass;
      const dev = this._dev();
      if (!hass || !dev || typeof hass.callWS !== "function") {
        /* No way to ask: stop waiting and let the live attributes decide. */
        this._daysReady = true;
        this._sync();
        return;
      }
      this._loadingDays = true;
      let days = [];
      try {
        const result = await hass.callWS({
          type: "hoymiles/sankey/history",
          dev_id: dev,
        });
        days = result && Array.isArray(result.days) ? result.days : [];
      } catch (err) {
        days = [];
      } finally {
        this._loadingDays = false;
      }
      this._days = days.filter((d) => d && typeof d.date === "string" && d.payload);
      this._daysReady = true;
      /* Re-run the verdict: the archive's `flags.has_meter` may be the only
         answer there is while the unit is silent, and until now the card was
         drawing on a guess.  Without this call the card stayed visible until the
         next `hass` assignment - the flash the user reported. */
      this._sig = null;
      this._sync();
      this.requestUpdate();
    }

    /** Every day the picker may show: archived dates up to today, oldest first. */
    _dayList() {
      const today = this._today();
      const keys = this._days
        .map((entry) => entry.date)
        .filter((date) => typeof date === "string" && date <= today);
      // ISO dates sort correctly as plain strings.
      keys.sort();
      return keys;
    }

    _dayEntry(day) {
      return this._days.find((entry) => entry.date === day) || null;
    }

    /** The flags recorded for the newest archived day, or ``null``. */
    _newestFlags() {
      const list = this._dayList();
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const entry = this._dayEntry(list[i]);
        if (entry && entry.flags) return entry.flags;
      }
      return null;
    }

    /**
     * Does this day have an energy flow to show?
     *
     * Three ways to have none: no archive at all, an archive that says the unit
     * had no grid meter that day (the firmware still publishes a zero snapshot
     * then), or a snapshot whose flows are all zero.  The last one used to be
     * counted as "has a record", so the date stayed black while the body said
     * there was no energy that day.
     */
    _dayHasFlow(day) {
      return this._hasEnergy(this._readingsFor(day));
    }

    /** Is there anything to draw in these readings? */
    _hasEnergy(readings) {
      if (!readings) return false;
      let total = 0;
      for (const flow of FLOWS) total += num(readings[flow.id]);
      return total > EMPTY_EPS;
    }

    /**
     * The readings `_sync` would draw for `day` (``null`` when there are none).
     *
     * Shared with the date colour so the picker and the diagram can never
     * disagree: whatever makes the body say "no energy" also greys the date.
     */
    _readingsFor(day) {
      const today = this._today();
      const entry = this._dayEntry(day || today);
      if (entry && entry.flags && entry.flags.has_meter === false) return null;
      if (day && day !== today) {
        return entry ? this._readingsFromPayload(entry.payload) : null;
      }
      const live = this._liveReadings();
      if (live) return live;
      return entry ? this._readingsFromPayload(entry.payload) : null;
    }

    /** Where the picker sits right now: the selected day, or today. */
    _navState() {
      const today = this._today();
      const list = this._dayList();
      const current = this._day && this._day !== today ? this._day : today;
      /* Step through the *calendar*, not through the days that happen to have a
         record: walking only the archived ones made every day look busy, and the
         user could not tell "this day had no energy" from "this day was never
         recorded".  The oldest archived day is the floor. */
      const min = list.length ? list[0] : today;
      const entry = this._dayEntry(current);
      const noMeter = !!entry && !!entry.flags && entry.flags.has_meter === false;
      return {
        list,
        current,
        min,
        max: today,
        prev: current > min,
        next: current < today,
        /* Is there anything to draw for this day?  Drives the grey date. */
        has: this._dayHasFlow(current),
        /* Why it is grey, for the tooltip: no record / no meter / all zeros. */
        why: entry ? (noMeter ? "meter" : "empty") : "none",
      };
    }

    _shiftDay(step) {
      const nav = this._navState();
      const next = shiftDay(nav.current, step);
      if (!next || next < nav.min || next > nav.max) return;
      this._selectDay(next);
    }

    /** `null` (or today's date) means "show the live numbers". */
    _selectDay(day) {
      const today = this._today();
      const next = !day || day >= today ? null : day;
      if (next === this._day) return;
      this._day = next;
      // A highlight belongs to one diagram; carrying it over would dim the new
      // day's flows against a selection the user made a day ago.
      this._selected = null;
      this._sig = null;
      this.requestUpdate();
      this._sync();
    }

    /** ‹ date › - hidden while the archive is empty (nothing to go back to). */
    _dayNav() {
      const nav = this._navState();
      if (!nav.list.length) return "";
      return html`
        <div class="daynav" title=${nav.has
          ? this._t("Only days since this integration was running are archived.",
            "只存档集成运行期间的天数。")
          : nav.why === "meter"
            ? this._t("No grid meter was connected that day.", "该日未接入电表。")
            : nav.why === "empty"
              ? this._t("No energy flow was recorded that day.", "该日没有能量流记录。")
              : this._t("No record for this day.", "该日没有记录。")}>
          <button title=${this._t("Previous day", "上一天")} ?disabled=${!nav.prev}
            @click=${(event) => { event.stopPropagation(); this._shiftDay(-1); }}>‹</button>
          <div class="dayhost">
            <button class="daybtn ${nav.has ? "" : "empty"}"
              title=${this._t("Pick a day", "选择日期")}
              @click=${(event) => { event.stopPropagation(); this._toggleCalendar(); }}>${nav.current}</button>
            ${this._calOpen ? this._calendar() : ""}
          </div>
          <button title=${this._t("Next day", "下一天")} ?disabled=${!nav.next}
            @click=${(event) => { event.stopPropagation(); this._shiftDay(1); }}>›</button>
        </div>`;
    }

    /* --------------------------- day calendar --------------------------- */

    /**
     * The day picker, the same widget the history chart uses.
     *
     * The native `<input type="date">` was replaced because it cannot say which
     * days have something to draw - its calendar only greys the future, so every
     * past day looks equally valid.  This one knows: a day with an energy flow is
     * drawn in the normal text colour, a day without one in grey, and the legend
     * under the grid spells that out.
     */
    _toggleCalendar() {
      this._calOpen = !this._calOpen;
      if (this._calOpen) {
        const [year, month] = this._navState().current.split("-").map(Number);
        this._calMonth = new Date(year, month - 1, 1);
      }
      this.requestUpdate();
    }

    /** Locale used for the calendar's own labels (month name, weekdays). */
    _locale() {
      const lang = hmLang(this._hass, this._config);
      if (lang === "zh") return "zh-CN";
      if (lang === "de") return "de-DE";
      return "en-GB";
    }

    _monthLabel(month) {
      try {
        return new Intl.DateTimeFormat(this._locale(), {
          year: "numeric", month: "long",
        }).format(month);
      } catch (err) {
        return `${month.getFullYear()}-${pad2(month.getMonth() + 1)}`;
      }
    }

    /** Monday-first weekday initials, taken from the browser's own locale data. */
    _weekdayLabels() {
      const out = [];
      /* 2024-01-01 was a Monday, so it is a stable base for a Monday-first row. */
      for (let i = 0; i < 7; i += 1) {
        const day = new Date(2024, 0, 1 + i);
        try {
          out.push(new Intl.DateTimeFormat(this._locale(), { weekday: "short" }).format(day));
        } catch (err) {
          out.push("MTWTFSS".charAt(i));
        }
      }
      return out;
    }

    _shiftCalendar(step) {
      const base = this._calMonth || new Date();
      const next = new Date(base.getFullYear(), base.getMonth() + step, 1);
      const [todayYear, todayMonth] = this._today().split("-").map(Number);
      if (step > 0 && (next.getFullYear() > todayYear
        || (next.getFullYear() === todayYear && next.getMonth() > todayMonth - 1))) {
        return;
      }
      const [minYear, minMonth] = (this._navState().min || this._today())
        .split("-").map(Number);
      if (step < 0 && (next.getFullYear() < minYear
        || (next.getFullYear() === minYear && next.getMonth() < minMonth - 1))) {
        return;
      }
      this._calMonth = next;
      this.requestUpdate();
    }

    _pickDay(key) {
      if (key > this._today()) return;
      this._calOpen = false;
      this._selectDay(key);
    }

    _calendar() {
      const todayKey = this._today();
      const month = this._calMonth || (() => {
        const [year, mon] = this._navState().current.split("-").map(Number);
        return new Date(year, mon - 1, 1);
      })();
      const year = month.getFullYear();
      const mon = month.getMonth();
      const lead = (new Date(year, mon, 1).getDay() + 6) % 7; // Monday-first
      const count = new Date(year, mon + 1, 0).getDate();
      const selected = this._navState().current;

      const cells = [];
      for (let i = 0; i < lead; i += 1) {
        cells.push(html`<span class="cal-blank"></span>`);
      }
      for (let day = 1; day <= count; day += 1) {
        const key = `${year}-${pad2(mon + 1)}-${pad2(day)}`;
        const future = key > todayKey;
        const has = !future && this._dayHasFlow(key);
        const cls = [
          "cal-day",
          future ? "future" : "",
          !future && !has ? "empty" : "",
          key === todayKey ? "today" : "",
          key === selected ? "sel" : "",
        ].filter(Boolean).join(" ");
        const title = future
          ? this._t("This day has not happened yet", "这一天还没到")
          : has
            ? this._t("An energy flow was recorded", "该日有能量流记录")
            : this._t("No energy flow was recorded", "该日没有能量流记录");
        cells.push(html`
          <button class=${cls} ?disabled=${future} title=${title}
            @click=${(event) => { event.stopPropagation(); this._pickDay(key); }}>${day}</button>`);
      }

      const [todayYear, todayMonth] = todayKey.split("-").map(Number);
      const atNowMonth = year > todayYear
        || (year === todayYear && mon >= todayMonth - 1);

      return html`
        <div class="cal" role="dialog">
          <div class="cal-head">
            <button class="cal-nav"
              @click=${(event) => { event.stopPropagation(); this._shiftCalendar(-1); }}>‹</button>
            <span class="cal-month">${this._monthLabel(month)}</span>
            <button class="cal-nav" ?disabled=${atNowMonth}
              @click=${(event) => { event.stopPropagation(); this._shiftCalendar(1); }}>›</button>
          </div>
          <div class="cal-grid cal-week">
            ${this._weekdayLabels().map((w) => html`<span class="cal-wd">${w}</span>`)}
          </div>
          <div class="cal-grid">${cells}</div>
          <div class="cal-legend">
            <span class="lg has"></span>${this._t("has data", "有数据")}
            <span class="lg empty"></span>${this._t("no data", "无数据")}
          </div>
        </div>`;
    }

    /* ---------------------------- graph layout --------------------------- */

    /**
     * Lay out the diagram from the nine measurements.
     *
     * A node's height is the sum of the flows that touch it, so both columns
     * always add up to the same total: the device reports both ends of every
     * flow, and nothing has to be estimated, balanced or hidden in a "loss"
     * node.
     */
    _buildGraph(readings) {
      const cfg = this._config || {};
      const EPS = EMPTY_EPS; // kWh - below this a flow is noise, not a ribbon

      const table = {};
      const srcValue = {};
      const snkValue = {};
      let total = 0;
      for (const flow of FLOWS) {
        const value = num(readings[flow.id]);
        /* Accumulate, do not assign: two measurements can now feed the same
           pair of nodes (pv_e2b + pv_tp2b both become pv -> bat_in).  Plain
           assignment would keep only the last one and quietly drop energy. */
        const key = `${flow.from}|${flow.to}`;
        table[key] = (table[key] || 0) + value;
        srcValue[flow.from] = (srcValue[flow.from] || 0) + value;
        snkValue[flow.to] = (snkValue[flow.to] || 0) + value;
        total += value;
      }

      const srcs = SOURCES
        .map((d) => ({ ...d, value: srcValue[d.id] || 0 }))
        .filter((d) => d.value > EPS);
      const snks = SINKS
        .map((d) => ({ ...d, value: snkValue[d.id] || 0 }))
        .filter((d) => d.value > EPS);

      if (total <= EPS || !srcs.length || !snks.length) {
        return { empty: true, total: 0 };
      }

      // Each column fills the chart height on its own: the left column stacks
      // the sources, the right column the sinks.
      const leftFit = fitScale(srcs.map((d) => d.value), CHART_H);
      const rightFit = fitScale(snks.map((d) => d.value), CHART_H);

      const stack = (items, fit) => {
        let y = PAD_TOP;
        return items.map((item) => {
          const h = Math.max(fit.minH, item.value * fit.scale);
          const node = { ...item, y, h };
          y += h + GAP;
          return node;
        });
      };

      const srcNodes = stack(srcs, leftFit);
      const snkNodes = stack(snks, rightFit);

      /* Ribbons cover their node box completely.
         The thickness used to be value * a column-wide scale, so a node whose
         height was clamped up to MIN_NODE_H (or one that simply did not fill
         the column) had its ribbons bunched in the middle of the box with card
         colour above and below them - the flow looked like it started from a
         point inside the box instead of from the box's whole edge.  Now each
         end is scaled by the node it touches: (value / node.value) * node.h,
         so the ribbons of one node always add up to exactly its height and
         leave/enter flush with the top and bottom edges, as in the vendor app.
         The ribbon then tapers between its two ends, which is what makes the
         diagram read as flow rather than as spaghetti. */
      const gapPx = num(cfg.ribbon_gap != null ? cfg.ribbon_gap : 0);
      const flows = [];
      const srcCursor = srcNodes.map((n) => n.y);
      const snkCursor = snkNodes.map((n) => n.y);

      for (let i = 0; i < srcNodes.length; i += 1) {
        for (let j = 0; j < snkNodes.length; j += 1) {
          const value = table[`${srcNodes[i].id}|${snkNodes[j].id}`] || 0;
          if (!(value > EPS)) continue;
          const hL = (value / srcNodes[i].value) * srcNodes[i].h;
          const hR = (value / snkNodes[j].value) * snkNodes[j].h;
          if (hL < 0.7 && hR < 0.7) continue;
          const insetL = hL > gapPx * 2.5 ? gapPx / 2 : 0;
          const insetR = hR > gapPx * 2.5 ? gapPx / 2 : 0;
          /* Height of both ends, kept so the highlight can print a share at
             each end, centred on the ribbon it belongs to. */
          const topL = srcCursor[i] + insetL;
          const topR = snkCursor[j] + insetR;
          const hgtL = Math.max(0.6, hL - insetL * 2);
          const hgtR = Math.max(0.6, hR - insetR * 2);
          flows.push({
            path: ribbon(RIBBON_L, topL, hgtL, RIBBON_R, topR, hgtR),
            yL: topL + hgtL / 2,
            yR: topR + hgtR / 2,
            /* Share denominators: how much the whole node carries, so a
               highlighted node can say "61 of 69 Wh = 88.4 %". */
            srcValue: srcNodes[i].value,
            snkValue: snkNodes[j].value,
            /* Both ends, because the ribbon is painted as a gradient between
               them: it leaves the source in the source's colour and arrives at
               the sink in the sink's - which is what makes a crossing diagram
               readable, instead of seven ribbons in four flat colours. */
            color: srcNodes[i].color,
            toColor: snkNodes[j].color,
            value,
            srcId: srcNodes[i].id,
            snkId: snkNodes[j].id,
            from: this._label(srcNodes[i]),
            to: this._label(snkNodes[j]),
          });
          srcCursor[i] += hL;
          snkCursor[j] += hR;
        }
      }

      return { empty: false, total, srcs: srcNodes, snks: snkNodes, flows };
    }

    /* ------------------------------ rendering ---------------------------- */

    /**
     * One node: a colour block (glyph + value + unit + share of the day) and its
     * name printed next to it, on top of the ribbons.
     *
     * The name used to sit on a flat tinted rectangle, then on a gradient that
     * faded out of the node colour, and finally on the bare card background.
     * None of them worked, because the real problem was the column itself: a
     * fixed 158px strip kept free for the text showed the card colour all the
     * way down the chart, and a tall node turned that strip into a pale slab.
     * Now the ribbons start at the node box and the text is painted over them,
     * with a thin card-coloured halo so it stays legible on any ribbon.
     *
     * The glyph is a coloured SVG pictogram printed on a soft dark plate, not an
     * emoji: an emoji is drawn by the platform's own font, so it arrived with
     * its own colours and shadows and a different size on every OS, none of
     * which matched the box it sat on.
     */
    _nodeBox(node, boxX, chipX, chipAnchor, shareBase, info) {
      const color = node.color;
      const label = node.label || this._label(node);
      const uid = `${this._uid}-${node.side}-${node.id}`;
      const cx = boxX + NODE_W / 2;
      const custom = (this._config.icons || {})[node.id];
      const glyph = GLYPH[node.id] || GLYPH_FALLBACK;
      const showGlyph = node.h >= 50;
      const inner = [];
      const key = `${node.side}:${node.id}`;

      /* One rhythm for every box, whatever its height: a soft dark plate pinned
         to the TOP of the node, the icon printed straight onto that plate, the
         energy reading just below the icon (mid-plate, a touch low), and the
         share hugging the bottom edge of the node.

         The plate replaced the white circular badge: a 21 px disc in a 68 px
         box looked like a sticker, its drop shadow only traced the circle, and
         the icon inside it competed with the colour block behind.  A rectangle
         spanning the box width reads as one recessed panel, the icon sits on it
         like a crest, and the three parts (icon / energy / share) share one
         vertical axis for all six nodes. */
      const PLATE_X = 4;
      const PLATE_Y = 3;
      const PLATE_W = NODE_W - PLATE_X * 2;
      /* Height for the icon only: 26 px gives a 5 px radius around an 18 px
         drawing without clipping it.  The plate is a header for the glyph, not
         a panel for data - its 46 px version also held the energy number and
         pushed that reading into the dark area. */
      const PLATE_H = 26;
      const plateTop = node.y + PLATE_Y;
      const iconCY = plateTop + PLATE_H / 2;
      /* Bigger than the old badge glyph (0.62): without a white disc around it, a
         15 px drawing had no presence on a 60 px plate. */
      const G_SCALE = 0.78;
      const gx = cx - (24 * G_SCALE) / 2;
      const gy = iconCY - (24 * G_SCALE) / 2;
      /* "Mid-plate, a touch low" no longer applies: the reading is on the node
         colour, right under the plate - the 12 px offset keeps it clear of the
         panel's shadow. */
      const valueY = plateTop + PLATE_H + 12;
      /* The share is not on the plate - it sits at the very bottom of the node,
         which is what makes the box read as three stacked bands. */
      const pctY = node.y + node.h - 5;

      // Selection: the node that touches the highlighted flow(s) stays at full
      // strength while everything else fades.  No outline: a 2.5px ring around
      // the box read as a black frame bolted onto the diagram, and the contrast
      // between 100 % and 38 % opacity already says which part is highlighted.
      const isSel = !!info && info.nodeKeys.has(key);
      const isDim = !!info && !isSel;

      /* The plate first: everything else is painted on top of it.  A custom
         `icons:` entry is plain text (it may be an emoji the user chose), so it
         keeps the text path. */
      if (showGlyph) {
        inner.push(`<rect x="${boxX + PLATE_X}" y="${plateTop}" width="${PLATE_W}"
          height="${PLATE_H}" rx="5" fill="#000" fill-opacity="0.20"
          filter="url(#${uid}-sh)"/>`);
        if (custom) {
          inner.push(`<text x="${cx}" y="${iconCY + 5}" text-anchor="middle"
            font-size="13" fill="#fff">${esc(custom)}</text>`);
        } else {
          inner.push(`<g transform="translate(${gx} ${gy}) scale(${G_SCALE})"
            >${glyph}</g>`);
        }
      }
      /* Inside the box the text is plain body colour on the node colour: no
         white, and no darker strip behind the share line - that band was there
         to keep white text readable, and with dark text it just looked like a
         shadow draped over the bottom of the node. */
      const INK = "#111";
      inner.push(`<text x="${cx}" y="${valueY}" text-anchor="middle" font-size="13"
        fill="${INK}">${esc(fmtEnergy(node.value))}</text>`);
      if (node.h >= 40) {
        inner.push(`<text x="${cx}" y="${pctY}" text-anchor="middle" font-size="11"
          fill="${INK}" fill-opacity="0.85">${esc(fmtPct(node.value, shareBase))}</text>`);
      }

      /* The name is plain text painted over the ribbons, right against its box.
         No halo, no plate: a stroke around the glyphs reads as an outline at any
         width, and the card already sits on a light surface so the body text
         keeps its contrast against the 50 % ribbons. */
      const chipTextX =
        chipAnchor === "end" ? chipX - LABEL_INSET : chipX + LABEL_INSET;
      /* While something is highlighted, the names on the annotated side drop
         out: the per-ribbon shares are printed in that very strip, and on a
         short box the two land on the same baseline.  The dimmed nodes on the
         other side keep their names - they fade with the group, so they no
         longer out-shout the highlight. */
      const hideName = !!info &&
        (info.mutedSides.indexOf(node.side) >= 0 || info.mutedNames.has(key));
      const name = hideName
        ? ""
        : `<text x="${chipTextX}" y="${node.y + node.h / 2 + 4.5}" text-anchor="${chipAnchor}"
          font-size="12.5" fill="var(--primary-text-color, #212121)">${esc(label)}</text>`;

      return `<g class="node${isDim ? " dim" : ""}" data-node="${esc(key)}">
        <defs><filter id="${uid}-sh" x="-25%" y="-30%" width="150%" height="180%">
          <feDropShadow dx="0" dy="1.6" stdDeviation="2.1" flood-color="#000"
            flood-opacity="0.34"/>
        </filter></defs>
        <clipPath id="${uid}"><rect x="${boxX}" y="${node.y}" width="${NODE_W}"
          height="${node.h}"></rect></clipPath>
        <rect x="${boxX}" y="${node.y}" width="${NODE_W}" height="${node.h}"
          fill="${color}"><title>${esc(`${label}: ${fmtEnergy(node.value)}`)}</title></rect>
        <g clip-path="url(#${uid})">${inner.join("")}</g>
        ${name}
      </g>`;
    }

    /** True when `flow` should stay lit for the current selection. */
    _flowSelected(flow, sel) {
      if (!sel) return false;
      if (sel.kind === "flow") return flow.srcId === sel.from && flow.snkId === sel.to;
      return flow.srcId === sel.id || flow.snkId === sel.id;
    }

    /**
     * Resolve `_selected` against the current graph.
     * Returns null when nothing is highlighted (or the highlight no longer
     * matches any ribbon, e.g. after the device stopped using that port).
     */
    _selectionInfo(graph) {
      const sel = this._selected;
      if (!sel || !graph || graph.empty) return null;
      const flows = graph.flows.filter((f) => this._flowSelected(f, sel));
      if (!flows.length) return null;
      let node = null;
      if (sel.kind === "node") {
        node = [...graph.srcs, ...graph.snks]
          .find((n) => n.id === sel.id && n.side === sel.side) || null;
        if (!node) return null;
      }
      const nodeKeys = new Set();
      for (const f of flows) {
        nodeKeys.add(`src:${f.srcId}`);
        nodeKeys.add(`snk:${f.snkId}`);
      }
      /* The shares are printed in the strip the node NAME occupies, so the names
         on the annotated side step aside while something is highlighted: a node
         highlight annotates one whole column (its out-flows on the left, its
         in-flows on the right), a single-ribbon highlight annotates both ends
         and therefore only the two endpoint names have to go.  The other column
         keeps its names (faded with the rest of the diagram), so the picture is
         never nameless. */
      const mutedSides = sel.kind === "node" ? [sel.side] : [];
      const mutedNames = new Set();
      if (sel.kind !== "node") {
        for (const f of flows) {
          mutedNames.add(`src:${f.srcId}`);
          mutedNames.add(`snk:${f.snkId}`);
        }
      }
      return { sel, flows, node, nodeKeys, mutedSides, mutedNames };
    }

    _chart(graph) {
      const base = num(
        this._config.ribbon_opacity != null ? this._config.ribbon_opacity : 0.58
      );
      const info = this._selectionInfo(graph);
      const parts = [];
      const defs = [];

      /* Ribbons first so the node boxes are drawn on top of them.
         Each ribbon is filled with its OWN gradient, running from the source
         colour to the sink colour: with four flat source colours a diagram where
         everything happens to come from the grid is a wall of one blue, and the
         eye cannot tell a ribbon going to the battery from one going to the load.
         The gradient carries both ends, so neither direction has to be guessed. */
      graph.flows.forEach((f, i) => {
        const gid = `${this._uid}-fl-${i}`;
        defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse"
          x1="${RIBBON_L}" y1="0" x2="${RIBBON_R}" y2="0">
          <stop offset="0" stop-color="${f.color}"/>
          <stop offset="1" stop-color="${f.toColor}"/>
        </linearGradient>`);
        const isSel = !!info && info.flows.indexOf(f) >= 0;
        const opacity = !info ? base : isSel ? Math.min(1, base + 0.4) : Math.max(0.06, base * 0.16);
        parts.push(`<path class="ribbon" d="${f.path}" fill="url(#${gid})"
          fill-opacity="${opacity.toFixed(3)}" data-flow="${esc(f.srcId)}|${esc(f.snkId)}"
          ><title>${esc(`${f.from} \u2192 ${f.to}: ${fmtEnergy(f.value)}`)}</title></path>`);
      });

      for (const node of graph.srcs) {
        parts.push(this._nodeBox(node, LEFT_X, LEFT_CHIP_X, "start", graph.total, info));
      }
      for (const node of graph.snks) {
        parts.push(this._nodeBox(node, RIGHT_X, RIGHT_CHIP_X, "end", graph.total, info));
      }

      /* Highlight: each involved ribbon gets its share of the node it touches,
         printed on the ribbon at that end - "88.4 %" for the 61 Wh that leaves
         a 69 Wh source, "11.6 %" for the remainder.  Highlighting a node shows
         the shares at that node only (its out-flows on the left, its in-flows
         on the right); highlighting one ribbon shows both ends, because then
         both the split of its source and its weight in its sink are wanted.
         The names of that column are suppressed (see _selectionInfo), so the
         numbers are not competing with the labels they replace. */
      if (info) {
        const sides = info.sel.kind === "flow" ? ["src", "snk"] : [info.sel.side];
        for (const f of info.flows) {
          if (sides.indexOf("src") >= 0) {
            parts.push(`<text class="fpct" x="${RIBBON_L + 9}" y="${f.yL + 4.2}"
              text-anchor="start" font-size="12.5"
              fill="var(--primary-text-color, #212121)">${esc(fmtPct(f.value, f.srcValue))}</text>`);
          }
          if (sides.indexOf("snk") >= 0) {
            parts.push(`<text class="fpct" x="${RIBBON_R - 9}" y="${f.yR + 4.2}"
              text-anchor="end" font-size="12.5"
              fill="var(--primary-text-color, #212121)">${esc(fmtPct(f.value, f.snkValue))}</text>`);
          }
        }
      }

      return `<svg viewBox="0 0 ${VB_W} ${VB_H}" role="img"
        aria-label="${esc(this._t("Energy flow", "能量流"))}"><defs>${defs.join("")}</defs>${
        parts.join("")}</svg>`;
    }

    /** Detail panel for the current highlight (empty when nothing is selected). */
    _detailBar(graph) {
      const info = this._selectionInfo(graph);
      if (!info) return "";
      const { flows, node, sel } = info;
      const sum = flows.reduce((acc, f) => acc + f.value, 0);

      let head;
      if (node) {
        head = `${node.label || this._label(node)} \u00B7 ${fmtEnergy(node.value)} \u00B7 ${fmtPct(node.value, graph.total)}`;
      } else {
        const f = flows[0];
        head = `${f.from} \u2192 ${f.to} \u00B7 ${fmtEnergy(f.value)} \u00B7 ${fmtPct(f.value, graph.total)}`;
      }

      const chips = flows
        .slice()
        .sort((a, b) => b.value - a.value)
        .map((f) => {
          const dir = node ? (sel.side === "src" ? "\u2192" : "\u2190") : "\u2192";
          const other = node
            ? (sel.side === "src" ? f.to : f.from)
            : `${f.from} \u2192 ${f.to}`;
          return `<span class="chip"><i style="background:${f.color}"></i>${esc(
            `${dir} ${other} ${fmtEnergy(f.value)}`
          )}</span>`;
        })
        .join("");

      const total = flows.length > 1
        ? ` \u00B7 ${esc(this._t("total", "合计"))} ${esc(fmtEnergy(sum))}`
        : "";

      return `<div class="detail">
        <div class="dhead">${esc(head)}${total}</div>
        <div class="dflows">${node ? chips : ""}</div>
        <div class="dhint">${esc(this._t("Click again to clear.", "再次点击取消高亮。"))}</div>
      </div>`;
    }

    _sameSelection(a, b) {
      if (!a || !b || a.kind !== b.kind) return false;
      if (a.kind === "flow") return a.from === b.from && a.to === b.to;
      return a.side === b.side && a.id === b.id;
    }

    _onClick(event) {
      // Click-to-highlight: a ribbon, or any ribbon of a node box.
      const flowEl = event.target.closest("[data-flow]");
      const nodeEl = event.target.closest("[data-node]");
      if (flowEl || nodeEl) {
        let next;
        if (flowEl) {
          const [from, to] = String(flowEl.dataset.flow).split("|");
          next = { kind: "flow", from, to };
        } else {
          const raw = String(nodeEl.dataset.node);
          const at = raw.indexOf(":");
          next = { kind: "node", side: raw.slice(0, at), id: raw.slice(at + 1) };
        }
        this._selected = this._sameSelection(this._selected, next) ? null : next;
        this.requestUpdate();
        return;
      }

      // Clicking empty diagram space clears the highlight.
      if (this._selected && event.target.closest("svg")) {
        this._selected = null;
        this.requestUpdate();
      }
    }

    render() {
      if (!this._config) return html``;
      // No meter: the card is not shown at all.  The grid flows would all be
      // zero, so the picture would claim the unit never imports or exports.
      if (this._hidden) return html``;
      const title = this._text(this._config.title) || this._t("Energy flow", "能量流");
      const graph = this._graph;
      // Whether the diagram on screen is an archived day rather than the live
      // cumulative.  It only changes the wording: the picture is the same one.
      const archived = !!this._day && this._day !== this._today();

      let body;
      if (this._dayMissing) {
        body = html`<div class="msg">${this._noMeterDay
          ? this._t("No grid meter was connected that day.",
            "该日未接入电表，没有能量流记录。")
          : archived
            ? this._t("No record for this day.", "该日没有记录。")
            : this._t("Nothing recorded yet today.", "今日还没有记录。")}</div>`;
      } else if (this._missing) {
        body = html`<div class="msg">${this._t(
          "No energy flow data for this device.",
          "暂无该设备的能量流数据。"
        )}</div>`;
      } else if (!graph) {
        body = html`<div class="msg">${this._t("No data yet.", "暂无数据。")}</div>`;
      } else if (graph.empty) {
        body = html`<div class="msg">${archived
          ? this._t("No energy recorded on this day.", "该日暂无能量记录。")
          : this._t("No energy recorded today.", "今日暂无能量记录。")}</div>`;
      } else {
        body = html`
          ${this._untrusted(this._chart(graph))}
          ${this._untrusted(this._detailBar(graph))}
        `;
      }

      return html`
        <ha-card @click=${this._handleClick}>
          <div class="head">
            <span class="title">${this._icon(this._config.icon)}${title}</span>
            <div class="hright">${this._dayNav()}</div>
          </div>
          ${body}
        </ha-card>
      `;
    }

    /**
     * Mirror `_hidden` onto the host element.
     *
     * Returning an empty template empties the shadow root but keeps the custom
     * element's own layout box, so Home Assistant's card wrapper still reserved
     * a row of blank space where the sankey used to be. `hidden` is what the
     * alarms card uses for the same purpose, and it is what makes the wrapper
     * collapse so the cards below move up.
     */
    updated() {
      this.hidden = this._hidden === true;
    }

    /**
     * The header icon: a named SVG from the built-in set, or plain text.
     *
     * A name that is not in the set falls through to text, which keeps an
     * emoji config working.  The SVG is injected as a string: a `<path>` built
     * inside a lit template is parsed in the HTML namespace and never paints,
     * while the HTML parser handles SVG foreign content correctly.
     */
    _icon(name) {
      if (!name) return "";
      const build = ICON_SVG[name];
      if (!build) return esc(String(name));
      const uid = "hms" + (this._iconSeq = (this._iconSeq || 0) + 1) + "-";
      const svg = `<svg viewBox="0 0 24 24" width="19" height="19" `
        + `xmlns="http://www.w3.org/2000/svg">${build(uid)}</svg>`;
      return this._untrusted(svg);
    }

    /**
     * Build a TrustedHTML-free fragment.
     * The SVG is rendered via innerHTML because Lit has no cheap SVG builder
     * here; every interpolated value goes through `esc()` in `_chart`.
     */
    _untrusted(markup) {
      const template = document.createElement("template");
      template.innerHTML = markup;
      return template.content.cloneNode(true);
    }
  }

  /* ------------------------------------------------------------------ *
   * Visual editor
   * ------------------------------------------------------------------ */
  class HoymilesEnergySankeyEditor extends LitElement {
    static get properties() {
      return { _config: { type: Object }, hass: { type: Object } };
    }

    setConfig(config) {
      this._config = { ...config };
    }

    _valueChanged(field) {
      return (event) => {
        const config = { ...this._config, [field]: event.target.value };
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config } }));
      };
    }

    static get styles() {
      return css`
        .row { padding: 8px; }
        ha-textfield, ha-select { display: block; width: 100%; }
      `;
    }

    render() {
      const config = this._config || {};
      return html`
        <div class="row">
          <ha-textfield label="dev_id" .value=${config.dev_id || ""}
            @change=${this._valueChanged("dev_id")}></ha-textfield>
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._valueChanged("title")}></ha-textfield>
          <ha-textfield label="icon (flow | sankey | swap, or any text)"
            .value=${config.icon || ""}
            @change=${this._valueChanged("icon")}></ha-textfield>
          <ha-textfield label="ribbon_opacity (0..1)" .value=${config.ribbon_opacity || ""}
            @change=${this._valueChanged("ribbon_opacity")}></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-energy-sankey-editor")) {
    customElements.define("hoymiles-energy-sankey-editor", HoymilesEnergySankeyEditor);
  }
  if (!customElements.get("hoymiles-energy-sankey")) {
    customElements.define("hoymiles-energy-sankey", HoymilesEnergySankey);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-energy-sankey")) {
    window.customCards.push({
      type: "hoymiles-energy-sankey",
      name: "Hoymiles Energy Flow (Sankey)",
      description:
        "Sankey diagram of the energy flow the device measured, day by day (V0.6.2).",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmSankeyRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmSankeyRegister());
}
