/**
 * planGenerator.js
 * Rules-based training plan logic. No network calls, no dependencies.
 * Produces a plain object plan that app.js renders and healthSync.js
 * compares actual runs against.
 */

const PlanGenerator = (() => {

  // Target long-run distance (km) by race distance, as a fraction of race distance.
  const LONG_RUN_TARGET = {
    5: 8,
    10: 14,
    21.1: 18,
    42.2: 32
  };

  // Minimum sensible plan length so there's room to build safely.
  const MIN_WEEKS = 6;

  function weeksBetween(fromDate, toDate) {
    const ms = toDate.getTime() - fromDate.getTime();
    return Math.max(MIN_WEEKS, Math.round(ms / (7 * 24 * 60 * 60 * 1000)));
  }

  function phaseForWeek(weekIndex, totalWeeks) {
    const taperWeeks = totalWeeks >= 16 ? 3 : 2;
    const peakStart = totalWeeks - taperWeeks - Math.round(totalWeeks * 0.2);
    const buildStart = Math.round(totalWeeks * 0.3);

    if (weekIndex >= totalWeeks - taperWeeks) return 'taper';
    if (weekIndex >= peakStart) return 'peak';
    if (weekIndex >= buildStart) return 'build';
    return 'base';
  }

  // Weekly total km, ramping from currentVolume toward a race-appropriate
  // peak, with a step-back (recovery) week every 4th week, then tapering.
  function volumeForWeek(weekIndex, totalWeeks, currentVolume, goalDistance) {
    const taperWeeks = totalWeeks >= 16 ? 3 : 2;
    const peakVolume = Math.max(currentVolume * 1.5, LONG_RUN_TARGET[goalDistance] * 2.2);
    const buildWeeks = totalWeeks - taperWeeks;

    if (weekIndex >= buildWeeks) {
      // Taper: step down toward ~50% of peak on race week.
      const taperProgress = (weekIndex - buildWeeks + 1) / taperWeeks;
      return round5(peakVolume * (1 - taperProgress * 0.5));
    }

    const isStepBack = (weekIndex + 1) % 4 === 0;
    const progress = buildWeeks <= 1 ? 1 : weekIndex / (buildWeeks - 1);
    let volume = currentVolume + (peakVolume - currentVolume) * progress;
    if (isStepBack) volume *= 0.8;
    return round5(volume);
  }

  function longRunForWeek(weekIndex, totalWeeks, goalDistance) {
    const taperWeeks = totalWeeks >= 16 ? 3 : 2;
    const buildWeeks = totalWeeks - taperWeeks;
    const target = LONG_RUN_TARGET[goalDistance];

    if (weekIndex >= buildWeeks) {
      const taperProgress = (weekIndex - buildWeeks + 1) / taperWeeks;
      return round5(target * (1 - taperProgress * 0.4));
    }
    const progress = buildWeeks <= 1 ? 1 : weekIndex / (buildWeeks - 1);
    return round5(Math.min(target, target * (0.5 + progress * 0.5)));
  }

  function round5(km) {
    return Math.max(3, Math.round(km / 0.5) * 0.5);
  }

  // Split a week's total volume into named sessions.
  function buildSessions(weekIndex, totalWeeks, weeklyVolume, longRun, runsPerWeek, phase) {
    const sessions = [];
    const remaining = Math.max(0, weeklyVolume - longRun);
    const otherRuns = Math.max(1, runsPerWeek - 1);

    sessions.push({
      name: 'Long run',
      type: 'long',
      distance: longRun,
      status: 'planned'
    });

    if (phase !== 'taper' || otherRuns > 1) {
      const qualityDistance = round5(Math.min(remaining * 0.4, 10));
      sessions.push({
        name: phase === 'base' ? 'Steady run' : 'Tempo / intervals',
        type: 'quality',
        distance: qualityDistance,
        status: 'planned'
      });
    }

    const easyCount = Math.max(0, otherRuns - (sessions.length - 1));
    const easyTotal = Math.max(0, weeklyVolume - sessions.reduce((s, x) => s + x.distance, 0));
    const easyEach = easyCount > 0 ? round5(easyTotal / easyCount) : 0;

    for (let i = 0; i < easyCount; i++) {
      sessions.push({
        name: 'Easy run',
        type: 'easy',
        distance: easyEach,
        status: 'planned'
      });
    }

    return sessions;
  }

  function generate({ goalDistance, raceDate, currentVolume, runsPerWeek }) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const race = new Date(raceDate);
    const totalWeeks = weeksBetween(start, race);

    const weeks = [];
    for (let i = 0; i < totalWeeks; i++) {
      const phase = phaseForWeek(i, totalWeeks);
      const weeklyVolume = volumeForWeek(i, totalWeeks, Number(currentVolume), Number(goalDistance));
      const longRun = longRunForWeek(i, totalWeeks, Number(goalDistance));
      weeks.push({
        weekNumber: i + 1,
        phase,
        targetVolume: weeklyVolume,
        sessions: buildSessions(i, totalWeeks, weeklyVolume, longRun, Number(runsPerWeek), phase)
      });
    }

    return {
      goalDistance: Number(goalDistance),
      raceDate,
      runsPerWeek: Number(runsPerWeek),
      startingVolume: Number(currentVolume),
      createdAt: new Date().toISOString(),
      totalWeeks,
      weeks
    };
  }

  // Re-derive the plan's remaining weeks after a missed or completed
  // session, without discarding history. Called by app.js when actual
  // run data comes back from healthSync.
  function adjustForMiss(plan, weekNumber) {
    const weekIdx = plan.weeks.findIndex(w => w.weekNumber === weekNumber);
    if (weekIdx === -1) return plan;

    // Simple, conservative rule: if a week's long run was missed, hold
    // next week's volume flat instead of progressing, rather than
    // jumping back up to plan.
    const nextWeek = plan.weeks[weekIdx + 1];
    if (nextWeek) {
      nextWeek.targetVolume = plan.weeks[weekIdx].targetVolume;
      nextWeek.adjusted = true;
    }
    return plan;
  }

  return { generate, adjustForMiss };
})();
