// UI regression check (next-build item #6).
//
// The v0.1.0 startup bug passed the engine-only smoke test (24/24)
// because nothing ever rendered the app. This check serves the built
// dist/ headlessly, intercepts the data APIs with deterministic
// fixtures, and asserts the interface actually populates: planner
// verdict, trends strip, day-detail modal, settings modal, explainer.
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
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));

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

  await page.goto("http://localhost:4173/", { waitUntil: "load" });

  check("title is Zero Light", (await page.title()).startsWith("Zero Light"));

  // Planner populates — the assertion v0.1.0 would have failed.
  await page.waitForFunction(
    () => document.querySelector("#planner")?.textContent?.includes("Day:"),
    null,
    { timeout: 20000 },
  );
  const plannerText = await page.textContent("#planner");
  check("planner shows a day verdict", plannerText.includes("Day:"));
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

  // Settings modal (gear) and explainer (info) open.
  await page.click("#settings-btn");
  await page.waitForSelector("#settings-modal:not([hidden])", { timeout: 8000 });
  check("settings modal opens with key fields", (await page.locator("#usgs-key").count()) === 1);
  await page.click('#settings-modal .modal-close');

  await page.click("#info-btn");
  await page.waitForSelector("#info-modal:not([hidden])", { timeout: 8000 });
  const infoText = await page.textContent("#info-modal");
  check("explainer explains pressure cap", infoText.includes("Pressure trend"));
  check("explainer states solunar zero rule", infoText.includes("ZERO"));
  await page.click('#info-modal .modal-close');
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
