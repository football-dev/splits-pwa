/**
 * planGenerator.js
 * Rules-based training plan logic. No network calls, no dependencies.
 * Produces a plain object plan that app.js renders and healthSync.js
 * compares actual runs against.
 *
 * The plan is weighted by the runner's experience (beginner, intermediate
 * or experienced). Level changes how far the long run and weekly volume are
 * allowed to climb, how fast they may grow, and how often a lighter recovery
 * week comes round. It never overrides current fitness: peak volume is also
 * capped relative to what the runner does now. The session mix (one quality
 * run a week) is the same at every level.
 */

const PlanGenerator = (() => {

  // longPeak: the long run the plan builds to, by race distance (km).
  // longStart: share of current weekly volume the first long run takes.
  // longCap: longest a long run may be, as a share of that week's volume.
  // growth: ceiling on weekly volume growth (compounded, per non-recovery week).
  // peakMult / ratio: wanted peak volume = max(current * peakMult, longPeak * ratio).
  //   ratio must be at least 1 / longCap, or the peak volume can't carry the peak
  //   long run and the plan never reaches its own target.
  // stepEvery: every Nth week is a lighter recovery week.
  // minWeeks: rule-of-thumb shortest sensible plan, by race distance.
  // Race distances are in km: 5, 10, 21.1 (half), 42.2 (marathon), 50 and 100 (ultras).
  const LEVELS = {
    beginner: {
      label: 'Beginner',
      longStart: 0.40, longCap: 0.50, growth: 0.08, peakMult: 1.4, ratio: 2.0, stepEvery: 3,
      longPeak: { 5: 6, 10: 10, 21.1: 14, 42.2: 28, 50: 30, 100: 34 },
      minWeeks: { 5: 8, 10: 14, 21.1: 20, 42.2: 24, 50: 30, 100: 40 }
    },
    intermediate: {
      label: 'Intermediate',
      longStart: 0.40, longCap: 0.46, growth: 0.10, peakMult: 1.5, ratio: 2.2, stepEvery: 4,
      longPeak: { 5: 8, 10: 14, 21.1: 18, 42.2: 32, 50: 35, 100: 40 },
      minWeeks: { 5: 6, 10: 8, 21.1: 12, 42.2: 18, 50: 22, 100: 30 }
    },
    experienced: {
      label: 'Experienced',
      longStart: 0.30, longCap: 0.35, growth: 0.11, peakMult: 1.4, ratio: 3.2, stepEvery: 4,
      longPeak: { 5: 10, 10: 16, 21.1: 21, 42.2: 35, 50: 38, 100: 45 },
      minWeeks: { 5: 6, 10: 6, 21.1: 8, 42.2: 14, 50: 16, 100: 24 }
    }
  };
  const DEFAULT_LEVEL = 'intermediate'; // plans saved before levels existed

  // General fitness outside running (job, gym, sport). Experience sets how far a
  // plan can go; fitness sets how fast it may get there, so it scales the
  // growth ceiling, the peak volume the plan aims for and caps at, and the peak
  // long run (down only), shifts the recovery cadence, and stretches or shortens
  // the suggested minimum weeks.
  const FITNESS = {
    sedentary: { label: 'Mostly sedentary',  blurb: 'Desk job, little other exercise', growth: 0.75, peak: 0.90, long: 0.95, minWeeks: 1.25, stepEvery: 3 },
    light:     { label: 'Lightly active',    blurb: 'Some walking or the odd session', growth: 0.90, peak: 0.95, long: 1.0,  minWeeks: 1.1,  stepEvery: 4 },
    active:    { label: 'Active',            blurb: 'Exercise 2\u20133 days a week', growth: 1.0,  peak: 1.0,  long: 1.0,  minWeeks: 1.0,  stepEvery: 4 },
    veryActive:{ label: 'Very active',       blurb: 'Train 4+ days a week (gym, sport, running)', growth: 1.15, peak: 1.05, long: 1.0,  minWeeks: 0.9,  stepEvery: 4 }
  };
  const DEFAULT_FITNESS = 'active'; // same as before fitness existed

  // A safety net, not the main brake (the growth ceiling is): peak weekly volume
  // never exceeds this multiple of current volume, or current + PEAK_CAP_ADD km
  // for low-volume runners. Loose enough that a long timeline can build properly.
  const PEAK_CAP_MULT = 3;
  const PEAK_CAP_ADD = 20;
  // Beginners starting from very little still add at least this per growth week (km).
  const MIN_WEEKLY_ADD = 0.8;

  const RACE_NAMES = { 5: '5K', 10: '10K', 21.1: 'half marathon', 42.2: 'marathon', 50: '50K ultra', 100: '100K ultra' };

  // No plan aims for more weekly volume than this, whatever the level. It only
  // matters for very high-mileage runners; it never lowers a runner's current volume.
  const RACE_PEAK_MAX = { 5: 60, 10: 80, 21.1: 100, 42.2: 120, 50: 130, 100: 145 };

  // Minimum sensible plan length so there's room to build safely.
  const MIN_WEEKS = 6;

  function levelOf(experience) {
    return LEVELS[experience] ? experience : DEFAULT_LEVEL;
  }

  function fitnessOf(fitness) {
    return FITNESS[fitness] ? fitness : DEFAULT_FITNESS;
  }

  // Starting suggestion from what the runner already does. The form lets them
  // override it.
  function suggestLevel(currentVolume, runsPerWeek) {
    const volume = Number(currentVolume) || 0;
    const runs = Number(runsPerWeek) || 0;
    if (volume < 15) return 'beginner';
    if (volume >= 40 && runs >= 4) return 'experienced';
    return 'intermediate';
  }

  function weeksUntil(raceDate, from = new Date()) {
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    const ms = new Date(raceDate).getTime() - start.getTime();
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

  function round5(km, min = 3) {
    return Math.max(min, Math.round(km / 0.5) * 0.5);
  }

  // Peak weekly volume: what the race and level call for, held back by how
  // fast the level may grow and by the cap relative to current fitness.
  function peakVolume(current, buildWeeks, longPeak, goal, L, F, stepEvery) {
    const growthWeeks = buildWeeks - Math.floor(buildWeeks / stepEvery);
    const growthCeiling = Math.max(
      current * Math.pow(1 + L.growth * F.growth, growthWeeks),
      current + MIN_WEEKLY_ADD * F.growth * growthWeeks
    );
    const wanted = Math.max(current * L.peakMult, longPeak * L.ratio) * F.peak;
    const cap = Math.max(current * PEAK_CAP_MULT, current + PEAK_CAP_ADD) * F.peak;
    return Math.max(current, Math.min(wanted, growthCeiling, cap, RACE_PEAK_MAX[goal] || Infinity));
  }

  // Split a week's volume into named sessions that add up to it: the long
  // run first, then one quality run, then easy runs sharing what is left.
  function buildSessions(weeklyVolume, longRun, runsPerWeek, phase) {
    const sessions = [{ name: 'Long run', type: 'long', distance: longRun, status: 'planned' }];
    const otherRuns = Math.max(1, runsPerWeek - 1);
    const remaining = Math.max(0, weeklyVolume - longRun);

    const hasQuality = phase !== 'taper' || otherRuns > 1;
    const easyCount = Math.max(0, otherRuns - (hasQuality ? 1 : 0));

    let qualityDistance = 0;
    if (hasQuality) {
      // Slightly longer than an easy run, never longer than 10 km.
      const share = easyCount > 0 ? (remaining / otherRuns) * 1.15 : remaining;
      qualityDistance = round5(Math.min(share, 10), 2);
      sessions.push({
        name: phase === 'base' ? 'Steady run' : 'Tempo / intervals',
        type: 'quality',
        distance: qualityDistance,
        status: 'planned'
      });
    }

    const easyEach = easyCount > 0 ? round5((remaining - qualityDistance) / easyCount, 2) : 0;
    for (let i = 0; i < easyCount; i++) {
      sessions.push({ name: 'Easy run', type: 'easy', distance: easyEach, status: 'planned' });
    }

    // Rounding each run to 0.5 km can leave the week a little off its planned
    // volume, which shows up as wobble in an otherwise rising plan. Put the
    // difference on the last short run (an easy run, else the quality run).
    const gap = Math.round((weeklyVolume - sessions.reduce((sum, x) => sum + x.distance, 0)) * 2) / 2;
    const last = sessions[sessions.length - 1];
    if (gap !== 0 && last.type !== 'long' && last.distance + gap >= 2) last.distance += gap;
    return sessions;
  }

  function generate({ goalDistance, raceDate, currentVolume, runsPerWeek, experience, fitness }) {
    const level = levelOf(experience);
    const L = LEVELS[level];
    const fitnessLevel = fitnessOf(fitness);
    const F = FITNESS[fitnessLevel];
    const stepEvery = Math.min(L.stepEvery, F.stepEvery); // recovery weeks: whichever is more cautious
    const goal = Number(goalDistance);
    const current = Math.max(0, Number(currentVolume) || 0);
    const runs = Number(runsPerWeek);

    const totalWeeks = weeksUntil(raceDate);
    const taperWeeks = totalWeeks >= 16 ? 3 : 2;
    const buildWeeks = totalWeeks - taperWeeks;
    const longPeak = L.longPeak[goal] * F.long;
    // A long run's natural share of the week rises as runs per week fall (with 3
    // runs it is ~45%, with 6 ~25%), so the level's cap is never tighter than that.
    const longCap = Math.max(L.longCap, 1.5 / runs);
    const peak = peakVolume(current, buildWeeks, longPeak, goal, L, F, stepEvery);
    const longStart = Math.min(current * L.longStart, longPeak);

    const weeks = [];
    let longestBuildRun = 0;
    for (let i = 0; i < totalWeeks; i++) {
      const phase = phaseForWeek(i, totalWeeks);
      let volume;
      let longRun;

      if (i >= buildWeeks) {
        // Taper: step down toward ~50% of peak on race week, and shorten the
        // long run from the longest one actually reached.
        const taperProgress = (i - buildWeeks + 1) / taperWeeks;
        volume = peak * (1 - taperProgress * 0.5);
        longRun = longestBuildRun * (1 - taperProgress * 0.4);
      } else {
        const progress = buildWeeks <= 1 ? 1 : i / (buildWeeks - 1);
        const isStepBack = (i + 1) % stepEvery === 0; // recovery week
        volume = (current + (peak - current) * progress) * (isStepBack ? 0.8 : 1);
        longRun = (longStart + (longPeak - longStart) * progress) * (isStepBack ? 0.85 : 1);
      }

      volume = round5(volume);
      longRun = round5(Math.min(longRun, volume * longCap), 2);
      if (i < buildWeeks) longestBuildRun = Math.max(longestBuildRun, longRun);

      const sessions = buildSessions(volume, longRun, runs, phase);
      const planned = sessions.reduce((sum, s) => sum + s.distance, 0);
      weeks.push({
        weekNumber: i + 1,
        phase,
        targetVolume: Math.round(planned * 10) / 10, // matches the sessions, so the chart and rows agree
        sessions
      });
    }

    return {
      goalDistance: goal,
      raceDate,
      runsPerWeek: runs,
      startingVolume: current,
      experience: level,
      fitness: fitnessLevel,
      createdAt: new Date().toISOString(),
      totalWeeks,
      weeks
    };
  }

  // Checks a set of inputs before a plan is built. Returns the level used and
  // any honest warnings: too little time for the level, or a long run that
  // can't get near where the race calls for.
  function assess(inputs) {
    const level = levelOf(inputs.experience);
    const L = LEVELS[level];
    const F = FITNESS[fitnessOf(inputs.fitness)];
    const goal = Number(inputs.goalDistance);
    const plan = generate({ ...inputs, experience: level });
    const race = RACE_NAMES[goal] || `${goal}K`;
    const minWeeks = Math.ceil(L.minWeeks[goal] * F.minWeeks);
    const targetLong = Math.round(L.longPeak[goal] * F.long * 2) / 2;
    const peakLong = Math.max(...plan.weeks.map(w => w.sessions[0].distance));

    const warnings = [];
    if (plan.totalWeeks < minWeeks) {
      warnings.push(`${plan.totalWeeks} weeks is tight for a ${L.label.toLowerCase()} ${race} — we suggest ${minWeeks} or more.`);
    }
    if (peakLong < targetLong * 0.8) {
      warnings.push(`At your current volume the plan's longest run only reaches ${peakLong} km, short of the ~${targetLong} km we'd usually build to for a ${race}.`);
    }
    return { level, weeks: plan.totalWeeks, minWeeks, peakLong, targetLong, warnings };
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

  return { LEVELS, FITNESS, DEFAULT_LEVEL, DEFAULT_FITNESS, generate, assess, suggestLevel, levelOf, fitnessOf, adjustForMiss };
})();
