// Data layer — the only place that fetches primary forecast/tide data.
//   Weather: Open-Meteo forecast API (no key, CORS-open). NOTE: the free
//     tier is non-commercial — development use only (see README). When a
//     Layer 2 cache endpoint is configured in Settings, weather requests
//     go to that Worker instead (item #15); it returns the same JSON.
//   Tides: NOAA CO-OPS predictions for the nearest station (item #4).
// All reads pass through the Layer 1 local-first cache (cache.ts).
// Pressure trend is computed from pressure_msl (the NWS hourly forecast
// has no pressure field); see scoring.pressureTrendPer6h.

import type { HourWeather, Tides, TideEvent, TidePoint } from "./scoring";
import { cachedJsonUrl, TTL, type Cached } from "./cache";

export const TAMPA_TIDE_STATION = "8726520"; // St. Petersburg, FL

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map((x) => parseInt(x, 10));
  return new Date(y, m - 1, d);
}

export function addDaysKey(key: string, days: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

export interface WeatherByDay {
  /** key: YYYY-MM-DD (location-local, as returned by Open-Meteo) */
  days: Map<string, HourWeather[]>;
  /** Last day (inclusive, YYYY-MM-DD) covered by the real forecast. */
  forecastThrough: string;
  /** The location's IANA timezone and UTC offset (item #5). */
  timezone: string;
  utcOffsetSec: number;
  /** When the underlying data was fetched (epoch ms) and whether it was
   *  served stale after a failed refresh (item #15). */
  fetchedAt: number;
  stale: boolean;
}

interface OpenMeteoJson {
  timezone?: string;
  utc_offset_seconds?: number;
  hourly: {
    time: string[];
    temperature_2m: number[];
    pressure_msl: number[];
    wind_speed_10m: number[];
    cloud_cover?: number[];
    precipitation_probability?: number[];
  };
}

/** Fetch up to 16 days of hourly forecast, grouped by location-local day. */
export async function fetchWeather(
  lat: number,
  lon: number,
  opts?: { cacheEndpoint?: string; force?: boolean },
): Promise<WeatherByDay> {
  const direct =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,pressure_msl,wind_speed_10m,cloud_cover,precipitation_probability` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=16&timezone=auto`;
  const url = opts?.cacheEndpoint
    ? `${opts.cacheEndpoint.replace(/\/$/, "")}/weather?lat=${lat}&lon=${lon}`
    : direct;
  let res: Cached<OpenMeteoJson>;
  try {
    res = await cachedJsonUrl<OpenMeteoJson>(url, TTL.weatherMs, { force: opts?.force });
  } catch (err) {
    if (!opts?.cacheEndpoint) throw err;
    // A configured-but-unreachable cache endpoint must not break the app.
    res = await cachedJsonUrl<OpenMeteoJson>(direct, TTL.weatherMs, { force: opts?.force });
  }
  const j = res.data;
  const times = j.hourly.time;
  const days = new Map<string, HourWeather[]>();
  let forecastThrough = "";
  for (let i = 0; i < times.length; i++) {
    const key = times[i].slice(0, 10);
    forecastThrough = key;
    const arr = days.get(key) ?? [];
    arr.push({
      time: new Date(times[i]),
      tempF: j.hourly.temperature_2m[i],
      pressureHpa: j.hourly.pressure_msl[i],
      windMph: j.hourly.wind_speed_10m[i],
      cloudCover: j.hourly.cloud_cover?.[i] ?? 0,
      precipProb: j.hourly.precipitation_probability?.[i] ?? 0,
    });
    days.set(key, arr);
  }
  return {
    days,
    forecastThrough,
    timezone: j.timezone ?? "",
    utcOffsetSec: j.utc_offset_seconds ?? 0,
    fetchedAt: res.fetchedAt,
    stale: res.stale,
  };
}

/** Fetch CO-OPS tide predictions (hi/lo events + hourly curve) for a range.
 *  Returns undefined on any failure — inland and offline use simply has no
 *  tide anchor. */
export async function fetchTides(
  station: string,
  from: Date,
  to: Date,
  force = false,
): Promise<Tides | undefined> {
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const base =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?application=ZeroLight` +
    `&station=${station}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json` +
    `&begin_date=${fmt(from)}&end_date=${fmt(to)}`;
  try {
    const [hilo, hourly] = await Promise.all([
      cachedJsonUrl<{ predictions?: { t: string; v: string; type: string }[] }>(`${base}&interval=hilo`, TTL.tidesMs, { force }),
      cachedJsonUrl<{ predictions?: { t: string; v: string }[] }>(`${base}&interval=h`, TTL.tidesMs, { force }),
    ]);
    const events: TideEvent[] = (hilo.data.predictions ?? []).map((p) => ({
      time: new Date(p.t.replace(" ", "T")),
      type: p.type === "H" ? "High" : "Low",
      heightFt: parseFloat(p.v),
    }));
    const curve: TidePoint[] = (hourly.data.predictions ?? []).map((p) => ({
      time: new Date(p.t.replace(" ", "T")),
      heightFt: parseFloat(p.v),
    }));
    if (!events.length && !curve.length) return undefined;
    return { events, curve };
  } catch {
    return undefined;
  }
}

/** Slice a multi-day tide set down to one calendar day (plus neighbours for
 *  slope computation at the edges). */
export function tidesForDay(tides: Tides | undefined, day: Date): Tides | undefined {
  if (!tides) return undefined;
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() - 3600_000;
  const end = start + 26 * 3600_000;
  return {
    events: tides.events.filter((e) => e.time.getTime() >= start && e.time.getTime() <= end),
    curve: tides.curve.filter((p) => p.time.getTime() >= start && p.time.getTime() <= end),
  };
}
