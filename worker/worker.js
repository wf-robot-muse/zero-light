// Zero Light shared cache — Cloudflare Worker + D1 (next-build item #15,
// Layer 2).
//
// Design rules (decided 2026-11-11):
// - Cache-aside only: clients never write. The Worker writes to D1 only
//   what it fetched itself from the upstream source, after a shape
//   check. There is no client-facing write endpoint at all.
// - Weather is keyed by 0.1° grid cell + the upstream URL shape; the
//   exact user coordinates are never stored — requests are snapped to
//   the cell centre before fetching upstream.
// - Aging ladder (TTL): forecast starting today/tomorrow ~2h, days
//   +3–7 ~8h, +8–16 ~12h. On upstream failure, an expired entry is
//   served stale for up to 6h past expiry with an X-ZL-Stale header.
// - Purge is a POST to /purge guarded by the PURGE_SECRET Worker secret.
//
// Endpoints:
//   GET /weather?lat=<n>&lon=<n>   → Open-Meteo 16-day hourly JSON
//   GET /health                     → { ok: true }
//
// D1 schema: see schema.sql. Binding name: CACHE.

const UPSTREAM = "https://api.open-meteo.com/v1/forecast";

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

    if (url.pathname !== "/weather" || request.method !== "GET") {
      return jsonResponse({ error: "not found" }, 404);
    }

    const lat = parseFloat(url.searchParams.get("lat") ?? "");
    const lon = parseFloat(url.searchParams.get("lon") ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return jsonResponse({ error: "lat/lon required" }, 400);
    }

    // Snap to the 0.1° cell centre — the cell, never the exact point, is
    // what gets fetched and stored.
    const cellLat = (Math.round(lat * 10) / 10).toFixed(1);
    const cellLon = (Math.round(lon * 10) / 10).toFixed(1);
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
      `${UPSTREAM}?latitude=${cellLat}&longitude=${cellLon}` +
      `&hourly=temperature_2m,pressure_msl,wind_speed_10m,cloud_cover,precipitation_probability` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=16&timezone=auto`;

    let upstreamRes;
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
  },

  // Sweeper: expired entries are removed hourly (D1 has no native TTL).
  async scheduled(_event, env, _ctx) {
    const now = Math.floor(Date.now() / 1000);
    await env.CACHE.prepare("DELETE FROM cache_entries WHERE expires_at < ?")
      .bind(now - 6 * 3600)
      .run();
  },
};
