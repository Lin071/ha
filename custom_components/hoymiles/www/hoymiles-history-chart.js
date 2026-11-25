/* ============================================================================
 * Hoymiles Micro Storage — History chart card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-history-chart`
 *
 * A power / SOC chart with a 日 / 月 / 年 selector and a date navigator, drawn
 * like the vendor app's history pages:
 *
 *   - every series is filled from the zero line; power / energy series stack
 *     (positive values stacking up, negative values stacking down, so a
 *     charge/discharge sensor reads naturally on both sides of the axis);
 *   - a *level* such as SOC is drawn overlaid instead, because stacking two
 *     packs at 81 % would put the second curve at 81..162 % and the third at
 *     162..243 %, pushing everything but the first off a 0..100 axis. The
 *     `stack` option makes the choice explicit;
 *   - the y axis is symmetric around 0 and auto-scales to whatever is on
 *     screen - the whole period at first, then the zoomed window. A fixed
 *     range drew an idle 90 W evening as a flat hairline under a ±2500 W
 *     axis. Units are kept as W / Wh until the range passes 10 000, and only
 *     then promoted to kW / MWh: at 1.5 kW a 92 W load already read
 *     "0.09 kW", which hides the very digits this chart exists to show;
 *   - hovering shows a guide line and the value of every series, and the same
 *     timestamp is mirrored on every card that shares a `sync_group`;
 *   - clicking a legend entry shows **only** that series and hides the rest
 *     (clicking it again, or the chart, brings them all back). Dimming was not
 *     enough: three faint curves on top of each other are still unreadable;
 *   - the wheel zooms the time axis around the pointer, drag pans and a double
 *     click restores the whole period. Zooming redraws the already-fetched
 *     series, so it is immediate and costs no recorder query.
 *
 * Data comes from the Home Assistant recorder (long term statistics) through
 * the public websocket command `recorder/statistics_during_period`. The card
 * never touches the database itself, and `recorder` has to be enabled.
 *
 * Card config:
 *   type: custom:hoymiles-history-chart
 *   dev_id: MSA-280520260806        # optional when every series names an entity
 *   title: History
 *   language: en                    # optional (en|zh|de); omit to follow Home Assistant
 *   range: day                      # initial range (day|month|year)
 *   height: 330                     # optional svg height in px
 *   unit: W                         # optional unit label (auto-promotes past 10 kW)
 *   zero_line: true                 # optional, draw the 0 line (default true)
 *   symmetric: true                 # optional; false draws a bottom-up axis
 *                                   # (use it for SOC: min 0 / max 100)
 *   stack: true                     # optional; false overlays the curves
 *                                   # instead of stacking them. Defaults to
 *                                   # the value of `symmetric`, so a bottom-up
 *                                   # axis (SOC, temperature) overlays - a
 *                                   # level must never stack.
 *   min / max: 0 / 100              # optional fixed axis limits
 *   span: 2500                      # optional; pins the half-range. Omit it
 *                                   # and the axis follows the data instead
 *   sync_group: living-room         # optional; cards sharing a group share
 *                                   # their time window (range + date)
 *   show_toolbar: false             # optional; hide this card's own toolbar
 *                                   # (use it on the followers)
 *   skip_empty: true                # optional (default true); drop a series
 *                                   # that recorded nothing in the period, so
 *                                   # a copied dashboard does not draw empty
 *                                   # battery packs / PV ports as 0
 *   zoom: false                     # optional; disable wheel zoom / drag pan
 *   series:                         # required, one entry per curve
 *     - entity: sensor.x_pv_power
 *       name: 发电功率
 *       color: "#22c55e"
 *     - entity: sensor.x_system_battery_power
 *       name: 放电[+]/充电[-]
 *       color: "#4a90d9"
 *
 * A curve can be made conditional on the device's capabilities, which is how
 * one template serves a unit with a grid meter and one without:
 *
 *     - entity: sensor.x_system_grid_power
 *       while:  { entity: sensor.x_energy_flow_today, attribute: has_meter }
 *     - entity: sensor.x_grid_on_power
 *       unless: { entity: sensor.x_energy_flow_today, attribute: has_meter }
 *
 * `while` keeps the curve only while the condition is **true**; `unless` keeps
 * it unless the condition is true, so an unknown attribute (before the first
 * snapshot after a restart) falls back to the `unless` curve - the combined one
 * - instead of leaving the chart with neither.
 * ========================================================================== */

/**
 * Register the card.
 *
 * `litElement` is supplied by `window.__hmWhenLit(cb)`. That hook exists
 * because `ha-panel-lovelace` is **not** defined on every page, and even on a
 * dashboard it may not be defined yet at the moment the bootstrap says Lit is
 * ready. Reading the base class from it unconditionally threw
 * `Object.getPrototypeOf(undefined)`, which aborted registration and surfaced
 * on the dashboard as "Custom element doesn't exist" - so the class is taken
 * from the caller when it offers one.
 */
function _hmHistoryRegister(litElement) {
  let LitElement = litElement || null;
  if (!LitElement) {
    const base = customElements.get("ha-panel-lovelace");
    if (!base) return false;
    LitElement = Object.getPrototypeOf(base);
  }
  if (!LitElement || !LitElement.prototype || !LitElement.prototype.html) return false;
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
    "Home Assistant is not connected。": "Home Assistant ist nicht verbunden.",
    "Statistics are unavailable — is the recorder enabled?": "Statistiken sind nicht verfügbar – ist der Recorder aktiviert?",
    "History Data": "Verlauf",
    "Previous": "Zurück",
    "Next": "Weiter",
    "Loading…": "Wird geladen…",
    "No statistics recorded for this period。": "Für diesen Zeitraum wurden keine Statistiken aufgezeichnet.",
    "Scroll to zoom · drag to pan · double-click to reset": "Scrollen zum Zoomen · ziehen zum Verschieben · Doppelklick zum Zurücksetzen",
    "Zoomed": "Gezoomt",
    "Reset": "Zurücksetzen",
    "Click to show this curve": "Klicken, um diese Kurve einzublenden",
    "Click to hide this curve": "Klicken, um diese Kurve auszublenden",
    "Pick a day": "Tag wählen",
    "This day has not happened yet": "Dieser Tag liegt noch in der Zukunft",
    "No statistics recorded": "Keine Statistiken aufgezeichnet",
    "Statistics recorded": "Statistiken aufgezeichnet",
    "has data": "mit Daten",
    "no data": "ohne Daten",
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
   *     en: History
   *     zh: 历史数据
   *   series:
   *     - entity: sensor.x
   *       name:
   *         en: PV power
   *         zh: 发电功率
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
   * Layout / behaviour constants
   * ------------------------------------------------------------------ */
  /* `VB_W` is only the drawing width used before the card has been measured.
   * The charts fill their card via `preserveAspectRatio="none"`, which would
   * squash every label horizontally (a 625 px card over a 1200 unit viewBox
   * compresses text to 52 % of its width). To keep text undistorted the viewBox
   * width follows the measured pixel width (`_vbW`), leaving the scale at 1:1.
   */
  const VB_W = 1200;
  const MIN_VB_W = 320;
  /* `ha-card` padding is `12px 16px 14px`, so the drawing area is this much
     narrower than the host. Only used before the svg exists. */
  const CARD_PAD_X = 32;
  const DEFAULT_H = 330;

  const PAD_L = 64;   // room for the y labels
  const PAD_R = 18;
  const PAD_T = 14;
  const PAD_B = 34;   // room for the x labels

  const RANGES = [
    { id: "day", en: "Day", zh: "日" },
    { id: "month", en: "Month", zh: "月" },
    { id: "year", en: "Year", zh: "年" },
  ];

  const DEFAULT_COLORS = ["#22c55e", "#4a90d9", "#22d3ee", "#f5a623", "#a78bfa"];

  /* ------------------------------------------------------------------ *
   * Entity id aliases
   *
   * Home Assistant names a firmware discovery entity after the payload's
   * `name`, not after the protocol key: §36 `bat_p` is called "Battery Power",
   * so its entity id is `..._battery_power` while the protocol key - and the
   * dashboard template written from it - says `..._bat_power`.  Pointing the
   * chart at an entity that does not exist made `skip_empty` drop the battery
   * curve, so the power chart showed PV and grid only.
   *
   * Both spellings are accepted, in both directions: a unit whose firmware
   * publishes the config keeps `battery_power`, while older installations still
   * carry the `bat_power` entity an earlier integration release created.  A
   * dashboard generated with either name therefore draws the same curve.
   * ------------------------------------------------------------------ */
  const ENTITY_ALIASES = [
    [/_bat_power$/, "_battery_power"],
    [/_battery_power$/, "_bat_power"],
  ];

  /** The entity id to read for a configured series, following the aliases. */
  function resolveEntity(hass, entityId) {
    const states = (hass && hass.states) || {};
    if (!entityId || states[entityId]) return entityId;
    for (const [pattern, replacement] of ENTITY_ALIASES) {
      if (!pattern.test(entityId)) continue;
      const candidate = entityId.replace(pattern, replacement);
      if (states[candidate]) return candidate;
    }
    return entityId;
  }

  /* ------------------------------------------------------------------ *
   * Time-window sharing.
   *
   * Cards that declare the same `sync_group` keep one window between them, so
   * a dashboard can pair e.g. a power chart with an SOC chart and drive both
   * from a single toolbar. The group holds the last window plus the set of
   * member cards; whichever card the user touches publishes to the others.
   * Membership is per DOM lifetime, so removing a card cannot leak.
   * ------------------------------------------------------------------ */
  const SYNC_GROUPS = new Map();

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  function num(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /** Like `num()`, but returns null for "there is no number here".
   *
   * `num()` deliberately reads anything unparsable as 0, which is right while
   * drawing (a missing point is 0 W) and wrong while deciding *whether a value
   * exists*: a sensor whose state is the string "unknown" would otherwise read
   * as a perfectly good 0, and every unsupported battery pack would count as
   * "reporting".
   */
  function numOrNull(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  /* `esc()` is only for the markup strings handed to `_untrusted()` (they go
   * through `innerHTML`, so they really do need escaping). Lit templates escape
   * their own text and attribute bindings, so wrapping a `${...}` inside a
   * `html` template in `esc()` would render `&amp;` on screen - a series called
   * "电网&负载" would read as "电网&amp;负载". */

  /** Round `value` up to a readable step on a 1 / 1.25 / 1.5 / 2 / 2.5 / 3 /
   * 4 / 5 / 6 / 8 / 10 × 10^n ladder.
   *
   * The coarse 1 / 2 / 5 / 10 ladder wasted up to 5x the data range: a day that
   * dipped to 2.2 kW produced a +-5 kW axis, so the curve was squeezed into the
   * bottom fifth of the plot and read as "almost nothing happened". The finer
   * ladder caps the waste at about 1.33x, which keeps the curve filling the
   * pane without putting the gridlines on odd numbers - every entry is a
   * multiple of 125, so the five labels (max, max/2, 0, -max/2, -max) and the
   * bottom-up ticks stay exact to at most two decimals.
   */
  const NICE_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

  function niceMax(value) {
    if (!(value > 0)) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(value)));
    const mantissa = value / exp;
    // The epsilon keeps 2 * 10^n from stepping up to 2.5 * 10^n when the
    // division lands a hair above the rung (e.g. 200.00000000000003 / 100).
    const step = NICE_STEPS.find((s) => mantissa <= s * (1 + 1e-9));
    return (step == null ? 10 : step) * exp;
  }

  /** Smallest number of decimals (0..3) that renders `step` exactly. */
  function decimalsFor(step) {
    const abs = Math.abs(step);
    if (!(abs > 0) || !Number.isFinite(abs)) return 0;
    for (let d = 0; d <= 3; d++) {
      if (Math.abs(abs - Number(abs.toFixed(d))) < abs * 1e-6) return d;
    }
    return 3;
  }

  function fmtNumber(value, decimals) {
    const text = num(value).toFixed(decimals);
    const parts = text.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
    return parts.join(".");
  }

  /** Pick a unit + divisor so the axis stays readable (W -> kW). */
  /*
     The divisor and the label have to move together: dividing by 1000 while
     still printing "W" turns a 2.5 kW curve into "2.50 W", which reads like a
     device that is barely producing. That was the bug here - the axis was
     scaled, the symbol was not.

     Only base units take a prefix. "kWh" is already scaled, and prefixing it
     again would be off by a factor of 1000, and "k%" is not a thing.

     The promotion thresholds are deliberately high (10 k). A home storage
     device spends most of its day around a few hundred watt, and the previous
     1.5 kW threshold turned that into "0.1 kW" / "0.09 kW" - a resolution of
     roughly 100 W, which flattens exactly the variation the chart is for.
     Keeping W up to 10 kW means the axis and the tooltip both show whole
     watts.
   */
  const PREFIXABLE_UNITS = ["W", "Wh", "VA", "VAh", "var", "varh", "A", "Ah", "V"];

  /** Largest prefix that keeps the number short, or "" when it is already short. */
  const UNIT_STEPS = [
    { scale: 1e6, prefix: "M", gap: 1e6 },
    { scale: 1e3, prefix: "k", gap: 1e4 },
    { scale: 1, prefix: "", gap: 0 },
  ];

  function pickUnit(unit, maxValue) {
    if (!unit) return { unit: "", divisor: 1, decimals: 1 };
    if (PREFIXABLE_UNITS.indexOf(unit) < 0) {
      return { unit, divisor: 1, decimals: 1 };
    }
    const abs = Math.abs(maxValue);
    for (const step of UNIT_STEPS) {
      if (abs >= step.gap) {
        return {
          unit: step.prefix + unit,
          divisor: step.scale,
          decimals: step.scale === 1 ? 0 : 1,
        };
      }
    }
    return { unit, divisor: 1, decimals: 1 };
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /**
   * Turn raw per-series value arrays into drawable bands.
   *
   * Kept out of `_build` so the same stacking rules apply when the legend
   * narrows the chart down to one series: the selected curve has to be drawn
   * from the zero line, not floating on top of the layers that are now hidden.
   *
   * Returns `{layers, max, min}`; `layers[i].pos` / `.neg` are `{base, top}`
   * arrays that the renderer turns into one filled band plus its edge stroke.
   */
  /**
   * Largest / smallest value actually drawn between two bucket indices.
   *
   * Reads the finished bands rather than the raw series, so the answer already
   * includes the stacking: the axis has to cover the top of the outermost
   * layer, not the individual curves. `base` is walked as well - a charge band
   * starts *below* the zero line, so its extreme sits at the base.
   */
  function windowExtent(layers, first, last) {
    let max = 0;
    let min = 0;
    if (!(last >= first)) return { max, min };
    for (const layer of layers) {
      for (const side of ["pos", "neg"]) {
        const band = layer[side];
        if (!band) continue;
        for (let i = first; i <= last; i += 1) {
          for (const arr of [band.top, band.base]) {
            const value = num(arr[i]);
            if (value > max) max = value;
            if (value < min) min = value;
          }
        }
      }
    }
    return { max, min };
  }

  /** Fallback half-range for a pane that has no data at all.
   *
   * An untouched PV port reads 0 W for the whole day, and auto-scaling that
   * gives a +-1 W axis whose labels (1.0 / 0.5 / 0.0) suggest a precision the
   * data does not have. A modest per-unit default reads as "nothing happened"
   * instead of "something is broken".
   */
  function idleSpan(unit) {
    const u = String(unit || "").toLowerCase();
    if (u === "wh" || u === "vah" || u === "varh") return 1000;
    if (u === "a" || u === "ah") return 10;
    if (u === "v") return 10;
    return 100;
  }

  function computeLayers(values, series, pane) {
    const symmetric = pane.symmetric !== false;
    /* Stacking depends on what the numbers *mean*, not on the axis. Power
       and energy series that add up (charge + discharge, per-phase power)
       stack; a level must never stack - with three packs at 81 % the second
       curve would be drawn at 81..162 % and the third at 162..243 %, so on a
       0..100 axis only the first stays visible, which reads as "Battery 2
       and 3 are wrong". `symmetric: false` is only ever used for such a
       level, so it defaults to overlay; `stack` overrides either way. */
    const stacked = pane.stack != null ? pane.stack !== false : symmetric;
    const len = values.length ? values[0].length : 0;
    const empty = () => new Array(len).fill(0);
    const add = (acc, other) => acc.map((v, k) => v + other[k]);

    let max = 0;
    let min = 0;
    let layers = [];

    if (symmetric) {
      // Positive parts grow upwards, negative parts grow downwards, which
      // keeps a charge/discharge sensor readable on both sides of the zero
      // line.
      const pos = values.map((vals) => vals.map((v) => (v > 0 ? v : 0)));
      const neg = values.map((vals) => vals.map((v) => (v < 0 ? v : 0)));

      if (stacked) {
        // Two independent stacks, each series riding on the ones before it.
        let runPos = empty();
        let runNeg = empty();
        const cums = pos.map((p, i) => {
          const layer = {
            posBase: runPos,
            negBase: runNeg,
            posTop: add(runPos, p),
            negTop: add(runNeg, neg[i]),
          };
          runPos = layer.posTop;
          runNeg = layer.negTop;
          return layer;
        });
        const last = cums[cums.length - 1];
        if (last) {
          last.posTop.forEach((v) => { if (v > max) max = v; });
          last.negTop.forEach((v) => { if (-v > max) max = -v; });
        }

        layers = series.map((s, i) => ({
          series: s,
          pos: { base: cums[i].posBase, top: cums[i].posTop },
          neg: { base: cums[i].negBase, top: cums[i].negTop },
        }));
      } else {
        // Overlaid: every curve grows from the zero line on its own.
        pos.forEach((p) => p.forEach((v) => { if (v > max) max = v; }));
        neg.forEach((n) => n.forEach((v) => { if (-v > max) max = -v; }));

        layers = series.map((s, i) => ({
          series: s,
          pos: { base: empty(), top: pos[i] },
          neg: { base: empty(), top: neg[i] },
        }));
      }
    } else if (stacked) {
      // One cumulative stack rising from the baseline (energy series).
      const cums = [];
      let run = empty();
      values.forEach((vals) => {
        cums.push([...run]);
        run = run.map((acc, k) => acc + vals[k]);
        cums.push([...run]);
      });
      run.forEach((v) => {
        if (v > max) max = v;
        if (v < min) min = v;
      });
      layers = series.map((s, i) => ({
        series: s,
        pos: { base: cums[i * 2], top: cums[i * 2 + 1] },
        neg: null,
      }));
    } else {
      // A level drawn bottom-up (SOC): every curve is plotted at its own
      // value so the series can be compared directly.
      values.forEach((vals) => vals.forEach((v) => {
        if (v > max) max = v;
        if (v < min) min = v;
      }));
      layers = series.map((s, i) => ({
        series: s,
        pos: { base: empty(), top: values[i] },
        neg: null,
      }));
    }

    return { layers, max, min };
  }

  /* ------------------------------------------------------------------ *
   * Horizontal zoom
   *
   * The card always fetches the whole period, then draws a sub-range of it.
   * Fetching again after every wheel tick would be both slow and pointless:
   * `recorder` keeps 5 minute statistics for a day at best, so zooming in
   * further cannot reveal more points, only more space per point.
   *
   * The zoom is stored as a fraction of the window (`{a, b}` in 0..1) rather
   * than as indices, so it survives a reload that happens to return a
   * different number of buckets.
   * ------------------------------------------------------------------ */

  /** Never narrower than this share of the window (~4 of 200 buckets). */
  const ZOOM_MIN_SPAN = 0.02;

  /** Wheel curve: `exp(deltaY * this)` gives ~1.25x per notch. */
  const ZOOM_WHEEL = 0.0022;

  /** Two clicks closer than this on the same plot count as a double click. */
  const DOUBLE_CLICK_MS = 350;

  /* A per-pack curve name as the dashboard template writes it: "Battery 1",
     "Batterie 1", "电池 1".  Matched whole, so a label that merely happens to
     end in a digit ("PV1") is left alone; the index is dropped only when the
     device actually has a single pack. */
  const SERIES_INDEX_NAME = /^(Battery|Batterie|电池包?)\s*\d+$/i;

  /** Resolve a zoom state against a bucket count, in fractional indices. */
  function zoomWindow(zoom, count) {    const last = Math.max(count - 1, 0);
    if (!zoom || last <= 0) {
      return { from: 0, to: last, narrow: false };
    }
    const a = Math.min(Math.max(num(zoom.a), 0), 1);
    const b = Math.min(Math.max(num(zoom.b), 0), 1);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return { from: lo * last, to: hi * last, narrow: hi - lo < 0.999 };
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function endOfDay(date) {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  /* ------------------------------------------------------------------ *
   * Card
   * ------------------------------------------------------------------ */
  class HoymilesHistoryChart extends LitElement {
    static get properties() {
      return {
        _config: { type: Object },
        _hass: { type: Object },
        _range: { type: String },
        _anchor: { type: Object },
        _data: { type: Object },
        _loading: { type: Boolean },
        _error: { type: String },
        _hoverTime: { type: Number },
        /* One entry per pane: the config indices of the curves the user has
           switched off. An empty list means "everything is drawn". */
        _hidden: { type: Array },
        _remoteTime: { type: Number },
        _vbW: { type: Number },
        _zoom: { type: Object },
      };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._panes = null;
      this._range = "day";
      this._anchor = new Date();
      this._data = null;
      this._loading = false;
      this._error = null;
      /* The guide line is shared by every pane, so the hover is stored as an
         absolute timestamp rather than a bucket index: two panes can have
         slightly different bucket grids when one of their series has a gap. */
      this._hoverTime = null;
      /* One entry per pane: which of that pane's curves are switched off. The
         legend is a set of switches (see `_toggleSeries`), so this is a list,
         not a single "highlighted" index. */
      this._hidden = [];
      this._remoteTime = null;
      this._token = 0;
      /* Horizontal zoom: `null` is the whole window, otherwise `{a, b}` as a
         fraction of it. Shared by every pane, because the panes share a time
         axis by definition. */
      this._zoom = null;
      /* In-flight drag-to-pan: the pointer x and the zoom it started from.
         `_dragging` is a plain field, not a reactive property on purpose: the
         mousedown that starts a pan must not re-render the pane, because lit
         would replace the <svg> and the browser would then drop the click that
         follows the mouseup (which is what broke double-click-to-reset). The
         class is written straight to the DOM instead. */
      this._drag = null;
      this._dragging = false;
      /* A drag ends with a click event; that one must not switch the curves
         back on while the user was only panning past. */
      this._suppressClick = false;
      this._onWindowUp = null;
      /* Click timing for the double-click-to-reset gesture. */
      this._lastClickAt = 0;
      this._lastClickPane = -1;
      /* viewBox width in CSS pixels; guarded so `_svg` works before mount. */
      this._vbW = VB_W;
      this._ro = null;
      this._syncJoined = null;
      /* Day picker (see `_calendar`): whether it is open, which month it shows,
         and which days of that month actually have statistics.  Plain fields
         plus `requestUpdate()` - none of it belongs to the card's state.

         `_availDays === null` means "we do not know" (the recorder query has not
         run, or failed), which must NOT be rendered as "every day is empty". */
      this._calOpen = false;
      this._calMonth = null;
      this._availKey = null;
      this._availDays = null;
      this._availPending = null;
    }

    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
      this._joinSync();
      this._watchWidth();
      /* A pan can end anywhere: outside the card, over another card, on the
         scrollbar. Listening on the window is the only way to always hear it. */
      this._onWindowUp = () => {
        if (this._dragging) this._resetDrag();
      };
      window.addEventListener("pointerup", this._onWindowUp);
      window.addEventListener("blur", this._onWindowUp);
      /* The day picker closes on any press outside the card.  `pointerdown`
         rather than `click`: the opening click happens first, so this listener
         can never close the picker it just opened. */
      this._onWindowDown = (event) => {
        if (this._calOpen && !event.composedPath().includes(this)) {
          this._calOpen = false;
          this.requestUpdate();
        }
      };
      window.addEventListener("pointerdown", this._onWindowDown);
    }

    disconnectedCallback() {
      if (this._onLangChange) {
        window.removeEventListener(LANG_EVENT, this._onLangChange);
      }
      super.disconnectedCallback();
      this._leaveSync();
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this._onWindowUp) {
        window.removeEventListener("pointerup", this._onWindowUp);
        window.removeEventListener("blur", this._onWindowUp);
        this._onWindowUp = null;
      }
      if (this._onWindowDown) {
        window.removeEventListener("pointerdown", this._onWindowDown);
        this._onWindowDown = null;
      }
    }

    /**
     * Keep the drawing width equal to the svg's pixel width.
     *
     * The svg is stretched by CSS (`width:100%` with a fixed pixel height), so
     * with `preserveAspectRatio="none"` a viewBox wider than the card squashes
     * the text horizontally. Measuring instead of hard-coding keeps the x scale
     * at 1 and the labels crisp at any card width.
     */
    _watchWidth() {
      if (typeof ResizeObserver !== "function" || this._ro) return;
      this._ro = new ResizeObserver(() => this._measure());
      this._ro.observe(this);
    }

    /**
     * Re-read the drawing width. Called after every render (the svg only exists
     * once there is data, and `_vbW` has to follow the first real layout) and by
     * the ResizeObserver (for later card resizes).
     */
    _measure() {
      const renderRoot = this.renderRoot;
      const svg = renderRoot ? renderRoot.querySelector("svg") : null;
      const svgWidth = svg ? svg.getBoundingClientRect().width : 0;
      const width = Math.round(svgWidth
        || this.getBoundingClientRect().width - CARD_PAD_X);
      if (width < MIN_VB_W) return;
      // 2 px of slack keeps rounding from ping-ponging the render.
      if (Math.abs(width - this._vbW) < 2) return;
      this._vbW = width;
      this.requestUpdate();
    }

    /** Current drawing width, falling back to the default before layout. */
    _width() {
      const width = this._vbW;
      return width >= MIN_VB_W ? width : VB_W;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-history-chart-editor");
    }

    static getStubConfig() {
      return { range: "day", series: [] };
    }

    static get styles() {
      return css`
        :host { display: block; }
        ha-card { padding: 12px 16px 14px; }
        /* Title on the left, toolbar on the right, on ONE line.
         *
         * The toolbar used to span the full width, which pushed the title onto
         * a second row where it sat directly above the first pane heading - the
         * two read as one title broken in half ("History" / "Power"). There is
         * room for both, so the toolbar now takes only what it needs and the
         * title keeps its own line. */
        .head { display: flex; flex-wrap: wrap; gap: 8px 12px;
                align-items: center; justify-content: space-between; }
        .title { font-size: 16px; font-weight: 600; white-space: nowrap;
                 color: var(--primary-text-color); }
        .head.no-title .title { display: none; }
        /* Toolbar, shaped like the vendor app's history pages: the date
           navigator on the left, the range picker on the right. */
        .toolbar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center;
                   margin-left: auto; }
        .toolbar select {
          font: inherit; font-size: 13px; color: var(--primary-text-color);
          background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color); border-radius: 10px;
          padding: 7px 10px; outline: none; cursor: pointer;
        }
        /* date navigator: one rounded pill holding ‹ date › */
        .toolbar .nav {
          display: flex; align-items: center; gap: 2px;
          border: 1px solid var(--divider-color); border-radius: 999px;
          padding: 2px; background: var(--card-background-color, #fff);
        }
        .toolbar .nav input {
          font: inherit; font-size: 13px; font-weight: 600;
          color: var(--primary-text-color);
          background: none; border: none; outline: none;
          padding: 5px 6px; text-align: center;
        }
        select:focus, input:focus { border-color: var(--primary-color); }
        .navbtn {
          width: 30px; height: 30px; border-radius: 50%; border: none;
          background: none; cursor: pointer; font: inherit;
          font-size: 15px; color: var(--primary-text-color); line-height: 1;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .navbtn:hover { background: var(--secondary-background-color, rgba(127,127,127,0.1)); }
        .navbtn:disabled { opacity: .35; cursor: default; background: none; }
        /* The day field: a button that looks like the date input it replaced,
           plus the calendar hanging under it.  position: relative on the host
           is what anchors the popover to the field instead of the card. */
        .dayhost { position: relative; display: inline-flex; }
        .daybtn {
          font: inherit; font-size: 13px; font-weight: 600;
          color: var(--primary-text-color); background: none;
          border: none; outline: none; padding: 5px 6px;
          text-align: center; cursor: pointer; border-radius: 7px;
          min-width: 96px; font-variant-numeric: tabular-nums;
        }
        .daybtn:hover { background: var(--secondary-background-color, rgba(127,127,127,0.1)); }
        .cal {
          position: absolute; top: calc(100% + 6px); left: 50%;
          transform: translateX(-50%); z-index: 60;
          width: 238px; padding: 8px 9px 7px; box-sizing: border-box;
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
        /* A day cell has THREE looks, and telling them apart is the point:
             - data recorded  -> normal text colour (--primary-text-color)
             - nothing recorded -> muted grey, still clickable (the chart then
               says so, which is honest and lets the user go back)
             - future -> muted grey and disabled, because there is nothing there
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
        .chart { margin-top: 8px; position: relative;
                 user-select: none; -webkit-user-select: none;
                 touch-action: none; }
        .chart svg { display: block; width: 100%; }
        /* The wheel zooms the time axis, so the affordance has to be visible:
           a grab cursor once there is something to pan, and a hard "zoomed"
           badge with the way back out. */
        .chart.zoomed { cursor: grab; }
        .chart.dragging { cursor: grabbing; }
        .chart.dragging svg { pointer-events: none; }
        .zhint { position: absolute; top: 6px; right: 8px;
                 display: inline-flex; align-items: center; gap: 6px;
                 font-size: 11px; color: var(--secondary-text-color);
                 background: var(--card-background-color, #fff);
                 border: 1px solid var(--divider-color); border-radius: 999px;
                 padding: 2px 4px 2px 9px; opacity: 0.92; }
        .zhint button { border: none; background: none; font: inherit;
                        color: var(--primary-color); cursor: pointer;
                        padding: 2px 7px; border-radius: 999px; }
        .zhint button:hover { background: var(--secondary-background-color, rgba(127,127,127,0.12)); }
        /* One chart block: heading, drawing, legend. */
        .pane + .pane { margin-top: 14px; padding-top: 12px;
                        border-top: 1px solid var(--divider-color); }
        /* A chart's own name, not a second card title: small, spaced, muted.
           Drawn at the card title's size it read as the rest of that title. */
        .ptitle { font-size: 11px; font-weight: 700; letter-spacing: .07em;
                  text-transform: uppercase; margin: 10px 0 0;
                  color: var(--secondary-text-color); }
        .axis { font-size: 11.5px; fill: var(--secondary-text-color); }
        .grid { stroke: var(--divider-color); stroke-width: 1; stroke-dasharray: 3 4; }
        .zero { stroke: var(--secondary-text-color); stroke-width: 1.1; opacity: 0.55; }
        .guide { stroke: var(--primary-color); stroke-width: 1; stroke-dasharray: 2 3;
                 opacity: 0.8; }
        .tipbox { fill: var(--card-background-color, #fff); stroke: var(--divider-color);
                  stroke-width: 1; }
        .tiptext { font-size: 12px; fill: var(--primary-text-color); }
        /* pill-shaped legend, like the app: colored disc inside a grey chip */
        .legend { display: flex; flex-wrap: wrap; gap: 8px 10px;
                  justify-content: center; margin-top: 10px; }
        .li { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px;
              color: var(--primary-text-color); cursor: pointer;
              border-radius: 999px; padding: 4px 13px 4px 5px;
              background: var(--secondary-background-color, rgba(127,127,127,0.12));
              transition: opacity .15s, background .15s, box-shadow .15s;
              user-select: none; }
        .li:hover { box-shadow: inset 0 0 0 1px var(--divider-color); }
        /* Each chip is a switch, so there is no "selected" look: a filled disc
           means drawn, a hollow one means switched off. The off chip fades as
           well, so the state is readable even for colour-blind users. */
        .li.off { opacity: 0.45; }
        .li.off .dot { border-width: 2px; }
        .dot { width: 17px; height: 17px; border-radius: 50%; flex: 0 0 auto;
               box-sizing: border-box;
               border: 2px solid var(--card-background-color, #fff); }
        .msg { font-size: 13px; color: var(--secondary-text-color); padding: 26px 2px;
               text-align: center; }
        .err { color: var(--error-color); }
        .spin { display: inline-block; width: 12px; height: 12px; margin-right: 6px;
                border: 2px solid var(--divider-color); border-top-color: var(--primary-color);
                border-radius: 50%; animation: sp 0.8s linear infinite; vertical-align: -2px; }
        @keyframes sp { to { transform: rotate(360deg); } }
      `;
    }

    setConfig(config) {
      if (!config || (!Array.isArray(config.series) && !Array.isArray(config.panes))) {
        throw new Error("hoymiles-history-chart: 'series' must list at least one entity");
      }
      if (!Array.isArray(config.panes) && !config.series.length) {
        throw new Error("hoymiles-history-chart: 'series' must list at least one entity");
      }
      this._config = { ...config };
      this._panes = this._normalizePanes(config);
      if (this._panes.some((p) => !p.series.length)) {
        throw new Error("hoymiles-history-chart: every pane needs at least one series");
      }
      this._hidden = this._panes.map(() => []);
      if (config.range) this._range = config.range;
      this._data = null;
      this._countSig = null;
      this._joinSync();
      // `hass` may already be set when the dashboard is edited in place.
      if (this._hass) {
        this._resolveEntities();
        this._fetch();
      }
    }

    /**
     * One card can draw several charts stacked under a single toolbar.
     *
     * `panes` is what makes two curves that share a time window read as one
     * block: side by side they each grew their own date picker, and nothing
     * told the reader the two were locked together.  A legacy config without
     * `panes` is treated as a single pane, so every existing dashboard keeps
     * working unchanged.
     */
    _normalizePanes(config) {
      const list = Array.isArray(config.panes) && config.panes.length
        ? config.panes
        : [config];
      return list.map((pane, index) => ({
        index,
        /* A legacy config carries its heading at the top level, and the card
           already draws that one in the header - repeating it as a pane heading
           would print the same text twice. */
        title: Array.isArray(config.panes) ? pane.title : false,
        series: (pane.series || []).map((s, i) => ({
          ...s,
          color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        })),
        unit: pane.unit,
        height: pane.height,
        symmetric: pane.symmetric,
        span: pane.span,
        min: pane.min,
        max: pane.max,
        stack: pane.stack,
        zero_line: pane.zero_line,
        /* Carried through explicitly: without this the option only ever read
           its default, so `skip_empty: false` could not be turned back off. */
        skip_empty: pane.skip_empty,
        /* How many of the listed series really exist on this device. */
        count_entity: pane.count_entity,
      }));
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      /* Follow the entity aliases before anything reads `series.entity`: the
         statistic query, `count_entity` and `skip_empty` all work on the id. */
      const renamed = this._resolveEntities();
      if (first && this._config) {
        this._countSig = this._countSignature();
        this._fetch();
      } else if (this._config && this._panes) {
        /* `count_entity` can start out unknown and turn numeric a minute later
           (a device that just woke up, a fresh install).  Without this the
           chart kept whatever series count the first fetch decided on. */
        const signature = this._countSignature();
        if (renamed || signature !== this._countSig) {
          this._countSig = signature;
          this._fetch();
        }
      }
      this.requestUpdate();
    }

    /**
     * Point every series at the entity id that actually exists.
     *
     * A dashboard generated before the `bat_power` / `battery_power` mismatch
     * was known still carries the wrong id, and regenerating it would throw
     * away the user's own edits.  Renaming in place fixes the existing page and
     * is a no-op once the ids agree.
     */
    _resolveEntities() {
      if (!this._hass || !this._panes) return false;
      let changed = false;
      for (const pane of this._panes) {
        if (pane.count_entity) {
          const resolved = resolveEntity(this._hass, pane.count_entity);
          if (resolved !== pane.count_entity) {
            pane.count_entity = resolved;
            changed = true;
          }
        }
        for (const series of pane.series) {
          const resolved = resolveEntity(this._hass, series.entity);
          if (resolved !== series.entity) {
            series.entity = resolved;
            changed = true;
          }
        }
      }
      return changed;
    }

    /** Cheap fingerprint of every pane's series limit. */
    _countSignature() {
      if (!this._panes) return "";
      return this._panes
        .map((pane) => String(this._countLimit(pane)) + "/" + this._gateSignature(pane))
        .join(",");
    }

    /** Re-measure after every render: the svg appears only once data arrived. */
    updated() {
      this._measure();
    }

    getCardSize() {
      const panes = this._panes || [];
      return Math.max(4, panes.length * 5);
    }

    _t(en, zh) {
      return hmPick(hmLang(this._hass, this._config), en, zh);
    }

    /** Resolve one user-supplied string (plain string or language map). */
    _text(value) {
      return hmText(value, hmLang(this._hass, this._config));
    }

    /**
     * A series' display name, resolved for the current language.
     *
     * The dashboard template names the pack curves "Battery 1" .. "Battery 4"
     * because it is written for the largest unit and cannot know how many packs
     * a given device has.  On a one-pack unit that number is noise - and worse,
     * it implies a second pack - so it is dropped here, where `count_entity`
     * has already told us the real count.  Only the exact "word + number" form
     * is touched: a name like "PV1" keeps its digit, and two packs or more keep
     * their numbers, which is where they start being useful.
     */
    _sName(s, pane) {
      if (!s) return "";
      const name = this._text(s.name != null ? s.name : s.entity) || "";
      if (!name) return "";
      if (pane && this._countLimit(pane) === 1
          && SERIES_INDEX_NAME.test(name.trim())) {
        return name.trim().replace(/\s*\d+$/, "");
      }
      return name;
    }

    /* --------------------------- time windows --------------------------- */

    _window() {
      const a = this._anchor;
      /* The window never reaches into the future.  Asking the recorder for
         "tomorrow" answered with an empty chart, which looks like a bug rather
         than like "there is nothing there yet"; clamping the end to now also
         makes the partial last bucket of the current day/month/year correct. */
      const now = new Date();
      const clampEnd = (end) => (end.getTime() > now.getTime() ? now : end);
      if (this._range === "month") {
        return {
          start: startOfDay(new Date(a.getFullYear(), a.getMonth(), 1)),
          end: clampEnd(endOfDay(new Date(a.getFullYear(), a.getMonth() + 1, 0))),
        };
      }
      if (this._range === "year") {
        return {
          start: startOfDay(new Date(a.getFullYear(), 0, 1)),
          end: clampEnd(endOfDay(new Date(a.getFullYear(), 11, 31))),
        };
      }
      return { start: startOfDay(a), end: clampEnd(endOfDay(a)) };
    }

    /* ---------------------------- date limits ---------------------------- */

    /** Local midnight of today. */
    _today() {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }

    /** The newest period the card may show, in the current range. */
    _maxAnchor() {
      const t = this._today();
      if (this._range === "month") return new Date(t.getFullYear(), t.getMonth(), 1);
      if (this._range === "year") return new Date(t.getFullYear(), 0, 1);
      return t;
    }

    /**
     * True when `anchor` is **after** the newest period.
     *
     * Kept apart from `_atMax` on purpose: moving *onto* today is allowed (it is
     * the most interesting day there is), while moving *past* it is not. Using
     * the "at or past" test as the navigation guard silently refused to step from
     * yesterday to today.
     */
    _past(anchor) {
      const a = anchor || this._anchor;
      const max = this._maxAnchor();
      if (this._range === "year") return a.getFullYear() > max.getFullYear();
      if (this._range === "month") {
        return a.getFullYear() > max.getFullYear()
          || (a.getFullYear() === max.getFullYear() && a.getMonth() > max.getMonth());
      }
      return startOfDay(a).getTime() > max.getTime();
    }

    /** True when `anchor` is at (or past) the newest period - nowhere to go. */
    _atMax(anchor) {
      if (this._past(anchor)) return true;
      const a = anchor || this._anchor;
      const max = this._maxAnchor();
      if (this._range === "year") return a.getFullYear() === max.getFullYear();
      if (this._range === "month") {
        return a.getFullYear() === max.getFullYear() && a.getMonth() === max.getMonth();
      }
      return startOfDay(a).getTime() === max.getTime();
    }

    /** Pull an anchor back into the past, so no navigation can leave the range. */
    _clampAnchor(anchor) {
      if (this._past(anchor)) return this._maxAnchor();
      return anchor;
    }

    /** The `max` attribute for a native picker. */
    _maxAttr() {
      const a = this._maxAnchor();
      if (this._range === "year") return String(a.getFullYear());
      if (this._range === "month") return `${a.getFullYear()}-${pad2(a.getMonth() + 1)}`;
      return `${a.getFullYear()}-${pad2(a.getMonth() + 1)}-${pad2(a.getDate())}`;
    }

    /** Statistics granularity: finer for short windows, coarser for long ones. */
    _periods() {
      if (this._range === "month") return ["hour"];
      if (this._range === "year") return ["day"];
      // A day is best rendered from 5 minute statistics, but those are only
      // retained for `purge_keep_days` (10 days by default), so fall back to
      // hourly buckets when the finer query came back empty.
      return ["5minute", "hour"];
    }

    _shiftRange(step) {
      const a = new Date(this._anchor);
      if (this._range === "month") a.setMonth(a.getMonth() + step);
      else if (this._range === "year") a.setFullYear(a.getFullYear() + step);
      else a.setDate(a.getDate() + step);
      /* Forward stops at the current period.  The recorder holds nothing in the
         future, so a step past today could only ever produce "no statistics". */
      if (step > 0 && this._past(a)) return;
      this._anchor = this._clampAnchor(a);
      this._calOpen = false;
      this._reload();
    }

    _onRangeChange(event) {
      this._range = event.target.value;
      /* Switching to a coarser range keeps the anchor, but the anchor may now be
         past the end of that range (a day in the future month is impossible, yet
         a stale anchor from a shared `sync_group` is not). */
      this._anchor = this._clampAnchor(this._anchor);
      this._calMonth = null;
      this._calOpen = false;
      this._reload();
    }

    _onAnchorChange(event) {
      const value = event.target.value;
      let a = null;
      if (this._range === "year") {
        const year = parseInt(value, 10);
        if (Number.isFinite(year)) a = new Date(year, 0, 1);
      } else if (this._range === "month" && /^\d{4}-\d{2}$/.test(value)) {
        const [y, m] = value.split("-").map(Number);
        a = new Date(y, m - 1, 1);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [y, m, d] = value.split("-").map(Number);
        a = new Date(y, m - 1, d);
      }
      if (!a || Number.isNaN(a.getTime())) return;
      const clamped = this._clampAnchor(a);
      this._anchor = clamped;
      /* A typed or pasted future date is silently corrected rather than
         rejected: the field must always show the period actually on screen. */
      if (clamped.getTime() !== a.getTime() && event.target) {
        event.target.value = this._anchorValue();
      }
      this._reload();
    }

    /** Drop the cached data and refetch, then tell the group about the window. */
    _reload() {
      this._data = null;
      this._hoverTime = null;
      this._hidden = (this._panes || []).map(() => []);
      /* A new period means new buckets: keep the zoom at "whole window" rather
         than reopening on an arbitrary slice of the previous one. */
      this._zoom = null;
      this._resetDrag();
      this._fetch();
      this._pushSync();
    }

    /* --------------------------- sync group --------------------------- */

    _syncKey() {
      const key = this._config && this._config.sync_group;
      return key == null || key === "" || key === false ? null : String(key);
    }

    _joinSync() {
      const key = this._syncKey();
      if (key === this._syncJoined) return;
      this._leaveSync();
      if (!key) return;
      let group = SYNC_GROUPS.get(key);
      if (!group) {
        group = { state: null, members: new Set() };
        SYNC_GROUPS.set(key, group);
      }
      group.members.add(this);
      this._syncJoined = key;
      // Adopt the window the group already has, so a late card does not show a
      // different period than the one next to it.
      if (group.state) this._applySync(group.state);
      if (group.hover != null) this._applyRemoteHover(group.hover);
    }

    _leaveSync() {
      const key = this._syncJoined;
      if (!key) return;
      const group = SYNC_GROUPS.get(key);
      if (group) {
        group.members.delete(this);
        if (!group.members.size) SYNC_GROUPS.delete(key);
      }
      this._syncJoined = null;
    }

    /** Publish this card's window to the rest of the group. */
    _pushSync() {
      const key = this._syncKey();
      if (!key) return;
      const group = SYNC_GROUPS.get(key);
      if (!group) return;
      const state = { range: this._range, anchor: this._anchor.getTime() };
      group.state = state;
      for (const member of group.members) {
        if (member !== this) member._applySync(state);
      }
    }

    /** Follow the group's window. Never pushes back, so it cannot loop. */
    _applySync(state) {
      if (!state) return;
      const same = this._range === state.range
        && this._anchor.getTime() === state.anchor;
      if (same) return;
      this._range = state.range;
      /* A sibling card cannot send a future window any more (`_shiftRange`
         refuses to leave the past), but an older cached group state could, and
         the clamp here is what keeps that from drawing an empty chart. */
      this._anchor = this._clampAnchor(new Date(state.anchor));
      this._calMonth = null;
      this._calOpen = false;
      this._data = null;
      this._hoverTime = null;
      this._remoteTime = null;
      /* The other card navigated to a different day, so a fraction of the old
         window no longer describes anything here. */
      this._zoom = null;
      this._resetDrag();
      if (this._config && this._hass) this._fetch();
      this.requestUpdate();
    }

    /** Publish the hovered timestamp so the rest of the group can mirror it. */
    _pushHover(time) {
      const key = this._syncKey();
      if (!key) return;
      const group = SYNC_GROUPS.get(key);
      if (!group) return;
      // `mousemove` fires far more often than the bucket changes, so only a new
      // timestamp is worth waking the other cards for.
      if (group.hover === time) return;
      group.hover = time;
      for (const member of group.members) {
        if (member !== this) member._applyRemoteHover(time);
      }
    }

    /** Mirror another card's hover. Never pushes back. */
    _applyRemoteHover(time) {
      const next = time == null ? null : num(time);
      if (this._remoteTime === next && (next != null || this._hoverTime == null)) return;
      this._remoteTime = next;
      this._hoverTime = next;
      this.requestUpdate();
    }

    _anchorValue() {
      const a = this._anchor;
      if (this._range === "year") return String(a.getFullYear());
      if (this._range === "month") return `${a.getFullYear()}-${pad2(a.getMonth() + 1)}`;
      return `${a.getFullYear()}-${pad2(a.getMonth() + 1)}-${pad2(a.getDate())}`;
    }

    async _fetch() {
      if (!this._hass || !this._config || !this._panes) return;
      if (typeof this._hass.callWS !== "function") {
        this._error = this._t("Home Assistant is not connected。", "未连接到 Home Assistant。");
        return;
      }

      /* Every pane is fetched in one query: they share a time window by
         definition, so a second round trip would only risk the panes landing on
         different periods. */
      const ids = [...new Set(
        this._panes.flatMap((pane) => pane.series.map((s) => s.entity)).filter(Boolean),
      )];
      const { start, end } = this._window();
      const token = ++this._token;
      const periods = this._periods();

      this._loading = true;
      this._error = null;

      try {
        let rows = null;
        let period = periods[0];
        for (const candidate of periods) {
          const result = await this._hass.callWS({
            type: "recorder/statistics_during_period",
            start_time: start.toISOString(),
            end_time: end.toISOString(),
            statistic_ids: ids,
            period: candidate,
            types: ["mean"],
          });
          if (token !== this._token) return; // a newer request won
          period = candidate;
          rows = result;
          const first = rows && rows[ids[0]];
          if (Array.isArray(first) && first.length > 6) break;
        }

        this._data = this._panes.map((pane) => this._build(rows || {}, period, pane));
      } catch (err) {
        if (token !== this._token) return;
        this._data = null;
        this._error = this._t(
          "Statistics are unavailable — is the recorder enabled?",
          "统计数据不可用 —— 是否启用了 recorder？",
        );
      } finally {
        if (token === this._token) {
          this._loading = false;
          this.requestUpdate();
        }
      }
    }

    /**
     * How many of the configured series exist on this device, or null.
     *
     * The bundled dashboard lists four battery packs because four is the
     * largest pack count the firmware supports, but a device with one pack has
     * one.  `skip_empty` covers the usual case (the other entities never
     * report, so they have no statistics), yet it cannot help when the recorder
     * still holds values for packs the device no longer has - the stale curves
     * then make the chart say "four packs" for a one-pack unit.
     *
     * `count_entity` points at the sensor that reports the real number, so the
     * chart follows the hardware instead of the template.  When that sensor has
     * no value yet, the same fallback the power-flow card uses is applied: the
     * highest series whose entity currently reports a number.  That keeps the
     * two cards saying the same thing - a chart reading "Battery 1..4" next to
     * an illustration drawing one module is the mismatch this exists to stop.
     *
     * Null means "no limit".  That is the answer whenever neither source knows
     * anything - right after a restart, or with the device offline.  Guessing 1
     * there is worse than the template list: a three-pack unit would collapse to
     * one curve for the first minutes after every boot, which is exactly the
     * kind of wrong the option is meant to remove.
     */
    _countLimit(pane) {
      const entity = pane.count_entity;
      if (!entity || !this._hass) return null;
      const state = this._hass.states[entity];
      if (!state) return null;

      const declared = numOrNull(state.state);
      if (declared != null && declared > 0) return Math.floor(declared);

      /* Undeclared: count the series that are reporting right now.  0 means
         "nothing is known yet", which is answered as "no limit" below.
         `always` series (context lines) do not occupy a slot. */
      let reporting = 0;
      let slot = 0;
      for (const s of pane.series) {
        if (s.always) continue;
        const live = this._hass.states[s.entity];
        if (live && numOrNull(live.state) != null) reporting = slot + 1;
        slot += 1;
      }
      return reporting > 0 ? reporting : null;
    }

    /**
     * Is a `{entity, attribute}` condition true right now?
     *
     * `true` / `"true"` / `"on"` / `1` count as true; anything else - including
     * a missing entity and a `null` attribute - is false.  The attribute is
     * read when one is named, the state otherwise, so the same helper covers
     * both "this flag is set" and "this entity says X".
     */
    _condition(cond) {
      if (!cond || !this._hass) return false;
      const entity = typeof cond === "string" ? cond : cond.entity;
      if (!entity) return false;
      const state = this._entityState(entity);
      if (!state) return false;
      const raw = !cond.attribute || typeof cond === "string"
        ? state.state
        : (state.attributes || {})[cond.attribute];
      if (raw === true) return true;
      if (typeof raw === "number") return raw === 1;
      if (typeof raw === "string") {
        const text = raw.trim().toLowerCase();
        return text === "true" || text === "on" || text === "1";
      }
      return false;
    }

    /**
     * The state of `id`, tolerant of a renamed device.
     *
     * Renaming a device in Home Assistant renames its entities too
     * (`sensor.msa_…_energy_flow_today` becomes
     * `sensor.g3_msa_…_energy_flow_today`), and the dashboard template can only
     * guess the id from the serial.  The gate must not read that rename as "the
     * device has no meter", so a missing id falls back to the longest unique
     * object-id suffix - the same tolerance the battery card applies.  Only the
     * gate pays this cost; the statistics query keeps the configured ids.
     */
    _entityState(id) {
      if (!id || !this._hass) return null;
      const states = this._hass.states;
      const direct = states[id];
      if (direct) return direct;
      if (!this._alias) this._alias = new Map();
      const cached = this._alias.get(id);
      if (cached && states[cached]) return states[cached];
      const wanted = String(id).split(".").pop();
      let found = null;
      for (const key of Object.keys(states)) {
        const objectId = key.split(".").pop();
        if (objectId === wanted || objectId.endsWith("_" + wanted)) {
          found = key;
          break;
        }
      }
      if (found) {
        this._alias.set(id, found);
        return states[found];
      }
      this._alias.delete(id);
      return null;
    }

    /**
     * Whether a configured series belongs on this device.
     *
     * `while` / `unless` exist so the bundled template can carry both the
     * combined grid-and-load curve and the split grid / load pair: a unit
     * without a grid meter has no separate load measurement, a unit with one
     * has, and the template is written once for both.  Unknown conditions
     * resolve to "false", so `unless` wins before the first snapshot arrives -
     * the combined curve is what a device that has not said anything yet used
     * to show.
     */
    _seriesShown(series) {
      if (!series) return true;
      if (series.while && !this._condition(series.while)) return false;
      if (series.unless && this._condition(series.unless)) return false;
      return true;
    }

    /** Fingerprint of every series gate, so a capability change refetches. */
    _gateSignature(pane) {
      return (pane.series || [])
        .map((s) => (this._seriesShown(s) ? "1" : "0"))
        .join("");
    }

    /** Align every series on one time grid and compute the stacked layers. */
    _build(result, period, pane) {
      const all = pane.series;
      const limit = this._countLimit(pane);

      /* Drop a curve that recorded *nothing* in this window.

         The bundled dashboard describes hardware that may not be there: four
         battery packs and four PV ports are listed whatever the device really
         has. Those extra entities exist (the integration creates the full list)
         but never report, so they carry no statistics at all - drawn as a flat
         line they read as "this pack sits at 0 %", which is a lie. A series
         that is genuinely zero still has rows with mean 0 and is kept; only an
         entity that stayed silent the whole period goes.

         A row whose `mean` is null is silence as well: the statistics query
         returns a row for the bucket even when nothing was recorded, so
         `rows.length` alone is not evidence of data.

         `srcIndex` maps the kept position back to the config index, because
         `_hidden` stores the latter (it must survive a reload that drops a
         pack). */
      const skipEmpty = pane.skip_empty !== false;
      /* Series gated by `while` / `unless` are dropped before anything else.
         Each one is carried with its **config** index, because `_hidden` and the
         legend store that index - re-numbering the surviving curves would make
         a legend click hide its neighbour. */
      const indexed = all
        .map((s, i) => ({ s, i }))
        .filter((entry) => this._seriesShown(entry.s));
      /* `always` series are context, not one of the n pieces of hardware (the
         device SOC line above the per-pack curves, for instance).  They neither
         take up a slot for `count_entity` nor get dropped by it - counting them
         made a one-pack unit lose its pack. */
      const absent = new Set();
      let slot = 0;
      for (const entry of indexed) {
        if (entry.s.always) continue;
        if (limit != null && slot >= limit) absent.add(entry.i);
        slot += 1;
      }
      const kept = [];
      const srcIndex = [];
      indexed.forEach(({ s, i }) => {
        /* Positions past the real hardware count are not "empty", they are
           absent - the entity may well carry values from before the device was
           re-configured. */
        if (absent.has(i)) return;
        const rows = result[s.entity];
        const hasData = Array.isArray(rows)
          && rows.some((row) => numOrNull(row.mean) != null);
        if (skipEmpty && !hasData) return;
        kept.push(s);
        srcIndex.push(i);
      });
      /* The series the device really has, before the "recorded nothing" filter.
         Used as the fallback below, so a quiet device still shows the curves of
         its actual hardware instead of every slot the template lists. */
      const present = indexed.filter((entry) => !absent.has(entry.i));
      /* Never silently draw nothing: if every series is silent, keep the ones
         that exist so the "no statistics" path below can say so. */
      const series = kept.length ? kept : present.map((entry) => entry.s);
      const indexMap = kept.length
        ? srcIndex
        : present.map((entry) => entry.i);

      const timeSet = new Set();
      const bySeries = series.map((s) => {
        const map = new Map();
        for (const row of (result[s.entity] || [])) {
          const t = num(row.start);
          map.set(t, row.mean == null ? null : num(row.mean));
          timeSet.add(t);
        }
        return map;
      });

      const times = [...timeSet].sort((a, b) => a - b);
      if (!times.length) {
        return { times, period, layers: [], max: 1, min: 0, values: [], series, srcIndex: indexMap };
      }

      // Forward fill so a series that started later still has a value.
      const values = bySeries.map((map) => {
        let last = 0;
        return times.map((t) => {
          const v = map.get(t);
          if (v != null) last = v;
          return last;
        });
      });

      const { layers, max, min } = computeLayers(values, series, pane);

      return { times, period, layers, max, min, values, series, srcIndex: indexMap };
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config || !this._panes) return html``;
      const title = this._config.title === false ? ""
        : (this._text(this._config.title) || this._t("History Data", "历史数据"));

      /* One toolbar for the whole card. Every pane is drawn against the same
         window, so repeating the picker under each chart would imply they could
         drift apart. The panes are stacked inside a single ha-card, which is
         what makes the shared window obvious at a glance.
         The title is written BEFORE the toolbar: the toolbar is pushed right by
         `margin-left: auto`, so whatever follows it in the markup ends up on the
         far edge - which is how "History" once landed to the right of the range
         picker. */
      return html`
        <ha-card>
          <div class="head">
            ${title === "" ? "" : html`<div class="title">${title}</div>`}
            ${this._config.show_toolbar === false ? "" : this._toolbar()}
          </div>
          ${this._panes.map((pane, index) => this._pane(index, pane))}
        </ha-card>
      `;
    }

    /** One chart block: its own heading, drawing and legend. */
    _pane(index, pane) {
      const heading = this._text(pane.title);
      const showHeading = heading != null && heading !== false && heading !== "";
      return html`
        <div class="pane">
          ${showHeading ? html`<div class="ptitle">${heading}</div>` : ""}
          ${this._paneBody(index)}
          ${this._legend(index, pane)}
        </div>`;
    }
    _toolbar() {
      const rangeOptions = RANGES.map((r) =>
        `<option value="${r.id}" ${r.id === this._range ? "selected" : ""}>${esc(this._t(r.en, r.zh))}</option>`).join("");

      return html`
        <div class="toolbar">
          <div class="nav">
            <button class="navbtn" title=${this._t("Previous", "上一个")}
              @click=${() => this._shiftRange(-1)}>‹</button>
            ${this._range === "day" ? this._dayField() : html`
              <input type=${this._range === "month" ? "month" : "number"}
                .value=${this._anchorValue()} max=${this._maxAttr()}
                @change=${(e) => this._onAnchorChange(e)} />`}
            <button class="navbtn" title=${this._t("Next", "下一个")}
              ?disabled=${this._atMax()} @click=${() => this._shiftRange(1)}>›</button>
          </div>
          <select @change=${(e) => this._onRangeChange(e)}>${this._untrusted(rangeOptions)}</select>
        </div>`;
    }

    /* ---------------------------- day picker ---------------------------- */

    /**
     * The day field: a button showing the date, plus the calendar under it.
     *
     * The native `<input type="date">` was replaced for the *day* range only,
     * because it cannot say which days actually have data: its calendar greys
     * out nothing but the future, and every past day looks equally valid - so
     * clicking a day the recorder purged opened a chart that only said "no
     * statistics for this period". The card's own calendar knows the answer
     * (see `_loadAvailability`) and draws those days grey, while days with real
     * statistics keep the normal text colour.
     *
     * Month and year keep the native picker: they are typed more often than
     * clicked, and there is no per-period data question worth showing there.
     */
    _dayField() {
      return html`
        <div class="dayhost">
          <button class="daybtn" title=${this._t("Pick a day", "选择日期")}
            @click=${() => this._toggleCalendar()}>${this._anchorValue()}</button>
          ${this._calOpen ? this._calendar() : ""}
        </div>`;
    }

    _toggleCalendar() {
      this._calOpen = !this._calOpen;
      if (this._calOpen) {
        const a = this._anchor;
        this._calMonth = new Date(a.getFullYear(), a.getMonth(), 1);
        this._loadAvailability();
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
        const d = new Date(2024, 0, 1 + i);
        try {
          out.push(new Intl.DateTimeFormat(this._locale(), { weekday: "short" }).format(d));
        } catch (err) {
          out.push("MTWTFSS".charAt(i));
        }
      }
      return out;
    }

    _shiftCalendar(step) {
      const month = this._calMonth || this._anchor;
      const next = new Date(month.getFullYear(), month.getMonth() + step, 1);
      const today = this._today();
      if (step > 0 && (next.getFullYear() > today.getFullYear()
        || (next.getFullYear() === today.getFullYear() && next.getMonth() > today.getMonth()))) {
        return;
      }
      this._calMonth = next;
      this._loadAvailability();
      this.requestUpdate();
    }

    _pickDay(date) {
      if (date.getTime() > this._today().getTime()) return;
      const same = this._anchor.getTime() === date.getTime();
      this._calOpen = false;
      if (same) {
        this.requestUpdate();
        return;
      }
      this._anchor = date;
      this._reload();
    }

    /**
     * Which days of the shown month have statistics.
     *
     * One `period: "day"` query for the whole month, cached per month: a bucket
     * exists for every day the recorder had anything for, so a bucket with a
     * `mean` is exactly "this day has data". Any failure (no recorder, a series
     * that is not long-term statistics at all) leaves `_availDays` at `null`,
     * which the calendar renders as "no opinion" - greying every day there would
     * be a lie the integration cannot back up.
     */
    async _loadAvailability() {
      const month = this._calMonth;
      if (!month || !this._hass || typeof this._hass.callWS !== "function") return;
      const key = `${month.getFullYear()}-${pad2(month.getMonth() + 1)}`;
      if (this._availKey === key || this._availPending === key) return;

      const ids = [...new Set(
        (this._panes || []).flatMap((pane) => pane.series.map((s) => s.entity)).filter(Boolean),
      )];
      if (!ids.length) {
        this._availKey = key;
        this._availDays = null;
        this.requestUpdate();
        return;
      }

      this._availPending = key;
      const start = new Date(month.getFullYear(), month.getMonth(), 1);
      const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
      try {
        const rows = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          statistic_ids: ids,
          period: "day",
          types: ["mean"],
        });
        const days = new Set();
        for (const id of Object.keys(rows || {})) {
          const list = rows[id];
          if (!Array.isArray(list)) continue;
          for (const row of list) {
            if (!row || row.mean == null || row.start == null) continue;
            const d = new Date(row.start);
            days.add(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
          }
        }
        this._availKey = key;
        this._availDays = days;
      } catch (err) {
        this._availKey = key;
        this._availDays = null;
      } finally {
        this._availPending = null;
        this.requestUpdate();
      }
    }

    _calendar() {
      const today = this._today();
      const month = this._calMonth
        || new Date(this._anchor.getFullYear(), this._anchor.getMonth(), 1);
      const year = month.getFullYear();
      const mon = month.getMonth();
      const lead = (new Date(year, mon, 1).getDay() + 6) % 7; // Monday-first
      const count = new Date(year, mon + 1, 0).getDate();
      const selKey = this._anchorValue();

      const cells = [];
      for (let i = 0; i < lead; i += 1) {
        cells.push(html`<span class="cal-blank"></span>`);
      }
      for (let d = 1; d <= count; d += 1) {
        const date = new Date(year, mon, d);
        const key = `${year}-${pad2(mon + 1)}-${pad2(d)}`;
        const future = date.getTime() > today.getTime();
        /* `null` availability (unknown) marks nothing either way. */
        const hasData = future || !this._availDays ? null : this._availDays.has(key);
        const cls = [
          "cal-day",
          future ? "future" : "",
          hasData === false ? "empty" : "",
          hasData === true ? "has" : "",
          date.getTime() === today.getTime() ? "today" : "",
          key === selKey ? "sel" : "",
        ].filter(Boolean).join(" ");
        const title = future
          ? this._t("This day has not happened yet", "这一天还没到")
          : hasData === false
            ? this._t("No statistics recorded", "该日没有统计数据")
            : this._t("Statistics recorded", "该日有统计数据");
        cells.push(html`
          <button class=${cls} ?disabled=${future} title=${title}
            @click=${() => this._pickDay(date)}>${d}</button>`);
      }

      const atNowMonth = year > today.getFullYear()
        || (year === today.getFullYear() && mon >= today.getMonth());

      return html`
        <div class="cal" role="dialog">
          <div class="cal-head">
            <button class="cal-nav" @click=${(e) => { e.stopPropagation(); this._shiftCalendar(-1); }}>‹</button>
            <span class="cal-month">${this._monthLabel(month)}</span>
            <button class="cal-nav" ?disabled=${atNowMonth}
              @click=${(e) => { e.stopPropagation(); this._shiftCalendar(1); }}>›</button>
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


    _paneBody(index) {
      if (this._error) return html`<div class="msg err">${this._error}</div>`;
      if (this._loading && !this._data) {
        return html`<div class="msg"><span class="spin"></span>${this._t("Loading…", "正在读取统计…")}</div>`;
      }
      const data = this._data ? this._data[index] : null;
      if (!data || !data.times.length) {
        return html`<div class="msg">${this._t(
          "No statistics recorded for this period。",
          "该时间段没有统计数据。",
        )}</div>`;
      }
      const zoomed = this._zoom != null;
      return html`
        <div class="chart ${this._dragging ? "dragging" : ""} ${zoomed ? "zoomed" : ""}"
             title=${this._t(
               "Scroll to zoom · drag to pan · double-click to reset",
               "滚轮缩放 · 拖动平移 · 双击还原",
             )}
             @mousemove=${(e) => this._onMove(e, index)}
             @mouseleave=${() => this._setHover(null)}
             @wheel=${(e) => this._onWheel(e, index)}
             @mousedown=${(e) => this._onDragStart(e, index)}
             @click=${() => this._onChartClick(index)}>
          ${this._untrusted(this._svg(data, this._panes[index]))}
          ${zoomed ? html`<div class="zhint">
            <span>${this._t("Zoomed", "已放大")}</span>
            <button @click=${(e) => { e.stopPropagation(); this._resetZoom(); }}>
              ${this._t("Reset", "还原")}
            </button>
          </div>` : ""}
        </div>`;
    }

    /**
     * Legend rows. They are real Lit elements (not `_untrusted` markup) because
     * they carry click handlers.
     *
     * Each chip is an independent switch: clicking it hides or shows **only
     * that** curve. A hidden one keeps its colour as a ring instead of a filled
     * disc and fades, so "switched off" reads differently from "not important".
     *
     * Only the curves that were actually drawn get a chip: a panel asking for
     * four battery packs on hardware with one must not advertise three empty
     * ones. `srcIndex` converts the drawn position back to the config index,
     * which is what `_hidden` stores.
     */
    _legend(index, pane) {
      const data = this._data ? this._data[index] : null;
      const list = data && data.series && data.series.length ? data.series : pane.series;
      const map = data && data.srcIndex && data.srcIndex.length
        ? data.srcIndex
        : pane.series.map((_, i) => i);
      const hidden = this._hiddenOf(index);
      return html`
        <div class="legend">
          ${list.map((s, i) => {
            const src = map[i] == null ? i : map[i];
            const off = hidden.has(src);
            return html`
            <span class="li ${off ? "off" : "on"}"
              title=${off
                ? this._t("Click to show this curve", "点击显示这条曲线")
                : this._t("Click to hide this curve", "点击隐藏这条曲线")}
              @click=${(e) => { e.stopPropagation(); this._toggleSeries(index, src); }}>
              <i class="dot" style="background:${off ? "transparent" : s.color};
                border-color:${off ? s.color : "var(--card-background-color, #fff)"}"
              ></i>${this._sName(s, pane)}
            </span>`;
          })}
        </div>`;
    }

    _svg(data, pane) {
      const H = num(pane.height) || DEFAULT_H;
      const W = this._width();
      const { times } = data;
      const symmetric = pane.symmetric !== false;
      const x0 = PAD_L;
      const x1 = W - PAD_R;
      const yTop = PAD_T;
      const yBot = H - PAD_B;

      /* The legend is a set of switches, not a radio group: a chip turns its own
         curve off and leaves the others exactly as they were, so switching PV
         off leaves the battery and the grid in place. The surviving curves are
         re-stacked from zero - a band whose base came from a now hidden layer
         would otherwise float above the axis.

         `_hidden` holds the index in the card config, while `data.series`
         may be shorter (silent entities are dropped), so the position is looked
         up through `data.srcIndex`. */
      const hidden = this._hiddenOf(pane.index);
      const picks = data.series.map((s, i) => ({
        s,
        i,
        src: data.srcIndex && data.srcIndex[i] != null ? data.srcIndex[i] : i,
      })).filter((x) => !hidden.has(x.src));

      /* Recomputing rather than filtering is the point: with the per-port chart
         stacked, hiding one layer has to pull the ones above it back down to the
         axis. The array keeps the config order, so which colour wins where two
         values coincide does not change when a chip is switched off. */
      const view = hidden.size
        ? computeLayers(picks.map((x) => data.values[x.i]), picks.map((x) => x.s), pane)
        : { layers: data.layers, max: data.max, min: data.min };

      /* Switching every curve off must not also throw the axis away: the plot
         keeps its shape and simply has nothing drawn inside it. */
      const { layers, max, min } = view.layers.length
        ? view
        : { layers: [], max: data.max, min: data.min };

      /* Horizontal zoom. `win.from` / `win.to` are fractional bucket indices;
         the curve is drawn only between the buckets they touch, and every
         index is clamped into that range so the band is cut cleanly at the
         edges instead of spilling past them. */
      const win = zoomWindow(this._zoom, times.length);
      const zoomSpan = Math.max(win.to - win.from, 1e-9);
      const toX = (i) => (win.to - win.from <= 1e-9
        ? (x0 + x1) / 2
        : x0 + (x1 - x0) * ((Math.min(Math.max(i, win.from), win.to) - win.from) / zoomSpan));
      const firstIdx = Math.max(0, Math.floor(win.from));
      const lastIdx = Math.min(times.length - 1, Math.ceil(win.to));

      /* Axis limits: mirrored around zero by default, otherwise a plain
         bottom-up range (0..100 for SOC).

         The range follows the data that is on screen, not a fixed number.
         Panes used to carry `span: 2500`, which kept a sunny afternoon in
         frame but flattened an idle evening: 90 W of discharge drew as a
         hairline across a +-2500 W axis, exactly the detail this chart
         exists to show. Zooming re-fits the axis for the same reason, and
         `niceMax` keeps the ticks on round numbers so panning does not make
         the grid crawl. `span` still pins the range when two charts really
         have to stay comparable. */
      const seen = windowExtent(layers, firstIdx, lastIdx);
      // A stretch of pure zeros must not collapse the axis to +-1 W.
      const visiblePeak = seen.max > 0 || seen.min < 0
        ? Math.max(seen.max, -seen.min)
        : Math.max(max, -min);
      let domainMax;
      let domainMin;
      let ticks;
      if (symmetric) {
        const nice = pane.span != null
          ? num(pane.span)
          : niceMax(visiblePeak > 0 ? visiblePeak : idleSpan(pane.unit));
        domainMax = nice;
        domainMin = -nice;
        ticks = [nice, nice / 2, 0, -nice / 2, -nice];
      } else {
        const peak = seen.max > 0 ? seen.max : max > 0 ? max : idleSpan(pane.unit);
        domainMax = pane.max != null
          ? num(pane.max)
          : niceMax(peak);
        domainMin = pane.min != null ? num(pane.min) : 0;
        if (domainMax <= domainMin) domainMax = domainMin + 1;
        ticks = [0, 1, 2, 3, 4].map((k) => domainMax - ((domainMax - domainMin) * k) / 4);
      }

      const extent = Math.max(Math.abs(domainMax), Math.abs(domainMin));
      const display = pickUnit(pane.unit, extent);
      const div = display.divisor;
      // Label precision follows the tick spacing, otherwise a 0.5 step would
      // print as "1" next to "0".
      const tickStep = (symmetric ? domainMax / 2 : (domainMax - domainMin) / 4) / div;
      const axDecimals = decimalsFor(tickStep);
      const toY = (v) => yTop
        + ((domainMax - Math.min(Math.max(num(v), domainMin), domainMax))
          / (domainMax - domainMin)) * (yBot - yTop);
      const yZero = toY(0);

      let grid = "";
      ticks.forEach((t, index) => {
        const y = toY(t).toFixed(1);
        if (t !== 0) {
          grid += `<line class="grid" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/>`;
        }
        const label = t / div;
        /* The unit rides on the topmost tick ("2.50 W"). It used to be a hint
           of its own in the same corner, which put it on top of this very
           label. */
        const unit = index === 0 && display.unit ? ` ${display.unit}` : "";
        grid += `<text class="axis" x="${x0 - 8}" y="${(toY(t) + 4).toFixed(1)}"
          text-anchor="end">${label.toFixed(axDecimals)}${esc(unit)}</text>`;
      });
      if (pane.zero_line !== false && symmetric) {
        grid += `<line class="zero" x1="${x0}" y1="${yZero.toFixed(1)}" x2="${x1}" y2="${yZero.toFixed(1)}"/>`;
      }

      /* Fills first, then every stroke.

         The translucent areas are allowed to overlap: that is what produces the
         mixed shade where two series share a value (green + blue -> teal), which
         is exactly how the vendor app shows an overlap. The *lines* must not
         mix, though - each one is painted in its own series colour, in series
         order, so where two values coincide the last one wins (PV, then Battery,
         then Grid & load, i.e. blue on top of green). */
      let fills = "";
      let edges = "";
      const FILL_OPACITY = 0.32;
      const STROKE_WIDTH = 2;
      /* `computeLayers` decides this the same way; duplicated here so the
         renderer knows whether a layer's edge is a plain value or a stack top. */
      const stackedDraw = pane.stack != null ? pane.stack !== false : symmetric;
      /* Set as soon as one band with height is drawn; if it stays false every
         series in this pane was flat, which is handled after the loop. */
      let drewBand = false;

      layers.forEach((layer) => {
        const color = layer.series.color;

        if (!stackedDraw) {
          /* One continuous path through the signed value.

             Pos and neg are separate stack arrays and exactly one of them is
             non-zero at any index, so adding them recovers the series itself.
             Running the whole window as a single path is what keeps a 0 W
             stretch visible as a line along the axis, and what stops the two
             bands from each closing around zero at every crossing (the little
             hooks that appeared at every edge). */
          const posTop = layer.pos ? layer.pos.top : null;
          const negTop = layer.neg ? layer.neg.top : null;
          let line = "";
          let any = false;
          for (let i = firstIdx; i <= lastIdx; i += 1) {
            const value = (posTop ? num(posTop[i]) : 0) + (negTop ? num(negTop[i]) : 0);
            if (Math.abs(value) > 1e-9) any = true;
            line += `${i === firstIdx ? "M" : "L"}${toX(i).toFixed(1)} ${toY(value).toFixed(1)}`;
          }
          if (any) {
            const area = `${line}`
              + `L${toX(lastIdx).toFixed(1)} ${yZero.toFixed(1)}`
              + `L${toX(firstIdx).toFixed(1)} ${yZero.toFixed(1)}Z`;
            fills += `<path d="${area}" fill="${esc(color)}"`
              + ` fill-opacity="${FILL_OPACITY}" stroke="none"/>`;
          }
          edges += `<path d="${line}" fill="none" stroke="${esc(color)}"`
            + ` stroke-width="${STROKE_WIDTH}" stroke-opacity="1"`
            + " stroke-linejoin=\"round\" stroke-linecap=\"round\"/>";
          return;
        }

        /* Stacked: each layer's own band, edge and all. */
        for (const side of ["pos", "neg"]) {
          const band = layer[side];
          if (!band) continue;
          const { top, base } = band;
          let flat = true;
          for (let i = firstIdx; i <= lastIdx; i += 1) {
            if (Math.abs(top[i] - base[i]) > 1e-9) { flat = false; break; }
          }
          /* A side that never rises above its base carries nothing - drawing it
             would paint a line along the zero axis for a series that has no
             negative part at all. */
          if (flat) continue;
          drewBand = true;
          /* Only the buckets inside the zoom window are walked. `toX` clamps
             every index into the window, so the first and last point land
             exactly on the axis edges and the band is cut, not squashed. */
          let d = "";
          for (let i = firstIdx; i <= lastIdx; i += 1) {
            d += `${i === firstIdx ? "M" : "L"}${toX(i).toFixed(1)} ${toY(top[i]).toFixed(1)}`;
          }
          for (let i = lastIdx; i >= firstIdx; i -= 1) {
            d += `L${toX(i).toFixed(1)} ${toY(base[i]).toFixed(1)}`;
          }
          d += "Z";
          fills += `<path d="${d}" fill="${esc(color)}"`
            + ` fill-opacity="${FILL_OPACITY}" stroke="none"/>`;

          let edge = "";
          for (let i = firstIdx; i <= lastIdx; i += 1) {
            edge += `${i === firstIdx ? "M" : "L"}${toX(i).toFixed(1)} ${toY(top[i]).toFixed(1)}`;
          }
          edges += `<path d="${edge}" fill="none" stroke="${esc(color)}"`
            + ` stroke-width="${STROKE_WIDTH}" stroke-opacity="1"`
            + " stroke-linejoin=\"round\" stroke-linecap=\"round\"/>";
        }
      });

      /* Every series was flat in this window - an idle day, or four PV ports that
         never produced anything. An empty box says "the chart is broken" when the
         truth is "the values are zero", so the baseline itself is drawn in each
         series colour. They coincide, and by the same overlap rule as everywhere
         else the last one wins. */
      if (stackedDraw && !drewBand && layers.length) {
        const y = yZero.toFixed(1);
        const xa = toX(firstIdx).toFixed(1);
        const xb = toX(lastIdx).toFixed(1);
        layers.forEach((layer) => {
          edges += `<path d="M${xa} ${y}L${xb} ${y}" fill="none"`
            + ` stroke="${esc(layer.series.color)}"`
            + ` stroke-width="${STROKE_WIDTH}" stroke-opacity="1"`
            + " stroke-linecap=\"round\"/>";
        });
      }

      const xLabels = this._xLabels(times, toX, H, win);

      return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
                   style="height:${H}px"
                   xmlns="http://www.w3.org/2000/svg" role="img">
        ${grid}
        ${fills}
        ${edges}
        ${xLabels}
        ${this._hoverLayer(data, pane, toX, yTop, yBot, div, axDecimals, display, hidden)}
      </svg>`;
    }

    _xLabels(times, toX, H, win) {
      const y = H - PAD_B + 18;
      const W = this._width();
      const picks = [];
      const seen = new Set();

      /* Zoomed in, the fixed "every three hours" grid can end up with zero or
         one tick inside the window. The labels then fall back to an even
         sample of the visible buckets, formatted to the minute. */
      const window = win || { from: 0, to: times.length - 1, narrow: false };
      const first = Math.max(0, Math.floor(window.from));
      const last = Math.min(times.length - 1, Math.ceil(window.to));
      const inWindow = (i) => i >= first && i <= last;

      if (this._range === "day") {
        /* While zoomed the tick spacing follows the visible span, otherwise a
           two-hour window would show at most one label (the fixed grid is
           every three hours). */
        const spanMin = last > first
          ? (num(times[last]) - num(times[first])) / 60000
          : 1440;
        const halfHour = spanMin <= 120;
        const hourly = !halfHour && spanMin <= 480;
        times.forEach((t, i) => {
          if (!inWindow(i)) return;
          const d = new Date(num(t));
          const h = d.getHours();
          const m = d.getMinutes();
          let text = null;
          if (halfHour) {
            // On the hour or on the half hour, allowing for bucket drift.
            if (m <= 6) text = `${pad2(h)}:00`;
            else if (Math.abs(m - 30) <= 6) text = `${pad2(h)}:30`;
          } else if (hourly) {
            if (m <= 6) text = `${pad2(h)}:00`;
          } else if (m <= 6 && h % 3 === 0) {
            text = `${pad2(h)}:00`;
          }
          if (!text || seen.has(text)) return;
          seen.add(text);
          picks.push({ i, text });
        });
      } else if (this._range === "month") {
        times.forEach((t, i) => {
          if (!inWindow(i)) return;
          const d = new Date(num(t));
          const day = d.getDate();
          if (d.getHours() !== 0 || seen.has(day)) return;
          if (day !== 1 && day % 5 !== 0) return;
          seen.add(day);
          picks.push({ i, text: String(day) });
        });
      } else {
        times.forEach((t, i) => {
          if (!inWindow(i)) return;
          const m = new Date(num(t)).getMonth();
          if (seen.has(m)) return;
          seen.add(m);
          picks.push({ i, text: String(m + 1) });
        });
      }

      if (picks.length < 2 && last > first) {
        return this._evenXLabels(times, toX, y, first, last);
      }

      return picks.map((p) => {
        const x = toX(p.i);
        const anchor = x < PAD_L + 8 ? "start" : x > W - PAD_R - 8 ? "end" : "middle";
        return `<text class="axis" x="${x.toFixed(1)}" y="${y}"
          text-anchor="${anchor}">${esc(p.text)}</text>`;
      }).join("");
    }

    /**
     * N evenly spaced timestamps between two bucket indices.
     *
     * Only used while zoomed: the normal tick grid is anchored to round hours
     * (or days/months), so a window of a few minutes can fall entirely between
     * two of them and leave the axis blank.
     */
    _evenXLabels(times, toX, y, first, last) {
      const W = this._width();
      const count = Math.min(6, last - first + 1);
      if (count < 2) return "";
      const out = [];
      for (let k = 0; k < count; k += 1) {
        const i = Math.round(first + ((last - first) * k) / (count - 1));
        const d = new Date(num(times[Math.min(Math.max(i, 0), times.length - 1)]));
        let text;
        if (this._range === "year") {
          text = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
        } else if (this._range === "month") {
          text = `${d.getMonth() + 1}/${d.getDate()}`;
        } else {
          text = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
        }
        const x = toX(i);
        const anchor = x < PAD_L + 8 ? "start" : x > W - PAD_R - 8 ? "end" : "middle";
        out.push(`<text class="axis" x="${x.toFixed(1)}" y="${y}"
          text-anchor="${anchor}">${esc(text)}</text>`);
      }
      return out.join("");
    }

    _hoverLayer(data, pane, toX, yTop, yBot, div, axDecimals, display, hidden) {
      const W = this._width();
      // A hover can come from this card (bucket index) or from another card in
      // the group (timestamp, which may sit on a different bucket grid), so the
      // index is resolved to a fractional position instead of being assumed.
      const pos = this._hoverPosition(data);
      if (pos == null) return "";
      const i = Math.min(Math.max(pos, 0), data.times.length - 1);
      const x = toX(i);
      const when = new Date(num(data.times[i]));
      const stamp = this._range === "day"
        ? `${pad2(when.getHours())}:${pad2(when.getMinutes())}`
        : this._range === "month"
          ? `${when.getMonth() + 1}/${when.getDate()}`
          : `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;

      /* The tooltip must speak the same unit as the axis: the numbers are
         divided by the axis divisor, so recomputing the unit from the data
         maximum here printed "0.09 W" for what the axis calls 0.09 kW. */
      const dec = Math.min((axDecimals || 0) + 1, 2);
      /* Only the curves that are actually drawn get a row. Listing a switched
         off series in the tooltip would contradict the chart right above it. */
      const rows = data.values
        .map((vals, k) => ({
          color: data.series[k].color,
          name: this._sName(data.series[k], pane),
          value: vals[i],
          src: data.srcIndex && data.srcIndex[k] != null ? data.srcIndex[k] : k,
        }))
        .filter((row) => !hidden.has(row.src));
      /* Every curve is switched off: there is nothing to report, and an empty
         box with just a timestamp would be noise. */
      if (!rows.length) return "";

      const lineH = 17;
      const boxW = 210;
      const boxH = 22 + rows.length * lineH;
      const boxX = x + 12 + boxW > W - PAD_R ? x - 12 - boxW : x + 12;
      const boxY = Math.min(yTop + 4, yBot - boxH);

      let box = `<rect class="tipbox" x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}"
          width="${boxW}" height="${boxH}" rx="8"/>`;
      box += `<text class="tiptext" x="${(boxX + 10).toFixed(1)}" y="${(boxY + 15).toFixed(1)}"
        style="font-weight:600">${esc(stamp)}</text>`;
      rows.forEach((row, k) => {
        const y = boxY + 15 + (k + 1) * lineH;
        const v = row.value / div;
        const text = v.toFixed(dec);
        box += "<g>";
        box += `<circle cx="${(boxX + 14).toFixed(1)}" cy="${(y - 4).toFixed(1)}" r="4"
            fill="${esc(row.color)}"/>`;
        box += `<text class="tiptext" x="${(boxX + 26).toFixed(1)}" y="${y.toFixed(1)}">${esc(
          String(row.name).slice(0, 20),
        )}</text>`;
        box += `<text class="tiptext" x="${(boxX + boxW - 10).toFixed(1)}" y="${y.toFixed(1)}"
            text-anchor="end" style="font-weight:600">${text}${esc(display.unit ? ` ${display.unit}` : "")}</text>`;
        box += "</g>";
      });

      return `<line class="guide" x1="${x.toFixed(1)}" y1="${yTop}" x2="${x.toFixed(1)}"
        y2="${yBot}"/>${box}`;
    }

    /* ---------------------------- interaction ---------------------------- */

    /**
     * Where the guide line belongs, as a bucket index, or null when nothing is
     * hovered.
     *
     * The hover is stored as a timestamp, not an index, because one card can
     * draw several panes: each pane builds its own bucket grid from whatever
     * statistics it got, so the same instant can sit at different indices. The
     * nearest bucket is found by binary search - statistics buckets are *not*
     * evenly spaced either (a device that was offline leaves a hole in the
     * series), so an index cannot be derived from a linear scale.
     */
    _hoverPosition(data) {
      const times = data.times;
      const n = times.length;
      if (!n) return null;
      const target = this._hoverTime;
      if (target == null) return null;

      const first = num(times[0]);
      const last = num(times[n - 1]);
      const gap = n > 1 ? (last - first) / (n - 1) : Math.max(last - first, 1);
      // Only reject a hover that belongs to a different window (e.g. the group
      // has moved on). Inside the range the nearest bucket is always used, even
      // when the hovered instant falls in one of this card's data gaps.
      if (target < first - gap || target > last + gap) return null;

      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (num(times[mid]) < target) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0
        && Math.abs(num(times[lo - 1]) - target) <= Math.abs(num(times[lo]) - target)) {
        return lo - 1;
      }
      return lo;
    }

    /** The config indices one pane currently has switched off. */
    _hiddenOf(paneIndex) {
      const list = this._hidden ? this._hidden[paneIndex] : null;
      return new Set(Array.isArray(list) ? list : []);
    }

    /** Flip one curve of one pane between drawn and switched off. */
    _toggleSeries(paneIndex, index) {
      const next = (this._hidden || []).map((list) => (
        Array.isArray(list) ? [...list] : []
      ));
      while (next.length <= paneIndex) next.push([]);
      const list = next[paneIndex];
      const at = list.indexOf(index);
      if (at >= 0) list.splice(at, 1);
      else list.push(index);
      /* A new array: lit only re-renders when the reference moves. */
      this._hidden = next;
      this.requestUpdate();
    }

    /** Draw every curve of one pane again. */
    _showAllSeries(paneIndex) {
      const list = this._hidden ? this._hidden[paneIndex] : null;
      if (!Array.isArray(list) || !list.length) return;
      const next = this._hidden.map((entry) => (Array.isArray(entry) ? [...entry] : []));
      next[paneIndex] = [];
      this._hidden = next;
      this.requestUpdate();
    }

    /**
     * Track the pointer. `time` is the hovered instant, or null to clear it.
     *
     * The hover is broadcast as a timestamp, so the other panes and the other
     * cards in the group can place their own guide line even if their buckets
     * are coarser.
     */
    _setHover(time) {
      const next = time == null ? null : num(time);
      if (this._hoverTime === next) return;
      this._remoteTime = null;
      this._hoverTime = next;
      this.requestUpdate();
      this._pushHover(next);
    }

    /* ------------------------------- zoom ------------------------------- */

    /** Pointer position as a fraction of the plot area (0 = left edge). */
    _pointerRatio(event) {
      const host = event.currentTarget;
      const svg = host && host.querySelector ? host.querySelector("svg") : null;
      if (!svg) return 0.5;
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return 0.5;
      // The svg is stretched by CSS, so map through the viewBox coordinates.
      const vbX = ((event.clientX - rect.left) / rect.width) * this._width();
      const ratio = (vbX - PAD_L) / (this._width() - PAD_R - PAD_L);
      return Math.min(Math.max(ratio, 0), 1);
    }

    /**
     * Wheel: zoom the time axis around the pointer.
     *
     * The anchor stays under the cursor, which is what makes repeated notches
     * feel like they zoom into one spot rather than towards the middle.
     */
    _onWheel(event, paneIndex) {
      if (this._config && this._config.zoom === false) return;
      const data = this._data ? this._data[paneIndex] : null;
      if (!data || data.times.length < 3) return;
      // Keep the page still: a wheel over the chart is a zoom, not a scroll.
      event.preventDefault();

      const current = this._zoom || { a: 0, b: 1 };
      const ratio = this._pointerRatio(event);
      const anchor = current.a + ratio * (current.b - current.a);
      const factor = Math.exp(num(event.deltaY) * ZOOM_WHEEL);
      const span = Math.min(
        Math.max((current.b - current.a) * factor, ZOOM_MIN_SPAN),
        1,
      );

      // Zoomed all the way out: forget the state so the card is "unzoomed".
      if (span >= 0.999) {
        this._resetZoom();
        return;
      }

      let a = anchor - ratio * span;
      let b = a + span;
      if (a < 0) { a = 0; b = span; }
      if (b > 1) { b = 1; a = 1 - span; }

      this._zoom = { a, b };
      this._drag = null;
      this.requestUpdate();
    }

    /** Drag (while zoomed): pan the window sideways. */
    _onDragStart(event, paneIndex) {
      if (!this._zoom || event.button !== 0) return;
      const data = this._data ? this._data[paneIndex] : null;
      if (!data || data.times.length < 3) return;
      this._drag = { x: event.clientX, zoom: { ...this._zoom } };
      this._suppressClick = false;
      /* Only the class changes here - no `requestUpdate()`, and no
         `preventDefault()`: either one would cost us the click that ends this
         gesture (see the note in the constructor). */
      const host = event.currentTarget;
      if (host && host.classList) host.classList.add("dragging");
      this._dragging = true;
    }

    _onDragMove(event) {
      const drag = this._drag;
      if (!drag) return false;
      const svg = event.currentTarget.querySelector
        ? event.currentTarget.querySelector("svg")
        : null;
      if (!svg) return false;
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return false;

      const dx = event.clientX - drag.x;
      // A few pixels of jitter should still count as a click, not a pan.
      if (Math.abs(dx) > 3) this._suppressClick = true;
      if (!this._suppressClick) return true;

      const span = drag.zoom.b - drag.zoom.a;
      const shift = -(dx / rect.width) * span;

      let a = drag.zoom.a + shift;
      let b = a + span;
      if (a < 0) { a = 0; b = span; }
      if (b > 1) { b = 1; a = 1 - span; }

      this._zoom = { a, b };
      this.requestUpdate();
      return true;
    }

    _resetDrag() {
      this._drag = null;
      this._dragging = false;
      /* Straight to the DOM: a re-render here would drop the click event that
         follows the mouseup, and that click is the double-click-to-reset. */
      const root = this.shadowRoot;
      if (!root) return;
      root.querySelectorAll(".chart.dragging").forEach((el) => {
        el.classList.remove("dragging");
      });
    }

    /**
     * Click on the plot: reset the zoom on a double click, otherwise switch
     * every curve of the pane back on.
     *
     * The native `dblclick` is not relied on: every click re-renders the pane
     * (the guide line moves, the drag class flips), and Chrome drops the
     * double-click when the target it started on is no longer the same node.
     * Timing two clicks here is immune to that.
     */
    _onChartClick(paneIndex) {
      if (this._suppressClick) { this._suppressClick = false; return; }
      const now = Date.now();
      const isDouble = this._lastClickAt > 0
        && now - this._lastClickAt < DOUBLE_CLICK_MS
        && this._lastClickPane === paneIndex;
      this._lastClickAt = isDouble ? 0 : now;
      this._lastClickPane = paneIndex;
      if (isDouble) {
        this._resetZoom();
        return;
      }
      this._showAllSeries(paneIndex);
    }

    _resetZoom() {
      const had = this._zoom != null;
      this._resetDrag();
      if (!had) return;
      this._zoom = null;
      this.requestUpdate();
    }

    _onMove(event, paneIndex) {
      const data = this._data ? this._data[paneIndex] : null;
      if (!data || data.times.length < 2) return;
      if (this._onDragMove(event)) return;
      if (!event.currentTarget.querySelector("svg")) return;
      // Inside the zoom window the pointer maps onto `from..to`, not 0..count.
      const win = zoomWindow(this._zoom, data.times.length);
      const ratio = this._pointerRatio(event);
      const exact = win.from + ratio * (win.to - win.from);
      const index = Math.round(Math.min(Math.max(exact, 0), data.times.length - 1));
      this._setHover(num(data.times[index]));
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
  class HoymilesHistoryChartEditor extends LitElement {
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
        ha-textfield, ha-select { display: block; width: 100%; margin-bottom: 8px; }
        .hint { font-size: 12px; color: var(--secondary-text-color); padding: 0 10px 8px; }
        .sw { display: flex; align-items: center; gap: 10px; padding: 6px 0;
              font-size: 14px; color: var(--primary-text-color); }
      `;
    }

    render() {
      const config = this._config || {};
      return html`
        <div class="row">
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="range (day|month|year)" .value=${config.range || "day"}
            @change=${this._changed("range")}></ha-textfield>
          <ha-textfield label="unit (W|%)" .value=${config.unit || ""}
            @change=${this._changed("unit")}></ha-textfield>
          <ha-textfield label="height (px)" .value=${config.height || ""}
            @change=${this._changed("height")}></ha-textfield>
          <ha-textfield label="sync_group" .value=${config.sync_group || ""}
            @change=${this._changed("sync_group")}></ha-textfield>
          <label class="sw">
            <ha-switch .checked=${config.symmetric !== false}
              @change=${this._toggle("symmetric")}></ha-switch>
            <span>symmetric (off = bottom-up axis, for SOC / temperature)</span>
          </label>
          <label class="sw">
            <ha-switch .checked=${config.stack === true}
              @change=${this._toggle("stack")}></ha-switch>
            <span>stack (power and energy series only - never a level like SOC)</span>
          </label>
          <label class="sw">
            <ha-switch .checked=${config.show_toolbar !== false}
              @change=${this._toggle("show_toolbar")}></ha-switch>
            <span>show_toolbar (this card's own time controls)</span>
          </label>
          <label class="sw">
            <ha-switch .checked=${config.skip_empty !== false}
              @change=${this._toggle("skip_empty")}></ha-switch>
            <span>skip_empty (hide curves that recorded nothing in the period)</span>
          </label>
        </div>
        <div class="hint">
          ${"Curves are configured with the `series` list (entity / name / color) in the YAML editor."}
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-history-chart-editor")) {
    customElements.define("hoymiles-history-chart-editor", HoymilesHistoryChartEditor);
  }
  if (!customElements.get("hoymiles-history-chart")) {
    customElements.define("hoymiles-history-chart", HoymilesHistoryChart);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-history-chart")) {
    window.customCards.push({
      type: "hoymiles-history-chart",
      name: "Hoymiles History Chart",
      description:
        "Power / SOC history with a day-month-year selector and date navigator, "
        + "built from Home Assistant long term statistics.",
      preview: false,
    });
  }
}

/* Register on any page that has Lit.
 *
 * `window.__hmWhenLit` is provided by the bootstrap bundle (`hoymiles-base.js`)
 * and hands over the LitElement class directly, which is the only way that
 * works on pages where `ha-panel-lovelace` never appears. Without it the card
 * falls back to waiting for that element, which is enough on a dashboard.
 */
function _hmHistoryBoot() {
  if (window.__hmWhenLit) {
    window.__hmWhenLit((Lit) => _hmHistoryRegister(Lit));
    return;
  }
  if (customElements.get("ha-panel-lovelace")) {
    _hmHistoryRegister();
    return;
  }
  customElements.whenDefined("ha-panel-lovelace")
    .then(() => _hmHistoryRegister())
    .catch(() => {});
}

_hmHistoryBoot();
