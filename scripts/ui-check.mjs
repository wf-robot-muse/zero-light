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

  // #24: target list = disabled placeholder + alphabetical 11.
  const optionTexts = await page.locator("#target option").allTextContents();
  check("target select has placeholder + 11 targets", optionTexts.length === 12);
  check("first option is the placeholder", optionTexts[0] === "Choose a target…");
  check(
    "targets are the alphabetical 11 (no Catfish/Crappie)",
    JSON.stringify(optionTexts.slice(1)) ===
      JSON.stringify([
        "Cobia", "Flounder", "Grouper", "Largemouth Bass", "Redfish",
        "Snapper", "Snook", "Speckled Trout", "Turkey", "Waterfowl", "Whitetail Deer",
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
  check("no bulk export while gated", (await page.locator("#export-all").count()) === 0);
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
  check("trends offers bulk export", (await page.locator("#export-all").count()) === 1);

  // Day detail modal opens from a trends cell (below 75em).
  await page.click("#trends .day-block >> nth=2");
  await page.waitForSelector("#day-modal:not([hidden])", { timeout: 8000 });
  check("day modal opens", await page.locator("#day-modal").isVisible());
  check("day modal has Plan this day", (await page.locator("#day-modal .plan-this-day").count()) === 1);
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
