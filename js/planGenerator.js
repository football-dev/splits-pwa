/**
 * planGenerator.js
 * Designs training plans. No network calls, no dependencies.
 *
 * This implements the "Running Plan Scaling Algorithm" (docs/plan-algorithm.md):
 * goal-specific minimum weeks and peak targets, BASE / BUILD / PEAK / TAPER
 * phases, deload every 4th week, a taper table, training-day schedules, a
 * workout for each phase, and the OK / AGGRESSIVE / TOO_SHORT timeline verdicts.
 *
 * Where the document as written cannot produce a working plan, the code follows
 * its intent and marks the change `FIX`, with the reason. docs/plan-algorithm.md
 * lists them all. In short: deload weeks are computed from the last *build* week
 * (the document computed them from the previous week, so every 4-week cycle
 * shrank the plan); growth has a small kilometre floor (a percentage of 0 km is
 * 0 km); the verdicts also check the plan actually reaches its peak; and, as
 * requested, the 5K, 10K and half marathon build to the full race distance in
 * training.
 *
 * design(input) is the entry point. It returns { status, plan, ... }; plan is
 * null when the status is TOO_SHORT.
 */

const PlanGenerator = (() => {

  const DAY_MS = 24 * 60 * 60 * 1000;

  // ------------------------------------------------------------ constants

  const GOAL_TYPES = [[5, '5K'], [10, '10K'], [21.1, 'HALF_MARATHON'], [42.2, 'MARATHON']];

  // Section 3.
  const MIN_WEEKS = { '5K': 6, '10K': 8, HALF_MARATHON: 12, MARATHON: 16, ULTRA: 20 };

  // Section 6.
  const TAPER_WEEKS = { '5K': 1, '10K': 1, HALF_MARATHON: 2, MARATHON: 3, ULTRA: 3 };

  // Section 7: peak weekly volume = goal km x multiplier x days factor.
  const PEAK_VOLUME_MULTIPLIER = { '5K': 3.0, '10K': 3.2, HALF_MARATHON: 2.5, MARATHON: 2.0, ULTRA: 1.6 };

  const LEVELS = {
    beginner: { label: 'Beginner' },
    intermediate: { label: 'Intermediate' },
    advanced: { label: 'Advanced' }
  };
  const DEFAULT_LEVEL = 'beginner'; // the document's default

  const QUALITY_NAMES = {
    strides_or_hills: 'Strides or hills',
    intervals: 'Intervals',
    tempo: 'Tempo run',
    goal_pace_blocks: 'Goal-pace blocks',
    race_specific_intervals: 'Race-specific intervals',
    light_sharpening: 'Light sharpening'
  };

  // FIX: growth is a percentage, and a percentage of a small number is tiny (of 0 km it
  // is 0 km). At low distances the long run grows by at least this many km per build
  // week, and weekly volume by this divided by the long-run share. 1 km is the pace of the
  // week-by-week milestone table for a beginner half marathon (3 km in week 3, 7 km in
  // week 8, 13 km in week 13, 17 km in week 16).
  const LONG_RUN_MIN_ADD_KM = 1;

  // FIX: a plan never starts below a 1 km long run (so week 1 is about 2 km, matching the
  // milestone table's "1-2 km run/walk"), or with any run shorter than 2 km.
  const MIN_START_LONG_RUN_KM = 1;
  const MIN_RUN_KM = 2;

  // Section 14 leaves "short but close" undefined. Below this share of the minimum
  // weeks, or when the plan can't get near its peak, a race plan is not generated.
  const TOO_SHORT_SHARE = 0.75;
  const TOO_SHORT_REACH = 0.5;
  // FIX: verdicts also require the plan to reach this much of the long run it aims for.
  const OK_REACH = 0.85;
  const MAX_PLAN_WEEKS = 104; // the longest plan considered when suggesting a date

  const round5 = km => Math.round(km * 2) / 2;
  const round1 = n => Math.round(n * 10) / 10;

  // -------------------------------------------------------------- inputs

  function levelOf(experience) {
    if (experience === 'experienced') return 'advanced'; // plans saved before the rename
    return LEVELS[experience] ? experience : DEFAULT_LEVEL;
  }

  function goalTypeFor(goalKm) {
    const hit = GOAL_TYPES.find(([km]) => Math.abs(km - goalKm) < 0.05);
    return hit ? hit[1] : 'ULTRA';
  }

  function raceName(goalKm) {
    const type = goalTypeFor(goalKm);
    return { '5K': '5K', '10K': '10K', HALF_MARATHON: 'half marathon', MARATHON: 'marathon' }[type] || `${goalKm}K ultra`;
  }

  // Starting suggestion from what the runner already does; the form lets them override it.
  function suggestLevel(startingKm, days) {
    const km = Number(startingKm) || 0;
    if (km >= 16 && Number(days) >= 4) return 'advanced';
    if (km >= 8) return 'intermediate';
    return 'beginner';
  }

  function parseLocalDate(value) {
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const [y, m, d] = String(value).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // Section 4. Whole days first, so a daylight-saving change can't lose a week.
  function weeksBetween(startDate, targetDate) {
    const days = Math.round((parseLocalDate(targetDate) - parseLocalDate(startDate)) / DAY_MS);
    return Math.floor(days / 7);
  }

  function normalize(input) {
    const goalKm = Number(input.goalDistance ?? input.goalKm);
    const days = Math.min(7, Math.max(2, Math.round(Number(input.trainingDays ?? input.runsPerWeek) || 3)));
    return {
      goalKm,
      goalType: goalTypeFor(goalKm),
      days,
      level: levelOf(input.experience),
      startKm: Math.max(0, Number(input.startingDistance ?? input.startingDistanceKm) || 0),
      raceDate: input.raceDate,
      startDate: input.startDate || new Date()
    };
  }

  // ------------------------------------------------ the algorithm's parts

  // Section 3.
  function adjustedMinimumWeeks(goalKm, startingKm, baseMinWeeks) {
    const readiness = startingKm / goalKm;
    if (readiness >= 0.75) return Math.max(4, baseMinWeeks - 4);
    if (readiness >= 0.5) return Math.max(6, baseMinWeeks - 2);
    if (readiness >= 0.25) return baseMinWeeks;
    return baseMinWeeks + 4;
  }

  // Section 6.
  function assignPhase(weekIndex, totalWeeks, taperWeeks) {
    const progress = weekIndex / totalWeeks;
    const taperStart = totalWeeks - taperWeeks + 1;
    if (weekIndex >= taperStart) return 'taper';
    if (progress < 0.35) return 'base';
    if (progress < 0.75) return 'build';
    return 'peak';
  }

  // Section 7.
  function longRunShare(days) {
    if (days <= 3) return 0.45;
    if (days === 4) return 0.38;
    if (days === 5) return 0.34;
    return 0.30;
  }

  function targetPeakWeeklyVolume(goalKm, goalType, days) {
    const daysFactor = Math.min(1.2, Math.max(0.75, days / 5));
    return goalKm * PEAK_VOLUME_MULTIPLIER[goalType] * daysFactor;
  }

  function weeklyGrowthRate(days, level) {
    let base = days <= 3 ? 0.07 : 0.10;
    if (level === 'beginner') base -= 0.02;
    if (level === 'advanced') base += 0.02;
    return Math.max(0.05, Math.min(base, 0.12));
  }

  function isDeloadWeek(weekIndex, totalWeeks, taperWeeks) {
    return weekIndex <= totalWeeks - taperWeeks && weekIndex % 4 === 0;
  }

  // Section 8, changed as requested: for the 5K, 10K and half marathon the peak long run
  // is the race distance (the document had 5 / 11 / 17.9 km). The marathon (32 km) and
  // ultras (goal x 0.45) are the document's.
  function targetPeakLongRun(goalKm, goalType) {
    switch (goalType) {
      case '5K':
      case '10K':
      case 'HALF_MARATHON': return goalKm;
      case 'MARATHON': return 32;
      default: return goalKm * 0.45;
    }
  }

  // Section 9.
  function taperVolume(peak, weekNumber, totalTaperWeeks) {
    if (totalTaperWeeks === 1) return peak * 0.60;
    if (totalTaperWeeks === 2) return weekNumber === 1 ? peak * 0.70 : peak * 0.45;
    if (weekNumber === 1) return peak * 0.75;
    return weekNumber === 2 ? peak * 0.55 : peak * 0.35;
  }

  // Section 10.
  function runTypesForDays(days) {
    if (days <= 2) return ['easy', 'long'];
    if (days === 3) return ['easy', 'quality', 'long'];
    if (days === 4) return ['easy', 'quality', 'easy', 'long'];
    if (days === 5) return ['easy', 'quality', 'easy', 'easy', 'long'];
    return ['easy', 'quality', 'easy', 'mediumLong', 'easy', 'long']; // 6 and 7 days: six runs, the rest is rest
  }

  // Section 11.
  function qualityWorkoutForPhase(phase, goalType) {
    if (phase === 'base') return 'strides_or_hills';
    if (phase === 'build') return goalType === '5K' || goalType === '10K' ? 'intervals' : 'tempo';
    if (phase === 'peak') return goalType === 'MARATHON' || goalType === 'ULTRA' ? 'goal_pace_blocks' : 'race_specific_intervals';
    return 'light_sharpening';
  }

  // Section 10: the week's volume shared across its runs. The document's shares
  // (medium-long 0.30, quality 0.25, easy 1 / number of other runs) add up to more or
  // less than 1 and it calls an undefined normalizeRunDistances, so they are scaled to
  // fill the week exactly. FIX: runs are at least 2 km and rounded to 0.5 km, with the
  // rounding difference put on the largest short run, so a week adds up to its volume.
  function distributeWeeklyVolume(weeklyVolume, longRunKm, runTypes) {
    const nonLong = runTypes.filter(t => t !== 'long');
    const remaining = Math.max(0, weeklyVolume - longRunKm);
    const shares = nonLong.map(t => (t === 'mediumLong' ? 0.30 : t === 'quality' ? 0.25 : 1 / nonLong.length));
    const shareTotal = shares.reduce((a, b) => a + b, 0);

    const distances = nonLong.map((_, i) => Math.max(MIN_RUN_KM, round5((remaining * shares[i]) / shareTotal)));
    const long = Math.max(MIN_RUN_KM, round5(longRunKm));

    const gap = round5(weeklyVolume) - (long + distances.reduce((a, b) => a + b, 0));
    if (gap !== 0) {
      const biggest = distances.indexOf(Math.max(...distances));
      if (biggest !== -1 && distances[biggest] + gap >= MIN_RUN_KM) distances[biggest] += gap;
    }

    let next = 0;
    return runTypes.map(type => ({ type, distanceKm: type === 'long' ? long : distances[next++] }));
  }

  // ---------------------------------------------------------- plan build

  // Everything a plan needs that depends only on the inputs.
  function planTargets(p) {
    const share = longRunShare(p.days);
    const runTypes = runTypesForDays(p.days);
    const targetLong = targetPeakLongRun(p.goalKm, p.goalType);
    let targetVolume = targetPeakWeeklyVolume(p.goalKm, p.goalType, p.days);
    // The long run is capped at its share of the weekly volume (section 8), and the
    // document's weekly peak for a half marathon on 3 days (39.6 km) only carries a
    // 17.8 km long run. So for the races whose long-run target was raised to the race
    // distance, the weekly peak is at least what carries it. The marathon and ultras are
    // the document's numbers, so a 4-day marathon plan can still only reach 25.6 km, and
    // that is what "the peak" means when judging whether a plan reaches it.
    if (p.goalType === '5K' || p.goalType === '10K' || p.goalType === 'HALF_MARATHON') {
      targetVolume = Math.max(targetVolume, targetLong / share);
    }
    const attainableLong = Math.min(targetLong, targetVolume * share);
    const startLong = Math.min(Math.max(p.startKm, MIN_START_LONG_RUN_KM), targetLong);
    const startVolume = Math.min(
      Math.max(startLong / share, startLong + MIN_RUN_KM * (runTypes.length - 1)),
      targetVolume
    );
    return { share, runTypes, targetVolume, targetLong, attainableLong, startLong, startVolume };
  }

  // Sections 6-9 and 12. `reduced` (AGGRESSIVE plans) swaps hard sessions for strides.
  function buildWeeks(p, totalWeeks, reduced) {
    const T = planTargets(p);
    const taperWeeks = TAPER_WEEKS[p.goalType];
    const growth = weeklyGrowthRate(p.days, p.level);
    const longAdd = LONG_RUN_MIN_ADD_KM;
    const volumeAdd = LONG_RUN_MIN_ADD_KM / T.share;

    // FIX: growth continues from the last build week, not from a deload week.
    let baseVolume = T.startVolume;
    let baseLong = T.startLong;
    let peakVolume = T.startVolume;
    let peakLong = T.startLong;
    const weeks = [];

    for (let weekIndex = 1; weekIndex <= totalWeeks; weekIndex++) {
      const phase = assignPhase(weekIndex, totalWeeks, taperWeeks);
      const deload = isDeloadWeek(weekIndex, totalWeeks, taperWeeks);
      let volume;
      let long;

      if (phase === 'taper') {
        const taperWeek = weekIndex - (totalWeeks - taperWeeks);
        volume = taperVolume(peakVolume, taperWeek, taperWeeks);
        long = peakLong * taperVolume(1, taperWeek, taperWeeks);
      } else if (deload) {
        volume = baseVolume * 0.75;
        long = baseLong * 0.75;
      } else {
        // Section 7 and 8: grow at the maximum allowed rate every build week until the peak.
        volume = Math.min(baseVolume + Math.max(baseVolume * growth, volumeAdd), T.targetVolume);
        long = Math.min(baseLong + Math.max(baseLong * 0.08, longAdd), volume * T.share, T.targetLong);
        long = Math.max(long, Math.min(baseLong, T.targetLong)); // a build week never shortens the long run
        baseVolume = volume;
        baseLong = long;
        peakVolume = Math.max(peakVolume, volume);
        peakLong = Math.max(peakLong, long);
      }

      const runs = distributeWeeklyVolume(volume, long, T.runTypes);
      const sessions = runs.map(run => {
        let workout = run.type;
        if (run.type === 'quality') {
          workout = phase === 'taper' ? 'light_sharpening'
            : reduced ? 'strides_or_hills'
              : qualityWorkoutForPhase(phase, p.goalType);
        }
        return sessionFor(run, workout);
      });
      const planned = sessions.reduce((sum, s) => sum + s.distance, 0);

      weeks.push({
        weekNumber: weekIndex,
        phase,
        deload,
        targetVolume: round1(planned), // the sessions' sum, so the chart and rows agree
        longRunKm: sessions.find(s => s.type === 'long').distance,
        sessions
      });
    }

    return { weeks, targets: T };
  }

  function sessionFor(run, workout) {
    const base = { distance: run.distanceKm, status: 'planned', workout };
    if (run.type === 'long') return { ...base, name: 'Long run', type: 'long' };
    if (run.type === 'mediumLong') return { ...base, name: 'Medium-long run', type: 'medium' };
    if (run.type === 'quality') return { ...base, name: QUALITY_NAMES[workout], type: 'quality' };
    return { ...base, name: 'Easy run', type: 'easy' };
  }

  // Section 13, applied to a finished plan. FIX: a build week is compared with the last
  // build week (not a deload week), and a rise of no more than the kilometre floor is
  // never called aggressive, because 2 km on a 7 km week is 29% but a few minutes of running.
  function validatePlan(weeks, share) {
    const longFloor = LONG_RUN_MIN_ADD_KM;
    const volumeFloor = LONG_RUN_MIN_ADD_KM / share;
    let last = null;
    return weeks.map(week => {
      const warnings = [];
      const share = week.longRunKm / week.targetVolume;
      if (week.phase !== 'taper' && !week.deload && last) {
        const volumeRise = week.targetVolume - last.targetVolume;
        const longRise = week.longRunKm - last.longRunKm;
        // 0.5 km of slack: sessions are rounded to 0.5 km, so a true 8% rise can read as 11%.
        if (volumeRise > Math.max(last.targetVolume * 0.12 + 0.5, volumeFloor + 0.5)) warnings.push('Weekly volume increase is aggressive.');
        if (longRise > Math.max(last.longRunKm * 0.10 + 0.5, longFloor + 0.5)) warnings.push('Long run increase is aggressive.');
      }
      if (share > 0.5 && week.targetVolume > 2 * MIN_RUN_KM + 1) warnings.push('Long run is too large a share of weekly volume.');
      if (week.phase !== 'taper' && !week.deload) last = week;
      return { ...week, warnings };
    });
  }

  // Section 5. FIX: the document's version shrank the long run at every deload (it was
  // multiplied by 0.75 and then grown from that), and returned 0 for a 0 km start.
  function estimateSafeGoalDistance(startingKm, weeks, days) {
    const rate = days <= 3 ? 0.08 : 0.10;
    let baseLong = Math.max(startingKm, MIN_START_LONG_RUN_KM);
    for (let week = 1; week <= weeks; week++) {
      if (week % 4 === 0) continue; // a deload week: the build carries on from where it was
      baseLong += Math.max(baseLong * rate, LONG_RUN_MIN_ADD_KM);
    }
    return baseLong / 0.9;
  }

  // ------------------------------------------------------------- verdicts

  function makePlan(p, weeks, built, status, warnings) {
    const volumes = built.weeks.map(w => w.targetVolume);
    return {
      algorithm: 'plan-algorithm-v1',
      goalDistance: p.goalKm,
      goalType: p.goalType,
      raceDate: p.raceDate,
      runsPerWeek: p.days,
      startingDistanceKm: p.startKm,
      experience: p.level,
      createdAt: new Date().toISOString(),
      totalWeeks: weeks,
      status,
      warnings,
      weeks: validatePlan(built.weeks, built.targets.share),
      summary: {
        startVolume: volumes[0],
        peakVolume: Math.max(...volumes),
        peakLong: Math.max(...built.weeks.map(w => w.longRunKm)),
        targetLong: round1(built.targets.attainableLong)
      }
    };
  }

  // Smallest length (weeks) at which the plan reaches OK_REACH of the long run it aims for.
  function weeksNeeded(p, minimumWeeks) {
    for (let weeks = Math.max(4, minimumWeeks); weeks <= MAX_PLAN_WEEKS; weeks++) {
      const built = buildWeeks(p, weeks, false);
      if (Math.max(...built.weeks.map(w => w.longRunKm)) >= built.targets.attainableLong * OK_REACH) return weeks;
    }
    return Infinity;
  }

  function addWeeks(date, weeks) {
    const d = parseLocalDate(date);
    d.setDate(d.getDate() + weeks * 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // The races (shorter than the goal) this runner could prepare for in the time they have.
  function alternativesFor(p) {
    return GOAL_TYPES.filter(([km]) => km < p.goalKm).reverse().map(([km]) => {
      const verdict = design({
        goalDistance: km, raceDate: p.raceDate, startDate: p.startDate, trainingDays: p.days,
        startingDistance: p.startKm, experience: p.level, alternatives: false
      });
      return { goalKm: km, label: raceName(km), status: verdict.status };
    }).filter(a => a.status !== 'TOO_SHORT');
  }

  function design(input) {
    const p = normalize(input);
    const race = raceName(p.goalKm);
    const availableWeeks = weeksBetween(p.startDate, p.raceDate);
    const minimumWeeks = adjustedMinimumWeeks(p.goalKm, p.startKm, MIN_WEEKS[p.goalType]);
    const T = planTargets(p);
    const result = { availableWeeks, minimumWeeks, goalKm: p.goalKm, goalType: p.goalType, level: p.level, plan: null, warnings: [] };

    const tooShort = () => {
      const needed = weeksNeeded(p, minimumWeeks);
      return {
        ...result,
        status: 'TOO_SHORT',
        neededWeeks: needed,
        suggestedDate: Number.isFinite(needed) ? addWeeks(p.startDate, needed) : null,
        recommendation: 'Use a maintenance or completion-focused plan, reduce the goal, or move the target date.',
        safestGoalKm: round1(estimateSafeGoalDistance(p.startKm, Math.max(0, availableWeeks), p.days)),
        alternatives: input.alternatives === false ? [] : alternativesFor(p),
        warnings: [Number.isFinite(needed)
          ? `${Math.max(0, availableWeeks)} weeks isn't enough to prepare safely for a ${race} when your longest run is ${round1(p.startKm)} km — we'd want about ${needed}.`
          : `A ${race} is a big step when your longest run is ${round1(p.startKm)} km — a shorter race first is the safer route.`]
      };
    };

    if (availableWeeks < 4 || availableWeeks < Math.ceil(minimumWeeks * TOO_SHORT_SHARE)) return tooShort();

    let built = buildWeeks(p, availableWeeks, false);
    const reach = Math.max(...built.weeks.map(w => w.longRunKm)) / T.attainableLong;
    if (reach < TOO_SHORT_REACH) return tooShort();

    let status = 'OK';
    const warnings = [];
    if (availableWeeks < minimumWeeks || reach < OK_REACH) {
      status = 'AGGRESSIVE';
      built = buildWeeks(p, availableWeeks, true); // conservative: no hard sessions
      const needed = weeksNeeded(p, minimumWeeks);
      const peakLong = Math.max(...built.weeks.map(w => w.longRunKm));
      warnings.push(Number.isFinite(needed)
        ? `${availableWeeks} weeks is tight for a ${race} when your longest run is ${round1(p.startKm)} km — we'd suggest ${needed} or more.`
        : `A ${race} is a big step when your longest run is ${round1(p.startKm)} km — a shorter race first is the safer route.`);
      if (reach < OK_REACH) {
        warnings.push(`In ${availableWeeks} weeks the longest run only builds to ${round1(peakLong)} km, short of the ~${round1(T.attainableLong)} km a ${race} plan usually reaches.`);
      }
      warnings.push('To keep it safe, this plan has no tempo or interval sessions — just easy running and strides.');
      result.neededWeeks = needed;
    }

    const plan = makePlan(p, availableWeeks, built, status, warnings);
    return { ...result, status, warnings, plan, summary: plan.summary, reach };
  }

  // Convenience for callers that only want the plan (null when it would not be generated).
  function generate(input) {
    return design(input).plan;
  }

  // Re-derive the plan's remaining weeks after a missed or completed session, without
  // discarding history. Called from PlanStats when a long run is missed.
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

  return {
    LEVELS, DEFAULT_LEVEL, QUALITY_NAMES, MIN_WEEKS, LONG_RUN_MIN_ADD_KM,
    design, generate, levelOf, suggestLevel, weeksBetween, raceName, goalTypeFor, adjustForMiss,
    // exposed for tests
    _parts: { adjustedMinimumWeeks, assignPhase, isDeloadWeek, taperVolume, runTypesForDays, weeklyGrowthRate, longRunShare, targetPeakLongRun, targetPeakWeeklyVolume, estimateSafeGoalDistance, validatePlan, buildWeeks, normalize }
  };
})();
