/**
 * app.js
 * Wires the onboarding form, stored plan, and Google Health sync
 * together, and renders the plan view. Plan and synced runs live in
 * localStorage for now — swap the storage keys for a backend once this
 * needs to move across devices. Plan/run maths lives in planStats.js.
 */

const PLAN_KEY = 'splits_plan';
const RUNS_KEY = 'splits_runs';
const LAST_SYNC_KEY = 'splits_last_sync';

// Keep in step with CACHE_NAME in service-worker.js ('splits-' + APP_VERSION).
const APP_VERSION = 'v5';

const RUN_LOG_PREVIEW = 8;

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
const typeLabels = { long: 'Long', quality: 'Quality', easy: 'Easy' };

let syncing = false;
let runLogExpanded = false;
let editingKey = null; // "weekNumber:sessionIndex" of the session with its "mark done" form open

// ---------------------------------------------------------------- storage

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function loadPlan() { return readJSON(PLAN_KEY, null); }
function savePlan(plan) { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); }
function loadRuns() { return readJSON(RUNS_KEY, []); }
function saveRuns(runs) { localStorage.setItem(RUNS_KEY, JSON.stringify(runs)); }

// ------------------------------------------------------------ formatting

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtKm(km) {
  return String(Math.round(km * 10) / 10);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtDuration(min) {
  if (!min) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

function fmtPace(secPerKm) {
  if (!secPerKm) return null;
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} /km`;
}

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3200);
}

// -------------------------------------------------------------- sync bar

function renderSyncBar() {
  const connected = HealthSync.isConnected();
  const lastSync = Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;

  const bar = document.getElementById('syncBar');
  bar.classList.toggle('connected', connected);
  bar.classList.toggle('syncing', connected && syncing);

  document.getElementById('syncTitle').textContent =
    connected ? 'Google Health connected' : 'Google Health not connected';
  document.getElementById('syncSub').textContent =
    !connected ? 'Connect to pull in your runs'
      : syncing ? 'Syncing runs…'
        : lastSync ? `Last synced ${timeAgo(lastSync)}`
          : 'Not synced yet — tap Sync now';

  const syncBtn = document.getElementById('syncBtn');
  syncBtn.classList.toggle('hidden', !connected);
  syncBtn.disabled = syncing;
  syncBtn.textContent = syncing ? 'Syncing…' : 'Sync now';

  const connectBtn = document.getElementById('connectBtn');
  connectBtn.textContent = connected ? 'Disconnect' : 'Connect Google Health';
  connectBtn.classList.toggle('primary-btn', !connected);
  connectBtn.classList.toggle('ghost-btn', connected);
}

// ------------------------------------------------------------------ hero

function statTile(label, value, sub, { suffix, meterPct } = {}) {
  const tile = el('div', 'stat');
  const valueEl = el('div', 'stat-value numeral', value);
  if (suffix) valueEl.appendChild(el('small', '', suffix));
  tile.append(el('div', 'stat-label', label), valueEl);
  if (meterPct !== undefined) {
    const meter = el('div', 'meter');
    const fill = el('span');
    fill.style.width = `${Math.min(100, meterPct)}%`;
    meter.appendChild(fill);
    tile.appendChild(meter);
  }
  tile.appendChild(el('div', 'stat-sub', sub));
  return tile;
}

function renderHero(plan, runs) {
  const h = PlanStats.hero(plan, runs);
  const hero = document.getElementById('hero');
  hero.innerHTML = '';

  const raceLabel = h.daysToRace === 0 ? 'Race day' : h.daysToRace === 1 ? 'day to race' : 'days to race';
  const pct = h.weekTarget ? (h.weekActual / h.weekTarget) * 100 : 0;

  hero.append(
    statTile(raceLabel, h.daysToRace === 0 ? 'GO' : String(h.daysToRace), `Week ${h.weekNumber} · ${h.phase}`),
    statTile(`Week ${h.weekNumber} volume`, fmtKm(h.weekActual), 'run vs target',
      { suffix: `/${fmtKm(h.weekTarget)} km`, meterPct: pct }),
    statTile('Streak', String(h.streak), h.streak === 1 ? 'session in a row' : 'sessions in a row')
  );
}

// ----------------------------------------------------------------- chart

function renderVolumeChart(plan, runs) {
  const series = PlanStats.weeklySeries(plan, runs);
  const max = Math.max(1, ...series.map(w => Math.max(w.target, w.actual)));

  const chart = document.getElementById('volumeChart');
  chart.innerHTML = '';
  const done = series.filter(w => !w.future);
  chart.setAttribute('aria-label',
    `Weekly volume, ${series.length} weeks. ` +
    done.map(w => `Week ${w.weekNumber}: ${fmtKm(w.actual)} of ${fmtKm(w.target)} km`).join('; '));

  series.forEach(w => {
    const col = el('div', 'vc-col' + (w.current ? ' current' : '') + (w.future ? ' future' : ''));
    col.title = w.future
      ? `Week ${w.weekNumber}: ${fmtKm(w.target)} km planned`
      : `Week ${w.weekNumber}: ${fmtKm(w.actual)} / ${fmtKm(w.target)} km`;

    const bars = el('div', 'vc-bars');
    const target = el('span', 'vc-target');
    target.style.height = `${(w.target / max) * 100}%`;
    bars.appendChild(target);
    if (w.actual > 0) {
      const actual = el('span', 'vc-actual');
      actual.style.height = `${(w.actual / max) * 100}%`;
      bars.appendChild(actual);
    }

    const showLabel = w.weekNumber === 1 || w.weekNumber % 4 === 0 || w.weekNumber === series.length;
    col.append(bars, el('div', 'vc-x', showLabel ? String(w.weekNumber) : ''));
    chart.appendChild(col);
  });
}

// ------------------------------------------------------------- run log

function renderRunLog(plan, runs) {
  const entries = PlanStats.runLog(plan, runs);
  const list = document.getElementById('runLog');
  const moreBtn = document.getElementById('runLogMore');
  list.innerHTML = '';

  document.getElementById('runCount').textContent =
    entries.length ? `${entries.length} logged` : '';

  if (!entries.length) {
    list.appendChild(el('p', 'empty',
      HealthSync.isConnected()
        ? 'No runs found since your plan started. Finish a run, then tap Sync now — or mark a session done by hand below.'
        : 'No runs yet. Connect Google Health to pull them in, or mark a session done by hand below.'));
    moreBtn.classList.add('hidden');
    return;
  }

  const shown = runLogExpanded ? entries : entries.slice(0, RUN_LOG_PREVIEW);
  shown.forEach(entry => {
    const row = el('div', 'run');

    const main = el('div', 'run-main');
    main.appendChild(el('div', 'run-date',
      entry.source === 'manual' ? `Logged ${fmtDate(entry.date)}` : fmtDate(entry.date)));

    const tag = el('div', 'run-tag' + (entry.tag.type ? ` type-${entry.tag.type}` : ''));
    tag.appendChild(el('span', 'run-tag-text',
      entry.tag.kind === 'matched' ? `Wk ${entry.tag.weekNumber} · ${entry.tag.label}` : entry.tag.label));
    if (entry.source === 'manual') tag.appendChild(el('span', 'badge', 'Manual'));
    main.appendChild(tag);

    const km = el('div', 'run-km numeral');
    km.append(entry.distanceKm > 0 ? fmtKm(entry.distanceKm) : '—', el('small', '', ' km'));

    const meta = [
      fmtDuration(entry.durationMin),
      fmtPace(entry.paceSecPerKm),
      entry.avgHeartRate ? `${entry.avgHeartRate} bpm` : null
    ].filter(Boolean);
    const metaEl = el('div', 'run-meta', meta.length ? meta.join(' · ') : 'No time or heart rate');

    row.append(main, km, metaEl);
    list.appendChild(row);
  });

  const hidden = entries.length - RUN_LOG_PREVIEW;
  moreBtn.classList.toggle('hidden', hidden <= 0);
  moreBtn.textContent = runLogExpanded ? 'Show fewer' : `Show all (${entries.length})`;
}

// ---------------------------------------------------------------- plan

function renderSession(plan, week, session, index, curWeek) {
  const state = PlanStats.sessionState(plan, week, session);
  const key = `${week.weekNumber}:${index}`;

  const row = el('div', `session type-${session.type} state-${state}`);

  const nameWrap = el('div', 'session-name');
  nameWrap.appendChild(el('span', '', session.name));
  const detail = state === 'done'
    ? `${typeLabels[session.type]} · ran ${fmtKm(session.actualKm ?? session.distance)} km (planned ${fmtKm(session.distance)})${session.manual ? ' · manual' : ''}`
    : `${typeLabels[session.type]} · ${fmtKm(session.distance)} km`;
  nameWrap.appendChild(el('span', 'session-detail', detail));

  const side = el('div', 'session-side');
  side.appendChild(el('span', `session-status ${state}`,
    state === 'done' ? '✓ Done' : state === 'missed' ? '✕ Missed' : 'Planned'));

  // Manual fallback only for weeks that have started — not for the future.
  if (state !== 'done' && week.weekNumber <= curWeek && editingKey !== key) {
    const btn = el('button', 'ghost-btn small', 'Mark done');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Mark ${session.name} in week ${week.weekNumber} as done`);
    btn.addEventListener('click', () => {
      editingKey = key;
      renderPlan(loadPlan(), { focusKey: key });
    });
    side.appendChild(btn);
  } else if (session.manual) {
    const btn = el('button', 'ghost-btn small', 'Undo');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Undo manual completion of ${session.name} in week ${week.weekNumber}`);
    btn.addEventListener('click', () => {
      const current = loadPlan();
      if (PlanStats.undoManual(current, week.weekNumber, index)) {
        savePlan(current);
        renderPlan(current);
      }
    });
    side.appendChild(btn);
  }

  row.append(nameWrap, side);

  if (editingKey === key) {
    const form = el('form', 'log-form');
    const input = el('input');
    input.type = 'number';
    input.min = '0.1';
    input.step = '0.1';
    input.inputMode = 'decimal';
    input.required = true;
    input.value = session.distance;
    input.id = `log-${week.weekNumber}-${index}`;
    input.setAttribute('aria-label', 'Distance run in km');
    const unit = el('span', 'log-unit', 'km');
    const save = el('button', 'primary-btn compact', 'Save');
    save.type = 'submit';
    const cancel = el('button', 'ghost-btn small', 'Cancel');
    cancel.type = 'button';

    cancel.addEventListener('click', () => {
      editingKey = null;
      renderPlan(loadPlan());
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const current = loadPlan();
      if (PlanStats.markManualDone(current, week.weekNumber, index, input.value)) {
        editingKey = null;
        savePlan(current);
        renderPlan(current);
        showToast(`Marked done · ${fmtKm(Number(input.value))} km`);
      } else {
        showToast('Enter the distance you ran, in km');
      }
    });

    form.append(input, unit, save, cancel);
    row.appendChild(form);
  }

  return row;
}

function renderWeeks(plan, runs) {
  const curWeek = PlanStats.currentWeekNumber(plan);
  const list = document.getElementById('weekList');
  list.innerHTML = '';

  plan.weeks.forEach(week => {
    const row = el('div', 'week-row' + (week.weekNumber === curWeek ? ' current' : ''));

    const body = el('div');
    const volume = week.weekNumber <= curWeek
      ? `${fmtKm(PlanStats.weekActualKm(plan, runs, week.weekNumber))} / ${fmtKm(week.targetVolume)} km`
      : `${fmtKm(week.targetVolume)} km`;
    body.appendChild(el('div', 'week-phase',
      `${week.phase} · ${volume}${week.adjusted ? ' · adjusted' : ''}`));

    const sessions = el('div', 'session-list');
    week.sessions.forEach((s, i) => sessions.appendChild(renderSession(plan, week, s, i, curWeek)));
    body.appendChild(sessions);

    row.append(el('div', 'week-num', String(week.weekNumber).padStart(2, '0')), body);
    list.appendChild(row);
  });
}

function renderPlan(plan, { focusKey } = {}) {
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('planView').classList.remove('hidden');

  const runs = loadRuns();
  const curWeek = PlanStats.currentWeekNumber(plan);

  document.getElementById('planTitle').textContent =
    distanceLabels[plan.goalDistance] || `${plan.goalDistance}K`;
  document.getElementById('totalWeeks').textContent = plan.totalWeeks;
  document.getElementById('currentWeekNum').textContent = curWeek;

  renderHero(plan, runs);
  renderVolumeChart(plan, runs);
  renderRunLog(plan, runs);
  renderWeeks(plan, runs);

  if (focusKey) {
    const [w, i] = focusKey.split(':');
    const input = document.getElementById(`log-${w}-${i}`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

// ---------------------------------------------------------------- sync

async function syncRuns(plan, { manual = false } = {}) {
  if (!HealthSync.isConnected() || syncing) return;
  syncing = true;
  renderSyncBar();
  try {
    const runs = await HealthSync.fetchRecentRuns(PlanStats.startDate(plan));

    // The plan may have changed while the request was in flight (a manual
    // "mark done", or a reset) — reconcile against what is stored now.
    const current = loadPlan();
    if (!current || current.createdAt !== plan.createdAt) return;

    saveRuns(runs);
    const adjusted = PlanStats.reconcile(current, runs);
    savePlan(current);
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    renderPlan(current);

    if (adjusted) showToast('Plan adjusted after a missed long run');
    else if (manual) showToast(runs.length ? `Synced · ${runs.length} run${runs.length === 1 ? '' : 's'} found` : 'Synced · no runs found yet');
  } catch (err) {
    console.error(err);
    if (err.code === 'token_expired') return; // onChange already told the user
    showToast('Could not sync with Google Health');
  } finally {
    syncing = false;
    renderSyncBar();
  }
}

async function init() {
  showVersion();
  HealthSync.onChange(({ reason, error }) => {
    renderSyncBar();
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
  renderSyncBar();
  setInterval(renderSyncBar, 30000); // keeps "last synced 3 min ago" current

  document.getElementById('connectBtn').addEventListener('click', () => {
    if (HealthSync.isConnected()) {
      HealthSync.disconnect();
      renderSyncBar();
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

  document.getElementById('syncBtn').addEventListener('click', () => {
    const plan = loadPlan();
    if (!plan) {
      showToast('Generate a plan first');
      return;
    }
    syncRuns(plan, { manual: true });
  });

  document.getElementById('runLogMore').addEventListener('click', () => {
    runLogExpanded = !runLogExpanded;
    const plan = loadPlan();
    if (plan) renderRunLog(plan, loadRuns());
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
    saveRuns([]); // runs belong to the plan window they were fetched for
    editingKey = null;
    renderPlan(plan);
    syncRuns(plan);
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Discard this plan and start over?')) return;
    localStorage.removeItem(PLAN_KEY);
    localStorage.removeItem(RUNS_KEY);
    editingKey = null;
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
