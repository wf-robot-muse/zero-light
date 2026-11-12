// User settings + persisted location — stored only in this device's
// localStorage.
//
// v0.3.0 (items #17/#20): API keys and the cache endpoint are NOT user
// settings anymore. The USGS / NCEI / Geoapify keys live server-side as
// Worker secrets (custody: Robot, per Wade 2026-11-12) and the app talks
// to the Layer 2 Worker, whose URL is a built-in constant below.

/** Layer 2 cache Worker base URL (items #15/#20). Built in, not a user
 *  setting (Wade, 2026-11-12). If the Worker is unreachable the app
 *  falls back to direct/keyless sources. */
export const CACHE_ENDPOINT = "https://zero-light-cache.wf-robot-muse.workers.dev";

const KEYS = {
  includeTypical: "zl_export_typical",
  includeDontGo: "zl_export_dontgo",
} as const;

export interface AppSettings {
  /** Calendar export toggles (item #12) — both default OFF. */
  includeTypical: boolean;
  includeDontGo: boolean;
}

function get(k: string): string {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
}

function set(k: string, v: string): void {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* storage unavailable — settings simply won't persist */
  }
}

export function loadSettings(): AppSettings {
  return {
    includeTypical: get(KEYS.includeTypical) === "1",
    includeDontGo: get(KEYS.includeDontGo) === "1",
  };
}

export function saveSettings(s: AppSettings): void {
  set(KEYS.includeTypical, s.includeTypical ? "1" : "");
  set(KEYS.includeDontGo, s.includeDontGo ? "1" : "");
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
  try {
    localStorage.setItem(
      LAST_KEY,
      JSON.stringify({ lat: p.lat, lon: p.lon, label: p.label.slice(0, 120) }),
    );
  } catch {
    /* storage unavailable */
  }
}
