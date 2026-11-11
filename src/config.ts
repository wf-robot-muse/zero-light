// User settings — stored only in this device's localStorage.
//
// NO key is ever committed to this repository. The USGS Water Data API key
// and the NOAA NCEI CDO token registered for this project live in the
// project mailbox / secure credential storage and stay out of this public
// repo. A user pastes their own keys here if they want live gauge data
// (USGS) and climate normals (NCEI); the app works without them.

const KEYS = {
  usgs: "fh_usgs_api_key",
  ncei: "fh_ncei_token",
  cacheEndpoint: "zl_cache_endpoint",
  includeTypical: "zl_export_typical",
  includeDontGo: "zl_export_dontgo",
} as const;

export interface ApiKeys {
  usgs: string;
  ncei: string;
}

export interface AppSettings extends ApiKeys {
  /** Optional Layer 2 cache Worker base URL (item #15). Empty = direct. */
  cacheEndpoint: string;
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

export function loadApiKeys(): ApiKeys {
  return { usgs: get(KEYS.usgs), ncei: get(KEYS.ncei) };
}

export function saveApiKeys(keys: ApiKeys): void {
  set(KEYS.usgs, keys.usgs);
  set(KEYS.ncei, keys.ncei);
}

export function loadSettings(): AppSettings {
  return {
    ...loadApiKeys(),
    cacheEndpoint: get(KEYS.cacheEndpoint),
    includeTypical: get(KEYS.includeTypical) === "1",
    includeDontGo: get(KEYS.includeDontGo) === "1",
  };
}

export function saveSettings(s: AppSettings): void {
  saveApiKeys(s);
  set(KEYS.cacheEndpoint, s.cacheEndpoint);
  set(KEYS.includeTypical, s.includeTypical ? "1" : "");
  set(KEYS.includeDontGo, s.includeDontGo ? "1" : "");
}
