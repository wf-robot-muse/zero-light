// Calendar export (next-build item #12).
// In plain words: this file turns planned time slots into calendar
// events — a downloadable .ics file (Apple Calendar and most others),
// or one-tap "add" links for Google and Outlook. It also owns the one
// save route every file the app produces uses, badges included.
//
// Decisions (locked 2026-11-11): export is offered from the planner, the
// trends view, and the day-detail modal. One event per slot. The .ics
// file is the bulk route (generated entirely in-app); Google and Outlook
// are per-event pre-filled "add" links (no OAuth). By default all
// forecast days export regardless of band; "typical" days and "Don't go"
// days are included only when their Settings toggles are on (both
// default OFF).

import type { DayPlan, Slot } from "./scoring";

export interface ExportDay {
  plan: DayPlan;
  /** Location-local calendar date the plan belongs to. */
  date: Date;
  targetName: string;
  locationName: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Floating local timestamp (no timezone suffix): calendar apps read it
 *  as wall-clock time, which is exactly how the app's times are framed. */
function icsTime(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function icsDate(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function stampNow(): string {
  const d = new Date();
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escIcs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function slotTitle(day: ExportDay, slot: Slot): string {
  const label = slot.bestToday ? "Best today" : slot.label;
  return `${label} — ${day.targetName} (${day.locationName})`;
}

function slotDescription(day: ExportDay, slot: Slot): string {
  // #42: the held-back reason rides in every calendar description (the
  // .ics routes and the Google/Outlook add links share this builder).
  const held = day.plan.heldBackBy ? ` Day held back by: ${day.plan.heldBackBy}.` : "";
  return `${slot.reason}.${held} Day verdict: ${day.plan.verdict}. Planned with Zero Light.`;
}

export function buildIcs(days: ExportDay[], opts: { includeTypical: boolean; includeDontGo: boolean }): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Zero Light//EN",
    "CALSCALE:GREGORIAN",
  ];
  const stamp = stampNow();
  let n = 0;
  for (const day of days) {
    if (day.plan.typical && !opts.includeTypical) continue;
    if (day.plan.veto) {
      if (!opts.includeDontGo) continue;
      lines.push(
        "BEGIN:VEVENT",
        `UID:dontgo-${day.plan.dateKey}-${n++}@zerolight`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(day.date)}`,
        `DTEND;VALUE=DATE:${icsDate(new Date(day.date.getTime() + 86400_000))}`,
        `SUMMARY:${escIcs(`Don't go — ${day.targetName} (${day.locationName})`)}`,
        `DESCRIPTION:${escIcs(day.plan.veto)}`,
        "END:VEVENT",
      );
      continue;
    }
    // #42 (Wade's addition): a held-back day with no rated window still
    // exports — one all-day event mirroring the Don't-go pattern. Not
    // gated by the typical/Don't-go toggles (decided at lock time).
    if (!day.plan.typical && day.plan.heldBackBy && day.plan.slots.length === 0) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:heldback-${day.plan.dateKey}-${n++}@zerolight`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(day.date)}`,
        `DTEND;VALUE=DATE:${icsDate(new Date(day.date.getTime() + 86400_000))}`,
        `SUMMARY:${escIcs(`Held back — ${day.targetName} (${day.locationName})`)}`,
        `DESCRIPTION:${escIcs(`Day held back by: ${day.plan.heldBackBy}. Day verdict: ${day.plan.verdict}. Planned with Zero Light.`)}`,
        "END:VEVENT",
      );
      continue;
    }
    for (const slot of day.plan.slots) {
      const title = day.plan.typical ? `Typical day (estimate) — ${slotTitle(day, slot)}` : slotTitle(day, slot);
      lines.push(
        "BEGIN:VEVENT",
        `UID:slot-${day.plan.dateKey}-${n++}@zerolight`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsTime(slot.start)}`,
        `DTEND:${icsTime(slot.end)}`,
        `SUMMARY:${escIcs(title)}`,
        `DESCRIPTION:${escIcs(slotDescription(day, slot))}`,
        `LOCATION:${escIcs(day.locationName)}`,
        "END:VEVENT",
      );
    }
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** #49: one save route for every .ics the app produces. In the desktop
 *  apps the user gets the native Save As dialog (name + location,
 *  default "zero-light-plans.ics") and the file is written to exactly
 *  the path they chose — cancelling writes nothing. On the web the
 *  build is unchanged: the browser's own download with the fixed name
 *  (Wade's scope call, 2026-11-14: desktop only). The shell is detected
 *  once through the app's own shell_info command. */
let shellOsCache: string | null | undefined;

export async function detectShellOs(): Promise<string | null> {
  if (shellOsCache !== undefined) return shellOsCache;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<{ os?: unknown }>("shell_info");
    shellOsCache = info && typeof info.os === "string" ? info.os : null;
  } catch {
    shellOsCache = null; // web build: no bridge
  }
  return shellOsCache;
}

async function saveIcsText(text: string): Promise<void> {
  const os = await detectShellOs();
  if (os) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: "zero-light-plans.ics",
      filters: [{ name: "Calendar file", extensions: ["ics"] }],
    });
    if (!path) return; // user cancelled the dialog — nothing is written
    await writeTextFile(path, text);
    return;
  }
  const blob = new Blob([text], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "zero-light-plans.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadIcs(days: ExportDay[], opts: { includeTypical: boolean; includeDontGo: boolean }): void {
  void saveIcsText(buildIcs(days, opts)).catch(() => {
    /* dialog/write failure: nothing saved; the export can be retried */
  });
}

/** #43: the per-slot "Apple / .ics" entry — a one-event .ics download for
 *  exactly this slot, parallel to the Google/Outlook per-slot links.
 *  Reuses buildIcs so the title/description match the other routes. */
export function downloadSlotIcs(day: ExportDay, slot: Slot): void {
  const one: ExportDay = { ...day, plan: { ...day.plan, slots: [slot] } };
  void saveIcsText(buildIcs([one], { includeTypical: true, includeDontGo: true })).catch(() => {
    /* dialog/write failure: nothing saved; the export can be retried */
  });
}

export function googleUrl(day: ExportDay, slot: Slot): string {
  const title = day.plan.typical ? `Typical day (estimate) — ${slotTitle(day, slot)}` : slotTitle(day, slot);
  return (
    `https://calendar.google.com/calendar/render?action=TEMPLATE` +
    `&text=${encodeURIComponent(title)}` +
    `&dates=${icsTime(slot.start)}/${icsTime(slot.end)}` +
    `&details=${encodeURIComponent(slotDescription(day, slot))}` +
    `&location=${encodeURIComponent(day.locationName)}`
  );
}

export function outlookUrl(day: ExportDay, slot: Slot): string {
  const title = day.plan.typical ? `Typical day (estimate) — ${slotTitle(day, slot)}` : slotTitle(day, slot);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  return (
    `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent` +
    `&subject=${encodeURIComponent(title)}` +
    `&startdt=${encodeURIComponent(iso(slot.start))}` +
    `&enddt=${encodeURIComponent(iso(slot.end))}` +
    `&body=${encodeURIComponent(slotDescription(day, slot))}` +
    `&location=${encodeURIComponent(day.locationName)}`
  );
}
