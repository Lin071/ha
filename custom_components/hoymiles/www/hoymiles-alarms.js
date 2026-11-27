/* ============================================================================
 * Hoymiles Micro Storage — Active alarms card
 * ----------------------------------------------------------------------------
 * Lovelace card: `custom:hoymiles-alarms`
 *
 * Protocol V0.6.2 §27: the device publishes the complete list of alarms that
 * have not ended yet (`alarm/state`), at most 20 of them, and republishes the
 * whole list whenever it changes.  The integration turns that into the
 * `Active Alarms` sensor: the state is the count, `attributes.alarms` is the
 * list, already decoded from code to text and already newest-first.
 *
 * This card only draws that list.  It deliberately has no acknowledge button:
 * the protocol has no way to acknowledge an alarm, so a button would either lie
 * or do nothing.
 *
 * Card config:
 *   type: custom:hoymiles-alarms
 *   dev_id: MSA-280520260806
 *   language: en               # optional (en|zh|de); omit to follow the picker
 *   title: Alarms              # optional; accepts an en/zh map
 *   entity: sensor.whatever    # optional; skip the lookup entirely
 *   max: 5                     # optional; show at most N rows (hard cap 20)
 * ========================================================================== */

function _hmAlarmsRegister() {
  const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
  const html = LitElement.prototype.html;
  const css = LitElement.prototype.css;

  /* ------------------------------------------------------------------ *
   * Language
   *
   * Same mechanism as the other cards: one localStorage key plus one window
   * event, so the dropdown on any card switches every card on the page.
   *
   * The alarm NAMES are not in here. The protocol appendix is English-only, so
   * the integration ships the Chinese wording itself (see ALARM_CODES_*_ZH in
   * const.py) and puts it on every list item as `name_zh`; this card picks the
   * field that matches the language. Doing it that way keeps one table in one
   * place instead of 160 strings duplicated in this file, and a code that the
   * hand-written table misses simply keeps its English name.
   * ------------------------------------------------------------------ */
  const T_DE = {
    "Alarms": "Alarme",
    "No active alarms": "Keine aktiven Alarme",
    "No alarm data": "Keine Alarmdaten",
    "Alarm data unavailable": "Alarmdaten nicht verf\u00fcgbar",
  };

  function hmNormalise(value) {
    const raw = String(value == null ? "" : value).toLowerCase();
    if (raw.startsWith("zh")) return "zh";
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("en")) return "en";
    return "";
  }

  const LANG_KEY = "hoymiles.language";
  const LANG_EVENT = "hoymiles-language";

  function hmStored() {
    try {
      return hmNormalise(window.localStorage.getItem(LANG_KEY));
    } catch (err) {
      return "";
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

  function hmPick(lang, en, zh) {
    if (lang === "zh") return zh;
    if (lang === "de") {
      const de = T_DE[en];
      return de == null ? en : de;
    }
    return en;
  }

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

  function hmField(value) {
    return typeof value === "string" ? value : "";
  }

  function slug(id) {
    return String(id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function norm(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  /**
   * The SN part of `<prefix>-<SN>`.
   *
   * The integration names its entities after the **device name**, not after the
   * SN: rename the device to "G3" and the entity becomes
   * `sensor.g3_msa_280577777777_active_alarms`. The SN survives inside that
   * name, the device name does not - and the frontend no longer exposes
   * `unique_id`, so the SN is the only stable thing to key on.
   */
  function serialOf(devId) {
    const parts = String(devId == null ? "" : devId).split("-");
    return parts[parts.length - 1].toLowerCase();
  }

  /** Protocol §27 sends at most 20 alarms; more than that would not arrive. */
  const ALARM_MAX = 20;

  /* ------------------------------------------------------------------ *
   * Alarm time
   *
   * The firmware sends `26-01-01 20:20` - two-digit year, no seconds.  The
   * card shows `2026-01-01 20:20`, because a two-digit year in a list of
   * events is a riddle rather than a date.  Anything else is passed through
   * unchanged: a format change on the device must not blank the column.
   * ------------------------------------------------------------------ */
  const STAMP = /^(\d{2})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

  function hmStamp(value) {
    const text = String(value == null ? "" : value).trim();
    const hit = STAMP.exec(text);
    if (!hit) return text;
    return `20${hit[1]}-${hit[2]}-${hit[3]} ${hit[4]}:${hit[5]}`;
  }

  class HoymilesAlarms extends LitElement {
    static get properties() {
      return { _config: { type: Object }, _hass: { type: Object } };
    }

    constructor() {
      super();
      this._hass = null;
      this._config = null;
      this._cache = null;
    }

    static getConfigElement() {
      return document.createElement("hoymiles-alarms-editor");
    }

    static getStubConfig() {
      return { dev_id: "" };
    }

    static get styles() {
      return css`
        /* The card fills whatever height the row gives it (the Device page puts
           this next to the illustration, and that card grows with the number of
           battery packs), so the list must take the space that is LEFT rather
           than stop at a fixed 260 px.  flex-grow 1 + min-height 0 is what lets
           a flex child shrink below its content: without the zero the list would
           refuse to scroll and push the card taller than its neighbour. */
        :host { display: block; height: 100%; }
        ha-card { padding: 12px 14px 14px; height: 100%; box-sizing: border-box;
                  display: flex; flex-direction: column; }
        .title { font-size: 15px; font-weight: 600; display: flex;
                 align-items: baseline; gap: 8px; flex: 0 0 auto;
                 color: var(--primary-text-color); margin-bottom: 10px; }
        .count { font-size: 12.5px; font-weight: 500;
                 color: var(--secondary-text-color); }
        .none { font-size: 12.5px; color: var(--secondary-text-color); }
        /* No default max-height: the scrollbar appears when the list runs out of
           card, not six rows early.  The custom property still caps it for
           anyone who wants a fixed window. */
        .list { display: flex; flex-direction: column; gap: 8px;
                flex: 1 1 auto; min-height: 0;
                overflow-y: auto; overscroll-behavior: contain;
                max-height: var(--hm-alarms-max-height, none);
                padding-right: 2px; }
        .row { display: grid; grid-template-columns: auto 1fr;
               gap: 2px 10px; align-items: baseline; }
        .code { font-size: 11.5px; font-variant-numeric: tabular-nums;
                padding: 1px 6px; border-radius: 9px;
                color: var(--error-color, #db4437);
                background: rgba(219, 68, 55, 0.12);
                border: 1px solid rgba(219, 68, 55, 0.35); }
        .nm { font-size: 13px; color: var(--primary-text-color);
              overflow-wrap: anywhere; }
        .time { grid-column: 2; font-size: 11.5px;
                color: var(--secondary-text-color);
                font-variant-numeric: tabular-nums; }
        /* A restored list is the last thing the device said, not necessarily
           what is true now - so the card has to say so rather than presenting
           it as a live reading. */
        .stale { margin-top: 10px; flex: 0 0 auto; font-size: 11.5px;
                 color: var(--warning-color, #f59e0b); }
      `;
    }

    setConfig(config) {
      if (!config || !(config.dev_id || config.entity)) {
        throw new Error("hoymiles-alarms: 'dev_id' is required");
      }
      this._config = { ...config };
      this._cache = null;
    }

    set hass(hass) {
      this._hass = hass;
      this._syncHidden();
      this.requestUpdate();
    }

    /**
     * Collapse the card when there is nothing to report.
     *
     * The Device page puts this card next to the device illustration in a
     * horizontal stack.  Home Assistant's card wrapper hides itself when the
     * element it wraps is `hidden`, and a flex row then hands the freed width to
     * the illustration - which is why that row is a stack and not a 2-column
     * grid, whose columns stay put and leave half the row blank.
     *
     * Deciding it here rather than with a `visibility` template keeps it working
     * after the entity is renamed, and the green tick in the illustration's head
     * band already carries the "all clear" - a second box saying "no active
     * alarms" was only occupying space.
     *
     * Assigned in the `hass` setter rather than in `render()` because the
     * wrapper checks `hidden` immediately after forwarding `hass`; a render-time
     * assignment would be seen one update later, so the empty box would flash on
     * every page load.
     */
    _syncHidden() {
      const alarms = this._alarms();
      this.hidden = !alarms || alarms.length === 0;
    }

    getCardSize() {
      const alarms = this._alarms();
      return 2 + Math.min(this._limit(), alarms ? alarms.length : 0) + (this._stale() ? 1 : 0);
    }

    connectedCallback() {
      super.connectedCallback();
      this._onLangChange = () => this.requestUpdate();
      window.addEventListener(LANG_EVENT, this._onLangChange);
    }

    disconnectedCallback() {
      window.removeEventListener(LANG_EVENT, this._onLangChange);
      super.disconnectedCallback();
    }

    _t(en, zh) {
      return hmPick(hmLang(this._hass, this._config), en, zh);
    }

    /**
     * One alarm's wording, in the language the reader picked.
     *
     * `name` is always the documented English text. `name_zh` is added by the
     * integration only when the code is translated, so its absence is the
     * signal to keep the English name - except for a code the protocol does not
     * document at all (`Unknown alarm 999`), where only the words need swapping.
     */
    _alarmName(item) {
      if (!item) return "—";
      const en = item.name || "—";
      if (hmLang(this._hass, this._config) !== "zh") return en;
      if (item.name_zh) return item.name_zh;
      return String(en).replace(/^Unknown alarm\b/, "未知告警");
    }

    _limit() {
      const asked = Number(this._config && this._config.max);
      if (!Number.isFinite(asked) || asked <= 0) return ALARM_MAX;
      return Math.min(Math.floor(asked), ALARM_MAX);
    }

    /* ----------------------------- lookups ----------------------------- */

    /**
     * The alarm entity: an explicit `entity:` wins, otherwise the sensor is
     * found by the SN inside its entity id.
     *
     * `hass.entities` used to carry `unique_id`, and the first version of this
     * card looked the sensor up that way. The frontend stopped exposing it, so
     * the unique_id lookup silently returned nothing and the card reported
     * "unavailable" on a perfectly healthy device. The SN in the entity id is
     * the stable identifier that is still visible.
     *
     * Picking **which** sensor is the harder half, because one SN can end up
     * with more than one alarm entity: a duplicate config entry that was added
     * with a different prefix (`MAW-280425390014` beside `MSA-280425390014`),
     * or the firmware's own MQTT discovery creating a parallel device. The old
     * rule - shortest id wins - could not tell them apart when the two ids have
     * the same length, so it took whichever came first in `hass.states` and had
     * a 50 % chance of reading the dead one. An `unavailable` sensor has no
     * attributes, so the list came back empty and the card hid itself - while
     * the illustration next to it (which resolves its entity a different way)
     * happily showed "4 active alarms". Two cards, two answers, same device.
     *
     * The order below is therefore: the id this page's own `dev_id` implies
     * first, then a live entity, and only then the shortest id.
     */
    _entityId() {
      if (this._config.entities && this._config.entities.alarms) {
        return this._config.entities.alarms;
      }
      if (this._config.entity) return this._config.entity;

      const hass = this._hass;
      if (!hass || !hass.states) return null;
      /* A cached id is only reused while it actually answers: the duplicate
         entity this rule exists for can be the one that was cached, and the
         cache must not make the wrong choice sticky. */
      if (this._cache && hass.states[this._cache]) {
        const cached = hass.states[this._cache];
        if (cached.state !== "unavailable" && cached.state !== "unknown") {
          return this._cache;
        }
        this._cache = null;
      }

      const devId = this._config.dev_id;
      if (!devId) return null;

      const serial = serialOf(devId);
      const suffix = "_active_alarms";
      /* What this page is about: the entity the device name implies. Renaming a
         device keeps the SN inside the id, so this is only a hint - the loop
         below still accepts any id that carries the SN. */
      const expected = "sensor." + slug(devId) + suffix;

      let found = null;
      let foundScore = -1;
      for (const entityId of Object.keys(hass.states)) {
        if (!entityId.startsWith("sensor.")) continue;
        if (!entityId.endsWith(suffix)) continue;
        if (!entityId.includes(serial)) continue;
        const state = hass.states[entityId];
        const live = !!state && state.state !== "unavailable" && state.state !== "unknown";
        /* Higher is better. 3 = the id this page implies *and* it answers, so a
           duplicate entry can never win it. Ties fall back to the shortest id,
           which is the previous behaviour. */
        const score = (entityId === expected ? 2 : 0) + (live ? 1 : 0);
        if (score > foundScore
          || (score === foundScore && found && entityId.length < found.length)) {
          found = entityId;
          foundScore = score;
        }
      }

      if (found) this._cache = found;
      return found;
    }

    /**
     * The decoded alarm list.
     *
     * `null` means "this device says nothing about alarms" - an older firmware
     * has no alarm topic at all, and a V0.6.2 unit that has not published it
     * since Home Assistant started has no list either.  Both are reported as
     * unknown rather than as "nothing is wrong", because the card cannot know.
     */
    _alarms() {
      const entityId = this._entityId();
      if (!entityId) return null;
      const state = (this._hass.states || {})[entityId];
      if (!state) return null;
      const items = state.attributes && state.attributes.alarms;
      if (!Array.isArray(items)) return null;
      return items.slice(0, this._limit());
    }

    /** True while the list shown was restored by Home Assistant, not received. */
    _stale() {
      const entityId = this._entityId();
      if (!entityId) return false;
      const state = (this._hass.states || {})[entityId];
      return !!(state && state.attributes && state.attributes.stale === true);
    }

    /* ----------------------------- rendering ----------------------------- */

    render() {
      if (!this._config) return html``;
      const title = hmText(this._config.title, hmLang(this._hass, this._config))
        || this._t("Alarms", "告警");

      const alarms = this._alarms();
      if (alarms == null) {
        // No entity: either the device is not on V0.6.2, or it has not
        // published the retained-free alarm topic since Home Assistant started.
        return html`
          <ha-card>
            <div class="title">${title}</div>
            <div class="none">${this._t("Alarm data unavailable", "告警数据不可用")}</div>
          </ha-card>
        `;
      }

      const rows = alarms.map((item) => {
        const code = item && item.code != null ? String(item.code) : "";
        const name = this._alarmName(item);
        const time = hmStamp(item && item.time);
        return html`
          <div class="row">
            ${code ? html`<span class="code">${code}</span>` : html`<span></span>`}
            <span class="nm">${name}</span>
            ${time ? html`<span class="time">${time}</span>` : ""}
          </div>`;
      });

      return html`
        <ha-card>
          <div class="title">
            ${title}
            ${alarms.length ? html`<span class="count">${alarms.length}</span>` : ""}
          </div>
          ${alarms.length === 0
            ? html`<div class="none">${this._t("No active alarms", "当前无告警")}</div>`
            : html`<div class="list">${rows}</div>`}
          ${this._stale()
            ? html`<div class="stale" title=${
              this._t("The device only publishes the list when it changes, so this is what it last reported.",
                "设备只在列表变化时发布，所以这里是它最后一次上报的内容。")}>
                ${this._t("last known - not confirmed since startup",
                  "上次已知 · 本次启动后尚未确认")}</div>`
            : ""}
        </ha-card>
      `;
    }
  }

  /* ------------------------------------------------------------------ *
   * Visual editor
   * ------------------------------------------------------------------ */
  class HoymilesAlarmsEditor extends LitElement {
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
          <ha-textfield label="title (accepts an en/zh map)" .value=${hmField(config.title)}
            @change=${this._changed("title")}></ha-textfield>
          <ha-textfield label="max rows (default 20)" .value=${config.max || ""}
            @change=${this._changed("max")}></ha-textfield>
        </div>
      `;
    }
  }

  if (!customElements.get("hoymiles-alarms-editor")) {
    customElements.define("hoymiles-alarms-editor", HoymilesAlarmsEditor);
  }
  if (!customElements.get("hoymiles-alarms")) {
    customElements.define("hoymiles-alarms", HoymilesAlarms);
  }

  window.customCards = window.customCards || [];
  if (!window.customCards.some((card) => card.type === "hoymiles-alarms")) {
    window.customCards.push({
      type: "hoymiles-alarms",
      name: "Hoymiles Alarms",
      description: "List of alarms the device has not cleared yet (V0.6.2).",
      preview: false,
    });
  }
}

if (customElements.get("ha-panel-lovelace")) {
  _hmAlarmsRegister();
} else {
  customElements.whenDefined("ha-panel-lovelace").then(() => _hmAlarmsRegister());
}
