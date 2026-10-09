# Contributing

Thanks for helping improve the Hoymiles Micro Storage integration for Home
Assistant. This repository is a **HACS custom integration** — it is not part of
Home Assistant core and it is not affiliated with Home Assistant.

## Ways to contribute

* **Bug reports and feature requests** — open an
  [issue](https://github.com/hoymiles-ha/ha/issues).
* **Code, docs, translations, dashboard cards** — open a pull request.

**You do not need any special permission to open a pull request.** Fork the
repository, push a branch and open the pull request. Merging, however, is done
by the maintainers only: `main` is protected, every change must arrive via a
pull request and be approved by a maintainer.

## Submitting a pull request

1. **Fork** this repository and branch off `main`
   (`git checkout -b fix/short-description`).
2. Make your change. Keep it focused — **one concern per pull request**.
3. Push to your fork and open a pull request against `main`.
4. CI runs automatically. For a first-time contributor a maintainer has to
   approve the workflow run before it starts — this is a GitHub safety default,
   not a rejection.
5. A maintainer reviews, approves and merges.

### Please do not

* **Bump `version` in `custom_components/hoymiles/manifest.json`.** Versions are
  bumped by maintainers as part of the release process; a version change in a
  pull request will be reverted.
* **Add new runtime dependencies.** The integration deliberately depends only on
  Home Assistant itself (`mqtt`, `http`, `frontend`) plus the Python standard
  library.
* **Load anything from a CDN in the frontend cards.** The cards in
  `custom_components/hoymiles/www/` must work fully offline, so their
  dependencies have to be committed to this repository.
* **Reformat or re-wrap unrelated code.** Large drive-by diffs are hard to
  review and will be asked to be split.

## Where things live

| Path | What it is |
| --- | --- |
| `custom_components/hoymiles/` | The integration (Python): `manifest.json`, `config_flow.py`, `coordinator.py`, `services.py`, platform modules. |
| `custom_components/hoymiles/www/` | Lovelace cards served by the integration (`add_extra_js_url`). |
| `custom_components/hoymiles/translations/` | `en` + `zh-Hans` UI strings. Keep them in sync with `strings.json`. |
| `custom_components/hoymiles/brand/` | Brand images (`icon.png` must be 256x256, `logo.png` landscape). |
| `docs/` | `CARDS.md` and `ARCHITECTURE.md`, each with a `*.zh-Hans.md` mirror. |
| `scripts/` | Maintainer tooling (release, brand image generation). |
| `DEPLOY.md` | Maintainer release / deployment manual. |

## Continuous integration

`.github/workflows/validate.yml` runs two checks on every pull request:

* **HACS validation** (`hacs/action`) — HACS repository/manifest rules.
* **hassfest validation** (`home-assistant/actions/hassfest`) — Home Assistant's
  own integration validator.

Both must pass. They are the same checks that gate the upstream `hacs/default`
listing.

## Compatibility rules

* `hacs.json` declares the minimum supported Home Assistant version. Do not use
  APIs that are newer than that minimum — for example `ConfigFlowResult` or the
  newer `SensorDeviceClass` members do not exist on the oldest supported
  release.
* Do not put angle brackets or HTML in `strings.json` / `translations/*.json` —
  hassfest rejects them as HTML.
* UI strings must stay free of placeholder syntax that reads like a tag, e.g.
  write `client_prefix-SN` rather than wrapping it in angle brackets.

## AI-assisted contributions

Using AI tools to help write a patch is fine. What is not acceptable is an
autonomous agent opening pull requests or issue comments on your behalf: as the
author you must be able to explain every change in your own words and answer
review questions yourself.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](../LICENSE).
