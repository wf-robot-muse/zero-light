// Zero Light shared cache + API proxy — Cloudflare Worker + D1.
// (Next-build items #15 Layer 2, #17 geocoding, #20 activation.)
//
// Design rules (decided 2026-11-11/12):
// - Cache-aside only: clients never write. The Worker writes to D1 only
//   what it fetched itself from an upstream source, after a shape
//   check. There is no client-facing write endpoint at all.
// - Data is keyed by 0.1° grid cell + data type; the exact user
//   coordinates are never stored — upstream fetches happen at the
//   cell centre. (The user's SELECTED location is never sent here at
//   all for storage; it lives only on their device.)
// - API keys live ONLY as Worker secrets (env): GEOAPIFY_API_KEY,
//   USGS_API_KEY, NCEI_CDO_TOKEN, PURGE_SECRET. Nothing keyed is ever
//   committed or sent to clients.
// - Aging ladder (TTL): weather by forecast horizon (~2h/8h/12h);
//   USGS readings 20 min; geocode + reverse labels ~90 days; climate
//   normals 30 days. On upstream failure an expired entry may be
//   served stale (weather: 6h grace, marked X-ZL-Stale).
// - Purge is a POST to /purge guarded by the PURGE_SECRET secret.
// - Geoapify-consuming endpoints are rate-limited per IP per day on
//   upstream fetches (cache hits are free) to protect the free quota.
//
// Endpoints:
//   GET /weather?lat=<n>&lon=<n>   → Open-Meteo 16-day hourly JSON
//   GET /usgs?lat=<n>&lon=<n>      → nearest live USGS gauge reading
//   GET /normals?lat=<n>&lon=<n>   → {"MM-DD": meanTempF} (NCEI)
//   GET /geocode?q=<text>          → {results:[{lat,lon,label,detail}]}
//   GET /reverse?lat=<n>&lon=<n>   → {label} nearest place name
//   GET /health                    → { ok: true }
//
// D1 schema: see schema.sql. Binding name: CACHE.

const UPSTREAM_WEATHER = "https://api.open-meteo.com/v1/forecast";
const GEO_TTL_SEC = 90 * 86400;
const NORMALS_TTL_SEC = 30 * 86400;
const USGS_TTL_SEC = 20 * 60;
const GEO_DAILY_UPSTREAM_CAP = 300; // per IP per day, per endpoint family

function ttlSecondsFor(startKey, todayKey) {
  // Both are YYYY-MM-DD (location-local, as the client frames them).
  const dayMs = 86400_000;
  const diff = Math.round((Date.parse(startKey) - Date.parse(todayKey)) / dayMs);
  if (diff <= 1) return 2 * 3600;
  if (diff <= 7) return 8 * 3600;
  return 12 * 3600;
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      ...extraHeaders,
    },
  });
}

async function getEntry(env, key) {
  return env.CACHE.prepare(
    "SELECT body, expires_at, fetched_at FROM cache_entries WHERE key = ?",
  )
    .bind(key)
    .first();
}

async function putEntry(env, key, body, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  await env.CACHE.prepare(
    "INSERT INTO cache_entries (key, body, fetched_at, expires_at) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT(key) DO UPDATE SET body = ?2, fetched_at = ?3, expires_at = ?4",
  )
    .bind(key, body, now, now + ttlSec)
    .run();
}

function parseLatLon(url) {
  const lat = parseFloat(url.searchParams.get("lat") ?? "");
  const lon = parseFloat(url.searchParams.get("lon") ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat, lon };
}

function cellOf(lat, lon) {
  return {
    cellLat: (Math.round(lat * 10) / 10).toFixed(1),
    cellLon: (Math.round(lon * 10) / 10).toFixed(1),
  };
}

/** Generic cache-aside: fresh hit serves immediately; otherwise the
 *  loader fetches upstream (returns a body string, or null on failure)
 *  and the validated body is stored. Stale entries are served within
 *  `staleGraceSec` when the loader fails. */
async function serveCached(env, ctx, key, ttlSec, staleGraceSec, loader) {
  const now = Math.floor(Date.now() / 1000);
  const entry = await getEntry(env, key).catch(() => null);
  if (entry && entry.expires_at > now) {
    return jsonResponse(entry.body, 200, {
      "x-zl-cache": "hit",
      "cache-control": `max-age=${entry.expires_at - now}`,
    });
  }
  const body = await loader().catch(() => null);
  if (body !== null) {
    ctx.waitUntil(putEntry(env, key, body, ttlSec));
    return jsonResponse(body, 200, { "x-zl-cache": "miss", "cache-control": `max-age=${ttlSec}` });
  }
  if (entry && entry.expires_at > now - staleGraceSec) {
    return jsonResponse(entry.body, 200, { "x-zl-cache": "stale", "x-zl-stale": "1" });
  }
  return jsonResponse({ error: "upstream unavailable" }, 502);
}

/** Per-IP daily counter for upstream (quota-consuming) fetches. */
async function upstreamCount(env, family, ip) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `rl:${family}:${ip}:${day}`;
  const entry = await getEntry(env, key).catch(() => null);
  return { key, count: entry ? parseInt(entry.body, 10) || 0 : 0 };
}

async function bumpUpstreamCount(env, key, count) {
  await putEntry(env, key, String(count + 1), 86400).catch(() => {});
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

// ------------------------------------------------------------- weather

async function handleWeather(request, env, ctx, url) {
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const key = `wx:${cellLat}:${cellLon}`;
  const now = Math.floor(Date.now() / 1000);

  const entry = await getEntry(env, key).catch(() => null);
  if (entry && entry.expires_at > now) {
    return jsonResponse(entry.body, 200, {
      "x-zl-cache": "hit",
      "cache-control": `max-age=${entry.expires_at - now}`,
    });
  }

  const upstream =
    `${UPSTREAM_WEATHER}?latitude=${cellLat}&longitude=${cellLon}` +
    `&hourly=temperature_2m,pressure_msl,wind_speed_10m,cloud_cover,precipitation_probability` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=16&timezone=auto`;

  let upstreamRes = null;
  try {
    upstreamRes = await fetch(upstream, { headers: { "user-agent": "ZeroLight-Cache/1.0" } });
  } catch {
    upstreamRes = null;
  }

  if (upstreamRes && upstreamRes.ok) {
    const body = await upstreamRes.text();
    // Shape check before anything is stored: must parse and carry an
    // hourly block with a time array.
    let valid = false;
    let firstDay = "";
    try {
      const parsed = JSON.parse(body);
      valid = Array.isArray(parsed?.hourly?.time) && parsed.hourly.time.length > 0;
      firstDay = valid ? String(parsed.hourly.time[0]).slice(0, 10) : "";
    } catch {
      valid = false;
    }
    if (!valid) return jsonResponse({ error: "upstream shape" }, 502);
    const todayKey = new Date().toISOString().slice(0, 10);
    const ttl = ttlSecondsFor(firstDay, todayKey);
    ctx.waitUntil(putEntry(env, key, body, ttl));
    return jsonResponse(body, 200, {
      "x-zl-cache": "miss",
      "cache-control": `max-age=${ttl}`,
    });
  }

  // Upstream failed: serve stale within the grace window.
  if (entry && entry.expires_at > now - 6 * 3600) {
    return jsonResponse(entry.body, 200, { "x-zl-cache": "stale", "x-zl-stale": "1" });
  }
  return jsonResponse({ error: "upstream unavailable" }, 502);
}

// ------------------------------------------------- geocoding (item #17)

async function handleGeocode(request, env, ctx, url) {
  if (!env.GEOAPIFY_API_KEY) return jsonResponse({ error: "geocode not configured" }, 503);
  const raw = (url.searchParams.get("q") ?? "").trim();
  if (raw.length < 2 || raw.length > 80 || !/^[\p{L}\p{N} ,.'#°-]+$/u.test(raw)) {
    return jsonResponse({ error: "bad query" }, 400);
  }
  const norm = raw.toLowerCase().replace(/\s+/g, " ");
  const key = `geo:${norm}`;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rl = await upstreamCount(env, "geo", ip);

  return serveCached(env, ctx, key, GEO_TTL_SEC, 0, async () => {
    if (rl.count >= GEO_DAILY_UPSTREAM_CAP) return null;
    const upstream =
      `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(raw)}` +
      `&limit=5&lang=en&apiKey=${env.GEOAPIFY_API_KEY}`;
    const res = await fetch(upstream, { headers: { "user-agent": "ZeroLight-Cache/1.0" } });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j.features)) return null;
    await bumpUpstreamCount(env, rl.key, rl.count);
    const results = [];
    for (const f of j.features) {
      const p = f?.properties ?? {};
      const lat = p.lat;
      const lon = p.lon;
      if (
        typeof lat !== "number" ||
        typeof lon !== "number" ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180 ||
        typeof p.formatted !== "string" ||
        !p.formatted
      ) {
        continue;
      }
      const detail = [p.city || p.county || "", p.state || "", p.country || ""]
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(", ");
      results.push({ lat, lon, label: p.formatted.slice(0, 120), detail: detail.slice(0, 120) });
    }
    return JSON.stringify({ results });
  });
}

async function handleReverse(request, env, ctx, url) {
  if (!env.GEOAPIFY_API_KEY) return jsonResponse({ error: "geocode not configured" }, 503);
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const key = `rev:${cellLat}:${cellLon}`;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rl = await upstreamCount(env, "rev", ip);

  return serveCached(env, ctx, key, GEO_TTL_SEC, 0, async () => {
    if (rl.count >= GEO_DAILY_UPSTREAM_CAP) return null;
    const upstream =
      `https://api.geoapify.com/v1/geocode/reverse?lat=${cellLat}&lon=${cellLon}` +
      `&limit=1&lang=en&apiKey=${env.GEOAPIFY_API_KEY}`;
    const res = await fetch(upstream, { headers: { "user-agent": "ZeroLight-Cache/1.0" } });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    if (!j || !Array.isArray(j.features)) return null;
    await bumpUpstreamCount(env, rl.key, rl.count);
    const formatted = j.features[0]?.properties?.formatted;
    return JSON.stringify({ label: typeof formatted === "string" ? formatted.slice(0, 120) : "" });
  });
}

// ------------------------------------------------------- USGS (item #20)
// Port of the app's v0.2.0 logic: nearest stations in a ±0.75° box,
// latest-continuous values for temperature/flow/turbidity, only
// observations from the last 48h count as a live gauge. Fetched at
// the cell centre, like weather.

async function handleUsgs(request, env, ctx, url) {
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const clat = parseFloat(cellLat);
  const clon = parseFloat(cellLon);
  const key = `usgs:${cellLat}:${cellLon}`;

  return serveCached(env, ctx, key, USGS_TTL_SEC, 3600, async () => {
    const headers = env.USGS_API_KEY ? { "X-Api-Key": env.USGS_API_KEY } : {};
    const base = "https://api.waterdata.usgs.gov/ogcapi/v0/collections";
    const d = 0.75;
    const bbox = `${clon - d},${clat - d},${clon + d},${clat + d}`;
    const [locRes, latestRes] = await Promise.all([
      fetch(`${base}/monitoring-locations/items?f=json&bbox=${bbox}&limit=1000&skipGeometry=false`, { headers }),
      fetch(
        `${base}/latest-continuous/items?f=json&bbox=${bbox}&parameter_code=00010,00060,63680&limit=1000&skipGeometry=true`,
        { headers },
      ),
    ]);
    if (!locRes.ok || !latestRes.ok) return null;
    const locs = await locRes.json().catch(() => null);
    const latest = await latestRes.json().catch(() => null);
    if (!locs || !Array.isArray(locs.features) || !latest || !Array.isArray(latest.features)) return null;

    const locById = new Map();
    for (const f of locs.features) {
      const coords = f.geometry?.coordinates;
      const id = String(f.id ?? f.properties?.monitoring_location_id ?? "");
      if (!coords || !id) continue;
      locById.set(id, {
        name: String(f.properties?.monitoring_location_name ?? id),
        dist: haversineKm(clat, clon, coords[1], coords[0]),
      });
    }
    const freshCutoff = Date.now() - 48 * 3600_000;
    const byStation = new Map();
    for (const f of latest.features) {
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
        reading.waterTempF = (value * 9) / 5 + 32;
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
        const at = a.waterTempF !== undefined ? 0 : 1;
        const bt = b.waterTempF !== undefined ? 0 : 1;
        if (at !== bt) return at - bt;
        return (locById.get(a.stationId)?.dist ?? 1e9) - (locById.get(b.stationId)?.dist ?? 1e9);
      });
    return JSON.stringify(ranked[0] ?? {});
  });
}

// ----------------------------------------------------- normals (item #20)
// NOAA NCEI CDO NORMAL_DLY daily average-temperature normals for the
// nearest station to the cell centre. Returns {"MM-DD": °F}.

async function handleNormals(request, env, ctx, url) {
  if (!env.NCEI_CDO_TOKEN) return jsonResponse({ error: "normals not configured" }, 503);
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const clat = parseFloat(cellLat);
  const clon = parseFloat(cellLon);
  const key = `normals:${cellLat}:${cellLon}`;

  return serveCached(env, ctx, key, NORMALS_TTL_SEC, 7 * 86400, async () => {
    const headers = { token: env.NCEI_CDO_TOKEN };
    const ext = `${clon - 0.6},${clat - 0.6},${clon + 0.6},${clat + 0.6}`;
    const stRes = await fetch(
      `https://www.ncdc.noaa.gov/cdo-web/api/v2/stations?datasetid=NORMAL_DLY&extent=${ext}&limit=5`,
      { headers },
    );
    if (!stRes.ok) return null;
    const stations = await stRes.json().catch(() => null);
    const stationId = stations?.results?.[0]?.id;
    if (!stationId) return JSON.stringify({});
    const dataRes = await fetch(
      `https://www.ncdc.noaa.gov/cdo-web/api/v2/data?datasetid=NORMAL_DLY&stationid=${stationId}` +
        `&datatypeid=DLY-TAVG-NORMAL&startdate=2010-01-01&enddate=2010-12-31&units=standard&limit=1000`,
      { headers },
    );
    if (!dataRes.ok) return null;
    const data = await dataRes.json().catch(() => null);
    if (!data || !Array.isArray(data.results)) return null;
    const out = {};
    for (const r of data.results) {
      if (r.datatype !== "DLY-TAVG-NORMAL") continue;
      const mmdd = String(r.date ?? "").slice(5, 10);
      const v = typeof r.value === "number" ? r.value / 10 : NaN;
      if (/^\d{2}-\d{2}$/.test(mmdd) && Number.isFinite(v)) out[mmdd] = v;
    }
    return JSON.stringify(out);
  });
}

// ------------------------------------------------------------- router

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return jsonResponse("", 204);
    if (url.pathname === "/health") return jsonResponse({ ok: true }, 200);

    if (url.pathname === "/purge" && request.method === "POST") {
      const secret = request.headers.get("x-purge-secret");
      if (!env.PURGE_SECRET || secret !== env.PURGE_SECRET) {
        return jsonResponse({ error: "forbidden" }, 403);
      }
      await env.CACHE.prepare("DELETE FROM cache_entries").run();
      return jsonResponse({ purged: true }, 200);
    }

    if (request.method !== "GET") return jsonResponse({ error: "not found" }, 404);
    switch (url.pathname) {
      case "/weather":
        return handleWeather(request, env, ctx, url);
      case "/geocode":
        return handleGeocode(request, env, ctx, url);
      case "/reverse":
        return handleReverse(request, env, ctx, url);
      case "/usgs":
        return handleUsgs(request, env, ctx, url);
      case "/normals":
        return handleNormals(request, env, ctx, url);
      default:
        return jsonResponse({ error: "not found" }, 404);
    }
  },

  // Sweeper: expired entries are removed hourly (D1 has no native TTL).
  async scheduled(_event, env, _ctx) {
    const now = Math.floor(Date.now() / 1000);
    await env.CACHE.prepare("DELETE FROM cache_entries WHERE expires_at < ?")
      .bind(now - 6 * 3600)
      .run();
  },
};
