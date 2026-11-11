// Layer 1 of the caching design (next-build item #15): a local-first
// device cache. Interactions read the local copy; the network is queried
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
  try {
    const now = Date.now();
    const e: Entry = { t: now, exp: now + ttlMs, data };
    localStorage.setItem(storageKey(key), JSON.stringify(e));
  } catch {
    /* quota or unavailable — caching is best-effort, never fatal */
  }
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
