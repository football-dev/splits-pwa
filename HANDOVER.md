# Splits — handover

Snapshot as of **2026-09-19**, at **v8** on `main` (experience-weighted plans; the commit before it is `ce011b8`). Everything described
here as "built" is committed and pushed; anything not yet done is listed under
[Open items](#7-open-items-and-risks).

- **Live app:** https://football-dev.github.io/splits-pwa/ (GitHub Pages, branch `main`, folder `/`, HTTPS enforced)
- **Repo:** https://github.com/football-dev/splits-pwa (public)
- **Local copy:** `~/splits-pwa`
- **Stack:** static PWA — plain HTML, CSS and JavaScript. No build step, no dependencies, no backend.

---

## 1. What Splits is

A training-plan generator and run tracker. You give it a goal distance, race date,
current weekly volume and runs per week. It lays out a periodised plan
(base → build → peak → taper). It then pulls your actual runs from **Google Health**
(where Apple Watch runs arrive via Apple Health sync), matches them to planned
sessions, and adjusts the plan if a long run is missed.

Everything is stored in the browser's `localStorage`: one device, no account.

---

## 2. Commit history

| Commit | What it did |
|---|---|
| `66a6c90` | Initial scaffold, unzipped from `splits-pwa.zip` (originally a `runplan/` folder, flattened so `index.html` sits at the repo root). |
| `8ff7127` | Put the real Google OAuth `CLIENT_ID`, endpoints and scopes into `healthSync.js`. |
| `81b7d92` | Replaced the PKCE redirect flow with **Google Identity Services (GIS)** popup token flow. Added token-expiry handling. Loaded the GIS script. |
| `adf2198` | Rewrote run fetching against the **Google Health v4** API (`health.googleapis.com`), using the live discovery document. Paginated, filtered by exercise type. |
| `77c08ee` | Added a version label (bottom right) to expose stale service-worker caches. |
| `707ddbe` | Sync button, run log, manual "mark done", hero stats, weekly-volume chart, colour-coded sessions. Moved plan maths into `planStats.js`. Fixed several reconciliation bugs. |
| `de60423` | **UI redesign (v6):** single long scroll replaced by a bottom-tabbed app (Today / Plan / Progress / Profile) plus a session-detail screen, on new design tokens. Plan and sync logic unchanged. Brief: [`docs/redesign-brief.md`](docs/redesign-brief.md). |

| `ce011b8` | **v7:** Profile → App version → **Check for updates**; the service worker installs with `cache: 'reload'`. |
| *(v8)* | **Experience- and fitness-weighted plans:** Beginner / Intermediate / Experienced selector and an "outside running, how active are you?" question on the plan form; level- and fitness-aware long runs, volume growth and recovery weeks; short-timeline warnings; 50K and 100K ultra races (§5.5). |

GitHub Pages was already enabled (source `main`, path `/`) the first time it was checked. Each push
to `main` redeploys in about a minute (§8.1).

---

## 3. File map

| File | Lines | Role |
|---|---:|---|
| `index.html` | 137 | App shell: onboarding form, one empty `<section data-view>` per screen, bottom tab bar, the reusable bottom sheet (`<dialog>`), toast. Loads fonts and scripts in order (below). |
| `css/styles.css` | 675 | Design tokens on `:root` (dark `#12181C`, accent orange `#E08D3C`, teal `#3FA796`); Fraunces for headings, IBM Plex Sans for body, JetBrains Mono for numbers. |
| `js/planGenerator.js` | 267 | Rules-based plan generation, weighted by running experience and general fitness; `assess()` for pre-build warnings; `suggestLevel()`. Races: 5K, 10K, half, marathon, 50K and 100K ultras. See §5.5. |
| `js/planStats.js` | 253 | **Pure** plan/run maths — no DOM, no network. Reconcile, streak, weekly series, run log, `weekStart`. Added in `707ddbe`. |
| `js/healthSync.js` | 213 | Google auth (GIS) and Google Health API calls. |
| `js/app.js` | 1368 | Storage, view switching (`showView`), rendering of every screen, sheet, sync, event wiring. |
| `service-worker.js` | 40 | Cache-first app shell (`splits-v8`). Cross-origin requests bypass it. |
| `manifest.json`, `icons/` | — | PWA install metadata (iOS Add to Home Screen). |
| `README.md` | 88 | Setup notes. Google Health section was updated in `81b7d92` and `adf2198`. |
| `docs/redesign-brief.md` | — | The design brief the v6 UI was built from, plus how the build departed from it. |

**Script load order** (in `index.html`): GIS client (`async defer`) → `planGenerator.js` →
`planStats.js` → `healthSync.js` → `app.js`. Each module is a global (`PlanGenerator`,
`PlanStats`, `HealthSync`); there are no ES modules. `PlanStats` calls
`PlanGenerator.adjustForMiss`, so it must load after it.

---

## 4. Google Health integration

### 4.1 Authentication (GIS token flow)

- `beginAuth()` calls `google.accounts.oauth2.initTokenClient(...).requestAccessToken()`,
  which opens a Google consent **popup**. It must be called synchronously from a click handler.
- The token client is created **lazily on first click**, because the GIS script loads `async`
  and `google` may not exist when `healthSync.js` first runs.
- The result is an **access token that lasts about an hour**. There is **no refresh token** and
  **no client secret**. When it expires the user reconnects.
- Stored in `localStorage` key `splits_health_token` as
  `{ access_token, expires_in (number), obtained_at (ms) }`. GIS returns `expires_in` as a
  string; it is parsed.
- **Expiry handling:** `isConnected()` treats a token as expired **60 seconds early** and clears it,
  so the UI falls back to "Connect Google Health". `authorisedFetch()` also clears the token and
  throws an error with `code = 'token_expired'` on expiry or an HTTP 401. `app.js` shows a toast
  and does not show a second generic error.
- `HealthSync.onChange(fn)` notifies the UI (`{ reason: 'expired' }` or `{ error }`), because the
  token arrives in a callback after the popup, not on a page load.
- Closing the popup (`popup_closed`) is treated as a cancel, with no toast.

### 4.2 OAuth client (Google Cloud Console)

- **Client ID:** `999514215655-bsk9nklad96oae4vm1gs255aklaqnatv.apps.googleusercontent.com`
  (public by design; it is in the shipped JS).
- Must be a **Web application** client.
- **Authorised JavaScript origins** must include `https://football-dev.github.io`
  (no path, no trailing slash). Redirect URIs are **not** used by this flow.
- If the OAuth consent screen is in **Testing** mode, the Google account must be listed as a test user.
- **Scopes requested** (from the v4 discovery document):
  - `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` — **the one that matters**; it covers listing exercise data points.
  - `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` and `.../googlehealth.location.readonly` — **not needed** for the exercise endpoint. Left in so the existing consent didn't need redoing. Dropping them would be a least-privilege improvement but forces re-consent.
- There is **no `exercise.readonly` scope** in the API. An earlier handover mentioned one; the discovery document does not list it.

### 4.3 API usage

Source of truth: the live discovery document at
`https://health.googleapis.com/$discovery/rest?version=v4`. Re-check it if anything responds oddly.

- **`API_BASE`** = `https://health.googleapis.com/v4`. An earlier note gave `healthapi.googleapis.com`; that is **not** the discovery document's `rootUrl` and is wrong.
- **Endpoint:** `GET /users/me/dataTypes/exercise/dataPoints`
- **Filter** (query param `filter`): `exercise.interval.civil_start_time >= "YYYY-MM-DD"`. For session types the documented pattern is `civil_start_time` with a plain date. An earlier note suggested `interval.start_time` with an RFC-3339 timestamp; that pattern is documented for other types, not for exercise.
- **Paging:** `pageSize=25` (the API maximum for `exercise`) and `pageToken` / `nextPageToken`. `fetchRecentRuns` loops up to `MAX_PAGES = 20` (500 sessions). Results arrive **newest first**; they are reversed to oldest first before returning.
- **Response shape:** `dataPoints[]` are `DataPoint` objects, with the session **nested under `.exercise`**:
  - `exercise.exerciseType` — enum string
  - `exercise.interval.startTime` / `.endTime`
  - `exercise.metricsSummary.distanceMillimeters` (number) → divide by 1,000,000 for km
  - `exercise.metricsSummary.averageHeartRateBeatsPerMinute` (**int64, arrives as a string**)
- **Run detection:** `RUN_TYPES = { RUNNING, TRAIL_RUN, INCLINE_RUN, TREADMILL }`. The enum has 182 values. The earlier note said `RUNNING` only; the wider set was chosen so indoor and trail runs don't leave a planned session marked missed.
- **Each returned run:** `{ id, date, distanceKm, durationMin, durationSec, avgHeartRate }`. `id` is the session start time, which is stable and unique after dedupe.
- **De-duplication:** the same workout is often written by more than one source (watch plus a phone app such as MyFitnessPal), sometimes with 0 km. Entries starting within **2 minutes** of each other collapse, keeping the one with distance and heart rate. A lone 0 km run is kept.
- API error bodies are logged to the console (`console.error('Google Health API error', status, body)`), which makes 400/403 diagnosable.

### 4.4 What the API actually returned for this account

A raw, unfiltered call on 2026-09-19 returned 25 sessions from 4–16 Sept: `GOLF`, `GARDENING`,
`WALKING`, `WORKOUT`, and MyFitnessPal entries typed `OTHER` (e.g. "Aerobics, general
(MyFitnessPal)"). **No runs.** Distance data was present (e.g. a 1.47 km walk). Duplicates were
visible (the same golf round two or three times, one copy with 0 km).

---

## 5. App behaviour

### 5.1 Data model

`localStorage` keys: `splits_plan`, `splits_runs`, `splits_last_sync`, `splits_health_token`, and
`splits_profile` (`{ name }`, display only — the Today greeting).

A **plan** (from `PlanGenerator.generate`): `goalDistance`, `raceDate` (`YYYY-MM-DD`), `runsPerWeek`,
`startingVolume`, `experience` (`beginner` | `intermediate` | `experienced`) and `fitness`
(`sedentary` | `light` | `active` | `veryActive`) — both absent on plans saved before v8, read as
`intermediate` and `active` — `createdAt` (ISO), `totalWeeks`, `weeks[]`. `goalDistance` is one of
5, 10, 21.1, 42.2, 50, 100 (km). Each week has `weekNumber`, `phase`,
`targetVolume`, `sessions[]`, and optionally `adjusted`.

A **session**: `name`, `type` (`long` | `quality` | `easy`), `distance` (planned km), `status`
(`planned` | `done`), and, once done, `runId` (the synced run that filled it) or `manual: true`,
plus `actualKm` and `doneAt` (manual only).

### 5.2 Weeks and "missed"

- Plan weeks are **7-day windows from local midnight on the day the plan was created** (not from the
  `createdAt` time of day).
- **"Missed" is derived, not stored:** a not-done session in a week that has already ended. This means
  a run that syncs late can still fill it. Older saved plans with a stored `'missed'` are normalised
  back to `planned` on reconcile.

### 5.3 Reconciliation (`PlanStats.reconcile`)

- Sorted oldest-first, each run is matched to the **closest-by-distance not-done session** in the plan
  week it falls in.
- **Idempotent:** a session remembers its `runId`, so re-syncing never fills a second session with the
  same run. (The pre-`707ddbe` code re-matched every run each sync and would have ticked off extra
  sessions on every "Sync now".)
- **0 km runs are not auto-matched** (distance matching is meaningless). They still appear in the run
  log; the user can mark the session done by hand.
- A missed long run in a past week calls `PlanGenerator.adjustForMiss` once (holds next week's volume
  flat). `nextWeek.adjusted` makes this idempotent, so the toast doesn't repeat.

### 5.4 UI (v6, `de60423`)

**Shell.** Four tabs in a fixed bottom bar; session detail is a fifth screen with no tab bar.
`showView(name)` in `app.js` toggles `hidden` on the `<section data-view>` elements — no router,
no hash URLs. Each tab keeps its scroll position. The open session lives in the in-memory
`openSession` (`{ weekNumber, index, from }`); Back returns to the tab it was opened from. Every
data change calls `refresh()`, which re-renders all screens from storage. Onboarding (no plan yet)
hides the tab bar.

- **Today:** date and greeting ("Morning, <name>" — name set in Profile), streak pill. Hero card =
  the next not-done session in the current week (plan order); tapping the card opens session detail,
  **Mark done** opens the distance sheet, **Start run** only shows a toast (Splits doesn't record runs).
  Three stat tiles (days to race, week km / target, streak). "This week" strip, then a sync card
  (Connect / Sync now / last synced).
- **Plan:** header, phase bar (segments sized by weeks per phase; current phase orange). One card
  per week, as an accordion: the current week is open by default, others show a one-line summary.
  Session rows have an L/Q/E icon chip, tap through to detail, and **Mark done** (weeks that have
  started only) or **Done** plus **Undo** for manual completions.
- **Progress:** "This week" heatmap (km per day), 2×2 stat grid (week volume with meter, average pace
  with a 4-weeks-vs-prior-4-weeks trend, streak, sessions done / due), volume-by-week chart (target bar
  behind, run bar in front; current week orange, past weeks that beat target teal, base phase tinted),
  and the recent-runs log (5 shown, "Show all").
- **Session detail:** chips for km (target, or km run once done), pace (the matched run's pace, else
  your average across synced runs, else a dash) and effort zone; Z1–Z5 bar; route placeholder; splits
  table (always dashes — see below); footer **Mark done** / **Skip**, **Undo** for manual, a note for
  synced, disabled for future weeks.
- **Profile:** name (tap to edit), Google Health card (status, last synced, Sync now / Disconnect or
  Connect), settings (Race goal → Edit reopens the form pre-filled and rebuilds the plan; Experience and Fitness show the
  plan's levels, display-only; Units, Rest day, Notifications are display-only), **App version** row with **Check for updates** (below), and
  **Start over**.
- **Check for updates** (Profile, added in v7): fetches `service-worker.js` with `no-store` and reads
  its `CACHE_NAME`. If that version matches `APP_VERSION` it shows "Splits is up to date". If not, it
  unregisters the service worker, deletes the `splits-*` caches, re-fetches the page's own scripts,
  stylesheet and manifest with `cache: 'reload'` (so the browser's HTTP cache can't serve stale
  copies), then reloads. localStorage (plan, runs, Google token, name) is untouched. It only detects a
  release if the version was bumped (§8.1). The service worker's install step also fetches with
  `cache: 'reload'` from v7 on.

**Behaviour carried over from `707ddbe` unchanged:** sync re-entrancy guard and re-reading the plan
after the network call; "last synced" refreshing every 30 s; streak = trailing completed sessions with
no miss between, unresolved current-week sessions don't break it; week km = every synced run in the week
window plus manual completions; run-log tags (`Wk N · <session>`, `Extra run`, `Outside plan`,
`No distance recorded`, `Manual`); manual mark done only for weeks that have started.

**Display conventions invented for the redesign (not in the data model):**

- *Days in "This week"* are the 7 days of the **current plan week**, which starts on the weekday the plan
  was created, not Monday. Sessions have no assigned day, so dots/km show runs actually done that day,
  coloured by the session they filled (long = orange, quality = teal, easy/extra = muted).
- *Effort zone* by session type: easy and long = Z2, "Steady run" = Z3, "Tempo / intervals" = Z4.
- *Skip* stores nothing: the session stays planned and becomes missed if its week ends without a run.
- *Splits table* is always dashes: Google Health's exercise summary has no per-km data. The route stays
  a placeholder (no GPS).
- *Colours:* session types use the accent colours (long = orange, quality = teal, easy = grey);
  done = teal, missed = `#C96A5B`.

### 5.5 Plan generation: experience, fitness and races (v8)

`PlanGenerator.generate({ goalDistance, raceDate, currentVolume, runsPerWeek, experience, fitness })`
builds the plan. `experience` is one of `LEVELS` (`beginner`, `intermediate`, `experienced`; default
`intermediate`); `fitness` is one of `FITNESS` (default `active`). Both tables are at the top of
`planGenerator.js`, so tuning is a data change. Missing values fall back to the defaults, which
reproduce the behaviour of a plan built before the option existed.

**Principle: experience sets how far, fitness sets how fast.** Running experience limits the ceiling
(long runs and tendons adapt slowly whatever your general fitness); general fitness (job, gym, sport)
scales how quickly and how ambitiously the plan climbs to it. Current volume anchors both: a plan never
aims for more than 2.5× (or +12 km) what the runner does now.

**What a running-experience level changes**

| | Beginner | Intermediate | Experienced |
|---|---|---|---|
| Peak long run: 5K / 10K / half / marathon / 50K / 100K (km) | 6 / 10 / 14 / 28 / 30 / 34 | 8 / 14 / 18 / 32 / 35 / 40 | 10 / 16 / 21 / 35 / 38 / 45 |
| First long run (share of current weekly volume) | 40% | 40% | 30% |
| Longest a long run may be (share of that week)* | 50% | 40% | 35% |
| Weekly volume growth ceiling (compounded, per non-recovery week) | 7% | 9% | 10% |
| Wanted peak volume | max(1.4× current, 2.5× peak long run) | max(1.5×, 2.2×) | max(1.4×, 3.2×) |
| Recovery week (×0.8 volume, ×0.85 long run) | every 3rd | every 4th | every 4th |
| Minimum sensible weeks: 5K / 10K / half / marathon / 50K / 100K | 8 / 14 / 20 / 24 / 30 / 40 | 6 / 8 / 12 / 18 / 22 / 30 | 6 / 6 / 8 / 14 / 16 / 24 |

\* Never tighter than `1.5 / runsPerWeek` (a long run is naturally ~50% of a 3-run week, ~30% of a
5-run week). Without this an experienced runner on 3 runs a week got a *shorter* long run than a beginner.

**What a fitness level changes** (multipliers on the level's numbers)

| | Mostly sedentary | Lightly active | Active | Very active |
|---|---|---|---|---|
| Blurb on the form | Desk job, little other exercise | Some walking or the odd session | Exercise 2–3 days a week | Train 4+ days a week (gym, sport, running) |
| Growth ceiling | ×0.6 | ×0.8 | ×1 | ×1.2 |
| Peak volume (wanted and cap) | ×0.8 | ×0.9 | ×1 | ×1.1 |
| Peak long run | ×0.9 | ×0.95 | ×1 | ×1 |
| Recovery week | every 3rd at most | every 4th | every 4th | every 4th |
| Minimum weeks | ×1.25 | ×1.1 | ×1 | ×0.9 |

Recovery cadence is the more cautious of the level's and the fitness's. On the plan form the fitness
question starts on **Lightly active** (deliberately a little cautious; people tend to overrate
themselves). `Active` is the internal default for saved plans and code that doesn't pass a value.

**Rules that apply at every level**

- **Current fitness anchors the plan.** Peak weekly volume never exceeds
  `max(2.5 × current, current + 12 km) × fitness peak factor`, and never falls below current volume.
  There is also an absolute ceiling per race, `RACE_PEAK_MAX`: 60 / 80 / 100 / 120 / 130 / 145 km a week
  for 5K / 10K / half / marathon / 50K / 100K.
- **Sessions add up to the week.** A week's `targetVolume` is the sum of its session distances, so the
  chart, the week summary and the rows always agree. Every session is at least 2 km.
- **Session mix is the same at every level and race:** one long run, one quality run (`Steady run` in
  base, `Tempo / intervals` after; none in a 2-run taper) and easy runs sharing the rest, roughly equal
  with the quality run ~15% longer. (An explicit decision: experience changes distances and recovery
  cadence, not session types.)
- **Taper** steps volume down to ~50% of peak, and the long run to 60% of the longest one actually
  reached (so a capped plan doesn't taper *up*).
- **Ultras** (50K, 100K) use the same structure with higher long-run and volume targets. There are no
  back-to-back long runs, time-on-feet targets or walk-run guidance, and no vertical-gain planning;
  a single long run up to 45 km is the ultra long run.

**How the running-experience level is chosen.** `suggestLevel(volume, runsPerWeek)`: under 15 km a week
→ beginner; 40 km or more on 4+ runs → experienced; otherwise intermediate. The plan form pre-selects that
and keeps updating it as volume and runs change, until the runner picks a level themselves
(`levelTouched`). Race goal → Edit opens the form with the plan's saved level and fitness.

**Warnings.** `PlanGenerator.assess(inputs)` builds the plan and returns
`{ level, weeks, minWeeks, peakLong, targetLong, warnings[] }`. `minWeeks` and `targetLong` include the
fitness factors. There are two warnings: fewer weeks than `minWeeks` for that level, fitness and race,
and a longest run below 80% of the target (the volume cap stopped it getting there). The form shows
them once, in a box above the button, which becomes **Build it anyway**; changing any input clears the
warning. Nothing is blocked. `weeksUntil()` floors the length at 6 weeks, so a race closer than that is
planned as 6 weeks.

**Example (half marathon, 29 weeks, 3 runs a week, 8 km a week now):** beginner + sedentary peaks at
16 km a week with an 8 km long run; beginner + very active at 22 km with 11 km; experienced + very
active also 22 km with 11 km (current volume, not experience, is the limit there). At 20 km a week an
intermediate runner peaks at 29 km if sedentary and 43.5 km if very active.

---

## 6. Verification performed

The test scripts were **throwaway files in a temp scratchpad and are not in the repo**.

**Plan/run logic (37 checks, all passing):** one run fills exactly one session across repeated
syncs; a run earlier on plan-creation day counts; closest-distance matching; every fetched run
appears in the log with the right tag; the log is sorted newest-first; 0 km runs are not matched;
missed is derived, and a late run fills a past-week session; legacy stored `'missed'` is
normalised; missed long run adjusts next week once; manual mark/undo, including rejecting blank or
zero distance, double-marking and undoing synced sessions; week totals include extra runs; streak
counts, doesn't break on unresolved current-week sessions, and resets on a past miss; days-to-race is
never negative; pace calculation and its fallbacks.

**`fetchRecentRuns` (mocked API):** correct host and path; filter string; `pageSize=25`;
`nextPageToken` followed; `WALKING` excluded and `RUNNING`/`TREADMILL` kept; km, minutes and heart-rate
conversion; oldest-first ordering; duplicate collapsing (4 → 3 entries) and keeping the richer copy.

**Token/expiry logic (stubbed browser globals):** connect callback stores a numeric-expiry token;
expired fetch throws `token_expired` and clears storage; `isConnected` clears an expired token; a 401
is treated as expiry; an error response notifies the UI.

**Browser pane (localhost, mocked Google response):** clicked the real **Sync now** button (9 runs
found, 2 `WALKING` entries excluded, duplicate collapsed); three syncs left the done-count unchanged;
the manual flow (open form → type 8.5 km → Save → week total 30.6 / 27, streak 2 → 10, log entry
tagged Manual, Undo present); unmatched-run tags; the expired-session path (a bogus token against the
real Google endpoint returned 401 and the UI fell back to the amber Connect state); layout at 375 px
with no horizontal overflow, in both the connected and disconnected sync-bar states. (These checks
were against the pre-v6 UI.)

**v6 redesign (browser pane, 390×844, seeded plan + stubbed `fetchRecentRuns`):** all four tabs and
session detail render; tab switching; hero card → detail → Back returns to Today; Plan row → detail;
Mark done via the sheet (9.8 km saved, footer switches to Undo); two syncs left the done-count unchanged;
the syncing state shows in Profile; future weeks have no Mark done; accordion expands; Edit race goal →
Cancel; Start over → onboarding → new plan; no horizontal overflow; no left-border accents; no console
errors. **Not tested:** Safari/iOS itself, and real Google sign-in from the home-screen app.

**v8 experience, fitness and ultras:** a throwaway Node script (not in the repo) generated 1,728 plans
(3 levels × 4 fitness levels × 6 races × 6 runner profiles × 5 lengths, including 0 km and 2-run edge
cases) and asserted: every session ≥ 2 km with the right number of runs and no NaN; sessions sum to the
week; long run within the level's share (+ rounding); peak volume within the cap scaled by fitness;
peak volume and longest run rise beginner < intermediate < experienced for one runner; at each level,
peak volume rises sedentary < light < active < very active and the longest run never falls; recovery
weeks fall on 3, 6, 9… for beginners and sedentary runners; one quality run per week; a 5 km-a-week
beginner gets a 6 km first week (was 15 km); "active" is identical to passing no fitness; the
experienced low-volume runner's long run is not shorter than a beginner's; the sedentary beginner is
gentler than the very active experienced runner; `suggestLevel` at its thresholds; longest run rises
marathon < 50K < 100K at every level; `assess` warns for a beginner half in 14 weeks, a beginner
marathon from 15 km, a sedentary beginner 100K, and a sedentary-intermediate half in 16 weeks (but not
a very active one), and is quiet for realistic experienced ultra plans. In the browser pane (390×844):
the selector pre-selects from volume as it is typed and stops once overridden; the fitness cards
render with "Lightly active" selected; the warning appears once, clears on any edit, and "Build it
anyway" builds the plan with `experience` and `fitness` saved; Race goal → Edit pre-fills both; a
50K ultra plan builds for an experienced, very active runner and shows as "50K ultra plan"; Profile shows
Experience and Fitness rows.

**Not verified on real data:** everything past the API call for an actual run. See below.

---

## 7. Open items and risks

**Highest priority**

1. **No real run has been through the app yet.** Auth, host, path, filter, paging and distance parsing
   are proven against real data (the raw call returned real sessions). Unproven on real data: that an
   Apple Watch run arrives as one of the four `RUN_TYPES`, that heart rate arrives in
   `averageHeartRateBeatsPerMinute`, and the in-app match to a planned session. **Next step:** log a
   short run, wait for it to sync to Google Health, then **Sync now**. If the run is missing, run the
   unfiltered raw call (snippet below) to see how it was labelled, and add that type to `RUN_TYPES`
   in `js/healthSync.js`.
2. **iPhone home-screen PWA vs the GIS popup.** The connect flow has only been exercised in a desktop
   browser. Popups from an iOS standalone (Add to Home Screen) web app can behave differently or be
   blocked. Untested.

**Known limitations / decisions worth revisiting**

- **Token lasts ~1 hour, no refresh.** Long sessions will need a reconnect. Fixing this properly needs a
  backend (auth-code flow with a secret) or a different GIS approach.
- **Matching is "closest planned session by distance".** A short jog can fill a long-run slot if it is
  the only one left in the week. The run log makes such matches visible; no minimum-distance guard
  exists.
- **A manual completion plus a real run for the same day double-counts** (both add to week km, and the
  real run may fill another session).
- **`RUN_TYPES` includes `TREADMILL`** (a judgement call). Change it to `RUNNING` only if treadmill
  walking shows up as runs.
- **Extra scopes** (`health_metrics_and_measurements`, `location`) are requested but unused.
- **Single device, localStorage only.** Clearing site data deletes the plan (runs re-sync; manual
  completions are lost).
- **Dedupe window is 2 minutes**, by start time. Two genuinely separate runs starting within that
  window would collapse (unlikely).
- **500-session cap** (20 pages × 25) on a sync. Plenty for a plan window, but silent if exceeded.
- **The "Enter" key in the manual-distance form** (now the bottom sheet) could not be tested in the
  browser tool (its synthetic Enter doesn't submit forms); clicking Save works and a real browser submits on Enter.
- **The test scripts are not in the repo.** Worth turning into a real `tests/` folder if the maths grows
  — the plan generator is now the largest piece of pure logic (§5.5).
- **Level and fitness numbers are rules of thumb, not coaching science.** The long-run peaks, growth
  caps, share limits, `RACE_PEAK_MAX` and minimum weeks in `LEVELS` / `FITNESS` (§5.5) were chosen to
  give sensible, cautious plans and checked against a range of example runners, but no coach has
  reviewed them. Treat them as tunable.
- **Ultra plans are a first cut.** Same session mix as road races; no back-to-back long runs, time-on-feet
  or vertical targets. A beginner or sedentary runner picking a 100K is told it needs ~50 weeks.
- **Fitness is self-reported.** It is one question with four options, not read from Google Health
  activity data. Inferring it from synced data is a possible later step.
- **Plans saved before v8 keep their old sessions.** They read as Intermediate / Active on Profile even
  though the old generator built them; use Race goal → Edit to rebuild under a level.
- **The plan still assumes the runner's stated volume is honest.** It never looks at synced runs when
  generating; only a missed long run adjusts anything (`adjustForMiss`).

**Diagnostic snippet** (paste in the browser console on the live page while connected; prints the 25
most recent sessions with no filtering or type matching):

```js
const t = JSON.parse(localStorage.splits_health_token).access_token; fetch('https://health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints?pageSize=25', { headers: { Authorization: 'Bearer ' + t } }).then(r => r.json().then(j => { console.log(r.status, j); console.table((j.dataPoints || []).map(p => ({ type: p.exercise?.exerciseType, name: p.exercise?.displayName, start: p.exercise?.interval?.startTime, km: (p.exercise?.metricsSummary?.distanceMillimeters || 0) / 1e6 }))); }))
```

And to run the app's own path: `HealthSync.fetchRecentRuns('2026-08-01').then(console.table)`.

---

## 8. Operating notes

### 8.1 Releasing a change

1. Edit the files. Syntax-check with `node --check js/*.js service-worker.js`.
2. **Bump the version in two places together:**
   - `APP_VERSION` in `js/app.js` (e.g. `'v9'`)
   - `CACHE_NAME` in `service-worker.js` (`'splits-v9'`)
   The service worker is **cache-first**, so without a new `CACHE_NAME` returning users keep the old files. The App version row in Profile flags a mismatch, and **Check for updates** only sees a release whose `CACHE_NAME` changed.
3. If you add a JS file, also add it to `APP_SHELL` in `service-worker.js` and a `<script>` tag in `index.html` (in dependency order).
4. Commit and push to `main`. Pages redeploys in about a minute.
5. Check the build finished and the live site matches:
   ```bash
   gh api repos/football-dev/splits-pwa/pages/builds/latest --jq '.status + " " + .commit[0:7]'
   curl -s "https://football-dev.github.io/splits-pwa/service-worker.js?nocache=$(date +%s)" | head -1
   ```

### 8.2 Seeing the new version in a browser

Clear the old service worker: DevTools → Application → Clear site data (or Unregister), then
hard-refresh. On a phone, or anywhere without DevTools, use **Profile → Check for updates**. The
App version row in Profile should show the new `APP_VERSION`.

### 8.3 Local preview

```bash
cd ~/splits-pwa && python3 -m http.server 8123 --bind 127.0.0.1
```
Open http://127.0.0.1:8123. Service workers work on `localhost`, so clear site data between versions.
Note that a stored token pointing at Google with a fake value will 401 on load and disconnect —
which is a handy way to see the expired-session state.

### 8.4 Access

- GitHub CLI is authenticated as `football-dev` (scopes `gist`, `read:org`, `repo`, `workflow`); HTTPS
  push works via the macOS keychain credential.
- Pages source: branch `main`, path `/`.
- Commits made in this work carry the `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.

---

## 9. Suggested next steps

1. Record a real run and complete the verification in section 7 (item 1). Adjust `RUN_TYPES` if needed.
2. Test Connect from the iPhone home-screen app (section 7, item 2).
3. Decide whether to add a minimum-distance guard to matching, and whether to move the maths tests into the repo.
4. Consider dropping the two unused scopes (needs re-consent).
5. If the hour-long token becomes annoying: design a small backend token exchange or accept the
   reconnect prompt.
