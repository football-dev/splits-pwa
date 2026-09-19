# Splits — Redesign Handover

> **Status:** implemented in commit `de60423` (v6), 2026-09-19. This is the brief as written, kept as a
> record of why the UI looks the way it does. The "Source of truth" link below points to a private
> design file that only its owner can open. Where the build differs from the brief, see
> [How the build departed from this brief](#how-the-build-departed-from-this-brief) at the end.

2026-09-19 · prepared by @Someone

## Purpose & scope

This handover briefs whoever implements the redesign (Claude Code or another engineer) on rebuilding Splits' UI. It assumes no memory of the design conversation, so it restates the decision rather than describing every pixel in prose.

**What to build**: the "Combined" direction from the design exploration — a tabbed app (Today / Plan / Progress / Profile) that pairs an earlier concept's glanceable landing screens with a data-dense Progress tab and session-detail screen, redrawn in one consistent dark/orange palette.

**Source of truth**: [Splits Redesign Concepts artifact](https://claude.ai/artifact/KwKxYXryxFWx25Axgn8ZoK) — open it in Play mode and click through Today → Plan → a session → Progress → Profile (row 4, labelled "Combined"). Every colour, spacing and layout value in this doc was taken directly from that artifact's markup; if this doc and the artifact ever disagree, the artifact wins.

**Why this direction**: it keeps a calm, glance-first landing on Today and Plan, while giving Progress and session detail enough density for a coach checking a training block — rather than trading one off against the other.

## Current app baseline

Splits is a vanilla HTML/CSS/JS Progressive Web App with no framework and no backend:

| File | Role |
| --- | --- |
| `index.html` | App shell |
| `manifest.json` | PWA metadata |
| `service-worker.js` | Offline caching |
| `css/styles.css` | All styling |
| `js/planGenerator.js` | Periodised plan logic (base → build → peak → taper) |
| `js/healthSync.js` | Google Health OAuth + sync |
| `js/app.js` | Form handling, localStorage, rendering |

Plans and progress live in `localStorage` only — single device, no accounts, no server. Runs are pulled from Google Health and matched to planned sessions by distance.

**Keep unchanged**: the tech stack (no framework, no build step, no backend), the data model in `planGenerator.js` and `healthSync.js`, localStorage-only storage, and the fact that this app has no GPS tracking, no live pace and no maps — it plans and reviews, it doesn't record a run in progress. This is a UI/IA rebuild on top of the existing logic, not a rewrite of it.

## Information architecture

Replace the current single long scroll with a bottom-tabbed app shell:

| Tab | Purpose |
| --- | --- |
| Today | Landing screen: today's session as a hero card, at-a-glance stats, this week's day strip |
| Plan | The full periodised plan, one card per week, sessions grouped by phase |
| Progress | Data view: week heatmap, stat grid, phase-banded volume chart |
| Profile | Google Health connection, race goal, preferences, reset |

A fifth screen, **session detail**, is not a tab — it's reached by tapping a session row in Plan or the hero card on Today, and has no tab bar of its own (a detail view doesn't compete with top-level navigation).

## Design tokens

**Colour**

| Token | Hex | Use |
| --- | --- | --- |
| Background | `#12181C` | App background |
| Card | `#1B2329` | Cards, chips |
| Card border (subtle) | `#232D31` / `#2A3438` | Dividers, outlines |
| Text primary | `#F4F1EA` | Headings, body |
| Text muted | `#8A968C` | Labels, secondary text |
| Text faint | `#566260` | Placeholders, disabled |
| Accent (primary) | `#E08D3C` | Primary actions, active tab, highlights |
| Accent (secondary) | `#3FA796` | Completed states, positive deltas |

**Typography**

- Display/headings: **Fraunces** (500/600) — via Google Fonts
- Numeric/data (Progress tab, session detail): **JetBrains Mono** (500/600)
- Body/UI text: **IBM Plex Sans** (400/500/600)

**Spacing & shape**: 8px spacing scale, 12–20px corner radius on cards, 44px minimum tap target on all buttons and tab items.

**Icon rule**: no left-border accent strips on list rows (the current app's pattern) — use a small 30×30px rounded icon chip with a coloured letter/glyph instead (see Plan tab spec). Icons are inline stroke SVG, never emoji.

## Today tab

Reference artboard: `C4-Today.dc.html`.

Top row: date + "Morning, \[name\]" (Fraunces 24px), streak pill top-right (flame icon + streak count from existing streak logic).

Hero card (`#1B2329`, 20px radius): eyebrow label "Today · Week N" in accent orange, session name (Fraunces 28px), distance/pace/duration line, then a two-button row — **Start run** (filled orange, primary) and **Mark done** (outlined). Tapping the card body (not the buttons) opens session detail.

Three-up stat row: Days to race, Week volume (X/Y km), Streak — same data already computed by `app.js` for the current dashboard cards.

"This week" day strip: 7 pills (Mon–Sun), each showing a coloured dot for session type (orange = long, teal = quality, muted = easy/rest) and today's pill outlined in accent orange.

Sync/empty-state card at the bottom, reusing the existing "No runs found… tap Sync now" copy and logic from `healthSync.js`.

## Plan tab

Reference artboard: `C4-Plan.dc.html`.

Header: plan name + "N days to race · week X of Y". Below it, a four-segment phase progress bar (Base/Build/Peak/Taper) with the current phase highlighted in accent orange and labelled underneath.

Below that, one card per week:

- **Current/expanded week**: week number (Fraunces, accent), phase + volume summary, then one row per session — a 30px icon chip (L/Q/E lettered, colour per type), name, distance, and a "Mark done" button. Tapping a session row (not the button) opens session detail.
- **Future/collapsed weeks**: single-line summary card — week number, phase, session count, total km, chevron — expands on tap (or, for a first pass, taps through as a flat list; a real accordion can follow).

This replaces the current build's flat 32-week list of always-expanded cards, which is the main scroll-length problem today.

## Progress tab

Reference artboard: `C4-Progress.dc.html`.

Header: "Progress" + plan/phase/week subtitle.

Week heatmap strip: 7 cells (Mon–Sun), each showing the day letter and a JetBrains Mono distance value; today's cell filled in a warm tint, future/rest days shown muted with an en-dash.

2×2 stat grid: Week volume (with a thin progress bar), Avg pace (with a trend delta), Streak, Readiness (a derived score — flag to whoever owns the data model if this doesn't exist yet; if not, drop this tile or swap in an existing metric).

Volume-by-week chart: full-width bar chart, one bar per week (1–32), muted bars for target/undone weeks, accent orange for the current week, teal for a completed week that beat target, with a subtle phase-band tint behind the base-phase bars. This is a restyle of the existing chart already in `app.js`/`styles.css` — same data, new visual treatment (rounded bar tops, muted grid, mono axis labels).

## Session detail

Reference artboard: `C4-Session.dc.html`.

Header: back chevron (returns to Plan) + session name (Fraunces) + "Week N · phase" subtitle.

Three-up stat chips (mono numerals): km target, pace/km, effort zone.

Effort zone bar: five-segment horizontal bar (Z1–Z5), current zone highlighted in accent teal, with a caption row underneath.

Route placeholder: dashed-border card with a route icon and "Route appears once the run is synced" — this app has no GPS, so this stays a placeholder until/unless Google Health ever returns route data; don't build a live map.

Splits table: km / pace / HR / elevation columns, mono type, populated once the matched Google Health run has per-km data — otherwise shows dashes as in the mockup.

Footer actions: **Mark done** (filled orange) and **Skip** (outlined) — wire to the same mark-done/skip logic already used by the current session rows.

## Profile tab (new)

Reference artboard: `C4-Profile.dc.html`.

This tab doesn't exist in the current build — it consolidates settings and account actions currently scattered (the top banner's Sync/Disconnect, the header's Start over button) into one place, plus room for preferences that don't exist yet but should be planned for.

Contents, top to bottom:

1. Identity row — avatar placeholder + name + "Training for a \[race\]" line.
2. Google Health card — connection status dot, "last synced" text, **Sync now** / **Disconnect** buttons (move directly from the current top banner).
3. Settings list — Race goal (with Edit), Units, Rest day, Notifications. Units/Rest day/Notifications are new preferences; if there's no time to build real settings screens behind them in this pass, ship them as static/display-only rows and flag as follow-up.
4. Footer — **Start over** (moved from the current header button) and **Sign out**, plus the app version string.

## Implementation notes

**Tab switching**: this is a single-page vanilla-JS PWA with no router. Use a simple view-swap pattern — one root container, four tab view templates (or template functions), a `showTab(name)` function that toggles a `data-active` attribute / `display` style and updates the active state on the bottom tab bar. No full page reload, no hash routing needed unless deep-linking is a requirement. Keep it in `js/app.js` or split into `js/tabs.js` if it grows.

**Session detail as a "screen"**: implement as a fifth view in the same swap mechanism (not a separate route/page), pushed over the Plan/Today view with its own back action. State (which session is open) can live in a small in-memory variable — no need for real routing.

**Data mapping**:

- Today's hero card ← the next incomplete session from `planGenerator.js`'s current week
- Plan tab week cards ← the full plan array already generated and stored in `localStorage`
- Progress tab stats/chart ← the same aggregate data currently feeding the existing weekly volume chart and stat cards
- Session detail ← a single session object from the plan, plus any matched Google Health activity from `healthSync.js`
- Profile tab connection card ← existing OAuth/token state in `healthSync.js`

**New CSS**: the token table in this doc (colours, Fraunces/JetBrains Mono/IBM Plex Sans, spacing/radius) should replace the current `css/styles.css` values rather than being added alongside them — check specifically for the left-border row style, since that pattern is being retired everywhere (see Design tokens).

**Fonts**: add Fraunces, JetBrains Mono and IBM Plex Sans via Google Fonts `<link>` tags in `index.html`.

**manifest.json / service-worker.js**: no changes required for the IA change itself, but bump the service worker's cache version so the new HTML/CSS/JS ships to installed PWA users on next load.

## Acceptance checklist

- [ ] Four-tab bottom navigation works (Today, Plan, Progress, Profile) with correct active-state styling
- [ ] Today shows the next incomplete session, correct stats, and this week's day strip; tapping the hero card opens session detail
- [ ] Plan lists all weeks, current week expanded with tappable session rows, other weeks collapsed/summarised
- [ ] Progress shows the week heatmap, stat grid and restyled volume chart, all reading from existing data (no new backend calls)
- [ ] Session detail shows stats, effort zone, route placeholder, splits table (with dashes when unsynced), and working Mark done / Skip
- [ ] Profile consolidates Google Health connect/sync/disconnect and Start over from their current locations
- [ ] No left-border accent strips remain anywhere in the UI — icon chips used instead
- [ ] Colour, type and spacing match the design tokens table, not the current app's values
- [ ] No GPS/map/live-tracking functionality was added — the route section stays a placeholder
- [ ] Tested at 390×844 (phone) viewport in Safari, since this is an iPhone-first PWA with no App Store install

## How the build departed from this brief

Added after implementation (`de60423`). Each point is either a gap in the data model or a
judgement call; the brief's "keep unchanged" constraints (no backend, no GPS, data model as is) won
where they conflicted with the mockups.

- **"This week" day strip (Today) and heatmap (Progress):** plan weeks start on the weekday the plan was
  created, not Monday, and sessions have no assigned day. Both show the 7 days of the current plan
  week with real weekday labels, and the dots/km reflect runs actually done that day (coloured by the
  session each run filled), not planned sessions.
- **Readiness tile:** no such metric exists, so it was swapped (as the brief allows) for
  **Sessions** — done / due so far.
- **Effort zone:** the data has no zones. The UI assigns them by session type: easy and long = Z2,
  "Steady run" = Z3, "Tempo / intervals" = Z4. The zone bar shows the current zone in teal over a
  dimmed Z1–Z5 ramp.
- **Pace:** only real numbers are shown — the matched run's pace, else the average across synced runs,
  else a dash. The hero's "~N min" estimate uses that average and is omitted without one.
- **Start run:** shows a toast ("Record the run on your watch — Splits picks it up when you sync"),
  since the app records nothing.
- **Skip:** there is no skip state in the data model, so nothing is stored. The session stays planned
  and counts as missed if its week ends without a run.
- **Sign out:** left out. There are no accounts; Disconnect covers Google Health.
- **Units / Rest day / Notifications:** display-only rows (Kilometres / Not set / Off). Follow-up if
  real preferences are wanted.
- **Name:** the greeting and identity row need a name that Google doesn't provide (no profile scope),
  so it is set by tapping the Profile identity row and stored locally in `splits_profile`.
- **Race goal → Edit:** reopens the plan form pre-filled; saving rebuilds the plan (with a confirm),
  replacing progress on the old one.
- **Recent runs log:** not in the brief's IA; kept at the bottom of Progress so the feature isn't lost.
- **Mark done:** uses a bottom sheet with a distance field (pre-filled with the planned km), shared by
  Today, Plan and session detail. Manual completions show **Undo**.
- **Plan tab:** collapsed weeks are a real accordion rather than the brief's flat-list first pass.
- **Version label:** moved from the bottom-right corner into the Profile footer.
- **`manifest.json`:** background/theme colour updated to `#12181C` to match the new background.
