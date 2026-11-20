// User settings + persisted location — stored only in this device's
// localStorage.
// In plain words: the app's memory of your choices — the two calendar
// export toggles, the theme, which targets show in the dropdown (#63),
// the last target you picked, the map style, and the last location —
// kept on this device only, never uploaded.
//
// v0.3.0 (items #17/#20): API keys and the cache endpoint are NOT user
// settings anymore. The USGS / NCEI / Geoapify keys live server-side as
// Worker secrets (custody: Robot, per Wade 2026-11-12) and the app talks
// to the Layer 2 Worker, whose URL is a built-in constant below.

/** Layer 2 cache Worker base URL (items #15/#20). Built in, not a user
 *  setting (Wade, 2026-11-12). If the Worker is unreachable the app
 *  falls back to direct/keyless sources. */
export const CACHE_ENDPOINT = "https://zero-light-cache.wf-robot-muse.workers.dev";

import { TARGETS } from "./scoring";
import { evictOldestCacheEntries, sweepCache } from "./cache";

const KEYS = {
  includeTypical: "zl_export_typical",
  includeDontGo: "zl_export_dontgo",
  theme: "zl_theme",
  targets: "zl_enabled_targets",
} as const;

/** Item #63: the targets shown in the dropdown on a fresh install (and
 *  the "Reset to defaults" set) — 10 of the 25-target catalog, chosen by
 *  Wade 2026-11-19. Stored per user once they save Settings; the full
 *  catalog always stays available in the Settings target picker. */
export const DEFAULT_TARGET_IDS: readonly string[] = [
  "catfish",
  "flounder",
  "grouper",
  "largemouth-bass",
  "redfish",
  "snapper",
  "speckled-trout",
  "turkey",
  "waterfowl",
  "whitetail",
];

/** Theme preference (#25). "device" = Follow device (default). The persisted
 *  value is re-validated on load against exactly these three values
 *  (input-security rule, Wade 2026-11-12); anything else falls back to
 *  "device". */
export type ThemePref = "device" | "light" | "dark";
export const THEME_PREFS: readonly ThemePref[] = ["device", "light", "dark"];

export interface AppSettings {
  /** Calendar export toggles (item #12) — both default OFF. */
  includeTypical: boolean;
  includeDontGo: boolean;
  /** Theme (#25): Follow device / Light / Dark. */
  theme: ThemePref;
  /** Item #63: ids of the targets shown in the target dropdown, in
   *  catalog order. Always at least one; validated on load. */
  targets: string[];
}

function get(k: string): string {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
}

/**
 * #67: write one key (a null value removes it), making room if the
 * bucket refuses. The Layer 1 cache (src/cache.ts) shares this origin's
 * localStorage bucket and, before #67, grew until the browser capped
 * it — after which every settings write needing new space threw
 * QuotaExceededError while long-resident keys (like the last location)
 * kept working, so settings silently stopped saving in Wade's Safari.
 * These values are a few hundred bytes and outrank cached forecasts:
 * on a refused write, sweep expired cache entries, evict the oldest
 * cache entries, and retry once. Only zl_cache_* keys are ever freed —
 * never settings keys, never another app's data.
 */
function writeWithRoom(k: string, v: string | null): void {
  const put = () => {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  };
  try {
    put();
  } catch {
    try {
      sweepCache(0);
      evictOldestCacheEntries(5);
      put();
    } catch {
      /* storage unavailable — the value simply won't persist */
    }
  }
}

function set(k: string, v: string): void {
  writeWithRoom(k, v ? v : null);
}

/** Item #63: the persisted enabled-target list is untrusted input —
 *  re-validate on load (input-security rule, Wade 2026-11-12): it must
 *  be a JSON array of strings, only ids that exist in the current
 *  catalog survive, duplicates are dropped, and a missing/empty/garbled
 *  value falls back to the default subset. The result is returned in
 *  catalog order so the dropdown order is stable. */
function loadEnabledTargets(): string[] {
  const known = new Set(TARGETS.map((t) => t.id));
  let picked = new Set<string>();
  try {
    const raw = get(KEYS.targets);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const v of parsed.slice(0, 100)) {
        if (typeof v === "string" && known.has(v)) picked.add(v);
      }
    }
  } catch {
    picked = new Set();
  }
  if (picked.size === 0) picked = new Set(DEFAULT_TARGET_IDS);
  return TARGETS.filter((t) => picked.has(t.id)).map((t) => t.id);
}

export function loadSettings(): AppSettings {
  const rawTheme = get(KEYS.theme);
  return {
    includeTypical: get(KEYS.includeTypical) === "1",
    includeDontGo: get(KEYS.includeDontGo) === "1",
    theme: (THEME_PREFS as readonly string[]).includes(rawTheme)
      ? (rawTheme as ThemePref)
      : "device",
    targets: loadEnabledTargets(),
  };
}

/** Persist the settings; returns true only when the values read back
 *  exactly as written. #66: a browser context that refuses site data
 *  (Private Browsing, blocked storage) makes the writes fail or
 *  silently drop, and the loss otherwise surfaces much later as "my
 *  settings reset" — the caller checks this result and tells the user
 *  at save time instead. */
export function saveSettings(s: AppSettings): boolean {
  set(KEYS.includeTypical, s.includeTypical ? "1" : "");
  set(KEYS.includeDontGo, s.includeDontGo ? "1" : "");
  set(KEYS.theme, s.theme);
  set(KEYS.targets, JSON.stringify(s.targets));
  return (
    get(KEYS.includeTypical) === (s.includeTypical ? "1" : "") &&
    get(KEYS.includeDontGo) === (s.includeDontGo ? "1" : "") &&
    get(KEYS.theme) === s.theme &&
    get(KEYS.targets) === JSON.stringify(s.targets)
  );
}

// ------------------------------------------------------- last target (#24)
// The last-used target is remembered on this device only. The stored id is
// validated by the caller against the current TARGETS list; an id that no
// longer exists is ignored (the "Choose a target…" placeholder shows).

const TARGET_KEY = "zl_last_target";

export function loadLastTargetId(): string {
  const v = get(TARGET_KEY);
  // Ids are short slugs; reject anything that is not slug-shaped outright.
  return /^[a-z0-9-]{1,40}$/.test(v) ? v : "";
}

export function saveLastTargetId(id: string): void {
  set(TARGET_KEY, id);
}

// ------------------------------------------------------- base map (#37)
// The chosen map base layer is remembered on this device only. The
// persisted value is re-validated on load against exactly the three
// known layer ids (input-security rule, Wade 2026-11-12); anything
// else falls back to the standard map.

export type BaseMapId = "map" | "satellite" | "topo";
export const BASE_MAP_IDS: readonly BaseMapId[] = ["map", "satellite", "topo"];
const BASE_MAP_KEY = "zl_base_map";

export function loadBaseMapId(): BaseMapId {
  const v = get(BASE_MAP_KEY);
  return (BASE_MAP_IDS as readonly string[]).includes(v) ? (v as BaseMapId) : "map";
}

export function saveBaseMapId(id: BaseMapId): void {
  set(BASE_MAP_KEY, id);
}

// ------------------------------------------------------- last location
// Item #17: the user's selected location is per-user data — it is kept
// ONLY on this device, never in the shared Layer 2 cache. It is
// re-validated on every load (input-security rule, Wade 2026-11-12).

export interface SavedPlace {
  lat: number;
  lon: number;
  label: string;
}

const LAST_KEY = "zl_last_location";

export function validCoords(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}

export function loadLastPlace(): SavedPlace | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SavedPlace>;
    if (!validCoords(p.lat, p.lon)) return null;
    const label = typeof p.label === "string" ? p.label.slice(0, 120) : "";
    return { lat: p.lat as number, lon: p.lon as number, label };
  } catch {
    return null;
  }
}

export function saveLastPlace(p: SavedPlace): void {
  // #67: routed through writeWithRoom like the settings writes, so a
  // full bucket frees cache space for this write too.
  writeWithRoom(
    LAST_KEY,
    JSON.stringify({ lat: p.lat, lon: p.lon, label: p.label.slice(0, 120) }),
  );
}
