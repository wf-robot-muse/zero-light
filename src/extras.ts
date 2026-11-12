// Secondary data sources (next-build items #1, #2, #3, #4, #7, #10).
// Every function here is best-effort: any failure returns undefined and
// the app falls back to its v1 behaviour. Nothing here may throw.

import { cachedJson, cachedJsonUrl, TTL } from "./cache";
import { CACHE_ENDPOINT } from "./config";

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

/** v0.3.0 (item #20): the primary path is the Layer 2 Worker, which
 *  holds the USGS key as a secret and caches readings in D1. If the
 *  Worker is unreachable (or has no reading), fall back to the keyless
 *  direct OGC queries below (rate-capped, but functional). */
export async function fetchUsgsReading(
  lat: number,
  lon: number,
  force = false,
): Promise<UsgsReading | undefined> {
  try {
    const res = await cachedJson<Partial<UsgsReading>>(
      `usgs-worker:${lat.toFixed(1)},${lon.toFixed(1)}`,
      TTL.usgsMs,
      async () => {
        const r = await fetch(`${CACHE_ENDPOINT}/usgs?lat=${lat}&lon=${lon}`);
        if (!r.ok) throw new Error(`cache usgs ${r.status}`);
        return (await r.json()) as Partial<UsgsReading>;
      },
      { force },
    );
    const d = res.data;
    if (
      d &&
      typeof d.stationId === "string" &&
      d.stationId &&
      (typeof d.waterTempF === "number" || typeof d.dischargeCfs === "number")
    ) {
      return {
        waterTempF: typeof d.waterTempF === "number" ? d.waterTempF : undefined,
        dischargeCfs: typeof d.dischargeCfs === "number" ? d.dischargeCfs : undefined,
        turbidity: typeof d.turbidity === "number" ? d.turbidity : undefined,
        stationName: typeof d.stationName === "string" ? d.stationName : d.stationId,
        stationId: d.stationId,
        observedAt: typeof d.observedAt === "string" ? d.observedAt : undefined,
      };
    }
  } catch {
    /* fall through to the direct path */
  }
  return fetchUsgsReadingDirect(lat, lon, force);
}

async function fetchUsgsReadingDirect(
  lat: number,
  lon: number,
  force = false,
): Promise<UsgsReading | undefined> {
  const headers: Record<string, string> = {};
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
// v0.3.0 (item #20): normals come from the Layer 2 Worker, which holds
// the NCEI CDO token as a secret and caches the (effectively static)
// normals in D1. The Worker returns a plain {"MM-DD": tempF} object.
// No Worker → no normals; typical days fall back to astronomy/season,
// exactly as v0.2.0 behaved with no token entered.

export async function fetchNormals(
  lat: number,
  lon: number,
): Promise<Map<string, number> | undefined> {
  try {
    const res = await cachedJson<Record<string, unknown>>(
      `normals-worker:${lat.toFixed(1)},${lon.toFixed(1)}`,
      TTL.normalsMs,
      async () => {
        const r = await fetch(`${CACHE_ENDPOINT}/normals?lat=${lat}&lon=${lon}`);
        if (!r.ok) throw new Error(`cache normals ${r.status}`);
        return (await r.json()) as Record<string, unknown>;
      },
    );
    const map = new Map<string, number>();
    for (const [k, v] of Object.entries(res.data ?? {})) {
      if (/^\d{2}-\d{2}$/.test(k) && typeof v === "number" && Number.isFinite(v)) {
        map.set(k, v);
      }
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

// ------------------------------------------- Place-name geocoding (#17)
// Place names resolve through the Layer 2 Worker (items #17/#20): the
// Geoapify key lives server-side as a Worker secret, and lookups are
// cached twice — locally on this device and shared in D1 (~90-day
// aging, decided 2026-11-12). The user's SELECTED location is never
// sent to the shared cache; it stays in local storage only.
// Returns: candidates array (possibly empty = no match), or null when
// the service is unreachable.

export interface PlaceCandidate {
  lat: number;
  lon: number;
  label: string;
  detail: string;
}

const GEO_LOCAL_TTL_MS = 90 * 86400_000; // mirrors the Layer 2 aging

export async function geocodePlace(query: string): Promise<PlaceCandidate[] | null> {
  const norm = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (norm.length < 2) return [];
  try {
    const res = await cachedJson<{ results?: unknown }>(
      `geocode:${norm}`,
      GEO_LOCAL_TTL_MS,
      async () => {
        const r = await fetch(
          `${CACHE_ENDPOINT}/geocode?q=${encodeURIComponent(query.trim())}`,
        );
        if (!r.ok) throw new Error(`geocode ${r.status}`);
        return (await r.json()) as { results?: unknown };
      },
    );
    const out: PlaceCandidate[] = [];
    const list = Array.isArray(res.data?.results) ? (res.data.results as unknown[]) : [];
    for (const c of list) {
      const o = c as Record<string, unknown>;
      const lat = o.lat;
      const lon = o.lon;
      if (
        typeof lat === "number" &&
        typeof lon === "number" &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        typeof o.label === "string" &&
        o.label
      ) {
        out.push({
          lat,
          lon,
          label: o.label.slice(0, 120),
          detail: typeof o.detail === "string" ? o.detail.slice(0, 120) : "",
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Nearest place name for a point (map readout, geolocation label).
 *  The Worker snaps to the 0.1° cell before querying upstream, so the
 *  exact point never leaves the device-side request pattern. */
export async function reverseLabel(lat: number, lon: number): Promise<string | null> {
  try {
    const res = await cachedJson<{ label?: unknown }>(
      `reverse:${lat.toFixed(1)},${lon.toFixed(1)}`,
      GEO_LOCAL_TTL_MS,
      async () => {
        const r = await fetch(`${CACHE_ENDPOINT}/reverse?lat=${lat}&lon=${lon}`);
        if (!r.ok) throw new Error(`reverse ${r.status}`);
        return (await r.json()) as { label?: unknown };
      },
    );
    return typeof res.data?.label === "string" && res.data.label
      ? res.data.label.slice(0, 120)
      : null;
  } catch {
    return null;
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
