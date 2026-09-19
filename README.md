# Splits

A training plan generator and run tracker that reads completed runs from
Google Health (your Apple Watch runs, synced in via Apple Health → Google
Health). Built as a PWA so it lives entirely in Safari on your iPhone,
no App Store, no Xcode.

## What's here

```
index.html          app shell
manifest.json        PWA metadata (name, icons, standalone display)
service-worker.js    offline caching of the app shell
css/styles.css        all styling
js/planGenerator.js  rules-based plan logic — no network calls
js/healthSync.js      OAuth + Google Health API calls
js/app.js              wires the form, storage and rendering together
icons/                 placeholder icons — replace before shipping
```

## Running it locally

Any static file server works. From this folder:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000` in Safari on your Mac to check it
renders. You can't test the "Add to Home Screen" flow or Google Health
OAuth over plain HTTP though — both need a real HTTPS host (see below).

## Deploying so your iPhone can install it

PWAs need HTTPS to install to the home screen and to run a service
worker. Cheapest paths, all free for a single small app:

- **GitHub Pages** — push this folder to a repo, enable Pages in
  settings. Get a `github.io` HTTPS URL for free.
- **Netlify** or **Vercel** — drag-and-drop deploy, also free, gives
  you HTTPS immediately.

Once it's live, open the URL in Safari on your iPhone, tap Share →
**Add to Home Screen**. It'll launch full-screen like a native app from
then on.

## Connecting Google Health

1. Register an app at the Google Health / Fitbit developer console to
   get a `CLIENT_ID`. Choose the client-side / PKCE app type — this app
   has no backend to hold a secret.
2. In `js/healthSync.js`, set `CLIENT_ID` and check `REDIRECT_URI`
   matches whatever HTTPS URL you deployed to (must match exactly what
   you register).
3. Confirm `AUTH_ENDPOINT`, `TOKEN_ENDPOINT`, and `API_BASE` against
   the current Google Health API docs. These are scaffolded from the
   legacy Fitbit Web API shape (Google Health's API is the same family,
   rebranded in 2026) — worth double-checking nothing's moved before
   you rely on it.
4. On your iPhone: Apple Watch → Apple Health (records the run,
   including GPS) → Google Health (via the Apple Health sync you've
   already set up) → this app pulls it in via the API.

## What it does right now

- Generates a periodised plan (base → build → peak → taper) from goal
  distance, race date, current weekly volume and runs/week
- Stores the plan in `localStorage` — one device, no account needed
- On load, pulls recent runs from Google Health and matches them
  against planned sessions by distance
- If a long run is missed, holds the next week's volume flat instead
  of progressing

## What it doesn't do yet

- No live in-run tracking — that still happens in the Apple Watch
  Workout app; this app reads the result afterwards
- No refresh-token handling in `healthSync.js` — tokens will expire
  and you'll need to reconnect (marked with a `TODO` in the code)
- Matching a run to a session is nearest-by-distance only — no pace
  or day-of-week logic yet
- Icons in `/icons` are placeholders, swap for real artwork
