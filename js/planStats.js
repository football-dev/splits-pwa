/**
 * planStats.js
 * Pure plan/run maths — no DOM, no network. Reconciles synced runs against
 * the plan, and derives the numbers the UI shows (hero stats, weekly volume,
 * run log). app.js owns storage and rendering.
 *
 * Plan weeks are 7-day windows starting at local midnight on the day the plan
 * was created. A session is 'planned' or 'done'; "missed" is derived (a
 * not-done session in a week that has already ended), never stored, so a run
 * that syncs late can still fill it.
 */

const PlanStats = (() => {

  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;

  const round1 = n => Math.round(n * 10) / 10;

  function planStart(plan) {
    const d = new Date(plan.createdAt);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // Local YYYY-MM-DD of the plan's first day — the format the Google Health
  // civil_start_time filter expects.
  function startDate(plan) {
    const d = new Date(planStart(plan));
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  function currentWeekNumber(plan, now = Date.now()) {
    const weeksElapsed = Math.floor((now - planStart(plan)) / WEEK_MS);
    return Math.max(1, Math.min(plan.totalWeeks, weeksElapsed + 1));
  }

  // Zero-based plan week a timestamp falls in. Negative before the plan
  // starts, >= totalWeeks after it ends.
  function weekIndexFor(plan, isoDate) {
    return Math.floor((new Date(isoDate).getTime() - planStart(plan)) / WEEK_MS);
  }

  function sessionState(plan, week, session, now = Date.now()) {
    if (session.status === 'done') return 'done';
    return week.weekNumber < currentWeekNumber(plan, now) ? 'missed' : 'planned';
  }

  // Match synced runs to sessions. Idempotent: a session remembers the run
  // that filled it (runId), so re-syncing never fills a second session with
  // the same run. Returns true if a missed long run newly adjusted the plan.
  function reconcile(plan, runs, now = Date.now()) {
    // Older saved plans stored 'missed'; it is derived now.
    plan.weeks.forEach(w => w.sessions.forEach(s => {
      if (s.status === 'missed') s.status = 'planned';
    }));

    const byRunId = new Map();
    plan.weeks.forEach(w => w.sessions.forEach(s => {
      if (s.runId) byRunId.set(s.runId, s);
    }));

    [...runs]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .forEach(run => {
        const existing = byRunId.get(run.id);
        if (existing) {
          existing.actualKm = run.distanceKm;
          return;
        }
        // A run with no distance can't be matched by distance; it still
        // shows in the run log, and can be marked done by hand.
        if (!(run.distanceKm > 0)) return;

        const week = plan.weeks[weekIndexFor(plan, run.date)];
        if (!week) return;

        const candidate = week.sessions
          .filter(s => s.status !== 'done')
          .sort((a, b) => Math.abs(a.distance - run.distanceKm) - Math.abs(b.distance - run.distanceKm))[0];
        if (!candidate) return;

        candidate.status = 'done';
        candidate.runId = run.id;
        candidate.actualKm = run.distanceKm;
        byRunId.set(run.id, candidate);
      });

    let adjusted = false;
    const curWeek = currentWeekNumber(plan, now);
    plan.weeks.forEach((week, i) => {
      if (week.weekNumber >= curWeek) return;
      const nextWeek = plan.weeks[i + 1];
      const missedLong = week.sessions.some(s => s.type === 'long' && s.status !== 'done');
      if (missedLong && nextWeek && !nextWeek.adjusted) {
        PlanGenerator.adjustForMiss(plan, week.weekNumber);
        adjusted = true;
      }
    });
    return adjusted;
  }

  // Manual fallback for a run the watch didn't track (treadmill etc).
  function markManualDone(plan, weekNumber, sessionIndex, km, now = Date.now()) {
    const week = plan.weeks[weekNumber - 1];
    const session = week && week.sessions[sessionIndex];
    const distance = Number(km);
    if (!session || session.status === 'done' || !(distance > 0)) return false;
    session.status = 'done';
    session.manual = true;
    session.actualKm = round1(distance);
    session.doneAt = new Date(now).toISOString();
    return true;
  }

  function undoManual(plan, weekNumber, sessionIndex) {
    const week = plan.weeks[weekNumber - 1];
    const session = week && week.sessions[sessionIndex];
    if (!session || !session.manual) return false;
    session.status = 'planned';
    delete session.manual;
    delete session.actualKm;
    delete session.doneAt;
    return true;
  }

  function paceSecPerKm(run) {
    const seconds = run.durationSec || (run.durationMin || 0) * 60;
    return run.distanceKm > 0 && seconds > 0 ? seconds / run.distanceKm : null;
  }

  // Km actually run in a plan week: every synced run in the week's window
  // (matched or not) plus manual completions.
  function weekActualKm(plan, runs, weekNumber) {
    let km = 0;
    runs.forEach(run => {
      if (run.distanceKm > 0 && weekIndexFor(plan, run.date) === weekNumber - 1) km += run.distanceKm;
    });
    const week = plan.weeks[weekNumber - 1];
    if (week) week.sessions.forEach(s => { if (s.manual) km += s.actualKm || 0; });
    return round1(km);
  }

  function daysToRace(plan, now = Date.now()) {
    const [y, m, d] = plan.raceDate.split('-').map(Number);
    const race = new Date(y, m - 1, d).getTime();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((race - today.getTime()) / DAY_MS));
  }

  // Trailing run of completed sessions with no miss in between. Sessions still
  // to come in the current week are unresolved and don't break it.
  function streak(plan, now = Date.now()) {
    const curWeek = currentWeekNumber(plan, now);
    let count = 0;
    plan.weeks.slice(0, curWeek).forEach(week => {
      week.sessions.forEach(s => {
        if (s.status === 'done') count++;
        else if (week.weekNumber < curWeek) count = 0;
      });
    });
    return count;
  }

  function hero(plan, runs, now = Date.now()) {
    const weekNumber = currentWeekNumber(plan, now);
    const week = plan.weeks[weekNumber - 1];
    return {
      daysToRace: daysToRace(plan, now),
      weekNumber,
      phase: week.phase,
      weekTarget: week.targetVolume,
      weekActual: weekActualKm(plan, runs, weekNumber),
      streak: streak(plan, now)
    };
  }

  function weeklySeries(plan, runs, now = Date.now()) {
    const curWeek = currentWeekNumber(plan, now);
    return plan.weeks.map(week => ({
      weekNumber: week.weekNumber,
      phase: week.phase,
      target: week.targetVolume,
      actual: week.weekNumber <= curWeek ? weekActualKm(plan, runs, week.weekNumber) : 0,
      current: week.weekNumber === curWeek,
      future: week.weekNumber > curWeek
    }));
  }

  // Every synced run plus every manual completion, newest first, each tagged
  // with the plan session it filled (or why it didn't fill one).
  function runLog(plan, runs) {
    const filled = new Map();
    plan.weeks.forEach(week => week.sessions.forEach(s => {
      if (s.runId) filled.set(s.runId, { week, session: s });
    }));

    const entries = runs.map(run => {
      const match = filled.get(run.id);
      let tag;
      if (match) {
        tag = { kind: 'matched', weekNumber: match.week.weekNumber, label: match.session.name, type: match.session.type };
      } else if (!(run.distanceKm > 0)) {
        tag = { kind: 'nodistance', label: 'No distance recorded' };
      } else {
        const idx = weekIndexFor(plan, run.date);
        tag = idx < 0 || idx >= plan.totalWeeks
          ? { kind: 'outside', label: 'Outside plan' }
          : { kind: 'extra', label: 'Extra run' };
      }
      return {
        source: 'health',
        id: run.id,
        date: run.date,
        distanceKm: run.distanceKm,
        durationMin: run.durationMin,
        paceSecPerKm: paceSecPerKm(run),
        avgHeartRate: run.avgHeartRate,
        tag
      };
    });

    plan.weeks.forEach(week => week.sessions.forEach((s, i) => {
      if (!s.manual) return;
      entries.push({
        source: 'manual',
        id: `manual-${week.weekNumber}-${i}`,
        date: s.doneAt,
        distanceKm: s.actualKm,
        durationMin: null,
        paceSecPerKm: null,
        avgHeartRate: null,
        tag: { kind: 'matched', weekNumber: week.weekNumber, label: s.name, type: s.type }
      });
    }));

    return entries.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  return {
    startDate, currentWeekNumber, weekIndexFor, sessionState, reconcile,
    markManualDone, undoManual, paceSecPerKm, weekActualKm, daysToRace,
    streak, hero, weeklySeries, runLog
  };
})();
