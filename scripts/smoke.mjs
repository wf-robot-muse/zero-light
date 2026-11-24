// Smoke test for the scoring engine.
// Compiles src/scoring.ts standalone, then runs fixed-input assertions:
//   - at most 4 slots per day, at least 1 on a good day
//   - slots ranked best-to-worst (ties within 10 pts may stay chronological)
//   - slot labels match the >=75 / 60-74 / 45-59 thresholds
//   - deer (and all freshwater) targets receive ZERO solunar points
//   - solunar is +0 in saltwater when a tide anchor already scored the slot
//   - pressure trend alone moves the front package by at most ±2 (range <= 4)
//   - a veto empties the slot list and caps the day at 20 / Poor
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
execSync(
  "npx tsc src/scoring.ts src/suncalc.d.ts --ignoreConfig --outDir .smoke-build --module esnext --target es2020 --skipLibCheck",
  { cwd: root, stdio: "inherit" },
);
const S = await import(path.join(root, ".smoke-build", "scoring.js"));

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function hoursFor(date, { temp = 76, wind = 8, cloud = 35, precip = 5, p0 = 1018, pTrendPer6h = 0 } = {}) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    out.push({
      time: new Date(date.getFullYear(), date.getMonth(), date.getDate(), h),
      tempF: temp + 5 * Math.sin(((h - 9) / 24) * 2 * Math.PI),
      pressureHpa: p0 + (pTrendPer6h / 6) * h,
      windMph: wind,
      cloudCover: cloud,
      precipProb: precip,
    });
  }
  return out;
}

function sineTides(date) {
  // High at 05:52 and 18:05, like the research worked example.
  const curve = [];
  for (let m = 0; m <= 24 * 60; m += 30) {
    const t = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, m);
    const height = 1.6 + 1.1 * Math.sin(((m / 60 - 5.87) / 12.2) * 2 * Math.PI - Math.PI / 2);
    curve.push({ time: t, heightFt: height });
  }
  return {
    events: [
      { time: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 5, 52), type: "High", heightFt: 2.7 },
      { time: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 10), type: "Low", heightFt: 0.5 },
      { time: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 18, 5), type: "High", heightFt: 2.6 },
    ],
    curve,
  };
}

// --- Label thresholds -------------------------------------------------------
check("label 75 = Best", S.labelForScore(75) === "Best");
check("label 74 = Good", S.labelForScore(74) === "Good");
check("label 60 = Good", S.labelForScore(60) === "Good");
check("label 59 = Okay", S.labelForScore(59) === "Okay");
check("label 45 = Okay", S.labelForScore(45) === "Okay");
check("label 44 = hidden", S.labelForScore(44) === null);

// --- A good Tampa redfish day (September, prime temps, moving water) --------
const tampaDay = new Date(2026, 8, 15); // Sep 15
const redfish = S.targetById("redfish");
const plan = S.generateDayPlan({
  date: tampaDay,
  lat: 27.9506,
  lon: -82.4572,
  target: redfish,
  hours: hoursFor(tampaDay, { temp: 76, wind: 8 }),
  tides: sineTides(tampaDay),
});
console.log(
  `      Tampa redfish plan: verdict=${plan.verdict} dayQuality=${plan.dayQuality} slots=` +
    plan.slots.map((s) => `${s.labelSymbol}${s.label}@${s.score}`).join(", "),
);
check("no veto on a normal day", plan.veto === null);
check("slots per day <= 4", plan.slots.length <= 4, `${plan.slots.length} slots`);
check("good day yields >= 1 slot", plan.slots.length >= 1);
let ranked = true;
for (let i = 0; i < plan.slots.length; i++)
  for (let j = i + 1; j < plan.slots.length; j++)
    if (plan.slots[j].score - plan.slots[i].score > 10) ranked = false;
check("slots ranked best-to-worst (10-pt tie rule)", ranked);
check(
  "slot labels match thresholds",
  plan.slots.every((s) => s.bestToday || S.labelForScore(s.score) === s.label),
);
check(
  "saltwater solunar never exceeds +3",
  plan.slots.every((s) => s.solunarPoints >= 0 && s.solunarPoints <= 3),
);

// --- Deer: solunar is exactly zero ------------------------------------------
const deer = S.targetById("whitetail");
const octDay = new Date(2026, 9, 20);
const astro = S.computeAstro(octDay, 33.2098, -87.5692);
let deerSolunarZero = true;
for (let h = 0; h < 24; h++) {
  if (S.solunarBonus(deer, new Date(2026, 9, 20, h), astro, false) !== 0) deerSolunarZero = false;
}
check("deer solunar bonus = 0 at every hour", deerSolunarZero);
const deerPlan = S.generateDayPlan({
  date: octDay,
  lat: 33.2098,
  lon: -87.5692,
  target: deer,
  hours: hoursFor(octDay, { temp: 48, wind: 6, precip: 10 }),
});
check("deer plan slots carry 0 solunar points", deerPlan.slots.every((s) => s.solunarPoints === 0));

// --- Freshwater: solunar is exactly zero ------------------------------------
const bass = S.targetById("largemouth-bass");
check(
  "bass solunar bonus = 0",
  S.solunarBonus(bass, astro.moonTransit, astro, false) === 0,
);

// --- Saltwater double-count rule --------------------------------------------
check(
  "saltwater solunar = 0 when tide anchor scored",
  S.solunarBonus(redfish, astro.moonTransit, astro, true) === 0,
);
const solAtTransit = S.solunarBonus(redfish, astro.moonTransit, astro, false);
check("saltwater solunar at moon transit <= +3", solAtTransit >= 0 && solAtTransit <= 3, `got ${solAtTransit}`);

// --- Pressure cap: trend alone moves front package by <= 4 total ------------
const falling = S.frontPackageScore(redfish, hoursFor(tampaDay, { pTrendPer6h: -3 }));
const rising = S.frontPackageScore(redfish, hoursFor(tampaDay, { pTrendPer6h: 3 }));
check("pressure-alone front-package range <= 4 (±2 cap)", Math.abs(falling - rising) <= 4, `falling=${falling} rising=${rising}`);

// --- Veto --------------------------------------------------------------------
const vetoPlan = S.generateDayPlan({
  date: tampaDay,
  lat: 27.9506,
  lon: -82.4572,
  target: redfish,
  hours: hoursFor(tampaDay, {}),
  tides: sineTides(tampaDay),
  veto: "red tide (medium) reported nearby",
});
check("veto empties slots", vetoPlan.slots.length === 0);
check("veto caps day score at 20", vetoPlan.dayScore <= 20, `dayScore=${vetoPlan.dayScore}`);
check("veto day verdict is Poor", vetoPlan.verdict === "Poor");

// --- Typical (beyond-forecast) day still plans -------------------------------
const typicalPlan = S.generateDayPlan({
  date: new Date(2027, 0, 15),
  lat: 34.4207,
  lon: -86.3947,
  target: S.targetById("largemouth-bass"),
  hours: [],
});
check("typical day is flagged typical", typicalPlan.typical === true);
check("typical day dayQuality within 0-50", typicalPlan.dayQuality >= 0 && typicalPlan.dayQuality <= 50);

// --- #63: the 25-target catalog ---------------------------------------------
check("catalog has 25 targets (#63)", S.TARGETS.length === 25, `${S.TARGETS.length}`);
check(
  "catalog ids are unique (#63)",
  new Set(S.TARGETS.map((t) => t.id)).size === S.TARGETS.length,
);
let allPlan = true;
for (const t of S.TARGETS) {
  const p = S.generateDayPlan({
    date: new Date(2026, 5, 15),
    lat: 33.2,
    lon: -87.5,
    target: t,
    hours: hoursFor(new Date(2026, 5, 15), { temp: 68, wind: 6 }),
  });
  if (!(p.dayScore >= 0 && p.dayScore <= 100 && p.slots.length <= 4)) allPlan = false;
}
check("every catalog target produces a sane plan (#63)", allPlan);

// Nocturnal anchor: on a prime June night a catfish plan's best slot is
// a night slot (the engine's night anchor is 21:00-02:00).
const catDay = new Date(2026, 5, 15); // Jun 15 — catfish peak, prime temps
const catPlan = S.generateDayPlan({
  date: catDay,
  lat: 33.2,
  lon: -87.5,
  target: S.targetById("catfish"),
  hours: hoursFor(catDay, { temp: 78, wind: 5 }),
});
const catBest = catPlan.slots.reduce((a, s) => (a && a.score >= s.score ? a : s), null);
check(
  "catfish best slot is at night (#63 nocturnal)",
  !!catBest && (catBest.start.getHours() >= 20 || catBest.start.getHours() <= 2),
  catBest ? `best @${catBest.start.getHours()}:00 score ${catBest.score}` : "no slots",
);

// --- #69: environmental inputs ----------------------------------------------
// An env veto behaves like any veto (slots emptied, day capped, Poor),
// and the caller's own veto (red tide) outranks it.
const envVetoPlan = S.generateDayPlan({
  date: tampaDay,
  lat: 27.9506,
  lon: -82.4572,
  target: redfish,
  hours: hoursFor(tampaDay, {}),
  tides: sineTides(tampaDay),
  envVeto: "sewage spill reported — Hillsborough River, 2 km away",
});
check("#69 env veto empties slots", envVetoPlan.slots.length === 0);
check("#69 env veto caps day at 20 / Poor", envVetoPlan.dayScore <= 20 && envVetoPlan.verdict === "Poor");
check("#69 env veto is the plan's veto", (envVetoPlan.veto ?? "").includes("sewage spill"));
check("#69 env veto day is not flagged a mere caution", envVetoPlan.envCaution === false);
const bothVetoPlan = S.generateDayPlan({
  date: tampaDay,
  lat: 27.9506,
  lon: -82.4572,
  target: redfish,
  hours: hoursFor(tampaDay, {}),
  tides: sineTides(tampaDay),
  veto: "red tide (high) reported nearby",
  envVeto: "sewage spill reported — Hillsborough River, 2 km away",
});
check("#69 caller veto outranks env veto", bothVetoPlan.veto === "red tide (high) reported nearby");

// The AQI modifier shifts every hour (and so the day score) by exactly
// the modifier; a caution alone changes words, not numbers.
const basePlan = S.generateDayPlan({
  date: tampaDay,
  lat: 27.9506,
  lon: -82.4572,
  target: redfish,
  hours: hoursFor(tampaDay, { temp: 76, wind: 8 }),
  tides: sineTides(tampaDay),
});
const modPlan = S.generateDayPlan({
  date: tampaDay,
  lat: 27.9506,
  lon: -82.4572,
  target: redfish,
  hours: hoursFor(tampaDay, { temp: 76, wind: 8 }),
  tides: sineTides(tampaDay),
  envScoreModifier: -10,
});
check("#69 modifier shifts the day score by exactly 10", modPlan.dayScore === basePlan.dayScore - 10, `${basePlan.dayScore} -> ${modPlan.dayScore}`);
check(
  "#69 modifier shifts every hour by 10",
  modPlan.hourlyScores.every((h, i) => h.score === Math.max(0, basePlan.hourlyScores[i].score - 10)),
);
check("#69 modifier alone flags envCaution", modPlan.envCaution === true);
const cautionPlan = S.generateDayPlan({
  date: tampaDay,
  lat: 27.9506,
  lon: -82.4572,
  target: redfish,
  hours: hoursFor(tampaDay, { temp: 76, wind: 8 }),
  tides: sineTides(tampaDay),
  envCautions: ["algal bloom sampled at Lake X (Nov 20)"],
});
check("#69 caution leads the held-back line", (cautionPlan.heldBackBy ?? "").startsWith("algal bloom sampled at Lake X"), cautionPlan.heldBackBy ?? "null");
check("#69 caution flags envCaution", cautionPlan.envCaution === true);
check("#69 caution does not change the score", cautionPlan.dayScore === basePlan.dayScore);
check("#69 a plain plan has envCaution false", basePlan.envCaution === false);

// --- #76: "best" means the highest score, not slots[0] -----------------------
// Slot order is display order (near-ties stay chronological), so a later
// slot can outscore the first. bestSlot must still find the true top.
const mkSlot = (h, score) => ({
  start: new Date(2026, 10, 25, h),
  end: new Date(2026, 10, 25, h + 1),
  score,
  label: S.labelForScore(score),
  labelSymbol: "",
  reason: "",
  solunarPoints: 0,
  bestToday: false,
});
check("#76 bestSlot picks the highest score, not the first slot", S.bestSlot([mkSlot(1, 57), mkSlot(5, 64), mkSlot(15, 62)])?.score === 64);
check("#76 bestSlot tie goes to the earliest slot", S.bestSlot([mkSlot(5, 64), mkSlot(1, 64)])?.start.getHours() === 1);
check("#76 bestSlot of no slots is null", S.bestSlot([]) === null);
// On a weak (Fair/Poor) day the "Best today" flag must sit on the
// highest-scored slot even when display order puts another slot first.
const weakPlan = S.generateDayPlan({
  date: new Date(2027, 0, 15),
  lat: 30.25,
  lon: -88.05,
  target: S.targetById("speckled-trout"),
  hours: hoursFor(new Date(2027, 0, 15), { temp: 52, wind: 15 }),
  tides: sineTides(new Date(2027, 0, 15)),
});
const weakTop = S.bestSlot(weakPlan.slots);
check(
  "#76 Best today flag sits on the highest-scored slot",
  weakPlan.slots.length >= 2 &&
    weakTop !== weakPlan.slots[0] &&
    weakPlan.slots.every((s) => s.bestToday === (s === weakTop && s.score < 60)),
  weakPlan.slots.map((s) => `${s.score}${s.bestToday ? "*" : ""}`).join(", "),
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL SMOKE CHECKS PASSED");
process.exit(failures ? 1 : 0);
