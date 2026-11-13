import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  TARGETS,
  generateDayPlan,
  dayBand,
  pressureTrendPer6h,
  type DayPlan,
  type TargetDef,
  type Tides,
} from "./scoring";
import {
  fetchWeather,
  fetchTides,
  tidesForDay,
  dateKey,
  parseDateKey,
  addDaysKey,
  type WeatherByDay,
} from "./data";
import {
  loadSettings,
  saveSettings,
  loadLastPlace,
  saveLastPlace,
  loadLastTargetId,
  saveLastTargetId,
  loadBaseMapId,
  saveBaseMapId,
  CACHE_ENDPOINT,
  type AppSettings,
  type ThemePref,
  type BaseMapId,
} from "./config";
// #29/#30 logo masters (assets/logo/). The full lockup ships in two
// colorways and swaps with the theme; it is the header brand (#30) and
// tops the About modal. The square mark remains the app icon / favicon.
import lockupLightUrl from "../assets/logo/zero-light-lockup-on-light.svg?url";
import lockupDarkUrl from "../assets/logo/zero-light-lockup-on-dark.svg?url";

// #28 hero stencils: engraved prey art, one webp per target. The glob makes
// any missing file degrade gracefully (that target's hero shows no ghost).
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

function stencilFor(targetId: string): string {
  const name = STENCIL_BY_TARGET[targetId];
  if (!name) return "";
  return stencilModules[`./assets/stencils/stencil-${name}.webp`] ?? "";
}
import {
  fetchUsgsReading,
  fetchHabVeto,
  fetchNormals,
  fetchTideStations,
  nearestTideStation,
  lookupZip,
  geocodePlace,
  reverseLabel,
  rutForLocation,
  type UsgsReading,
  type PlaceCandidate,
} from "./extras";
import { downloadIcs, googleUrl, outlookUrl, type ExportDay } from "./calendar";

/** The one selected place (item #17). null = nothing selected yet —
 *  the app sits at its "enter a location" first-run state. */
export interface Place {
  lat: number;
  lon: number;
  label: string;
}

const state = {
  place: null as Place | null,
  // #24: nullable — null means the "Choose a target…" placeholder is in
  // effect and nothing computes. Restored from the persisted last target
  // at startup (validated against TARGETS there).
  targetId: null as string | null,
  dayOffset: 0,
  view: "planner" as "planner" | "trends",
  settings: loadSettings(),
  weather: null as WeatherByDay | null,
  weatherFor: "",
  tides: undefined as Tides | undefined,
  tideStationId: "",
  tideStationName: "",
  usgs: undefined as UsgsReading | undefined,
  habVeto: null as string | null,
  normals: undefined as Map<string, number> | undefined,
  extrasFor: "",
  loading: false,
  plansCache: new Map<string, DayPlan>(),
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function currentLatLon(): { lat: number; lon: number } {
  // With no place selected, fall back to the centre of the US — used
  // only to centre the first-run map, never for scoring.
  return state.place ?? { lat: 39.5, lon: -98.35 };
}

function locationShortName(): string {
  return state.place?.label || "No location selected";
}

function currentTarget(): TargetDef | null {
  // #24: an unset or no-longer-valid id yields null (the placeholder),
  // never a silent fallback to the first target.
  return TARGETS.find((t) => t.id === state.targetId) ?? null;
}

/** The location-local "today" as a date key: the first forecast day when
 *  weather is loaded (Open-Meteo starts at location-local today), else
 *  the device's today. All planner/trends arithmetic is key-based so the
 *  app speaks the location's calendar, not the device's (item #5). */
function startKey(): string {
  if (state.weather && state.weather.days.size) {
    return [...state.weather.days.keys()].sort()[0];
  }
  return dateKey(new Date());
}

function fmtTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${ampm}` : `${h} ${ampm}`;
}

/** Mockup-style range: a shared AM/PM suffix when both ends share one
 *  ("5:58 – 8:58 AM"), full times otherwise. */
function fmtRange(a: Date, b: Date): string {
  const sfx = (d: Date) => (d.getHours() >= 12 ? "PM" : "AM");
  if (sfx(a) === sfx(b)) return `${fmtTime(a).replace(/ (AM|PM)$/, "")} – ${fmtTime(b)}`;
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}

/** Rating-band key for a plan: drives hero color, spine color, band words. */
function bandKey(plan: DayPlan): "excellent" | "good" | "fair" | "poor" | "dontgo" {
  if (plan.veto) return "dontgo";
  return plan.verdict.toLowerCase() as "excellent" | "good" | "fair" | "poor";
}

function bandWord(plan: DayPlan): string {
  return plan.veto ? "Don't go" : plan.verdict;
}

function fmtDay(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ------------------------------------------------------------- data flow

async function ensureData(force = false): Promise<void> {
  if (!state.place) {
    // First-run state (item #17): nothing to load until a location is
    // chosen. No default location, no automatic geolocation prompt.
    $("#status").textContent = "";
    render();
    return;
  }
  const { lat, lon } = currentLatLon();
  const key = `${lat},${lon}`;
  if (state.loading) return;
  if (!force && state.weatherFor === key && state.extrasFor === key) return;
  state.loading = true;
  // #39: no progress text — the status line shows problems only.
  try {
    state.weather = await fetchWeather(lat, lon, {
      cacheEndpoint: CACHE_ENDPOINT,
      force,
    });
    state.weatherFor = key;
  } catch {
    if (state.weatherFor !== key) state.weather = null;
    state.weatherFor = key;
  }

  // Secondary sources, each independent and best-effort.
  const jobs: Promise<void>[] = [];
  jobs.push(
    (async () => {
      const stations = await fetchTideStations(force);
      const nearest = nearestTideStation(stations, lat, lon);
      state.tideStationId = nearest?.id ?? "";
      state.tideStationName = nearest?.name ?? "";
    })(),
  );
  jobs.push(
    (async () => {
      state.usgs = await fetchUsgsReading(lat, lon, force);
    })(),
    (async () => {
      state.habVeto = await fetchHabVeto(lat, lon, force);
    })(),
    (async () => {
      state.normals = await fetchNormals(lat, lon);
    })(),
  );
  await Promise.all(jobs);

  if (state.tideStationId) {
    const from = parseDateKey(startKey());
    const to = new Date(from.getTime() + 31 * 86400_000);
    state.tides = await fetchTides(state.tideStationId, from, to, force);
  } else {
    state.tides = undefined;
  }

  state.extrasFor = key;
  state.loading = false;
  state.plansCache.clear();
  const note = $("#updated-note");
  if (state.weather) {
    const t = new Date(state.weather.fetchedAt);
    note.textContent = state.weather.stale
      ? `Showing the last downloaded copy from ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} — refresh failed (offline?). `
      : "";
    $("#status").textContent = "";
  } else {
    note.textContent = "";
    $("#status").textContent =
      "Forecast unavailable (offline?) — showing typical-day estimates from astronomy and season only.";
  }
  render();
}

function planForKey(key: string): DayPlan {
  const cacheKey = `${key}|${state.targetId}|${state.weatherFor}|${state.extrasFor}`;
  const hit = state.plansCache.get(cacheKey);
  if (hit) return hit;
  const target = currentTarget();
  // Callers (render/print/export) gate on a chosen target first (#24).
  if (!target) throw new Error("planForKey called with no target chosen");
  const { lat, lon } = currentLatLon();
  const date = parseDateKey(key);
  const hours = state.weather?.days.get(key) ?? [];
  const isToday = key === startKey();
  const rut = target.id === "whitetail" ? rutForLocation(lat, lon, date) : undefined;
  const plan = generateDayPlan({
    date,
    lat,
    lon,
    target,
    hours,
    tides: tidesForDay(state.tides, date),
    veto: target.kind === "saltwater" ? state.habVeto : null,
    waterTempF: isToday && target.kind !== "hunting" ? state.usgs?.waterTempF : undefined,
    rutPeak: !!rut,
    typicalMeanF: hours.length ? undefined : state.normals?.get(key.slice(5)),
    tzOffsetSec: state.weather?.utcOffsetSec,
  });
  state.plansCache.set(cacheKey, plan);
  return plan;
}

function exportDayFor(key: string): ExportDay {
  return {
    plan: planForKey(key),
    date: parseDateKey(key),
    targetName: currentTarget()?.name ?? "",
    locationName: locationShortName(),
  };
}

function forecastKeys(): string[] {
  if (!state.weather) return [];
  return [...state.weather.days.keys()].sort();
}

// ------------------------------------------------------------- rendering

function slotAddLinks(day: ExportDay, slotIdx: number): string {
  const slot = day.plan.slots[slotIdx];
  if (!slot) return "";
  return `<span class="slot-add">Add:
    <a href="${googleUrl(day, slot)}" target="_blank" rel="noopener">Google</a> ·
    <a href="${outlookUrl(day, slot)}" target="_blank" rel="noopener">Outlook</a></span>`;
}

// ------------------------------------------------------------- planner (#28)
// C2 Band Hero reskin: rating-color hero (in #plan-side) + slot cards,
// enrichment and day details (in #planner) + area cards (in #plan-cards).
// Presentation only — every figure comes from the same plan data as before.

const PROHIBIT_SVG = `<svg class="hero-prohibit" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="33" fill="none" stroke="#fff" stroke-width="9"/><line x1="27" y1="73" x2="73" y2="27" stroke="#fff" stroke-width="9"/></svg>`;

function heroHtml(plan: DayPlan, key: string, target: TargetDef): string {
  const band = bandKey(plan);
  const stencil = plan.veto ? "" : stencilFor(target.id);
  const pill = plan.veto
    ? `<span class="hero-pill">⦻ ${esc(plan.veto)}</span>`
    : plan.slots.length
      ? `<span class="hero-pill">${plan.slots[0].labelSymbol} Best window ${fmtRange(plan.slots[0].start, plan.slots[0].end)}</span>`
      : `<span class="hero-pill">No window rated Okay or better</span>`;
  return `
  <section class="hero hero-${band}">
    ${plan.veto ? PROHIBIT_SVG : stencil ? `<img class="hero-stencil" data-stencil="${esc(STENCIL_BY_TARGET[target.id] ?? "")}" src="${stencil}" alt="" aria-hidden="true" />` : ""}
    <div class="hero-main">
      <div class="hero-band">${esc(bandWord(plan))}</div>
      <div class="hero-when">${esc(fmtDay(key))} · ${esc(locationShortName())}</div>
      ${pill}
    </div>
    <div class="hero-sun">Sunrise ${fmtTime(plan.astro.sunrise)} · Sunset ${fmtTime(plan.astro.sunset)}</div>
  </section>`;
}

function slotCardHtml(day: ExportDay, plan: DayPlan): string {
  if (!plan.slots.length)
    return `<p class="note">No window reached the Okay level today. Rest of the day: slow.</p>`;
  const cards = plan.slots
    .map(
      (s, i) => `
    <div class="slot2 spine-${s.label.toLowerCase()}">
      <div class="slot2-top">
        <span class="slot2-label lbl-${s.label.toLowerCase()}">${s.labelSymbol} ${s.bestToday ? "Best today" : s.label}</span>
        <span class="slot2-time">${fmtRange(s.start, s.end)}</span>
      </div>
      <div class="slot2-reason">${esc(s.reason)}</div>
      ${slotAddLinks(day, i)}
    </div>`,
    )
    .join("");
  return `<div class="slotgrid">${cards}</div><p class="note">Rest of the day: slow.</p>`;
}

function hourlyHtml(plan: DayPlan): string {
  if (!plan.hourlyScores.length) return "";
  const inSlot = (t: Date) => plan.slots.some((s) => t >= s.start && t < s.end);
  const bars = plan.hourlyScores
    .map((h) => {
      const cls = inSlot(h.time) && h.score >= 75 ? "bar best" : h.score >= 45 ? "bar mid" : "bar";
      return `<div class="${cls}" style="height:${Math.round(14 + (h.score / 100) * 52)}px" title="${fmtTime(h.time)} — score ${h.score}"></div>`;
    })
    .join("");
  return `
  <section class="enrich hourly-sec">
    <h3>Hour by hour</h3>
    <div class="hourly"><div class="bars">${bars}</div>
    <div class="hours"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div></div>
  </section>`;
}

function weekGlanceHtml(): string {
  const start = startKey();
  const cells: string[] = [];
  for (let i = 0; i < 7; i++) {
    const key = addDaysKey(start, i);
    const plan = planForKey(key);
    const date = parseDateKey(key);
    const best = plan.slots.length ? fmtRange(plan.slots[0].start, plan.slots[0].end) : "—";
    cells.push(`
    <button type="button" class="wk-day wk-${bandKey(plan)}" data-offset="${i}">
      <span class="wk-dow">${date.toLocaleDateString(undefined, { weekday: "short" })}</span>
      <span class="wk-num">${date.getDate()}</span>
      <span class="wk-band">${esc(bandWord(plan))}</span>
      <span class="wk-best">${esc(best)}</span>
    </button>`);
  }
  return `
  <section class="enrich week-sec">
    <h3>Week at a glance</h3>
    <div class="week">${cells.join("")}</div>
  </section>`;
}

/** Day-detail items shared by the list (phone) and tiles (wider) layouts. */
function detailItems(plan: DayPlan, key: string, target: TargetDef): { label: string; value: string }[] {
  const hours = state.weather?.days.get(key) ?? [];
  const items: { label: string; value: string }[] = [
    { label: "Sunrise", value: fmtTime(plan.astro.sunrise) },
    { label: "Sunset", value: fmtTime(plan.astro.sunset) },
  ];
  if (hours.length) {
    items.push({
      label: "High / Low",
      value: `${Math.round(Math.max(...hours.map((h) => h.tempF)))}° / ${Math.round(Math.min(...hours.map((h) => h.tempF)))}°`,
    });
    items.push({ label: "Wind", value: `to ${Math.round(Math.max(...hours.map((h) => h.windMph)))} mph` });
    items.push({ label: "Rain chance", value: `to ${Math.round(Math.max(...hours.map((h) => h.precipProb)))}%` });
    const trend = pressureTrendPer6h(hours);
    const inHg = hours[hours.length - 1].pressureHpa * 0.02953;
    const arrow = trend > 0.5 ? "↑ rising" : trend < -0.5 ? "↓ falling" : "→ steady";
    items.push({ label: "Pressure", value: `${inHg.toFixed(2)} inHg ${arrow}` });
    const typical = state.normals?.get(key.slice(5));
    if (typical !== undefined) {
      const mean = hours.reduce((a, h) => a + h.tempF, 0) / hours.length;
      const delta = Math.round(mean - typical);
      items.push({
        label: "Typical for this date",
        value: `${Math.round(typical)}° avg — today ${delta === 0 ? "about typical" : delta > 0 ? `${delta}° warmer` : `${-delta}° cooler`}`,
      });
    }
  }
  if (state.usgs?.waterTempF !== undefined && key === startKey() && target.kind !== "hunting") {
    items.push({ label: "Water temp (USGS)", value: `${Math.round(state.usgs.waterTempF)}°F` });
  }
  const tides = tidesForDay(state.tides, parseDateKey(key));
  if (tides?.events.length) {
    items.push({
      label: "Tides",
      value: tides.events.map((e) => `${e.type} ${fmtTime(e.time)}`).join(" · "),
    });
  }
  items.push({ label: "Moon", value: `${Math.round(plan.astro.moonIllumination * 100)}% lit` });
  return items;
}

function areaCardsHtml(selectedKey: string): string {
  const target = currentTarget();
  if (!target || !state.place) return "";
  const rows: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const key = addDaysKey(startKey(), i);
    const plan = planForKey(key);
    const date = parseDateKey(key);
    rows.push(
      `<div class="uprow"><span class="dotb dot-${bandKey(plan)}"></span><span>${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</span><span class="upband">${esc(bandWord(plan))}</span></div>`,
    );
  }
  const gauge = state.usgs
    ? `<div class="acard-v">${state.usgs.waterTempF !== undefined ? `${Math.round(state.usgs.waterTempF)}°F` : "—"}</div>
       <div class="acard-s">${esc(state.usgs.stationName)}${state.usgs.dischargeCfs !== undefined ? ` · flow ${Math.round(state.usgs.dischargeCfs)} cfs` : ""}${state.usgs.observedAt ? ` · ${esc(state.usgs.observedAt)}` : ""}</div>`
    : `<div class="acard-s">No USGS gauge reporting near this location.</div>`;
  const { lat, lon } = currentLatLon();
  const inFlorida = lat >= 24 && lat <= 31.5 && lon >= -88.5 && lon <= -79.5;
  const tide = state.habVeto
    ? `<div class="acard-s acard-alert">${esc(state.habVeto)}</div>`
    : inFlorida
      ? `<div class="acard-s">No red tide detected near this location in the latest FWC-FWRI samples.</div>`
      : `<div class="acard-s">Red tide monitoring covers Florida coastal waters (FWC-FWRI).</div>`;
  void selectedKey;
  return `
  <div class="area-cards enrich">
    <div class="acard"><h4>Coming up</h4>${rows.join("")}</div>
    <div class="acard"><h4>Nearest gauge</h4>${gauge}</div>
    <div class="acard"><h4>Red tide</h4>${tide}</div>
  </div>`;
}

function jumpToDay(offset: number): void {
  state.dayOffset = offset;
  state.view = "planner";
  document.querySelectorAll("#view-picker .chip").forEach((x) =>
    x.classList.toggle("selected", (x as HTMLElement).dataset.view === "planner"),
  );
  document.querySelectorAll("#day-picker .chip").forEach((x) =>
    x.classList.toggle("selected", parseInt((x as HTMLElement).dataset.offset ?? "-1", 10) === offset),
  );
  render();
}

// ---- no-data skeletons (#33): muted blocks mirroring the real
// regions at their real sizes, so a no-data screen carries the same
// layout as a loaded one. Enrichment skeletons reuse the .enrich
// visibility rule (shown from 52.5em up), like the real sections.
function skHeroHtml(): string {
  return `
  <div class="sk-hero" aria-hidden="true">
    <div class="sk" style="width:55%;height:34px;border-radius:8px"></div>
    <div class="sk sk-line" style="width:70%"></div>
    <div class="sk" style="width:45%;height:26px;border-radius:999px;margin-top:16px"></div>
    <div class="sk sk-line" style="width:52%"></div>
  </div>`;
}

function skAreasHtml(): string {
  const card = (h: number, lines: string[]) =>
    `<div class="acard sk-acard" style="height:${h}px"><div class="sk" style="width:38%;height:12px"></div>${lines.map((w) => `<div class="sk sk-line" style="width:${w}"></div>`).join("")}</div>`;
  return `
  <div class="area-cards enrich" aria-hidden="true">
    ${card(150, ["82%", "82%", "82%"])}
    ${card(92, ["76%", "58%"])}
    ${card(92, ["80%", "52%"])}
  </div>`;
}

function skMainHtml(prompt: string): string {
  const slot = `<div class="sk-slot"><div class="sk" style="width:38%;height:15px"></div><div class="sk sk-line" style="width:82%"></div><div class="sk sk-line" style="width:55%"></div><div class="sk sk-line" style="width:42%"></div></div>`;
  const heights = [45, 45, 80, 85, 50, 52, 62, 66, 88, 82, 55, 84, 86, 52, 58, 60, 70, 75, 68, 55, 72, 74, 58, 64];
  const bars = heights.map((h) => `<i style="height:${h}%"></i>`).join("");
  const day = `<div class="sk-day"><div class="sk" style="width:60%;height:11px"></div><div class="sk" style="width:45%;height:17px;margin-top:8px"></div><div class="sk sk-line" style="width:75%"></div></div>`;
  const tile = (w2: string, span = "") =>
    `<div class="tile sk-tile" ${span}><div class="sk" style="width:55%;height:11px"></div><div class="sk" style="width:${w2};height:15px;margin-top:8px"></div></div>`;
  const listRow = `<div class="det2-row"><div class="sk" style="width:32%;height:13px"></div><div class="sk" style="width:22%;height:13px"></div></div>`;
  return `
  <section class="card empty-state"><p>${prompt}</p></section>
  <div aria-hidden="true">
    <div class="slotgrid" style="margin-top:14px">${slot.repeat(4)}</div>
    <div class="sk" style="width:180px;height:13px;margin-top:14px"></div>
    <section class="enrich">
      <div class="sk" style="width:130px;height:15px;margin:20px 0 8px"></div>
      <div class="sk-strip" style="margin-top:0"><div class="sk-bars" style="margin-top:0">${bars}</div></div>
    </section>
    <section class="enrich">
      <div class="sk" style="width:150px;height:15px;margin:20px 0 8px"></div>
      <div class="week">${day.repeat(7)}</div>
    </section>
    <section class="details-sec">
      <div class="sk" style="width:170px;height:15px;margin:20px 0 8px"></div>
      <div class="det2">${listRow.repeat(5)}</div>
      <div class="dettiles">
        ${tile("70%")}${tile("70%")}${tile("70%")}
        ${tile("70%")}${tile("70%")}${tile("70%")}
        ${tile("88%", 'style="grid-column:span 2"')}${tile("62%")}
      </div>
      <div class="sk" style="width:64%;height:12px;margin-top:14px"></div>
      <div class="sk" style="width:170px;height:34px;border-radius:8px;margin-top:12px"></div>
    </section>
  </div>`;
}

/** #38: the unfilled day panel mirrors the filled one's shape in
 *  skeleton blocks — heading, verdict, two slot cards, detail lines —
 *  and, in the stretched trends layout, fills the chart card's height
 *  until a day is selected. */
function skDayPanelHtml(): string {
  const slot = (top: number) => `
    <div class="sk-slot" style="margin-top:${top}px">
      <div class="sk" style="width:40%;height:14px"></div>
      <div class="sk sk-line" style="width:85%"></div>
      <div class="sk sk-line" style="width:60%"></div>
      <div class="sk sk-line" style="width:45%"></div>
    </div>`;
  return `
    <div class="sk" style="width:55%;height:17px"></div>
    <div class="sk" style="width:100%;height:36px;border-radius:8px;margin-top:14px"></div>
    ${slot(14)}
    ${slot(12)}
    <div class="sk sk-line" style="width:92%"></div>
    <div class="sk sk-line" style="width:96%"></div>
    <div class="sk sk-line" style="width:88%"></div>
    <div class="sk sk-line" style="width:94%"></div>
    <div class="sk sk-line" style="width:70%"></div>
    <div class="sk sk-line" style="width:90%;margin-top:22px"></div>
    <div class="sk sk-line" style="width:82%"></div>
    <div class="sk sk-line" style="width:64%"></div>
    <div class="sk sk-line" style="width:78%;margin-top:22px"></div>
    <div class="sk sk-line" style="width:58%"></div>`;
}

function skTrendsHtml(prompt: string): string {
  const blocks = (n: number) => `<div class="strip">${'<div class="sk-dblock"></div>'.repeat(n)}</div>`;
  return `
  <section class="card empty-state"><p>${prompt}</p></section>
  <div class="trends-layout" aria-hidden="true" style="margin-top:14px">
    <section class="card trends-main">
      <div class="sk" style="width:170px;height:18px"></div>
      <div class="sk" style="width:110px;height:14px;margin:16px 0 8px"></div>
      ${blocks(7)}
      <div class="sk" style="width:120px;height:14px;margin:16px 0 8px"></div>
      ${blocks(30)}
      <div class="sk sk-line" style="width:88%"></div>
      <div class="sk sk-line" style="width:76%"></div>
    </section>
    <aside class="card day-panel">${skDayPanelHtml()}
    </aside>
  </div>`;
}

function renderPlanner(): void {
  const el = $("#planner");
  const side = $("#plan-side");
  const cards = $("#plan-cards");
  if (!state.place) {
    // #33: no-data state = the prompt line over skeleton placeholders.
    side.innerHTML = skHeroHtml();
    cards.innerHTML = skAreasHtml();
    el.innerHTML = skMainHtml("Search above, pick on the map, or use your location.");
    return;
  }
  const target = currentTarget();
  if (!target) {
    // #24: nothing computes until a real target is chosen; #33
    // placeholders fill the layout the same way.
    side.innerHTML = skHeroHtml();
    cards.innerHTML = skAreasHtml();
    el.innerHTML = skMainHtml("Pick a target to see best times.");
    return;
  }
  const key = addDaysKey(startKey(), state.dayOffset);
  const plan = planForKey(key);
  const day: ExportDay = { plan, date: parseDateKey(key), targetName: target.name, locationName: locationShortName() };

  side.innerHTML = heroHtml(plan, key, target);
  cards.innerHTML = areaCardsHtml(key);

  if (plan.veto) {
    el.innerHTML = `
      <section class="card veto">
        <h2>Don't go — ${esc(plan.veto)}</h2>
        <p>${esc(fmtDay(key))} · ${esc(target.name)} · ${esc(locationShortName())}</p>
        <p class="note">Safety and closures outrank every score. Check conditions again before going.</p>
      </section>`;
    return;
  }

  const extras: string[] = [];
  if (state.usgs?.waterTempF !== undefined && key === startKey() && target.kind !== "hunting") {
    extras.push(
      `Water now ${Math.round(state.usgs.waterTempF)}°F at USGS gauge “${esc(state.usgs.stationName)}”` +
        (state.usgs.dischargeCfs !== undefined ? ` · flow ${Math.round(state.usgs.dischargeCfs)} cfs` : "") +
        ` — live gauge data, not an air-temperature estimate.`,
    );
  }
  if (target.id === "whitetail") {
    const { lat, lon } = currentLatLon();
    const rut = rutForLocation(lat, lon, parseDateKey(key));
    if (rut) extras.push(`Peak rut window for ${rut.state} (approximate, from state data).`);
  }
  if (state.tideStationId && target.kind === "saltwater") {
    extras.push(`Tides from NOAA station ${state.tideStationId}${state.tideStationName ? ` (${esc(state.tideStationName)})` : ""}.`);
  }

  const items = detailItems(plan, key, target);
  const listHtml = items
    .map((it) => `<div class="det2-row"><span class="det2-k">${esc(it.label)}</span><span class="det2-v">${esc(it.value)}</span></div>`)
    .join("");
  const tilesHtml = items
    .map((it) => `<div class="tile"><div class="tile-k">${esc(it.label)}</div><div class="tile-v">${esc(it.value)}</div></div>`)
    .join("");

  el.innerHTML = `
    ${slotCardHtml(day, plan)}
    <section class="details-sec">
      <h3>Day details — ${esc(target.name)}</h3>
      <div class="det2">${listHtml}</div>
      <div class="dettiles">${tilesHtml}</div>
      ${plan.heldBackBy ? `<p class="held-back">Day held back by: ${esc(plan.heldBackBy)}.</p>` : ""}
      ${extras.map((x) => `<p class="note">${x}</p>`).join("")}
      <p class="note astro">
        Moonrise ${plan.astro.moonrise ? fmtTime(plan.astro.moonrise) : "—"} · Moonset ${plan.astro.moonset ? fmtTime(plan.astro.moonset) : "—"}
        ${state.weather?.timezone ? `· Times in ${esc(state.weather.timezone.replace("_", " "))}` : ""}
        ${plan.typical ? "· Typical-day estimate (no forecast for this date)" : ""}
      </p>
      <div class="row export-row">
        <button type="button" id="export-day">Export this day (.ics)</button>
      </div>
    </section>`;
  el.querySelectorAll<HTMLElement>(".wk-day").forEach((b) =>
    b.addEventListener("click", () => jumpToDay(parseInt(b.dataset.offset ?? "0", 10))),
  );
  // Enrichment sections are inserted between slots and details.
  const detailsSec = el.querySelector(".details-sec");
  if (detailsSec) {
    const wrap = document.createElement("div");
    wrap.innerHTML = `${hourlyHtml(plan)}${weekGlanceHtml()}`;
    el.insertBefore(wrap, detailsSec);
    wrap.querySelectorAll<HTMLElement>(".wk-day").forEach((b) =>
      b.addEventListener("click", () => jumpToDay(parseInt(b.dataset.offset ?? "0", 10))),
    );
  }
  const exportBtn = $("#export-day");
  if (exportBtn)
    exportBtn.addEventListener("click", () => {
      downloadIcs([day], {
        includeTypical: state.settings.includeTypical,
        includeDontGo: state.settings.includeDontGo,
      });
    });
}

function daySummary(key: string): { band: string; best: string; hi: number; lo: number; wind: number; rain: number } {
  const plan = planForKey(key);
  const hours = state.weather?.days.get(key) ?? [];
  const band = plan.veto ? "Don't go" : dayBand(plan.dayScore);
  const best = plan.slots.length
    ? `${fmtTime(plan.slots[0].start)} – ${fmtTime(plan.slots[0].end)}`
    : "no window";
  return {
    band,
    best,
    hi: hours.length ? Math.round(Math.max(...hours.map((h) => h.tempF))) : 0,
    lo: hours.length ? Math.round(Math.min(...hours.map((h) => h.tempF))) : 0,
    wind: hours.length ? Math.round(Math.max(...hours.map((h) => h.windMph))) : 0,
    rain: hours.length ? Math.round(Math.max(...hours.map((h) => h.precipProb))) : 0,
  };
}

function renderTrends(): void {
  const el = $("#trends");
  if (!state.place) {
    el.innerHTML = skTrendsHtml("Trends appear once a location is chosen above.");
    return;
  }
  const target = currentTarget();
  if (!target) {
    // #24: Trends is gated the same way as the planner.
    el.innerHTML = skTrendsHtml("Pick a target to see best times.");
    return;
  }
  const start = startKey();
  const blocks: string[] = [];
  const weekPlans: { key: string; plan: DayPlan }[] = [];
  for (const [label, days] of [["Week", 7], ["Month", 30]] as const) {
    const cells: string[] = [];
    for (let i = 0; i < days; i++) {
      const key = addDaysKey(start, i);
      const plan = planForKey(key);
      if (label === "Week") weekPlans.push({ key, plan });
      const band = plan.veto ? "Veto" : dayBand(plan.dayScore);
      const kind = plan.typical ? "typical" : "forecast";
      const date = parseDateKey(key);
      cells.push(
        `<div class="day-block band-${band.toLowerCase()} ${kind}" data-key="${key}" tabindex="0" role="button" aria-label="${key} detail">
           <span class="db-dow">${"SMTWTFS"[date.getDay()]}</span>
           <span class="db-num">${date.getDate()}</span>
           <span class="db-band">${esc(band === "Veto" ? "Don't go" : band)}</span>
         </div>`,
      );
    }
    blocks.push(`<h3>${label} — ${esc(target.name)}</h3><div class="strip">${cells.join("")}</div>`);
  }
  const best = [...weekPlans]
    .filter((p) => !p.plan.veto)
    .sort((a, b) => b.plan.dayScore - a.plan.dayScore)
    .slice(0, 3);
  const chips = best.length
    ? `<p class="best-days">Best days this week: ${best
        .map((p) => `<span class="best-chip">${parseDateKey(p.key).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</span>`)
        .join(" ")}</p>`
    : "";
  el.innerHTML = `
    <div class="trends-layout">
    <section class="card trends-main">
      <h2>Viability trends</h2>
      ${blocks.join("")}
      ${chips}
      <p class="note legend">Day bands, from the day's best hour: <strong>Excellent</strong> 78+ ·
      <strong>Good</strong> 62+ · <strong>Fair</strong> 48+ · <strong>Poor</strong> under 48 ·
      <strong>Don't go</strong> = a veto (dangerous weather or a closure) outranks the score.</p>
      <p class="note">Solid blocks are forecast days (Open-Meteo, up to 16 days out).
      Paler blocks are <strong>typical for this date</strong> — scored from astronomy and
      season${state.normals ? " plus climate normals" : ""}, not a forecast.
      Hover a day for a summary; click it for full detail.</p>
      <div class="row export-row">
        <button type="button" id="export-all">Export forecast days (.ics)</button>
      </div>
    </section>
    <aside id="day-panel" class="card day-panel">${skDayPanelHtml()}
    </aside>
    </div>`;

  $("#export-all").addEventListener("click", () => {
    const days = forecastKeys().map((k) => exportDayFor(k));
    downloadIcs(days, {
      includeTypical: state.settings.includeTypical,
      includeDontGo: state.settings.includeDontGo,
    });
  });

  const tooltip = $("#tooltip");
  el.querySelectorAll<HTMLElement>(".day-block").forEach((cell) => {
    const key = cell.dataset.key!;
    cell.addEventListener("mouseenter", () => {
      const s = daySummary(key);
      const plan = planForKey(key);
      tooltip.innerHTML =
        `<strong>${esc(fmtDay(key))} — ${s.band}</strong><br>` +
        (plan.veto
          ? esc(plan.veto)
          : `Best window: ${s.best}<br>High ${s.hi}° · Low ${s.lo}° · Wind to ${s.wind} mph · Rain chance ${s.rain}%`) +
        (plan.typical ? `<br><em>Typical day (estimate)</em>` : "");
      const r = cell.getBoundingClientRect();
      tooltip.style.left = `${Math.min(r.left, window.innerWidth - 250)}px`;
      tooltip.style.top = `${r.bottom + window.scrollY + 6}px`;
      tooltip.hidden = false;
    });
    cell.addEventListener("mouseleave", () => (tooltip.hidden = true));
    cell.addEventListener("click", () => {
      tooltip.hidden = true;
      openDayDetail(key);
    });
  });
}

/** #39: Print stays disabled until a location and a target are both
 *  chosen; re-evaluated on every render (place/target/view changes). */
function syncPrintBtn(): void {
  const btn = $<HTMLButtonElement>("#print-btn");
  if (btn) btn.disabled = !(state.place && currentTarget());
}

function render(): void {
  syncPrintBtn();
  const planner = state.view === "planner";
  $("#planner").hidden = !planner;
  $("#plan-side").hidden = !planner;
  $("#plan-cards").hidden = !planner;
  $("#trends").hidden = planner;
  if (planner) renderPlanner();
  else renderTrends();
}

// ------------------------------------------------------------- day modal

/** Full day detail markup — shared by the modal (narrow widths) and the
 *  Trends side panel (desktop widths, #28). */
function dayDetailHtml(key: string): string {
  const plan = planForKey(key);
  const target = currentTarget();
  if (!target) return "";
  const day: ExportDay = { plan, date: parseDateKey(key), targetName: target.name, locationName: locationShortName() };
  const hours = state.weather?.days.get(key) ?? [];
  const tides = tidesForDay(state.tides, parseDateKey(key));
  const tideHtml = tides?.events.length
    ? `<p class="note">Tides: ${tides.events
        .map((e) => `${e.type} ${fmtTime(e.time)} (${e.heightFt.toFixed(1)} ft)`)
        .join(" · ")}</p>`
    : "";
  const slotsHtml = plan.veto
    ? `<p class="held-back">Don't go — ${esc(plan.veto)}</p>`
    : plan.slots.length
      ? `<div class="slotgrid">${plan.slots
          .map(
            (s, i) => `
          <div class="slot2 spine-${s.label.toLowerCase()}">
            <div class="slot2-top">
              <span class="slot2-label lbl-${s.label.toLowerCase()}">${s.labelSymbol} ${s.bestToday ? "Best today" : s.label}</span>
              <span class="slot2-time">${fmtRange(s.start, s.end)}</span>
            </div>
            <div class="slot2-reason">${esc(s.reason)}</div>
            ${slotAddLinks(day, i)}
          </div>`,
          )
          .join("")}</div>`
      : `<p class="note">No window reached the Okay level this day.</p>`;
  return `
    <div class="verdict verdict-${bandKey(plan)}">Day: ${bandWord(plan).toUpperCase()}</div>
    ${slotsHtml}
    ${plan.heldBackBy && !plan.veto ? `<p class="held-back">Day held back by: ${esc(plan.heldBackBy)}.</p>` : ""}
    ${
      hours.length
        ? `<p class="note">Weather: high ${Math.round(Math.max(...hours.map((h) => h.tempF)))}°F ·
           low ${Math.round(Math.min(...hours.map((h) => h.tempF)))}°F ·
           wind to ${Math.round(Math.max(...hours.map((h) => h.windMph)))} mph ·
           rain chance to ${Math.round(Math.max(...hours.map((h) => h.precipProb)))}%</p>`
        : `<p class="note">Typical-day estimate — no forecast exists for this date yet.</p>`
    }
    <p class="note">Sunrise ${fmtTime(plan.astro.sunrise)} · Sunset ${fmtTime(plan.astro.sunset)} ·
    Moonrise ${plan.astro.moonrise ? fmtTime(plan.astro.moonrise) : "—"} · Moonset ${plan.astro.moonset ? fmtTime(plan.astro.moonset) : "—"} ·
    Moon ${Math.round(plan.astro.moonIllumination * 100)}% lit · Solunar major ${fmtTime(plan.solunarMajor.start)} – ${fmtTime(plan.solunarMajor.end)} (annotation only)</p>
    ${tideHtml}
    <div class="row modal-actions">
      <button type="button" class="plan-this-day">Plan this day</button>
      <button type="button" class="export-this-day">Export this day (.ics)</button>
    </div>`;
}

function wireDayDetail(root: HTMLElement, key: string): void {
  const planBtn = root.querySelector<HTMLElement>(".plan-this-day");
  if (planBtn)
    planBtn.addEventListener("click", () => {
      $("#day-modal").hidden = true;
      const offset = Math.round(
        (parseDateKey(key).getTime() - parseDateKey(startKey()).getTime()) / 86400_000,
      );
      jumpToDay(offset);
    });
  const expBtn = root.querySelector<HTMLElement>(".export-this-day");
  if (expBtn)
    expBtn.addEventListener("click", () => {
      downloadIcs([exportDayFor(key)], {
        includeTypical: state.settings.includeTypical,
        includeDontGo: state.settings.includeDontGo,
      });
    });
}

/** #28: at desktop widths the Trends day detail opens in a side panel;
 *  below that it stays a modal. */
function openDayDetail(key: string): void {
  const target = currentTarget();
  if (!target) return;
  if (window.matchMedia("(min-width: 75em)").matches) {
    const panel = $("#day-panel");
    if (panel) {
      panel.innerHTML = `<h3>${esc(fmtDay(key))} — ${esc(target.name)}</h3>${dayDetailHtml(key)}`;
      wireDayDetail(panel, key);
      panel.scrollIntoView({ block: "nearest" });
      return;
    }
  }
  $("#day-modal-title").textContent = `${fmtDay(key)} — ${target.name}`;
  const content = $("#day-modal-content");
  content.innerHTML = dayDetailHtml(key);
  wireDayDetail(content, key);
  $("#day-modal").hidden = false;
}

// ------------------------------------------------------------- explainer

const INFO_HTML = `
  <h3>Day ratings</h3>
  <p>Every hour is scored 0–100. The day's band comes from its <strong>best hour</strong>:</p>
  <p><span class="band-chip band-excellent">Excellent</span> 78+ &nbsp;
     <span class="band-chip band-good">Good</span> 62+ &nbsp;
     <span class="band-chip band-fair">Fair</span> 48+ &nbsp;
     <span class="band-chip band-poor">Poor</span> under 48</p>
  <p>Slots are the day's best windows: <strong>★ Best</strong> 75+, <strong>✓ Good</strong> 60+,
  <strong>· Okay</strong> 45+. At most four are shown. On a weak day the single best window may be
  labelled “Best today” next to a Fair or Poor verdict — it is the best of a poor day, not a good one.</p>
  <p><strong>Don't go</strong> means a veto outranked the score: dangerous wind, or a live red-tide /
  closure feed. <strong>Typical days</strong> (paler, beyond the forecast) are scored from astronomy,
  season and climate normals — an estimate of a normal day, not a prediction.</p>
  <h3>What moves the score</h3>
  <table class="factors">
    <tr><td>Season &amp; temperature</td><td class="dots">●●●○</td><td>Peak season and water in the target's prime band carry the day (0–50 base).</td></tr>
    <tr><td>Light — dawn &amp; dusk</td><td class="dots">●●●○</td><td>The main daily activity windows for most targets.</td></tr>
    <tr><td>Moving water (saltwater)</td><td class="dots">●●●○</td><td>Tide current from the nearest NOAA station; combined with low light it scores most.</td></tr>
    <tr><td>Wind &amp; rain</td><td class="dots">●●○○</td><td>Modifiers — they trim windows, and dangerous wind vetoes the day.</td></tr>
    <tr><td>Pressure trend</td><td class="dots">●○○○</td><td>Capped at ±2 on purpose — the famous pressure bands are anecdote, not evidence.</td></tr>
    <tr><td>Moon &amp; solunar</td><td class="dots">ZERO</td><td>+0 for deer and freshwater (GPS-collar and catch studies found ~no effect). In saltwater, at most +3 as a tie-breaker, and +0 when the tide already scored the slot.</td></tr>
    <tr><td>Solar activity</td><td class="dots">ZERO</td><td>Not an input at all.</td></tr>
    <tr><td>Red tide / closures</td><td class="dots">VETO</td><td>Overrides everything — the day is capped and slots are replaced.</td></tr>
  </table>
  <p class="note">Water temperature comes from a nearby USGS gauge when one is reporting;
  otherwise fish bands use air temperature as a labelled proxy. Rut windows for deer come from
  state-published peak-breeding data (AL/FL/GA/MS/TX) and are approximate — Tennessee publishes
  none, so none is shown there.</p>`;

// ------------------------------------------- unified location (#17)
// One search box: typed coordinates, ZIP, or place name; the crosshair
// (device geolocation, #19) and the folded-map icon (below) all feed
// the same applyPlace(). The selected place persists on-device only.

function setSearchStatus(msg: string): void {
  $("#search-status").textContent = msg;
}

/** #22: the clear (×) control is visible only while the field has text.
 *  It is visibility-toggled (never display:none) so the search-box layout
 *  never shifts, and it leaves tab order while hidden. */
function syncClearBtn(): void {
  const btn = $("#clear-btn");
  const input = $<HTMLInputElement>("#place-search");
  const show = input.value.length > 0;
  btn.classList.toggle("show", show);
  btn.tabIndex = show ? 0 : -1;
  btn.setAttribute("aria-hidden", String(!show));
}

function applyPlace(p: Place): void {
  const place: Place = {
    lat: Math.round(p.lat * 10000) / 10000,
    lon: Math.round(p.lon * 10000) / 10000,
    label: p.label.slice(0, 120),
  };
  state.place = place;
  saveLastPlace(place);
  $<HTMLInputElement>("#place-search").value = place.label;
  syncClearBtn();
  setSearchStatus(`${place.label} — ${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`);
  hidePickList();
  closeMapAll();
  state.weatherFor = "";
  state.extrasFor = "";
  rebuildTargets();
  void ensureData();
}

function hidePickList(): void {
  const list = $("#pick-list");
  list.hidden = true;
  list.replaceChildren();
}

function showPickList(candidates: PlaceCandidate[]): void {
  const list = $("#pick-list");
  list.replaceChildren();
  for (const c of candidates) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    const name = document.createElement("span");
    name.className = "pick-name";
    name.textContent = c.label;
    const detail = document.createElement("span");
    detail.className = "pick-detail";
    detail.textContent = c.detail || `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`;
    btn.append(name, detail);
    btn.addEventListener("click", () => applyPlace(c));
    li.append(btn);
    list.append(li);
  }
  list.hidden = false;
  setSearchStatus("More than one match — pick the right one:");
}

/** Detection order (decided 2026-11-12): coordinates, then ZIP, then
 *  place name. All input is validated before use (input-security rule). */
async function resolveSearch(): Promise<void> {
  const input = $<HTMLInputElement>("#place-search");
  const q = input.value.trim();
  hidePickList();
  if (!q) {
    setSearchStatus("Type a place name, ZIP code, or coordinates, then press Enter.");
    return;
  }
  if (q.length > 80) {
    setSearchStatus("That search is too long — 80 characters at most.");
    return;
  }
  const coord = q.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (coord) {
    const lat = parseFloat(coord[1]);
    const lon = parseFloat(coord[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      applyPlace({ lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` });
    } else {
      setSearchStatus("Coordinates out of range: latitude −90 to 90, longitude −180 to 180.");
    }
    return;
  }
  if (/^\d{5}$/.test(q)) {
    setSearchStatus("Looking up ZIP…");
    const found = await lookupZip(q);
    if (found) applyPlace(found);
    else setSearchStatus(`No match found for ZIP ${q}.`);
    return;
  }
  if (!/^[\p{L}\p{N} ,.'#°-]+$/u.test(q)) {
    setSearchStatus("Place names can use letters, numbers, spaces, and , . ' - only.");
    return;
  }
  setSearchStatus("Searching…");
  const results = await geocodePlace(q);
  if (results === null) {
    setSearchStatus(
      "Place search is unavailable right now — try a ZIP code, coordinates, or the map.",
    );
    return;
  }
  if (!results.length) {
    setSearchStatus(`No match found for “${q}”.`);
    return;
  }
  if (results.length === 1) {
    applyPlace(results[0]);
    return;
  }
  showPickList(results);
}

/** Device geolocation (item #19): errors are reported by their real
 *  cause, and the lookup options suit Wi-Fi-only devices like Fire
 *  tablets (no high-accuracy demand, generous timeout, cached fix OK). */
function locateMe(): void {
  hidePickList();
  if (!("geolocation" in navigator)) {
    setSearchStatus(
      "This device does not offer geolocation — use a place name, ZIP code, coordinates, or the map.",
    );
    return;
  }
  setSearchStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const near = await reverseLabel(lat, lon);
      applyPlace({
        lat,
        lon,
        label: near ?? `Near me (±${Math.round(pos.coords.accuracy)} m)`,
      });
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        setSearchStatus(
          "Location permission was not granted. Allow location for this site in your browser settings — or use a place name, ZIP code, coordinates, or the map.",
        );
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        setSearchStatus(
          "This device couldn't determine a location. On Fire tablets, location comes from Wi-Fi — check that Location is ON in the device settings and Wi-Fi is connected. Or use a place name, ZIP code, coordinates, or the map.",
        );
      } else {
        setSearchStatus(
          "Locating timed out. Check the Wi-Fi connection and try again — or use a place name, ZIP code, coordinates, or the map.",
        );
      }
    },
    { enableHighAccuracy: false, timeout: 20000, maximumAge: 300000 },
  );
}

// ------------------------------------------------------------- map (#17)
// Inline Leaflet panel under the search box, expandable to a large
// modal. One map element moves between the two homes. The pin is a
// WORKING selection: nothing applies until "Use this spot" (decided
// 2026-11-12). In the modal, Esc/✕ cancel everything; the collapse
// control returns to the inline panel with the pin kept.

let leafletMap: L.Map | null = null;
let leafletMarker: L.Marker | null = null;
let expandBtn: HTMLButtonElement | null = null;
let pendingPin: { lat: number; lon: number } | null = null;
let pendingLabel = "";
let mapIsOpen = false;
let mapIsExpanded = false;

function pinIcon(): L.DivIcon {
  return L.divIcon({ className: "map-pin", html: "<span></span>", iconSize: [18, 18], iconAnchor: [9, 9] });
}

function updateReadouts(): void {
  const text = pendingPin
    ? `${pendingLabel ? `Near ${pendingLabel} — ` : ""}${pendingPin.lat.toFixed(4)}, ${pendingPin.lon.toFixed(4)}`
    : "Tap the map to drop the pin.";
  $("#map-readout").textContent = text;
  $("#map-readout-modal").textContent = text;
}

function setPending(lat: number, lon: number): void {
  pendingPin = {
    lat: Math.round(lat * 10000) / 10000,
    lon: Math.round(lon * 10000) / 10000,
  };
  pendingLabel = "";
  if (!leafletMarker && leafletMap) {
    leafletMarker = L.marker([lat, lon], { draggable: true, icon: pinIcon() }).addTo(leafletMap);
    leafletMarker.on("dragend", () => {
      const p = leafletMarker!.getLatLng();
      setPending(p.lat, p.lng);
    });
  } else if (leafletMarker) {
    leafletMarker.setLatLng([lat, lon]);
  }
  updateReadouts();
  void (async () => {
    const label = await reverseLabel(lat, lon);
    // Only apply if the pin hasn't moved since this lookup started.
    if (label && pendingPin && Math.abs(pendingPin.lat - lat) < 0.001 && Math.abs(pendingPin.lon - lon) < 0.001) {
      pendingLabel = label;
      updateReadouts();
    }
  })();
}

function initMap(): void {
  const el = $("#map");
  const hasPlace = !!state.place;
  const c = currentLatLon();
  leafletMap = L.map("map").setView([c.lat, c.lon], hasPlace ? 10 : 4);
  // #37: three base layers behind the Layers switcher (top-left,
  // under the zoom buttons). The saved choice is restored (validated
  // in config) and re-saved whenever the user switches.
  const baseLayers: Record<BaseMapId, L.TileLayer> = {
    map: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 18,
    }),
    satellite: L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Esri, Maxar, Earthstar Geographics",
        maxZoom: 18,
      },
    ),
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution: "Map data: © OpenStreetMap contributors, SRTM | map style: © OpenTopoMap (CC-BY-SA)",
      maxZoom: 15,
    }),
  };
  const baseLabels: Record<BaseMapId, string> = { map: "Map", satellite: "Satellite", topo: "Topo" };
  baseLayers[loadBaseMapId()].addTo(leafletMap);
  L.control
    .layers(
      { Map: baseLayers.map, Satellite: baseLayers.satellite, Topo: baseLayers.topo },
      undefined,
      { position: "topleft" },
    )
    .addTo(leafletMap);
  leafletMap.on("baselayerchange", (e: L.LayersControlEvent) => {
    const id = (Object.keys(baseLabels) as BaseMapId[]).find((k) => baseLabels[k] === e.name);
    if (id) saveBaseMapId(id);
  });
  // #37: scale bar — imperial only, bottom-left (both map views: the
  // same #map element moves between the inline panel and the modal).
  L.control.scale({ imperial: true, metric: false, position: "bottomleft" }).addTo(leafletMap);
  const ExpandControl = L.Control.extend({
    onAdd: () => {
      const btn = L.DomUtil.create("button", "map-expand-btn") as HTMLButtonElement;
      btn.type = "button";
      btn.textContent = "⤢";
      btn.title = "Expand map";
      btn.setAttribute("aria-label", "Expand map");
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, "click", () => toggleMapExpand());
      expandBtn = btn;
      return btn;
    },
  });
  leafletMap.addControl(new ExpandControl({ position: "topright" }));
  leafletMap.on("click", (e: L.LeafletMouseEvent) => setPending(e.latlng.lat, e.latlng.lng));
  if (hasPlace) setPending(c.lat, c.lon);
  else updateReadouts();
  setTimeout(() => leafletMap?.invalidateSize(), 50);
}

function openMap(): void {
  mapIsOpen = true;
  $("#map-panel").hidden = false;
  if (!leafletMap) {
    initMap();
  } else {
    // Re-centre on the current place with a fresh working pin.
    const c = currentLatLon();
    if (state.place) {
      leafletMap.setView([c.lat, c.lon], Math.max(leafletMap.getZoom(), 10));
      setPending(c.lat, c.lon);
    }
    setTimeout(() => leafletMap?.invalidateSize(), 50);
  }
}

function closeMapAll(): void {
  if (mapIsExpanded) collapseMap();
  mapIsOpen = false;
  pendingPin = null;
  pendingLabel = "";
  $("#map-panel").hidden = true;
}

function expandMap(): void {
  const el = $("#map");
  $("#map-modal-slot").append(el);
  $("#map-modal").hidden = false;
  mapIsExpanded = true;
  if (expandBtn) {
    expandBtn.textContent = "⤡";
    expandBtn.title = "Collapse map";
    expandBtn.setAttribute("aria-label", "Collapse map");
  }
  setTimeout(() => leafletMap?.invalidateSize(), 60);
}

function collapseMap(): void {
  const el = $("#map");
  const panel = $("#map-panel");
  panel.insertBefore(el, panel.firstChild);
  $("#map-modal").hidden = true;
  mapIsExpanded = false;
  if (expandBtn) {
    expandBtn.textContent = "⤢";
    expandBtn.title = "Expand map";
    expandBtn.setAttribute("aria-label", "Expand map");
  }
  setTimeout(() => leafletMap?.invalidateSize(), 60);
}

function toggleMapExpand(): void {
  if (mapIsExpanded) collapseMap();
  else expandMap();
}

function confirmMap(): void {
  if (!pendingPin) {
    setSearchStatus("Tap the map to drop the pin first.");
    return;
  }
  applyPlace({
    lat: pendingPin.lat,
    lon: pendingPin.lon,
    label:
      pendingLabel ||
      `${pendingPin.lat.toFixed(4)}, ${pendingPin.lon.toFixed(4)}`,
  });
}

// ------------------------------------------------------------- themes (#25)

const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedTheme(): "light" | "dark" {
  const pref = state.settings.theme;
  return pref === "device" ? (themeMedia.matches ? "dark" : "light") : pref;
}

function applyTheme(): void {
  document.documentElement.dataset.theme = resolvedTheme();
}

// Follow device tracks the OS live, including mid-session flips.
themeMedia.addEventListener("change", () => {
  if (state.settings.theme === "device") applyTheme();
});

// ------------------------------------------------------------- print (#26)
// Sheets render into #print-root from the same plan data as the screen.
// Day = proof 31; Week = summary page, then details with the sheet header
// repeated (38 + 40); Month = compact details only, no summary (37).

type PrintMode = "day" | "week" | "month";

const PRINT_FOOTER =
  "Zero Light provides planning guidance only. Ratings estimate fish and game activity — " +
  "they do not guarantee activity, success, or safe conditions. Always confirm seasons, " +
  "limits, licensing, closures, and local conditions with official sources before hunting or fishing.";

function printHeaderHtml(viewLabel: string, rangeLabel: string): string {
  const now = new Date();
  const printed =
    `Printed ${now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}` +
    ` · ${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  const target = currentTarget();
  return `
  <div class="phead"><span class="plogo"><img src="${lockupLightUrl}" alt="Zero Light" /></span><span class="pprinted">${esc(printed)}</span></div>
  <p class="pmeta"><strong>${esc(locationShortName())}</strong> · Target: <strong>${esc(target?.name ?? "")}</strong></p>
  <p class="pmeta">${esc(viewLabel)} — ${esc(rangeLabel)}</p>`;
}

function printSlotLine(s: DayPlan["slots"][number], compact = false): string {
  const range = compact ? fmtRange(s.start, s.end) : `${fmtTime(s.start)} – ${fmtTime(s.end)}`;
  const head = s.bestToday ? `· Best today — ${range}` : `${s.labelSymbol} ${s.label} — ${range}`;
  return `<div class="pslot"><strong>${esc(head)}</strong><div class="preason">${esc(s.reason)}</div></div>`;
}

function printDayFigs(key: string): { hi: string; lo: string; wind: string; rain: string } {
  const hours = state.weather?.days.get(key) ?? [];
  if (!hours.length) return { hi: "—", lo: "—", wind: "—", rain: "—" };
  return {
    hi: `${Math.round(Math.max(...hours.map((h) => h.tempF)))}°`,
    lo: `${Math.round(Math.min(...hours.map((h) => h.tempF)))}°`,
    wind: `to ${Math.round(Math.max(...hours.map((h) => h.windMph)))} mph`,
    rain: `${Math.round(Math.max(...hours.map((h) => h.precipProb)))}%`,
  };
}

function printDayBlock(key: string, compact: boolean): string {
  const plan = planForKey(key);
  const figs = printDayFigs(key);
  const band = bandWord(plan);
  const figsLine = `High ${figs.hi} · Low ${figs.lo} · Wind ${figs.wind} · Rain chance ${figs.rain}`;
  if (compact) {
    return `
    <div class="pcblock">
      <div class="pstatus pband-${bandKey(plan)}"><strong>${esc(fmtDay(key))} — ${esc(band)}</strong> · ${figsLine}${plan.typical ? " (typical-day estimate)" : ""}</div>
      ${plan.veto ? `<div class="pveto">Don't go — ${esc(plan.veto)}</div>` : ""}
      ${!plan.veto && plan.slots.length ? plan.slots.map((s) => printSlotLine(s, true)).join("") : ""}
      ${!plan.veto && !plan.slots.length ? `<div class="pnone">No window rated Okay or better.</div>` : ""}
    </div>`;
  }
  const best = plan.slots.length ? fmtRange(plan.slots[0].start, plan.slots[0].end) : "—";
  return `
  <div class="pdayblock">
    <h3 class="pstatus pband-${bandKey(plan)}">${esc(fmtDay(key))} — ${esc(band)}</h3>
    <div class="pdataline">Best window ${esc(best)} · ${figsLine}${plan.typical ? " · Typical-day estimate" : ""}</div>
    ${plan.veto ? `<div class="pveto">Don't go — ${esc(plan.veto)}</div>` : ""}
    ${!plan.veto && plan.slots.length ? plan.slots.map((s) => printSlotLine(s)).join("") : ""}
    ${!plan.veto && !plan.slots.length ? `<div class="pnone">No window rated Okay or better.</div>` : ""}
  </div>`;
}

function renderPrint(mode: PrintMode): void {
  const target = currentTarget();
  if (!state.place || !target) return;
  const root = $("#print-root");
  const start = startKey();
  let body = "";
  if (mode === "day") {
    const key = addDaysKey(start, state.dayOffset);
    const plan = planForKey(key);
    const hours = state.weather?.days.get(key) ?? [];
    const rows: [string, string][] = [
      ["Sunrise / Sunset", `${fmtTime(plan.astro.sunrise)} / ${fmtTime(plan.astro.sunset)}`],
    ];
    if (hours.length) {
      const figs = printDayFigs(key);
      rows.push(["High / Low", `${figs.hi} / ${figs.lo}`]);
      rows.push(["Wind", figs.wind]);
      rows.push(["Rain chance", figs.rain]);
      const trend = pressureTrendPer6h(hours);
      const inHg = (hours[hours.length - 1].pressureHpa * 0.02953).toFixed(2);
      const word =
        trend <= -1.5 ? "falling" : trend < -0.3 ? "falling slowly" : trend <= 0.3 ? "steady" : trend <= 1.5 ? "rising slowly" : "rising";
      rows.push(["Pressure", `${inHg} inHg (${word})`]);
    }
    if (state.usgs?.waterTempF !== undefined && key === start && target.kind !== "hunting") {
      rows.push([
        "Water temperature",
        `${Math.round(state.usgs.waterTempF)}°F — USGS gauge “${state.usgs.stationName}”`,
      ]);
    }
    const tides = tidesForDay(state.tides, parseDateKey(key));
    if (tides?.events.length) {
      rows.push([
        "Tides",
        tides.events.map((e) => `${e.type} ${fmtTime(e.time)} (${e.heightFt.toFixed(1)} ft)`).join("; ") +
          (state.tideStationName ? ` — NOAA station ${state.tideStationId} (${state.tideStationName})` : ""),
      ]);
    }
    body = `
    ${printHeaderHtml("Day view", fmtDay(key))}
    <h2>Day rating: ${esc(bandWord(plan))}</h2>
    ${plan.veto ? `<p class="pveto">Don't go — ${esc(plan.veto)}</p>` : ""}
    ${plan.typical ? `<p class="pnote">Typical-day estimate — no forecast exists for this date yet.</p>` : ""}
    <table class="pkv">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
    <h2>Best windows</h2>
    ${plan.slots.length ? plan.slots.map((s) => printSlotLine(s)).join("") : `<p>No window rated Okay or better.</p>`}`;
  } else if (mode === "week") {
    const keys = Array.from({ length: 7 }, (_, i) => addDaysKey(start, i));
    const range = `${fmtDay(keys[0])} – ${fmtDay(keys[6])}`;
    const sumRows = keys
      .map((key) => {
        const plan = planForKey(key);
        const figs = printDayFigs(key);
        const best = plan.slots.length ? fmtRange(plan.slots[0].start, plan.slots[0].end) : "—";
        return `<tr><td>${esc(fmtDay(key))}</td><td>${esc(bandWord(plan))}</td><td>${esc(best)}</td><td>${figs.hi} / ${figs.lo}</td></tr>`;
      })
      .join("");
    body = `
    ${printHeaderHtml("Week view", range)}
    <table class="psum"><thead><tr><th>Date</th><th>Rating</th><th>Best window</th><th>High / Low</th></tr></thead><tbody>${sumRows}</tbody></table>
    <div class="pbreak"></div>
    ${printHeaderHtml("Week view", range)}
    <h2>Day details</h2>
    ${keys.map((k) => printDayBlock(k, false)).join("")}`;
  } else {
    const keys = Array.from({ length: 30 }, (_, i) => addDaysKey(start, i));
    const range = `${fmtDay(keys[0])} – ${fmtDay(keys[29])}`;
    body = `
    ${printHeaderHtml("Month view", range)}
    ${keys.map((k) => printDayBlock(k, true)).join("")}`;
  }
  root.innerHTML = `${body}<p class="pfooter">${esc(PRINT_FOOTER)}</p>`;
}

function doPrint(mode: PrintMode): void {
  // #39: no guidance message — the Print button is disabled in this
  // state, and the browser-print path simply does nothing.
  if (!state.place || !currentTarget()) return;
  renderPrint(mode);
  window.print();
}

// Browser print (Ctrl+P) without the button: default to the current view.
window.addEventListener("beforeprint", () => {
  if (state.place && currentTarget() && !$("#print-root").innerHTML) {
    renderPrint(state.view === "trends" ? "week" : "day");
  }
});

// ------------------------------------------------------------- wiring

function rebuildTargets(): void {
  // Any searched place can host any target kind (the v0.2.0 preset
  // kind restrictions went away with the presets, item #17).
  // #24: a disabled "Choose a target…" placeholder leads the list; an
  // unset or no-longer-valid id falls back to it (never to TARGETS[0]).
  const sel = $<HTMLSelectElement>("#target");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a target…";
  placeholder.disabled = true;
  sel.replaceChildren(placeholder);
  for (const t of TARGETS) {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.name;
    sel.append(o);
  }
  if (state.targetId && !TARGETS.some((t) => t.id === state.targetId)) state.targetId = null;
  sel.value = state.targetId ?? "";
}

function openModal(id: string): void {
  $(`#${id}`).hidden = false;
}

// ------------------------------------------------- About (item #18)
// Disclaimer wording settled with Wade on 2026-11-12 (Option B + the
// Option C safety sentence) — verbatim, do not paraphrase.
const DISCLAIMER =
  "Zero Light provides planning guidance only. Its ratings and forecasts are generated from " +
  "third-party data that may be incomplete, delayed, or wrong, and conditions in the field or " +
  "on the water can change quickly. Ratings estimate fish and game activity only — they do " +
  "not guarantee activity, success, or safe conditions. Always confirm seasons, bag and " +
  "creel limits, licensing, closures, and local conditions with official sources — your " +
  "state fish and wildlife agency, NOAA, and local authorities — before hunting or fishing. " +
  "You are responsible for complying with all applicable laws and regulations, and for your " +
  "own safety.";

function aboutHtml(version: string): string {
  const link = (href: string, name: string, what: string) =>
    `<li><a href="${href}" target="_blank" rel="noopener">${name}</a> — ${what}</li>`;
  return `
  <img class="about-lockup about-lockup-light" src="${lockupLightUrl}" alt="Zero Light" />
  <img class="about-lockup about-lockup-dark" src="${lockupDarkUrl}" alt="Zero Light" />
  <p><strong>Zero Light</strong> — best times to hunt and fish for a location.</p>
  <p class="note">${esc(version)} · © Wade Feltman — All Rights Reserved.</p>
  <h3>Using Zero Light</h3>
  <p>Use the search box — a place name, a ZIP code, or coordinates — tap the map
  icon to pick a spot on the map, or the crosshair to use your location. Your
  last location is remembered on this device for next time. Pick a target and
  a day to see that day's best windows in the Planner; Trends shows how the
  coming weeks rate. The printer icon in the header prints the day, week, or
  month; the gear holds theme and calendar-export settings.</p>
  <h3>Data &amp; services</h3>
  <ul class="credits">
    ${link("https://open-meteo.com/", "Open-Meteo", "weather forecasts")}
    ${link("https://www.usgs.gov/", "USGS", "stream gauge water temperature &amp; flow")}
    ${link("https://tidesandcurrents.noaa.gov/", "NOAA CO-OPS", "tide predictions &amp; stations")}
    ${link("https://www.ncei.noaa.gov/", "NOAA NCEI", "climate normals behind typical days")}
    ${link("https://myfwc.com/research/redtide/", "FWC-FWRI", "red tide monitoring")}
    ${link("https://www.geoapify.com/", "Geoapify", "place search &amp; geocoding")}
    ${link("https://www.openstreetmap.org/copyright", "OpenStreetMap contributors", "map data")}
    ${link("https://www.esri.com/", "Esri", "satellite base map imagery (World Imagery)")}
    ${link("https://opentopomap.org/", "OpenTopoMap", "topographic base map")}
    ${link("https://leafletjs.com/", "Leaflet", "map library")}
    ${link("https://www.zippopotam.us/", "Zippopotam.us", "ZIP code lookups")}
  </ul>
  <p class="disclaimer">${esc(DISCLAIMER)}</p>`;
}

function closeInfoMenu(): void {
  $("#info-menu").hidden = true;
  $("#info-btn").setAttribute("aria-expanded", "false");
}

function closePrintMenu(): void {
  $("#print-menu").hidden = true;
  $("#print-btn").setAttribute("aria-expanded", "false");
}

/** #35: hang a header menu from its own button. The menu is
 *  position:fixed; its top lands 6px under the button and its right
 *  edge aligns with the button's right edge (opens down-left). Fixed
 *  positioning keeps it out of the document flow, so opening it can
 *  never change the app's dimensions or summon scroll bars. */
function placeMenu(btn: HTMLElement, menu: HTMLElement): void {
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
}

/** #25: the Settings theme chips mirror the saved preference when the
 *  modal opens; chip clicks stage a pending value that Save persists. */
let pendingTheme: ThemePref = "device";

function syncThemeChips(): void {
  pendingTheme = state.settings.theme;
  document.querySelectorAll<HTMLElement>("#theme-picker .chip").forEach((c) =>
    c.classList.toggle("selected", c.dataset.themePref === pendingTheme),
  );
}

window.addEventListener("DOMContentLoaded", async () => {
  // Restore the last selected location (device-only, item #17). A
  // first run stays at the "enter a location" state — no default, no
  // automatic geolocation prompt.
  const last = loadLastPlace();
  if (last) {
    state.place = last;
    $<HTMLInputElement>("#place-search").value = last.label;
    setSearchStatus(`${last.label} — ${last.lat.toFixed(4)}, ${last.lon.toFixed(4)}`);
  } else {
    $<HTMLInputElement>("#place-search").focus();
  }
  syncClearBtn();

  // #30: header brand is the full lockup; CSS swaps the colorway with
  // the theme. #25: apply the (already validated) theme.
  $<HTMLImageElement>("#brand-lockup-light").src = lockupLightUrl;
  $<HTMLImageElement>("#brand-lockup-dark").src = lockupDarkUrl;
  applyTheme();

  // #24: restore the last-used target; an id that no longer exists is
  // ignored and the placeholder shows instead.
  const lastTarget = loadLastTargetId();
  state.targetId = TARGETS.some((t) => t.id === lastTarget) ? lastTarget : null;

  rebuildTargets();
  $<HTMLSelectElement>("#target").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (TARGETS.some((t) => t.id === v)) {
      state.targetId = v;
      saveLastTargetId(v);
    } else {
      state.targetId = null;
    }
    state.plansCache.clear();
    render();
  });

  // Unified location input (item #17).
  const searchInput = $<HTMLInputElement>("#place-search");
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void resolveSearch();
    }
  });
  searchInput.addEventListener("input", () => {
    hidePickList();
    syncClearBtn();
  });
  // #22: clear text + close the pick list, keep focus; the loaded place
  // and the saved last place are untouched.
  $("#clear-btn").addEventListener("click", () => {
    searchInput.value = "";
    hidePickList();
    syncClearBtn();
    searchInput.focus();
  });
  $("#geo-btn").addEventListener("click", () => locateMe());
  $("#map-btn").addEventListener("click", () => {
    hidePickList();
    if (mapIsOpen) closeMapAll();
    else openMap();
  });
  $("#map-use").addEventListener("click", () => confirmMap());
  $("#map-cancel").addEventListener("click", () => closeMapAll());
  $("#map-use-modal").addEventListener("click", () => confirmMap());
  $("#map-cancel-modal").addEventListener("click", () => closeMapAll());
  $("#map-modal-close").addEventListener("click", () => closeMapAll());

  document.querySelectorAll("#day-picker .chip").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#day-picker .chip").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      state.dayOffset = parseInt((b as HTMLElement).dataset.offset ?? "0", 10);
      state.view = "planner";
      document.querySelectorAll("#view-picker .chip").forEach((x) =>
        x.classList.toggle("selected", (x as HTMLElement).dataset.view === "planner"),
      );
      render();
    }),
  );
  document.querySelectorAll("#view-picker .chip").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#view-picker .chip").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      state.view = (b as HTMLElement).dataset.view as "planner" | "trends";
      render();
    }),
  );

  $("#refresh-btn").addEventListener("click", () => void ensureData(true));

  // Header icons + modals. The ⓘ opens a small menu (item #18); the
  // printer icon opens the #26 print menu the same way.
  $("#settings-btn").addEventListener("click", () => {
    syncThemeChips();
    openModal("settings-modal");
  });
  $("#info-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    closePrintMenu();
    const menu = $("#info-menu");
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    if (willOpen) placeMenu($("#info-btn"), menu);
    $("#info-btn").setAttribute("aria-expanded", String(willOpen));
  });
  $("#menu-how").addEventListener("click", () => {
    closeInfoMenu();
    openModal("info-modal");
  });
  $("#menu-about").addEventListener("click", () => {
    closeInfoMenu();
    openModal("about-modal");
  });
  $("#print-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    closeInfoMenu();
    const menu = $("#print-menu");
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    if (willOpen) placeMenu($("#print-btn"), menu);
    $("#print-btn").setAttribute("aria-expanded", String(willOpen));
  });
  // #35: an open menu closes when the page scrolls or resizes (the
  // button it hangs from has moved).
  window.addEventListener("scroll", () => { closeInfoMenu(); closePrintMenu(); }, { passive: true });
  window.addEventListener("resize", () => { closeInfoMenu(); closePrintMenu(); });
  $("#print-day").addEventListener("click", () => {
    closePrintMenu();
    doPrint("day");
  });
  $("#print-week").addEventListener("click", () => {
    closePrintMenu();
    doPrint("week");
  });
  $("#print-month").addEventListener("click", () => {
    closePrintMenu();
    doPrint("month");
  });
  document.addEventListener("click", (e) => {
    const menu = $("#info-menu");
    if (!menu.hidden && !menu.contains(e.target as Node)) closeInfoMenu();
    const pmenu = $("#print-menu");
    if (!pmenu.hidden && !pmenu.contains(e.target as Node)) closePrintMenu();
  });
  $("#info-content").innerHTML = INFO_HTML;
  document.querySelectorAll<HTMLElement>(".modal-close").forEach((b) =>
    b.addEventListener("click", () => {
      $(`#${b.dataset.close}`).hidden = true;
    }),
  );
  // #37: a backdrop click counts only when the PRESS also started on
  // the backdrop. A press that starts inside the modal (e.g. a map
  // drag) and releases on the backdrop otherwise surfaces as a click
  // targeted at the backdrop — which used to cancel the map session.
  let backdropPressTarget: EventTarget | null = null;
  document.addEventListener("mousedown", (e) => {
    backdropPressTarget = e.target;
  });
  document.querySelectorAll<HTMLElement>(".modal-backdrop").forEach((bd) =>
    bd.addEventListener("click", (e) => {
      if (e.target !== bd) return;
      if (backdropPressTarget !== bd) return;
      // The map modal's backdrop click is a cancel (item #17): discard
      // the working pin and close both views, like Esc.
      if (bd.id === "map-modal") closeMapAll();
      else bd.hidden = true;
    }),
  );

  // Escape layering: info menu → map (modal Esc cancels everything,
  // decided 2026-11-12) → pick list.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#print-menu").hidden) {
      closePrintMenu();
      return;
    }
    if (!$("#info-menu").hidden) {
      closeInfoMenu();
      return;
    }
    if (mapIsOpen) {
      closeMapAll();
      return;
    }
    hidePickList();
  });

  // Settings form — theme (#25) + calendar export toggles (item #20
  // removed the key and endpoint fields; keys live server-side now).
  const s = state.settings;
  $<HTMLInputElement>("#export-typical").checked = s.includeTypical;
  $<HTMLInputElement>("#export-dontgo").checked = s.includeDontGo;
  syncThemeChips();
  document.querySelectorAll<HTMLElement>("#theme-picker .chip").forEach((c) =>
    c.addEventListener("click", () => {
      const v = c.dataset.themePref;
      if (v === "device" || v === "light" || v === "dark") pendingTheme = v;
      document.querySelectorAll<HTMLElement>("#theme-picker .chip").forEach((x) =>
        x.classList.toggle("selected", x.dataset.themePref === pendingTheme),
      );
    }),
  );
  $("#save-settings").addEventListener("click", () => {
    state.settings = {
      includeTypical: $<HTMLInputElement>("#export-typical").checked,
      includeDontGo: $<HTMLInputElement>("#export-dontgo").checked,
      theme: pendingTheme,
    };
    saveSettings(state.settings);
    applyTheme();
    $("#settings-modal").hidden = true;
    // #34: no "settings saved" confirmation message (Wade, 2026-11-13).
  });

  // Rust app-info command (replaces the foundation's greet example).
  // The version lives in the About modal only (#27 removed the footer).
  let versionLabel = "Zero Light 0.4.4";
  try {
    versionLabel = await invoke<string>("app_info");
  } catch {
    /* web build: keep the fallback label */
  }
  $("#about-content").innerHTML = aboutHtml(versionLabel);

  void ensureData();
});
