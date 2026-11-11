// Data layer — the only place that fetches.
//   Weather: Open-Meteo forecast API (no key, CORS-open). NOTE: the free
//     tier is non-commercial — development use only (see README).
//   Tides: NOAA CO-OPS predictions for the Tampa preset station.
// Pressure trend is computed from pressure_msl (the NWS hourly forecast has
// no pressure field); see scoring.pressureTrendPer6h.

import type { HourWeather, Tides, TideEvent, TidePoint } from "./scoring";

export const TAMPA_TIDE_STATION = "8726520"; // St. Petersburg, FL

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface WeatherByDay {
  /** key: YYYY-MM-DD (location-local, as returned by Open-Meteo) */
  days: Map<string, HourWeather[]>;
  /** Last day (inclusive, YYYY-MM-DD) covered by the real forecast. */
  forecastThrough: string;
}

/** Fetch up to 16 days of hourly forecast, grouped by local day. */
export async function fetchWeather(lat: number, lon: number): Promise<WeatherByDay> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,pressure_msl,wind_speed_10m,cloud_cover,precipitation_probability` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=16&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);
  const j = await res.json();
  const times: string[] = j.hourly.time;
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
      cloudCover: j.hourly.cloud_cover[i] ?? 0,
      precipProb: j.hourly.precipitation_probability[i] ?? 0,
    });
    days.set(key, arr);
  }
  return { days, forecastThrough };
}

/** Fetch CO-OPS tide predictions (hi/lo events + hourly curve) for a range.
 *  Returns undefined on any failure — inland and offline use simply has no
 *  tide anchor. */
export async function fetchTides(station: string, from: Date, to: Date): Promise<Tides | undefined> {
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const base =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?application=FishingHuntingPredictor` +
    `&station=${station}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json` +
    `&begin_date=${fmt(from)}&end_date=${fmt(to)}`;
  try {
    const [hiloRes, hourlyRes] = await Promise.all([
      fetch(`${base}&interval=hilo`),
      fetch(`${base}&interval=h`),
    ]);
    if (!hiloRes.ok || !hourlyRes.ok) return undefined;
    const hilo = await hiloRes.json();
    const hourly = await hourlyRes.json();
    const events: TideEvent[] = (hilo.predictions ?? []).map((p: { t: string; v: string; type: string }) => ({
      time: new Date(p.t.replace(" ", "T")),
      type: p.type === "H" ? "High" : "Low",
      heightFt: parseFloat(p.v),
    }));
    const curve: TidePoint[] = (hourly.predictions ?? []).map((p: { t: string; v: string }) => ({
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
