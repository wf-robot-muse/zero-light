// Optional user-supplied API keys.
//
// NO key is ever committed to this repository. The USGS Water Data API key and
// the NOAA NCEI CDO token registered for this project live in the project
// mailbox / secure credential storage and stay out of this public repo.
// v1 makes no USGS/NCEI calls; these settings exist so a user can paste their
// own keys locally (stored only in this browser/webview's localStorage).

const KEYS = {
  usgs: "fh_usgs_api_key",
  ncei: "fh_ncei_token",
} as const;

export interface ApiKeys {
  usgs: string;
  ncei: string;
}

export function loadApiKeys(): ApiKeys {
  try {
    return {
      usgs: localStorage.getItem(KEYS.usgs) ?? "",
      ncei: localStorage.getItem(KEYS.ncei) ?? "",
    };
  } catch {
    return { usgs: "", ncei: "" };
  }
}

export function saveApiKeys(keys: ApiKeys): void {
  try {
    if (keys.usgs) localStorage.setItem(KEYS.usgs, keys.usgs);
    else localStorage.removeItem(KEYS.usgs);
    if (keys.ncei) localStorage.setItem(KEYS.ncei, keys.ncei);
    else localStorage.removeItem(KEYS.ncei);
  } catch {
    /* storage unavailable — keys simply won't persist */
  }
}
