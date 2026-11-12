# Fishing and Hunting Predictor — Change / Issues List for the Next Build

Running list, started 2026-11-11 at Wade's direction. Same practice as
GoodEnoughCraft's list: log items as they come in (defects and change
requests), numbered continuously; fixes land in the next build unless Wade
says otherwise.

**Current build:** v0.1.1 (startup fix; GitHub Release PUBLISHED
2026-11-11 as Latest, both Windows installers attached —
https://github.com/wf-robot-muse/fishing-hunting-predictor/releases/tag/v0.1.1.
CI run #2: Windows job passed; the macOS/Linux jobs stalled on GitHub
runner infrastructure (macOS runner never acquired, Linux dependency
install hung), were cancelled, and a re-run of those three jobs was
triggered 2026-11-11. Re-run result: Windows passed again; both Linux
jobs failed after ~80 min with exit code 100 (which step produced it
is unverified — the job logs could not be opened); the macOS job
again never acquired a runner (GitHub arm64 capacity). **Wade's
decision (2026-11-11): leave v0.1.1 Windows-only for now** — macOS/
Linux deferred, no third re-run, no investigation. The published
release is unaffected.)
**Superseded:** v0.1.0 — DO NOT INSTALL (startup bug: planner never loaded;
fixed in v0.1.1)
**Repo:** https://github.com/wf-robot-muse/fishing-hunting-predictor

**Status update (2026-11-12):** v0.2.0 (Zero Light) SHIPPED — repo
renamed to wf-robot-muse/zero-light; items #1–#16 built; CI run #6
fully green with Windows signing verified; Release v0.2.0 published
as Latest with both signed Windows installers; GitHub Pages freshly
deployed and verified live. The list continues at #17 below for the
next round.

## Seeded items — known v1 simplifications and roadmap (from the research and README)

1. **Wire the USGS Water Data OGC API** (api.waterdata.usgs.gov — the new
   API only; the legacy service is being decommissioned). Real-time water
   temperature, discharge, and turbidity from gauges near the chosen
   location, replacing the air-temperature proxy the fish bands use in v1.
   Uses the registered USGS key from local app settings only — the repo is
   public, keys are never committed.
2. **Live red tide / HAB veto feed.** Florida FWC-FWRI ArcGIS first; the
   veto engine already exists and currently only triggers on dangerous
   wind. Add state/EPA sources for other regions as available (there is no
   single national real-time HAB API).
3. **Per-state season and rut tables** (static ingests for AL, FL, GA, MS,
   TX) replacing the generic month windows for hunting targets. Tennessee
   publishes no rut/conception data — a known hole; do not interpolate.
4. **Tides for any coastal or custom location.** Automatically select the
   nearest NOAA CO-OPS station instead of wiring tides only to the Tampa
   preset.
5. **Location-local times.** Slot, sunrise, and sunset times should display
   in the chosen location's timezone, not the device's timezone.
6. **UI-level regression test in CI.** v0.1.0's startup bug passed the
   engine-only smoke test (24/24) because nothing rendered the app. Add a
   headless render check asserting the planner populates (mocked data) so
   this class of bug fails CI.
7. **NCEI wiring.** Use the registered CDO token (local settings only) and
   1991–2020 normals behind the Trends view's "typical for this date" days.
8. **Code-sign the Windows installers — DECIDED (Wade, 2026-11-11).**
   Sign with the **same self-signed certificate used for
   GoodEnoughCraft**: CN=Wade Feltman, SHA-256 fingerprint
   AF:FA:FC:91:08:15:72:F0:81:C9:F0:78:3A:59:59:5E:61:F4:BE:00:D8:F3:77:CA:55:82:DD:3D:52:CE:62:B3
   (valid to 2036-11-07). Wade's standing rule from the same date: use
   this certificate for **all** app builds where signing is needed,
   going forward. Wiring follows the GoodEnoughCraft pattern: the
   encrypted PFX committed at `signing/wade-feltman-codesign.pfx` in
   this repo, the PFX password as the repo secret
   `WINDOWS_CERT_PASSWORD`, CI signs the installers (osslsigncode +
   DigiCert timestamp, as in GoodEnoughCraft) and fails the build if
   the signing fingerprint does not match the published one. Known
   limit (unchanged): self-signing is tamper evidence only — SmartScreen
   may still warn on machines that have not installed/trusted the cert.
   **License — DECIDED (Wade, 2026-11-11):** no open-source license;
   **All Rights Reserved**, © Wade Feltman. Add a LICENSE file stating
   copyright and all-rights-reserved (public to view, no reuse rights)
   plus a matching line in the README, in the next push. (Wade can
   relicense his own code later; nothing granted meanwhile.)
9. **Commercial-launch weather source.** Open-Meteo's free tier is
   non-commercial development use. Before any commercial release, switch
   the default US weather source to NWS api.weather.gov or move to a paid
   plan. (Options analysis presented to Wade 2026-11-11: NWS free and
   commercial-safe but US-only and its hourly forecast has no pressure
   field; Open-Meteo paid is a zero-rework drop-in at per-call cost;
   other commercial APIs need field rework; a hybrid is possible.
   **DECIDED (Wade, 2026-11-11): stay as-is for now** — Open-Meteo free
   tier remains the weather source while the app is non-commercial;
   revisit only if/when a commercial launch is planned. Paid-tier costs
   checked 2026-11-11 from official pricing pages: Open-Meteo Standard
   1M calls/mo ≈ $29/mo and Professional 5M ≈ $99/mo (plan budgets
   official; dollar figures tracker-reported, not sighted on the
   official page), commercial licence included, same API — the
   zero-rework option. WeatherAPI.com: free tier 100K calls/mo allows
   commercial use; Starter $7/mo for 3M calls (but field rework, and
   7-day forecast at that tier). Visual Crossing: free 1,000
   records/day, commercial with attribution; metered $0.0001/record
   after that (a full forecast = 1 record — very cheap for this app);
   Professional $35/mo for 10M records. OpenWeather: hourly forecast
   via subscription starts at Developer $180/mo; One Call is
   $0.0015/call after 1,000 free/day. Tomorrow.io publishes no paid
   prices (sales only). Granularity/span comparison (official docs,
   checked 2026-11-11): Open-Meteo is first or tied-first in every
   category that matters to this app — longest hourly forecast horizon
   (16 days), 15-minute data native in North America, 1–2 km regional
   models, hourly pressure_msl (which NWS lacks), and the deepest
   hourly history (ERA5 reanalysis to 1940; gated to Professional+ on
   commercial plans). Visual Crossing is the strongest challenger
   (15-day hourly, observations-based history to 1970, metered pricing
   that suits forecasts). WeatherAPI reaches 14 days but its
   "history" (to 2010) is archived forecasts, not actuals. OpenWeather
   is the weakest fit (48-hour hourly ceiling in One Call). Tomorrow.io's
   headline figures collapse on inspection (sub-hourly only ±6 h and
   Enterprise-only; deep archive is a bespoke sales purchase). NWS:
   2.5 km grids, 7-day hourly, no pressure, no history in-API (NCEI
   covers history under item #7). Conclusion recorded: the comparison
   reinforces the stay-as-is decision; Visual Crossing is the named
   fallback if observations-based deep history ever becomes an in-app
   requirement. **Reaffirmed by Wade, 2026-11-11, after the
   granularity/span comparison: stay as-is with Open-Meteo
   (option 1).**)

## Wade's test findings and change requests on v0.1.1

10. **Location entry options (Wade, 2026-11-11).** Add ways to set the
    location beyond presets and typed lat/lon:
    - **Device geolocation** — use the device's available location data
      ("Near me"), with a permission prompt and the detected place shown
      before applying.
    - **ZIP code lookup** — enter a US ZIP, resolve to its coordinates
      (ZIP centroid) with city/state shown for confirmation.
    - **Map picker** — pick coordinates by dropping/dragging a pin on a
      map, with a live coordinate readout.
    All three resolve to the same internal lat/lon the current Custom mode
    uses, so scoring and tide logic are unchanged; pairs naturally with
    item #4 (nearest tide station). Mockups requested by Wade and prepared
    2026-11-11; **all three mockups approved by Wade, 2026-11-11.**

11. **Day detail in Trends — hover tooltip + click modal (Wade, 2026-11-11;
    design APPROVED by Wade the same day: hover tooltip plus click for
    full details, as in Mockup D).**
    Hovering a day block shows a compact tooltip (band, best window,
    high/low, wind, rain chance); clicking a day opens a detail modal:
    all of that day's slots with reasons, day verdict and held-back line,
    weather summary (high/low, pressure + trend, wind, rain chance, cloud),
    sunrise/sunset and moon, tide events on saltwater, and a "plan this
    day" action (extends the Planner beyond today/+1/+2 to the clicked
    day). No new data feeds needed — the app already computes a full day
    plan per trend day and currently displays only its band. Typical
    (beyond-forecast) days show astronomy + season only and say so.
    Mockup prepared 2026-11-11.

12. **Calendar export from all three views (Wade, 2026-11-11).** Give the
    user a download/export option for calendar events in Google Calendar,
    Outlook, and .ics formats, offered from:
    - the **Planner view** (the displayed day's slots),
    - the **overall Trends view** (the visible range — week or month),
    - the **individual full day view** (item #11's modal).
    Event content: one event per slot — title carries the label and target
    (e.g. "★ Best — Redfish, Tampa Bay, FL"), timed to the slot, with the
    reason line, day verdict, and location in the description.
    **Default scope (clarified and confirmed by Wade, 2026-11-11):** ALL
    forecast days export by default, whatever their band — Excellent,
    Good, Fair, or Poor — because they are real forecast days with real
    slots. There are NO band toggles. The only inclusion toggles are the
    two special cases below (typical days, Don't-go days).
    Implementation facts that shape the design (checked 2026-11-11):
    - **.ics** is generated in the app and downloaded; a single .ics file
      can hold many events, so it is the bulk route for the Trends range
      and works for import into Google, Outlook, and Apple calendars.
    - **Google Calendar and Outlook** have no bulk file format of their
      own; without signing the user into a Google/Microsoft account
      (OAuth/API integration — out of scope unless Wade asks), they are
      per-event "add" links that open a pre-filled event page
      (Google Calendar template URL; Outlook compose deep link). So in
      the Planner and day views each slot gets Google/Outlook add links,
      and the Trends view's Google/Outlook option applies per selected
      day, while .ics covers the whole range in one file.
    - Don't-go (veto) days export no events; typical (beyond-forecast)
      days are excluded from Trends export by default with a note, since
      their times are estimates.
    - **Inclusion options (Wade, 2026-11-11 — amendment to this item):**
      the user can also include those two day kinds in exports, off by
      default:
    - **Where the options live (Wade, 2026-11-11 — supersedes the
      export-panel placement in Mockup F):** the two inclusion toggles
      move OUT of the per-export panel into a **Settings modal opened by a
      gear/cog icon in the top-right of the app**. They are saved
      preferences, **default OFF**, and every export (all three views)
      simply follows them — the export panels themselves carry no
      inclusion checkboxes. (The modal is also the natural home for the
      existing API-key settings, which currently sit in a collapsible
      section at the bottom of the page; consolidating them into the same
      modal is part of this change unless Wade says otherwise.)
    - **Header icon style (Wade, 2026-11-11; Mockup I):** V1 traced
      outline — stroke-only SVG, slate at rest, app green on hover/open —
      for BOTH the gear and the item #13 ⓘ, with **no button frame or
      raised effect and no text label under the icons**: bare icons,
      invisible ~40 px hit area, hover tooltip ("Settings" / "How
      ratings work"). Supersedes the boxed, labelled icon buttons shown
      in Mockups G and H.
      - "Include typical days" — their slots export as events, with the
        title prefixed "Typical day (estimate) —" and the description
        stating the times come from astronomy and season only, not a
        forecast.
      - "Include Don't-go days" — a veto day has no slots, so it exports
        as a single all-day event titled "Don't go — <Target>, <Place>"
        with the veto reason in the description (e.g. red tide present,
        dangerous winds), so the blocked day still shows on the calendar.
      Both options apply in all three views where those day kinds appear
      (Planner day can be a typical/veto day too, and the item #11 modal
      inherits the same exporter).
    Mockups prepared 2026-11-11 (Mockup E; options panel in Mockup F;
    Settings placement in Mockup G).

13. **In-app legend / explainer (Wade, 2026-11-11).** Add a "How ratings
    work" explainer to the app. **Placement DECIDED by Wade, 2026-11-11:**
    a separate **ⓘ icon in the header, next to the Settings gear** (bare
    V1 outline style — see the icon-style note in item #12) — ⓘ opens the
    explainer modal, the gear opens Settings. (The
    alternative, a gear dropdown menu containing both, was considered and
    not chosen.) Plus a compact band-color legend under the Trends strip.
    Contents:
    - **The labels:** day bands (Excellent ≥78, Good ≥62, Fair ≥48, Poor
      below — the day's band comes from its best hour's score), slot
      labels (★ Best / ✓ Good / · Okay), Don't-go (a veto day), and
      "typical" days (astronomy + season only, no forecast).
    - **How a day is calculated:** each hour is scored from a day-quality
      base (season fit, temperature fit, weather penalties) plus anchor
      points for the windows that matter (light, tide), with plain-language
      rows per factor: what it does, how much it can move the score
      (Strong / Moderate / Minor / Zero / Veto), and which data source
      feeds it — Open-Meteo forecast (temperature, wind, rain, pressure),
      NOAA CO-OPS tide predictions, local SunCalc astronomy, built-in
      species season/temperature tables (FWC/USFWS), and the planned
      USGS/FWC feeds (items #1–#2) marked as such.
    - **What deliberately scores zero, and why:** moon phase and solunar
      for deer/freshwater (GPS-collar and creel studies found ~no effect),
      solar activity/Kp (no validated effect); barometric pressure capped
      at a minor ±2 (the traditional 30.00–30.40 inHg "optimum" is
      anecdotal); solunar survives only as a +3 saltwater tie-breaker,
      credited to the tide. Keep the tone factual — one line each, no
      lecturing.
    Mockup prepared 2026-11-11 (Mockup H, showing the decided placement).

14. **Web build + GitHub Pages hosting (Wade, 2026-11-11).** In addition
    to the Windows (Tauri) build, publish the app as a web app hosted on
    GitHub Pages. Feasibility verified 2026-11-11: the frontend is a
    standard Vite/TypeScript app (Tauri is only a shell around the same
    dist/ output); the sole Tauri API call (app_info for the footer) is
    already wrapped in try/catch with a text fallback; all data calls
    (Open-Meteo, NOAA CO-OPS) are browser-safe (CORS-open), and settings /
    API keys already live in localStorage. The 2026-11-11 screenshot
    verification in fact ran this exact web output in a browser against
    live data. Work required:
    - Set the Vite base path for a project Pages site (relative "./" is
      simplest) without breaking the Tauri build.
    - Add a CI job that builds the web output and deploys it to GitHub
      Pages on push, alongside the Tauri matrix; expected URL:
      https://wf-robot-muse.github.io/fishing-hunting-predictor/
    - Notes: Pages is public (no login) — acceptable, the app holds no
      private data and keys stay in each visitor's own browser; HTTPS is
      included, which item #10's geolocation option requires; the
      Open-Meteo free-tier non-commercial caveat (item #9) applies to
      the web build equally.

15. **API-call efficiency and caching (Wade, 2026-11-11).** Make the
    app's API usage as efficient as possible: serve repeated requests
    from cache and only call the source API when the cached data has
    gone stale. Wade's assumption (server-side shared cache) examined
    against the app's serverless shape — the app currently has **no
    backend at all** (Tauri and the GitHub Pages web build both call the
    sources directly from the device), and Pages is static-only, so a
    shared cache means adding one small hosted component. Design as
    logged (recommendation presented to Wade 2026-11-11):
    - **Layer 1 — client cache (do first, no infrastructure):** every
      app instance caches responses on-device (localStorage/IndexedDB)
      keyed by rounded coordinate grid cell + date, with per-data-type
      time-to-live and stale-while-revalidate (show the cached day
      instantly, refresh in the background once stale). Cuts repeat
      opens by the same user — the dominant traffic — to zero calls
      within the TTL.
    - **Layer 2 — shared edge cache (when cross-user sharing matters,
      e.g. paid weather tiers under item #9):** a small caching proxy on
      **Cloudflare Workers with KV storage** (recommended store). All
      app instances, desktop and web, ask the Worker first; on a fresh
      hit it returns the cached payload; on a stale/missing entry the
      Worker itself fetches from the source, stores the result, and
      returns it (cache-aside). Free tier covers early scale (~100K
      requests/day); KV is globally replicated and built for exactly
      this read-heavy, TTL'd data. Alternatives considered: GitHub
      Actions writing scheduled JSON snapshots to Pages (works only for
      known preset locations, not arbitrary user coordinates); Firebase/
      Supabase (workable, heavier — database + functions + another
      account surface); Wade's home IIS box (availability unsuitable
      for a public app).
    - **Cache keys and aging:** keys are data type + grid cell
      (coordinates rounded to ~0.1°, so nearby users share an entry)
      + date. Suggested TTLs: weather forecast 30–60 min; USGS gauge
      observations 15–30 min; red-tide reports ~6 h; tide predictions
      7 days (they are deterministic predictions); climate normals and
      season tables effectively static (versioned, not timed).
    - **Security around creating/updating the shared cache (Wade's
      requirement):** app instances **never write** — there is no
      client-facing create/update call at all. Only the Worker's own
      server-side code writes, and only in response to its own fetch
      from the named source (cache-aside), after validating the payload
      shape. Refresh is therefore not an endpoint anyone can invoke;
      the only administrative operation (purge/force-refresh) sits
      behind a secret token held server-side. Reads are public by
      design (the underlying weather/tide data is public), protected
      against abuse by per-IP rate limiting and request-shape
      validation (coordinates must parse and fall in range, dates
      bounded) so the proxy can't be used as a free general weather
      API or a reflection point. Any paid source key (item #9) lives
      only in the Worker's server-side secrets — a side benefit: keys
      stop shipping to every device.

16. **Rename the app and repo (Wade, 2026-11-11).** Wade wants a new
    name for the app and the GitHub repo; candidate names being checked
    for collisions (existing apps on the App Store / Google Play,
    existing GitHub repos, and obvious outdoors-business/trademark use)
    before he picks. Rename mechanics to execute with the change:
    GitHub repo rename (old web URLs redirect; the item #14 Pages URL
    changes to match the new repo name), Tauri productName and window
    title, installer file names, README/release wording, and the app
    identifier (com.wf.robot.muse.*) — changing the identifier makes
    installs register as a new app, so the timing should ride with the
    next build rather than a patch. **New name DECIDED (Wade,
    2026-11-11): "Zero Light"** — from the round-2 clears (the pun:
    zeroing a rifle × zero light before dawn; covers hunting and
    fishing equally and names the timing concept). Derived forms for
    the rename: display name **Zero Light**; repo
    **wf-robot-muse/zero-light**; Tauri productName **ZeroLight**;
    app identifier **com.wf.robot.muse.zerolight** (new identifier =
    fresh app identity; existing v0.1.x settings/local data do not
    carry over — acceptable at this stage); GitHub Pages URL becomes
    https://wf-robot-muse.github.io/zero-light/ ; the descriptive
    subtitle ("Best times to hunt and fish for a location") stays as
    the tagline under the new name. Known blemish, accepted: a few
    unrelated personal GitHub repos named ZeroLight exist under other
    owners; no app, brand, or trademark collision was found.
    Collision check (2026-11-11; App Store, Google Play, GitHub,
    outdoors-brand searches). CLEAR: **Lowlight Outdoors** (nothing
    found anywhere; GitHub check cut off by rate limit, unverified),
    **Crepuscular** (no app/brand; only unrelated graphics projects),
    **First & Last Light** (no exact collision, but First Lite — a
    major MeatEater-owned hunting brand — is phonetically close in
    the same industry, and the phrase is generic hunting vocabulary),
    **The Feeding Window** (nothing exact; generic solunar term;
    GitHub unverified), **Peak Slot** (nothing found; "slot" carries
    casino associations in search). COLLIDING, do not use: Cast &
    Blast (exact-name outfitters), Prime Window (PrimeWindow app,
    same concept), FieldClock (live app, both stores), Tide & Timber
    (exact-name MD outfitter + repos), Antler & Anchor (Antler Anchor
    Co + exact-name apparel brand), Slotwise (apps/repos/SaaS),
    GoWindow (fishing weather GO/NO-GO apps — same name and concept).
    Round 2 (Wade, 2026-11-11: bold/conservative brand style, Black
    Rifle Coffee register; GitHub verified directly this round). CLEAR:
    **Antler & Lead** (cleanest result in either round — zero hits on
    every axis), **Lead & Liberty** (no brand/app/repo; one-off
    gun-auction event title only), **Zero Light** (no app/brand; a few
    unrelated personal GitHub repos named ZeroLight). COLLIDING:
    Dark Thirty Outdoors (active Dark Thirty heated-vest brand sold
    at Costco + a DARK 30 OUTDOORS trademark filing whose pseudo-mark
    is the exact name), Oh Dark Thirty (phrase family occupied by
    Zero Dark Thirty Coffee), Cold Bore (exact-name App Store app +
    Patagonia Ballistics' ColdBore + multiple marks), Racks & Reels
    (registered/renewed USPTO apparel trademark for hunters/fishers +
    TX outfitter), Brass & Bass (operating USMC veteran-owned gun
    shop specializing in firearms AND bass gear), Iron Antler (two
    active exact-name hunting/fishing apparel brands), Send It
    Outdoors (exact-name fishing tackle brand at retail), Shells &
    Scales (Shells2Scales guide service, same spoken name), Holdover
    (registered HOLDOVER TARGET SYSTEMS mark; generic term).
    Round 3 (Wade, 2026-11-11: variations on Antler & Lead, incl.
    fishing-inclusive ones; GitHub verified via API). CLEAR, no
    material caveats: **Antler & Flint** (cleanest hunting-side),
    **Antler & Primer**, **Antler & Grain**, **Antler & Reel** (hunt +
    fish, direct variation), **Antler & Lure**, **Antler & Wake**,
    **Lead & Lure** (lead = ammunition and sinker weight). CLEAR with
    cautions: Antlers & Lead (Love & Lead bullet/antler jewelry
    nearby), Lead & Antler (Oak & Antler apparel + ANTLER & OAK mark
    crowd the reversed pattern), Antler & Powder ("antler powder"
    already means a supplement/pet product), Antler & Cordite (CORDIA
    hunting brand phonetically close), Rack & Lead (Rack- apparel
    crowding), Antler & Gill (Pittston Antler & Gill Sportsmen Club,
    est. 1974 — minor). COLLIDING: Antler & Brass (Canvas Antlers &
    Brass decor brand), Antler & Steel (reversed Steel and Antler
    Outfitters), Antler & Tine (exact-name antler jewelry business),
    Antler & Iron (Iron Antler Taxidermy + exact decor businesses),
    Antler & Tackle (active "Antler Tackle" design business), Antler
    & Hook (exact "Antler & Hook Co.", Alabama, hunting/fishing),
    Rack & Reel (exact apparel brand + Montana outfitter + near-
    identity to the registered RACKS AND REELS mark — do not use),
    Antler & Cast (exact-name MN fishing guide service), Hooks &
    Horns (saturated: Mossy Oak game, FFL dealer, tackle shop,
    hunting club).
    - **Discussion addendum (2026-11-11, decisions open):**
      - *Layer 2 platform — DECIDED (Wade, 2026-11-11):* **Cloudflare**
        (Workers proxy). **Store — DECIDED (Wade, 2026-11-11): D1**
        (chosen over KV for the 100× free write headroom — 100K rows
        written/day vs KV's 1,000 writes/day — and queryable cache
        statistics; KV was Robot's recommendation for simplicity, with
        native TTL. D1 consequences carried into the design: expiry is
        an `expires_at` column checked on read plus a scheduled
        sweeper deleting dead rows; all reads are primary-key lookups
        on the cache key (D1 meters rows scanned, so no unindexed
        queries); the Worker carries a write-budget guard so refresh
        writes stay bounded by cells × refresh rate). Options
        considered and set aside: Azure Functions +
        Table Storage (fits his Microsoft stack; more setup, cold
        starts, heaviest Robot-side maintenance); Vercel/Netlify
        functions + Upstash Redis (native per-key TTL fits caching
        well; another vendor); AWS Lambda + DynamoDB (TTL built in;
        steepest ops); GitHub Actions snapshots (presets only).
        Verified Cloudflare free-tier limits (official docs, checked
        2026-11-11): Workers 100K requests/day; KV 100K reads/day but
        only **1,000 writes/day** — the write cap is the binding
        constraint for a cache (each stale refresh is a write), so D1
        (100K rows written/day free) is the alternative Cloudflare
        store if write volume grows; Workers Paid is $5/mo minimum
        (10M requests/mo, KV 1M writes/mo included). Account would be
        Wade's to create (free workers.dev address; no domain needed).
      - *Grid cells — DECIDED (Wade, 2026-11-11):* **0.1° (~11 km)**,
        the recommended default. Weather cache keys quantize
        coordinates to a fixed grid; all users in a cell share one
        entry fetched for the cell's representative point. (The dial
        considered: 0.05° ≈ 5.5 km, more precise/less sharing; 0.25°
        ≈ 28 km, maximum sharing/coarser.) Side benefit: exact user
        coordinates are never stored server-side — only cell IDs.
        Tides and gauges don't grid; they key by station ID. The app's
        own location display still uses the user's exact coordinates.
      - *Aging:* TTLs live server-side (Worker config), adjustable
        without shipping an app update; the Worker returns each
        payload's max-age and the Layer 1 device cache obeys it, so
        policy is defined once. Aging scales with forecast horizon
        (**today's forecast ~2 h — set by Wade, 2026-11-11**, raised
        from the 30 min originally proposed; tomorrow ~2 h, days +3–7
        ~6–12 h, since far forecasts change slowly); entries also
        expire on clock boundaries so all users flip together;
        serve-stale-on-error grace (e.g. up to 6 h) if a source is
        down.
      - *Local-first read path — DECIDED (Wade, 2026-11-11;
        sub-points CONFIRMED by Wade the same day):* once an app
        instance receives data it caches it locally, and **all in-app
        interactions read the local copy**. The instance queries the
        remote (Layer 2) cache **only when its local copy is stale
        or missing** — never merely because the user interacted. If
        the device has lost connectivity, the app keeps serving the
        local copy (including past its TTL) rather than failing, and
        offline-stale data is shown with a small "last updated" note
        (confirmed). Local expiry follows the max-age handed down
        with the payload, keeping the aging policy single-sourced at
        the Worker. Ordinary interactions may never force a refresh;
        an explicit user refresh action, if one is added, may bypass
        local staleness (confirmed).
      - *Worker secrets, explained for Wade:* Workers "secrets" are
        encrypted variables stored by Cloudflare, set once via
        dashboard/CLI, readable only by the running Worker — never in
        the repo, never sent to any device. A paid source key would
        exist only there: the app asks the Worker keylessly, the Worker
        adds the key server-side when it fetches, and only the data
        comes back. (Anything embedded in the app itself is effectively
        public — the Tauri bundle's JS is readable by anyone, and the
        repo is public.) Rotation/revocation = change one secret; every
        instance benefits immediately.
    - **Cloudflare account (Wade, 2026-11-11):** one free account
      under the plain project mailbox wf.robot.muse@gmail.com (his
      "option 1": a single shared account; future apps share it or get
      their own account under a genuinely distinct address if they
      ever need separate quotas). Checked fact (2026-11-11):
      Cloudflare normalizes Gmail addresses — `+tag` variations and
      dot variants collapse to the base address, so
      `wf.robot.muse+AppA@…` and `+AppB@…` can NOT create separate
      accounts; separate accounts require genuinely different
      addresses, after which the main login can be invited into each
      as Super Admin. Account creation started 2026-11-11 (signup in
      the browser; Wade sets the password via the secure form). The
      D1 database itself is created when Layer 2 is built, not at
      signup. **Signup blocked in Robot's browser (2026-11-11):**
      Cloudflare's Turnstile "Verify you are human" check rejects the
      cloud browser's network outright — extensive automated attempts
      reset silently, and Wade's own three clicks during a live
      takeover looped the same way. No account was created and no
      data was submitted. Fallback path given to Wade: create the
      account in his own browser on his own device/network (email
      wf.robot.muse@gmail.com, his own password), tell Robot when
      done; Robot can pull the verification link from the project
      mailbox on request. Future Worker deploys can run through
      GitHub Actions with a Cloudflare API token, so Robot's browser
      may never need dashboard access. **Account CREATED (by Wade in
      his own browser, 2026-11-11)** under wf.robot.muse@gmail.com,
      with email two-factor authentication enabled. Outstanding for
      build time only: an API token for the GitHub Actions deploy
      route (Wade creates it in the dashboard when Layer 2 is built;
      Robot never needs his password).

## Next round — post-v0.2.0 items

17. **Unified location input — remove the preset dropdown entirely
    (Wade, 2026-11-12).** Replace the preset dropdown (Tampa Bay /
    Lake Guntersville / Tuscaloosa / Custom) with ONE search box that
    intelligently determines what it was given:
    - a typed ZIP code → resolve via ZIP lookup (Zippopotam.us, as
      built in #10);
    - typed latitude/longitude → parse the coordinates directly;
    - device geolocation ("Near me") → same resolver path;
    - a map pin (existing Leaflet picker) → same resolver path.
    All four feed the single input; presets are gone entirely.
    - **Last search persistence (Wade, 2026-11-12):** the last used
      location loads automatically when the program is closed and
      reopened (persist the resolved location in local settings).
    - **First access — DECIDED (Wade, 2026-11-12; Robot's
      recommended scenario accepted):** returning users get the
      saved last location; on first run there is NO auto-fired
      geolocation permission prompt and NO default location — the
      app sits at an "enter a location" state, search box focused,
      until the user provides a location. Detection priority inside
      the box: coordinate pattern first (unambiguous), then ZIP,
      then place name.
    - **Geolocation affordance — DECIDED (Wade, 2026-11-12):** the
      geolocation action is an icon link INSIDE the unified search
      box, at the far right, with a hover tooltip "Use my location"
      (same pattern as mainstream websites; aria-label and keyboard
      focus give the same text to non-mouse users). Clicking it is
      what triggers the browser permission request — always
      user-initiated.
    - **Place names — DECIDED (Wade, 2026-11-12): IN.** Free-text
      place names (e.g. "Tuscaloosa", "Lake Guntersville") resolve
      in the box via a geocoding service (provider chosen at build
      time; Open-Meteo Geocoding fits the current keyless stack,
      Nominatim has broader place/POI coverage — decide by coverage
      test). Ambiguous names follow the #10 confirm-before-apply
      pattern (short pick list, user confirms).
    - **Input security — Wade's standing requirement (2026-11-12),
      applies app-wide, not only to this item:** every user input
      and input field is treated as untrusted and scrutinized with
      the highest feasible level of security. Concretely for this
      app: strict format and range validation (ZIP pattern;
      latitude −90..90 / longitude −180..180; length caps and
      character checks on place-name text); user text is rendered
      via textContent only, never injected as HTML; query values
      are URL-encoded; API responses are treated as untrusted and
      schema-checked before use; the persisted last-location value
      is re-validated on load before it is applied; no dynamic code
      execution from input, ever.
    - **Geocoding provider — DECIDED (Wade, 2026-11-12): Geoapify**
      for place-name lookup. Reasons: free plan is explicitly usable for commercial
      projects in production within quota (attribution required), at
      3,000 credits/day with 1 credit per geocoding request and
      5 requests/second; Geoapify states geocoding results may be
      stored on our side without restrictions or additional cost,
      which matters because #17 persists the last location; paid
      plans start at $59/month and a custom unmetered/dedicated option
      exists if volume ever justifies it. Route calls through the
      Cloudflare Worker once Layer 2 is active so the API key stays
      server-side. Alternatives checked: LocationIQ free is larger
      (5,000/day) and allows limited commercial use with a link back,
      but free-plan caching of request/response pairs is limited to
      48 hours, which conflicts with persistent last-search storage
      unless on a paid plan; Open-Meteo Geocoding allows 10,000/day
      free but is non-commercial on the free tier and is GeoNames-based
      (weaker for lakes/POIs); the public OSM Nominatim service caps
      the whole app at 1 request/second, forbids autocomplete-style
      use, and warns commercial apps about withdrawal — not suitable
      as the primary provider.
    - **Geocode caching — DECIDED (Wade, 2026-11-12; the hybrid
      split, the local-first sequencing, and ~90-day Layer 2 aging
      all confirmed):** hybrid, split by data type. The shared
      place-name lookup cache (normalized query → Geoapify candidate
      results) belongs in Layer 2 (Cloudflare Worker + D1): it is
      public, non-personal data; one entry serves every user, which
      protects the shared Geoapify quota (3,000/day per key, not per
      user) and keeps the API key server-side; long TTL (~90 days —
      place data is near-static; Geoapify permits storing results
      without restriction). The user's SELECTED location and their
      recent-search history stay LOCAL only (Layer 1): they are
      per-user, privacy-sensitive, and the last-search restore must
      work offline and instantly. Layer 2 keys must never contain a
      user's exact coordinates or geolocation fix; any proximity bias
      keys to the existing 0.1° cell. Until Layer 2 is deployed, the
      app caches locally and calls Geoapify directly; the geocode
      client is written cache-aside (local → Layer 2 → provider) so
      activating Layer 2 later changes no UI behavior.
    - **Mockup (2026-11-12):** unified box, in-box geolocation icon
      with "Use my location" tooltip, map placements M1 (button
      beside the box) / M2 (both icons inside the box) / M3 (quiet
      link under the box), and the first-run / ambiguous-name /
      restored-last-search states rendered at
      ~/workspace/fhp-screenshots/24-mockup-unified-search.png.
      Map placement DECIDED (Wade, 2026-11-12): **M2** (both icons
      inside the box). Map-icon variants for the M2 layout rendered
      at ~/workspace/fhp-screenshots/25-mockup-map-icons.png —
      I1 pin (current), I2 folded map, I3 map + pin, I4 compass,
      I5 grid + dot, I6 globe. Icon DECIDED (Wade, 2026-11-12):
      **I2 folded map**.
    - **Map display on icon click — DECIDED (Wade, 2026-11-12;
      step-5 confirm-before-apply confirmed; expand-to-modal added
      by Wade the same day):** clicking I2 expands an inline
      Leaflet/OpenStreetMap panel (~300 px tall) directly under the
      search box — not a modal. It opens centered on the current
      location if one is set (pin on it, zoom ~10); on first run it
      opens on a broad US view with no pin until the first click.
      Click/tap sets or moves the pin; drag fine-tunes; a readout
      under the map updates live (nearest place name via Geoapify
      reverse lookup + coordinates). Robot recommends explicit
      "Use this spot" / Cancel buttons (confirm-before-apply, as
      decided for place names) over v0.2.0's instant apply. Panel
      closes on apply, Cancel, Esc, or clicking the icon again.
      **Expand to modal (Wade, 2026-11-12):** the inline map carries
      an expand control (expand icon, top-right corner) that opens
      the same picker as a large modal (~90% of the window) with
      identical functionality — pin position, zoom, and readout
      carry over in both directions between inline and modal; in
      the modal the expand control becomes a collapse control.
      "Use this spot" in the modal applies the selection, closes
      modal AND inline panel, and returns the app to normal
      function (box filled, planner reloaded, last search saved);
      Cancel in either view discards. Esc and ✕ in the modal
      CANCEL EVERYTHING (Wade's decision, 2026-11-12, overruling
      Robot's exit-is-not-cancel assumption): the unconfirmed pin
      is discarded and both the modal and the inline panel close.
      The collapse control is the only route back to the inline
      view and keeps the pin — it is a view toggle, not an exit.

18. **Attribution & About — DECIDED (Wade, 2026-11-12: his
    ⓘ-dropdown suggestion adopted with Robot's two-layer credit
    split).** Wade's
    suggestion: the top-right ⓘ icon opens a dropdown containing an
    About selection, which holds the service attributions. Robot's
    recommendation: adopt the dropdown — ⓘ menu with "How ratings
    work" and "About & credits" (this amends #13: ⓘ no longer opens
    the explainer directly; gear stays Settings-only) — but split
    the credits into two layers, because not all of them may live
    only behind a menu:
    - **Point-of-use (always visible where the data appears):**
      "© OpenStreetMap contributors" stays in the map corner (OSM
      requires it on the map; already there in v0.2.0); a small
      muted "Powered by Geoapify" link sits under the search box
      where place results are used (Geoapify free-plan attribution).
    - **About & credits modal (from the ⓘ menu):** the complete
      list with links — Open-Meteo (weather; their free terms
      require a displayed credit link), USGS (water data), NOAA/NWS
      (tides & forecasts), NCEI (climate normals), FWC-FWRI (red
      tide), Geoapify (place search), OpenStreetMap & Leaflet
      (map), Zippopotam.us (ZIP lookups) — plus app version,
      "© Wade Feltman — All Rights Reserved", and a disclaimer
      stating that ratings are guidance and seasons/regulations
      remain the user's to verify (Wade, 2026-11-12: he likes this
      section; wording DECIDED (Wade, 2026-11-12): Option B plus
      Option C's safety sentence, verbatim for the About modal —
      "Zero Light provides planning guidance only. Its ratings and
      forecasts are generated from third-party data that may be
      incomplete, delayed, or wrong, and conditions in the field or
      on the water can change quickly. Ratings estimate fish and
      game activity only — they do not guarantee activity, success,
      or safe conditions. Always confirm seasons, bag and creel
      limits, licensing, closures, and local conditions with
      official sources — your state fish and wildlife agency, NOAA,
      and local authorities — before hunting or fishing. You are
      responsible for complying with all applicable laws and
      regulations, and for your own safety.")
    Menu behavior: click toggles, outside-click/Esc closes,
    keyboard-navigable, same V1 outline styling; ⓘ tooltip becomes
    "Information".

19. **Fire HD 10 web geolocation failure (Wade test finding,
    2026-11-12).** Testing the Pages web app on his Fire HD 10,
    "Near me" fails with "Location permission was not granted."
    Diagnosis (code checked 2026-11-12): the app's geolocation
    handler uses ONE generic error callback — every failure type
    (PERMISSION_DENIED, POSITION_UNAVAILABLE, TIMEOUT; 15 s
    timeout, default accuracy, no maximumAge) shows that same
    "permission" text, so the message does not establish that
    permission was actually denied. Platform facts (Amazon docs):
    Silk supports the Geolocation API, prompts at the bottom of
    the page, and has a per-site/all-sites Location setting; Fire
    HD 10 has no GPS — location is Wi-Fi positioning, requiring
    Fire OS location services ON and Wi-Fi connected. Checklist
    given to Wade: Fire OS location services on; Wi-Fi on; Silk
    Settings → Site Settings → Location set to ask/allow and any
    blocked entry for the Pages site cleared; reload and accept
    Silk's bottom-of-page prompt; cross-check with Google Maps in
    Silk (if that also fails, it is device-level, not the app).
    **App-side fix (this item):** branch messages on error.code —
    denied → permission guidance incl. the Silk/Fire settings
    path; unavailable → "device couldn't determine a location"
    with the Fire no-GPS/Wi-Fi note; timeout → retry guidance —
    and use Wi-Fi-friendly options (enableHighAccuracy: false,
    longer timeout, a maximumAge so a cached fix can succeed).
    #17's in-box crosshair inherits this fixed handler.
    **Root cause confirmed (Wade, 2026-11-12):** Fire OS location
    services were OFF; turning them on resolved "Near me" on the
    Fire. The app-side fix stays on the list: with services off,
    the app's text blamed permission instead of the device switch;
    the new unavailable-branch message names the Fire OS location
    setting explicitly.

20. **Layer 2 activation + both build-time prerequisites — added
    to the next build (Wade, 2026-11-12).** Scope:
    - **Geoapify prerequisite:** account + free API key under
      wf.robot.muse@gmail.com — DONE (2026-11-12, via Google
      sign-in; project "Zero Light" created with an active default
      key named "Zero Light"; free plan confirmed: 3,000
      credits/day, 5 requests/second). The key stays in the
      Geoapify dashboard until deploy time, then moves into
      secrets without passing through chat; server-side only (the
      Worker), never in the app or the public repo.
    - **Cloudflare prerequisite:** Wade creates a scoped API token
      (name: `zero-light-github-actions`; custom token, his
      account only: Workers role must be **Admin** for the first
      deploy — Editor "can read, update, deploy, and rename
      existing Workers — cannot create or delete Workers" per
      Cloudflare's Workers authorization docs, so an Editor token
      cannot create the not-yet-existing cache Worker (CORRECTED
      2026-11-12: Robot first told Wade Editor could create it;
      wrong). Optional hardening after the first deploy succeeds:
      replace the GitHub secret with a fresh Editor token, which
      can deploy updates to an existing Worker. Alternative:
      create the Worker manually in the dashboard first and keep
      Editor from the start. Other permissions: D1 Edit, Account
      Settings Read; resource "Entire Account") and adds GitHub secrets
      CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to the
      zero-light repo — the exact gates deploy-worker.yml already
      checks. Robot verifies presence only, never sees values.
      **CLOSED (2026-11-12):** Wade edited the token's Workers
      role in place (Editor → Admin; value unchanged) and created
      both secrets; Robot verified CLOUDFLARE_API_TOKEN and
      CLOUDFLARE_ACCOUNT_ID present on the repo (both updated
      Nov 12, 2026) alongside the existing WINDOWS_CERT_PASSWORD.
      Both #20 prerequisites are now closed.
    - **Deploy:** create the D1 database, replace the
      REPLACE_WITH_D1_DATABASE_ID placeholder in
      worker/wrangler.toml, set the Worker's PURGE_SECRET, run
      deploy-worker.yml, confirm the Worker answers on its
      workers.dev URL.
    - **Wire-up:** extend the Worker with #17's geocode cache
      endpoints (shared place-name lookups, ~90-day TTL, Geoapify
      key server-side); set the app's shared-cache endpoint by
      default in the new build (Settings override remains); verify
      end-to-end — a repeat data fetch is served from D1, and a
      repeated place search costs no additional Geoapify credit.
    - **Custody fold-in + Settings cleanup (Wade, 2026-11-12):**
      USGS/NCEI custody moves to Robot. At deploy time the values
      leave the project mailbox and become Worker secrets; the app
      fetches gauge data and climate normals through the Worker
      (cached in D1) and holds no keys itself. Wade directed the
      corresponding fields out of the Settings modal: the USGS API
      key field, the NCEI token field, AND the Shared cache
      endpoint field are all removed — the cache endpoint becomes
      a built-in constant (the deployed Worker URL), not a user
      setting. Settings keeps only the two calendar-export
      toggles. Fallback if the Worker is unreachable: keyless
      direct USGS (rate-capped) and normals absent (typical days
      fall back to astronomy/season, as they do today with no
      token).
    With #20, the next build covers #17 + #18 + #19 + Layer 2 +
    the USGS/NCEI custody move — every decided item. The only
    remaining unknown is findings Wade has not yet reported from
    v0.2.0 testing.
