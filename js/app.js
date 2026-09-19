/**
 * app.js
 * Wires the onboarding form, stored plan, and Google Health sync
 * together. Plan lives in localStorage for now — swap PLAN_KEY storage
 * for a backend once this needs to move across devices.
 */

const PLAN_KEY = 'splits_plan';

// Keep in step with CACHE_NAME in service-worker.js ('splits-' + APP_VERSION).
const APP_VERSION = 'v4';

// Shows the version this page is running. If a newer service worker has
// already taken over the cache, flag that a reload is needed to pick it up.
async function showVersion() {
  const el = document.getElementById('appVersion');
  el.textContent = APP_VERSION;
  try {
    const active = (await caches.keys()).find(k => k.startsWith('splits-'));
    if (active && active !== `splits-${APP_VERSION}`) {
      el.textContent = `${APP_VERSION} · ${active.slice('splits-'.length)} available, reload`;
    }
  } catch (err) {
    // Cache API unavailable (e.g. insecure context) — the plain version is enough.
  }
}

const distanceLabels = { 5: '5K', 10: '10K', 21.1: 'Half marathon', 42.2: 'Marathon' };

function loadPlan() {
  const raw = localStorage.getItem(PLAN_KEY);
  return raw ? JSON.parse(raw) : null;
}

function savePlan(plan) {
  localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3200);
}

function currentWeekNumber(plan) {
  const start = new Date(plan.createdAt);
  const weeksElapsed = Math.floor((Date.now() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return Math.min(plan.totalWeeks, weeksElapsed + 1);
}

function renderPlan(plan) {
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('planView').classList.remove('hidden');

  document.getElementById('planTitle').textContent =
    distanceLabels[plan.goalDistance] || `${plan.goalDistance}K`;
  document.getElementById('totalWeeks').textContent = plan.totalWeeks;
  const curWeek = currentWeekNumber(plan);
  document.getElementById('currentWeekNum').textContent = curWeek;

  const list = document.getElementById('weekList');
  list.innerHTML = '';

  plan.weeks.forEach(week => {
    const row = document.createElement('div');
    row.className = 'week-row' + (week.weekNumber === curWeek ? ' current' : '');

    const num = document.createElement('div');
    num.className = 'week-num';
    num.textContent = String(week.weekNumber).padStart(2, '0');

    const body = document.createElement('div');

    const phase = document.createElement('div');
    phase.className = 'week-phase';
    phase.textContent = `${week.phase} · ${week.targetVolume} km${week.adjusted ? ' · adjusted' : ''}`;

    const sessions = document.createElement('div');
    sessions.className = 'session-list';

    week.sessions.forEach(s => {
      const el = document.createElement('div');
      el.className = 'session';

      const nameWrap = document.createElement('div');
      nameWrap.className = 'session-name';
      const name = document.createElement('span');
      name.textContent = s.name;
      const detail = document.createElement('span');
      detail.className = 'session-detail';
      detail.textContent = `${s.distance} km`;
      nameWrap.append(name, detail);

      const status = document.createElement('span');
      status.className = 'session-status' + (s.status === 'done' ? ' done' : s.status === 'missed' ? ' missed' : '');
      status.textContent = s.status === 'done' ? 'Done' : s.status === 'missed' ? 'Missed' : 'Planned';

      el.append(nameWrap, status);
      sessions.appendChild(el);
    });

    body.append(phase, sessions);
    row.append(num, body);
    list.appendChild(row);
  });
}

function updateConnectButton() {
  const btn = document.getElementById('connectBtn');
  btn.textContent = HealthSync.isConnected() ? 'Google Health connected' : 'Connect Google Health';
}

// Match completed runs against this week's long run / quality session.
// Deliberately simple for a first pass: closest planned session by
// distance gets marked done; anything from a past week left "planned"
// becomes "missed".
function reconcileRuns(plan, runs) {
  runs.forEach(run => {
    const runDate = new Date(run.date);
    const weekIndex = Math.floor(
      (runDate - new Date(plan.createdAt)) / (7 * 24 * 60 * 60 * 1000)
    );
    const week = plan.weeks[weekIndex];
    if (!week) return;

    const candidate = week.sessions
      .filter(s => s.status === 'planned')
      .sort((a, b) => Math.abs(a.distance - run.distanceKm) - Math.abs(b.distance - run.distanceKm))[0];

    if (candidate) candidate.status = 'done';
  });

  const curWeek = currentWeekNumber(plan);
  let adjusted = false;
  plan.weeks.forEach(week => {
    if (week.weekNumber < curWeek) {
      week.sessions.forEach(s => {
        if (s.status === 'planned') {
          s.status = 'missed';
          if (s.type === 'long') {
            PlanGenerator.adjustForMiss(plan, week.weekNumber);
            adjusted = true;
          }
        }
      });
    }
  });

  return adjusted;
}

async function syncRuns(plan) {
  if (!HealthSync.isConnected()) return;
  try {
    const runs = await HealthSync.fetchRecentRuns(plan.createdAt.slice(0, 10));
    const adjusted = reconcileRuns(plan, runs);
    savePlan(plan);
    renderPlan(plan);
    if (adjusted) showToast('Plan adjusted after a missed long run');
  } catch (err) {
    console.error(err);
    if (err.code === 'token_expired') return; // onChange already told the user
    showToast('Could not sync with Google Health');
  }
}

async function init() {
  showVersion();
  HealthSync.onChange(({ reason, error }) => {
    updateConnectButton();
    if (error) {
      showToast('Could not connect to Google Health');
    } else if (reason === 'expired') {
      showToast('Google Health session expired — tap Connect Google Health');
    } else if (HealthSync.isConnected()) {
      showToast('Google Health connected');
      const plan = loadPlan();
      if (plan) syncRuns(plan);
    }
  });
  updateConnectButton();

  document.getElementById('connectBtn').addEventListener('click', () => {
    if (HealthSync.isConnected()) {
      HealthSync.disconnect();
      updateConnectButton();
      showToast('Disconnected from Google Health');
    } else {
      try {
        HealthSync.beginAuth();
      } catch (err) {
        console.error(err);
        showToast(err.message);
      }
    }
  });

  document.getElementById('planForm').addEventListener('submit', e => {
    e.preventDefault();
    const plan = PlanGenerator.generate({
      goalDistance: document.getElementById('goalDistance').value,
      raceDate: document.getElementById('raceDate').value,
      currentVolume: document.getElementById('currentVolume').value,
      runsPerWeek: document.getElementById('runsPerWeek').value
    });
    savePlan(plan);
    renderPlan(plan);
    syncRuns(plan);
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Discard this plan and start over?')) return;
    localStorage.removeItem(PLAN_KEY);
    document.getElementById('planView').classList.add('hidden');
    document.getElementById('onboarding').classList.remove('hidden');
  });

  const existingPlan = loadPlan();
  if (existingPlan) {
    renderPlan(existingPlan);
    syncRuns(existingPlan);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

init();
