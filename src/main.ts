import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import {
  TARGETS,
  generateDayPlan,
  dayBand,
  type DayPlan,
  type TargetDef,
  type TargetKind,
  type Tides,
} from "./scoring";
import { fetchWeather, fetchTides, tidesForDay, dateKey, TAMPA_TIDE_STATION, type WeatherByDay } from "./data";
import { loadApiKeys, saveApiKeys } from "./config";

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
  { id: "custom", name: "Custom coordinates…", lat: 0, lon: 0, kinds: ["saltwater", "freshwater", "hunting"] },
];

const state = {
  location: LOCATIONS[0],
  customLat: 27.9506,
  customLon: -82.4572,
  targetId: "redfish",
  dayOffset: 0,
  view: "planner" as "planner" | "trends",
  weather: null as WeatherByDay | null,
  weatherFor: "",
  tides: undefined as Tides | undefined,
  tidesFor: "",
  loading: false,
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

function currentLatLon(): { lat: number; lon: number } {
  if (state.location.id === "custom") return { lat: state.customLat, lon: state.customLon };
  return { lat: state.location.lat, lon: state.location.lon };
}

function currentTarget(): TargetDef {
  return TARGETS.find((t) => t.id === state.targetId) ?? TARGETS[0];
}

function fmtTime(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${ampm}` : `${h} ${ampm}`;
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function ensureData(): Promise<void> {
  const { lat, lon } = currentLatLon();
  const key = `${lat},${lon}`;
  if (state.weatherFor === key || state.loading) return;
  state.loading = true;
  $("#status").textContent = "Loading forecast…";
  try {
    state.weather = await fetchWeather(lat, lon);
    state.weatherFor = key;
  } catch {
    state.weather = null;
    state.weatherFor = key;
  }
  // Tides only for the Tampa preset (station-bound in v1).
  if (state.location.tideStation && state.tidesFor !== state.location.id) {
    const now = new Date();
    const end = new Date(now.getTime() + 31 * 86400_000);
    state.tides = await fetchTides(state.location.tideStation, now, end);
    state.tidesFor = state.location.id;
  }
  state.loading = false;
  $("#status").textContent = state.weather
    ? ""
    : "Forecast unavailable (offline?) — showing typical-day estimates from astronomy and season only.";
  render();
}

function planFor(date: Date): DayPlan {
  const target = currentTarget();
  const { lat, lon } = currentLatLon();
  const key = dateKey(date);
  const hours = state.weather?.days.get(key) ?? [];
  const tides = state.location.tideStation ? tidesForDay(state.tides, date) : undefined;
  return generateDayPlan({ date, lat, lon, target, hours, tides });
}

function renderPlanner(): void {
  const el = $("#planner");
  const date = new Date();
  date.setDate(date.getDate() + state.dayOffset);
  const plan = planFor(date);
  const target = currentTarget();

  if (plan.veto) {
    el.innerHTML = `
      <section class="card veto">
        <h2>Don't go — ${esc(plan.veto)}</h2>
        <p>${esc(fmtDay(date))} · ${esc(target.name)} · ${esc(state.location.name.split(" — ")[0])}</p>
        <p class="note">Safety and closures outrank every score. Check conditions again before going.</p>
      </section>`;
    return;
  }

  const slotsHtml = plan.slots.length
    ? plan.slots
        .map(
          (s) => `
        <div class="slot slot-${s.label.toLowerCase()}">
          <div class="slot-label">${s.labelSymbol} ${s.bestToday ? "Best today" : s.label}</div>
          <div class="slot-body">
            <div class="slot-time">${fmtTime(s.start)} – ${fmtTime(s.end)}</div>
            <div class="slot-reason">${esc(s.reason)}</div>
          </div>
        </div>`,
        )
        .join("")
    : `<p class="note">No window reached the Okay level today. Rest of the day: slow.</p>`;

  el.innerHTML = `
    <section class="card">
      <div class="day-head">
        <h2>${esc(fmtDay(date))} — ${esc(target.name)}</h2>
        <div class="verdict verdict-${plan.verdict.toLowerCase()}">Day: ${plan.verdict.toUpperCase()}</div>
      </div>
      ${slotsHtml}
      ${plan.slots.length ? `<p class="note">Rest of the day: slow.</p>` : ""}
      ${plan.heldBackBy ? `<p class="held-back">Day held back by: ${esc(plan.heldBackBy)}.</p>` : ""}
      <p class="note astro">
        Sunrise ${fmtTime(plan.astro.sunrise)} · Sunset ${fmtTime(plan.astro.sunset)}
        · Moon ${Math.round(plan.astro.moonIllumination * 100)}% lit
        ${plan.typical ? "· Typical-day estimate (no forecast for this date)" : ""}
      </p>
    </section>`;
}

function renderTrends(): void {
  const el = $("#trends");
  const target = currentTarget();
  const blocks: string[] = [];
  const plans: { date: Date; plan: DayPlan }[] = [];
  for (const [label, days] of [["Week", 7], ["Month", 30]] as const) {
    const cells: string[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      const plan = planFor(date);
      if (label === "Week") plans.push({ date, plan });
      const band = plan.veto ? "Veto" : dayBand(plan.dayScore);
      const kind = plan.typical ? "typical" : "forecast";
      cells.push(
        `<div class="day-block band-${band.toLowerCase()} ${kind}" title="${dateKey(date)} — ${band}${plan.typical ? " (typical)" : ""}">
           <span class="db-dow">${"SMTWTFS"[date.getDay()]}</span>
           <span class="db-num">${date.getDate()}</span>
         </div>`,
      );
    }
    blocks.push(`<h3>${label} — ${esc(target.name)}</h3><div class="strip">${cells.join("")}</div>`);
  }
  const best = [...plans]
    .filter((p) => !p.plan.veto)
    .sort((a, b) => b.plan.dayScore - a.plan.dayScore)
    .slice(0, 3);
  const chips = best.length
    ? `<p class="best-days">Best days this week: ${best
        .map((p) => `<span class="best-chip">${p.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</span>`)
        .join(" ")}</p>`
    : "";
  el.innerHTML = `
    <section class="card">
      <h2>Viability trends</h2>
      ${blocks.join("")}
      ${chips}
      <p class="note">Solid blocks are forecast days (Open-Meteo, up to 16 days out).
      Paler blocks are <strong>typical for this date</strong> — scored from astronomy and
      season only, not a forecast. Bands: Poor / Fair / Good / Excellent.</p>
    </section>`;
}

function render(): void {
  $("#planner").hidden = state.view !== "planner";
  $("#trends").hidden = state.view !== "trends";
  if (state.view === "planner") renderPlanner();
  else renderTrends();
}

function rebuildTargets(): void {
  const sel = $<HTMLSelectElement>("#target");
  const allowed = TARGETS.filter((t) => state.location.kinds.includes(t.kind));
  sel.innerHTML = allowed.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
  if (!allowed.some((t) => t.id === state.targetId)) state.targetId = allowed[0].id;
  sel.value = state.targetId;
}

window.addEventListener("DOMContentLoaded", async () => {
  const locSel = $<HTMLSelectElement>("#location");
  locSel.innerHTML = LOCATIONS.map((l) => `<option value="${l.id}">${l.name}</option>`).join("");
  locSel.addEventListener("change", () => {
    state.location = LOCATIONS.find((l) => l.id === locSel.value) ?? LOCATIONS[0];
    $("#custom-coords").hidden = state.location.id !== "custom";
    state.weatherFor = "";
    state.tidesFor = "";
    rebuildTargets();
    void ensureData();
  });

  rebuildTargets();
  $<HTMLSelectElement>("#target").addEventListener("change", (e) => {
    state.targetId = (e.target as HTMLSelectElement).value;
    render();
  });

  $("#custom-apply").addEventListener("click", () => {
    const lat = parseFloat($<HTMLInputElement>("#custom-lat").value);
    const lon = parseFloat($<HTMLInputElement>("#custom-lon").value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      state.customLat = lat;
      state.customLon = lon;
      state.weatherFor = "";
      void ensureData();
    }
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

  // Settings: optional keys, local only.
  const keys = loadApiKeys();
  $<HTMLInputElement>("#usgs-key").value = keys.usgs;
  $<HTMLInputElement>("#ncei-token").value = keys.ncei;
  $("#save-keys").addEventListener("click", () => {
    saveApiKeys({
      usgs: $<HTMLInputElement>("#usgs-key").value.trim(),
      ncei: $<HTMLInputElement>("#ncei-token").value.trim(),
    });
    $("#status").textContent = "Keys saved on this device only.";
  });

  // Rust app-info command (replaces the foundation's greet example).
  try {
    $("#app-info").textContent = await invoke<string>("app_info");
  } catch {
    $("#app-info").textContent = "Fishing and Hunting Predictor 0.1.1";
  }

  void ensureData();
});
