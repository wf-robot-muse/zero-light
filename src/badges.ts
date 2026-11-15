// #56: watch badge PNGs. The app renders a watch-sized badge image from
// live plan data — slot, day, or week (W1 layout) — for Apple Watch
// (416x496) or Android Wear OS (480x480, round). The user puts the saved
// PNG on the watch as a photo face. A badge is a static picture: it
// never updates itself, and a new slot or day means a new badge.
// Rendering is Canvas 2D with text drawn as text — user-derived strings
// (the location name) are fillText only, never parsed markup.
//
// In plain words: this file is a small poster printer. It takes a
// finished day plan and paints a picture of it at exactly the pixel
// size of a watch screen (drawn at 2x for sharpness). Two geometry
// rules shape every badge: the top of the Apple canvas stays empty
// because the watch draws its own clock there, and on Android only
// the circle inscribed in the square is ever visible, so all content
// lives in a central column. The ghost animal image behind the text
// is the same stencil art as the app's hero, drawn with the "screen"
// blend so it lightens the band colour instead of covering it; since
// #57 it is always drawn at its natural proportions. Saving goes
// through the same route as the calendar files (calendar.ts): a
// native Save As dialog in the desktop apps, a browser download on
// the web.
import type { DayPlan, Slot } from "./scoring";
import { detectShellOs } from "./calendar";

export type BadgePlatform = "apple" | "android";

export interface BadgeDay {
  plan: DayPlan;
  targetId: string;
  targetName: string;
  locationName: string;
}

const BAND_HEX: Record<string, string> = {
  excellent: "#1E6634",
  good: "#2E7D46",
  fair: "#BC8400",
  poor: "#607D8B",
  dontgo: "#B3261E",
};
const DARK_BG = "#0D1114";
const OFFWHITE = "#F2EFE3";
const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`;

const STENCIL_BY_TARGET: Record<string, string> = {
  redfish: "redfish",
  whitetail: "whitetail",
  turkey: "turkey",
  waterfowl: "mallard",
  "largemouth-bass": "bass",
  cobia: "cobia",
  flounder: "flounder",
  grouper: "grouper",
  snapper: "snapper",
  snook: "snook",
  "speckled-trout": "trout",
};
const stencilModules = import.meta.glob("./assets/stencils/stencil-*.webp", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function stencilUrl(targetId: string): string {
  const name = STENCIL_BY_TARGET[targetId];
  if (!name) return "";
  return stencilModules[`./assets/stencils/stencil-${name}.webp`] ?? "";
}

// ---- small helpers --------------------------------------------------------

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function fmtTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${ampm}` : `${h} ${ampm}`;
}

/** Compact badge range ("6:12–8:12 AM") — the locked #56 mockup form. */
function fmtRange(a: Date, b: Date): string {
  const sfx = (d: Date) => (d.getHours() >= 12 ? "PM" : "AM");
  if (sfx(a) === sfx(b)) return `${fmtTime(a).replace(/ (AM|PM)$/, "")}–${fmtTime(b)}`;
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}

function dayLabel(key: string): string {
  return parseKey(key).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function bandKey(plan: DayPlan): string {
  if (plan.veto) return "dontgo";
  return plan.verdict.toLowerCase();
}

function slotLabelWord(slot: Slot): string {
  return slot.bestToday ? "Best today" : slot.label;
}

function slotHex(slot: Slot): string {
  if (slot.bestToday) return BAND_HEX.fair;
  return BAND_HEX[slot.label.toLowerCase()] ?? BAND_HEX.good;
}

// #59: the stencil is loaded through a blob URL, never the raw asset
// URL. In the desktop apps the asset URL uses the app's own scheme,
// and WebKit treats images from non-http(s) schemes as foreign for
// canvas purposes: drawing one makes the canvas unreadable, so the
// PNG export (toBlob) fails and no Save dialog ever appears. Proven
// on macOS by elimination — the week badge, which draws no stencil,
// saved fine in the app while day/slot badges did not, and the shared
// save route was proven good by .ics export. A blob URL inherits the
// page's origin, so the canvas stays exportable on every platform.
// Loaded images are cached per URL for the session (the object URLs
// are deliberately not revoked — a cached image must stay drawable;
// there are at most 11 stencils).
const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  const hit = imageCache.get(src);
  if (hit) return hit;
  const p = (async (): Promise<HTMLImageElement | null> => {
    let url = src;
    try {
      const res = await fetch(src);
      if (res.ok) url = URL.createObjectURL(await res.blob());
    } catch {
      /* fetch unavailable — fall back to the direct URL */
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  })();
  imageCache.set(src, p);
  return p;
}

interface Geo {
  w: number;
  h: number;
  x: number; // content left
  cw: number; // content width
  top: number; // content top (below the watch's own clock)
  footerY: number;
  center: boolean;
}

const GEOS: Record<BadgePlatform, Geo> = {
  // Apple: top 150px stays empty for the watchOS clock, 50px bottom
  // guard, 34px side insets for the rounded corners / center crop.
  apple: { w: 416, h: 496, x: 34, cw: 348, top: 150, footerY: 446, center: false },
  // Android (Wear OS, round): only the inscribed circle shows; the
  // clock sits top-center, so content lives in a 340px central column.
  android: { w: 480, h: 480, x: 70, cw: 340, top: 138, footerY: 402, center: true },
};

function makeCanvas(geo: Geo): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = geo.w * 2;
  canvas.height = geo.h * 2;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(2, 2);
  ctx.textBaseline = "alphabetic";
  return { canvas, ctx };
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

function spacing(ctx: CanvasRenderingContext2D, px: number): void {
  try {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
  } catch {
    /* older engines: no letter spacing, layout still fits */
  }
}

/** Draw text at the geo's alignment; returns its width. */
/** Badge-only location cleanup (#57): drop a trailing country suffix
 *  ("…, United States of America") and the comma it leaves behind.
 *  The app's own location label is unchanged. */
function badgeLocation(name: string): string {
  const cleaned = name
    .replace(/[,\s]*(United States of America|United States|USA)\s*$/i, "")
    .replace(/[,\s]+$/, "")
    .trim();
  return cleaned || name;
}

function text(
  ctx: CanvasRenderingContext2D,
  geo: Geo,
  s: string,
  y: number,
  weight: number,
  size: number,
  color: string,
  alpha = 1,
  shadow = false,
): number {
  setFont(ctx, weight, size);
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.textAlign = geo.center ? "center" : "left";
  const x = geo.center ? geo.x + geo.cw / 2 : geo.x;
  if (shadow) {
    // Soft dark halo so the line stays readable over the stencil ghost.
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
  }
  ctx.fillText(s, x, y, geo.cw);
  if (shadow) {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  return ctx.measureText(s).width;
}

/** Shrink-to-fit single line for the big window readout. */
function fitText(
  ctx: CanvasRenderingContext2D,
  geo: Geo,
  s: string,
  y: number,
  weight: number,
  size: number,
  color: string,
): void {
  let sz = size;
  setFont(ctx, weight, sz);
  while (ctx.measureText(s).width > geo.cw && sz > 20) {
    sz -= 2;
    setFont(ctx, weight, sz);
  }
  ctx.fillStyle = color;
  ctx.textAlign = geo.center ? "center" : "left";
  const x = geo.center ? geo.x + geo.cw / 2 : geo.x;
  ctx.fillText(s, x, y);
  ctx.textAlign = "left";
}

/** Word-wrap into at most maxLines lines within the content width. */
function wrapLines(ctx: CanvasRenderingContext2D, s: string, maxW: number, maxLines: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) return lines;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

/** A filled pill with centered label; drawn at the geo alignment. */
function pill(
  ctx: CanvasRenderingContext2D,
  geo: Geo,
  s: string,
  yTop: number,
  size: number,
  bg: string,
  fg: string,
): void {
  setFont(ctx, 800, size);
  const tw = ctx.measureText(s).width;
  const w = tw + 26;
  const h = size + 15;
  const x = geo.center ? geo.x + (geo.cw - w) / 2 : geo.x;
  ctx.fillStyle = bg;
  rr(ctx, x, yTop, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.fillText(s, x + w / 2, yTop + h / 2 + size * 0.36);
  ctx.textAlign = "left";
}

/** The crosshair mark in off-white line art (the on-dark treatment). */
function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  ctx.strokeStyle = OFFWHITE;
  ctx.fillStyle = OFFWHITE;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, size * 0.075);
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.3, 0, Math.PI * 2);
  ctx.stroke();
  const inner = size * 0.38;
  const outer = size * 0.48;
  ctx.beginPath();
  for (const [dx, dy] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const) {
    ctx.moveTo(cx + dx * inner, cy + dy * inner);
    ctx.lineTo(cx + dx * outer, cy + dy * outer);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.055, 0, Math.PI * 2);
  ctx.fill();
}

function footer(
  ctx: CanvasRenderingContext2D,
  geo: Geo,
  rightText: string,
): void {
  const size = 26;
  const y = geo.footerY - size;
  ctx.fillStyle = "#FFFFFF";
  if (geo.center) {
    setFont(ctx, 800, 13);
    spacing(ctx, 2);
    const label = "ZERO LIGHT";
    const tw = ctx.measureText(label).width;
    const total = size + 8 + tw;
    const x0 = geo.x + (geo.cw - total) / 2;
    drawMark(ctx, x0, y, size);
    ctx.globalAlpha = 0.92;
    ctx.fillText(label, x0 + size + 8, geo.footerY - size / 2 + 5);
    ctx.globalAlpha = 1;
    spacing(ctx, 0);
    return;
  }
  drawMark(ctx, geo.x, y, size);
  setFont(ctx, 800, 13);
  spacing(ctx, 2);
  ctx.globalAlpha = 0.92;
  ctx.fillText("ZERO LIGHT", geo.x + size + 8, geo.footerY - size / 2 + 5);
  ctx.globalAlpha = 1;
  spacing(ctx, 0);
  if (rightText) {
    setFont(ctx, 600, 12);
    ctx.globalAlpha = 0.85;
    ctx.textAlign = "right";
    ctx.fillText(rightText, geo.x + geo.cw, geo.footerY - size / 2 + 5);
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
  }
}

async function drawStencil(
  ctx: CanvasRenderingContext2D,
  geo: Geo,
  targetId: string,
  alpha: number,
): Promise<void> {
  const img = await loadImage(stencilUrl(targetId));
  if (!img) return;
  // #57: preserve the source aspect ratio. The stencil webps are not
  // square — the fish are 2:1 and mallard/turkey/whitetail are 3:2 — so
  // drawing into a square box squashes them. Anchor the width and let
  // the height follow the image, the same approach as the hero stencil
  // (which sets a height and lets the width follow).
  const aspect = img.naturalWidth / img.naturalHeight;
  if (!aspect || !isFinite(aspect)) return;
  const w = geo.w * 0.98;
  const h = w / aspect;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "screen";
  ctx.drawImage(img, geo.w - w * 0.82, geo.top - 30, w, h);
  ctx.restore();
}

// ---- scope renderers ------------------------------------------------------

async function renderSlotBadge(day: BadgeDay, slotIndex: number, platform: BadgePlatform): Promise<HTMLCanvasElement> {
  const geo = GEOS[platform];
  const { canvas, ctx } = makeCanvas(geo);
  const plan = day.plan;
  const slot = plan.slots[slotIndex];
  ctx.fillStyle = slotHex(slot);
  ctx.fillRect(0, 0, geo.w, geo.h);
  await drawStencil(ctx, geo, day.targetId, platform === "apple" ? 0.22 : 0.2);
  ctx.fillStyle = "#FFFFFF";

  let y = geo.top + 16;
  spacing(ctx, 2);
  text(ctx, geo, `${slotLabelWord(slot).toUpperCase()} SLOT · ${day.targetName.toUpperCase()}`, y, 800, 15, "#FFFFFF", 0.85);
  spacing(ctx, 0);
  y += 52;
  fitText(ctx, geo, fmtRange(slot.start, slot.end), y, 800, platform === "apple" ? 47 : 43, "#FFFFFF");
  y += 18;
  pill(ctx, geo, `${slot.labelSymbol} ${slotLabelWord(slot).toUpperCase()} · SCORE ${Math.round(slot.score)}`, y, 15, "rgba(0,0,0,0.25)", "#FFFFFF");
  y += 52;
  text(ctx, geo, `${dayLabel(plan.dateKey)} · ${badgeLocation(day.locationName)}`, y, 700, 17, "#FFFFFF", 1, true);
  y += 26;
  setFont(ctx, 500, 15);
  for (const line of wrapLines(ctx, slot.reason, geo.cw, 2)) {
    text(ctx, geo, line, y, 500, 15, "#FFFFFF", 0.85);
    y += 21;
  }
  const others = plan.slots.filter((_, i) => i !== slotIndex).slice(0, 2);
  if (others.length) {
    y += 8;
    const s = `Also good: ${others.map((o) => fmtRange(o.start, o.end)).join(" · ")}`;
    setFont(ctx, 500, 14);
    for (const line of wrapLines(ctx, s, geo.cw, 2)) {
      text(ctx, geo, line, y, 500, 14, "#FFFFFF", 0.8);
      y += 20;
    }
  }
  footer(ctx, geo, platform === "apple" ? `Sunrise ${fmtTime(plan.astro.sunrise)}` : "");
  return canvas;
}

async function renderDayBadge(day: BadgeDay, platform: BadgePlatform): Promise<HTMLCanvasElement> {
  const geo = GEOS[platform];
  const { canvas, ctx } = makeCanvas(geo);
  const plan = day.plan;
  ctx.fillStyle = BAND_HEX[bandKey(plan)];
  ctx.fillRect(0, 0, geo.w, geo.h);
  await drawStencil(ctx, geo, day.targetId, platform === "apple" ? 0.22 : 0.14);
  ctx.fillStyle = "#FFFFFF";

  let y = geo.top + 16;
  spacing(ctx, 2);
  text(ctx, geo, dayLabel(plan.dateKey).toUpperCase(), y, 800, 15, "#FFFFFF", 0.85);
  spacing(ctx, 0);
  y += 14;
  const verdictWord = plan.veto ? "DON'T GO" : `${plan.verdict.toUpperCase()} DAY`;
  pill(ctx, geo, verdictWord, y, 16, "rgba(0,0,0,0.25)", "#FFFFFF");
  y += 56;
  text(ctx, geo, `${day.targetName} · ${badgeLocation(day.locationName)}`, y, 700, 17, "#FFFFFF", 1, true);
  y += 14;

  if (plan.veto) {
    setFont(ctx, 500, 16);
    for (const line of wrapLines(ctx, plan.veto, geo.cw, 3)) {
      y += 24;
      text(ctx, geo, line, y, 500, 16, "#FFFFFF", 0.92);
    }
  } else if (!plan.slots.length) {
    y += 24;
    text(ctx, geo, "No window reached the Okay level.", y, 500, 15, "#FFFFFF", 0.9);
  } else {
    // Four-slot days compress the row step so the last divider still
    // clears the footer (QA on the v0.4.7 build caught the collision).
    const rowTime = plan.slots.length > 3 ? 26 : 30;
    const rowDiv = plan.slots.length > 3 ? 10 : 12;
    for (const slot of plan.slots.slice(0, 4)) {
      y += rowTime;
      text(ctx, geo, fmtRange(slot.start, slot.end), y, 700, 17, "#FFFFFF");
      // rating chip, right-aligned within the content box
      const chip = `${slot.labelSymbol} ${slotLabelWord(slot).toUpperCase()} · ${Math.round(slot.score)}`;
      setFont(ctx, 800, 12.5);
      const tw = ctx.measureText(chip).width;
      const w = tw + 18;
      const x = geo.x + geo.cw - w;
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      rr(ctx, x, y - 17, w, 24, 12);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.textAlign = "center";
      ctx.fillText(chip, x + w / 2, y - 0.5);
      ctx.textAlign = "left";
      y += rowDiv;
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(geo.x, y, geo.cw, 1);
      ctx.fillStyle = "#FFFFFF";
    }
  }
  footer(
    ctx,
    geo,
    platform === "apple" ? `Sunrise ${fmtTime(plan.astro.sunrise)} · Sunset ${fmtTime(plan.astro.sunset)}` : "",
  );
  return canvas;
}

function renderWeekBadge(days: BadgeDay[], platform: BadgePlatform): HTMLCanvasElement {
  const geo = GEOS[platform];
  const { canvas, ctx } = makeCanvas(geo);
  ctx.fillStyle = DARK_BG;
  ctx.fillRect(0, 0, geo.w, geo.h);
  ctx.fillStyle = "#FFFFFF";
  const first = days[0];

  // Vertical rhythm per platform, sized so the strip labels clear the
  // footer (QA on the v0.4.7 build caught both platforms colliding).
  // Android starts higher: the Wear OS clock zone is smaller than the
  // Apple overlay zone the 138px top was budgeted from.
  const top = platform === "android" ? 128 : geo.top;
  const rowHead = platform === "android" ? 33 : 36;
  const rowWin = platform === "android" ? 19 : 20;
  const captionGap = platform === "android" ? 20 : 26;

  let y = top + 14;
  spacing(ctx, 1.6);
  const weekOf = parseKey(first.plan.dateKey)
    .toLocaleDateString("en-US", { month: "short", day: "numeric" })
    .toUpperCase();
  const eyebrow = `WEEK OF ${weekOf} · ${first.targetName.toUpperCase()} · ${badgeLocation(first.locationName).toUpperCase()}`;
  text(ctx, geo, eyebrow, y, 800, 13.5, "#FFFFFF", 0.92);
  spacing(ctx, 0);

  // W1: only the three best days get full rows.
  const ranked = [...days].sort((a, b) => b.plan.dayScore - a.plan.dayScore).slice(0, 3);
  ranked.forEach((d, i) => {
    y += rowHead;
    const head = `${dayLabel(d.plan.dateKey).toUpperCase()} — ${d.plan.veto ? "DON'T GO" : d.plan.verdict.toUpperCase()} · ${Math.round(d.plan.dayScore)}`;
    text(ctx, geo, head, y, 800, 16.5, "#FFFFFF");
    if (i === 0) {
      setFont(ctx, 800, 11);
      const tag = "BEST";
      const tw = ctx.measureText(tag).width;
      const w = tw + 14;
      const x = geo.x + geo.cw - w;
      ctx.fillStyle = BAND_HEX.excellent;
      rr(ctx, x, y - 15, w, 21, 10);
      ctx.fill();
      ctx.fillStyle = "#FFFFFF";
      ctx.textAlign = "center";
      ctx.fillText(tag, x + w / 2, y - 0.5);
      ctx.textAlign = "left";
    }
    y += rowWin;
    const win = d.plan.veto
      ? d.plan.veto
      : d.plan.slots.length
        ? `Best window ${fmtRange(d.plan.slots[0].start, d.plan.slots[0].end)}`
        : "No rated window";
    text(ctx, geo, win, y, 500, 14.5, "#FFFFFF", 0.78);
  });

  // The whole week as a color strip.
  y += captionGap;
  spacing(ctx, 1.6);
  text(ctx, geo, "WHOLE WEEK — COLOR = RATING", y, 700, 11, "#FFFFFF", 0.6);
  spacing(ctx, 0);
  y += 10;
  const gap = 5;
  const segW = (geo.cw - gap * (days.length - 1)) / days.length;
  days.forEach((d, i) => {
    const x = geo.x + i * (segW + gap);
    ctx.fillStyle = BAND_HEX[bandKey(d.plan)];
    rr(ctx, x, y, segW, 26, 6);
    ctx.fill();
    const lab = parseKey(d.plan.dateKey)
      .toLocaleDateString("en-US", { weekday: "narrow" })
      .toUpperCase();
    setFont(ctx, 700, 10.5);
    ctx.fillStyle = "#FFFFFF";
    ctx.globalAlpha = 0.75;
    ctx.textAlign = "center";
    ctx.fillText(`${lab} ${parseKey(d.plan.dateKey).getDate()}`, x + segW / 2, y + 40);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
  });
  footer(ctx, geo, "");
  return canvas;
}

// ---- save route (#49 pattern: native Save As on desktop, download on
// web; #62 added the phone share-sheet route in savePng below) --

async function savePng(blob: Blob, filename: string): Promise<void> {
  const os = await detectShellOs();
  // #62 (decision D2): in the phone apps the badge leaves through the
  // share sheet (save to Photos, send, set as watch face from there).
  if (os === "ios" || os === "android") {
    const { shareFileBytes } = await import("./share");
    await shareFileBytes(filename, new Uint8Array(await blob.arrayBuffer()), "image/png");
    return;
  }
  if (os) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (!path) return; // user cancelled — nothing is written
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("badge render failed"))), "image/png"),
  );
}

export async function downloadSlotBadge(day: BadgeDay, slotIndex: number, platform: BadgePlatform): Promise<void> {
  const canvas = await renderSlotBadge(day, slotIndex, platform);
  await savePng(await toBlob(canvas), `zero-light-badge-slot-${platform}-${day.plan.dateKey}.png`);
}

export async function downloadDayBadge(day: BadgeDay, platform: BadgePlatform): Promise<void> {
  const canvas = await renderDayBadge(day, platform);
  await savePng(await toBlob(canvas), `zero-light-badge-day-${platform}-${day.plan.dateKey}.png`);
}

export async function downloadWeekBadge(days: BadgeDay[], platform: BadgePlatform): Promise<void> {
  if (!days.length) return;
  const canvas = renderWeekBadge(days, platform);
  await savePng(await toBlob(canvas), `zero-light-badge-week-${platform}-${days[0].plan.dateKey}.png`);
}
