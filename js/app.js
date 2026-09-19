/**
 * app.js
 * Wires the onboarding form, stored plan, and Google Health sync
 * together, and renders the tabbed app: Today, Plan, Progress, Profile,
 * plus a session-detail screen pushed over Today/Plan. Plan and synced
 * runs live in localStorage — swap the storage keys for a backend once
 * this needs to move across devices. Plan/run maths lives in planStats.js.
 *
 * Views are <section data-view> elements in index.html; showView() swaps
 * which one is visible. No router: the open session is an in-memory variable.
 */

const PLAN_KEY = 'splits_plan';
const RUNS_KEY = 'splits_runs';
const LAST_SYNC_KEY = 'splits_last_sync';
const PROFILE_KEY = 'splits_profile'; // { name } — display only

// Keep in step with CACHE_NAME in service-worker.js ('splits-' + APP_VERSION).
const APP_VERSION = 'v8';

const RUN_LOG_PREVIEW = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const TABS = ['today', 'plan', 'progress', 'profile'];

const distanceLabels = { 5: '5K', 10: '10K', 21.1: 'Half marathon', 42.2: 'Marathon', 50: '50K ultra', 100: '100K ultra' };
const FITNESS_FORM_DEFAULT = 'light'; // pre-selected on the plan form; slightly cautious on purpose
const typeLabels = { long: 'Long', quality: 'Quality', easy: 'Easy' };
const typeLetters = { long: 'L', quality: 'Q', easy: 'E' };
const PHASES = ['base', 'build', 'peak', 'taper'];

let syncing = false;
let runLogExpanded = false;
let activeView = null;
let lastTab = 'today';
let openSession = null;          // { weekNumber, index, from } while session detail is showing
const weekToggles = new Map();   // weekNumber -> expanded? (overrides the default: current week open)
const scrollByView = {};
let versionNote = '';            // e.g. "v7 available, reload"
let levelTouched = false;        // has the runner picked an experience level, or is it still the suggestion?
let warnedFor = null;            // form inputs (JSON) the short-timeline warning was shown for
let updateState = 'idle';        // 'idle' | 'checking' | 'updating' — the Profile "Check for updates" button

// Shows the version this page is running. If a newer service worker has
// already taken over the cache, flag that a reload is needed to pick it up.
async function checkVersion() {
  try {
    const active = (await caches.keys()).find(k => k.startsWith('splits-'));
    if (active && active !== `splits-${APP_VERSION}`) {
      versionNote = `${active.slice('splits-'.length)} available, reload`;
      const plan = loadPlan();
      if (plan) renderProfile(plan);
    }
  } catch (err) {
    // Cache API unavailable (e.g. insecure context) — the plain version is enough.
  }
}

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
function loadProfile() { return readJSON(PROFILE_KEY, {}); }
function saveProfile(profile) { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); }

// ------------------------------------------------------------ dom helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const btn = el('button', className, label);
  btn.type = 'button';
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

const ICONS = {
  flame: '<path d="M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c0-1.5-1-2-1-3 2 1 3 3 3 5a5 5 0 0 1-10 0c0-4 3-5 5-11z"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  map: '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6z"/><path d="M9 3v15M15 6v15"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4.5 5-6 8-6s6.5 1.5 8 6"/>'
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name]; // constant markup, never user data
  return svg;
}

function typeChip(type) {
  const chip = el('span', `chip type-${type}`, typeLetters[type]);
  chip.setAttribute('aria-hidden', 'true');
  return chip;
}

// ------------------------------------------------------------ formatting

function fmtKm(km) {
  return String(Math.round(km * 10) / 10);
}

function fmtKm1(km) {
  return (Math.round(km * 10) / 10).toFixed(1);
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

function fmtPaceBare(secPerKm) {
  if (!secPerKm) return null;
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function fmtPace(secPerKm) {
  const bare = fmtPaceBare(secPerKm);
  return bare && `${bare} /km`;
}

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function raceLabel(plan) {
  return distanceLabels[plan.goalDistance] || `${plan.goalDistance}K`;
}

function fitnessLabel(fitness) {
  return PlanGenerator.FITNESS[PlanGenerator.fitnessOf(fitness)].label;
}

function levelLabel(experience) {
  return PlanGenerator.LEVELS[PlanGenerator.levelOf(experience)].label;
}

function daysToRaceText(days) {
  return days === 0 ? 'Race day' : days === 1 ? '1 day to race' : `${days} days to race`;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

// ------------------------------------------------------------ derived data

// Effort zone is a display convention by session type (the plan data has no
// zones): easy and long runs are conversational, steady is Z3, tempo Z4.
function effortFor(session) {
  if (session.type === 'quality') {
    return /tempo|interval/i.test(session.name)
      ? { zone: 4, label: 'hard effort' }
      : { zone: 3, label: 'steady effort' };
  }
  return { zone: 2, label: 'easy effort' };
}

// Average pace (s/km) over synced runs with both distance and time.
function avgPace(runs) {
  let sec = 0;
  let km = 0;
  runs.forEach(r => {
    const s = r.durationSec || (r.durationMin || 0) * 60;
    if (r.distanceKm > 0 && s > 0) { sec += s; km += r.distanceKm; }
  });
  return km > 0 ? sec / km : null;
}

function findRun(runs, id) {
  return id ? runs.find(r => r.id === id) || null : null;
}

// Next not-done session in the current week, in plan order.
function nextSession(plan) {
  const weekNumber = PlanStats.currentWeekNumber(plan);
  const week = plan.weeks[weekNumber - 1];
  const index = week.sessions.findIndex(s => s.status !== 'done');
  return { week, index, session: index === -1 ? null : week.sessions[index] };
}

// The seven days of the current plan week (plan weeks start on the weekday
// the plan was created, not Monday), with what was actually run each day.
function weekDays(plan, runs, now = Date.now()) {
  const weekNumber = PlanStats.currentWeekNumber(plan, now);
  const start = PlanStats.weekStart(plan, weekNumber);
  const todayIdx = Math.floor((now - start) / DAY_MS);
  const days = Array.from({ length: 7 }, (_, i) => ({
    date: new Date(start + i * DAY_MS + 12 * 60 * 60 * 1000), // midday: safe across DST
    km: 0,
    type: null,
    topKm: -1,
    today: i === todayIdx,
    future: i > todayIdx
  }));

  PlanStats.runLog(plan, runs).forEach(entry => {
    if (!entry.date || !(entry.distanceKm > 0)) return;
    const i = Math.floor((new Date(entry.date).getTime() - start) / DAY_MS);
    if (i < 0 || i > 6) return;
    const day = days[i];
    day.km += entry.distanceKm;
    if (entry.distanceKm > day.topKm) {
      day.topKm = entry.distanceKm;
      day.type = entry.tag.type || 'extra';
    }
  });
  return days;
}

// --------------------------------------------------------------- views

function showView(name) {
  if (activeView) scrollByView[activeView] = window.scrollY;
  if (TABS.includes(name)) lastTab = name;
  activeView = name;
  document.body.dataset.view = name;

  document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
  document.getElementById('tabBar').hidden = !TABS.includes(name);
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.tab === name) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });

  // Tabs keep their scroll position; session detail always opens at the top.
  window.scrollTo(0, name === 'session' ? 0 : scrollByView[name] || 0);
}

function renderApp(plan) {
  const runs = loadRuns();
  renderToday(plan, runs);
  renderPlanTab(plan, runs);
  renderProgress(plan, runs);
  renderProfile(plan);
  if (openSession) renderSession(plan, runs);
}

// Re-render after a data change and stay on the current screen.
function refresh(plan = loadPlan()) {
  if (!plan) return;
  renderApp(plan);
}

function openSessionDetail(weekNumber, index) {
  openSession = { weekNumber, index, from: TABS.includes(activeView) ? activeView : lastTab };
  renderSession(loadPlan(), loadRuns());
  showView('session');
}

function closeSessionDetail() {
  const from = openSession ? openSession.from : lastTab;
  openSession = null;
  showView(from);
}

// ------------------------------------------------------------- today tab

function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
}

function renderToday(plan, runs) {
  const root = document.getElementById('view-today');
  root.innerHTML = '';
  const h = PlanStats.hero(plan, runs);
  const { name } = loadProfile();

  // Top row: date, greeting, streak pill
  const top = el('div', 'today-top');
  const hello = el('div');
  hello.append(
    el('div', 'today-date', new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short' })),
    el('h1', 'h1', name ? `${greeting()}, ${name}` : `Good ${greeting().toLowerCase()}`)
  );
  const pill = el('div', 'streak-pill');
  pill.setAttribute('aria-label', `Streak: ${h.streak} ${h.streak === 1 ? 'session' : 'sessions'} in a row`);
  pill.append(icon('flame'), el('span', '', String(h.streak)));
  top.append(hello, pill);

  root.append(top, renderHeroCard(plan, runs, h), renderTodayStats(h), renderWeekStrip(plan, runs), renderSyncCard(plan, runs));
}

function renderHeroCard(plan, runs, h) {
  const { week, index, session } = nextSession(plan);
  const card = el('section', 'hero');
  card.setAttribute('aria-label', "Today's session");
  card.appendChild(el('div', 'hero-eyebrow', `Today · Week ${week.weekNumber}`));

  if (!session) {
    card.classList.add('hero-done');
    const body = el('div');
    body.append(
      el('div', 'display', 'Week complete'),
      el('div', 'hero-line', `All ${week.sessions.length} sessions done · ${fmtKm(h.weekActual)} of ${fmtKm(h.weekTarget)} km`)
    );
    card.appendChild(body);
    return card;
  }

  const effort = effortFor(session);
  const pace = avgPace(runs);
  const line = [`${fmtKm(session.distance)} km`, effort.label];
  if (pace) line.push(`~${Math.round((pace * session.distance) / 60)} min`);

  const body = el('div');
  const open = button(session.name, 'hero-open', () => openSessionDetail(week.weekNumber, index));
  open.setAttribute('aria-label', `${session.name}, ${fmtKm(session.distance)} km — open details`);
  body.append(open, el('div', 'hero-line', line.join(' · ')));

  const actions = el('div', 'btn-row');
  actions.append(
    button('Start run', 'btn btn-primary grow', () =>
      showToast('Record the run on your watch — Splits picks it up when you sync')),
    button('Mark done', 'btn btn-ghost', () => openMarkDone(week.weekNumber, index))
  );

  card.append(body, actions);
  return card;
}

function renderTodayStats(h) {
  const row = el('div', 'stat-row');

  const tile = (label, valueNode) => {
    const t = el('div', 'stat-tile');
    t.append(el('div', 'eyebrow', label), valueNode);
    return t;
  };

  const days = el('div', 'display accent', h.daysToRace === 0 ? 'GO' : String(h.daysToRace));
  const vol = el('div', 'display', fmtKm(h.weekActual));
  vol.appendChild(el('small', '', ` /${fmtKm(h.weekTarget)}km`));
  const streak = el('div', 'display teal', String(h.streak));

  row.append(
    tile(h.daysToRace === 0 ? 'Race day' : 'Days to race', days),
    tile('Week volume', vol),
    tile('Streak', streak)
  );
  return row;
}

function renderWeekStrip(plan, runs) {
  const wrap = el('section', 'week-strip-wrap');
  wrap.appendChild(el('h2', 'section-label', 'This week'));
  const strip = el('div', 'week-strip');

  weekDays(plan, runs).forEach(day => {
    const pill = el('div', 'day-pill' + (day.today ? ' today' : '') + (day.future ? ' future' : ''));
    const dayName = day.date.toLocaleDateString('en-AU', { weekday: 'short' });
    pill.appendChild(el('span', '', dayName));
    pill.appendChild(el('span', 'dot' + (day.type ? ` type-${day.type}` : '')));
    pill.setAttribute('aria-label',
      `${day.date.toLocaleDateString('en-AU', { weekday: 'long' })}${day.today ? ' (today)' : ''}: ` +
      (day.km > 0 ? `${fmtKm(day.km)} km run` : day.future ? 'to come' : 'no run'));
    pill.setAttribute('role', 'img');
    strip.appendChild(pill);
  });

  wrap.appendChild(strip);
  return wrap;
}

function renderSyncCard(plan, runs) {
  const connected = HealthSync.isConnected();
  const lastSync = Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  const card = el('section', 'sync-card');
  card.setAttribute('aria-live', 'polite');

  let text;
  if (!connected) text = 'Connect Google Health to pull in your runs — or mark sessions done by hand.';
  else if (syncing) text = 'Syncing runs…';
  else if (!runs.length) text = 'No runs found since your plan started. Finish a run, then tap Sync now — or mark a session done by hand.';
  else text = `${runs.length} run${runs.length === 1 ? '' : 's'} synced · last synced ${lastSync ? timeAgo(lastSync) : 'never'}`;

  card.appendChild(el('p', '', text));
  if (connected) {
    const btn = button(syncing ? 'Syncing…' : 'Sync now', 'btn btn-ghost', () => syncRuns(loadPlan(), { manual: true }));
    btn.disabled = syncing;
    card.appendChild(btn);
  } else {
    card.appendChild(button('Connect', 'btn btn-primary', connectHealth));
  }
  return card;
}

// -------------------------------------------------------------- plan tab

function isWeekExpanded(weekNumber, curWeek) {
  return weekToggles.has(weekNumber) ? weekToggles.get(weekNumber) : weekNumber === curWeek;
}

function renderPlanTab(plan, runs) {
  const root = document.getElementById('view-plan');
  root.innerHTML = '';
  const curWeek = PlanStats.currentWeekNumber(plan);
  const curPhase = plan.weeks[curWeek - 1].phase;

  const head = el('div');
  head.append(
    el('h1', 'h1', `${raceLabel(plan)} plan`),
    el('p', 'sub', `${daysToRaceText(PlanStats.daysToRace(plan))} · week ${curWeek} of ${plan.totalWeeks}`)
  );
  root.appendChild(head);

  // Phase progress: one segment per phase, sized by its number of weeks.
  const phaseBar = el('div', 'phase-bar');
  const track = el('div', 'phase-track');
  const labels = el('div', 'phase-labels');
  const curIdx = PHASES.indexOf(curPhase);
  PHASES.forEach((phase, i) => {
    const count = plan.weeks.filter(w => w.phase === phase).length;
    if (!count) return;
    const state = i === curIdx ? ' current' : i < curIdx ? ' past' : '';
    const seg = el('div', 'phase-seg' + state);
    seg.style.flex = `${count} 1 0`;
    const label = el('span', state.trim(), phase);
    label.style.flex = `${count} 1 0`;
    track.appendChild(seg);
    labels.appendChild(label);
  });
  track.setAttribute('role', 'img');
  track.setAttribute('aria-label', `Currently in the ${curPhase} phase`);
  phaseBar.append(track, labels);
  root.appendChild(phaseBar);

  const list = el('div', 'week-list');
  plan.weeks.forEach(week => list.appendChild(renderWeekCard(plan, runs, week, curWeek)));
  root.appendChild(list);
}

function renderWeekCard(plan, runs, week, curWeek) {
  const expanded = isWeekExpanded(week.weekNumber, curWeek);
  const when = week.weekNumber === curWeek ? 'current' : week.weekNumber < curWeek ? 'past' : 'future';
  const card = el('section', `week-card ${when}`);

  const done = week.sessions.filter(s => s.status === 'done').length;
  const started = week.weekNumber <= curWeek;
  const actual = started ? PlanStats.weekActualKm(plan, runs, week.weekNumber) : 0;

  let summary;
  if (expanded && started) summary = `${week.phase} · ${fmtKm(actual)}/${fmtKm(week.targetVolume)} km`;
  else if (expanded) summary = `${week.phase} · ${fmtKm(week.targetVolume)} km`;
  else if (when === 'past') summary = `${week.phase} · ${done}/${week.sessions.length} done · ${fmtKm(actual)}/${fmtKm(week.targetVolume)} km`;
  else summary = `${week.phase} · ${week.sessions.length} sessions · ${fmtKm(week.targetVolume)} km`;
  if (week.adjusted) summary += ' · adjusted';

  const head = button('', 'week-head', () => {
    weekToggles.set(week.weekNumber, !expanded);
    renderPlanTab(loadPlan(), loadRuns());
    const again = document.querySelector(`[data-week="${week.weekNumber}"]`);
    if (again) again.focus();
  });
  head.dataset.week = week.weekNumber;
  head.setAttribute('aria-expanded', String(expanded));
  const main = el('span', 'week-head-main');
  const num = el('span', 'week-num', String(week.weekNumber).padStart(2, '0'));
  num.setAttribute('aria-label', `Week ${week.weekNumber}`);
  main.append(num, el('span', 'week-summary', summary));
  head.append(main, icon(expanded ? 'down' : 'right'));
  card.appendChild(head);

  if (expanded) {
    const sessions = el('div', 'session-list');
    week.sessions.forEach((s, i) => sessions.appendChild(renderSessionRow(plan, week, s, i, curWeek)));
    card.appendChild(sessions);
  }
  return card;
}

function renderSessionRow(plan, week, session, index, curWeek) {
  const state = PlanStats.sessionState(plan, week, session);
  const row = el('div', `session-row state-${state}`);

  const open = button('', 'session-open', () => openSessionDetail(week.weekNumber, index));
  const text = el('span');
  text.appendChild(el('span', 'session-name', session.name));
  let detail = `${fmtKm(session.distance)} km`;
  if (state === 'done') detail = `ran ${fmtKm(session.actualKm ?? session.distance)} of ${fmtKm(session.distance)} km${session.manual ? ' · manual' : ''}`;
  if (state === 'missed') detail += ' · missed';
  text.appendChild(el('span', 'session-detail' + (state === 'missed' ? ' missed' : ''), detail));
  open.append(typeChip(session.type), text);
  open.setAttribute('aria-label', `${session.name}, ${typeLabels[session.type]}, ${detail}. Open details`);
  row.appendChild(open);

  const side = el('div', 'session-side');
  if (state === 'done') {
    const label = el('span', 'done-label');
    label.append(icon('check'), el('span', '', 'Done'));
    side.appendChild(label);
    if (session.manual) {
      const undo = button('Undo', 'btn btn-ghost btn-sm', () => undoManual(week.weekNumber, index));
      undo.setAttribute('aria-label', `Undo manual completion of ${session.name} in week ${week.weekNumber}`);
      side.appendChild(undo);
    }
  } else if (week.weekNumber <= curWeek) {
    // Manual fallback only for weeks that have started — not for the future.
    const mark = button('Mark done', 'btn btn-ghost btn-sm', () => openMarkDone(week.weekNumber, index));
    mark.setAttribute('aria-label', `Mark ${session.name} in week ${week.weekNumber} as done`);
    side.appendChild(mark);
  }
  row.appendChild(side);
  return row;
}

// ---------------------------------------------------------- progress tab

function renderProgress(plan, runs) {
  const root = document.getElementById('view-progress');
  root.innerHTML = '';
  const h = PlanStats.hero(plan, runs);

  const head = el('div');
  head.append(
    el('h1', 'h1', 'Progress'),
    el('p', 'sub', `${raceLabel(plan)} · ${h.phase} phase · week ${h.weekNumber} of ${plan.totalWeeks}`)
  );
  root.append(head, renderHeatmap(plan, runs), renderStatGrid(plan, runs, h), renderVolumeChart(plan, runs), renderRunLog(plan, runs));
}

function renderHeatmap(plan, runs) {
  const days = weekDays(plan, runs);
  const wrap = el('section');
  const fmt = d => d.toLocaleDateString('en-AU', { weekday: 'short' });
  const head = el('div', 'heat-head');
  head.append(el('h2', 'eyebrow', 'This week'), el('span', 'eyebrow', `${fmt(days[0].date)} — ${fmt(days[6].date)}`));

  const strip = el('div', 'heat');
  days.forEach(day => {
    const ran = day.km > 0;
    const cell = el('div', 'heat-cell' + (day.today ? ' today' : day.future ? ' future' : ran ? '' : ' rest'));
    cell.append(
      el('span', 'd', day.date.toLocaleDateString('en-AU', { weekday: 'narrow' })),
      el('span', 'mono', ran ? fmtKm1(day.km) : '–')
    );
    cell.setAttribute('role', 'img');
    cell.setAttribute('aria-label',
      `${day.date.toLocaleDateString('en-AU', { weekday: 'long' })}: ${ran ? `${fmtKm(day.km)} km` : day.future ? 'to come' : 'no run'}`);
    strip.appendChild(cell);
  });

  wrap.append(head, strip);
  return wrap;
}

function gridTile(label, value, { small, valueClass, note, noteClass, meterPct } = {}) {
  const tile = el('div', 'grid-tile');
  const v = el('div', 'mono' + (valueClass ? ` ${valueClass}` : ''), value);
  if (small) v.appendChild(el('small', '', small));
  tile.append(el('div', 'eyebrow', label), v);
  if (meterPct !== undefined) {
    const meter = el('div', 'meter');
    const fill = el('span');
    fill.style.width = `${Math.max(0, Math.min(100, meterPct))}%`;
    meter.appendChild(fill);
    tile.appendChild(meter);
  }
  if (note) tile.appendChild(el('div', 'note' + (noteClass ? ` ${noteClass}` : ''), note));
  return tile;
}

function renderStatGrid(plan, runs, h) {
  const grid = el('section', 'stat-grid');
  grid.setAttribute('aria-label', 'Key numbers');

  // Pace trend: last four weeks of synced runs against the four before.
  const now = Date.now();
  const inRange = (from, to) => runs.filter(r => {
    const t = new Date(r.date).getTime();
    return t >= now - from * DAY_MS && t < now - to * DAY_MS;
  });
  const pace = avgPace(runs);
  const recent = avgPace(inRange(28, 0));
  const prior = avgPace(inRange(56, 28));
  let paceNote = pace ? `from ${runs.filter(r => r.distanceKm > 0).length} synced runs` : 'no timed runs yet';
  let paceClass;
  if (recent && prior) {
    const delta = Math.round(recent - prior);
    paceNote = delta === 0 ? 'level with prior 4 wks' : `${delta < 0 ? '↓' : '↑'} ${Math.abs(delta)}s vs prior 4 wks`;
    if (delta < 0) paceClass = 'good';
  }

  // Sessions done so far, out of those in weeks that have started.
  const curWeek = h.weekNumber;
  let done = 0;
  let due = 0;
  plan.weeks.slice(0, curWeek).forEach(w => w.sessions.forEach(s => {
    due++;
    if (s.status === 'done') done++;
  }));

  grid.append(
    gridTile('WEEK VOLUME', fmtKm1(h.weekActual), {
      small: ` / ${fmtKm(h.weekTarget)}km`,
      meterPct: h.weekTarget ? (h.weekActual / h.weekTarget) * 100 : 0
    }),
    gridTile('AVG PACE', pace ? fmtPaceBare(pace) : '–', { small: pace ? '/km' : '', note: paceNote, noteClass: paceClass }),
    gridTile('STREAK', String(h.streak), { valueClass: 'teal', note: h.streak === 1 ? 'session in a row' : 'sessions in a row' }),
    gridTile('SESSIONS', String(done), { small: ` / ${due}`, valueClass: 'accent', note: 'done so far' })
  );
  return grid;
}

function renderVolumeChart(plan, runs) {
  const series = PlanStats.weeklySeries(plan, runs);
  const max = Math.max(1, ...series.map(w => Math.max(w.target, w.actual)));
  const n = series.length;

  const card = el('section', 'card');
  const head = el('div', 'card-head');
  const legend = el('div', 'legend');
  [['l-target', 'target'], ['l-run', 'run'], ['l-beat', 'beat target']].forEach(([cls, label]) => {
    const item = el('span');
    item.append(el('i', cls), label);
    legend.appendChild(item);
  });
  head.append(el('h2', 'card-title', 'Volume by week'), legend);

  const chart = el('div', 'chart');
  const bars = el('div', 'chart-bars');
  bars.setAttribute('role', 'img');
  const done = series.filter(w => !w.future);
  bars.setAttribute('aria-label',
    `Weekly volume, ${n} weeks. ` +
    done.map(w => `Week ${w.weekNumber}: ${fmtKm(w.actual)} of ${fmtKm(w.target)} km`).join('; '));

  // Phase band behind the base-phase weeks (columns are equal width, 3px gaps).
  const baseWeeks = series.filter(w => w.phase === 'base').length;
  if (baseWeeks) {
    const band = el('div', 'chart-band');
    band.style.width = `calc((100% + 3px) * ${baseWeeks / n} - 3px)`;
    band.appendChild(el('span', '', 'BASE'));
    bars.appendChild(band);
  }

  series.forEach(w => {
    const beat = !w.future && !w.current && w.actual >= w.target && w.actual > 0;
    const col = el('div', 'vc-col' + (w.current ? ' current' : '') + (w.future ? ' future' : '') + (beat ? ' beat' : ''));
    col.title = w.future
      ? `Week ${w.weekNumber}: ${fmtKm(w.target)} km planned`
      : `Week ${w.weekNumber}: ${fmtKm(w.actual)} / ${fmtKm(w.target)} km`;
    const target = el('span', 'vc-target');
    target.style.height = `${(w.target / max) * 100}%`;
    col.appendChild(target);
    if (w.actual > 0) {
      const actual = el('span', 'vc-actual');
      actual.style.height = `${(w.actual / max) * 100}%`;
      col.appendChild(actual);
    }
    bars.appendChild(col);
  });

  // Mono axis: week 1, every 8th, and the last, placed under their columns.
  const axis = el('div', 'chart-axis');
  axis.setAttribute('aria-hidden', 'true');
  series.forEach(w => {
    const k = w.weekNumber;
    if (!(k === 1 || k === n || (k % 8 === 0 && n - k >= 3))) return;
    const label = el('span', '', String(k));
    label.style.left = `calc((100% + 3px) * ${(k - 0.5) / n} - 1.5px)`;
    axis.appendChild(label);
  });

  chart.append(bars, axis);
  card.append(head, chart);
  return card;
}

function renderRunLog(plan, runs) {
  const entries = PlanStats.runLog(plan, runs);
  const card = el('section', 'card');
  const head = el('div', 'card-head');
  head.append(el('h2', 'card-title', 'Recent runs'), el('span', 'legend', entries.length ? `${entries.length} logged` : ''));
  card.appendChild(head);

  if (!entries.length) {
    card.appendChild(el('p', 'empty',
      HealthSync.isConnected()
        ? 'No runs found since your plan started. Finish a run, then tap Sync now — or mark a session done by hand.'
        : 'No runs yet. Connect Google Health in Profile to pull them in, or mark a session done by hand.'));
    return card;
  }

  const list = el('div', 'run-log');
  const shown = runLogExpanded ? entries : entries.slice(0, RUN_LOG_PREVIEW);
  shown.forEach(entry => {
    const row = el('div', 'run');
    row.appendChild(el('div', 'run-date',
      entry.source === 'manual' ? `Logged ${fmtDate(entry.date)}` : fmtDate(entry.date)));

    const km = el('div', 'run-km mono', entry.distanceKm > 0 ? fmtKm(entry.distanceKm) : '—');
    km.appendChild(el('small', '', ' km'));
    row.appendChild(km);

    const tag = el('div', 'run-tag');
    if (entry.tag.type) tag.appendChild(el('span', `dot type-${entry.tag.type}`));
    tag.appendChild(el('span', '',
      entry.tag.kind === 'matched' ? `Wk ${entry.tag.weekNumber} · ${entry.tag.label}` : entry.tag.label));
    if (entry.source === 'manual') tag.appendChild(el('span', 'badge', 'Manual'));
    row.appendChild(tag);

    const meta = [
      fmtDuration(entry.durationMin),
      fmtPace(entry.paceSecPerKm),
      entry.avgHeartRate ? `${entry.avgHeartRate} bpm` : null
    ].filter(Boolean);
    row.appendChild(el('div', 'run-meta', meta.length ? meta.join(' · ') : 'No time or heart rate'));
    list.appendChild(row);
  });
  card.appendChild(list);

  if (entries.length > RUN_LOG_PREVIEW) {
    card.appendChild(button(runLogExpanded ? 'Show fewer' : `Show all (${entries.length})`, 'btn btn-ghost btn-sm more-btn', () => {
      runLogExpanded = !runLogExpanded;
      renderProgress(loadPlan(), loadRuns());
    }));
  }
  return card;
}

// -------------------------------------------------------- session detail

function renderSession(plan, runs) {
  const root = document.getElementById('view-session');
  root.innerHTML = '';
  const week = plan && openSession && plan.weeks[openSession.weekNumber - 1];
  const session = week && week.sessions[openSession.index];
  if (!session) {
    openSession = null;
    return;
  }
  const curWeek = PlanStats.currentWeekNumber(plan);
  const state = PlanStats.sessionState(plan, week, session);
  const run = findRun(runs, session.runId);
  const effort = effortFor(session);

  // Header: back chevron, name, week · phase
  const back = button('', 'back-btn', closeSessionDetail);
  back.setAttribute('aria-label', `Back to ${openSession.from}`);
  const title = el('span');
  title.append(el('span', 'display', session.name), el('span', 'sub', `Week ${week.weekNumber} · ${week.phase} phase`));
  back.append(icon('left'), title);
  root.appendChild(back);

  // Stat chips
  const chips = el('div', 'chip-row');
  const chip = (value, label, cls) => {
    const c = el('div', 'stat-chip');
    c.append(el('div', 'mono' + (cls ? ` ${cls}` : ''), value), el('div', 'lbl', label));
    return c;
  };
  const done = state === 'done';
  const runPace = run && PlanStats.paceSecPerKm(run);
  const pace = runPace || avgPace(runs);
  chips.append(
    done ? chip(fmtKm1(session.actualKm ?? session.distance), 'km run') : chip(fmtKm1(session.distance), 'km target'),
    chip(pace ? fmtPaceBare(pace) : '–', runPace ? 'pace / km' : pace ? 'your avg / km' : 'pace / km'),
    chip(`Z${effort.zone}`, 'effort zone', 'teal')
  );
  root.appendChild(chips);

  if (run) {
    const bits = [
      fmtDuration(run.durationMin),
      run.avgHeartRate ? `avg ${run.avgHeartRate} bpm` : null,
      `synced ${fmtDate(run.date)}`
    ].filter(Boolean);
    root.appendChild(el('p', 'run-summary', bits.join(' · ')));
  }

  // Effort zone bar
  const zoneWrap = el('section');
  zoneWrap.appendChild(el('h2', 'eyebrow', 'Effort zone'));
  const zones = el('div', 'zones');
  zones.setAttribute('role', 'img');
  zones.setAttribute('aria-label', `Zone ${effort.zone} of 5, ${effort.label}`);
  const caps = el('div', 'zone-caps');
  caps.setAttribute('aria-hidden', 'true');
  for (let z = 1; z <= 5; z++) {
    zones.appendChild(el('span', z === effort.zone ? 'on' : ''));
    caps.appendChild(el('span', z === effort.zone ? 'on' : '', `Z${z}`));
  }
  zoneWrap.append(zones, caps, el('div', 'zone-note', `${effort.label[0].toUpperCase()}${effort.label.slice(1)} — ${
    effort.zone === 2 ? 'you should be able to talk in full sentences.'
      : effort.zone === 3 ? 'comfortably hard, a few words at a time.'
        : 'hard but controlled; short phrases only.'}`));
  root.appendChild(zoneWrap);

  // Route placeholder — Splits has no GPS; this stays a placeholder.
  const route = el('div', 'route-placeholder');
  route.append(icon('map'), el('span', '', 'Route appears once the run is synced'));
  root.appendChild(route);

  // Splits table — Google Health's exercise summary has no per-km data yet.
  const splits = el('section');
  const sh = el('div', 'splits-head');
  sh.append(el('h2', 'eyebrow', 'Splits'),
    el('span', 'eyebrow', done ? (session.manual ? 'logged by hand' : 'no per-km data') : 'not yet run'));
  const table = el('table', 'splits-table');
  const thead = el('thead');
  const hr = el('tr');
  ['KM', 'PACE', 'HR', 'ELEV'].forEach(t => {
    const th = el('th', '', t);
    th.scope = 'col';
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  const tbody = el('tbody');
  const kms = Math.max(1, Math.ceil(done ? session.actualKm ?? session.distance : session.distance));
  for (let k = 1; k <= kms; k++) {
    const tr = el('tr');
    tr.appendChild(el('td', '', String(k)));
    for (let c = 0; c < 3; c++) tr.appendChild(el('td', '', '–'));
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  splits.append(sh, table);
  root.appendChild(splits);

  // Footer actions
  const footer = el('div', 'session-footer');
  const actions = el('div', 'btn-row');
  if (done && session.manual) {
    footer.appendChild(el('p', 'note', `Marked done by hand · ${fmtKm(session.actualKm)} km`));
    actions.appendChild(button('Undo', 'btn btn-ghost grow', () => undoManual(week.weekNumber, openSession.index)));
  } else if (done) {
    footer.appendChild(el('p', 'note', 'Done · matched from Google Health'));
    actions.appendChild(button('Back', 'btn btn-ghost grow', closeSessionDetail));
  } else if (week.weekNumber > curWeek) {
    const later = button(`Opens in week ${week.weekNumber}`, 'btn btn-primary grow');
    later.disabled = true;
    actions.appendChild(later);
  } else {
    actions.append(
      button('Mark done', 'btn btn-primary grow', () => openMarkDone(week.weekNumber, openSession.index)),
      // Nothing is stored for a skip: the session stays planned, and counts
      // as missed once its week ends (unless a run syncs in to fill it).
      button('Skip', 'btn btn-ghost', () => {
        closeSessionDetail();
        showToast(state === 'missed' ? 'Left as missed' : 'Skipped — it counts as missed if the week ends without it');
      })
    );
  }
  footer.appendChild(actions);
  root.appendChild(footer);
}

// ----------------------------------------------------------- profile tab

function renderProfile(plan) {
  const root = document.getElementById('view-profile');
  root.innerHTML = '';
  const { name } = loadProfile();
  const days = PlanStats.daysToRace(plan);

  root.appendChild(el('h1', 'h1', 'Profile'));

  // Identity — tap to set the name used in the Today greeting.
  const identity = button('', 'identity', editName);
  const avatar = el('span', 'avatar');
  avatar.appendChild(icon('user'));
  const who = el('span', 'grow');
  who.append(el('span', 'display', name || 'Add your name'), el('span', 'sub', `Training for a ${raceLabel(plan).toLowerCase()}`));
  identity.append(avatar, who, icon('right'));
  identity.setAttribute('aria-label', name ? `${name}. Edit name` : 'Add your name');
  root.appendChild(identity);

  root.appendChild(renderHealthCard());

  // Settings
  const settings = el('section', 'card settings');
  settings.setAttribute('aria-label', 'Settings');
  const row = (label, sub, side) => {
    const r = el('div', 'setting-row');
    const left = el('div');
    left.appendChild(el('div', '', label));
    if (sub) left.appendChild(el('div', 'sub', sub));
    r.append(left, side);
    return r;
  };
  const [y, m, d] = plan.raceDate.split('-').map(Number);
  const raceDate = new Date(y, m - 1, d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const edit = button('Edit', 'btn-text', () => showOnboarding({ editing: true }));
  edit.setAttribute('aria-label', 'Edit race goal');
  settings.append(
    row('Race goal', `${raceLabel(plan)} · ${raceDate} · ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}`, edit),
    row('Experience', 'Change it with Edit above', el('span', 'value', levelLabel(plan.experience))),
    // Display-only until real preference screens exist.
    row('Fitness', null, el('span', 'value', fitnessLabel(plan.fitness))),
    row('Units', null, el('span', 'value', 'Kilometres')),
    row('Rest day', null, el('span', 'value', 'Not set')),
    row('Notifications', null, el('span', 'value', 'Off')),
    row('App version', `Splits ${APP_VERSION}${versionNote ? ` · ${versionNote}` : ''}`, updateButton())
  );
  root.appendChild(settings);

  const footer = el('div', 'profile-footer');
  footer.append(button('Start over', 'btn btn-ghost', startOver));
  root.appendChild(footer);
}

function renderHealthCard() {
  const connected = HealthSync.isConnected();
  const lastSync = Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  const card = el('section', 'card health-card');
  card.setAttribute('aria-label', 'Google Health');
  card.setAttribute('aria-live', 'polite');

  const status = el('div', 'health-status');
  status.appendChild(el('span', 'status-dot' + (connected ? ' on' : '') + (connected && syncing ? ' busy' : '')));
  const text = el('div');
  text.append(
    el('div', 'health-title', connected ? 'Google Health connected' : 'Google Health not connected'),
    el('div', 'sub',
      !connected ? 'Connect to pull in your runs'
        : syncing ? 'Syncing runs…'
          : lastSync ? `Last synced ${timeAgo(lastSync)}`
            : 'Not synced yet — tap Sync now')
  );
  status.appendChild(text);
  card.appendChild(status);

  const actions = el('div', 'btn-row');
  if (connected) {
    const sync = button(syncing ? 'Syncing…' : 'Sync now', 'btn btn-primary grow', () => syncRuns(loadPlan(), { manual: true }));
    sync.disabled = syncing;
    actions.append(sync, button('Disconnect', 'btn btn-ghost grow', () => {
      HealthSync.disconnect();
      refresh();
      showToast('Disconnected from Google Health');
    }));
  } else {
    actions.appendChild(button('Connect Google Health', 'btn btn-primary grow', connectHealth));
  }
  card.appendChild(actions);
  return card;
}

// ------------------------------------------------------------ app updates

function updateButton() {
  const label = updateState === 'checking' ? 'Checking…'
    : updateState === 'updating' ? 'Updating…'
      : 'Check for updates';
  const btn = button(label, 'btn-text', checkForUpdate);
  btn.disabled = updateState !== 'idle';
  return btn;
}

function setUpdateState(state) {
  updateState = state;
  const plan = loadPlan();
  if (plan) renderProfile(plan);
}

// The version the server has now, read from CACHE_NAME in service-worker.js.
async function latestVersion() {
  const res = await fetch(`service-worker.js?check=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`service-worker.js: ${res.status}`);
  const match = (await res.text()).match(/CACHE_NAME\s*=\s*'splits-([^']+)'/);
  return match ? match[1] : null;
}

async function checkForUpdate() {
  setUpdateState('checking');
  let latest;
  try {
    latest = await latestVersion();
  } catch (err) {
    console.error(err);
    setUpdateState('idle');
    showToast("Couldn't check for updates — are you online?");
    return;
  }
  if (!latest || latest === APP_VERSION) {
    setUpdateState('idle');
    showToast(`Splits is up to date (${APP_VERSION})`);
    return;
  }
  setUpdateState('updating');
  showToast(`Updating to ${latest}…`);
  await applyUpdate();
}

// Drops the offline copy and reloads from the network. Plan, runs and the
// Google Health token live in localStorage and are not touched.
async function applyUpdate() {
  try {
    if ('serviceWorker' in navigator) {
      for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    }
    if (window.caches) {
      for (const key of await caches.keys()) if (key.startsWith('splits-')) await caches.delete(key);
    }
    // Refresh the browser's HTTP cache too, so the reload can't pick up stale files.
    const sameOrigin = url => new URL(url, location.href).origin === location.origin;
    const files = [
      location.href.split('#')[0],
      ...[...document.scripts].map(s => s.src),
      ...[...document.querySelectorAll('link[rel="stylesheet"], link[rel="manifest"]')].map(l => l.href)
    ].filter(url => url && sameOrigin(url));
    await Promise.all(files.map(url => fetch(url, { cache: 'reload' }).catch(() => {})));
  } finally {
    location.reload();
  }
}

// ------------------------------------------------------------ bottom sheet

let sheetSubmit = null;

function openSheet({ title, sub, label, value, unit, inputType, inputAttrs = {}, onSubmit }) {
  const dialog = document.getElementById('sheet');
  document.getElementById('sheetTitle').textContent = title;
  document.getElementById('sheetSub').textContent = sub || '';
  document.getElementById('sheetSub').hidden = !sub;
  document.getElementById('sheetLabel').textContent = label;
  document.getElementById('sheetUnit').textContent = unit || '';

  // Replace the input so attributes from a previous use don't leak through.
  const old = document.getElementById('sheetInput');
  const input = el('input');
  input.id = 'sheetInput';
  input.type = inputType;
  Object.entries(inputAttrs).forEach(([k, v]) => input.setAttribute(k, v));
  input.value = value ?? '';
  if (unit) input.style.paddingRight = '48px';
  old.replaceWith(input);

  sheetSubmit = onSubmit;
  dialog.showModal();
  input.focus();
  if (input.select) input.select();
}

function closeSheet() {
  sheetSubmit = null;
  document.getElementById('sheet').close();
}

// Manual fallback for a run the watch didn't track (treadmill etc).
function openMarkDone(weekNumber, index) {
  const plan = loadPlan();
  const session = plan && plan.weeks[weekNumber - 1] && plan.weeks[weekNumber - 1].sessions[index];
  if (!session) return;
  openSheet({
    title: `Mark ${session.name.toLowerCase()} done`,
    sub: `Week ${weekNumber} · planned ${fmtKm(session.distance)} km`,
    label: 'Distance run',
    value: session.distance,
    unit: 'km',
    inputType: 'number',
    inputAttrs: { min: '0.1', step: '0.1', inputmode: 'decimal', required: '' },
    onSubmit: value => {
      const current = loadPlan();
      if (!PlanStats.markManualDone(current, weekNumber, index, value)) {
        showToast('Enter the distance you ran, in km');
        return false;
      }
      savePlan(current);
      refresh(current);
      showToast(`Marked done · ${fmtKm(Number(value))} km`);
      return true;
    }
  });
}

function undoManual(weekNumber, index) {
  const current = loadPlan();
  if (PlanStats.undoManual(current, weekNumber, index)) {
    savePlan(current);
    refresh(current);
    showToast('Completion undone');
  }
}

function editName() {
  openSheet({
    title: 'Your name',
    sub: 'Used for the greeting on Today. Stays on this device.',
    label: 'Name',
    value: loadProfile().name || '',
    inputType: 'text',
    inputAttrs: { maxlength: '40', autocomplete: 'given-name' },
    onSubmit: value => {
      saveProfile({ ...loadProfile(), name: value.trim() });
      refresh();
      return true;
    }
  });
}

// ------------------------------------------------------------ onboarding

const LEVEL_HINTS = {
  suggested: 'Suggested from your weekly volume — change it if it doesn\'t fit.',
  chosen: 'Beginner plans build slower with shorter long runs; experienced plans build higher.',
  saved: 'The level this plan was built for. Changing it rebuilds the plan.'
};

function formInputs() {
  const checked = document.querySelector('input[name="experience"]:checked');
  return {
    goalDistance: document.getElementById('goalDistance').value,
    raceDate: document.getElementById('raceDate').value,
    currentVolume: document.getElementById('currentVolume').value,
    runsPerWeek: document.getElementById('runsPerWeek').value,
    experience: checked ? checked.value : PlanGenerator.DEFAULT_LEVEL,
    fitness: (document.querySelector('input[name="fitness"]:checked') || {}).value || FITNESS_FORM_DEFAULT
  };
}

// The fitness radio cards are built once from PlanGenerator.FITNESS.
function buildFitnessChoices() {
  const list = document.getElementById('fitnessList');
  Object.entries(PlanGenerator.FITNESS).forEach(([key, f]) => {
    const label = el('label');
    const input = el('input');
    input.type = 'radio';
    input.name = 'fitness';
    input.value = key;
    const card = el('span', 'choice');
    card.append(el('span', 'choice-title', f.label), el('span', 'choice-blurb', f.blurb));
    label.append(input, card);
    list.appendChild(label);
  });
}

function setFitness(fitness) {
  const radio = document.querySelector(`input[name="fitness"][value="${fitness}"]`);
  if (radio) radio.checked = true;
}

function setLevel(level, hint) {
  const radio = document.querySelector(`input[name="experience"][value="${level}"]`);
  if (radio) radio.checked = true;
  document.getElementById('levelHint').textContent = hint;
}

// The warning belongs to one set of inputs; any edit clears it.
function clearPlanWarning() {
  warnedFor = null;
  document.getElementById('planWarning').hidden = true;
  const submit = document.getElementById('planSubmit');
  submit.textContent = submit.dataset.label;
}

function showPlanWarning(assessment) {
  const box = document.getElementById('planWarning');
  box.innerHTML = '';
  assessment.warnings.forEach(text => box.appendChild(el('p', '', text)));
  box.appendChild(el('p', 'warning-tip', 'You can change the race date or experience level, or build the plan anyway.'));
  box.hidden = false;
  const submit = document.getElementById('planSubmit');
  submit.textContent = 'Build it anyway';
  submit.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // keep the warning and its button on screen
}

function showOnboarding({ editing = false } = {}) {
  const plan = editing ? loadPlan() : null;
  if (plan) {
    document.getElementById('goalDistance').value = String(plan.goalDistance);
    document.getElementById('raceDate').value = plan.raceDate;
    document.getElementById('currentVolume').value = plan.startingVolume;
    document.getElementById('runsPerWeek').value = plan.runsPerWeek;
    levelTouched = true;
    setLevel(PlanGenerator.levelOf(plan.experience), LEVEL_HINTS.saved);
    setFitness(PlanGenerator.fitnessOf(plan.fitness));
  } else {
    levelTouched = false;
    setFitness(FITNESS_FORM_DEFAULT);
    const { currentVolume, runsPerWeek } = formInputs();
    setLevel(PlanGenerator.suggestLevel(currentVolume, runsPerWeek), LEVEL_HINTS.suggested);
  }
  document.querySelector('#onboarding .h1').textContent = plan ? 'Change race goal' : 'Build your plan';
  document.querySelector('#onboarding .lede').textContent = plan
    ? 'Splits will build a new plan from these settings. Progress on your current plan is replaced; synced runs are fetched again.'
    : "Tell Splits what you're training for. It lays out the weeks; you run them; it adjusts as you go.";
  const submit = document.getElementById('planSubmit');
  submit.dataset.label = plan ? 'Rebuild plan' : 'Generate plan';
  clearPlanWarning();
  document.getElementById('planCancel').hidden = !plan;
  showView('onboarding');
}

function startOver() {
  if (!confirm('Discard this plan and start over?')) return;
  localStorage.removeItem(PLAN_KEY);
  localStorage.removeItem(RUNS_KEY);
  openSession = null;
  weekToggles.clear();
  showOnboarding();
}

// ---------------------------------------------------------------- sync

function connectHealth() {
  try {
    HealthSync.beginAuth(); // must stay synchronous inside the click
  } catch (err) {
    console.error(err);
    showToast(err.message);
  }
}

async function syncRuns(plan, { manual = false } = {}) {
  if (!plan) {
    if (manual) showToast('Generate a plan first');
    return;
  }
  if (!HealthSync.isConnected() || syncing) return;
  syncing = true;
  refresh();
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

    if (adjusted) showToast('Plan adjusted after a missed long run');
    else if (manual) showToast(runs.length ? `Synced · ${runs.length} run${runs.length === 1 ? '' : 's'} found` : 'Synced · no runs found yet');
  } catch (err) {
    console.error(err);
    if (err.code === 'token_expired') return; // onChange already told the user
    showToast('Could not sync with Google Health');
  } finally {
    syncing = false;
    refresh();
  }
}

// ---------------------------------------------------------------- init

function init() {
  HealthSync.onChange(({ reason, error }) => {
    refresh();
    if (error) {
      showToast('Could not connect to Google Health');
    } else if (reason === 'expired') {
      showToast('Google Health session expired — reconnect in Profile');
    } else if (HealthSync.isConnected()) {
      showToast('Google Health connected');
      syncRuns(loadPlan());
    }
  });
  // Keeps "last synced 3 min ago" current (skipped while a sheet is open).
  setInterval(() => { if (!document.getElementById('sheet').open) refresh(); }, 30000);

  document.querySelectorAll('.tab').forEach(tab =>
    tab.addEventListener('click', () => showView(tab.dataset.tab)));

  document.getElementById('sheetForm').addEventListener('submit', e => {
    e.preventDefault();
    const value = document.getElementById('sheetInput').value;
    if (sheetSubmit && sheetSubmit(value) === false) return;
    closeSheet();
  });
  document.getElementById('sheetCancel').addEventListener('click', closeSheet);
  document.getElementById('sheet').addEventListener('click', e => {
    if (e.target.id === 'sheet') closeSheet(); // tap on the backdrop
  });

  document.getElementById('planCancel').addEventListener('click', () => showView('profile'));

  buildFitnessChoices();
  setFitness(FITNESS_FORM_DEFAULT);

  // Until the runner picks a level themselves, keep suggesting one from volume.
  const planForm = document.getElementById('planForm');
  planForm.addEventListener('input', e => {
    clearPlanWarning();
    if (e.target.name === 'experience') {
      levelTouched = true;
      document.getElementById('levelHint').textContent = LEVEL_HINTS.chosen;
    } else if (!levelTouched && (e.target.id === 'currentVolume' || e.target.id === 'runsPerWeek')) {
      const { currentVolume, runsPerWeek } = formInputs();
      setLevel(PlanGenerator.suggestLevel(currentVolume, runsPerWeek), LEVEL_HINTS.suggested);
    }
  });
  planForm.addEventListener('change', clearPlanWarning);

  planForm.addEventListener('submit', e => {
    e.preventDefault();
    const inputs = formInputs();

    // Too little time, or a long run that can't get where the race needs:
    // say so once, then build it if they still want to.
    const assessment = PlanGenerator.assess(inputs);
    const signature = JSON.stringify(inputs);
    if (assessment.warnings.length && warnedFor !== signature) {
      showPlanWarning(assessment);
      warnedFor = signature;
      return;
    }

    if (loadPlan() && !confirm('Replace your current plan? Progress on it will be lost.')) return;
    const plan = PlanGenerator.generate(inputs);
    savePlan(plan);
    saveRuns([]); // runs belong to the plan window they were fetched for
    openSession = null;
    weekToggles.clear();
    scrollByView.today = 0;
    renderApp(plan);
    showView('today');
    syncRuns(plan);
  });

  const existingPlan = loadPlan();
  if (existingPlan) {
    renderApp(existingPlan);
    showView('today');
    syncRuns(existingPlan);
  } else {
    showOnboarding();
  }

  checkVersion();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

init();
