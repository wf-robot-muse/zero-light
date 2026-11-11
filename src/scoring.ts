// Scoring engine — pure functions, no DOM, no fetch.
//
// Implements the research spec (report §5 as corrected by
// notes/correction-5.3-5.4.md):
//
//   SlotScore = clamp( DayQuality (0-50) + AnchorScore (0-40)
//                      + SlotModifiers (-20..+10), 0, 100 ), then veto cap.
//
// Evidence rules baked in:
//   - Pressure trend ALONE contributes at most ±2 inside the front-package
//     term (turkey rising-pressure term: up to +4, the one peer-reviewed
//     result). No pressure band is hard-coded.
//   - Moon phase contributes 0 for deer/freshwater; solunar is at most a
//     +3/+1 tie-breaker in saltwater, +0 if a tide anchor already scored the
//     slot (no double-counting), and it can never create a slot.
//   - Solar / Kp contributes 0 and is not an input at all.
//   - Labels: >=75 Best, 60-74 Good, 45-59 Okay, <45 not shown.

import * as SunCalc from "suncalc";

export type TargetKind = "saltwater" | "freshwater" | "hunting";

export interface TargetDef {
  id: string;
  name: string;
  kind: TargetKind;
  /** Months (0-11) of peak season. */
  peakMonths: number[];
  /** Months (0-11) of shoulder season. */
  shoulderMonths: number[];
  /** Prime temperature band (°F) — water temp for fish (air-temp proxy in v1),
   *  active-temperature band for game. */
  primeMinF: number;
  primeMaxF: number;
  /** Light-anchor strength 25-40. */
  lightAnchor: number;
  /** Nocturnal targets (catfish) peak at night instead of dawn/dusk. */
  nocturnal?: boolean;
  /** How hard rain hurts this target (0-1 multiplier on rain penalties). */
  rainSensitivity: number;
}

export const TARGETS: TargetDef[] = [
  // Saltwater (FWC/USFWS temperature bands; v1 uses air temp as a water proxy)
  { id: "snook", name: "Snook", kind: "saltwater", peakMonths: [3, 4, 5, 6, 7, 8, 9], shoulderMonths: [2, 10], primeMinF: 72, primeMaxF: 86, lightAnchor: 34, rainSensitivity: 0.5 },
  { id: "redfish", name: "Redfish", kind: "saltwater", peakMonths: [8, 9, 10, 3, 4], shoulderMonths: [1, 2, 5, 7, 11], primeMinF: 65, primeMaxF: 82, lightAnchor: 34, rainSensitivity: 0.5 },
  { id: "speckled-trout", name: "Speckled Trout", kind: "saltwater", peakMonths: [3, 4, 9, 10], shoulderMonths: [1, 2, 5, 8, 11], primeMinF: 65, primeMaxF: 80, lightAnchor: 36, rainSensitivity: 0.5 },
  // Freshwater (FWC/USFWS table: bass spawn 62-75, crappie spawn 62-65,
  // channel catfish spawn 72-82 / feed 70-85)
  { id: "largemouth-bass", name: "Largemouth Bass", kind: "freshwater", peakMonths: [2, 3, 4, 9, 10], shoulderMonths: [1, 5, 8, 11], primeMinF: 62, primeMaxF: 78, lightAnchor: 34, rainSensitivity: 0.6 },
  { id: "crappie", name: "Crappie", kind: "freshwater", peakMonths: [1, 2, 3, 10, 11], shoulderMonths: [0, 4, 9], primeMinF: 58, primeMaxF: 68, lightAnchor: 32, rainSensitivity: 0.6 },
  { id: "catfish", name: "Catfish", kind: "freshwater", peakMonths: [4, 5, 6, 7, 8], shoulderMonths: [3, 9], primeMinF: 70, primeMaxF: 85, lightAnchor: 30, nocturnal: true, rainSensitivity: 0.3 },
  // Hunting (season windows are generic v1 approximations — see README)
  { id: "whitetail", name: "Whitetail Deer", kind: "hunting", peakMonths: [10, 11, 0], shoulderMonths: [9], primeMinF: 32, primeMaxF: 58, lightAnchor: 38, rainSensitivity: 0.8 },
  { id: "waterfowl", name: "Waterfowl", kind: "hunting", peakMonths: [11, 0, 10], shoulderMonths: [9], primeMinF: 25, primeMaxF: 50, lightAnchor: 36, rainSensitivity: 0.4 },
  { id: "turkey", name: "Turkey", kind: "hunting", peakMonths: [2, 3, 4], shoulderMonths: [1, 5], primeMinF: 45, primeMaxF: 70, lightAnchor: 36, rainSensitivity: 1.0 },
];

export function targetById(id: string): TargetDef {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown target ${id}`);
  return t;
}

export interface HourWeather {
  time: Date;
  tempF: number;
  pressureHpa: number;
  windMph: number;
  cloudCover: number; // 0-100
  precipProb: number; // 0-100
}

export interface TideEvent {
  time: Date;
  type: "High" | "Low";
  heightFt: number;
}

export interface TidePoint {
  time: Date;
  heightFt: number;
}

export interface Tides {
  events: TideEvent[];
  curve: TidePoint[];
}

export interface Astro {
  sunrise: Date;
  sunset: Date;
  moonrise: Date | null;
  moonset: Date | null;
  moonTransit: Date;
  moonIllumination: number; // 0-1
  moonPhase: number; // 0-1, 0 = new, 0.5 = full
}

export interface Slot {
  start: Date;
  end: Date;
  score: number;
  label: "Best" | "Good" | "Okay";
  labelSymbol: string;
  reason: string;
  solunarPoints: number;
  /** True when this is the day's top slot on a weak day (score < 60): the UI
   *  may call it "Best today" only alongside an explicit weak day verdict. */
  bestToday: boolean;
}

export interface DayPlan {
  dateKey: string;
  dayQuality: number; // 0-50
  dayScore: number; // 0-100, used by the trends strip
  verdict: "Excellent" | "Good" | "Fair" | "Poor";
  heldBackBy: string | null;
  slots: Slot[];
  veto: string | null;
  astro: Astro;
  typical: boolean;
  solunarMajor: { start: Date; end: Date };
}

export function labelForScore(score: number): "Best" | "Good" | "Okay" | null {
  if (score >= 75) return "Best";
  if (score >= 60) return "Good";
  if (score >= 45) return "Okay";
  return null;
}

export function labelSymbol(label: "Best" | "Good" | "Okay"): string {
  return label === "Best" ? "★" : label === "Good" ? "✓" : "·";
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Astronomy for a calendar day at a location, computed locally. */
export function computeAstro(date: Date, lat: number, lon: number): Astro {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  const times = SunCalc.getTimes(noon, lat, lon);
  const moon = SunCalc.getMoonTimes(noon, lat, lon);
  const illum = SunCalc.getMoonIllumination(noon);
  // Moon transit (highest altitude) — SunCalc has no transit call, so scan
  // the day at 10-minute steps for maximum moon altitude.
  let transit = new Date(noon);
  let bestAlt = -Infinity;
  for (let m = 0; m <= 24 * 60; m += 10) {
    const t = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, m, 0);
    const alt = SunCalc.getMoonPosition(t, lat, lon).altitude;
    if (alt > bestAlt) {
      bestAlt = alt;
      transit = t;
    }
  }
  return {
    sunrise: times.sunrise,
    sunset: times.sunset,
    moonrise: moon.rise ?? null,
    moonset: moon.set ?? null,
    moonTransit: transit,
    moonIllumination: illum.fraction,
    moonPhase: illum.phase,
  };
}

/** Solunar periods: major centred on moon transit, minor on rise/set.
 *  Annotation / tie-breaker only — never creates a slot. */
export function solunarPeriods(astro: Astro): {
  major: { start: Date; end: Date };
  minors: { start: Date; end: Date }[];
} {
  const h = 3600_000;
  return {
    major: { start: new Date(astro.moonTransit.getTime() - h), end: new Date(astro.moonTransit.getTime() + h) },
    minors: [astro.moonrise, astro.moonset]
      .filter((d): d is Date => !!d)
      .map((d) => ({ start: new Date(d.getTime() - 0.5 * h), end: new Date(d.getTime() + 0.5 * h) })),
  };
}

/** The solunar contribution to one hour, with every cap from the spec.
 *  Exported separately so tests can assert the caps directly. */
export function solunarBonus(
  target: TargetDef,
  hourStart: Date,
  astro: Astro,
  tideAnchorScored: boolean,
): number {
  if (target.kind !== "saltwater") return 0; // deer/freshwater: debunked, +0
  if (tideAnchorScored) return 0; // no double-counting with the tide anchor
  const { major, minors } = solunarPeriods(astro);
  const t = hourStart.getTime();
  if (t >= major.start.getTime() && t < major.end.getTime()) return 3;
  if (minors.some((m) => t >= m.start.getTime() && t < m.end.getTime())) return 1;
  return 0;
}

/** Season component of DayQuality: 0-18. */
export function seasonScore(target: TargetDef, date: Date): number {
  const m = date.getMonth();
  if (target.peakMonths.includes(m)) return 16 + ((m * 7) % 3); // 16-18
  if (target.shoulderMonths.includes(m)) return 10;
  return 5;
}

/** Temperature-band component of DayQuality: 0-18. */
export function tempBandScore(target: TargetDef, meanTempF: number): number {
  const { primeMinF, primeMaxF } = target;
  if (meanTempF >= primeMinF && meanTempF <= primeMaxF) {
    const centre = (primeMinF + primeMaxF) / 2;
    const half = (primeMaxF - primeMinF) / 2 || 1;
    return Math.round(18 - 3 * Math.abs(meanTempF - centre) / half);
  }
  const dist = meanTempF < primeMinF ? primeMinF - meanTempF : meanTempF - primeMaxF;
  if (dist <= 8) return Math.round(14 - dist * 0.75); // 8-14
  if (dist <= 20) return Math.round(8 - (dist - 8) * 0.4); // ~3-8
  return 2;
}

/** Mean pressure trend over the day, hPa per 6h (needs >= 6 hours). */
export function pressureTrendPer6h(hours: HourWeather[]): number {
  if (hours.length < 6) return 0;
  const sorted = [...hours].sort((a, b) => a.time.getTime() - b.time.getTime());
  const first = sorted.slice(0, 3).reduce((s, h) => s + h.pressureHpa, 0) / 3;
  const last = sorted.slice(-3).reduce((s, h) => s + h.pressureHpa, 0) / 3;
  const spanH = (sorted[sorted.length - 1].time.getTime() - sorted[0].time.getTime()) / 3600_000;
  if (spanH <= 0) return 0;
  return ((last - first) / spanH) * 6;
}

/** Front-package component of DayQuality: 0-14.
 *  Pressure trend alone moves this by at most ±2 (turkey rising: up to +4). */
export function frontPackageScore(target: TargetDef, hours: HourWeather[]): number {
  const trend = pressureTrendPer6h(hours);
  let pressurePart: number;
  if (target.id === "turkey") {
    // Peer-reviewed: rising day-to-day pressure increases gobbling.
    pressurePart = trend > 0 ? clamp(trend * 1.5, 0, 4) : clamp(trend, -2, 0);
  } else {
    // Falling pressure (pre-front feeding) helps slightly; rising slightly
    // hurts; either way capped at ±2 on its own.
    pressurePart = clamp(-trend * 1.2, -2, 2);
  }
  // Temperature swing through the day is the other cheap front signal.
  let swingPart = 0;
  if (hours.length >= 12) {
    const morning = hours.slice(5, 9).reduce((s, h) => s + h.tempF, 0) / Math.max(1, Math.min(4, hours.length - 5));
    const afternoon = hours.slice(13, 17).reduce((s, h) => s + h.tempF, 0) / 4;
    const drop = morning - afternoon; // afternoon colder than morning = front through
    if (drop > 6) swingPart = -3; // post-front day
    else if (drop < -2) swingPart = 1; // normal warm-up / pre-front build
  }
  return clamp(Math.round(9 + pressurePart + swingPart), 0, 14);
}

export interface DayQualityOpts {
  /** Real water temperature (°F) from a USGS gauge (item #1). For fish it
   *  replaces the air-temperature proxy in the temperature-band term. */
  waterTempF?: number;
  /** Peak-rut window active for this location/date (item #3, whitetail). */
  rutPeak?: boolean;
}

export function dayQuality(
  target: TargetDef,
  date: Date,
  hours: HourWeather[],
  opts?: DayQualityOpts,
): number {
  const meanTemp = hours.length
    ? hours.reduce((s, h) => s + h.tempF, 0) / hours.length
    : typicalTempF(date, 33);
  const bandTemp =
    opts?.waterTempF !== undefined && target.kind !== "hunting" ? opts.waterTempF : meanTemp;
  const season =
    opts?.rutPeak && target.id === "whitetail" ? 18 : seasonScore(target, date);
  return clamp(
    season + tempBandScore(target, bandTemp) + frontPackageScore(target, hours),
    0,
    50,
  );
}

/** Rough "typical" mean temperature (°F) for a date/latitude — used only for
 *  beyond-forecast trend days, which are labelled "typical", never forecast. */
export function typicalTempF(date: Date, lat: number): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const doy = Math.floor((date.getTime() - start.getTime()) / 86400_000);
  const seasonal = 20 * Math.cos(((doy - 200) / 365) * 2 * Math.PI);
  return 63 + seasonal - Math.max(0, Math.abs(lat) - 30) * 0.9;
}

/** Synthetic hours for a typical day (astronomy + season only). */
function typicalHours(date: Date, lat: number, meanOverride?: number): HourWeather[] {
  const mean = meanOverride ?? typicalTempF(date, lat);
  const out: HourWeather[] = [];
  for (let h = 0; h < 24; h++) {
    const diurnal = 6 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
    out.push({
      time: new Date(date.getFullYear(), date.getMonth(), date.getDate(), h),
      tempF: mean + diurnal,
      pressureHpa: 1015,
      windMph: 8,
      cloudCover: 40,
      precipProb: 10,
    });
  }
  return out;
}

interface HourScore {
  time: Date;
  score: number;
  anchor: number;
  reason: string;
  solunar: number;
}

function lightAnchorAt(target: TargetDef, hour: Date, astro: Astro): number {
  const t = hour.getTime() + 1800_000; // hour centre
  if (target.nocturnal) {
    const h = hour.getHours();
    return h >= 21 || h <= 2 ? target.lightAnchor : 0;
  }
  const peak = target.lightAnchor;
  const near = (centre: Date, beforeH: number, afterH: number) => {
    const dt = (t - centre.getTime()) / 3600_000;
    if (dt >= -beforeH && dt <= afterH) {
      const frac = dt < 0 ? 1 - Math.abs(dt) / (beforeH * 2) : 1 - dt / (afterH * 2);
      return peak * clamp(frac, 0.35, 1);
    }
    return 0;
  };
  return Math.max(near(astro.sunrise, 0.75, 2), near(astro.sunset, 2, 0.75));
}

/** Moving-water anchor from the tide curve slope: 0-38. */
function tideAnchorAt(hour: Date, tides: Tides | undefined): number {
  if (!tides || tides.curve.length < 2) return 0;
  const t = hour.getTime() + 1800_000;
  const slopes: { time: number; slope: number }[] = [];
  for (let i = 1; i < tides.curve.length; i++) {
    const dt = (tides.curve[i].time.getTime() - tides.curve[i - 1].time.getTime()) / 3600_000;
    if (dt > 0) slopes.push({ time: tides.curve[i].time.getTime(), slope: Math.abs(tides.curve[i].heightFt - tides.curve[i - 1].heightFt) / dt });
  }
  if (!slopes.length) return 0;
  const maxSlope = Math.max(...slopes.map((s) => s.slope), 0.01);
  let best = 0;
  for (const s of slopes) if (Math.abs(s.time - t) <= 3600_000) best = Math.max(best, s.slope);
  return 38 * clamp(best / maxSlope, 0, 1);
}

function scoreHour(
  target: TargetDef,
  hour: HourWeather,
  dq: number,
  astro: Astro,
  tides: Tides | undefined,
): HourScore {
  const light = lightAnchorAt(target, hour.time, astro);
  const tide = target.kind === "saltwater" ? tideAnchorAt(hour.time, tides) : 0;
  let anchor = Math.max(light, tide);
  let reason = "";
  if (light >= 15 && tide >= 15) {
    anchor = Math.min(40, anchor + 8); // overlap bonus, capped
    const nearDawn =
      Math.abs(hour.time.getTime() - astro.sunrise.getTime()) <=
      Math.abs(hour.time.getTime() - astro.sunset.getTime());
    reason = nearDawn ? "Moving water in low light at dawn" : "Moving water in low light toward dusk";
  } else if (tide >= 20) {
    reason = "Moving water — tide running";
  } else if (light >= 20) {
    if (target.nocturnal) reason = "Night — prime hours for this target";
    else if (Math.abs(hour.time.getTime() - astro.sunrise.getTime()) < Math.abs(hour.time.getTime() - astro.sunset.getTime())) reason = "First light — the day's main activity window";
    else reason = "Last light — movement picks up toward dusk";
  }

  // Slot modifiers (-20..+10 before clamping to spec range)
  let mods = 0;
  mods += clamp(5 - hour.windMph * 0.9, -15, 5); // wind at that hour
  if (hour.precipProb > 20) {
    const rain = hour.precipProb > 70 ? -11 : hour.precipProb > 40 ? -7 : -3;
    mods += rain * target.rainSensitivity;
  }
  if (hour.cloudCover >= 60 && light > 0) mods += 3; // cloud extends the light anchor
  const hr = hour.time.getHours();
  if (target.kind !== "hunting" && !target.nocturnal && hr >= 11 && hr <= 15 && hour.cloudCover < 30 && light === 0 && tide < 15) {
    mods -= 8; // bright midday lull
    if (!reason) reason = "Movement resumes as conditions change";
  }
  const sol = solunarBonus(target, hour.time, astro, tide > 0);
  mods += sol;
  mods = clamp(mods, -20, 10);

  if (!reason) {
    if (tide > 0) reason = "Tide moving, light moderate";
    else reason = "Steady conditions in a decent window";
  }
  return { time: hour.time, score: clamp(Math.round(dq + anchor + mods), 0, 100), anchor, reason, solunar: sol };
}

function heldBackBy(target: TargetDef, hours: HourWeather[], dq: number): string | null {
  if (!hours.length) return null;
  const maxWind = Math.max(...hours.map((h) => h.windMph));
  const meanPrecip = hours.reduce((s, h) => s + h.precipProb, 0) / hours.length;
  const meanTemp = hours.reduce((s, h) => s + h.tempF, 0) / hours.length;
  if (maxWind >= 18) return `gusty wind up to ${Math.round(maxWind)} mph`;
  if (meanPrecip >= 50) return "rain much of the day";
  if (meanTemp < target.primeMinF - 5) return `temperatures below this target's prime range`;
  if (meanTemp > target.primeMaxF + 5) return `heat above this target's prime range`;
  if (pressureTrendPer6h(hours) > 2.5) return "post-front conditions — pressure rising fast";
  if (dq < 30) return "season and temperature working against it";
  return null;
}

export interface DayInputs {
  date: Date; // any time on the target calendar day (local)
  lat: number;
  lon: number;
  target: TargetDef;
  hours: HourWeather[]; // empty => typical day (astronomy + season only)
  tides?: Tides;
  /** External veto (e.g. red tide medium/high, closure). Dangerous wind is
   *  also applied internally. */
  veto?: string | null;
  /** Real water temperature (°F) from a nearby USGS gauge (item #1). */
  waterTempF?: number;
  /** Peak rut active for this location/date (item #3). */
  rutPeak?: boolean;
  /** Typical mean temperature (°F) for this date from NCEI normals
   *  (item #7) — used only when hours is empty (typical day). */
  typicalMeanF?: number;
  /** The location's UTC offset in seconds (item #5). SunCalc works in
   *  true instants while forecast hours are location wall-clock; when
   *  this is supplied, astronomy is shifted into the same wall-clock
   *  frame so anchors and displayed times agree in the location's
   *  timezone rather than the device's. */
  tzOffsetSec?: number;
}

/** Build one day's plan: ranked slots + verdict, per spec §5. */
export function generateDayPlan(input: DayInputs): DayPlan {
  const { target, lat, lon } = input;
  const date = new Date(input.date.getFullYear(), input.date.getMonth(), input.date.getDate());
  const typical = input.hours.length === 0;
  const hours = typical
    ? typicalHours(date, lat, input.typicalMeanF)
    : [...input.hours].sort((a, b) => a.time.getTime() - b.time.getTime());
  const astro = computeAstro(date, lat, lon);
  if (input.tzOffsetSec !== undefined) {
    const deviceOffsetSec = -date.getTimezoneOffset() * 60;
    const shiftMs = (input.tzOffsetSec - deviceOffsetSec) * 1000;
    if (shiftMs !== 0) {
      const shift = (d: Date | null) => (d ? new Date(d.getTime() + shiftMs) : null);
      astro.sunrise = shift(astro.sunrise)!;
      astro.sunset = shift(astro.sunset)!;
      astro.moonrise = shift(astro.moonrise);
      astro.moonset = shift(astro.moonset);
      astro.moonTransit = shift(astro.moonTransit)!;
    }
  }
  const dq = dayQuality(target, date, hours, {
    waterTempF: input.waterTempF,
    rutPeak: input.rutPeak,
  });

  const maxWind = Math.max(...hours.map((h) => h.windMph));
  let veto = input.veto ?? null;
  if (!veto && maxWind >= 32) veto = `dangerous wind (${Math.round(maxWind)} mph)`;

  const scored = hours.map((h) => scoreHour(target, h, dq, astro, input.tides));
  const dayScore = scored.length ? Math.max(...scored.map((s) => s.score)) : dq * 2;
  const verdict: DayPlan["verdict"] = veto
    ? "Poor"
    : dayScore >= 78
      ? "Excellent"
      : dayScore >= 62
        ? "Good"
        : dayScore >= 48
          ? "Fair"
          : "Poor";

  const slots: Slot[] = [];
  if (!veto) {
    // Merge contiguous hours at >= 45 into windows.
    const good = scored.filter((s) => s.score >= 45);
    const windows: HourScore[][] = [];
    for (const s of good) {
      const last = windows[windows.length - 1];
      if (last && s.time.getTime() - last[last.length - 1].time.getTime() <= 3600_000 + 1) last.push(s);
      else windows.push([s]);
    }
    // Cap each slot at 3h: a longer good stretch is split around its best
    // 3 contiguous hours, and the remaining stretches stay as their own
    // windows (a dawn peak and a dusk peak must not merge into one slot).
    const splitWindow = (w: HourScore[]): HourScore[][] => {
      if (w.length <= 3) return w.length ? [w] : [];
      let bestI = 0;
      let bestSum = -1;
      for (let i = 0; i + 3 <= w.length; i++) {
        const sum = w[i].score + w[i + 1].score + w[i + 2].score;
        if (sum > bestSum) { bestSum = sum; bestI = i; }
      }
      return [
        ...splitWindow(w.slice(0, bestI)),
        w.slice(bestI, bestI + 3),
        ...splitWindow(w.slice(bestI + 3)),
      ];
    };
    const built: Slot[] = [];
    for (const w of windows.flatMap(splitWindow)) {
      const win = w;
      const top = win.reduce((a, b) => (b.score > a.score ? b : a), win[0]);
      const label = labelForScore(top.score);
      if (!label) continue;
      built.push({
        start: win[0].time,
        end: new Date(win[win.length - 1].time.getTime() + 3600_000),
        score: top.score,
        label,
        labelSymbol: labelSymbol(label),
        reason: top.reason,
        solunarPoints: Math.max(...win.map((x) => x.solunar)),
        bestToday: false,
      });
    }
    // Rank best-to-worst; ties (within 10 pts) keep chronological order.
    built.sort((a, b) => {
      if (Math.abs(a.score - b.score) <= 10) return a.start.getTime() - b.start.getTime();
      return b.score - a.score;
    });
    slots.push(...built.slice(0, 4));
    // Weak-day exception: if nothing reached 45 but the best hour is close,
    // show that one window, flagged "Best today" against a weak verdict.
    if (!slots.length && scored.length) {
      const top = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]);
      if (top.score >= 35) {
        slots.push({
          start: top.time,
          end: new Date(top.time.getTime() + 3600_000),
          score: top.score,
          label: "Okay",
          labelSymbol: labelSymbol("Okay"),
          reason: top.reason,
          solunarPoints: top.solunar,
          bestToday: true,
        });
      }
    }
    if (slots.length && verdict === "Fair" || verdict === "Poor") {
      if (slots.length) slots[0].bestToday = slots[0].score < 60;
    }
  }

  const { major } = solunarPeriods(astro);
  return {
    dateKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    dayQuality: dq,
    dayScore: veto ? Math.min(dayScore, 20) : dayScore,
    verdict,
    heldBackBy: veto ? veto : heldBackBy(target, hours, dq),
    slots,
    veto,
    astro,
    typical,
    solunarMajor: major,
  };
}

/** Viability band for the trends strip. */
export function dayBand(dayScore: number): "Poor" | "Fair" | "Good" | "Excellent" {
  if (dayScore >= 78) return "Excellent";
  if (dayScore >= 62) return "Good";
  if (dayScore >= 48) return "Fair";
  return "Poor";
}
