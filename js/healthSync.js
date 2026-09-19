/**
 * healthSync.js
 * Google Identity Services (GIS) token flow against the Google Health API —
 * the API family formerly known as the Fitbit Web API, now also serving data
 * synced in from Apple Health (i.e. your Apple Watch runs land here too).
 *
 * How auth works: GIS opens a Google consent popup and hands back a
 * short-lived access token (about an hour). There is no refresh token and no
 * client secret — when the token expires the user reconnects.
 *
 * Google Cloud Console setup: the OAuth client must be a "Web application"
 * with this app's origin (https://football-dev.github.io) listed under
 * Authorised JavaScript origins.
 *
 * API_BASE and the fetchRecentRuns() endpoint/response shape are still
 * unverified against the current Google Health API docs.
 */

const HealthSync = (() => {

  const CLIENT_ID = '999514215655-bsk9nklad96oae4vm1gs255aklaqnatv.apps.googleusercontent.com';
  const API_BASE = 'https://healthapi.googleapis.com/v1'; // verify against developers.google.com/health before relying on it
  const SCOPES = [
    'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.location.readonly'
  ];

  const STORAGE_KEY = 'splits_health_token';
  const DEFAULT_LIFETIME_S = 3600;
  const EXPIRY_SKEW_MS = 60 * 1000; // treat the token as expired a minute early

  let tokenClient = null;
  const listeners = [];

  // Subscribe to connection changes. fn receives { reason?, error? }:
  // reason 'expired' when a stored token lapsed, error when sign-in failed.
  function onChange(fn) {
    listeners.push(fn);
  }

  function notify(detail = {}) {
    listeners.forEach(fn => fn(detail));
  }

  function saveToken(response) {
    const token = {
      access_token: response.access_token,
      expires_in: Number(response.expires_in) || DEFAULT_LIFETIME_S,
      obtained_at: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(token));
  }

  function handleTokenResponse(response) {
    if (response.error || !response.access_token) {
      console.error('Google sign-in failed', response);
      notify({ error: response.error_description || response.error || 'no_token' });
      return;
    }
    saveToken(response);
    notify();
  }

  function handleTokenError(err) {
    // Closing the popup is a normal cancel, not a failure worth a toast.
    if (err && err.type === 'popup_closed') return;
    console.error('Google sign-in error', err);
    notify({ error: (err && err.type) || 'unknown' });
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      throw new Error('Google sign-in is still loading — try again in a moment');
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
      callback: handleTokenResponse,
      error_callback: handleTokenError
    });
    return tokenClient;
  }

  // Must be called straight from a click handler so the popup isn't blocked.
  function beginAuth() {
    ensureTokenClient().requestAccessToken();
  }

  function readToken() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function isExpired(token) {
    return Date.now() >= token.obtained_at + token.expires_in * 1000 - EXPIRY_SKEW_MS;
  }

  // Returns a live token, or null (clearing any expired one from storage).
  function getToken() {
    const token = readToken();
    if (!token) return null;
    if (!token.access_token || !token.obtained_at || !token.expires_in || isExpired(token)) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return token;
  }

  function isConnected() {
    return !!getToken();
  }

  function disconnect() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function expire() {
    disconnect();
    notify({ reason: 'expired' });
    const err = new Error('Google Health session expired — reconnect to sync');
    err.code = 'token_expired';
    return err;
  }

  async function authorisedFetch(path) {
    const hadToken = !!readToken(); // getToken() clears an expired token
    const token = getToken();
    if (!token) {
      if (hadToken) throw expire(); // was connected, lapsed
      throw new Error('Not connected to Google Health');
    }

    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (res.status === 401) throw expire(); // revoked or expired server-side
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

  return { beginAuth, onChange, isConnected, disconnect, fetchRecentRuns };
})();
