# Card reference

Complete option list for the eight Lovelace cards bundled with the
`hoymiles` custom integration.

**English** · [简体中文](CARDS.zh-Hans.md)

---

## How the cards are loaded

The integration registers all eight cards as frontend modules when it starts, so
there is **no "add resource" step** and no CDN is used. Add a card with
**Add card → Manual** and paste YAML, or add it directly to a dashboard YAML file.

After the integration is installed and Home Assistant has restarted, the cards
appear as `custom:hoymiles-*`.

> Changed a card file? Hard-refresh the browser (`Ctrl` + `F5`).

## Options shared by every card

| Option | Type | Description |
|---|---|---|
| `dev_id` | string | Device identifier, `<client_prefix>-<SN>` (e.g. `MSA-280520260806`). Required on all cards except the gauge, which is entity-driven. |
| `language` | `zh` \| `en` | **Follows Home Assistant.** Leave it out and the card uses the language of the HA user viewing it (any `zh-*` code selects Chinese). Set it only to pin one card to a language. |
| `title` | string | Card heading. Defaults are per-card (see below). |
| `show_title` | bool | Set `false` to hide the heading (and, on some cards, the device SN). |

How `dev_id` is used: the card derives the entity ids it needs from it
(`sensor.<dev_id_slug>_<suffix>`). When your entities do not follow that pattern,
override them individually with the card's `entities:` map.

### How the language is chosen

1. An explicit `language: en` / `language: zh` in the card config wins. Use it only
   to pin one card to a language.
2. Otherwise the card follows the **Home Assistant user's** language, which each
   user sets in **Profile → Language**. Any code starting with `zh` (`zh-Hans`,
   `zh-Hant`, `zh-Hans-CN`) selects Chinese; everything else selects English.
3. Because it is resolved per render, changing the profile language updates every
   card live — no reload and no config change.

> This is why a shared dashboard reads correctly for an English and a Chinese user
> at the same time: the language is a property of the viewer, not of the card.

> `hoymiles-gauge` is the exception — it has no built-in wording at all. Every word
> on it comes from your own `name` / `label` / `icon`, so it never needs translating.

### Making your own text follow the language too

The language rule above covers the wording *inside* the cards. The text **you** write
in YAML - card titles, series names, gauge names, `balancer_label` - is yours, so the
card cannot translate it. It can, however, pick between the languages you supply:
write a **map** instead of a string.

```yaml
type: custom:hoymiles-history-chart
# instead of:  title: History
title:
  en: History
  zh: 历史数据
series:
  - entity: sensor.x_pv_power
    name:
      en: PV power
      zh: 发电功率
```

The card looks up the resolved language (`zh` or `en`). A map that is missing the
current language falls back to `en`, then to whichever entry exists, so a partial map
is never blank. A plain string keeps working exactly as before, which is why every
existing dashboard is unaffected.

Supported on these options:

| Card | Options that accept a map |
|---|---|
| all cards | `title` |
| `hoymiles-history-chart` | `title`, `series[].name` |
| `hoymiles-gauge` | `name`, `label` |
| `hoymiles-energy-sankey` | `title`, `balancer_label` |

> Because the visual card editor holds plain strings, a map shows there as an empty
> field and the label says `accepts an en/zh map`. Edit those options in the YAML
> editor (⋮ → *Edit in YAML*) rather than the visual one.

> Home Assistant's own cards - `markdown`, and the view/tab titles - belong to HA, not
> to this integration, so their text cannot follow the language. Keep those
> language-neutral, or pick one language for them.

### Why the view tabs cannot follow the language

Home Assistant resolves a view's tab label from `view.title` **without any
localization**:

```js
// home-assistant/frontend - src/data/lovelace/config/view.ts
computeViewTitle = (view, index) => view.title ?? (view.path ? titleCase(view.path) : String(index));
```

Contrast with HA's built-in Energy panel, which localizes its own tab titles by
generating the view from a *strategy* (`hass.localize(...)`) - a mechanism that
needs the whole view to come from JavaScript, so it is not worth coupling a
dashboard to it just for a label.

Two things follow, both easy to get wrong:

1. **A `view.title` is a fixed string.** There is no per-user language for it. If
   you want text that reads correctly for both audiences, write it bilingually -
   for example `System status / 系统状态`. A neutral heading inside the view
   (emoji + device SN) is the other option.
2. **Setting `icon` hides the title.** HA renders *either* the icon *or* the title
   unless you ask for both:

   ```js
   const icon_and_title = view.show_icon_and_title && view.icon && view.title;
   const icon_only = view.icon && !icon_and_title;
   ```

   So a view with an `icon` but no `show_icon_and_title: true` shows **only the
   icon** - the title survives merely as a tooltip. Add the flag when you want the
   icon and the label side by side.

---

## 1. `custom:hoymiles-power-flow`

Draws the system as a **wiring diagram**, the way the vendor app's system
screen does: one icon per branch, the unit in the middle, the grid tie point as
a junction dot, and thick rounded connectors carrying moving pearls. The icons
are the app's own artwork, embedded in the card.

```
⬜ PV1 ──┐                    ┌── ⬜ PV2
         ├── ▣ unit ───── ● ── ── ⬜ grid
⬜ storage ┘                  └── ⬜ load
                               └── ⬜ smart plug
```

- **The unit in the middle works as soon as anything flows through it**, so its
  artwork is the coloured one then and the dim one when the whole system is idle.
```yaml
type: custom:hoymiles-power-flow
dev_id: MSA-280520260806
title: 我的家
language: zh
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized *My home* | Heading text. |
| `show_title` | bool | `true` | `false` hides the title and the device SN, leaving only the signal icon. |
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `temperature_entity` | entity id | — | Outdoor temperature shown next to the title. |
| `show_rssi` | bool | `true` | Wi-Fi signal fan in the top-right corner. |
| `gradient` | bool | `true` | Draw the plain **white** backdrop the schematic sits on. `false` leaves the card background instead — pair it with a light theme, since the diagram's text colours are fixed. |
| `max_width` | number (px) | `620` | Maximum width of the illustration; it stays centred. |
| `flow_speed` | number | `1` | Speed multiplier for the moving pearls. `0.5` is calmer, `2` is faster. |
| `entities` | map | — | Entity overrides, keyed by suffix (see below). |

### Data sources

All values come from plain entity states — **the recorder is not required** — and
every branch reads the 1 s *quick state* system entity, the same numbers the
vendor app's system page shows:

| Node | Entity suffix (`sensor.<dev>_…`) |
|---|---|
| PV1 (top-left) | `sys_pv_p` |
| PV2 (top-right) | `sys_pv2_p` |
| Grid (right) | `sys_grid_p` (positive = importing) |
| Load (bottom-right) | `sys_load_p` |
| Smart plug (bottom-right, below load) | `sys_sp_p` |
| Storage (bottom-left) | `sys_bat_p` (negative = charging), falls back to `bat_p`; SOC from `sys_soc` |
| Status | `battery_status` (`standby` / `charge` / `discharge` / `lock`) |
| Signal fan | `rssi` (dBm) |

### Behaviour notes

- **A branch that carries power (`|P| >= 5 W`) is drawn in colour; an idle one
  uses the grey variant of the same icon**, which is how the app says "nothing
  happening here" without you having to read the number.
- A branch whose entity is **missing** (a slave unit reports no system level
  values) is left out entirely, together with its connector.
- The grid caption follows the flow: *Grid in* while importing, *Grid out*
  while exporting, plain *Grid* at ~0 W — it does not claim a direction it
  cannot see.
- The two diagonal branches (PV2 and load) are plain connectors - there is no
  direction arrow anywhere in the picture.  Which way the power goes is shown
  by the pearls, and only by them.
- A connector only shows moving pearls when that branch carries **≥ 5 W**,
  and the pearls always travel **with** the energy: out of PV1 / PV2, out of a
  discharging battery, in from a charging grid, back into a charging battery,
  out of the inverter when it feeds the house and back into it when the grid
  or the PV2 branch charges the battery, and into the load / smart plug.
  Pearl colour follows the branch, and speed rises with power.
- Travel time is computed from the **path length**, so a short stub and a long
  line look like the same speed - the fastest branch crosses in about 1.5 s,
  short stubs are held to a 1.0 s floor and a long line at low power takes at
  most 6 s. Tune the whole card with `flow_speed`.
- **The RSSI fan** uses four ascending bars; the number of lit bars indicates
  quality, with the `-21 dBm` reading next to it. Hovering shows a
  description:

  | RSSI | Bars lit |
  |---|---|
  | ≥ −55 dBm | 4 (excellent) |
  | ≥ −65 dBm | 3 (good) |
  | ≥ −75 dBm | 2 (fair) |
  | < −75 dBm | 1 (weak) |

  Hidden automatically when the device does not report `rssi`; disable with
  `show_rssi: false`.
- Override individual entities with the suffix-keyed `entities:` map:

  ```yaml
  entities:
    system_pv_power: sensor.my_pv_power
    system_battery_power: sensor.my_battery_power
    system_grid_power: sensor.my_grid_power
    system_load_power: sensor.my_load_power
    system_smart_plug_power: sensor.my_system_smart_plug_power
    soc: sensor.my_soc
    battery_status: sensor.my_battery_status
    rssi: sensor.my_rssi
  ```

### Sign conventions

`sys_grid_p` is **positive while importing** and the storage power is
**negative while charging**; the card normalises both before drawing. A node
carrying no power gets a grey ring — never a *standby* chip.

---

## 2. `custom:hoymiles-battery`

Draws the physical battery stack module by module, so the picture always matches
how many packs are actually installed (1–4), each with its own SOC and
temperature callout alternating left / right. The illustration follows the
product photos: one body with a single light-to-dark gradient, thin seams
between the modules, the brand badge on the first module, and a dark head
drawing the hardware's **display bar** — the power symbol, the PV reading with
its SOLAR caption, the SOC between two chevrons, and the battery reading with
its BATTERY caption. The drawn unit is a clean rectangle: no side panel, no
feet.

  - SOLAR and BATTERY show **this unit's own** `pv_power` / `bat_power` (the
    panel depicts the device itself); the corner callouts keep the system level
    readings. The values are shown as they are — no zero padding — and clamp at
    four digits (9999 W).
  - **The chevrons are the charge / discharge indicator**: charging draws the
    left one, discharging the right one, both in white, and an idle battery
    draws neither. Charging is negative battery power, matching the firmware.

The head module is also where the **host temperature** is called out.

```yaml
type: custom:hoymiles-battery
dev_id: MSA-280520260806
title: HiBattery 4020 X
language: zh
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | detected model | Overrides the model read from the device registry. |
| `show_title` | bool | `true` | `false` hides the heading. |
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `show_history` | bool | `true` | Optional history section (needs the recorder). |
| `show_host_temp` | bool | `true` | `false` hides the head unit temperature. |
| `max_width` | number (px) | `560` | Maximum width of the illustration. |
| `alarm_entity` | entity id | — | Shows a bell next to the title while this entity is `on`. |
| `entities` | map | — | Entity overrides (see below). |

| `entities` key | Meaning |
|---|---|
| `pack_count` | Number of installed packs |
| `pv` | PV power |
| `grid_on` | On-grid port power |
| `grid_off` | Off-grid / EPS port power |
| `battery` | Battery power |
| `battery_status` | Battery status |
| `soc` | System SOC |
| `pack<N>_soc` | Per-pack SOC |
| `pack<N>_temperature` | Per-pack temperature |
| `battery_temperature` | Firmware's own battery temperature (head temperature fallback) |

### Behaviour notes

- **The title defaults to the model in the device registry** — in our test unit
  that is `HiBattery 4020 X`, taken from the firmware's MQTT discovery
  `device.model`. Different model, no config change; an explicit `title` wins.
- Pack count prefers the `pack_count` sensor (from `pack_num` in
  `device/state`) and falls back to counting how many `pack1_soc`…`pack4_soc`
  actually report a value. The upper bound is 4, matching the firmware's own
  truncation.
- Per-pack values use `pack<i>_soc` / `pack<i>_temperature`; the surrounding
  powers use `pv_power`, `grid_on_power`, `grid_off_power`, `battery_power`.
- **The head unit temperature is the average of the installed packs**, drawn as
  one more callout in the same style as the per-pack ones — the head has no
  sensor of its own, so the vendor app shows the same measure. Packs that report
  no temperature are skipped, and if none of them do the firmware's
  `battery_temperature` (`bat_temp`) is used instead. `show_host_temp: false`
  removes the callout.
- The signal bars next to the title are derived from `rssi` (dBm).
- The history section (optional) reads long-term statistics via
  `recorder/statistics_during_period`, plotting pack SOC and summarising charge /
  discharge energy for the range. If the recorder is off you only get a notice —
  the rest of the card still works.

---

## 3. `custom:hoymiles-pack-list`

A compact alternative to the battery illustration: one row per pack, SOC bar on
the left, SOC percentage and heating flag on the right. Pack count follows the
same rule as the battery card.

```yaml
type: custom:hoymiles-pack-list
dev_id: MSA-280520260806
language: zh
title: 电池电量
columns: 2
show_temperature: false
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized *Battery* | Heading text. |
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `columns` | number | `1` | Lay the rows out in N columns. Omit for a single column. |
| `show_temperature` | bool | `true` | `false` shows SOC only, dropping the ℃ reading. |

---

## 4. `custom:hoymiles-history-chart`

Day / month / year curves with date navigation, drawn like the vendor app's
history pages. Positive values stack upward from the zero line and negative
values stack downward, so a charge/discharge sensor reads naturally on both sides
of the axis.

```yaml
type: custom:hoymiles-history-chart
dev_id: MSA-280520260806
title: 历史数据
language: zh
range: day
height: 330
unit: W
series:
  - entity: sensor.x_pv_power
    name: 发电功率
    color: "#22c55e"
  - entity: sensor.x_system_battery_power
    name: 放电[+]/充电[-]
    color: "#4a90d9"
```

| Option | Type | Default | Description |
|---|---|---|---|
| `series` | list | — | **Required.** One entry per curve: `entity`, `name`, `color`. |
| `dev_id` | string | — | Optional when every series names an explicit `entity`. |
| `title` | string | — | Card heading. |
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `range` | `day` \| `month` \| `year` | `day` | Initial time range. |
| `height` | number (px) | `330` | SVG height. |
| `unit` | string | — | Y-axis unit label. Auto-promotes to kW above 1.5 kW. |
| `zero_line` | bool | `true` | Draw the zero line. |
| `symmetric` | bool | `true` | `false` draws a bottom-up axis from min to max — use it for SOC. |
| `stack` | bool | = `symmetric` | `false` overlays the curves instead of stacking them. Leave it off for a *level* (SOC, temperature); stack only series that add up (power, energy). |
| `min` / `max` | number | — | Fixed axis limits. |
| `span` | number | — | Fixed half-range when `symmetric` is on. |
| `sync_group` | string | — | Cards sharing a group share their time window (range + date). |
| `show_toolbar` | bool | `true` | `false` hides this card's own time controls — use it on the followers. |

### Behaviour notes

- **Data comes from `recorder/statistics_during_period`** (long-term statistics),
  so no administrator rights are needed and the database file is never touched.
- The time selector matches the vendor app: a date pill (`‹` `›` around the date)
  top-left, a day/month/year dropdown top-right, and rounded pill legends below
  the curve.
- Axis ticks pick their decimal places from the actual step, so a 1.25 kW step
  shows `1.25` instead of rounding to `1`.
- Fixing `span` / `min` / `max` keeps the same scale across different days, which
  makes side-by-side comparison possible.
- **Stacking follows the axis unless you say otherwise.** Power and energy
  series stack, because `charge + discharge` is a sum worth reading as a total.
  A *level* must never stack: three packs at 81 % would be drawn at 0..81 %,
  81..162 % and 162..243 %, so on a 0..100 axis only the first pack stays
  visible. `symmetric: false` (the SOC / temperature axis) therefore overlays
  by default; `stack: true` / `false` overrides it either way.
- **Click a legend entry to highlight that curve** — the selected curve thickens
  and brightens while the others fade back. Click it again (or click the chart)
  to clear. The tooltip dims faded curves to match.
- **Hovering shows a guide line and a tooltip at the same instant on every chart
  in the same `sync_group`** (for example *History* driving *Battery SOC*).
  Matching is by timestamp, so charts with different bucket sizes or data gaps
  still line up.
- `show_toolbar: false` plus `sync_group` gives you a dashboard where one chart
  controls and the others follow.
- A card removes itself from its group when it is deleted, leaving nothing behind.

---

## 5. `custom:hoymiles-gauge`

A stat tile: title and icon on top, big value in the middle, and one green arc at
the bottom filled by the value's share of `min`…`max`, with the percentage printed
inside the arc.

```yaml
type: custom:hoymiles-gauge
entity: sensor.msa_280520260806_battery_charge_energy_today
name: 今日充电量
unit: kWh
scale: 0.001
max: 10
min: 0
decimals: 2
icon: ⚡
label: 自发自用率
color: "#22c55e"
```

| Option | Type | Default | Description |
|---|---|---|---|
| `entity` | entity id | — | **Required.** Drives the big readout. |
| `name` | string | entity name | Title. |
| `unit` | string | entity unit | Display unit. |
| `scale` | number | `1` | Multiplier applied before display. `0.001` turns Wh into kWh. |
| `max` | number | — | Upper limit **in display units**. Omit to let the arc grow with the value. |
| `min` | number | `0` | Lower limit. |
| `decimals` | number | `2` | Decimal places in the readout. |
| `icon` | string | — | Emoji / glyph shown next to the title. |
| `label` | string | — | Caption under the percentage. |
| `color` | CSS colour | `#22c55e` | Arc colour. |
| `show_arc` | bool | `true` | `false` drops the arch and its percentage, leaving a plain readout. |

### Ratio mode

When the interesting number is a ratio between entities rather than a share of an
invented ceiling, give the arc its own source. The big readout still shows
`entity`; only the arc and its percentage come from the ratio.

| Option | Description |
|---|---|
| `percent_numerator` | Required for ratio mode. |
| `percent_subtract` | Optional, taken off the numerator. |
| `percent_denominator` | Optional, defaults to the numerator. |

```yaml
type: custom:hoymiles-gauge
entity: sensor.msa_280520260806_system_pv_energy_today
name: 今日发电量
unit: kWh
scale: 0.001
icon: ☀️
label: 自发自用率
percent_numerator: sensor.msa_280520260806_system_pv_energy_today
percent_subtract: sensor.msa_280520260806_grid_on_energy_out_total
percent_denominator: sensor.msa_280520260806_system_pv_energy_today
```

Self-consumption = *PV energy − exported energy* ÷ *PV energy*.

### Behaviour notes

- Percentage = `(value − min) / (max − min) × 100`, rounded to a whole number,
  clamped to 0–100 %.
- While the entity has no data yet the arc is still drawn empty and the value and
  percentage read `—`, so the card never turns into a blank space.
- Set `max: 100` and point it at a SOC sensor for a battery-percentage tile.

---

## 6. `custom:hoymiles-control`

Every command in section 10–20 of the MQTT protocol guide, as buttons and inputs.
Commands are published **straight to the protocol topics** (qos 1, retain false),
so the card keeps working even if a discovery entity is missing or offers a
narrower option list than the protocol allows. Current values are read back from
the matching entities when they exist.

```yaml
type: custom:hoymiles-control
dev_id: MSA-280520260806
language: zh
title: 设备控制
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized *Control* | Card heading. |
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `show_power_ctrl` | bool | `true` | `false` hides the *Power control* row. |
| `show_phase` | bool | `true` | `false` hides the *Per-phase output power* row. |
| `show_log` | bool | `true` | `false` hides the *MQTT log* row (the log itself is off by default). |
| `show_topics` | bool | `false` | Show the MQTT topic under each row (debugging). |
| `subtitle` | bool | `true` | `false` hides the grey line next to the title. |

### Rows and topics

| Row | Protocol topic | Notes |
|---|---|---|
| Device on/off | `switch/<dev_id>/set` | `ON` / `OFF` |
| EMS mode | `select/<dev_id>/ems_mode/command` | `general` / `mqtt_ctrl` / `tou_plan`; unsupported options are greyed out |
| Power control | `number/<dev_id>/power_ctrl/set` | Only effective in `mqtt_ctrl` mode; must be sent at least once a minute |
| Output power | `number/<dev_id>/output_power/set` | Full-load output ceiling (W) |
| Per-phase output power | `number/<dev_id>/phase_output_power/set` | Sent as `{"phase_a":..,"phase_b":..,"phase_c":..}` |
| Fetch TOU plan | `sensor/<dev_id>/tou_plan/get` | The reply is published on `tou_plan/status` |
| Reboot | `button/<dev_id>/reboot/trigger` | Sends `RESTART` after a confirmation |
| MQTT log | *(subscribes only, sends nothing)* | Off by default; on, it streams what the device reports and what HA sends |

### MQTT log

The last row of *Plan & maintenance* is an **MQTT log**, **off by default**. Turning it
on subscribes to two wildcards over the Home Assistant websocket (the
`mqtt/subscribe` command) and interleaves both directions on one timeline:

| Wildcard | Carries |
|---|---|
| `homeassistant/+/<dev_id>/#` | what the device publishes (`quick/state` every second, `device/state`, `system/state`, `tou_plan/status`, the discovery configs) plus what HA sends (`set`, `command`, `trigger`, `get`) |
| `hoymiles/<dev_id>/#` | the integration's own topics (`availability`, the EMS mode echo) |

- Direction is read off the topic: the command side (`/set`, `/command`,
  `/trigger`, `/get`) is *HA → device*, everything else on those trees is
  *device → HA*, and the `hoymiles/` family belongs to this end as well.
- Every row shows the time, a direction badge, the topic with the boilerplate
  stripped (`sensor/quick/state`; the full topic is the tooltip) and the payload,
  pretty printed when it is JSON and truncated when it is long.
- The list keeps the **latest 200 messages** (a `quick/state` a second is about
  three minutes), counts what it dropped, and scrolls to the newest message
  unless you have scrolled up to read.
- While it is off **nothing is subscribed**, so the card costs nothing; leaving
  the view unsubscribes and coming back resumes it.
- We could not make this cheaper: `mqtt/subscribe` is **admin-only** in Home
  Assistant, so a non-admin user sees an explanation instead of a stream.

### Behaviour notes

- Range hints such as `-1000 ~ 1000 W` prefer the entity's `min` / `max`
  attributes, falling back to protocol defaults.
- The layout follows the iOS settings idiom: rounded groups, small grey section
  headers (**Power & mode / Power settings / Plan & maintenance**), rows of
  icon + name + right-aligned control, and hairlines that stop short of the card
  edge. On/off and EMS mode use segmented controls; reboot is red.
- **Power on/off is slow** — the firmware has to bring the PCS (and the packs)
  down or up. The card shows the requested state as *pending* for up to 5 s until
  the device reports it, then keeps a tick visible for a moment.
- MQTT topics are hidden by default because they are engineering detail that
  crowds out the content; enable `show_topics: true` when debugging.
- The **MQTT log** (see above) is a per-card switch, not a global one: it is off
  until you turn it on, and `show_log: false` removes the row entirely.

---

## 7. `custom:hoymiles-tou-editor`

The visual TOU plan editor. It talks to the device through the integration
services (`hoymiles.set_tou_day_plan`, `set_tou_week_plan`, `get_tou_plan`,
`set_ems_mode`) and falls back to `mqtt.publish` if the integration is somehow
absent.

```yaml
type: custom:hoymiles-tou-editor
dev_id: MSA-280520260806
language: zh
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized | Card heading. |
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `require_tou_mode` | bool | `true` | The editor only renders while EMS mode is `tou_plan`. Set `false` to disable that gate. |
| `ems_entity` | entity id | auto | Override the entity used to read EMS mode. |
| `status_entity` | entity id | auto | Override the entity used to read the plan status. |
| `day_ack_entity` | entity id | auto | Override the day-plan acknowledgement entity. |
| `week_ack_entity` | entity id | auto | Override the week-plan acknowledgement entity. |

### Behaviour notes

- A day is a list of segments with `mode` / `ts` / `te` / `sh` / `sl` / `pc` / `pd`.
  `ts` and `te` are quarter-hour slots, `0`–`96`.
- Modes: `1` force charge, `2` PV charge, `4` discharge.
- The card writes `day1`…`day8`, then the week plan, then switches EMS mode to
  `tou_plan`, then reads the current day back.
- The plan editor has its own UI config editor, so it can also be added and
  configured graphically from the dashboard.

> **Why the EMS gate exists.** Early firmware shipped no `state_topic` for
> `ems_mode`, so the integration maintains a **retained state topic** of its own
> at `hoymiles/<dev_id>/ems_mode/state`:
>
> - as soon as anyone publishes to `…/ems_mode/command`, the integration echoes
>   it to that topic, so the UI and cards refresh immediately;
> - it also follows `ems_mode` inside `system/state` (the device's real running
>   mode, on a 5-minute cycle) and corrects itself, so a device-side timeout back
>   to `general` shows up.
>
> Why not just point `state_topic` at `system/state`: that topic only arrives
> every 5 minutes, and this card gates on the select state, which would leave the
> editor stuck for up to 5 minutes after switching to `tou_plan`.

---

## 8. `custom:hoymiles-energy-sankey`

A source → sink energy-flow sankey built from long-term statistics.

```yaml
type: custom:hoymiles-energy-sankey
dev_id: MSA-280520260806
title: 能量流
language: zh
range: today
```

| Option | Type | Default | Description |
|---|---|---|---|
| `dev_id` | string | — | **Required.** |
| `title` | string | localized | Card heading. |
| `language` | `zh` \| `en` | *auto* | Pin the card's language. Omit it to follow the Home Assistant user's language. |
| `range` | `today` \| `7d` \| `30d` \| `month` | `today` | Time range. |
| `balancer_label` | string | localized | Name of the *Loss* / *Unmetered* residual node. |
| `show_toolbar` | bool | `true` | `false` hides the range switcher. |
| `ribbon_gap` | number (px) | `3` | White gap between ribbons. |
| `ribbon_opacity` | number | `0.5` | Ribbon opacity, 0–1. |
| `icons` | map | — | Per-node emoji overrides, e.g. `pv: "☀️"`. |
| `statistics` | string \| list \| map | — | Override the default `statistic_id`s. A value may be a single id or a list; multiple ids are summed. |

### Data source

The card calls Home Assistant's official WebSocket statistics endpoint:

```
recorder/statistics_during_period
  statistic_ids: [...]       # this device's energy sensors
  period: "day"
  units: {energy: "kWh"}     # unit conversion done server-side
  types: ["change"]          # HA's already-computed delta for the range
```

Therefore:

- The recorder **database file is never touched** — no SQLite reads, no exposure
  to schema migrations.
- **No administrator rights** are required (`statistics_during_period` is not
  admin-gated).
- Only the recorder integration is needed, and it is part of `default_config`.
- Rendering is hand-rolled SVG with **no CDN**, so it works offline.

### Interaction

Click a ribbon to highlight that single flow, or click a node box to highlight
every ribbon touching it. The rest of the diagram dims and a detail panel lists
the involved flows. Click the same target again (or empty space) to clear. This
is view state only — the numbers never change.

### About the "Loss / Unmetered" node

A sankey requires conservation, but the device meters every port **separately**
(conversion losses, sampling phase, unmetered loads all create a difference).
Rather than normalising and scaling the flows, the card draws the difference as
an explicit node — a positive residual becomes *Loss*, a negative one becomes
*Unmetered* — which keeps the diagram conserved and every ribbon truthful.

### Rendering caveat

Each side is a single column of node boxes. Because the device meters each port
separately, the routing behind the ribbons is **not measured**: it is estimated by
spreading each source over the sinks proportionally (iterative proportional
fitting), forbidding impossible loops such as battery-discharge →
battery-charge. Read the ribbons as a best-effort attribution, not as metered
truth.

### Relationship to the official Energy dashboard

Home Assistant's Energy dashboard has a sankey-style *Energy distribution* card,
but its nodes are fixed to **solar / grid / battery / home**. For comparison you
can configure it as follows:

| Slot | Suggested entity |
|---|---|
| Solar | `sensor.<dev>_system_pv_energy_today` |
| Grid consumption | `sensor.<dev>_grid_on_energy_in_total` |
| Return to grid | `sensor.<dev>_grid_on_energy_out_total` |
| Battery charge | `sensor.<dev>_battery_charge_energy_today` |
| Battery discharge | `sensor.<dev>_battery_discharge_energy_today` |

> **Prefer the `*_total` cumulative sensors** (`grid_on_*` / `inv_*` with `etin` /
> `etout`). The `*_today` sensors reset every day, and Home Assistant reads a
> cross-day drop **after a long outage** as a device reset, losing the deltas in
> between. Cumulative sensors do not have that problem.

The device-specific **EPS / smart plug / off-grid** ports do not fit the official
model — that is what this card is for.
