import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  TARGETS,
  generateDayPlan,
  dayBand,
  type DayPlan,
  type TargetDef,
  type TargetKind,
  type Tides,
} from "./scoring";
import {
  fetchWeather,
  fetchTides,
  tidesForDay,
  dateKey,
  parseDateKey,
  addDaysKey,
  TAMPA_TIDE_STATION,
  type WeatherByDay,
} from "./data";
import { loadSettings, saveSettings, type AppSettings } from "./config";
import {
  fetchUsgsReading,
  fetchHabVeto,
  fetchNormals,
  fetchTideStations,
  nearestTideStation,
  lookupZip,
  rutForLocation,
  type UsgsReading,
} from "./extras";
import { downloadIcs, googleUrl, outlookUrl, type ExportDay } from "./calendar";

interface LocationPreset {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kinds: TargetKind[];
  tideStation?: string;
}

const LOCATIONS: LocationPreset[] = [
  { id: "tampa", name: "Tampa Bay, FL — saltwater", lat: 27.9506, lon: -82.4572, kinds: ["saltwater"], tideStation: TAMPA_TIDE_STATION },
  { id: "guntersville", name: "Lake Guntersville, AL — freshwater lake", lat: 34.4207, lon: -86.3947, kinds: ["freshwater"] },
  { id: "tuscaloosa", name: "Tuscaloosa, AL — hunting / river", lat: 33.2098, lon: -87.5692, kinds: ["hunting", "freshwater"] },
  { id: "custom", name: "Custom location…", lat: 0, lon: 0, kinds: ["saltwater", "freshwater", "hunting"] },
];

const state = {
  location: LOCATIONS[0],
  customLat: 27.9506,
  customLon: -82.4572,
  customLabel: "",
  targetId: "redfish",
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
  if (state.location.id === "custom") return { lat: state.customLat, lon: state.customLon };
  return { lat: state.location.lat, lon: state.location.lon };
}

function locationShortName(): string {
  if (state.location.id === "custom") return state.customLabel || "Custom location";
  return state.location.name.split(" — ")[0];
}

function currentTarget(): TargetDef {
  return TARGETS.find((t) => t.id === state.targetId) ?? TARGETS[0];
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
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${ampm}` : `${h} ${ampm}`;
}

function fmtDay(key: string): string {
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ------------------------------------------------------------- data flow

async function ensureData(force = false): Promise<void> {
  const { lat, lon } = currentLatLon();
  const key = `${lat},${lon}`;
  if (state.loading) return;
  if (!force && state.weatherFor === key && state.extrasFor === key) return;
  state.loading = true;
  $("#status").textContent = "Loading forecast…";
  try {
    state.weather = await fetchWeather(lat, lon, {
      cacheEndpoint: state.settings.cacheEndpoint || undefined,
      force,
    });
    state.weatherFor = key;
  } catch {
    if (state.weatherFor !== key) state.weather = null;
    state.weatherFor = key;
  }

  // Secondary sources, each independent and best-effort.
  const jobs: Promise<void>[] = [];
  if (state.location.tideStation) {
    state.tideStationId = state.location.tideStation;
    state.tideStationName = "St. Petersburg, FL";
  } else {
    jobs.push(
      (async () => {
        const stations = await fetchTideStations(force);
        const nearest = nearestTideStation(stations, lat, lon);
        state.tideStationId = nearest?.id ?? "";
        state.tideStationName = nearest?.name ?? "";
      })(),
    );
  }
  jobs.push(
    (async () => {
      state.usgs = await fetchUsgsReading(lat, lon, state.settings.usgs, force);
    })(),
    (async () => {
      state.habVeto = await fetchHabVeto(lat, lon, force);
    })(),
    (async () => {
      state.normals = await fetchNormals(lat, lon, state.settings.ncei);
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
    targetName: currentTarget().name,
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

function renderPlanner(): void {
  const el = $("#planner");
  const key = addDaysKey(startKey(), state.dayOffset);
  const plan = planForKey(key);
  const target = currentTarget();
  const day: ExportDay = { plan, date: parseDateKey(key), targetName: target.name, locationName: locationShortName() };

  if (plan.veto) {
    el.innerHTML = `
      <section class="card veto">
        <h2>Don't go — ${esc(plan.veto)}</h2>
        <p>${esc(fmtDay(key))} · ${esc(target.name)} · ${esc(locationShortName())}</p>
        <p class="note">Safety and closures outrank every score. Check conditions again before going.</p>
      </section>`;
    return;
  }

  const slotsHtml = plan.slots.length
    ? plan.slots
        .map(
          (s, i) => `
        <div class="slot slot-${s.label.toLowerCase()}">
          <div class="slot-label">${s.labelSymbol} ${s.bestToday ? "Best today" : s.label}</div>
          <div class="slot-body">
            <div class="slot-time">${fmtTime(s.start)} – ${fmtTime(s.end)}</div>
            <div class="slot-reason">${esc(s.reason)}</div>
            ${slotAddLinks(day, i)}
          </div>
        </div>`,
        )
        .join("")
    : `<p class="note">No window reached the Okay level today. Rest of the day: slow.</p>`;

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

  el.innerHTML = `
    <section class="card">
      <div class="day-head">
        <h2>${esc(fmtDay(key))} — ${esc(target.name)}</h2>
        <div class="verdict verdict-${plan.verdict.toLowerCase()}">Day: ${plan.verdict.toUpperCase()}</div>
      </div>
      ${slotsHtml}
      ${plan.slots.length ? `<p class="note">Rest of the day: slow.</p>` : ""}
      ${plan.heldBackBy ? `<p class="held-back">Day held back by: ${esc(plan.heldBackBy)}.</p>` : ""}
      ${extras.map((x) => `<p class="note">${x}</p>`).join("")}
      <p class="note astro">
        Sunrise ${fmtTime(plan.astro.sunrise)} · Sunset ${fmtTime(plan.astro.sunset)}
        · Moon ${Math.round(plan.astro.moonIllumination * 100)}% lit
        ${state.weather?.timezone ? `· Times in ${esc(state.weather.timezone.replace("_", " "))}` : ""}
        ${plan.typical ? "· Typical-day estimate (no forecast for this date)" : ""}
      </p>
      <div class="row export-row">
        <button type="button" id="export-day">Export this day (.ics)</button>
      </div>
    </section>`;
  $("#export-day").addEventListener("click", () => {
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
  const target = currentTarget();
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
    <section class="card">
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
    </section>`;

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
      openDayModal(key);
    });
  });
}

function render(): void {
  $("#planner").hidden = state.view !== "planner";
  $("#trends").hidden = state.view !== "trends";
  if (state.view === "planner") renderPlanner();
  else renderTrends();
}

// ------------------------------------------------------------- day modal

function openDayModal(key: string): void {
  const plan = planForKey(key);
  const target = currentTarget();
  const day: ExportDay = { plan, date: parseDateKey(key), targetName: target.name, locationName: locationShortName() };
  $("#day-modal-title").textContent = `${fmtDay(key)} — ${target.name}`;
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
      ? plan.slots
          .map(
            (s, i) => `
          <div class="slot slot-${s.label.toLowerCase()}">
            <div class="slot-label">${s.labelSymbol} ${s.bestToday ? "Best today" : s.label}</div>
            <div class="slot-body">
              <div class="slot-time">${fmtTime(s.start)} – ${fmtTime(s.end)}</div>
              <div class="slot-reason">${esc(s.reason)}</div>
              ${slotAddLinks(day, i)}
            </div>
          </div>`,
          )
          .join("")
      : `<p class="note">No window reached the Okay level this day.</p>`;
  $("#day-modal-content").innerHTML = `
    <div class="verdict verdict-${plan.verdict.toLowerCase()}">Day: ${plan.verdict.toUpperCase()}</div>
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
      <button type="button" id="plan-this-day">Plan this day</button>
      <button type="button" id="export-this-day">Export this day (.ics)</button>
    </div>`;
  $("#day-modal").hidden = false;
  $("#plan-this-day").addEventListener("click", () => {
    const offset = Math.round((parseDateKey(key).getTime() - parseDateKey(startKey()).getTime()) / 86400_000);
    state.dayOffset = offset;
    state.view = "planner";
    document.querySelectorAll("#view-picker .chip").forEach((x) =>
      x.classList.toggle("selected", (x as HTMLElement).dataset.view === "planner"),
    );
    document.querySelectorAll("#day-picker .chip").forEach((x) =>
      x.classList.toggle("selected", parseInt((x as HTMLElement).dataset.offset ?? "0", 10) === offset),
    );
    $("#day-modal").hidden = true;
    render();
  });
  $("#export-this-day").addEventListener("click", () => {
    downloadIcs([day], {
      includeTypical: state.settings.includeTypical,
      includeDontGo: state.settings.includeDontGo,
    });
  });
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
    <tr><td>Light — dawn &amp; dusk</td><td class="dots">●●●○</td><td>The main daily activity windows (night for catfish).</td></tr>
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

// ------------------------------------------------------------- map (#10)

let leafletMap: L.Map | null = null;
let leafletMarker: L.Marker | null = null;

function setCustom(lat: number, lon: number, label: string): void {
  state.customLat = lat;
  state.customLon = lon;
  state.customLabel = label;
  $<HTMLInputElement>("#custom-lat").value = String(Math.round(lat * 10000) / 10000);
  $<HTMLInputElement>("#custom-lon").value = String(Math.round(lon * 10000) / 10000);
  $("#custom-label").textContent = label
    ? `${label} — ${lat.toFixed(4)}, ${lon.toFixed(4)}`
    : `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  if (leafletMarker && leafletMap) {
    leafletMarker.setLatLng([lat, lon]);
    leafletMap.setView([lat, lon], Math.max(leafletMap.getZoom(), 9));
  }
  state.weatherFor = "";
  state.extrasFor = "";
  void ensureData();
}

function initMap(): void {
  if (leafletMap) {
    leafletMap.invalidateSize();
    return;
  }
  const { lat, lon } = currentLatLon();
  leafletMap = L.map("map").setView([lat, lon], 9);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(leafletMap);
  const icon = L.divIcon({ className: "map-pin", html: "<span></span>", iconSize: [18, 18], iconAnchor: [9, 9] });
  leafletMarker = L.marker([lat, lon], { draggable: true, icon }).addTo(leafletMap);
  leafletMarker.on("dragend", () => {
    const p = leafletMarker!.getLatLng();
    setCustom(p.lat, p.lng, "");
  });
  leafletMap.on("click", (e: L.LeafletMouseEvent) => setCustom(e.latlng.lat, e.latlng.lng, ""));
  setTimeout(() => leafletMap?.invalidateSize(), 50);
}

// ------------------------------------------------------------- wiring

function rebuildTargets(): void {
  const sel = $<HTMLSelectElement>("#target");
  const allowed = TARGETS.filter((t) => state.location.kinds.includes(t.kind));
  sel.innerHTML = allowed.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  if (!allowed.some((t) => t.id === state.targetId)) state.targetId = allowed[0].id;
  sel.value = state.targetId;
}

function openModal(id: string): void {
  $(`#${id}`).hidden = false;
}

window.addEventListener("DOMContentLoaded", async () => {
  const locSel = $<HTMLSelectElement>("#location");
  locSel.innerHTML = LOCATIONS.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
  locSel.addEventListener("change", () => {
    state.location = LOCATIONS.find((l) => l.id === locSel.value) ?? LOCATIONS[0];
    $("#custom-coords").hidden = state.location.id !== "custom";
    if (state.location.id === "custom") initMap();
    state.weatherFor = "";
    state.extrasFor = "";
    rebuildTargets();
    void ensureData();
  });

  rebuildTargets();
  $<HTMLSelectElement>("#target").addEventListener("change", (e) => {
    state.targetId = (e.target as HTMLSelectElement).value;
    state.plansCache.clear();
    render();
  });

  $("#custom-apply").addEventListener("click", () => {
    const lat = parseFloat($<HTMLInputElement>("#custom-lat").value);
    const lon = parseFloat($<HTMLInputElement>("#custom-lon").value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) setCustom(lat, lon, "");
  });

  $("#near-me").addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      $("#custom-label").textContent = "This device does not offer geolocation.";
      return;
    }
    $("#custom-label").textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCustom(
          pos.coords.latitude,
          pos.coords.longitude,
          `Near me (±${Math.round(pos.coords.accuracy)} m)`,
        );
      },
      () => {
        $("#custom-label").textContent = "Location permission was not granted — use the ZIP lookup or the map instead.";
      },
      { timeout: 15000 },
    );
  });

  $("#zip-go").addEventListener("click", async () => {
    const zip = $<HTMLInputElement>("#zip").value.trim();
    if (!/^\d{5}$/.test(zip)) {
      $("#custom-label").textContent = "Enter a 5-digit US ZIP code.";
      return;
    }
    const found = await lookupZip(zip);
    if (found) setCustom(found.lat, found.lon, found.label);
    else $("#custom-label").textContent = `No match found for ZIP ${zip}.`;
  });

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

  // Header icons + modals.
  $("#settings-btn").addEventListener("click", () => openModal("settings-modal"));
  $("#info-btn").addEventListener("click", () => openModal("info-modal"));
  $("#info-content").innerHTML = INFO_HTML;
  document.querySelectorAll<HTMLElement>(".modal-close").forEach((b) =>
    b.addEventListener("click", () => {
      $(`#${b.dataset.close}`).hidden = true;
    }),
  );
  document.querySelectorAll<HTMLElement>(".modal-backdrop").forEach((bd) =>
    bd.addEventListener("click", (e) => {
      if (e.target === bd) bd.hidden = true;
    }),
  );

  // Settings form.
  const s = state.settings;
  $<HTMLInputElement>("#usgs-key").value = s.usgs;
  $<HTMLInputElement>("#ncei-token").value = s.ncei;
  $<HTMLInputElement>("#cache-endpoint").value = s.cacheEndpoint;
  $<HTMLInputElement>("#export-typical").checked = s.includeTypical;
  $<HTMLInputElement>("#export-dontgo").checked = s.includeDontGo;
  $("#save-settings").addEventListener("click", () => {
    state.settings = {
      usgs: $<HTMLInputElement>("#usgs-key").value.trim(),
      ncei: $<HTMLInputElement>("#ncei-token").value.trim(),
      cacheEndpoint: $<HTMLInputElement>("#cache-endpoint").value.trim(),
      includeTypical: $<HTMLInputElement>("#export-typical").checked,
      includeDontGo: $<HTMLInputElement>("#export-dontgo").checked,
    };
    saveSettings(state.settings);
    $("#settings-modal").hidden = true;
    state.weatherFor = "";
    state.extrasFor = "";
    $("#status").textContent = "Settings saved on this device.";
    void ensureData();
  });

  // Rust app-info command (replaces the foundation's greet example).
  try {
    $("#app-info").textContent = ` · ${await invoke<string>("app_info")}`;
  } catch {
    $("#app-info").textContent = " · Zero Light 0.2.0";
  }

  void ensureData();
});
