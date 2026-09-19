/**
 * healthSync.js
 * OAuth2 (PKCE) against the Google Health API — the API family formerly
 * known as the Fitbit Web API, now also serving data synced in from
 * Apple Health (i.e. your Apple Watch runs land here too).
 *
 * IMPORTANT — before this works you need to:
 *   1. Register an app at the Google Health / Fitbit developer console
 *      to get a CLIENT_ID. Use "Client-Side" / PKCE app type since this
 *      is a browser app with no backend to hold a secret.
 *   2. Set REDIRECT_URI below to wherever you host this app (must match
 *      exactly what you register).
 *   3. Confirm AUTH_ENDPOINT / TOKEN_ENDPOINT / API_BASE against the
 *      current Google Health API docs — these are carried over from the
 *      legacy Fitbit Web API shape and may have moved as part of the
 *      2026 rebrand, so verify before relying on them.
 */

const HealthSync = (() => {

  const CLIENT_ID = '999514215655-bsk9nklad96oae4vm1gs255aklaqnatv.apps.googleusercontent.com';
  const REDIRECT_URI = window.location.origin + window.location.pathname;
  const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
  const API_BASE = 'https://healthapi.googleapis.com/v1'; // verify against developers.google.com/health before relying on it
  const SCOPES = [
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.location.readonly'
  ];

  const STORAGE_KEY = 'splits_health_token';

  function base64UrlEncode(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256(plain) {
    const data = new TextEncoder().encode(plain);
    return crypto.subtle.digest('SHA-256', data);
  }

  function randomString(length = 64) {
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    return base64UrlEncode(arr.buffer).slice(0, length);
  }

  async function beginAuth() {
    const verifier = randomString(64);
    const challenge = base64UrlEncode(await sha256(verifier));
    sessionStorage.setItem('pkce_verifier', verifier);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(' ')
    });

    window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  async function handleRedirectIfPresent() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return false;

    const verifier = sessionStorage.getItem('pkce_verifier');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!res.ok) {
      console.error('Token exchange failed', await res.text());
      return false;
    }

    const token = await res.json();
    token.obtained_at = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(token));

    // Clean the auth code out of the URL.
    window.history.replaceState({}, document.title, REDIRECT_URI);
    return true;
  }

  function getToken() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function isConnected() {
    return !!getToken();
  }

  function disconnect() {
    localStorage.removeItem(STORAGE_KEY);
  }

  async function authorisedFetch(path) {
    const token = getToken();
    if (!token) throw new Error('Not connected to Google Health');

    // TODO: refresh token here if expired, using token.refresh_token
    // against TOKEN_ENDPOINT with grant_type=refresh_token.

    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!res.ok) throw new Error(`Google Health API error: ${res.status}`);
    return res.json();
  }

  // Pull recent runs. Endpoint shape follows the legacy Fitbit
  // "activities/list" call — confirm against current docs.
  async function fetchRecentRuns(sinceISODate) {
    const data = await authorisedFetch(
      `/activities/list.json?afterDate=${sinceISODate}&sort=asc&limit=50&offset=0`
    );
    const activities = data.activities || [];
    return activities
      .filter(a => /run/i.test(a.activityName || ''))
      .map(a => ({
        date: a.startTime,
        distanceKm: a.distance,
        durationMin: Math.round((a.duration || 0) / 60000),
        avgHeartRate: a.averageHeartRate || null
      }));
  }

  return { beginAuth, handleRedirectIfPresent, isConnected, disconnect, fetchRecentRuns };
})();
