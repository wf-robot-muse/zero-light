// Layer 1 of the caching design (next-build item #15): a local-first
// device cache. In plain words: the app's own notebook — answers it has
// already fetched are kept on the device with an expiry time, so
// reopening the app is instant and offline use still shows the last
// known data (labelled stale). Interactions read the local copy; the network is queried
// only when the local copy is missing or past its TTL. If the network
// fails, the local copy is served even past TTL and the caller is told
// the data is stale so the UI can show a "last updated" note. An
// explicit refresh (opts.force) is the only thing that bypasses a fresh
// local copy.
//
// TTLs mirror the server-side aging ladder that the Layer 2 Worker
// (worker/) applies; when a Worker endpoint is configured, its max-age
// would take over this role — v0.2.0 keeps the policy constants here.

export const TTL = {
  weatherMs: 2 * 3600_000, // today's forecast ~2h (spec decision)
  tidesMs: 12 * 3600_000, // predictions are static; 12h is plenty
  stationsMs: 7 * 86400_000, // tide station list
  usgsMs: 30 * 60_000, // gauge observations
  habMs: 6 * 3600_000, // red tide samples (source updates daily)
  normalsMs: 30 * 86400_000, // climate normals are effectively static
  geocodeMs: 30 * 86400_000,
  // Item #69 environmental families — these mirror the Layer 2 aging
  // ladder (worker/worker.js): air and spill notices move fastest,
  // satellite blooms and lab samples are slow by nature.
  envAirMs: 3600_000, // air quality: hourly
  envSpillMs: 3600_000, // spill / sewage notices: hourly
  envCyanMs: 86400_000, // satellite bloom index: weekly data, daily check
  envHabStateMs: 6 * 3600_000, // FL DEP bloom samples
  envWqpMs: 86400_000, // bacteria lab samples: posted days late anyway
  envFirmsMs: 3 * 3600_000, // active-fire detections
  envShellfishMs: 6 * 3600_000, // FDACS daily status pages
  envAttainsMs: 7 * 86400_000, // ATTAINS assessments: reviewed on multi-year cycles (#70)
  // Item #82 history: recorded weather by month. A settled month is
  // kept a month on-device (it cannot change); the current month only
  // a day, while its last days are still settling into the record.
  histSettledMs: 30 * 86400_000,
  histCurrentMs: 86400_000,
} as const;

interface Entry {
  t: number; // fetched-at, epoch ms
  exp: number; // expiry, epoch ms
  data: unknown;
}

const PREFIX = "zl_cache_";

function storageKey(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return PREFIX + h.toString(36);
}

function readEntry(key: string): Entry | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    const e = JSON.parse(raw) as Entry;
    if (typeof e?.t !== "number" || !("data" in e)) return null;
    return e;
  } catch {
    return null;
  }
}

function writeEntry(key: string, ttlMs: number, data: unknown): void {
  const now = Date.now();
  const e: Entry = { t: now, exp: now + ttlMs, data };
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(e));
  } catch {
    // #67: the bucket is probably full — this cache shares the origin's
    // localStorage with the app's settings, and until #67 nothing ever
    // deleted an entry, so the cache grew until Safari's localStorage
    // cap refused new writes (QuotaExceededError) and SETTINGS stopped
    // saving on Wade's iPhone. Free space and retry once: expired
    // entries first, then the oldest entries overall. Still failing →
    // caching stays best-effort, never fatal.
    try {
      sweepCache(0);
      evictOldestCacheEntries(3);
      localStorage.setItem(storageKey(key), JSON.stringify(e));
    } catch {
      /* quota or unavailable — caching is best-effort, never fatal */
    }
  }
}

/** #67: every localStorage key belonging to this cache. */
function cacheKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
  } catch {
    /* storage unavailable */
  }
  return keys;
}

/**
 * #67: delete cache entries whose expiry is more than `graceMs` in the
 * past. Recently-expired entries stay: they are the offline stale
 * fallback (#15). The startup sweep passes a 7-day grace, so the bucket
 * cannot grow without bound the way it did before #67. Returns how
 * many entries were removed.
 */
export function sweepCache(graceMs: number): number {
  const now = Date.now();
  let removed = 0;
  for (const k of cacheKeys()) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const e = JSON.parse(raw) as Partial<Entry>;
      if (typeof e?.exp !== "number" || now > e.exp + graceMs) {
        localStorage.removeItem(k);
        removed++;
      }
    } catch {
      /* unreadable entry — leave it; eviction below can still take it */
    }
  }
  return removed;
}

/**
 * #67: delete the `n` oldest cache entries (by fetch time; an
 * unreadable entry counts as oldest — it is useless anyway). Used to
 * make room when the bucket is full: one weather entry is typically
 * tens of KB, while the settings that need the room are a few hundred
 * bytes. Only zl_cache_* keys are ever touched — settings keys and
 * other apps' data are never removed here.
 */
export function evictOldestCacheEntries(n: number): number {
  const entries: { k: string; t: number }[] = [];
  for (const k of cacheKeys()) {
    let t = 0;
    try {
      const raw = localStorage.getItem(k);
      const e = raw ? (JSON.parse(raw) as Partial<Entry>) : null;
      if (typeof e?.t === "number") t = e.t;
    } catch {
      /* unreadable → t stays 0, evicted first */
    }
    entries.push({ k, t });
  }
  entries.sort((a, b) => a.t - b.t);
  let removed = 0;
  for (const { k } of entries.slice(0, Math.max(0, n))) {
    try {
      localStorage.removeItem(k);
      removed++;
    } catch {
      /* storage unavailable */
    }
  }
  return removed;
}

export interface Cached<T> {
  data: T;
  fetchedAt: number;
  /** True when served past TTL because the refresh failed (offline). */
  stale: boolean;
  fromCache: boolean;
}

/** Local-first JSON fetch: the single funnel for remote reads. */
export async function cachedJson<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  opts?: { force?: boolean },
): Promise<Cached<T>> {
  const entry = readEntry(key) as Entry | null;
  const now = Date.now();
  if (entry && !opts?.force && now < entry.exp) {
    return { data: entry.data as T, fetchedAt: entry.t, stale: false, fromCache: true };
  }
  try {
    const data = await load();
    writeEntry(key, ttlMs, data);
    return { data, fetchedAt: Date.now(), stale: false, fromCache: false };
  } catch (err) {
    if (entry) {
      return { data: entry.data as T, fetchedAt: entry.t, stale: true, fromCache: true };
    }
    throw err;
  }
}

/** Convenience wrapper for plain GET-JSON endpoints. */
export async function cachedJsonUrl<T>(
  url: string,
  ttlMs: number,
  opts?: { force?: boolean; headers?: Record<string, string> },
): Promise<Cached<T>> {
  return cachedJson<T>(url, ttlMs, async () => {
    const res = await fetch(url, { headers: opts?.headers });
    if (!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`);
    return (await res.json()) as T;
  }, opts);
}
