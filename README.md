# Zero Light

A clear, concise desktop app (Tauri 2 + TypeScript/Vite): pick a location and
a target, and it shows the **best times to hunt and fish that day** — at most
four labelled slots (★ Best / ✓ Good / · Okay), one plain reason each, a day
verdict, and a "Day held back by:" line. A Trends view shows hunting/fishing
viability day by day over a week and a month.

**Version 0.2.0** — renamed from "Fishing and Hunting Predictor" (v0.1.x). v1 scope: three preset locations (Tampa Bay FL saltwater,
Lake Guntersville AL freshwater, Tuscaloosa AL hunting/river) plus custom
coordinates; nine targets (Snook, Redfish, Speckled Trout, Largemouth Bass,
Crappie, Catfish, Whitetail Deer, Waterfowl, Turkey); today / tomorrow /
day-after planning.

**0.1.1 (fix):** the 0.1.0 build's interface failed to finish starting up —
several element lookups in `src/main.ts` were missing their `#` id prefix, so
setup stopped before any data loaded and the planner stayed empty. All
lookups fixed, and a CSS rule now keeps the custom-coordinates row hidden
until Custom is chosen. Caught by rendering the app for screenshots;
verified fixed in a headless browser against live forecast and tide data.

## Configuration

| Item | Value |
| --- | --- |
| App identifier | `com.wf.robot.muse.zerolight` |
| Product name | `ZeroLight` |
| Window | 1150 × 820, title `Zero Light` |
| Stack | Tauri 2, TypeScript + Vite (port 1420), Rust core (app-info command only — logic is in the frontend) |

## How the scoring works (evidence rules)

The engine (`src/scoring.ts`, pure functions) implements the project's
research spec — SlotScore = DayQuality (0–50: season + temperature band +
front package) + AnchorScore (0–40: dawn/dusk light, moving water for
saltwater; overlap = larger + 8, capped) + SlotModifiers (−20…+10), computed
hourly and merged into 1.5–3 h slots:

- **What carries the score:** light (dawn/dusk, night for catfish), season
  windows, temperature vs the species' prime band, and moving tidal current
  in saltwater.
- **Solunar is capped, hard:** at most +3 (major) / +1 (minor) as a
  tie-breaker in saltwater only, **+0 if a tide anchor already scored the
  slot** (no double-counting), **+0 for deer and freshwater — it never
  creates a slot.** GPS-collar and catch-record studies found moon phase and
  solunar periods have ~zero effect for deer and freshwater fish.
- **Pressure:** no pressure band is hard-coded. Pressure trend alone moves
  the score by at most **±2** inside the front-package term (turkey
  rising-pressure: up to +4, the one peer-reviewed result). The trend is
  computed from Open-Meteo `pressure_msl` — the NWS hourly forecast has no
  pressure field.
- **Moon phase and solar/Kp score exactly 0** and are not inputs.
- **Vetoes outrank scores:** a red-tide/closure/dangerous-weather veto caps
  the day at 20 and replaces the slots with a plain "Don't go" state
  (engine support in v1; live HAB feeds are a later version).
- Labels are absolute: ≥75 Best, 60–74 Good, 45–59 Okay, below hidden —
  except the top slot of a weak day may show as "Best today" next to an
  explicitly Fair/Poor verdict.

Astronomy (sunrise/sunset, moonrise/moonset, moon phase/illumination, moon
transit) is computed locally with SunCalc — no astronomy API, works offline.

## Data sources

| Data | Source | Key? |
| --- | --- | --- |
| Hourly weather + forecast (16 d) | Open-Meteo forecast API | No |
| Tide predictions (Tampa preset, station 8726520 St. Petersburg) | NOAA CO-OPS `product=predictions` (hilo + hourly) | No |
| Astronomy / solunar periods | SunCalc, computed locally | — |
| Beyond the forecast horizon (Trends) | Astronomy + season only, labelled **"typical"** — never presented as a forecast | — |

**Open-Meteo commercial note:** the Open-Meteo free tier used here is
**non-commercial — development use only.** A commercial launch must move to
Open-Meteo's paid customer plan or to the (free, US-only) NWS API.

## API keys — none in this repo

**Never commit any API key.** This repository is public. The USGS Water Data
API key and NOAA NCEI CDO token registered for this project stay in the
project mailbox / secure credential storage and out of the repo. v1 makes no
USGS/NCEI calls. `src/config.ts` reads *optional* keys from localStorage
settings fields so a user can paste their own on their own machine; they
default to empty and are stored only on that device.

## v1 simplifications (known, deliberate)

- Fish temperature bands are scored against **air temperature as a proxy** —
  v1 has no live water-temperature feed (USGS gauges / lake monitoring are
  the planned source).
- Hunting season windows are **generic month ranges**, not state agency
  rut/season tables (those are static per-state ingests, planned).
- Custom coordinates are treated as having **no tide station**; tides are
  wired only to the Tampa preset. Times are handled in the device's local
  timezone.
- No live red-tide/HAB, USGS flow, or dam-release data yet — all identified
  in the project research as later additions.

## Development

```sh
npm install
npm run build        # tsc + vite build (validation)
npm run test:smoke   # scoring-engine smoke test (scripts/smoke.mjs)
npm run tauri dev    # run the desktop app
```

The smoke test compiles `src/scoring.ts` standalone and asserts: ≤4 slots
per day, best-to-worst ranking (10-point tie rule), labels matching the
thresholds, **zero solunar points for deer/freshwater**, the saltwater
no-double-count rule, the ±2 pressure cap, and veto behaviour.

## CI (GitHub Actions)

Pushes to `main` run `.github/workflows/tauri.yml` (inherited unchanged from
the verified Tauri foundation) as a 4-way matrix — Windows (NSIS + MSI,
per-user install, no admin), macOS Apple Silicon (dmg/app), Linux x64 and
Linux ARM64 (deb/AppImage) — uploading each bundle set as a run artifact.
Builds are unsigned (SmartScreen/Gatekeeper warnings apply) until signing is
configured.

## License

Copyright (c) 2026 Wade Feltman. All rights reserved. See [LICENSE](LICENSE).
This is not open-source software; no license to use, copy, modify, or
distribute it is granted.
