// Secondary data sources (next-build items #1, #2, #3, #4, #7, #10).
// Every function here is best-effort: any failure returns undefined and
// the app falls back to its v1 behaviour. Nothing here may throw.

import { cachedJson, cachedJsonUrl, TTL } from "./cache";

// ---------------------------------------------------------------- USGS (#1)
// USGS Water Data OGC API (api.waterdata.usgs.gov/ogcapi/v0) — the new API
// only; the legacy waterservices.usgs.gov is being decommissioned.
// Collections: monitoring-locations, latest-continuous. Auth: X-Api-Key
// header (the key is optional but raises the rate limit).

export interface UsgsReading {
  waterTempF?: number;
  dischargeCfs?: number;
  turbidity?: number;
  stationName: string;
  stationId: string;
  observedAt?: string;
}

interface OgcFeature {
  id?: string;
  geometry?: { coordinates?: [number, number] } | null;
  properties?: Record<string, unknown>;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

export async function fetchUsgsReading(
  lat: number,
  lon: number,
  apiKey: string,
  force = false,
): Promise<UsgsReading | undefined> {
  const headers: Record<string, string> = apiKey ? { "X-Api-Key": apiKey } : {};
  const base = "https://api.waterdata.usgs.gov/ogcapi/v0/collections";
  try {
    const d = 0.75; // ~80 km box
    const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
    const locs = await cachedJson<{ features?: OgcFeature[] }>(
      `usgs-locs:${bbox}`,
      TTL.usgsMs,
      async () => {
        const res = await fetch(
          `${base}/monitoring-locations/items?f=json&bbox=${bbox}&limit=1000&skipGeometry=false`,
          { headers },
        );
        if (!res.ok) throw new Error(`USGS locations ${res.status}`);
        return res.json();
      },
      { force },
    );
    const locById = new Map<string, { name: string; dist: number }>();
    for (const f of locs.data.features ?? []) {
      const coords = f.geometry?.coordinates;
      const id = String(f.id ?? f.properties?.monitoring_location_id ?? "");
      if (!coords || !id) continue;
      locById.set(id, {
        name: String(f.properties?.monitoring_location_name ?? id),
        dist: haversineKm(lat, lon, coords[1], coords[0]),
      });
    }

    // One bbox query for the latest values themselves. "Latest" includes
    // long-discontinued series, so only observations from the last 48h
    // count as a live gauge.
    const latest = await cachedJson<{ features?: OgcFeature[] }>(
      `usgs-latest-bbox:${bbox}`,
      TTL.usgsMs,
      async () => {
        const res = await fetch(
          `${base}/latest-continuous/items?f=json&bbox=${bbox}&parameter_code=00010,00060,63680&limit=1000&skipGeometry=true`,
          { headers },
        );
        if (!res.ok) throw new Error(`USGS latest ${res.status}`);
        return res.json();
      },
      { force },
    );
    const freshCutoff = Date.now() - 48 * 3600_000;
    const byStation = new Map<string, UsgsReading>();
    for (const f of latest.data.features ?? []) {
      const p = f.properties ?? {};
      const stationId = String(p.monitoring_location_id ?? "");
      if (!stationId) continue;
      const when = Date.parse(String(p.time ?? ""));
      if (!Number.isFinite(when) || when < freshCutoff) continue;
      const value = parseFloat(String(p.value ?? ""));
      if (!Number.isFinite(value)) continue;
      const code = String(p.parameter_code ?? "");
      const reading = byStation.get(stationId) ?? {
        stationId,
        stationName: locById.get(stationId)?.name ?? stationId,
      };
      if (code === "00010" && reading.waterTempF === undefined) {
        reading.waterTempF = (value * 9) / 5 + 32; // sensor reports °C
        reading.observedAt = String(p.time ?? "");
      } else if (code === "00060" && reading.dischargeCfs === undefined) {
        reading.dischargeCfs = value;
      } else if (code === "63680" && reading.turbidity === undefined) {
        reading.turbidity = value;
      }
      byStation.set(stationId, reading);
    }
    const ranked = [...byStation.values()]
      .filter((r) => r.waterTempF !== undefined || r.dischargeCfs !== undefined)
      .sort((a, b) => {
        // A temperature gauge beats a flow-only gauge; then nearest wins.
        const at = a.waterTempF !== undefined ? 0 : 1;
        const bt = b.waterTempF !== undefined ? 0 : 1;
        if (at !== bt) return at - bt;
        return (locById.get(a.stationId)?.dist ?? 1e9) - (locById.get(b.stationId)?.dist ?? 1e9);
      });
    return ranked[0];
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------- Red tide / HAB (#2)
// FWC-FWRI ArcGIS service: the most recent 8 days of Karenia brevis
// samples with categorical abundance. A MEDIUM or HIGH sample within
// ~40 km of the location vetoes saltwater plans (fish kills / respiratory
// irritation territory per the FWRI abundance key).

const HAB_SERVICE =
  "https://gis.myfwc.com/mapping/rest/services/Projects_FWC/HAB_forDEP_Dashboard/MapServer/0/query";

export async function fetchHabVeto(lat: number, lon: number, force = false): Promise<string | null> {
  // The feed covers Florida waters only — skip the call elsewhere.
  if (lat < 24 || lat > 31.5 || lon < -88.5 || lon > -79.5) return null;
  try {
    const url =
      `${HAB_SERVICE}?where=1%3D1&geometry=${lon},${lat}&geometryType=esriGeometryPoint` +
      `&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=40000&units=esriSRUnit_Meter` +
      `&outFields=*&returnGeometry=false&f=json`;
    const res = await cachedJsonUrl<{ features?: { attributes?: Record<string, unknown> }[] }>(
      url,
      TTL.habMs,
      { force },
    );
    let worst: string | null = null;
    for (const f of res.data.features ?? []) {
      const attrs = f.attributes ?? {};
      const text = Object.values(attrs).join(" ").toUpperCase();
      if (/\bHIGH\b/.test(text)) worst = "high";
      else if (/\bMEDIUM\b/.test(text) && worst !== "high") worst = "medium";
    }
    if (worst) {
      return `red tide — Karenia brevis at ${worst} concentration sampled near this location in the last 8 days (FWC-FWRI)`;
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- NCEI normals (#7)
// NOAA NCEI Climate Data Online: dataset NORMAL_DLY, datatype
// DLY-TAVG-NORMAL (°F ×10 in CDO responses? — CDO returns tenths of a
// degree for normals in metric; with units=standard the value is °F×10).
// Best-effort: returns a map of MM-DD → typical mean temperature °F.

export async function fetchNormals(
  lat: number,
  lon: number,
  token: string,
): Promise<Map<string, number> | undefined> {
  if (!token) return undefined;
  const headers = { token };
  try {
    const ext = `${lon - 0.6},${lat - 0.6},${lon + 0.6},${lat + 0.6}`;
    const stations = await cachedJson<{ results?: { id: string }[] }>(
      `ncei-stations:${ext}`,
      TTL.normalsMs,
      async () => {
        const r2 = await fetch(
          `https://www.ncdc.noaa.gov/cdo-web/api/v2/stations?datasetid=NORMAL_DLY&extent=${ext}&limit=5`,
          { headers },
        );
        if (!r2.ok) throw new Error(`NCEI stations ${r2.status}`);
        return r2.json();
      },
    );
    const stationId = stations.data.results?.[0]?.id;
    if (!stationId) return undefined;
    const year = 2010; // normals are published per "2010" pseudo-year in CDO
    const data = await cachedJson<{ results?: { date: string; datatype: string; value: number }[] }>(
      `ncei-normals:${stationId}`,
      TTL.normalsMs,
      async () => {
        const res = await fetch(
          `https://www.ncdc.noaa.gov/cdo-web/api/v2/data?datasetid=NORMAL_DLY&stationid=${stationId}` +
            `&datatypeid=DLY-TAVG-NORMAL&startdate=${year}-01-01&enddate=${year}-12-31&units=standard&limit=1000`,
          { headers },
        );
        if (!res.ok) throw new Error(`NCEI data ${res.status}`);
        return res.json();
      },
    );
    const map = new Map<string, number>();
    for (const r of data.data.results ?? []) {
      if (r.datatype !== "DLY-TAVG-NORMAL") continue;
      const mmdd = r.date.slice(5, 10);
      map.set(mmdd, r.value / 10);
    }
    return map.size ? map : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------- Tide stations (#4)
// NOAA CO-OPS station list (tide prediction stations). The nearest
// station within range serves any coastal location — v1 was bound to
// the Tampa preset only.

export interface TideStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export async function fetchTideStations(force = false): Promise<TideStation[]> {
  try {
    const res = await cachedJsonUrl<{ stations?: Record<string, unknown>[] }>(
      "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions",
      TTL.stationsMs,
      { force },
    );
    return (res.data.stations ?? [])
      .map((s) => ({
        id: String(s.id ?? ""),
        name: String(s.name ?? s.id ?? ""),
        lat: parseFloat(String(s.lat ?? "")),
        lng: parseFloat(String(s.lng ?? "")),
      }))
      .filter((s) => s.id && Number.isFinite(s.lat) && Number.isFinite(s.lng));
  } catch {
    return [];
  }
}

export function nearestTideStation(
  stations: TideStation[],
  lat: number,
  lon: number,
  maxKm = 160,
): TideStation | undefined {
  let best: TideStation | undefined;
  let bestDist = maxKm;
  for (const s of stations) {
    const d = haversineKm(lat, lon, s.lat, s.lng);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

// ------------------------------------------------------- Geocoding (#10)

export interface ZipResult {
  lat: number;
  lon: number;
  label: string;
}

/** US ZIP → centroid via Zippopotam.us (free, no key). */
export async function lookupZip(zip: string): Promise<ZipResult | undefined> {
  try {
    const res = await cachedJsonUrl<{
      places?: { latitude: string; longitude: string; "place name": string; state: string }[];
    }>(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`, TTL.geocodeMs);
    const place = res.data.places?.[0];
    if (!place) return undefined;
    return {
      lat: parseFloat(place.latitude),
      lon: parseFloat(place.longitude),
      label: `${place["place name"]}, ${place.state} ${zip}`,
    };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------- Rut tables (#3)
// Approximate peak-rut (peak breeding) windows by state, ingested from
// state agency publications during the 2026-11-10 research. These are
// statewide compromises — rut timing varies within every state (Florida
// most of all) — and are labelled approximate in the UI. Tennessee
// publishes no rut data and is deliberately absent.

export interface RutWindow {
  state: string;
  /** [month 1-12, day] inclusive start and end; end may wrap the year. */
  start: [number, number];
  end: [number, number];
}

export const RUT_WINDOWS: RutWindow[] = [
  { state: "AL", start: [12, 10], end: [1, 20] },
  { state: "FL", start: [9, 15], end: [1, 15] }, // varies widely by zone
  { state: "GA", start: [11, 5], end: [11, 25] },
  { state: "MS", start: [12, 10], end: [1, 10] },
  { state: "TX", start: [11, 10], end: [12, 10] }, // north/central; south TX runs later
];

const STATE_BOXES: { state: string; latMin: number; latMax: number; lonMin: number; lonMax: number }[] = [
  { state: "FL", latMin: 24.4, latMax: 31.2, lonMin: -87.7, lonMax: -80.0 },
  { state: "AL", latMin: 31.0, latMax: 35.05, lonMin: -88.5, lonMax: -84.85 },
  { state: "GA", latMin: 30.35, latMax: 35.05, lonMin: -85.65, lonMax: -80.8 },
  { state: "MS", latMin: 30.15, latMax: 35.05, lonMin: -91.7, lonMax: -88.09 },
  { state: "TX", latMin: 25.8, latMax: 36.55, lonMin: -106.7, lonMax: -93.5 },
];

export function stateForCoords(lat: number, lon: number): string | undefined {
  return STATE_BOXES.find(
    (b) => lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax,
  )?.state;
}

export function rutActiveOn(rut: RutWindow, date: Date): boolean {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const cur = m * 100 + d;
  const s = rut.start[0] * 100 + rut.start[1];
  const e = rut.end[0] * 100 + rut.end[1];
  return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e;
}

export function rutForLocation(lat: number, lon: number, date: Date): RutWindow | undefined {
  const state = stateForCoords(lat, lon);
  if (!state) return undefined;
  const rut = RUT_WINDOWS.find((r) => r.state === state);
  return rut && rutActiveOn(rut, date) ? rut : undefined;
}
