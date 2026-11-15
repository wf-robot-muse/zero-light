// Mobile share hand-off (item #62, decisions D1/D2).
// In plain words: on a phone there is no Save As dialog and no
// downloads folder flow like a computer has — the way a file leaves
// an app is the system share sheet (Mail, Files, AirPrint, "Add to
// Calendar", and so on). This module is the one route every mobile
// export takes: write the file into the app's own cache folder, then
// hand its path to the app's share plugin (zlshare), which opens the
// sheet. Desktop and web never come through here — they keep the
// Save As dialog (#49) and the browser download.
//
// Safety note: the file names are fixed app-generated strings (never
// user text), and the bytes are produced by the app's own exporters
// (calendar.ts, badges.ts, printpdf.ts).

import { detectShellOs } from "./calendar";

/** True when the app is running as the iOS or Android app. */
export async function isMobileShell(): Promise<boolean> {
  const os = await detectShellOs();
  return os === "ios" || os === "android";
}

/** Write bytes to the app cache folder and open the share sheet. */
export async function shareFileBytes(filename: string, bytes: Uint8Array, mime: string): Promise<void> {
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const { appCacheDir, join } = await import("@tauri-apps/api/path");
  const { invoke } = await import("@tauri-apps/api/core");
  const dir = await appCacheDir();
  const path = await join(dir, filename);
  await writeFile(path, bytes);
  await invoke("plugin:zlshare|share_file", { path, mime });
}

/** Text variant (calendar files). */
export async function shareTextFile(filename: string, text: string, mime: string): Promise<void> {
  await shareFileBytes(filename, new TextEncoder().encode(text), mime);
}
