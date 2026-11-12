// UI regression check (next-build item #6; extended for v0.3.0 #17/#18/#20).
//
// The v0.1.0 startup bug passed the engine-only smoke test (24/24)
// because nothing ever rendered the app. This check serves the built
// dist/ headlessly, intercepts the data APIs (including the Layer 2
// Worker) with deterministic fixtures, and asserts the interface
// actually populates: first-run empty state, unified location search
// (coordinates / pick list / geolocation), planner verdict, trends
// strip, day-detail modal, slimmed settings modal, ⓘ menu with the
// explainer and the About & credits modal, map panel, and last-place
// restore after reload.
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
  check("no preset location dropdown remains", (await page.locator("#location").count()) === 0);
  check("unified search box exists", (await page.locator("#place-search").count()) === 1);

  // First-run state (#17): no default location, empty-state card.
  await page.waitForFunction(
    () => document.querySelector("#planner")?.textContent?.includes("Enter a location"),
    null,
    { timeout: 10000 },
  );
  check("first run shows the enter-a-location state", true);

  // Typed coordinates apply directly and load the planner.
  await page.fill("#place-search", "27.9506, -82.4572");
  await page.press("#place-search", "Enter");
  await page.waitForFunction(
    () => document.querySelector("#planner")?.textContent?.includes("Day:"),
    null,
    { timeout: 20000 },
  );
  const plannerText = await page.textContent("#planner");
  check("planner shows a day verdict after coordinate search", plannerText.includes("Day:"));
  check(
    "planner shows slots or the no-window note",
    (await page.locator("#planner .slot").count()) > 0 || plannerText.includes("No window"),
  );
  check("planner offers calendar export", (await page.locator("#export-day").count()) === 1);

  // Trends populates with 30 day blocks.
  await page.click('#view-picker .chip[data-view="trends"]');
  await page.waitForFunction(
    () => document.querySelectorAll("#trends .day-block").length >= 30,
    null,
    { timeout: 15000 },
  );
  check("trends renders 30 day blocks", (await page.locator("#trends .day-block").count()) >= 30);
  check("trends offers bulk export", (await page.locator("#export-all").count()) === 1);

  // Day detail modal opens from a trends cell.
  await page.click("#trends .day-block >> nth=2");
  await page.waitForSelector("#day-modal:not([hidden])", { timeout: 8000 });
  check("day modal opens", await page.locator("#day-modal").isVisible());
  check("day modal has Plan this day", (await page.locator("#plan-this-day").count()) === 1);
  await page.click('#day-modal .modal-close');

  // Settings modal — v0.3.0: key/endpoint fields are GONE (#20).
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
  check("settings modal opens", await page.locator("#settings-modal").isVisible());
  check("settings has no USGS key field", (await page.locator("#usgs-key").count()) === 0);
  check("settings has no NCEI token field", (await page.locator("#ncei-token").count()) === 0);
  check("settings has no cache endpoint field", (await page.locator("#cache-endpoint").count()) === 0);
  check("settings keeps export toggles", (await page.locator("#export-typical").count()) === 1);
  await page.click('#settings-modal .modal-close');

  // ⓘ menu (#18): How ratings work + About & credits.
  await page.click("#info-btn");
  await page.waitForSelector("#info-menu:not([hidden])", { timeout: 8000 });
  check("info menu opens from the ⓘ", await page.locator("#info-menu").isVisible());
  await page.click("#menu-how");
  await page.waitForSelector("#info-modal:not([hidden])", { timeout: 8000 });
  const infoText = await page.textContent("#info-modal");
  check("explainer explains pressure cap", infoText.includes("Pressure trend"));
  check("explainer states solunar zero rule", infoText.includes("ZERO"));
  await page.click('#info-modal .modal-close');

  await page.click("#info-btn");
  await page.waitForSelector("#info-menu:not([hidden])", { timeout: 8000 });
  await page.click("#menu-about");
  await page.waitForSelector("#about-modal:not([hidden])", { timeout: 8000 });
  const aboutText = await page.textContent("#about-modal");
  check("about credits Geoapify", aboutText.includes("Geoapify"));
  check("about credits OpenStreetMap", aboutText.includes("OpenStreetMap"));
  check("about carries the settled disclaimer", aboutText.includes("planning guidance only"));
  check("about carries All Rights Reserved", aboutText.includes("All Rights Reserved"));
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

  // Last location persists across reload (#17).
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(
    () => document.querySelector("#planner")?.textContent?.includes("Day:"),
    null,
    { timeout: 20000 },
  );
  check("last location auto-loads after reload", true);
  check(
    "search box restored to the saved label",
    (await page.inputValue("#place-search")).includes("Tampa"),
  );
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
