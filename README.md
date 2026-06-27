# datasiphon

Turn captured browser traffic into clean, reproducible data harvests.

Modern sites load their data from "hidden" JSON APIs that the page never fully
shows. Your browser already records every one of those requests. `datasiphon`
takes that capture (a HAR file or a single "Copy as cURL" string), finds the
request that carries the data, and turns it into a repeatable harvest that
outputs a spreadsheet plus a recipe other people can re-run and verify.

It is built for newsroom developers and data journalists. The goal is not to
defeat anti-bot systems but to close the last mile between "I found the API in
the Network tab" and "I have clean, documented data."

## Why a recipe

Every harvest produces a `recipe.yaml`: a human-readable record of the endpoint,
headers, pagination, and field mapping used to collect the data. It is the
"show your work" artifact: version it, share it, and let an editor or another
newsroom reproduce your collection exactly.

## Status

The full loop works end to end:

- `inspect` ranks the requests in a HAR file to find the likely data endpoint
- `init` generates a `recipe.yaml` (format, record path, and pagination
  auto-detected, with an optional live probe)
- `run` harvests every page and writes CSV, SQLite, and a manifest
- `peek` normalizes a cURL command piped on stdin

Formats supported: JSON, XML, and HTML tables.
Pagination supported: offset, page number, cursor, "next" field/URL, and the
HTTP `Link` header (`rel="next"`).

## Install

```bash
npm install
```

## Usage

```bash
# 1. Which request in this capture is the data?
npm run siphon -- inspect examples/sample.har

# 2. Turn the top-ranked request into a recipe (or use --pick N from inspect)
npm run siphon -- init examples/sample.har -o recipe.yaml

# 3. Review recipe.yaml, then harvest every page
npm run siphon -- run recipe.yaml

# Resume an interrupted harvest where it left off
npm run siphon -- run recipe.yaml --resume

# Quick check of a "Copy as cURL" string
pbpaste | npm run siphon -- peek
```

After `npm run build`, the `datasiphon` binary runs the same commands directly.

### When the HAR has no response bodies

Browsers often save HARs without response bodies ("Save all as HAR" vs "...with
content"). Then `inspect` can only rank by URL signals, and `init` can't see
the data shape. Use `--probe` so `init` fetches the endpoint once to detect the
format, record path, and pagination:

```bash
npm run siphon -- init capture.har --pick 1 --probe
```

`init` probes automatically when it has no record path and you haven't passed
`--no-probe`. Probing only fetches GET requests.

### When the endpoint is a config that points elsewhere

Some sites serve a configuration object instead of the data: a chart or
dashboard loads a small JSON file describing how to render, and that file names
the real data file in a `dataUrl` (or `dataFileName`) field. CDC's COVE
visualizations work this way.

When `--probe` fetches a response like that and finds no record array of its
own, it follows the `dataUrl` (resolving relative paths against the config URL)
and builds the recipe from the file that actually holds the records:

```bash
npm run siphon -- init cdc-config.curl --probe
# Probing https://www.cdc.gov/measles/weekly-cases-chart.json ...
#   config response points elsewhere; following dataUrl to .../MeaslesCasesWeekly.json
# source: GET https://www.cdc.gov/wcms/vizdata/measles/MeaslesCasesWeekly.json
```

It follows at most three hops and stops if a `dataUrl` loops back on itself.

### Formats

`init` detects whether a response is JSON, XML, or HTML and writes the right
`rows` block:

- JSON / XML: `rows.path` is a small JSONPath (`$.results`, `$.records.record`)
- HTML: `rows.selector` is a CSS selector for the repeating row; add
  `rows.fields` to map named columns to per-row selectors, or let it fall back
  to table cells (`c1`, `c2`, ...).

For HTML, `--probe` suggests a `rows.selector` by finding the largest data
table on the page (or, failing that, the most-repeated element). When the table
has a header row it also pre-fills `rows.fields` from the column headers. The
suggestion is a starting point: review it before harvesting.

### Secrets

By default `init` keeps headers like `Authorization` and `Cookie` (often
required) and warns you to treat the recipe as a secret. Use `--redact` to move
them out of the recipe into environment variables:

```bash
npm run siphon -- init capture.har --probe --redact
# recipe now has: Authorization: ${DATASIPHON_AUTHORIZATION}
DATASIPHON_AUTHORIZATION='Bearer ...' npm run siphon -- run recipe.yaml
```

### Try the whole loop offline

```bash
node examples/mock-server.mjs        # test API on :8787, leave running
# in another shell:
npm run siphon -- run examples/local-recipe.yaml
```

The mock server exposes endpoints for every supported pattern (offset, Link
header, cursor, XML, HTML, and an auth-protected route) so you can try
`init --probe` and `run` against each one.

### Fixtures from real APIs

Real two-page captures used as regression fixtures, each exercising a different
real-world shape:

| Fixture | Source | Exercises |
| --- | --- | --- |
| `socrata_nyc311.har` | NYC 311 (Socrata) | top-level array, `$offset`/`$limit` |
| `socrata_la_crime.har` | LAPD crime, data.lacity.org (Socrata) | same, LA data |
| `arcgis_la_streetlights.har` | LA Bureau of Street Lighting (ArcGIS) | `$.features`/`attributes`, `resultOffset`, `exceededTransferLimit` |

Regenerate them (or capture new fixtures) with the bundled script, which fetches
live pages and writes a HAR with response bodies:

```bash
# Socrata
node examples/capture.mjs \
  --url 'https://data.lacity.org/resource/2nrs-mtv8.json?$limit=5&$offset=0' \
  --out socrata_la_crime --pages 2 --offset-param '$offset' --limit 5

# ArcGIS FeatureServer / MapServer
node examples/capture.mjs \
  --url 'https://maps.lacity.org/lahub/rest/services/Bureau_of_Street_Lighting/MapServer/0/query?where=1=1&outFields=*&returnGeometry=false&resultRecordCount=3&resultOffset=0&f=json' \
  --out arcgis_la_streetlights --pages 2 --offset-param 'resultOffset' --limit 3
```

A `run` produces `<basename>.csv`, `<basename>.sqlite`, and
`<basename>.manifest.json`. The manifest records the source, pagination type,
page and row counts, columns (with their inferred SQLite types), and any
warnings: your reproducibility receipt.

The SQLite table infers a type per column (`INTEGER`, `REAL`, or `TEXT`) so
numbers come back as numbers. Codes that only look numeric are kept as text:
values with a leading zero (ZIP/FIPS codes) and very long digit strings (IDs,
phone numbers) stay `TEXT` so they aren't silently mangled.

## How to capture traffic

`datasiphon` does not intercept traffic itself; your browser already does it
better than a new tool could. Two ways to get a capture:

1. **HAR** (many requests): DevTools > Network tab > right-click > "Save all as
   HAR with content". Best for letting `inspect` find the data endpoint.
2. **cURL** (one request): DevTools > Network tab > right-click a request >
   Copy > "Copy as cURL". Best when you already know which request you want.

## Roadmap

- [x] HAR and cURL parsing
- [x] Request ranking (`inspect`)
- [x] Recipe generation (`init`), with live `--probe`
- [x] Pagination: offset, page, cursor, next field, Link header
- [x] ArcGIS support: `resultOffset`, `exceededTransferLimit`, `attributes` unwrap
- [x] Harvest engine: polite replay, retries, resume (`run`)
- [x] Flatten nested JSON/XML to CSV + SQLite
- [x] XML and HTML-table record extraction
- [x] Secret redaction (`--redact`) + env-var substitution on `run`
- [x] Harvest manifest (source, pagination, row counts, warnings)
- [x] Follow a config's `dataUrl` (CDC-style viz endpoints point elsewhere)
- [x] Auto-suggest an HTML row selector during `--probe`
- [x] Type inference for SQLite columns (INTEGER/REAL/TEXT)

## Not in scope

Bot/captcha evasion, mobile app interception, and headless-browser capture.
Use `mitmproxy` or Playwright for those; `datasiphon` focuses on the last mile.

## License

MIT
