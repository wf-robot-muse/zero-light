// UI regression check (next-build item #6; extended for v0.3.0 #17/#18/#20,
// v0.4.0 #22–#29, v0.4.1 #30, v0.4.2 #32, v0.4.3 #33–#37, v0.4.4 #38–#40).
//
// The v0.1.0 startup bug passed the engine-only smoke test (24/24)
// because nothing ever rendered the app. This check serves the built
// dist/ headlessly, intercepts the data APIs (including the Layer 2
// Worker) with deterministic fixtures, and asserts the interface
// actually populates: first-run state (#27 one-line empty state, empty
// status line), #24 target placeholder gating + the alphabetical
// 11-target list, unified location search (coordinates / pick list /
// geolocation), #22 clear (×) button, #28 Band Hero + stencil +
// enrichment, trends strip + day detail (modal below 75em, side panel
// at desktop), #25 theme setting, #26 print menu + sheet rendering,
// slimmed settings modal, ⓘ menu with the explainer and the About &
// credits modal (#29 lockup, "Using Zero Light"), map panel, and
// last-place + last-target restore after reload.
//
// Run: npm run build && node scripts/ui-check.mjs

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const DIST = new URL("../dist", import.meta.url).pathname;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") path = "/index.html";
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST)) throw new Error("bad path");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(4173, r));

// ---------------------------------------------------------- fixtures
function pad(n) {
  return String(n).padStart(2, "0");
}
function dateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function weatherFixture() {
  const time = [];
  const temp = [];
  const pres = [];
  const wind = [];
  const cloud = [];
  const precip = [];
  const today = new Date();
  for (let day = 0; day < 16; day++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + day);
    for (let h = 0; h < 24; h++) {
      time.push(`${dateStr(d)}T${pad(h)}:00`);
      temp.push(Math.round(74 + 6 * Math.sin(((h - 9) / 24) * 2 * Math.PI)));
      pres.push(1018);
      wind.push(6);
      cloud.push(30);
      precip.push(5);
    }
  }
  return {
    timezone: "America/New_York",
    utc_offset_seconds: -18000,
    hourly: {
      time,
      temperature_2m: temp,
      pressure_msl: pres,
      wind_speed_10m: wind,
      cloud_cover: cloud,
      precipitation_probability: precip,
    },
  };
}
function tideFixture(interval) {
  const preds = [];
  const today = new Date();
  for (let day = 0; day < 32; day++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + day);
    if (interval === "hilo") {
      preds.push(
        { t: `${dateStr(d)} 03:12`, v: "2.1", type: "H" },
        { t: `${dateStr(d)} 09:24`, v: "0.4", type: "L" },
        { t: `${dateStr(d)} 15:36`, v: "2.3", type: "H" },
        { t: `${dateStr(d)} 21:48`, v: "0.5", type: "L" },
      );
    } else {
      for (let h = 0; h < 24; h += 3) {
        preds.push({ t: `${dateStr(d)} ${pad(h)}:00`, v: (1.3 + Math.sin(h / 3)).toFixed(2) });
      }
    }
  }
  return { predictions: preds };
}

const failures = [];
function check(name, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures.push(name);
}

// Resolve a Chromium executable: prefer Playwright's own download, but
// fall back to any locally cached Puppeteer Chrome (useful on machines
// where the Playwright CDN download is slow or blocked).
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
function findChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const puppeteerRoot = join(homedir(), ".cache", "puppeteer");
  for (const flavour of ["chrome-headless-shell", "chrome"]) {
    try {
      for (const ver of readdirSync(join(puppeteerRoot, flavour))) {
        candidates.push(
          flavour === "chrome-headless-shell"
            ? join(puppeteerRoot, flavour, ver, "chrome-headless-shell-linux64", "chrome-headless-shell")
            : join(puppeteerRoot, flavour, ver, "chrome-linux64", "chrome"),
        );
      }
    } catch { /* not installed */ }
  }
  return candidates.find((c) => existsSync(c));
}
const executablePath = findChrome();
const browser = await chromium.launch(
  executablePath ? { executablePath, args: ["--no-sandbox"] } : {},
);
try {
  const context = await browser.newContext({
    geolocation: { latitude: 27.9506, longitude: -82.4572 },
    permissions: ["geolocation"],
    // 1000px = Expanded tier (52.5em–75em): enrichment in flow, day
    // detail still a modal. Desktop panel behaviour is checked later
    // by widening the viewport past 75em (1200px).
    viewport: { width: 1000, height: 850 },
  });
  await context.addInitScript(() => { localStorage.setItem("zl_tour_seen", "1"); localStorage.setItem("zl_nudge_seen", "1"); });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));

  // Layer 2 Worker endpoints (v0.3.0 primary data path).
  await page.route("**workers.dev/weather**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(weatherFixture()) }),
  );
  await page.route("**workers.dev/usgs**", (route) =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.route("**workers.dev/normals**", (route) =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.route("**workers.dev/reverse**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ label: "Tampa, FL, United States" }),
    }),
  );
  await page.route("**workers.dev/geocode**", (route) => {
    const q = (new URL(route.request().url()).searchParams.get("q") ?? "").toLowerCase();
    const results = q.includes("springfield")
      ? [
          { lat: 39.7817, lon: -89.6501, label: "Springfield, IL, United States", detail: "Illinois, United States" },
          { lat: 37.209, lon: -93.2923, label: "Springfield, MO, United States", detail: "Missouri, United States" },
        ]
      : [{ lat: 27.9506, lon: -82.4572, label: "Tampa, FL, United States", detail: "Florida, United States" }];
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ results }) });
  });
  // Direct fallbacks + remaining sources.
  await page.route("**api.open-meteo.com**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(weatherFixture()) }),
  );
  await page.route("**api.tidesandcurrents.noaa.gov/api/**", (route) => {
    const interval = new URL(route.request().url()).searchParams.get("interval");
    route.fulfill({ contentType: "application/json", body: JSON.stringify(tideFixture(interval)) });
  });
  await page.route("**api.tidesandcurrents.noaa.gov/mdapi/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        stations: [{ id: "8726520", name: "St. Petersburg", lat: "27.773", lng: "-82.627" }],
      }),
    }),
  );
  await page.route("**api.waterdata.usgs.gov**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ features: [] }) }),
  );
  await page.route("**gis.myfwc.com**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ features: [] }) }),
  );
  await page.route("**tile.openstreetmap.org**", (route) =>
    route.fulfill({ contentType: "image/png", body: Buffer.alloc(0) }),
  );

  await page.goto("http://localhost:4173/", { waitUntil: "load" });

  check("title is Zero Light", (await page.title()).startsWith("Zero Light"));
  // #39: Print is disabled until a location and a target are chosen.
  check(
    "print starts disabled with nothing chosen (#39)",
    await page.evaluate(() => document.querySelector("#print-btn").disabled),
  );
  check("no preset location dropdown remains", (await page.locator("#location").count()) === 0);
  check("unified search box exists", (await page.locator("#place-search").count()) === 1);

  // #23 tagline, #30 header lockup, #27 footer removal.
  check(
    "tagline is the locked #23 text",
    (await page.textContent(".subtitle"))?.trim() === "Your best times to hunt and fish.",
  );
  check(
    "header shows the full lockup, both colorways wired (#30)",
    await page.evaluate(() => {
      const loaded = (img) =>
        !!img &&
        (img.getAttribute("src") ?? "").length > 0 &&
        img.complete &&
        img.naturalWidth > 0;
      return (
        loaded(document.querySelector("#brand-lockup-light")) &&
        loaded(document.querySelector("#brand-lockup-dark")) &&
        !document.querySelector("#brand-mark")
      );
    }),
  );
  check(
    "tagline sits under the header row (#33)",
    await page.evaluate(() => {
      const img = document.querySelector("#brand-lockup-light");
      const sub = document.querySelector(".topbar .subtitle");
      if (!img || !sub) return false;
      return sub.getBoundingClientRect().top >= img.getBoundingClientRect().bottom - 1;
    }),
  );
  check(
    "light theme displays the light lockup colorway (#30)",
    await page.evaluate(() => {
      const light = document.querySelector("#brand-lockup-light");
      const dark = document.querySelector("#brand-lockup-dark");
      return (
        !!light &&
        !!dark &&
        getComputedStyle(light).display !== "none" &&
        getComputedStyle(dark).display === "none"
      );
    }),
  );
  check("footer scoring paragraph is gone (#27)", (await page.locator("footer").count()) === 0);
  check("no #app-info element remains (#27)", (await page.locator("#app-info").count()) === 0);

  // #27: the line under the search box carries no standing text.
  check(
    "search status line starts empty (#27)",
    ((await page.textContent("#search-status")) ?? "").trim() === "",
  );

  // First-run state (#17 + #27): no default location, one-line card.
  await page.waitForFunction(
    () => document.querySelector("#planner")?.textContent?.includes("Search above, pick on the map"),
    null,
    { timeout: 10000 },
  );
  check("first run shows the one-line empty state (#27)", true);

  // #24 + #63: target list = disabled placeholder + the enabled set;
  // on a first run that is the default 10 of the 25-target catalog.
  const optionTexts = await page.locator("#target option").allTextContents();
  check("target select has placeholder + default 10 targets (#63)", optionTexts.length === 11);
  check("first option is the placeholder", optionTexts[0] === "Choose a target…");
  check(
    "first-run targets are the default 10, alphabetical (#63)",
    JSON.stringify(optionTexts.slice(1)) ===
      JSON.stringify([
        "Catfish", "Flounder", "Grouper", "Largemouth Bass", "Redfish",
        "Snapper", "Speckled Trout", "Turkey", "Waterfowl", "Whitetail Deer",
      ]),
  );
  check("no target chosen on first run", (await page.inputValue("#target")) === "");

  // Typed coordinates apply directly; with no target chosen the
  // planner is gated (#24).
  await page.fill("#place-search", "27.9506, -82.4572");
  await page.press("#place-search", "Enter");
  await page.waitForFunction(
    () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
    null,
    { timeout: 20000 },
  );
  check("planner is gated until a target is chosen (#24)", true);

  // Trends is gated the same way, export included.
  await page.click('#view-picker .chip[data-view="trends"]');
  await page.waitForFunction(
    () => document.querySelector("#trends")?.textContent?.includes("Pick a target to see best times"),
    null,
    { timeout: 10000 },
  );
  check("trends is gated until a target is chosen (#24)", true);
  check("no week/month export while gated (#44)", (await page.locator("#export-week").count()) === 0 && (await page.locator("#export-month").count()) === 0);
  await page.click('#view-picker .chip[data-view="planner"]');

  // #22: × is visible with text in the field; clicking clears the text
  // but keeps the loaded place.
  const clearVisible = await page.evaluate(() => {
    const b = document.querySelector("#clear-btn");
    return b.classList.contains("show") && getComputedStyle(b).visibility === "visible";
  });
  check("clear (×) shows when the field has text (#22)", clearVisible);
  await page.click("#clear-btn");
  check("× clears the text", (await page.inputValue("#place-search")) === "");
  check(
    "× does not unload the place (status keeps the applied label)",
    ((await page.textContent("#search-status")) ?? "").includes("27.9506"),
  );
  const clearHidden = await page.evaluate(
    () => getComputedStyle(document.querySelector("#clear-btn")).visibility === "hidden",
  );
  check("× hides again once the field is empty", clearHidden);

  // Choose a target → hero + slots + enrichment populate (#28).
  await page.selectOption("#target", "redfish");
  await page.waitForSelector("#plan-side .hero", { timeout: 20000 });
  check("band hero renders (#28)", (await page.locator("#plan-side .hero").count()) === 1);
  const heroText = (await page.textContent("#plan-side .hero")) ?? "";
  check(
    "hero shows a rating band word",
    ["Excellent", "Good", "Fair", "Poor", "Don't go"].some((w) => heroText.includes(w)),
  );
  check("hero shows the best-window pill", heroText.includes("Best window") || heroText.includes("No window"));
  check(
    "hero ghosts the redfish stencil",
    ((await page.getAttribute(".hero-stencil", "src")) ?? "").includes("stencil-redfish"),
  );
  const plannerText = (await page.textContent("#planner")) ?? "";
  check(
    "planner shows slot cards or the no-window note",
    (await page.locator("#planner .slot2").count()) > 0 || plannerText.includes("No window"),
  );
  check("planner offers calendar export", (await page.locator("#export-day").count()) === 1);
  check(
    "planner export sits above the day details (#44)",
    await page.evaluate(() => {
      const b = document.querySelector("#export-day");
      const d = document.querySelector("#planner .details-sec");
      return !!b && !!d && (b.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }),
  );
  check(
    "slot add row leads with the Apple / .ics button (#43)",
    (await page.locator("#planner .slot-ics").count()) > 0 &&
      ((await page.textContent("#planner .slot-add")) ?? "").includes("Apple / .ics"),
  );
  check("hour-by-hour strip renders 24 bars", (await page.locator(".hourly .bar").count()) === 24);
  check("week at a glance renders 7 days", (await page.locator(".wk-day").count()) === 7);
  check("area cards render (Coming up / gauge / red tide)", (await page.locator("#plan-cards .acard").count()) === 3);
  check("day details render as tiles at this width", (await page.locator("#planner .tile").count()) >= 4);

  // #26: print menu exists; the beforeprint path renders a Day sheet.
  check("print button exists (#26)", (await page.locator("#print-btn").count()) === 1);
  await page.click("#print-btn");
  await page.waitForSelector("#print-menu:not([hidden])", { timeout: 8000 });
  check("print menu opens with day/week/month", (await page.locator("#print-menu button").count()) === 3);
  await page.click("#print-btn"); // close again without printing
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  const printText = (await page.textContent("#print-root")) ?? "";
  check("print sheet carries the header + day rating", printText.includes("Day rating:"));
  check("print header uses the cropped logo, not text (#36)", (await page.locator("#print-root .plogo img").count()) >= 1);
  check("print sheet carries Best windows", printText.includes("Best windows"));
  check(
    "print sheet carries the guidance footer",
    printText.includes("planning guidance only") && printText.includes("official sources"),
  );
  await page.emulateMedia({ media: "print" });
  check(
    "print media shows the sheet and hides the app",
    (await page.locator("#print-root").isVisible()) &&
      (await page.evaluate(() => getComputedStyle(document.querySelector(".container")).display === "none")),
  );
  await page.emulateMedia({ media: "screen" });

  // Trends populates with 30 day blocks.
  await page.click('#view-picker .chip[data-view="trends"]');
  await page.waitForFunction(
    () => document.querySelectorAll("#trends .day-block").length >= 30,
    null,
    { timeout: 15000 },
  );
  check("trends renders 30 day blocks", (await page.locator("#trends .day-block").count()) >= 30);
  check("trends offers week + month export, old button gone (#44)", (await page.locator("#export-week").count()) === 1 && (await page.locator("#export-month").count()) === 1 && (await page.locator("#export-all").count()) === 0);

  // Day detail modal opens from a trends cell (below 75em).
  await page.click("#trends .day-block >> nth=2");
  await page.waitForSelector("#day-modal:not([hidden])", { timeout: 8000 });
  check("day modal opens", await page.locator("#day-modal").isVisible());
  check("day modal has Plan this day", (await page.locator("#day-modal .plan-this-day").count()) === 1);
  check(
    "day modal actions sit above the slots (#44)",
    await page.evaluate(() => {
      const a = document.querySelector("#day-modal .modal-actions");
      const s = document.querySelector("#day-modal .slot2");
      if (!a) return false;
      if (!s) return true;
      return (a.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }),
  );
  await page.click('#day-modal .modal-close');

  // v0.4.6 — #52 (app-drawn select chevron), #50 modal form (action
  // row on one row), #53 modal form (best-day chip opens the detail).
  const t52 = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector("#target"));
    return { appearance: cs.appearance, bg: cs.backgroundImage };
  });
  check(
    "#52 target select draws its own chevron",
    t52.appearance === "none" && t52.bg.includes("data:image/svg+xml"),
  );
  await page.click("#trends .day-block >> nth=2");
  await page.waitForSelector("#day-modal:not([hidden])", { timeout: 8000 });
  const t50a = await page.evaluate(() => {
    // #56: the row now holds three buttons (Plan / Export / Watch
    // badge) — the #50 rule is unchanged: all on one row, no wrap.
    const btns = [...document.querySelectorAll("#day-modal .modal-actions > button")];
    if (btns.length !== 3) return null;
    const tops = btns.map((x) => x.getBoundingClientRect().top);
    return Math.max(...tops) - Math.min(...tops) <= 1;
  });
  check("#50 modal action buttons share one row", t50a === true);
  await page.click('#day-modal .modal-close');
  const chipDay = await page.evaluate(() => {
    const chip = document.querySelector(".best-chip");
    return chip ? chip.textContent.trim().split(" ").pop() : null;
  });
  await page.click(".best-chip >> nth=0");
  await page.waitForSelector("#day-modal:not([hidden])", { timeout: 8000 });
  check(
    "#53 best-day chip opens that day's detail (modal)",
    chipDay !== null &&
      ((await page.locator("#day-modal-title").textContent()) ?? "").includes(chipDay),
  );
  await page.click('#day-modal .modal-close');

  // At desktop width the same click fills the side panel instead (#28).
  await page.setViewportSize({ width: 1400, height: 900 });

  // v0.4.4 — #38 (trends in the main column, height-matched skeleton
  // panel), #39 (quiet status, print gating), #40 (view icons).
  await page.click('#view-picker .chip[data-view="planner"]');
  await page.click('#view-picker .chip[data-view="trends"]');
  await page.waitForFunction(
    () => document.querySelectorAll("#trends .day-block").length >= 30,
    null,
    { timeout: 8000 },
  );
  await page.waitForTimeout(400);
  const t38 = await page.evaluate(() => {
    const trends = document.querySelector("#trends").getBoundingClientRect();
    const status = document.querySelector(".status-row").getBoundingClientRect();
    const main = document.querySelector(".trends-main").getBoundingClientRect();
    const panel = document.querySelector("#day-panel").getBoundingClientRect();
    return {
      colAligned: Math.abs(trends.left - status.left) <= 3,
      heightsMatch: Math.abs(main.height - panel.height) <= 2,
      skCount: document.querySelectorAll("#day-panel .sk, #day-panel .sk-slot").length,
    };
  });
  check("#38 trends sits in the main column", t38.colAligned);
  check("#38 unfilled day panel matches chart height", t38.heightsMatch);
  check("#38 unfilled day panel is skeleton-filled", t38.skCount >= 8);
  const t3940 = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll("#view-picker .chip svg")];
    return {
      icons: svgs.length,
      iconW: svgs.length ? svgs[0].getBoundingClientRect().width : 0,
      printDisabled: document.querySelector("#print-btn").disabled,
      status: document.querySelector("#status").textContent ?? "",
    };
  });
  check("#40 both view buttons carry an icon", t3940.icons === 2);
  check("#40 view icon is 16px", Math.abs(t3940.iconW - 16) <= 1);
  check("#39 print is enabled once place+target are set", t3940.printDisabled === false);
  check("#39 status shows no progress text", !/Loading forecast/.test(t3940.status));

  await page.click("#trends .day-block >> nth=3");
  await page.waitForFunction(
    () => document.querySelector("#day-panel")?.textContent?.includes("Day:"),
    null,
    { timeout: 8000 },
  );
  check("desktop trends uses the side panel, not the modal", await page.locator("#day-modal").isHidden());
  const t38b = await page.evaluate(() => {
    const main = document.querySelector(".trends-main").getBoundingClientRect();
    const panel = document.querySelector("#day-panel").getBoundingClientRect();
    return Math.abs(main.height - panel.height) <= 2;
  });
  check("#38 filled day panel still matches chart height", t38b);

  // v0.4.6 — #50 panel form + #53 panel form.
  const t50b = await page.evaluate(() => {
    // #56: three buttons now (compact Plan / Export (.ics) / Watch
    // badge) — all must still share one row in the 306px panel.
    const btns = [...document.querySelectorAll("#day-panel .modal-actions > button")];
    if (btns.length !== 3) return null;
    const tops = btns.map((x) => x.getBoundingClientRect().top);
    return Math.max(...tops) - Math.min(...tops) <= 1;
  });
  check("#50 panel action buttons share one row", t50b === true);
  const chipKey = await page.evaluate(
    () => document.querySelector(".best-chip")?.dataset.key ?? null,
  );
  await page.click(".best-chip >> nth=0");
  await page.waitForFunction(
    (key) =>
      (document.querySelector("#day-panel")?.textContent ?? "").includes("Day:") &&
      (document.querySelector("#day-panel h3")?.textContent ?? "").includes(
        new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { month: "long" }),
      ),
    chipKey,
    { timeout: 8000 },
  );
  check("#53 best-day chip opens that day's detail (panel)", chipKey !== null);
  await page.setViewportSize({ width: 1000, height: 850 });

  // Settings modal — v0.3.0: key/endpoint fields are GONE (#20);
  // #25 adds the theme chips.
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
  check("settings modal opens", await page.locator("#settings-modal").isVisible());
  check("settings has no USGS key field", (await page.locator("#usgs-key").count()) === 0);
  check("settings has no NCEI token field", (await page.locator("#ncei-token").count()) === 0);
  check("settings has no cache endpoint field", (await page.locator("#cache-endpoint").count()) === 0);
  check("settings keeps export toggles", (await page.locator("#export-typical").count()) === 1);
  check("settings has the three theme chips (#25)", (await page.locator("#theme-picker .chip").count()) === 3);
  await page.click('[data-acc-head="theme"]');
  await page.click('#theme-picker .chip[data-theme-pref="dark"]');
  await page.click("#save-settings");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, { timeout: 5000 });
  check("choosing Dark applies the dark theme", true);
  check(
    "dark theme displays the dark lockup colorway (#30)",
    await page.evaluate(() => {
      const light = document.querySelector("#brand-lockup-light");
      const dark = document.querySelector("#brand-lockup-dark");
      return (
        !!light &&
        !!dark &&
        getComputedStyle(dark).display !== "none" &&
        getComputedStyle(light).display === "none"
      );
    }),
  );
  check(
    "theme persists to localStorage",
    (await page.evaluate(() => localStorage.getItem("zl_theme"))) === "dark",
  );
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
  await page.click('[data-acc-head="theme"]');
  await page.click('#theme-picker .chip[data-theme-pref="device"]');
  await page.click("#save-settings");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 5000 });
  check("Follow device restores the device theme (light here)", true);
  check(
    "back in light, the header lockup swaps back (#30)",
    await page.evaluate(() => {
      const light = document.querySelector("#brand-lockup-light");
      const dark = document.querySelector("#brand-lockup-dark");
      return (
        !!light &&
        !!dark &&
        getComputedStyle(light).display !== "none" &&
        getComputedStyle(dark).display === "none"
      );
    }),
  );

  // #63: Settings target picker — accordion structure, default set,
  // filter, save-through to the dropdown, placeholder fallback when
  // the selected target is disabled, the min-one guardrail, and Reset.
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
  check("settings has three accordion sections (#63)", (await page.locator(".acc-head").count()) === 3);
  check("targets summary shows the default count (#63)", (await page.textContent("#acc-sum-targets")) === "10 of 25 shown");
  await page.click('[data-acc-head="targets"]');
  check("targets section lists all 25 targets (#63)", (await page.locator("#target-groups input[data-target-id]").count()) === 25);
  check("10 targets checked by default (#63)", (await page.locator("#target-groups input[data-target-id]:checked").count()) === 10);
  check("count line reads 10 of 25 (#63)", ((await page.textContent("#target-count-text")) ?? "").startsWith("10 of 25 shown"));
  await page.fill("#target-filter", "tarpon");
  check(
    "filter shows only Tarpon (#63)",
    await page.evaluate(() => {
      const vis = [...document.querySelectorAll("#target-groups .check")].filter((l) => !l.hidden);
      return vis.length === 1 && (vis[0].textContent ?? "").includes("Tarpon");
    }),
  );
  await page.fill("#target-filter", "");
  await page.check('#target-groups input[data-target-id="tarpon"]');
  await page.click("#save-settings");
  check("dropdown gains Tarpon after save (#63)", (await page.locator("#target option").count()) === 12);
  check(
    "enabled targets persist (#63)",
    await page.evaluate(() => (localStorage.getItem("zl_enabled_targets") ?? "").includes("tarpon")),
  );
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
  await page.click('[data-acc-head="targets"]');
  await page.uncheck('#target-groups input[data-target-id="redfish"]');
  await page.click("#save-settings");
  check(
    "disabling the selected target falls back to the placeholder (#63)",
    (await page.inputValue("#target")) === "",
  );
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
  await page.click('[data-acc-head="targets"]');
  await page.click("#targets-reset");
  check("Reset restores the default 10 (#63)", (await page.locator("#target-groups input[data-target-id]:checked").count()) === 10);
  await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("#target-groups input[data-target-id]:checked")];
    boxes.slice(1).forEach((b) => {
      b.checked = false;
      b.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
  check("unchecking down to one leaves one (#63)", (await page.locator("#target-groups input[data-target-id]:checked").count()) === 1);
  await page.evaluate(() => {
    const last = document.querySelector("#target-groups input[data-target-id]:checked");
    if (last) {
      last.checked = false;
      last.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  check("the last target cannot be unchecked (#63)", (await page.locator("#target-groups input[data-target-id]:checked").count()) === 1);
  await page.click("#targets-reset");
  await page.click("#save-settings");
  check("dropdown restored to placeholder + default 10 (#63)", (await page.locator("#target option").count()) === 11);

  // #64: while a modal is open the page behind it must not scroll
  // (body gets the modal-open class → overflow hidden), and the
  // expanded Targets section must not overflow horizontally.
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
  check(
    "page scroll is locked while Settings is open (#64)",
    await page.evaluate(
      () =>
        document.body.classList.contains("modal-open") &&
        getComputedStyle(document.body).overflow === "hidden",
    ),
  );
  await page.click('[data-acc-head="targets"]');
  check(
    "expanded Targets section has no horizontal overflow (#64)",
    await page.evaluate(() => {
      const body = document.querySelector('[data-acc-body="targets"]');
      const bd = document.querySelector("#settings-modal");
      return (
        !!body &&
        body.scrollWidth <= body.clientWidth + 1 &&
        !!bd &&
        bd.scrollWidth <= bd.clientWidth + 1
      );
    }),
  );
  await page.click('[data-close="settings-modal"]');
  await page.waitForFunction(
    () => document.querySelector("#settings-modal")?.hidden === true,
    null,
    { timeout: 8000 },
  );
  check(
    "page scroll unlocks when the modal closes (#64)",
    await page.evaluate(() => !document.body.classList.contains("modal-open")),
  );

  // #65: hero stencils are head-first. At a phone-width viewport the
  // fish stencil's head end (its left edge) sits inside the hero, and
  // the pheasant's head end (its right edge) sits inside with margin.
  {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#view-picker .chip[data-view="planner"]');
    await page.selectOption("#target", "redfish");
    await page.waitForSelector(".hero .hero-stencil", { timeout: 20000 });
    const fish = await page.evaluate(() => {
      const h = document.querySelector(".hero");
      const img = h?.querySelector(".hero-stencil");
      if (!h || !img) return null;
      const hr = h.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      return { off: ir.left - hr.left, w: hr.width, hgt: ir.height };
    });
    check(
      "fish hero stencil is head-first at phone width (#65)",
      !!fish && fish.off > fish.w * 0.1 && fish.off < fish.w * 0.24 && fish.hgt === 200,
    );
    // Enable the pheasant, then check its right-anchored fit.
    await page.click("#settings-btn");
    await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
    await page.click('[data-acc-head="targets"]');
    await page.check('#target-groups input[data-target-id="pheasant"]');
    await page.click("#save-settings");
    await page.selectOption("#target", "pheasant");
    await page.waitForSelector(".hero .hero-stencil", { timeout: 20000 });
    const phez = await page.evaluate(() => {
      const h = document.querySelector(".hero");
      const img = h?.querySelector(".hero-stencil");
      if (!h || !img) return null;
      const hr = h.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      return { rightGap: hr.right - ir.right, leftOff: ir.left - hr.left };
    });
    check(
      "pheasant hero stencil keeps its head inside the right edge (#65)",
      !!phez && phez.rightGap >= 4 && phez.rightGap <= 18 && phez.leftOff >= -1,
    );
    // Restore the pre-block state: disable the pheasant again and
    // save — the app's own fallback returns the selection to the
    // placeholder when the selected target is disabled (#63).
    await page.click("#settings-btn");
    await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
    await page.click('[data-acc-head="targets"]');
    await page.uncheck('#target-groups input[data-target-id="pheasant"]');
    await page.click("#save-settings");
    // Selecting the pheasant above also overwrote the persisted
    // last-used target; the flow's later persistence check expects
    // the value it had before this block (redfish), so put it back.
    await page.evaluate(() => localStorage.setItem("zl_last_target", "redfish"));
    check(
      "hero block restores the default 10 + placeholder (#65)",
      (await page.locator("#target option").count()) === 11 && (await page.inputValue("#target")) === "",
    );
    if (vp) await page.setViewportSize(vp);
  }

  // ⓘ menu (#18): How ratings work + About & credits.
  await page.click("#info-btn");
  await page.waitForSelector("#info-menu:not([hidden])", { timeout: 8000 });
  check("info menu opens from the ⓘ", await page.locator("#info-menu").isVisible());
  await page.click("#menu-how");
  await page.waitForSelector("#info-modal:not([hidden])", { timeout: 8000 });
  const infoText = (await page.textContent("#info-modal")) ?? "";
  check("explainer explains pressure cap", infoText.includes("Pressure trend"));
  check("explainer states solunar zero rule", infoText.includes("ZERO"));
  await page.click('#info-modal .modal-close');

  await page.click("#info-btn");
  await page.waitForSelector("#info-menu:not([hidden])", { timeout: 8000 });
  await page.click("#menu-about");
  await page.waitForSelector("#about-modal:not([hidden])", { timeout: 8000 });
  const aboutText = (await page.textContent("#about-modal")) ?? "";
  check("about credits Geoapify", aboutText.includes("Geoapify"));
  check("about credits OpenStreetMap", aboutText.includes("OpenStreetMap"));
  check("about carries the settled disclaimer", aboutText.includes("planning guidance only"));
  check("about carries All Rights Reserved", aboutText.includes("All Rights Reserved"));
  check("about has the Using Zero Light section (#27)", aboutText.includes("Using Zero Light"));
  check("about shows both lockup colorways (#29)", (await page.locator("#about-modal .about-lockup").count()) === 2);
  await page.click('#about-modal .modal-close');

  // Ambiguous place name → confirm pick list (#17).
  await page.fill("#place-search", "Springfield");
  await page.press("#place-search", "Enter");
  await page.waitForSelector("#pick-list:not([hidden])", { timeout: 10000 });
  check("ambiguous name shows the pick list", (await page.locator("#pick-list li").count()) === 2);
  await page.click("#pick-list li >> nth=0 >> button");
  await page.waitForFunction(
    () => document.querySelector("#search-status")?.textContent?.includes("Springfield, IL"),
    null,
    { timeout: 10000 },
  );
  check("picking a candidate applies it", true);

  // Map panel (#17): opens inline with a working pin; Use this spot applies.
  await page.click("#map-btn");
  await page.waitForSelector("#map-panel:not([hidden])", { timeout: 8000 });
  check("map panel opens inline", await page.locator("#map-panel").isVisible());
  check("map renders a Leaflet container", (await page.locator("#map .leaflet-container, #map.leaflet-container").count()) >= 1);
  await page.click("#map-use");
  await page.waitForFunction(
    () => document.querySelector("#map-panel")?.hidden === true,
    null,
    { timeout: 8000 },
  );
  check("Use this spot closes the panel and applies", true);

  // Geolocation button (#19 path): granted fix applies via reverse label.
  await page.click("#geo-btn");
  await page.waitForFunction(
    () => document.querySelector("#search-status")?.textContent?.includes("Tampa, FL"),
    null,
    { timeout: 10000 },
  );
  check("geolocation applies with a place label", true);

  // Last location AND last target persist across reload (#17 + #24).
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#plan-side .hero", { timeout: 20000 });
  check("last location + target auto-load after reload", true);
  check(
    "search box restored to the saved label",
    (await page.inputValue("#place-search")).includes("Tampa"),
  );
  check("target restored to redfish (#24)", (await page.inputValue("#target")) === "redfish");

  // #33: inline header — the lockup shares one row with the icon
  // buttons at the locked widths (230 phone / 270 tablet / 290
  // expanded / 230 rail; 200 under a 375px viewport), the tagline
  // sits tight under the row, and nothing overflows horizontally.
  const lockupGeom = async (w) => {
    await page.setViewportSize({ width: w, height: 850 });
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const img = document.querySelector("#brand-lockup-light");
      const row = document.querySelector(".icon-row");
      const sub = document.querySelector(".subtitle");
      if (!img || !row || !sub) return null;
      const ir = img.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      return {
        lockup: ir.width,
        lockupTop: ir.top,
        lockupBottom: ir.bottom,
        rowTop: rr.top,
        rowBottom: rr.bottom,
        subTop: sub.getBoundingClientRect().top,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
  };
  const g390 = await lockupGeom(390);
  console.log(`  #33 measured @390: lockup=${g390?.lockup.toFixed(1)} overflow=${g390?.overflow}`);
  check("phone: lockup is 230px (#33)", !!g390 && Math.abs(g390.lockup - 230) <= 3);
  check(
    "phone: icons share the lockup row (#33)",
    !!g390 && g390.rowTop >= g390.lockupTop - 2 && g390.rowBottom <= g390.lockupBottom + 2,
  );
  check("phone: tagline tight under the header (#33)", !!g390 && g390.subTop - g390.lockupBottom <= 4);
  check("phone: no horizontal overflow (#33)", !!g390 && g390.overflow <= 0);
  const g360 = await lockupGeom(360);
  check(
    "narrow phone: lockup steps down to 200px, no overflow (#33)",
    !!g360 && Math.abs(g360.lockup - 200) <= 3 && g360.overflow <= 0,
  );
  const g820 = await lockupGeom(820);
  check("tablet: lockup is 270px (#33)", !!g820 && Math.abs(g820.lockup - 270) <= 2);
  const g1024 = await lockupGeom(1024);
  check("expanded: lockup is 290px (#33)", !!g1024 && Math.abs(g1024.lockup - 290) <= 2);
  const g1440 = await lockupGeom(1440);
  check("desktop: lockup is 230px in the rail (#33)", !!g1440 && Math.abs(g1440.lockup - 230) <= 2);
  check("header carries the refresh icon button (#33)", (await page.locator(".topbar #refresh-btn").count()) === 1);
  check("no floating Refresh button in the main column (#33)", (await page.locator(".main-col #refresh-btn").count()) === 0);
  await page.setViewportSize({ width: 1000, height: 850 });

  // #35: the info menu hangs from its button (fixed, right-aligned,
  // 6px below) and opening it changes no document dimensions.
  await page.click("#info-btn");
  await page.waitForSelector("#info-menu:not([hidden])");
  const menuGeom = await page.evaluate(() => {
    const b = document.querySelector("#info-btn").getBoundingClientRect();
    const m = document.querySelector("#info-menu");
    const r = m.getBoundingClientRect();
    return {
      pos: getComputedStyle(m).position,
      topGap: r.top - b.bottom,
      rightDiff: Math.abs(r.right - b.right),
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    };
  });
  check("info menu is viewport-fixed (#35)", menuGeom.pos === "fixed");
  check(
    "info menu hangs 6px under the info button, right-aligned (#35)",
    Math.abs(menuGeom.topGap - 6) <= 2 && menuGeom.rightDiff <= 2,
  );
  check("opening the menu adds no scroll width (#35)", menuGeom.sw <= menuGeom.iw);
  await page.keyboard.press("Escape");

  // #34: saving settings shows no confirmation message.
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])");
  await page.click("#save-settings");
  await page.waitForTimeout(200);
  check(
    "settings save shows no 'saved' message (#34)",
    !((await page.textContent("#status")) ?? "").includes("Settings saved"),
  );

  // #37: map scale + layers controls, base-map persistence, and the
  // drag-out guard on the map modal.
  await page.click("#map-btn");
  await page.waitForSelector(".leaflet-container", { timeout: 10000 });
  check("map has the scale control (#37)", (await page.locator(".leaflet-control-scale").count()) === 1);
  check("map has the layers control (#37)", (await page.locator(".leaflet-control-layers").count()) === 1);
  // The layers list expands on hover, which intercepts a Playwright
  // click on the toggle; click the Satellite radio directly instead.
  await page.evaluate(() => {
    const label = [...document.querySelectorAll(".leaflet-control-layers label")].find((l) =>
      l.textContent.includes("Satellite"),
    );
    label?.querySelector("input")?.click();
  });
  await page.waitForTimeout(300);
  check(
    "base-map choice persists (#37)",
    await page.evaluate(() => localStorage.getItem("zl_base_map") === "satellite"),
  );
  await page.click(".map-expand-btn");
  await page.waitForSelector("#map-modal:not([hidden])");
  const mapBox = await page.evaluate(() => {
    const r = document.querySelector("#map").getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
  });
  await page.mouse.move(mapBox.cx, mapBox.cy);
  await page.mouse.down();
  await page.mouse.move(30, 30, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(
    "drag out of the map modal no longer cancels it (#37)",
    await page.evaluate(() => !document.querySelector("#map-modal").hidden),
  );
  await page.mouse.click(30, 30);
  await page.waitForTimeout(300);
  check(
    "a genuine backdrop click still cancels the map modal (#37)",
    await page.evaluate(() => document.querySelector("#map-modal").hidden),
  );

  // #33: a fresh profile (no saved place/target) gets skeleton
  // placeholders in every region, and on desktop the two placeholder
  // columns end on the same line.
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(() => { localStorage.setItem("zl_tour_seen", "1"); localStorage.setItem("zl_nudge_seen", "1"); });
  const page2 = await ctx2.newPage();
  await page2.setViewportSize({ width: 1440, height: 1000 });
  await page2.goto("http://localhost:4173/", { waitUntil: "load" });
  await page2.waitForSelector(".sk-hero", { timeout: 10000 });
  check("fresh state shows the hero skeleton (#33)", true);
  check("fresh state shows 4 slot skeletons (#33)", (await page2.locator(".sk-slot").count()) === 4);
  check("fresh state shows area skeletons (#33)", (await page2.locator(".sk-acard").count()) === 3);
  const colGeom = await page2.evaluate(() => {
    const bottom = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().bottom + window.scrollY : 0;
    };
    return { rail: Math.max(bottom("#plan-side"), bottom("#plan-cards")), main: bottom("#planner") };
  });
  console.log(`  #33 placeholder columns @1440: rail=${colGeom.rail.toFixed(0)} main=${colGeom.main.toFixed(0)}`);
  check("desktop placeholders end on the same line (#33)", Math.abs(colGeom.rail - colGeom.main) <= 45);
  await page2.setViewportSize({ width: 390, height: 900 });
  await page2.waitForTimeout(250);
  check(
    "phone placeholders: no horizontal overflow (#33)",
    await page2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  );
  await ctx2.close();

  // v0.4.6 — #48: with a mocked Tauri bridge, Print routes by OS —
  // macOS must call the native print_page command and never reach
  // window.print (WKWebView drops it silently); Windows keeps
  // window.print and never calls print_page.
  async function mockRoutesFor(p) {
    await p.route("**workers.dev/weather**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(weatherFixture()) }),
    );
    await p.route("**workers.dev/usgs**", (route) =>
      route.fulfill({ contentType: "application/json", body: "{}" }),
    );
    await p.route("**workers.dev/normals**", (route) =>
      route.fulfill({ contentType: "application/json", body: "{}" }),
    );
    await p.route("**workers.dev/reverse**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ label: "Tampa, FL, United States" }),
      }),
    );
    await p.route("**workers.dev/geocode**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          results: [{ lat: 27.9506, lon: -82.4572, label: "Tampa, FL, United States", detail: "Florida, United States" }],
        }),
      }),
    );
    await p.route("**workers.dev/geo**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ lat: 30.4687, lon: -87.1861, city: "Pensacola", region: "Florida", country: "US" }),
      }),
    );
    await p.route("**api.open-meteo.com**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(weatherFixture()) }),
    );
    await p.route("**api.tidesandcurrents.noaa.gov/api/**", (route) => {
      const interval = new URL(route.request().url()).searchParams.get("interval");
      route.fulfill({ contentType: "application/json", body: JSON.stringify(tideFixture(interval)) });
    });
    await p.route("**api.tidesandcurrents.noaa.gov/mdapi/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          stations: [{ id: "8726520", name: "St. Petersburg", lat: "27.773", lng: "-82.627" }],
        }),
      }),
    );
    await p.route("**api.waterdata.usgs.gov**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ features: [] }) }),
    );
    await p.route("**gis.myfwc.com**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ features: [] }) }),
    );
    await p.route("**tile.openstreetmap.org**", (route) =>
      route.fulfill({ contentType: "image/png", body: Buffer.alloc(0) }),
    );
  }
  async function printRoute(os) {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 850 } });
    await ctx.addInitScript((mockOs) => {
      localStorage.setItem("zl_tour_seen", "1"); localStorage.setItem("zl_nudge_seen", "1");
      window.__bridgeCalls = [];
      window.__winPrint = 0;
      window.print = () => {
        window.__winPrint += 1;
      };
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd) => {
          window.__bridgeCalls.push(cmd);
          if (cmd === "app_info") return "Zero Light 0.4.6 — Tauri 2";
          if (cmd === "shell_info") return { os: mockOs, arch: "arm64" };
          return null;
        },
      };
    }, os);
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    // Typed coordinates apply directly (same proven path as the main
    // flow above — no geocode round-trip involved).
    await p.fill("#place-search", "27.9506, -82.4572");
    await p.press("#place-search", "Enter");
    await p.waitForFunction(
      () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
      null,
      { timeout: 20000 },
    );
    await p.selectOption("#target", "redfish");
    await p.waitForSelector("#plan-side .hero", { timeout: 20000 });
    await p.click("#print-btn");
    await p.waitForSelector("#print-menu:not([hidden])", { timeout: 8000 });
    await p.click("#print-menu button >> nth=0");
    await p.waitForTimeout(400);
    const out = await p.evaluate(() => ({
      calls: window.__bridgeCalls,
      winPrint: window.__winPrint,
    }));
    await ctx.close();
    return out;
  }
  const prMac = await printRoute("macos");
  check(
    "#48 macOS shell prints via the native print_page command",
    prMac.calls.includes("print_page") && prMac.winPrint === 0,
  );
  const prWin = await printRoute("windows");
  check(
    "#48 Windows shell keeps window.print",
    !prWin.calls.includes("print_page") && prWin.winPrint === 1,
  );

  // v0.5.0 — #62: with a mocked iOS bridge, the phone routes work:
  // location comes from the geolocation plugin, and exports, badges,
  // and print all leave through the share sheet (an fs write into the
  // app cache folder, then plugin:zlshare|share_file) — no dialogs,
  // no browser downloads.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("zl_tour_seen", "1"); localStorage.setItem("zl_nudge_seen", "1");
      window.__bridgeCalls = [];
      window.__shareCalls = [];
      window.__fsWrites = [];
      window.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args, options) => {
          window.__bridgeCalls.push(cmd);
          if (cmd === "app_info") return "Zero Light 0.5.0 — Tauri 2";
          if (cmd === "shell_info") return { os: "ios", arch: "arm64" };
          if (cmd === "plugin:geolocation|check_permissions") {
            return { location: "granted", coarseLocation: "granted" };
          }
          if (cmd === "plugin:geolocation|request_permissions") {
            return { location: "granted", coarseLocation: "granted" };
          }
          if (cmd === "plugin:geolocation|get_current_position") {
            return {
              coords: {
                latitude: 27.9506,
                longitude: -82.4572,
                accuracy: 25,
                altitude: null,
                altitudeAccuracy: null,
                heading: null,
                speed: null,
              },
              timestamp: 1763251200000,
            };
          }
          if (cmd === "plugin:path|resolve_directory") return "/app-cache";
          if (cmd === "plugin:path|join") return args.paths.join("/");
          if (cmd === "plugin:fs|write_file") {
            const p = decodeURIComponent(options?.headers?.path ?? "");
            window.__fsWrites.push({ path: p, bytes: Array.from(args ?? []) });
            return null;
          }
          if (cmd === "plugin:zlshare|share_file") {
            window.__shareCalls.push(args);
            return null;
          }
          return null;
        },
      };
    });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.fill("#place-search", "27.9506, -82.4572");
    await p.press("#place-search", "Enter");
    await p.waitForFunction(
      () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
      null,
      { timeout: 20000 },
    );
    await p.selectOption("#target", "redfish");
    await p.waitForSelector("#plan-side .hero", { timeout: 20000 });

    // Location via the geolocation plugin; the fix reverse-labels and
    // the place applies (search box shows the Tampa label).
    await p.click("#geo-btn");
    await p.waitForFunction(
      () => window.__bridgeCalls.includes("plugin:geolocation|get_current_position"),
      null,
      { timeout: 8000 },
    );
    check("#62 iOS locate uses the geolocation plugin", true);
    await p
      .waitForFunction(
        () => document.querySelector("#place-search")?.value.includes("Tampa"),
        null,
        { timeout: 8000 },
      )
      .catch(() => {});
    const locLabel = await p.evaluate(() => document.querySelector("#place-search")?.value ?? "");
    check("#62 iOS locate applies the plugin fix", locLabel.includes("Tampa"));

    // Export this day → share sheet with a calendar file.
    await p.click("#export-day");
    await p.waitForFunction(() => window.__shareCalls.length >= 1, null, { timeout: 8000 });
    let shares = await p.evaluate(() => window.__shareCalls);
    let writes = await p.evaluate(() => window.__fsWrites);
    check(
      "#62 iOS .ics export shares a text/calendar file",
      shares[0]?.mime === "text/calendar" &&
        shares[0]?.path.endsWith("zero-light-plans.ics") &&
        writes.some((w) => w.path.endsWith("zero-light-plans.ics") && w.bytes.length > 50),
    );

    // Watch badge → share sheet with a real PNG.
    await p.click("#badge-day");
    await p.waitForSelector("#badge-menu:not([hidden])", { timeout: 8000 });
    await p.click("#badge-menu button >> nth=0");
    await p.waitForFunction(() => window.__shareCalls.length >= 2, null, { timeout: 8000 });
    shares = await p.evaluate(() => window.__shareCalls);
    writes = await p.evaluate(() => window.__fsWrites);
    const pngWrite = writes.find((w) => w.path.endsWith(".png"));
    check(
      "#62 iOS badge shares an image/png file",
      shares[1]?.mime === "image/png" &&
        !!pngWrite &&
        pngWrite.bytes[0] === 0x89 &&
        pngWrite.bytes[1] === 0x50,
    );

    // Print → share sheet with a real PDF carrying the sheet content.
    // (The menu item is clicked through evaluate: at phone size a
    // Playwright click first scrolls, and the #35 close-on-scroll
    // rule would shut the menu before the click lands.)
    await p.click("#print-btn");
    await p.waitForSelector("#print-menu:not([hidden])", { timeout: 8000 });
    await p.evaluate(() => document.querySelector("#print-menu button")?.click());
    await p.waitForFunction(() => window.__shareCalls.length >= 3, null, { timeout: 8000 });
    shares = await p.evaluate(() => window.__shareCalls);
    writes = await p.evaluate(() => window.__fsWrites);
    const pdfWrite = writes.find((w) => w.path.endsWith("zero-light-print-day.pdf"));
    const pdfHead = pdfWrite
      ? String.fromCharCode(...pdfWrite.bytes.slice(0, 6000))
      : "";
    check(
      "#62 iOS print shares an application/pdf file",
      shares[2]?.mime === "application/pdf" && !!pdfWrite,
    );
    check(
      "#62 print PDF carries the sheet content",
      pdfHead.startsWith("%PDF") && pdfHead.includes("ZERO LIGHT") && pdfHead.includes("Day rating"),
    );
    await ctx.close();
  }

  // v0.4.7 — #56: watch badges in the web build (no Tauri bridge).
  // Every badge control opens the two-row Apple/Android pop-out, and
  // picking a platform downloads a real PNG at the locked pixel size
  // (Apple 416x496 @2x = 832x992; Android 480x480 @2x = 960x960).
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
    await ctx.addInitScript(() => { localStorage.setItem("zl_tour_seen", "1"); localStorage.setItem("zl_nudge_seen", "1"); });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.fill("#place-search", "27.9506, -82.4572");
    await p.press("#place-search", "Enter");
    await p.waitForFunction(
      () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
      null,
      { timeout: 20000 },
    );
    await p.selectOption("#target", "redfish");
    await p.waitForSelector("#plan-side .hero", { timeout: 20000 });

    check("#56 planner has a Watch badge button", (await p.locator("#badge-day").count()) === 1);
    check("#56 slot card has a Watch badge link", (await p.locator(".slot-badge").count()) >= 1);

    async function badgeDownload(openMenu, platform) {
      await openMenu();
      await p.waitForSelector("#badge-menu:not([hidden])", { timeout: 8000 });
      const items = await p.locator("#badge-menu [data-badge-platform]").count();
      const dlPromise = p.waitForEvent("download", { timeout: 15000 });
      await p.click(`#badge-menu [data-badge-platform='${platform}']`);
      const dl = await dlPromise;
      const path = await dl.path();
      const buf = path ? await readFile(path) : Buffer.alloc(0);
      return {
        items,
        name: dl.suggestedFilename(),
        size: buf.length,
        w: buf.length > 24 ? buf.readUInt32BE(16) : 0,
        h: buf.length > 24 ? buf.readUInt32BE(20) : 0,
      };
    }

    const slot = await badgeDownload(() => p.click(".slot-badge >> nth=0"), "apple");
    check("#56 badge menu has exactly the Apple and Android rows", slot.items === 2);
    check(
      "#56 slot badge downloads an 832x992 PNG",
      /zero-light-badge-slot-apple-.*\.png$/.test(slot.name) && slot.size > 2000 && slot.w === 832 && slot.h === 992,
    );

    const day = await badgeDownload(() => p.click("#badge-day"), "apple");
    check(
      "#56 planner day badge downloads a PNG",
      /zero-light-badge-day-apple-.*\.png$/.test(day.name) && day.size > 2000 && day.w === 832 && day.h === 992,
    );

    await p.click('#view-picker .chip[data-view="trends"]');
    await p.waitForFunction(() => document.querySelectorAll("#trends .day-block").length >= 30, null, {
      timeout: 20000,
    });
    check("#56 trends has a Week badge button", (await p.locator("#badge-week").count()) === 1);
    const week = await badgeDownload(() => p.click("#badge-week"), "apple");
    check(
      "#56 week badge downloads a PNG",
      /zero-light-badge-week-apple-.*\.png$/.test(week.name) && week.size > 2000 && week.w === 832 && week.h === 992,
    );

    // Day detail in the desktop panel: compact labels + badge button,
    // and the Android badge is a 960x960 PNG.
    await p.click("#trends .day-block >> nth=2");
    await p.waitForSelector("#day-panel .badge-this-day", { timeout: 8000 });
    const planLabel = await p.locator("#day-panel .plan-this-day").textContent();
    const exportLabel = await p.locator("#day-panel .export-this-day").textContent();
    check(
      "#56 day panel uses the compact action labels",
      planLabel?.trim() === "Plan" && exportLabel?.trim() === "Export (.ics)",
    );
    const panelDay = await badgeDownload(() => p.click("#day-panel .badge-this-day"), "android");
    check(
      "#56 day-panel Android badge downloads a 960x960 PNG",
      /zero-light-badge-day-android-.*\.png$/.test(panelDay.name) && panelDay.size > 2000 && panelDay.w === 960 && panelDay.h === 960,
    );

    // v0.4.8 — #58: Plan / Export / Badge labels never wrap; they
    // shrink to fit (fitActionButtons). Every visible action button's
    // label must be exactly one line with no horizontal overflow.
    async function assertOneLine(scopeSel, label) {
      const res = await p.evaluate((sel) => {
        const out = [];
        document.querySelectorAll(sel).forEach((btn) => {
          if (!btn.clientWidth) return;
          const r = document.createRange();
          r.selectNodeContents(btn);
          out.push({
            lines: r.getClientRects().length,
            fits: btn.scrollWidth <= btn.clientWidth + 1,
          });
        });
        return out;
      }, scopeSel);
      check(
        `#58 ${label}: labels on one line, no overflow`,
        res.length > 0 && res.every((b) => b.lines === 1 && b.fits),
      );
    }
    // The row itself must also fit its container (flex overflow would
    // clip the last button even with every label on one line).
    async function assertRowFits(rowSel, label) {
      const res = await p.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el || !el.clientWidth) return null;
        return { sw: el.scrollWidth, cw: el.clientWidth };
      }, rowSel);
      check(`#58 ${label}: row fits its container`, !!res && res.sw <= res.cw + 1);
    }
    await assertOneLine("#trends .export-row > button", "trends export row");
    await assertRowFits("#trends .export-row", "trends export row");
    await assertOneLine("#day-panel .modal-actions > button", "day panel actions");
    await assertRowFits("#day-panel .modal-actions", "day panel actions");
    // Planner export row (switch views first).
    await p.click("#view-picker [data-view='planner']");
    await p.waitForSelector("#badge-day", { state: "visible", timeout: 8000 });
    await assertOneLine("#planner .export-row > button", "planner export row");
    await assertRowFits("#planner .export-row", "planner export row");
    await p.click("#view-picker [data-view='trends']");
    await p.waitForSelector("#badge-week", { state: "visible", timeout: 8000 });
    // Day modal at phone width.
    await p.setViewportSize({ width: 390, height: 844 });
    await p.click("#trends .day-block >> nth=1");
    await p.waitForSelector("#day-modal .modal-actions > button", { state: "visible", timeout: 8000 });
    await assertOneLine("#day-modal .modal-actions > button", "day modal actions (phone)");
    await assertRowFits("#day-modal .modal-actions", "day modal actions (phone)");
    await p.click("#day-modal .modal-close");
    await p.setViewportSize({ width: 1440, height: 950 });
    await p.waitForTimeout(200);
    // Stress: a 25% larger root font (wider-metrics stand-in) must not
    // wrap anything either — the resize refit shrinks the labels. The
    // viewport widens too, so the 75em tier (now 1500px) still applies
    // and the day panel stays in its desktop form.
    await p.addStyleTag({ content: "html { font-size: 20px !important; }" });
    await p.setViewportSize({ width: 1600, height: 950 });
    // Re-open the day panel under the stressed metrics (a view switch
    // resets the panel to its skeleton, so it must be repopulated).
    await p.click("#trends .day-block >> nth=2");
    await p.waitForSelector("#day-panel .badge-this-day", { state: "visible", timeout: 8000 });
    await p.evaluate(() => window.dispatchEvent(new Event("resize")));
    await p.waitForTimeout(200);
    await assertOneLine("#trends .export-row > button", "trends export row under font stress");
    await assertRowFits("#trends .export-row", "trends export row under font stress");
    await assertOneLine("#day-panel .modal-actions > button", "day panel actions under font stress");
    await assertRowFits("#day-panel .modal-actions", "day panel actions under font stress");

    // v0.4.9 — #59: badge controls inside the Trends day detail were
    // dead. Two causes: the badge menu (z-index 40) opened UNDER the
    // day modal (backdrop z-index 50), and placeMenu always opened
    // downward, running off the viewport bottom for low anchors.
    // Undo the font stress, then exercise the modal form for real:
    // Playwright's click actionability fails if the menu is covered.
    await p.addStyleTag({ content: "html { font-size: 16px !important; }" });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.click("#trends .day-block >> nth=1");
    await p.waitForSelector("#day-modal .badge-this-day", { state: "visible", timeout: 8000 });
    const modalDay = await badgeDownload(() => p.click("#day-modal .badge-this-day"), "apple");
    check(
      "#59 day-modal day badge downloads an 832x992 PNG",
      /zero-light-badge-day-apple-.*\.png$/.test(modalDay.name) && modalDay.w === 832 && modalDay.h === 992,
    );
    const modalSlot = await badgeDownload(() => p.click("#day-modal .slot-badge >> nth=0"), "android");
    check(
      "#59 day-modal slot badge downloads a 960x960 PNG",
      /zero-light-badge-slot-android-.*\.png$/.test(modalSlot.name) && modalSlot.w === 960 && modalSlot.h === 960,
    );
    await p.click("#day-modal .modal-close");
    // Flip: in a short desktop window, a slot badge low in the day
    // panel must open its menu INSIDE the viewport (above the link).
    await p.setViewportSize({ width: 1440, height: 520 });
    await p.click("#trends .day-block >> nth=2");
    await p.waitForSelector("#day-panel .badge-this-day", { state: "visible", timeout: 8000 });
    const panelSlots = await p.locator("#day-panel .slot-badge").count();
    check("#59 panel has slot badge links for the flip test", panelSlots >= 2);
    await p.click(`#day-panel .slot-badge >> nth=${panelSlots - 1}`);
    await p.waitForSelector("#badge-menu:not([hidden])", { timeout: 8000 });
    const menuBox = await p.evaluate(() => {
      const r = document.querySelector("#badge-menu").getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, ih: window.innerHeight };
    });
    check(
      "#59 badge menu opens inside the viewport for a low anchor",
      menuBox.top >= 0 && menuBox.bottom <= menuBox.ih,
    );
    await p.keyboard.press("Escape");
    const flipSlot = await badgeDownload(() => p.click(`#day-panel .slot-badge >> nth=${panelSlots - 1}`), "apple");
    check(
      "#59 low panel slot badge downloads an 832x992 PNG",
      /zero-light-badge-slot-apple-.*\.png$/.test(flipSlot.name) && flipSlot.w === 832 && flipSlot.h === 992,
    );

    // #65: the pheasant is the one right-facing stencil; its badge
    // draw is mirrored so the head lands on-canvas. Download a
    // pheasant day badge and sample the strip where the mirrored
    // head sits (logical x 90–260, y 124–165 of the 416×496 badge —
    // above the text zone): it must hold stencil pixels, where the
    // unmirrored draw left only the background color.
    await p.evaluate(() => {
      const cur = JSON.parse(localStorage.getItem("zl_enabled_targets") ?? "[]");
      if (!cur.includes("pheasant")) {
        cur.push("pheasant");
        localStorage.setItem("zl_enabled_targets", JSON.stringify(cur));
      }
    });
    await p.reload({ waitUntil: "load" });
    await p.fill("#place-search", "27.9506, -82.4572");
    await p.press("#place-search", "Enter");
    await p.waitForFunction(
      () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
      null,
      { timeout: 20000 },
    );
    await p.selectOption("#target", "pheasant");
    await p.waitForSelector("#plan-side .hero", { timeout: 20000 });
    await p.click("#badge-day");
    await p.waitForSelector("#badge-menu:not([hidden])", { timeout: 8000 });
    const phezDlPromise = p.waitForEvent("download", { timeout: 15000 });
    await p.click("#badge-menu [data-badge-platform='apple']");
    const phezDl = await phezDlPromise;
    const phezPath = await phezDl.path();
    const phezBuf = phezPath ? await readFile(phezPath) : Buffer.alloc(0);
    const headPixels = await p.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = "data:image/png;base64," + b64;
      });
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const cx = cv.getContext("2d");
      if (!cx) return -1;
      cx.drawImage(img, 0, 0);
      const bg = cx.getImageData(8, 8, 1, 1).data;
      // @2x pixels: strip x 180–520, y 248–330 (logical 90–260, 124–165).
      const data = cx.getImageData(180, 248, 340, 82).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - bg[0]) >= 10 ||
          Math.abs(data[i + 1] - bg[1]) >= 10 ||
          Math.abs(data[i + 2] - bg[2]) >= 10
        )
          n++;
      }
      return n;
    }, phezBuf.toString("base64"));
    check("#65 pheasant badge shows its head (mirrored draw)", headPixels > 200);
    await ctx.close();
  }

  // #66: a settings save whose writes do not stick (a browser context
  // that refuses site data — the settings then reset on the next
  // reload, Wade's #66 report) must still apply for the session and
  // still close Settings, with the failure reported on a dismissible
  // card on the main screen instead of silently. (The badge share-
  // sheet route first built for #66 was dropped at Wade's direction;
  // web badges keep the plain download.)
  {
    // Storage that silently drops the targets write: the save must
    // still apply for the session, still close Settings and return to
    // the main screen with the updated dropdown (#66 revised per Wade),
    // and report the failure on a dismissible card there.
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 850 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("zl_tour_seen", "1"); localStorage.setItem("zl_nudge_seen", "1");
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (k === "zl_enabled_targets") return; // silently dropped
        return orig.call(this, k, v);
      };
    });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.click("#settings-btn");
    await p.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
    await p.click('[data-acc-head="targets"]');
    await p.uncheck('#target-groups input[data-target-id="redfish"]');
    await p.click("#save-settings");
    await p.waitForSelector("#settings-modal[hidden]", { state: "attached", timeout: 8000 });
    await p.waitForSelector("#save-warn-card:not([hidden])", { timeout: 8000 });
    const applied = await p.evaluate(
      () =>
        ![...document.querySelectorAll("#target option")].some(
          (o) => o.value === "redfish",
        ),
    );
    check(
      "#66 a save that does not stick still applies, closes, and warns on the main screen",
      applied,
    );
    await p.click("#save-warn-close");
    const dismissed = await p.evaluate(
      () => document.querySelector("#save-warn-card")?.hidden === true,
    );
    check("#66 the save-warning card dismisses", dismissed);
    await ctx.close();
  }

  // #67: the Layer 1 cache shares the localStorage bucket with the
  // settings and, before #67, grew until the browser capped it — after
  // which settings writes threw QuotaExceededError (Wade's Safari).
  // Two behaviours: the startup sweep drops entries expired beyond the
  // 7-day grace but keeps recent ones (offline stale fallback); and a
  // settings save refused for quota frees cache space and retries, so
  // the save succeeds instead of warning.
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 850 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("zl_tour_seen", "1"); localStorage.setItem("zl_nudge_seen", "1");
      const now = Date.now();
      const entry = (t, exp) =>
        JSON.stringify({ t, exp, data: { seeded: true } });
      localStorage.setItem("zl_cache_old", entry(now - 31 * 86400_000, now - 30 * 86400_000));
      localStorage.setItem("zl_cache_recent", entry(now - 3600_000, now - 3600_000));
      localStorage.setItem("zl_cache_fresh", entry(now, now + 86400_000));
    });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    const swept = await p.evaluate(() => ({
      old: localStorage.getItem("zl_cache_old"),
      recent: localStorage.getItem("zl_cache_recent") !== null,
      fresh: localStorage.getItem("zl_cache_fresh") !== null,
    }));
    check(
      "#67 startup sweep drops long-expired cache entries, keeps recent ones",
      swept.old === null && swept.recent && swept.fresh,
    );
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 850 } });
    await ctx.addInitScript(() => {
      // A bucket with no room for settings-sized writes: a settings
      // write throws QuotaExceededError while the seeded filler cache
      // entry (the oldest thing in the bucket) is still present.
      localStorage.setItem(
        "zl_cache_filler",
        JSON.stringify({ t: 1000, exp: Date.now() + 86400_000, data: { seeded: true } }),
      );
      localStorage.setItem("zl_tour_seen", "1"); localStorage.setItem("zl_nudge_seen", "1");
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (
          !String(k).startsWith("zl_cache_") &&
          localStorage.getItem("zl_cache_filler") !== null
        ) {
          const err = new Error("The quota has been exceeded.");
          err.name = "QuotaExceededError";
          throw err;
        }
        return orig.call(this, k, v);
      };
    });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.click("#settings-btn");
    await p.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
    await p.click('[data-acc-head="targets"]');
    await p.uncheck('#target-groups input[data-target-id="redfish"]');
    await p.click("#save-settings");
    await p.waitForSelector("#settings-modal[hidden]", { state: "attached", timeout: 8000 });
    const healed = await p.evaluate(() => ({
      warned: !document.querySelector("#save-warn-card")?.hidden,
      stored: localStorage.getItem("zl_enabled_targets") ?? "",
      filler: localStorage.getItem("zl_cache_filler"),
    }));
    check(
      "#67 a settings save refused for quota frees cache space and succeeds",
      !healed.warned &&
        healed.stored.includes('"catfish"') &&
        !healed.stored.includes('"redfish"') &&
        healed.filler === null,
    );
    await ctx.close();
  }

  // #68: the guided tour (7 stops, first open only, re-openable from
  // the \u24d8 menu) and the "more targets" nudge (once, 3 s after the
  // first-ever dropdown pick, Option B presentation). These contexts
  // are deliberately NOT seeded with the seen flags.
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.waitForSelector("#tour-layer:not([hidden])", { timeout: 8000 });
    const t1 = await p.textContent("#tour-title");
    const c1 = await p.textContent("#tour-count");
    check("#68 tour auto-starts on first open at step 1 of 7", t1 === "Find your place" && c1 === "Step 1 of 7");
    await p.click("#tour-next");
    check("#68 Next advances to the target stop", (await p.textContent("#tour-title")) === "Pick a target");
    await p.click("#tour-back");
    check("#68 Back returns to step 1", (await p.textContent("#tour-title")) === "Find your place");
    for (let i = 0; i < 5; i++) await p.click("#tour-next");
    check("#68 stop 6 headline is the targets job", (await p.textContent("#tour-title")) === "Add or remove targets here");
    await p.click("#tour-next");
    const doneLabel = await p.textContent("#tour-next");
    const skipVisible = await p.locator("#tour-left").isVisible();
    check("#68 last stop offers Done and no Skip", doneLabel === "Done" && !skipVisible);
    await p.click("#tour-next");
    await p.waitForSelector("#tour-layer[hidden]", { state: "attached", timeout: 8000 });
    check("#68 finishing the tour marks it seen", (await p.evaluate(() => localStorage.getItem("zl_tour_seen"))) === "1");
    await p.reload({ waitUntil: "load" });
    await p.waitForTimeout(700);
    check("#68 the tour does not auto-start again", (await p.evaluate(() => document.querySelector("#tour-layer")?.hidden)) === true);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("zl_tour_seen", "1");
      localStorage.setItem("zl_nudge_seen", "1");
    });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.click("#info-btn");
    await p.waitForSelector("#info-menu:not([hidden])", { timeout: 8000 });
    check("#68 the info menu leads with How to use Zero Light", (await p.textContent("#menu-tour")) === "How to use Zero Light");
    // Menu items are clicked via evaluate: a real click scrolls first
    // at phone size and the #35 close-on-scroll rule shuts the menu.
    await p.evaluate(() => document.querySelector("#menu-tour").click());
    await p.waitForSelector("#tour-layer:not([hidden])", { timeout: 8000 });
    check("#68 the menu row restarts the tour", (await p.textContent("#tour-title")) === "Find your place");
    await p.click("#tour-left");
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.waitForSelector("#tour-layer:not([hidden])", { timeout: 8000 });
    await p.click("#tour-left"); // skip the tour
    await p.waitForSelector("#tour-layer[hidden]", { state: "attached", timeout: 8000 });
    await p.fill("#place-search", "27.9506, -82.4572");
    await p.press("#place-search", "Enter");
    await p.waitForFunction(
      () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
      null,
      { timeout: 20000 },
    );
    await p.selectOption("#target", "redfish");
    await p.waitForSelector("#tour-layer:not([hidden])", { timeout: 9000 });
    const nb = await p.textContent("#tour-body");
    check(
      "#68 the nudge fires after the first pick with the live counts",
      (await p.textContent("#tour-title")) === "Want more targets?" && (nb ?? "").includes("10 of 25"),
    );
    await p.click("#tour-left"); // Not now
    await p.waitForSelector("#tour-layer[hidden]", { state: "attached", timeout: 8000 });
    check("#68 Not now marks the nudge seen", (await p.evaluate(() => localStorage.getItem("zl_nudge_seen"))) === "1");
    await p.selectOption("#target", "snapper");
    await p.waitForTimeout(3600);
    check("#68 the nudge never fires twice", (await p.evaluate(() => document.querySelector("#tour-layer")?.hidden)) === true);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.waitForSelector("#tour-layer:not([hidden])", { timeout: 8000 });
    await p.click("#tour-left");
    await p.waitForSelector("#tour-layer[hidden]", { state: "attached", timeout: 8000 });
    await p.fill("#place-search", "27.9506, -82.4572");
    await p.press("#place-search", "Enter");
    await p.waitForFunction(
      () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
      null,
      { timeout: 20000 },
    );
    await p.selectOption("#target", "redfish");
    await p.waitForSelector("#tour-layer:not([hidden])", { timeout: 9000 });
    await p.click("#tour-next"); // Open Settings
    await p.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
    check(
      "#68 the nudge's Open Settings lands on the Targets section, expanded",
      (await p.evaluate(() => document.querySelector('[data-acc-body="targets"]')?.hidden)) === false,
    );
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("zl_tour_seen", "1");
      localStorage.setItem("zl_enabled_targets", JSON.stringify(["redfish"]));
    });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.fill("#place-search", "27.9506, -82.4572");
    await p.press("#place-search", "Enter");
    await p.waitForFunction(
      () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
      null,
      { timeout: 20000 },
    );
    await p.selectOption("#target", "redfish");
    await p.waitForTimeout(3600);
    check("#68 no nudge when targets were already customized", (await p.evaluate(() => document.querySelector("#tour-layer")?.hidden)) === true);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await mockRoutesFor(p);
    await p.goto("http://localhost:4173/", { waitUntil: "load" });
    await p.waitForSelector("#tour-layer:not([hidden])", { timeout: 8000 });
    await p.click("#tour-left"); // skip the auto-started tour
    await p.waitForSelector("#tour-layer[hidden]", { state: "attached", timeout: 8000 });
    await p.fill("#place-search", "27.9506, -82.4572");
    await p.press("#place-search", "Enter");
    await p.waitForFunction(
      () => document.querySelector("#planner")?.textContent?.includes("Pick a target to see best times"),
      null,
      { timeout: 20000 },
    );
    await p.selectOption("#target", "redfish"); // arms the 3 s timer
    // Restart the tour from the menu before the timer lands.
    await p.evaluate(() => document.querySelector("#info-btn").click());
    await p.evaluate(() => document.querySelector("#menu-tour").click());
    await p.waitForSelector("#tour-layer:not([hidden])", { timeout: 8000 });
    await p.waitForTimeout(3400); // the timer fires during the tour
    check("#68 the nudge waits while the tour is up", (await p.textContent("#tour-title")) === "Find your place");
    await p.click("#tour-left"); // skip the tour — the nudge shows now
    await p.waitForFunction(
      () => document.querySelector("#tour-title")?.textContent === "Want more targets?",
      null,
      { timeout: 8000 },
    );
    check("#68 the nudge shows when the tour ends", true);
    await p.click("#tour-left");
    await ctx.close();
  }
} catch (err) {
  console.log("ERROR", err.message);
  failures.push("exception: " + err.message);
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.log(`\nUI CHECK FAILED (${failures.length})`);
  process.exit(1);
}
console.log("\nUI CHECK: ALL PASS");
