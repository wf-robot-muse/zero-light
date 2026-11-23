// Environmental hazard data (item #69).
// In plain words: before this item the only contamination input was
// Florida red tide. This module asks the Layer 2 Worker — which does
// the upstream fetching and caching — about eight more families:
// air quality, spills/sewage notices, beach bacteria, algal blooms
// (satellite + Florida's own sampling), freshwater bacteria samples,
// active fires, Florida shellfish closures, and (item #70) EPA
// ATTAINS long-term water assessments. It boils the answers
// down to one assessment the rest of the app can use: vetoes (don't
// go), caution phrases for the held-back banner, a per-day air
// quality table (which also carries the one score modifier), and the
// rows of the day detail's "Water & air" block.
//
// Honesty rules baked in:
// - Every function is best-effort: a family that cannot be reached
//   reports itself "not checked" (status na) — it never reads as
//   all-clear, and it never breaks the plan.
// - Lab samples (Water Quality Portal) are days to weeks old when
//   posted; the texts always carry the sample date.
// - Satellite bloom data (EPA CyAN) measures bloom biomass, not
//   toxins; the wording says "bloom", never "toxic", for satellite
//   rows. Toxin language is used only for Florida DEP lab samples
//   that actually report a toxin result.
// - A family switched off in Settings is not fetched and leaves no
//   trace in ratings, banners, dots or the conditions block.

import { cachedJson } from "./cache";
import { TTL } from "./cache";
import { CACHE_ENDPOINT, type EnvFamilyId, type EnvSettings } from "./config";
import type { TargetKind } from "./scoring";

export interface EnvSignal {
  id: EnvFamilyId | "redtide" | "gauge";
  label: string;
  status: "ok" | "caution" | "veto" | "na" | "pend";
  text: string;
  source: string;
}

export interface EnvVeto {
  kinds: TargetKind[];
  text: string;
  /** Item #75: the headline form of `text` for the hero pill —
   *  built beside the sentence so the two can never disagree. */
  short: string;
}

export interface EnvCaution {
  kinds: TargetKind[];
  text: string;
}

export interface EnvAssessment {
  fetchedAt: number;
  /** Rows for the "Water & air" block, in display order (the caller
   *  splices the red tide and river gauge rows in — those come from
   *  the older data paths, not from this module). */
  signals: EnvSignal[];
  vetoes: EnvVeto[];
  /** Current-conditions caution phrases for TODAY's plan. Air
   *  quality is deliberately not here — it is handled per day
   *  through aqiByDay so today and forecast days behave the same. */
  cautions: EnvCaution[];
  /** Location-local date key → that day's max AQI (today's entry is
   *  the higher of the current reading and today's forecast). */
  aqiByDay: Record<string, number>;
  /** Item #73: families still being fetched when this assessment
   *  was published (progressive loading). Empty on the final
   *  assessment. The UI renders these as "Checking…" rows/pills and
   *  never calls the day all-clear while the list is non-empty. */
  pending: EnvFamilyId[];
}

const FISHING: TargetKind[] = ["saltwater", "freshwater"];
const ALL_KINDS: TargetKind[] = ["saltwater", "freshwater", "hunting"];

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function fmtDateMs(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtDateKey(key: string): string {
  const [y, m, d] = key.split("-").map((x) => parseInt(x, 10));
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function aqiCategory(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

/** One Worker family call through the Layer 1 cache. Returns null on
 *  any failure (unreachable, not configured, bad shape) — the caller
 *  turns that into a "not checked" row, never an all-clear. */
async function workerFamily<T>(
  route: string,
  lat: number,
  lon: number,
  ttlMs: number,
  force: boolean,
  validate: (d: unknown) => T | null,
): Promise<T | null> {
  try {
    const res = await cachedJson<unknown>(
      `env-${route}:${lat.toFixed(1)},${lon.toFixed(1)}`,
      ttlMs,
      async () => {
        const r = await fetch(`${CACHE_ENDPOINT}/${route}?lat=${lat}&lon=${lon}`);
        if (!r.ok) throw new Error(`env ${route} ${r.status}`);
        return (await r.json()) as unknown;
      },
      { force },
    );
    return validate(res.data);
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown, cap = 120): string =>
  typeof v === "string" ? v.slice(0, cap) : "";
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ------------------------------------------------------------ air

interface AirData {
  source: string;
  currentAqi: number | null;
  daily: { date: string; aqi: number }[];
}

function validateAir(d: unknown): AirData | null {
  const o = obj(d);
  if (typeof o.source !== "string") return null;
  const cur = obj(o.current);
  const currentAqi = num(cur.aqi);
  const daily: { date: string; aqi: number }[] = [];
  if (Array.isArray(o.daily)) {
    for (const r of o.daily.slice(0, 7)) {
      const ro = obj(r);
      const aqi = num(ro.aqi);
      if (typeof ro.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ro.date) && aqi !== null) {
        daily.push({ date: ro.date, aqi });
      }
    }
  }
  if (currentAqi === null && !daily.length) return null;
  return { source: o.source, currentAqi, daily };
}

// ------------------------------------------------------------ cyan

interface CyanData {
  weekMs: number;
  cellsPerMl: number;
}

function validateCyan(d: unknown): CyanData | null {
  const latest = obj(d).latest;
  if (latest === null || latest === undefined) return null;
  const o = obj(latest);
  const weekMs = num(o.weekMs);
  const cells = num(o.cellsPerMl);
  if (weekMs === null || cells === null) return null;
  return { weekMs, cellsPerMl: cells };
}

// ------------------------------------------------------------ spill

interface SpillNotice {
  kind: string;
  title: string;
  facility: string;
  startedMs: number | null;
  ongoing: boolean;
  lat: number;
  lon: number;
  source: string;
  distKm: number;
}

interface SpillData {
  notices: SpillNotice[];
  covered: boolean;
}

function validateSpill(d: unknown, lat: number, lon: number): SpillData | null {
  const o0 = obj(d);
  const arr = o0.notices;
  if (!Array.isArray(arr)) return null;
  const out: SpillNotice[] = [];
  for (const r of arr.slice(0, 50)) {
    const o = obj(r);
    const la = num(o.lat);
    const lo = num(o.lon);
    if (la === null || lo === null) continue;
    out.push({
      kind: o.kind === "sewage" ? "sewage" : "spill",
      title: str(o.title) || "Pollution notice",
      facility: str(o.facility),
      startedMs: num(o.startedMs),
      ongoing: o.ongoing === true,
      lat: la,
      lon: lo,
      source: str(o.source, 60),
      distKm: haversineKm(lat, lon, la, lo),
    });
  }
  return { notices: out.sort((a, b) => a.distKm - b.distKm), covered: o0.covered === true };
}

// ------------------------------------------------------------ habstate

interface BloomSample {
  site: string;
  dateMs: number | null;
  bloom: boolean;
  toxin: boolean;
  toxinText: string;
  taxon: string;
  distKm: number;
}

function validateHabState(d: unknown, lat: number, lon: number): BloomSample[] | null {
  const arr = obj(d).samples;
  if (!Array.isArray(arr)) return null;
  const out: BloomSample[] = [];
  for (const r of arr.slice(0, 50)) {
    const o = obj(r);
    const la = num(o.lat);
    const lo = num(o.lon);
    if (la === null || lo === null) continue;
    out.push({
      site: str(o.site) || "Sampling site",
      dateMs: num(o.dateMs),
      bloom: o.bloom === true,
      toxin: o.toxin === true,
      toxinText: str(o.toxinText, 80),
      taxon: str(o.taxon),
      distKm: haversineKm(lat, lon, la, lo),
    });
  }
  return out.sort((a, b) => a.distKm - b.distKm);
}

// ------------------------------------------------------------ wqp

interface BacteriaSample {
  stationName: string;
  org: string;
  date: string;
  value: number;
  unit: string;
  distKm: number;
}

function validateSampleList(v: unknown, lat: number, lon: number): BacteriaSample[] {
  if (!Array.isArray(v)) return [];
  const out: BacteriaSample[] = [];
  for (const r of v.slice(0, 100)) {
    const o = obj(r);
    const la = num(o.lat);
    const lo = num(o.lon);
    const value = num(o.value);
    if (la === null || lo === null || value === null) continue;
    if (typeof o.date !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(o.date)) continue;
    out.push({
      stationName: str(o.stationName) || "Monitoring station",
      org: str(o.org, 80),
      date: o.date,
      value,
      unit: str(o.unit, 20),
      distKm: haversineKm(lat, lon, la, lo),
    });
  }
  return out.sort((a, b) => a.distKm - b.distKm);
}

interface WqpData {
  entero: BacteriaSample[];
  ecoli: BacteriaSample[];
}

function validateWqp(d: unknown, lat: number, lon: number): WqpData | null {
  const o = obj(d);
  if (!("entero" in o) || !("ecoli" in o)) return null;
  return {
    entero: validateSampleList(o.entero, lat, lon),
    ecoli: validateSampleList(o.ecoli, lat, lon),
  };
}

// ------------------------------------------------------------ firms

interface FireHit {
  atMs: number | null;
  distKm: number;
}

function validateFirms(d: unknown, lat: number, lon: number): FireHit[] | null {
  const arr = obj(d).detections;
  if (!Array.isArray(arr)) return null;
  const out: FireHit[] = [];
  for (const r of arr.slice(0, 300)) {
    const o = obj(r);
    const la = num(o.lat);
    const lo = num(o.lon);
    if (la === null || lo === null) continue;
    out.push({ atMs: num(o.atMs), distKm: haversineKm(lat, lon, la, lo) });
  }
  return out.sort((a, b) => a.distKm - b.distKm);
}

// ------------------------------------------------------------ shellfish

interface ShellfishData {
  published: string;
  closed: { name: string; reason: string }[];
  total: number;
}

function validateShellfish(d: unknown): ShellfishData | null {
  const o = obj(d);
  if (!Array.isArray(o.areas)) return null;
  const closed: { name: string; reason: string }[] = [];
  for (const r of o.areas.slice(0, 100)) {
    const ro = obj(r);
    if (ro.status === "CLOSED") {
      closed.push({ name: str(ro.name, 80), reason: str(ro.reason) });
    }
  }
  return { published: str(o.published, 60), closed, total: o.areas.length };
}

// ------------------------------------------------------------ attains

/** Item #70: EPA ATTAINS long-term assessment summary for the
 *  place's HUC12 watershed, as shaped by the Worker's /attains
 *  route. Annotation only — this family never vetoes, cautions or
 *  modifies a score; the row text says so. */
interface AttainsData {
  watershed: string;
  totalUnits: number;
  impairedUnits: number;
  goodUnits: number;
  notAssessedUnits: number;
  causes: string[];
}

function validateAttains(d: unknown): AttainsData | null {
  const o = obj(d);
  const totalUnits = num(o.totalUnits);
  const impairedUnits = num(o.impairedUnits);
  const goodUnits = num(o.goodUnits);
  const notAssessedUnits = num(o.notAssessedUnits);
  if (totalUnits === null || impairedUnits === null || goodUnits === null || notAssessedUnits === null) {
    return null;
  }
  const causes: string[] = [];
  if (Array.isArray(o.causes)) {
    for (const c of o.causes.slice(0, 3)) {
      if (typeof c === "string" && c) causes.push(c.slice(0, 60));
    }
  }
  return {
    watershed: str(o.watershed, 120),
    totalUnits,
    impairedUnits,
    goodUnits,
    notAssessedUnits,
    causes,
  };
}

// ------------------------------------------------------------ build

/**
 * Fetch every enabled family for a place and boil the answers down
 * to one assessment. `placeLabel` is used only to match Florida
 * shellfish area names against the chosen place (e.g. an area called
 * "Pensacola Bay" for a place labelled Pensacola).
 *
 * Item #73: the families do not wait for each other. Each family's
 * answer publishes a partial assessment through `onPartial` the
 * moment it lands — the day renders and acts on what it has (a
 * landed veto applies at once) while the slow families (the Water
 * Quality Portal can take ~25 s on a cold server cache) are still
 * running. A partial assessment names its unfinished families in
 * `pending`; the returned promise resolves with the final one.
 */
export async function fetchEnvAssessment(
  lat: number,
  lon: number,
  env: EnvSettings,
  placeLabel: string,
  force = false,
  onPartial?: (a: EnvAssessment) => void,
): Promise<EnvAssessment> {
  const on = (id: EnvFamilyId) => env[id];
  // The eight upstream fetches, in the order the original Promise.all
  // listed them. A slot is undefined until its fetch settles, then
  // holds the validated data (or null — failed / switched off).
  const slots: (unknown | null | undefined)[] = Array(8).fill(undefined);
  const fetches: [number, Promise<unknown | null>][] = [
    [0, on("air") ? workerFamily("air", lat, lon, TTL.envAirMs, force, validateAir) : Promise.resolve(null)],
    [1, on("bloom") ? workerFamily("cyan", lat, lon, TTL.envCyanMs, force, validateCyan) : Promise.resolve(null)],
    [2, on("spill") ? workerFamily("spill", lat, lon, TTL.envSpillMs, force, (d) => validateSpill(d, lat, lon)) : Promise.resolve(null)],
    [3, on("bloom") ? workerFamily("habstate", lat, lon, TTL.envHabStateMs, force, (d) => validateHabState(d, lat, lon)) : Promise.resolve(null)],
    [4, on("beach") || on("bacteria") ? workerFamily("wqp", lat, lon, TTL.envWqpMs, force, (d) => validateWqp(d, lat, lon)) : Promise.resolve(null)],
    [5, on("fires") ? workerFamily("firms", lat, lon, TTL.envFirmsMs, force, (d) => validateFirms(d, lat, lon)) : Promise.resolve(null)],
    [6, on("shellfish") ? workerFamily("shellfish", lat, lon, TTL.envShellfishMs, force, validateShellfish) : Promise.resolve(null)],
    [7, on("attains") ? workerFamily("attains", lat, lon, TTL.envAttainsMs, force, validateAttains) : Promise.resolve(null)],
  ];
  // Which toggle families each unsettled slot is holding up. The
  // bloom family reads two feeds (cyan + habstate); the WQP feed
  // serves both bacteria toggles.
  const pendingFor = (): EnvFamilyId[] => {
    const p: EnvFamilyId[] = [];
    if (slots[0] === undefined && on("air")) p.push("air");
    if ((slots[1] === undefined || slots[3] === undefined) && on("bloom")) p.push("bloom");
    if (slots[2] === undefined && on("spill")) p.push("spill");
    if (slots[4] === undefined && on("beach")) p.push("beach");
    if (slots[4] === undefined && on("bacteria")) p.push("bacteria");
    if (slots[5] === undefined && on("fires")) p.push("fires");
    if (slots[6] === undefined && on("shellfish")) p.push("shellfish");
    if (slots[7] === undefined && on("attains")) p.push("attains");
    return p;
  };
  const build = (): EnvAssessment =>
    buildAssessment(env, placeLabel, {
      air: slots[0] as AirData | null | undefined,
      cyan: slots[1] as CyanData | null | undefined,
      spill: slots[2] as SpillData | null | undefined,
      habState: slots[3] as BloomSample[] | null | undefined,
      wqp: slots[4] as WqpData | null | undefined,
      firms: slots[5] as FireHit[] | null | undefined,
      shellfish: slots[6] as ShellfishData | null | undefined,
      attains: slots[7] as AttainsData | null | undefined,
    }, pendingFor());
  let settled = 0;
  await Promise.all(
    fetches.map(([i, pr]) =>
      pr.then((v) => {
        slots[i] = v;
        settled += 1;
        if (settled < fetches.length) onPartial?.(build());
      }),
    ),
  );
  return build();
}

/** Boil one set of family answers (some possibly still missing —
 *  undefined — on a partial publish) into an assessment. Signals
 *  belonging to pending families are dropped here; the UI draws
 *  "Checking…" placeholders for them from `pending` instead, so a
 *  family that has not answered can never read as checked. */
function buildAssessment(
  env: EnvSettings,
  placeLabel: string,
  data: {
    air: AirData | null | undefined;
    cyan: CyanData | null | undefined;
    spill: SpillData | null | undefined;
    habState: BloomSample[] | null | undefined;
    wqp: WqpData | null | undefined;
    firms: FireHit[] | null | undefined;
    shellfish: ShellfishData | null | undefined;
    attains: AttainsData | null | undefined;
  },
  pending: EnvFamilyId[],
): EnvAssessment {
  const on = (id: EnvFamilyId) => env[id];
  const air = data.air ?? null;
  const cyan = data.cyan ?? null;
  const spill = data.spill ?? null;
  const habState = data.habState ?? null;
  const wqp = data.wqp ?? null;
  const firms = data.firms ?? null;
  const shellfish = data.shellfish ?? null;
  const attains = data.attains ?? null;

  const signals: EnvSignal[] = [];
  const vetoes: EnvVeto[] = [];
  const cautions: EnvCaution[] = [];
  const aqiByDay: Record<string, number> = {};

  // --- Air quality
  if (on("air")) {
    const sourceName = air?.source === "airnow" ? "AirNow" : "Open-Meteo air model";
    if (!air) {
      signals.push({
        id: "air",
        label: "Air quality",
        status: "na",
        text: "Air quality couldn't be checked.",
        source: "AirNow / Open-Meteo",
      });
    } else {
      for (const d of air.daily) aqiByDay[d.date] = d.aqi;
      const todayKey = air.daily[0]?.date;
      if (todayKey && air.currentAqi !== null) {
        aqiByDay[todayKey] = Math.max(aqiByDay[todayKey] ?? 0, air.currentAqi);
      }
      const aqi = air.currentAqi ?? air.daily[0]?.aqi ?? null;
      if (aqi === null) {
        signals.push({
          id: "air",
          label: "Air quality",
          status: "na",
          text: "No air quality reading for this area.",
          source: sourceName,
        });
      } else {
        signals.push({
          id: "air",
          label: "Air quality",
          status: aqi > 100 ? "caution" : "ok",
          text:
            `AQI ${aqi} — ${aqiCategory(aqi)}` +
            (aqi >= 151 ? ". Day scores are reduced by 10 while air is this poor." : ""),
          source: sourceName,
        });
      }
    }
  }

  // --- Spills & sewage
  if (on("spill") && spill !== null && !spill.covered) {
    signals.push({
      id: "spill",
      label: "Spills",
      status: "na",
      text: "No official spill feed covers this state yet (feeds cover Florida and Alabama).",
      source: "FL PNP / AL ADEM",
    });
  } else if (on("spill") && spill !== null) {
    const near = spill.notices.filter((n) => n.distKm <= 25);
    const vetoHit = near.find((n) => n.distKm <= 10);
    if (vetoHit) {
      const what = vetoHit.kind === "sewage" ? "Sewage spill" : "Pollution spill";
      vetoes.push({
        kinds: FISHING,
        short: `${what} reported nearby`,
        text:
          `${vetoHit.kind === "sewage" ? "sewage spill" : "pollution spill"} reported — ` +
          `${vetoHit.title}${vetoHit.facility ? ` (${vetoHit.facility})` : ""}, ` +
          `${vetoHit.distKm.toFixed(0)} km away, ${vetoHit.ongoing ? "still ongoing" : `reported ${vetoHit.startedMs ? fmtDateMs(vetoHit.startedMs) : "recently"}`} (${vetoHit.source})`,
      });
      signals.push({
        id: "spill",
        label: "Spills",
        status: "veto",
        text: `${what} reported ${vetoHit.distKm.toFixed(0)} km away — ${vetoHit.title}.`,
        source: vetoHit.source,
      });
    } else if (near.length) {
      signals.push({
        id: "spill",
        label: "Spills",
        status: "caution",
        text: `${near[0].kind === "sewage" ? "Sewage spill" : "Pollution spill"} reported ${near[0].distKm.toFixed(0)} km away — ${near[0].title}. Outside the 10 km caution radius.`,
        source: near[0].source,
      });
    } else {
      signals.push({
        id: "spill",
        label: "Spills",
        status: "ok",
        text: "No spills or sewage overflows reported nearby in the last 14 days.",
        source: "FL / AL official notices",
      });
    }
  } else if (on("spill")) {
    // spill === null: the call itself failed.
    signals.push({
      id: "spill",
      label: "Spills",
      status: "na",
      text: "Spill notices couldn't be checked.",
      source: "FL PNP / AL ADEM",
    });
  }

  // --- Beach bacteria (WQP enterococcus, coastal indicator)
  if (on("beach")) {
    if (!wqp) {
      signals.push({
        id: "beach",
        label: "Beach bacteria",
        status: "na",
        text: "Beach bacteria samples couldn't be checked.",
        source: "Water Quality Portal",
      });
    } else {
      const near = wqp.entero.filter((s) => s.distKm <= 25);
      const advisory = near.find((s) => s.distKm <= 5 && s.value > 104);
      const elevatedFar = near.find((s) => s.distKm <= 10 && s.value > 104);
      const elevated = near.find((s) => s.value > 70);
      if (advisory) {
        vetoes.push({
          kinds: ["saltwater"],
          short: "Bacteria at advisory level",
          text:
            `bacteria at advisory level near this beach — ${advisory.stationName} sampled ` +
            `${Math.round(advisory.value)} per 100 mL on ${fmtDateKey(advisory.date)}, ${advisory.distKm.toFixed(0)} km away (EPA advisory criterion: 104)`,
        });
        signals.push({
          id: "beach",
          label: "Beach bacteria",
          status: "veto",
          text: `Advisory-level sample at ${advisory.stationName} — ${Math.round(advisory.value)} per 100 mL, ${fmtDateKey(advisory.date)}, ${advisory.distKm.toFixed(0)} km away.`,
          source: advisory.org || "Water Quality Portal",
        });
      } else if (elevatedFar) {
        cautions.push({
          kinds: ["saltwater"],
          text: `bacteria sample above the safe limit at ${elevatedFar.stationName} (${fmtDateKey(elevatedFar.date)}, ${elevatedFar.distKm.toFixed(0)} km away)`,
        });
        signals.push({
          id: "beach",
          label: "Beach bacteria",
          status: "caution",
          text: `Sample above the safe limit at ${elevatedFar.stationName} — ${Math.round(elevatedFar.value)} per 100 mL, ${fmtDateKey(elevatedFar.date)}, ${elevatedFar.distKm.toFixed(0)} km away.`,
          source: elevatedFar.org || "Water Quality Portal",
        });
      } else if (elevated) {
        signals.push({
          id: "beach",
          label: "Beach bacteria",
          status: "caution",
          text: `Elevated sample at ${elevated.stationName} — ${Math.round(elevated.value)} per 100 mL, ${fmtDateKey(elevated.date)} (below the 104 advisory criterion).`,
          source: elevated.org || "Water Quality Portal",
        });
      } else if (near.length) {
        signals.push({
          id: "beach",
          label: "Beach bacteria",
          status: "ok",
          text: `Latest samples within limits — nearest at ${near[0].stationName}, ${fmtDateKey(near[0].date)}.`,
          source: near[0].org || "Water Quality Portal",
        });
      } else {
        signals.push({
          id: "beach",
          label: "Beach bacteria",
          status: "na",
          text: "No monitored beach samples near this location in the last 3 weeks.",
          source: "Water Quality Portal",
        });
      }
    }
  }

  // --- Algal blooms (FL DEP ground samples + EPA CyAN satellite)
  if (on("bloom")) {
    const flSamples = (habState ?? []).filter((s) => s.distKm <= 25);
    const toxinHit = flSamples.find((s) => s.toxin && s.distKm <= 10);
    const bloomHit = flSamples.find((s) => s.bloom || s.taxon);
    if (toxinHit) {
      vetoes.push({
        kinds: ["freshwater"],
        short: "Algal toxin found in a sample",
        text:
          `algal toxin found in a water sample — ${toxinHit.site}, sampled ` +
          `${toxinHit.dateMs ? fmtDateMs(toxinHit.dateMs) : "recently"} (FL DEP)`,
      });
    }
    if (toxinHit) {
      signals.push({
        id: "bloom",
        label: "Algal blooms",
        status: "veto",
        text: `Toxin found in a sample at ${toxinHit.site}${toxinHit.toxinText ? ` (${toxinHit.toxinText})` : ""}, sampled ${toxinHit.dateMs ? fmtDateMs(toxinHit.dateMs) : "recently"}.`,
        source: "FL DEP bloom sampling",
      });
    } else if (bloomHit) {
      cautions.push({
        kinds: FISHING,
        text: `algal bloom sampled at ${bloomHit.site} (${bloomHit.dateMs ? fmtDateMs(bloomHit.dateMs) : "recently"})`,
      });
      signals.push({
        id: "bloom",
        label: "Algal blooms",
        status: "caution",
        text: `Bloom sampled at ${bloomHit.site}${bloomHit.taxon ? ` — ${bloomHit.taxon}` : ""}.`,
        source: "FL DEP bloom sampling",
      });
    } else if (cyan && cyan.cellsPerMl >= 20000) {
      cautions.push({
        kinds: FISHING,
        text: `satellite shows an algal bloom on this lake (EPA CyAN, week of ${fmtDateMs(cyan.weekMs)})`,
      });
      signals.push({
        id: "bloom",
        label: "Algal blooms",
        status: "caution",
        text: `Satellite bloom index ${cyan.cellsPerMl.toLocaleString()} cells/mL — ${cyan.cellsPerMl >= 100000 ? "strong" : "moderate"} bloom, week of ${fmtDateMs(cyan.weekMs)}. Satellite measures the bloom, not toxins.`,
        source: "EPA CyAN satellite",
      });
    } else if (cyan || flSamples.length) {
      signals.push({
        id: "bloom",
        label: "Algal blooms",
        status: "ok",
        text: "No bloom on the latest satellite pass or recent state samples.",
        source: "EPA CyAN / FL DEP",
      });
    } else {
      signals.push({
        id: "bloom",
        label: "Algal blooms",
        status: "na",
        text: "No satellite lake reading for this spot (CyAN covers large lakes and reservoirs).",
        source: "EPA CyAN satellite",
      });
    }
  }

  // --- Freshwater bacteria samples (WQP E. coli)
  if (on("bacteria")) {
    if (!wqp) {
      signals.push({
        id: "bacteria",
        label: "Bacteria samples",
        status: "na",
        text: "Bacteria samples couldn't be checked.",
        source: "Water Quality Portal",
      });
    } else {
      const near = wqp.ecoli.filter((s) => s.distKm <= 25);
      const over = near.find(
        (s) => s.distKm <= 10 && s.value > 410 && Date.now() - Date.parse(s.date) <= 14 * 86400_000,
      );
      if (over) {
        cautions.push({
          kinds: ["freshwater"],
          text: `recent bacteria sample over the safe limit — ${over.stationName}, ${Math.round(over.value)} per 100 mL (${fmtDateKey(over.date)})`,
        });
        signals.push({
          id: "bacteria",
          label: "Bacteria samples",
          status: "caution",
          text: `E. coli over the EPA single-sample criterion at ${over.stationName} — ${Math.round(over.value)} per 100 mL, sampled ${fmtDateKey(over.date)}. Lab samples post days to weeks late.`,
          source: over.org || "Water Quality Portal",
        });
      } else if (near.length) {
        signals.push({
          id: "bacteria",
          label: "Bacteria samples",
          status: "ok",
          text: `Recent samples within limits — nearest at ${near[0].stationName}, ${fmtDateKey(near[0].date)}.`,
          source: near[0].org || "Water Quality Portal",
        });
      } else {
        signals.push({
          id: "bacteria",
          label: "Bacteria samples",
          status: "na",
          text: "No recent bacteria samples near this location in the last 3 weeks.",
          source: "Water Quality Portal",
        });
      }
    }
  }

  // --- Shellfish closures (FL, FDACS)
  if (on("shellfish") && shellfish !== null) {
    const labelWords = placeLabel.toLowerCase();
    const match = shellfish.closed.find((c) => {
      const name = c.name.toLowerCase().replace(/\s+(bay|system|river|sound|lagoon)$/, "");
      return name.length >= 4 && labelWords.includes(name);
    });
    if (match) {
      cautions.push({
        kinds: ["saltwater"],
        text: `shellfish harvest area closed here — ${match.name}${match.reason ? ` (${match.reason})` : ""}`,
      });
      signals.push({
        id: "shellfish",
        label: "Shellfish",
        status: "caution",
        text: `Harvest area closed: ${match.name}${match.reason ? ` — ${match.reason}` : ""}.`,
        source: "FDACS shellfish status",
      });
    } else if (shellfish.closed.length) {
      signals.push({
        id: "shellfish",
        label: "Shellfish",
        status: "ok",
        text: `Open here; ${shellfish.closed.length} area${shellfish.closed.length > 1 ? "s" : ""} closed elsewhere in this region (${shellfish.closed.slice(0, 2).map((c) => c.name).join(", ")}).`,
        source: "FDACS shellfish status",
      });
    } else if (shellfish.total > 0) {
      signals.push({
        id: "shellfish",
        label: "Shellfish",
        status: "ok",
        text: `All harvest areas open in this region${shellfish.published ? ` (status published ${shellfish.published})` : ""}.`,
        source: "FDACS shellfish status",
      });
    }
  }
  // Shellfish outside Florida: the route returns an empty area list,
  // which validates to total 0 and pushes no row above — the family
  // simply doesn't apply there, so the block stays silent about it.

  // --- Active fires
  if (on("fires")) {
    if (!firms) {
      signals.push({
        id: "fires",
        label: "Active fires",
        status: "na",
        text: "Fire detections couldn't be checked.",
        source: "NASA FIRMS",
      });
    } else {
      const near = firms.filter((f) => f.distKm <= 25);
      if (near.length) {
        const f0 = near[0];
        if (f0.distKm <= 10) {
          cautions.push({
            kinds: ["hunting"],
            text: `active fire detected ${f0.distKm.toFixed(0)} km away (NASA satellite${f0.atMs ? `, ${fmtDateMs(f0.atMs)}` : ""})`,
          });
        }
        signals.push({
          id: "fires",
          label: "Active fires",
          status: "caution",
          text: `${near.length} satellite fire detection${near.length > 1 ? "s" : ""} within 25 km — nearest ${f0.distKm.toFixed(0)} km away${f0.atMs ? `, ${fmtDateMs(f0.atMs)}` : ""}.`,
          source: "NASA FIRMS",
        });
      } else {
        signals.push({
          id: "fires",
          label: "Active fires",
          status: "ok",
          text: "No active fires detected within 25 km in the last 3 days.",
          source: "NASA FIRMS",
        });
      }
    }
  }

  // --- Long-term water notes (EPA ATTAINS, #70). Annotation only:
  // states and the EPA review these waters on multi-year cycles, so
  // this row is background about the watershed, never a condition of
  // today. It is pushed last; the block's flagged-first sort keeps it
  // behind any live caution.
  if (on("attains")) {
    if (!attains || attains.totalUnits === 0) {
      signals.push({
        id: "attains",
        label: "Long-term water notes",
        status: "na",
        text: "No long-term assessment record found for this watershed.",
        source: "EPA ATTAINS",
      });
    } else if (attains.impairedUnits > 0) {
      signals.push({
        id: "attains",
        label: "Long-term water notes",
        status: "ok",
        text:
          `${attains.impairedUnits} of ${attains.totalUnits} assessed waters in this watershed are listed impaired` +
          (attains.causes.length ? ` — leading causes: ${attains.causes.join(", ").toLowerCase()}` : "") +
          `. Long-term state/EPA assessments, not today's conditions.`,
        source: "EPA ATTAINS",
      });
    } else if (attains.goodUnits > 0) {
      signals.push({
        id: "attains",
        label: "Long-term water notes",
        status: "ok",
        text:
          `No impaired listings in this watershed — ${attains.goodUnits} assessed water${attains.goodUnits > 1 ? "s" : ""} fully supporting` +
          (attains.notAssessedUnits ? `, ${attains.notAssessedUnits} not yet assessed` : "") +
          `. Long-term state/EPA assessments, not today's conditions.`,
        source: "EPA ATTAINS",
      });
    } else {
      signals.push({
        id: "attains",
        label: "Long-term water notes",
        status: "na",
        text: "The waters in this watershed have not been assessed yet.",
        source: "EPA ATTAINS",
      });
    }
  }

  return {
    fetchedAt: Date.now(),
    signals: signals.filter((s) => !pending.includes(s.id as EnvFamilyId)),
    vetoes,
    cautions,
    aqiByDay,
    pending,
  };
}

/** The air-quality caution phrase + score modifier for one day, from
 *  the per-day AQI table. AQI 101–150 cautions; 151+ also cuts every
 *  hour's score by 10 (Wade's ruling, 2026-11-23). */
export function aqiEffectForDay(
  aqiByDay: Record<string, number>,
  dateKey: string,
  isToday: boolean,
): { caution: string | null; modifier: number } {
  const aqi = aqiByDay[dateKey];
  if (typeof aqi !== "number" || aqi <= 100) return { caution: null, modifier: 0 };
  const label = isToday ? "air quality" : "air quality forecast";
  return {
    caution: `${label} — AQI ${aqi} (${aqiCategory(aqi).toLowerCase()})${aqi >= 151 ? "; scores reduced" : ""}`,
    modifier: aqi >= 151 ? -10 : 0,
  };
}

export { ALL_KINDS };
