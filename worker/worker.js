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
  const key = `rev2:${cellLat}:${cellLon}`;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rl = await upstreamCount(env, "rev", ip);

  return serveCached(env, ctx, key, GEO_TTL_SEC, 0, async () => {
    if (rl.count >= GEO_DAILY_UPSTREAM_CAP) return null;
    // type=city: the label names the containing city ("Near Tampa, FL")
    // rather than a street address at the cell centre.
    const upstream =
      `https://api.geoapify.com/v1/geocode/reverse?lat=${cellLat}&lon=${cellLon}` +
      `&limit=1&lang=en&type=city&apiKey=${env.GEOAPIFY_API_KEY}`;
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
  const key = `normals4:${cellLat}:${cellLon}`;

  return serveCached(env, ctx, key, NORMALS_TTL_SEC, 7 * 86400, async () => {
    const headers = { token: env.NCEI_CDO_TOKEN };
    // CDO extent order is lat,lon of the SW corner then lat,lon of the
    // NE corner (NOAA API docs). The v0.2.0 code sent lon,lat, which
    // put the box in the southern ocean and matched zero stations.
    const ext = `${clat - 0.6},${clon - 0.6},${clat + 0.6},${clon + 0.6}`;
    const stRes = await fetch(
      `https://www.ncdc.noaa.gov/cdo-web/api/v2/stations?datasetid=NORMAL_DLY&extent=${ext}&limit=5`,
      { headers },
    );
    if (!stRes.ok) return null;
    const stations = await stRes.json().catch(() => null);
    const ids = (stations?.results ?? [])
      .map((r) => r?.id)
      .filter((x) => typeof x === "string" && x)
      .slice(0, 5);
    // Try each nearby station in turn: the first hit in the extent is
    // often a station without published daily normals.
    for (const stationId of ids) {
      const dataRes = await fetch(
        `https://www.ncdc.noaa.gov/cdo-web/api/v2/data?datasetid=NORMAL_DLY&stationid=${stationId}` +
          `&datatypeid=DLY-TAVG-NORMAL&startdate=2010-01-01&enddate=2010-12-31&units=standard&limit=1000`,
        { headers },
      );
      if (!dataRes.ok) continue;
      const data = await dataRes.json().catch(() => null);
      if (!data || !Array.isArray(data.results)) continue;
      const out = {};
      for (const r of data.results) {
        if (r.datatype !== "DLY-TAVG-NORMAL") continue;
        const mmdd = String(r.date ?? "").slice(5, 10);
        // With units=standard the CDO API returns whole degrees F
        // (verified live 2026-11-12: Tampa 01-01 raw 61.5). The raw
        // archive files are tenths of C; the API is not — do not /10.
        const v = typeof r.value === "number" ? r.value : NaN;
        if (/^\d{2}-\d{2}$/.test(mmdd) && Number.isFinite(v)) out[mmdd] = v;
      }
      if (Object.keys(out).length) return JSON.stringify(out);
    }
    return JSON.stringify({});
  });
}

// #47 fallback B: the caller's approximate area from Cloudflare's edge
// geolocation of the request IP (city level). Nothing is stored and no
// coordinates are accepted from the client — the values come from
// request.cf on THIS request only. The app shows the area on a card and
// applies it only when the user taps "Use this area".
function handleGeo(request) {
  const cf = request.cf;
  if (!cf || cf.latitude == null || cf.longitude == null) {
    return jsonResponse({ error: "no geo for this request" }, 404);
  }
  const lat = parseFloat(cf.latitude);
  const lon = parseFloat(cf.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse({ error: "no geo for this request" }, 404);
  }
  return jsonResponse({
    lat,
    lon,
    city: typeof cf.city === "string" ? cf.city : "",
    region: typeof cf.region === "string" ? cf.region : "",
    country: typeof cf.country === "string" ? cf.country : "",
  }, 200);
}

// ------------------------------------- environmental data (item #69)
// One route per data family, all following the house rules above:
// cache-aside in D1 keyed by 0.1° cell, keys only as Worker secrets
// (AIRNOW_API_KEY, FIRMS_MAP_KEY), every upstream reply shape-checked
// before it is stored, and a normalized small JSON returned to the
// app. Distances are NOT baked into cached bodies — rows carry their
// own lat/lon and the app measures from the user's exact point.
// Sources verified live at build time (2026-11-23); see the #69 entry
// in the changes list for what was checked and what was substituted.

/** Cache-aside returning the parsed value (not a Response), so a
 *  handler can shape its reply after the cache read. Null when the
 *  upstream fails and no usable stale copy exists. */
async function cachedRaw(env, ctx, key, ttlSec, staleGraceSec, loader) {
  const now = Math.floor(Date.now() / 1000);
  const entry = await getEntry(env, key).catch(() => null);
  if (entry && entry.expires_at > now) {
    try {
      return JSON.parse(entry.body);
    } catch {
      /* fall through and refetch */
    }
  }
  const value = await loader().catch(() => null);
  if (value !== null && value !== undefined) {
    ctx.waitUntil(putEntry(env, key, JSON.stringify(value), ttlSec));
    return value;
  }
  if (entry && entry.expires_at > now - staleGraceSec) {
    try {
      return JSON.parse(entry.body);
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchTextUp(url, headers) {
  const res = await fetch(url, { headers: { "user-agent": "ZeroLight-Cache/1.0", ...headers } });
  if (!res.ok) return null;
  return res.text();
}

async function fetchJsonUp(url, headers) {
  const text = await fetchTextUp(url, headers);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Small quote-aware CSV parser (WQP and FIRMS both answer CSV). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function aqiCategory(aqi) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

function truthyFlag(v) {
  return v === true || v === 1 || (typeof v === "string" && /^(y|yes|true|1)$/i.test(v.trim()));
}

// --- Air quality: AirNow when its key is set, else Open-Meteo's
// modelled US AQI (same provider family as the weather). AirNow is
// preliminary monitor data; Open-Meteo is a model estimate. The reply
// names its source so the app can label it honestly.
async function handleAir(request, env, ctx, url) {
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const value = await cachedRaw(env, ctx, `air1:${cellLat}:${cellLon}`, 3600, 3600, async () => {
    if (env.AIRNOW_API_KEY) {
      const base = "https://www.airnowapi.org/aq";
      const qs = `format=application/json&latitude=${cellLat}&longitude=${cellLon}&distance=25&API_KEY=${env.AIRNOW_API_KEY}`;
      const [cur, fc] = await Promise.all([
        fetchJsonUp(`${base}/observation/latLong/current/?${qs}`),
        fetchJsonUp(`${base}/forecast/latLong/?${qs}`),
      ]);
      let current = null;
      if (Array.isArray(cur)) {
        for (const r of cur) {
          const aqi = typeof r?.AQI === "number" ? r.AQI : NaN;
          if (Number.isFinite(aqi) && aqi >= 0 && (!current || aqi > current.aqi)) {
            current = { aqi, category: aqiCategory(aqi), area: String(r.ReportingArea ?? "").slice(0, 60) };
          }
        }
      }
      const byDate = new Map();
      if (Array.isArray(fc)) {
        for (const r of fc) {
          const date = String(r?.DateForecast ?? "").trim().slice(0, 10);
          const aqi = typeof r?.AQI === "number" ? r.AQI : NaN;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(aqi) || aqi < 0) continue;
          if (!byDate.has(date) || aqi > byDate.get(date)) byDate.set(date, aqi);
        }
      }
      const daily = [...byDate.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .slice(0, 5)
        .map(([date, aqi]) => ({ date, aqi, category: aqiCategory(aqi) }));
      if (current || daily.length) return { source: "airnow", current, daily };
      // AirNow answered nothing usable — fall through to the model.
    }
    const j = await fetchJsonUp(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${cellLat}&longitude=${cellLon}` +
        `&hourly=us_aqi&forecast_days=5&timezone=auto`,
    );
    const times = j?.hourly?.time;
    const aqis = j?.hourly?.us_aqi;
    if (!Array.isArray(times) || !Array.isArray(aqis)) return null;
    const offsetSec = typeof j.utc_offset_seconds === "number" ? j.utc_offset_seconds : 0;
    const locNow = new Date(Date.now() + offsetSec * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const nowHour =
      `${locNow.getUTCFullYear()}-${pad(locNow.getUTCMonth() + 1)}-${pad(locNow.getUTCDate())}` +
      `T${pad(locNow.getUTCHours())}:00`;
    let current = null;
    const byDate = new Map();
    for (let i = 0; i < times.length; i++) {
      const t = String(times[i]);
      const v = aqis[i];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const date = t.slice(0, 10);
      if (!byDate.has(date) || v > byDate.get(date)) byDate.set(date, v);
      if (t === nowHour) current = { aqi: Math.round(v), category: aqiCategory(v), area: "" };
    }
    const daily = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(0, 5)
      .map(([date, aqi]) => ({ date, aqi: Math.round(aqi), category: aqiCategory(aqi) }));
    if (!current && daily.length) {
      const t = daily[0];
      current = { aqi: t.aqi, category: t.category, area: "" };
    }
    return current || daily.length ? { source: "openmeteo", current, daily } : null;
  });
  if (value === null) return jsonResponse({ error: "upstream unavailable" }, 502);
  return jsonResponse(value, 200);
}

// --- Freshwater blooms by satellite: EPA CyAN weekly cyanobacteria
// index for the nearest resolvable lake pixel. A latest week older
// than 21 days is reported as no current reading — CyAN's archive
// holds years-old pixels and an old bloom is not a current one.
async function handleCyan(request, env, ctx, url) {
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const value = await cachedRaw(env, ctx, `cyan1:${cellLat}:${cellLon}`, 86400, 86400, async () => {
    const j = await fetchJsonUp(`https://cyan.epa.gov/cyan/cyano/location/data/${cellLat}/${cellLon}`, {
      accept: "application/json",
    });
    const out = Array.isArray(j?.output) ? j.output : [];
    let latest = null;
    for (const r of out) {
      const ms = typeof r?.imageDateLong === "number" ? r.imageDateLong : NaN;
      const cells = typeof r?.maxCellConcentration === "number" ? r.maxCellConcentration : NaN;
      if (!Number.isFinite(ms) || !Number.isFinite(cells)) continue;
      if (!latest || ms > latest.weekMs) latest = { weekMs: ms, cellsPerMl: Math.round(cells) };
    }
    if (latest && Date.now() - latest.weekMs > 21 * 86400_000) latest = null;
    return { latest };
  });
  if (value === null) return jsonResponse({ error: "upstream unavailable" }, 502);
  return jsonResponse(value, 200);
}

// --- Spills and sewage: Florida's Public Notice of Pollution
// (ArcGIS, last-30-days layer) and Alabama's ADEM sewer-overflow
// reports (ArcGIS). Both are official report feeds posted within
// about a day of the event. A notice counts while it is ongoing or
// began within the last 14 days.
const SPILL_WINDOW_MS = 14 * 86400_000;

async function esriPointQuery(base, lat, lon, fields, where) {
  const qs =
    `geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&distance=25000&units=esriSRUnit_Meter` +
    `&outFields=${encodeURIComponent(fields)}&returnGeometry=false&f=json` +
    (where ? `&where=${encodeURIComponent(where)}` : "");
  const j = await fetchJsonUp(`${base}?${qs}`);
  return Array.isArray(j?.features) ? j.features : null;
}

async function handleSpill(request, env, ctx, url) {
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const clat = parseFloat(cellLat);
  const clon = parseFloat(cellLon);
  const inFl = clat >= 24 && clat <= 31.5 && clon >= -88.5 && clon <= -79.5;
  const inAl = clat >= 30.8 && clat <= 35.1 && clon >= -88.6 && clon <= -84.8;
  const value = await cachedRaw(env, ctx, `spill1:${cellLat}:${cellLon}`, 3600, 6 * 3600, async () => {
    const notices = [];
    const covered = inFl || inAl;
    const now = Date.now();
    if (inFl) {
      const feats = await esriPointQuery(
        "https://ags.dep.state.fl.us/arcgis/rest/services/External_Services/PNP/FeatureServer/0/query",
        clat,
        clon,
        "INCIDENT_NAME,INCIDENT_REPORT,DATE_TIME_OF_REPORT,RELEASE_START_DATE_TIME,RELEASE_ONGOING,FACILITY_NAME,LATITUDE,LONGITUDE",
        null,
      );
      if (feats === null) return null;
      for (const f of feats) {
        const a = f?.attributes ?? {};
        const lat = typeof a.LATITUDE === "number" ? a.LATITUDE : NaN;
        const lon = typeof a.LONGITUDE === "number" ? a.LONGITUDE : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const started =
          typeof a.RELEASE_START_DATE_TIME === "number"
            ? a.RELEASE_START_DATE_TIME
            : typeof a.DATE_TIME_OF_REPORT === "number"
              ? a.DATE_TIME_OF_REPORT
              : NaN;
        const ongoing = truthyFlag(a.RELEASE_ONGOING);
        if (!ongoing && (!Number.isFinite(started) || now - started > SPILL_WINDOW_MS)) continue;
        const text = `${a.INCIDENT_NAME ?? ""} ${a.INCIDENT_REPORT ?? ""}`;
        notices.push({
          kind: /sewage|wastewater|sanitary|untreated|bypass|\bsso\b/i.test(text) ? "sewage" : "spill",
          title: String(a.INCIDENT_NAME || a.FACILITY_NAME || "Pollution notice").slice(0, 120),
          facility: String(a.FACILITY_NAME ?? "").slice(0, 120),
          startedMs: Number.isFinite(started) ? started : null,
          ongoing,
          lat,
          lon,
          source: "FL pollution notices",
        });
      }
    } else if (inAl) {
      const since = new Date(now - 30 * 86400_000);
      const pad = (n) => String(n).padStart(2, "0");
      const stamp =
        `${since.getUTCFullYear()}-${pad(since.getUTCMonth() + 1)}-${pad(since.getUTCDate())} ` +
        `${pad(since.getUTCHours())}:${pad(since.getUTCMinutes())}:${pad(since.getUTCSeconds())}`;
      const feats = await esriPointQuery(
        "https://gis.adem.alabama.gov/arcgis/rest/services/SSO_all_Dates_project/MapServer/0/query",
        clat,
        clon,
        "permittee,facility_site,date_sso_began,date_sso_stopped,sso_ongoing_ind,est_volume,location_of_discharge,receiving_stream,LATTITUDE_DECIMAL,LONGITUDE_DECIMAL",
        `date_sso_began >= TIMESTAMP '${stamp}'`,
      );
      if (feats === null) return null;
      for (const f of feats) {
        const a = f?.attributes ?? {};
        const lat = typeof a.LATTITUDE_DECIMAL === "number" ? a.LATTITUDE_DECIMAL : NaN;
        const lon = typeof a.LONGITUDE_DECIMAL === "number" ? a.LONGITUDE_DECIMAL : NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const started = typeof a.date_sso_began === "number" ? a.date_sso_began : NaN;
        const ongoing = truthyFlag(a.sso_ongoing_ind) || a.date_sso_stopped == null;
        if (!ongoing && (!Number.isFinite(started) || now - started > SPILL_WINDOW_MS)) continue;
        notices.push({
          kind: "sewage",
          title: String(a.receiving_stream || a.location_of_discharge || "Sewer overflow").slice(0, 120),
          facility: String(a.permittee ?? "").slice(0, 120),
          startedMs: Number.isFinite(started) ? started : null,
          ongoing,
          lat,
          lon,
          source: "AL sewer overflows",
        });
      }
    }
    return { notices, covered };
  });
  if (value === null) return jsonResponse({ error: "upstream unavailable" }, 502);
  return jsonResponse(value, 200);
}

// --- Florida's own bloom sampling (FDEP): ground-truth site visits
// with lab results — dominant taxon and whether toxin was found.
// Samples from the last 21 days within the query radius.
async function handleHabState(request, env, ctx, url) {
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const clat = parseFloat(cellLat);
  const clon = parseFloat(cellLon);
  const inFl = clat >= 24 && clat <= 31.5 && clon >= -88.5 && clon <= -79.5;
  if (!inFl) return jsonResponse({ samples: [] }, 200);
  const value = await cachedRaw(env, ctx, `habs1:${cellLat}:${cellLon}`, 6 * 3600, 6 * 3600, async () => {
    const since = new Date(Date.now() - 21 * 86400_000);
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
      `${since.getUTCFullYear()}-${pad(since.getUTCMonth() + 1)}-${pad(since.getUTCDate())} 00:00:00`;
    const qs =
      `geometry=${clon},${clat}&geometryType=esriGeometryPoint&inSR=4326` +
      `&spatialRel=esriSpatialRelIntersects&distance=25000&units=esriSRUnit_Meter` +
      `&outFields=${encodeURIComponent("SampleDateTime,BloomObserved,ToxinPresent,Microcystin,OtherToxin,AlgalIDResult,CyanobacteriaDominant,locationString")}` +
      `&returnGeometry=true&f=json&where=${encodeURIComponent(`SampleDateTime >= TIMESTAMP '${stamp}'`)}`;
    const j = await fetchJsonUp(
      `https://services1.arcgis.com/nRHtyn3uE1kyzoYc/arcgis/rest/services/AlgalBloom_Final_View/FeatureServer/0/query?${qs}`,
    );
    if (!Array.isArray(j?.features)) return null;
    const samples = [];
    for (const f of j.features) {
      const a = f?.attributes ?? {};
      const gx = f?.geometry?.x;
      const gy = f?.geometry?.y;
      if (typeof gx !== "number" || typeof gy !== "number") continue;
      samples.push({
        site: String(a.locationString ?? "Sampling site").slice(0, 120),
        dateMs: typeof a.SampleDateTime === "number" ? a.SampleDateTime : null,
        bloom: truthyFlag(a.BloomObserved),
        toxin: truthyFlag(a.ToxinPresent),
        toxinText: String(a.Microcystin || a.OtherToxin || "").slice(0, 80),
        taxon: String(a.AlgalIDResult || a.CyanobacteriaDominant || "").slice(0, 120),
        lat: gy,
        lon: gx,
      });
    }
    return { samples };
  });
  if (value === null) return jsonResponse({ error: "upstream unavailable" }, 502);
  return jsonResponse(value, 200);
}

// --- Bacteria samples: the Water Quality Portal (WQX 3.0 services).
// Lab grab samples posted by 1,500+ agencies — days to weeks old, so
// this is a caution-grade signal, never a same-day advisory. The
// Worker fetches the CSV (the Result service has no JSON profile),
// keeps the latest sample per station for each of the two indicator
// bacteria, and returns values raw; thresholds live in the app.
async function wqpLatest(characteristic, clat, clon) {
  const since = new Date(Date.now() - 21 * 86400_000);
  const pad = (n) => String(n).padStart(2, "0");
  const startLo = `${pad(since.getUTCMonth() + 1)}-${pad(since.getUTCDate())}-${since.getUTCFullYear()}`;
  const text = await fetchTextUp(
    `https://www.waterqualitydata.us/wqx3/Result/search?mimeType=csv&zip=no&dataProfile=narrow` +
      `&lat=${clat}&long=${clon}&within=16&characteristicName=${encodeURIComponent(characteristic)}` +
      `&startDateLo=${startLo}`,
  );
  if (text === null || !text.startsWith("Org_")) return null;
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const head = rows[0];
  const ix = (name) => head.indexOf(name);
  const iId = ix("Location_Identifier");
  const iName = ix("Location_Name");
  const iLat = ix("Location_Latitude");
  const iLon = ix("Location_Longitude");
  const iDate = ix("Activity_StartDate");
  const iVal = ix("Result_Measure");
  const iUnit = ix("Result_MeasureUnit");
  const iOrg = ix("Org_FormalName");
  const iDet = ix("Result_ResultDetectionCondition");
  if ([iId, iLat, iLon, iDate, iVal].some((i) => i < 0)) return null;
  const byStation = new Map();
  for (const r of rows.slice(1)) {
    if (iDet >= 0 && String(r[iDet] ?? "").trim()) continue; // non-detects carry limit values
    const value = parseFloat(String(r[iVal] ?? ""));
    const lat = parseFloat(String(r[iLat] ?? ""));
    const lon = parseFloat(String(r[iLon] ?? ""));
    const date = String(r[iDate] ?? "");
    const unit = String(r[iUnit] ?? "");
    if (!Number.isFinite(value) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
    if (!/(100\s*ml|cfu|mpn)/i.test(unit)) continue;
    const id = String(r[iId] ?? "");
    if (!id) continue;
    const prev = byStation.get(id);
    if (!prev || date > prev.date) {
      byStation.set(id, {
        stationId: id.slice(0, 60),
        stationName: String(r[iName] ?? id).slice(0, 120),
        org: iOrg >= 0 ? String(r[iOrg] ?? "").slice(0, 80) : "",
        lat,
        lon,
        date,
        value,
        unit: unit.slice(0, 20),
      });
    }
  }
  return [...byStation.values()];
}

async function handleWqp(request, env, ctx, url) {
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const value = await cachedRaw(env, ctx, `wqp1:${cellLat}:${cellLon}`, 86400, 86400, async () => {
    const [entero, ecoli] = await Promise.all([
      wqpLatest("Enterococcus", cellLat, cellLon),
      wqpLatest("Escherichia coli", cellLat, cellLon),
    ]);
    if (entero === null || ecoli === null) return null;
    return { entero, ecoli };
  });
  if (value === null) return jsonResponse({ error: "upstream unavailable" }, 502);
  return jsonResponse(value, 200);
}

// --- Active fires: NASA FIRMS VIIRS detections (needs the MAP_KEY
// secret; without it the route answers 503 and the app shows the
// family as not set up). Detections from the last 3 days in a
// ±0.4° box; the app measures exact distances.
async function handleFirms(request, env, ctx, url) {
  if (!env.FIRMS_MAP_KEY) return jsonResponse({ error: "fires not configured" }, 503);
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const { cellLat, cellLon } = cellOf(ll.lat, ll.lon);
  const clat = parseFloat(cellLat);
  const clon = parseFloat(cellLon);
  const value = await cachedRaw(env, ctx, `firms1:${cellLat}:${cellLon}`, 3 * 3600, 3 * 3600, async () => {
    const box = `${clon - 0.4},${clat - 0.4},${clon + 0.4},${clat + 0.4}`;
    const text = await fetchTextUp(
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${env.FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/${box}/3`,
    );
    if (text === null || !text.startsWith("latitude")) return null;
    const rows = parseCsv(text);
    const detections = [];
    for (const r of rows.slice(1)) {
      const lat = parseFloat(r[0]);
      const lon = parseFloat(r[1]);
      const date = String(r[6] ?? "");
      const time = String(r[7] ?? "").padStart(4, "0");
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const atMs = Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z`);
      detections.push({
        lat,
        lon,
        atMs: Number.isFinite(atMs) ? atMs : null,
        confidence: String(r[9] ?? "").slice(0, 4),
      });
      if (detections.length >= 300) break;
    }
    return { detections };
  });
  if (value === null) return jsonResponse({ error: "upstream unavailable" }, 502);
  return jsonResponse(value, 200);
}

// --- Florida shellfish harvest areas (FDACS): daily open/closed
// status published as one HTML page per coast region. The Worker
// reads the region's page and walks its status tables cell by cell
// (the pages are Word-generated HTML; the table cells survive tag
// stripping in reading order). Only the parsed status is returned.
function fdacsRegion(lat, lon) {
  if (lon > -80.9) return "atlantic";
  if (lon <= -85.4) return "westgulf";
  if (lon <= -84.0) return "centralgulf";
  if (lon <= -82.75) return "bigbendgulf";
  return "southgulf";
}

async function handleShellfish(request, env, ctx, url) {
  const ll = parseLatLon(url);
  if (!ll) return jsonResponse({ error: "lat/lon required" }, 400);
  const inFl = ll.lat >= 24 && ll.lat <= 31.5 && ll.lon >= -88.5 && ll.lon <= -79.5;
  if (!inFl) return jsonResponse({ region: null, areas: [] }, 200);
  const region = fdacsRegion(ll.lat, ll.lon);
  const value = await cachedRaw(env, ctx, `shell1:${region}`, 6 * 3600, 6 * 3600, async () => {
    const html = await fetchTextUp(`https://shellfish.fdacs.gov/seas/seas_${region}.htm`);
    if (html === null) return null;
    const text = html.replace(/\s+/g, " ");
    const pub = /published at ([^,]+,\s*\d{4})/i.exec(text);
    const cells = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "|")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .split("|")
      .map((c) => c.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const areas = [];
    let system = "";
    let cur = null;
    const flush = () => {
      if (cur && cur.status) areas.push(cur);
      cur = null;
    };
    for (const cell of cells) {
      if (/SHA\s*#?\s*\d+/i.test(cell) && cell.length < 80) {
        flush();
        system = cell.slice(0, 80);
        continue;
      }
      const m = /^(\d{4})\s+(.+)$/.exec(cell);
      if (m) {
        flush();
        cur = { num: m[1], name: m[2].slice(0, 80), system, status: null, date: "", reason: "" };
        continue;
      }
      if (!cur) continue;
      if (cell === "OPEN" || cell === "CLOSED") {
        if (cell === "CLOSED" || !cur.status) cur.status = cell;
        continue;
      }
      if (cur.status && !cur.date && /^\d{2}\/\d{2}\/\d{4}$/.test(cell)) {
        cur.date = cell;
        continue;
      }
      if (cur.status && cur.date && cur.reason.length < 110) {
        if (!/^(approved|conditionally|prohibited|public reefs|leases|status|date|reason)/i.test(cell)) {
          cur.reason = `${cur.reason} ${cell}`.trim().slice(0, 120);
        }
      }
    }
    flush();
    if (!areas.length) return null;
    return { region, published: pub ? pub[1] : "", areas };
  });
  if (value === null) return jsonResponse({ error: "upstream unavailable" }, 502);
  return jsonResponse(value, 200);
}

// ------------------------------------------------------------- router
//
// How one request flows through this Worker, in plain words:
//   1. The app asks this Worker (never the upstream service directly)
//      for one kind of data about one place.
//   2. The place is rounded to a 0.1° grid cell — about 11 km — and the
//      cache key is built from the data type + cell, so every user
//      near the same town shares one stored answer and the exact
//      coordinates are never written down.
//   3. If a fresh-enough copy of that answer is in D1 (the cache
//      cupboard), it is returned immediately; no upstream call, no
//      quota spent. That is "cache-aside": the cache is checked first
//      and filled only on a miss.
//   4. On a miss, the Worker fetches the upstream service itself —
//      using the API key it keeps as a secret — checks the reply has
//      the expected shape, stores it with an expiry time (the TTL),
//      and returns it.
//   5. If the upstream fetch fails but an expired copy exists, the
//      expired copy may be served anyway ("stale") within a grace
//      window, so a provider outage degrades the app instead of
//      breaking it.
//   6. Once an hour, the scheduled() sweeper deletes long-expired
//      rows, because D1 has no automatic expiry of its own.

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
      case "/geo":
        return handleGeo(request);
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
      case "/air":
        return handleAir(request, env, ctx, url);
      case "/cyan":
        return handleCyan(request, env, ctx, url);
      case "/spill":
        return handleSpill(request, env, ctx, url);
      case "/habstate":
        return handleHabState(request, env, ctx, url);
      case "/wqp":
        return handleWqp(request, env, ctx, url);
      case "/firms":
        return handleFirms(request, env, ctx, url);
      case "/shellfish":
        return handleShellfish(request, env, ctx, url);
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
