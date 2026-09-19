# Running Plan Scaling Algorithm

## 1. Inputs

```ts
type GoalType = "5K" | "10K" | "HALF_MARATHON" | "MARATHON" | "ULTRA";

type PlanInput = {
  startDate: Date;
  targetDate: Date;
  startingDistanceKm: number;      // Current comfortable long-run or max recent run
  goalType: GoalType;
  goalDistanceKm?: number;         // Required for ultra, optional override otherwise
  trainingDaysPerWeek: number;     // Usually 2-7
  experienceLevel?: "beginner" | "intermediate" | "advanced";
};
```

## 2. Goal Distances

```ts
const GOAL_DISTANCE_KM = {
  "5K": 5,
  "10K": 10,
  "HALF_MARATHON": 21.1,
  "MARATHON": 42.2,
  "ULTRA": input.goalDistanceKm ?? 50
};
```

## 3. Minimum Recommended Training Durations

These are minimums for a reasonably safe structured plan, assuming the runner is already capable of some running.

```ts
const MIN_WEEKS = {
  "5K": 6,
  "10K": 8,
  "HALF_MARATHON": 12,
  "MARATHON": 16,
  "ULTRA": 20
};
```

Adjust minimums based on starting distance:

```ts
function adjustedMinimumWeeks(goalKm, startingKm, baseMinWeeks) {
  const readinessRatio = startingKm / goalKm;

  if (readinessRatio >= 0.75) return Math.max(4, baseMinWeeks - 4);
  if (readinessRatio >= 0.50) return Math.max(6, baseMinWeeks - 2);
  if (readinessRatio >= 0.25) return baseMinWeeks;
  return baseMinWeeks + 4;
}
```

## 4. Available Weeks

```ts
function weeksBetween(startDate, targetDate) {
  const msPerWeek = 1000 * 60 * 60 * 24 * 7;
  return Math.floor((targetDate.getTime() - startDate.getTime()) / msPerWeek);
}
```

```ts
const availableWeeks = weeksBetween(input.startDate, input.targetDate);
const minimumWeeks = adjustedMinimumWeeks(goalKm, startingKm, MIN_WEEKS[goalType]);
```

## 5. Short-Timeline Handling

If available weeks are too short, the app should not simply compress the plan aggressively.

```ts
if (availableWeeks < minimumWeeks) {
  return {
    status: "TOO_SHORT",
    availableWeeks,
    minimumWeeks,
    recommendation: "Use a maintenance or completion-focused plan, reduce the goal, or move the target date.",
    safestGoalKm: estimateSafeGoalDistance(startingKm, availableWeeks, trainingDaysPerWeek)
  };
}
```

A safe estimated goal can be calculated using conservative long-run growth:

```ts
function estimateSafeGoalDistance(startingKm, weeks, daysPerWeek) {
  const weeklyGrowthRate = daysPerWeek <= 3 ? 0.08 : 0.10;
  const deloadFrequency = 4;

  let longRun = startingKm;

  for (let week = 1; week <= weeks; week++) {
    const isDeload = week % deloadFrequency === 0;

    if (isDeload) {
      longRun *= 0.75;
    } else {
      longRun *= 1 + weeklyGrowthRate;
    }
  }

  return longRun / 0.9; // long run should be about 70-90% of race distance depending on goal
}
```

## 6. Training Phases

Divide the plan into phases.

```ts
type Phase = "BASE" | "BUILD" | "PEAK" | "TAPER";
```

Suggested phase distribution:

```ts
function assignPhase(weekIndex, totalWeeks, taperWeeks) {
  const progress = weekIndex / totalWeeks;
  const taperStart = totalWeeks - taperWeeks + 1;

  if (weekIndex >= taperStart) return "TAPER";
  if (progress < 0.35) return "BASE";
  if (progress < 0.75) return "BUILD";
  return "PEAK";
}
```

Taper length:

```ts
function taperWeeksForGoal(goalType) {
  switch (goalType) {
    case "5K": return 1;
    case "10K": return 1;
    case "HALF_MARATHON": return 2;
    case "MARATHON": return 3;
    case "ULTRA": return 3;
  }
}
```

## 7. Weekly Volume Progression

Estimate starting weekly volume from current long-run ability and training days.

```ts
function estimateStartingWeeklyVolume(startingKm, trainingDaysPerWeek) {
  const longRunShare = trainingDaysPerWeek <= 3 ? 0.45 : 0.35;
  return startingKm / longRunShare;
}
```

Peak weekly volume targets:

```ts
function targetPeakWeeklyVolume(goalKm, goalType, trainingDaysPerWeek) {
  const multiplierByGoal = {
    "5K": 3.0,
    "10K": 3.2,
    "HALF_MARATHON": 2.5,
    "MARATHON": 2.0,
    "ULTRA": 1.6
  };

  const daysFactor = Math.min(1.2, Math.max(0.75, trainingDaysPerWeek / 5));

  return goalKm * multiplierByGoal[goalType] * daysFactor;
}
```

Weekly volume growth:

```ts
function weeklyGrowthRate(trainingDaysPerWeek, experienceLevel = "beginner") {
  let base = trainingDaysPerWeek <= 3 ? 0.07 : 0.10;

  if (experienceLevel === "beginner") base -= 0.02;
  if (experienceLevel === "advanced") base += 0.02;

  return Math.max(0.05, Math.min(base, 0.12));
}
```

Deload weeks:

```ts
function isDeloadWeek(weekIndex, totalWeeks, taperWeeks) {
  const beforeTaper = weekIndex <= totalWeeks - taperWeeks;
  return beforeTaper && weekIndex % 4 === 0;
}
```

Volume formula:

```ts
function calculateWeeklyVolume(previousVolume, targetPeakVolume, phase, isDeload, growthRate) {
  if (phase === "TAPER") return previousVolume;

  if (isDeload) {
    return previousVolume * 0.75;
  }

  return Math.min(previousVolume * (1 + growthRate), targetPeakVolume);
}
```

## 8. Long-Run Progression

The long run should grow more slowly than total weekly volume and should deload regularly.

Target peak long run:

```ts
function targetPeakLongRun(goalKm, goalType) {
  switch (goalType) {
    case "5K": return Math.min(goalKm, 6);
    case "10K": return Math.min(goalKm * 1.1, 12);
    case "HALF_MARATHON": return goalKm * 0.85;
    case "MARATHON": return 32;
    case "ULTRA": return goalKm * 0.45;
  }
}
```

Long-run share of weekly volume:

```ts
function longRunShare(trainingDaysPerWeek) {
  if (trainingDaysPerWeek <= 3) return 0.45;
  if (trainingDaysPerWeek === 4) return 0.38;
  if (trainingDaysPerWeek === 5) return 0.34;
  return 0.30;
}
```

Long-run calculation:

```ts
function calculateLongRun({
  previousLongRun,
  weeklyVolume,
  targetPeakLongRun,
  trainingDaysPerWeek,
  isDeload,
  phase
}) {
  if (phase === "TAPER") return previousLongRun;

  if (isDeload) {
    return previousLongRun * 0.75;
  }

  const maxByVolume = weeklyVolume * longRunShare(trainingDaysPerWeek);
  const grownLongRun = previousLongRun * 1.08;

  return Math.min(grownLongRun, maxByVolume, targetPeakLongRun);
}
```

## 9. Taper Logic

During taper, reduce volume while keeping some intensity.

```ts
function taperVolume(peakVolume, taperWeekNumber, totalTaperWeeks) {
  if (totalTaperWeeks === 1) {
    return peakVolume * 0.60;
  }

  if (totalTaperWeeks === 2) {
    return taperWeekNumber === 1
      ? peakVolume * 0.70
      : peakVolume * 0.45;
  }

  if (totalTaperWeeks === 3) {
    if (taperWeekNumber === 1) return peakVolume * 0.75;
    if (taperWeekNumber === 2) return peakVolume * 0.55;
    return peakVolume * 0.35;
  }
}
```

Taper long run:

```ts
function taperLongRun(peakLongRun, taperWeekNumber, totalTaperWeeks) {
  const volumeRatio = taperVolume(1, taperWeekNumber, totalTaperWeeks);
  return peakLongRun * volumeRatio;
}
```

## 10. Distributing Runs Across Training Days

Use the number of available training days to determine run types.

```ts
function runTypesForDays(days) {
  if (days <= 2) {
    return ["easy", "long"];
  }

  if (days === 3) {
    return ["easy", "quality", "long"];
  }

  if (days === 4) {
    return ["easy", "quality", "easy", "long"];
  }

  if (days === 5) {
    return ["easy", "quality", "easy", "easy", "long"];
  }

  return ["easy", "quality", "easy", "mediumLong", "easy", "long"];
}
```

Weekly distance allocation:

```ts
function distributeWeeklyVolume(weeklyVolume, longRunKm, runTypes) {
  const remainingVolume = weeklyVolume - longRunKm;
  const runs = [];

  for (const type of runTypes) {
    if (type === "long") {
      runs.push({ type, distanceKm: longRunKm });
    }
  }

  const nonLongRuns = runTypes.filter(type => type !== "long");

  for (const type of nonLongRuns) {
    let share;

    if (type === "mediumLong") share = 0.30;
    else if (type === "quality") share = 0.25;
    else share = 1 / nonLongRuns.length;

    runs.push({
      type,
      distanceKm: remainingVolume * share
    });
  }

  return normalizeRunDistances(runs, weeklyVolume);
}
```

## 11. Quality Workouts

Quality workouts should depend on phase and goal.

```ts
function qualityWorkoutForPhase(phase, goalType) {
  if (phase === "BASE") {
    return "strides_or_hills";
  }

  if (phase === "BUILD") {
    if (goalType === "5K" || goalType === "10K") return "intervals";
    return "tempo";
  }

  if (phase === "PEAK") {
    if (goalType === "MARATHON" || goalType === "ULTRA") return "goal_pace_blocks";
    return "race_specific_intervals";
  }

  return "light_sharpening";
}
```

## 12. Full Plan Generation Pseudocode

```ts
function generateRunningPlan(input: PlanInput) {
  const goalKm = getGoalDistance(input);
  const availableWeeks = weeksBetween(input.startDate, input.targetDate);
  const baseMinimumWeeks = MIN_WEEKS[input.goalType];

  const minimumWeeks = adjustedMinimumWeeks(
    goalKm,
    input.startingDistanceKm,
    baseMinimumWeeks
  );

  if (availableWeeks < minimumWeeks) {
    return {
      status: "TOO_SHORT",
      availableWeeks,
      minimumWeeks,
      recommendation: buildShortTimelineRecommendation(input),
      saferGoalKm: estimateSafeGoalDistance(
        input.startingDistanceKm,
        availableWeeks,
        input.trainingDaysPerWeek
      )
    };
  }

  const taperWeeks = taperWeeksForGoal(input.goalType);
  const growthRate = weeklyGrowthRate(
    input.trainingDaysPerWeek,
    input.experienceLevel
  );

  const startingVolume = estimateStartingWeeklyVolume(
    input.startingDistanceKm,
    input.trainingDaysPerWeek
  );

  const targetPeakVolume = targetPeakWeeklyVolume(
    goalKm,
    input.goalType,
    input.trainingDaysPerWeek
  );

  const peakLongRunTarget = targetPeakLongRun(goalKm, input.goalType);

  let previousVolume = startingVolume;
  let previousLongRun = input.startingDistanceKm;
  let peakVolume = startingVolume;
  let peakLongRun = input.startingDistanceKm;

  const weeks = [];

  for (let weekIndex = 1; weekIndex <= availableWeeks; weekIndex++) {
    const phase = assignPhase(weekIndex, availableWeeks, taperWeeks);
    const deload = isDeloadWeek(weekIndex, availableWeeks, taperWeeks);

    let weeklyVolume;
    let longRunKm;

    if (phase === "TAPER") {
      const taperWeekNumber = weekIndex - (availableWeeks - taperWeeks);

      weeklyVolume = taperVolume(
        peakVolume,
        taperWeekNumber,
        taperWeeks
      );

      longRunKm = taperLongRun(
        peakLongRun,
        taperWeekNumber,
        taperWeeks
      );
    } else {
      weeklyVolume = calculateWeeklyVolume(
        previousVolume,
        targetPeakVolume,
        phase,
        deload,
        growthRate
      );

      longRunKm = calculateLongRun({
        previousLongRun,
        weeklyVolume,
        targetPeakLongRun: peakLongRunTarget,
        trainingDaysPerWeek: input.trainingDaysPerWeek,
        isDeload: deload,
        phase
      });

      peakVolume = Math.max(peakVolume, weeklyVolume);
      peakLongRun = Math.max(peakLongRun, longRunKm);
    }

    const runTypes = runTypesForDays(input.trainingDaysPerWeek);
    const runs = distributeWeeklyVolume(weeklyVolume, longRunKm, runTypes);

    weeks.push({
      week: weekIndex,
      phase,
      deload,
      weeklyVolumeKm: round(weeklyVolume),
      longRunKm: round(longRunKm),
      runs: runs.map(run => ({
        ...run,
        workout: run.type === "quality"
          ? qualityWorkoutForPhase(phase, input.goalType)
          : run.type
      }))
    });

    previousVolume = weeklyVolume;
    previousLongRun = longRunKm;
  }

  return {
    status: "OK",
    goalKm,
    availableWeeks,
    minimumWeeks,
    weeks
  };
}
```

## 13. Safety Rules

Apply these as final validation after generating the plan.

```ts
function validatePlan(plan) {
  return plan.weeks.map((week, index, weeks) => {
    const previous = weeks[index - 1];

    if (!previous) return week;

    const volumeIncrease =
      (week.weeklyVolumeKm - previous.weeklyVolumeKm) / previous.weeklyVolumeKm;

    const longRunIncrease =
      (week.longRunKm - previous.longRunKm) / previous.longRunKm;

    return {
      ...week,
      warnings: [
        volumeIncrease > 0.12 ? "Weekly volume increase is aggressive." : null,
        longRunIncrease > 0.10 ? "Long run increase is aggressive." : null,
        week.longRunKm > week.weeklyVolumeKm * 0.5
          ? "Long run is too large a share of weekly volume."
          : null
      ].filter(Boolean)
    };
  });
}
```

## 14. Recommended App Behavior

If the plan is valid:

```ts
status: "OK"
```

Generate the plan normally.

If the timeline is short but close:

```ts
status: "AGGRESSIVE"
```

Generate a conservative plan with warnings, reduced intensity, and capped growth.

If the timeline is clearly too short:

```ts
status: "TOO_SHORT"
```

Do not generate a race-preparation plan. Instead suggest:

- move the target date
- reduce the goal distance
- use a maintenance plan
- use a run-walk completion plan
- consult a coach or clinician if injury risk is high

## 15. Core Principles

The algorithm should prioritize:

1. Consistency over intensity.
2. Long-run progression without sudden jumps.
3. Deload weeks every 4th week.
4. A taper before the target date.
5. Goal-specific peak long runs.
6. Conservative handling when the available timeline is too short.
7. Training-day-aware distribution of weekly volume.
---

# Implementation notes: where the code differs from this document

Everything above is implemented in `js/planGenerator.js` (each part is commented with its section
number), and this document is unchanged. The differences below are the only places the code departs from
it. Each is marked `FIX` in the source. All of them exist because the algorithm, run exactly as written,
does not produce a working plan.

**What "run exactly as written" produced** (transcribed line for line; only the undefined
`normalizeRunDistances` was filled in):

| Scenario | Result as written |
|---|---|
| Half marathon, 32 weeks, 3 days, beginner, start 0 km | Every week is 0 km (a percentage of zero is zero) |
| Same, start 3 km | Long run 3.2 → peak 3.5 km, then shrinks to **1.2 km** |
| Half marathon, 32 weeks, 4 days, intermediate, start 8 km | Long run 8.6 → peak 10.1 km, then falls to **5.8 km** |
| Marathon, 32 weeks, 5 days, advanced, start 12 km | Peak long run **15 km** (target 32) |
| 50K ultra, 40 weeks, 5 days, intermediate, start 15 km | Peak long run 18.7 km (its own target is 22.5, a marathon's is 32) |

## Changes requested by the owner

These are the only places the code follows an instruction rather than the document.

1. **Long-run targets (section 8).** For the **5K, 10K and half marathon** the peak long run is the race
   distance: 5, 10 and 21.1 km (the document had 5, 11 and 17.9 km). The **marathon (32 km) and ultras
   (goal x 0.45) are the document's**, unchanged.
2. **Weekly peak for those three races (section 7).** The long run is capped at its share of the weekly
   volume (section 8), and the document's half-marathon weekly peak on 3 days (39.6 km) only carries
   a 17.8 km long run. So for the 5K, 10K and half marathon the weekly peak is at least the long-run target divided
   by the share (half marathon: 46.9 km on 2-3 days, 55.5 on 4, 62.1 on 5, 70.3 on 6+). The marathon and
   ultra weekly peaks are the document's, so a 4-day marathon plan still tops out at a 25.6 km long run.
3. **Growth follows the document's rule** (maximum rate every build week until the target, then hold), not a
   spread-out schedule. Every level keeps the document's quality sessions.
4. **The growth floor comes from the milestone table** the owner supplied for a beginner half marathon
   (long run 3 km in week 3, 7 km in week 8, 13 km in week 13, 17 km in week 16): about **1 km more per build
   week**. See fix 2 below.

## The fixes

1. **Deload weeks (sections 5, 7, 8, 12).** A deload week is 75% of the previous week, and the following
   week grows from *that*, so every 4-week cycle multiplies the plan by roughly 0.92 to 0.95 and it
   shrinks. The code keeps the last **build** week's volume and long run, computes a deload week as 75% of
   those, and resumes growth from them. `estimateSafeGoalDistance` had the same bug and is fixed the same way.
2. **A kilometre floor on growth (sections 7, 8).** Growth is a percentage, so a small or zero starting
   distance never grows. The long run now grows by at least `LONG_RUN_MIN_ADD_KM` (1 km) per build week,
   and weekly volume by that divided by the long-run share. A plan never starts with a long run below
   1 km (week 1 is about 2 km) or with any run below 2 km. The document's percentage growth takes over
   once the distance is large enough.
3. **Starting weekly volume (section 7).** `estimateStartingWeeklyVolume` uses 0.45 for 3 or fewer days
   and 0.35 for everything else, while the long-run cap uses 0.38 / 0.34 / 0.30 for 4 / 5 / 6+ days. That
   made a 6-day plan's first long run exceed its cap. The start now uses the same share as the cap, and
   is raised to fit the minimum run length.
4. **`normalizeRunDistances` (section 10) was not defined.** The shares (medium-long 0.30, quality 0.25, easy
   1 / number of other runs) do not add to 1, so they are scaled to fill the week. Runs are rounded to 0.5 km,
   are at least 2 km, and the rounding difference is added to the longest short run so a week adds up
   exactly to its planned volume.
5. **The safety validator (section 13).** It compared each week with the previous week, so the week after a
   deload always read as a 33% jump. It now compares with the last build week, skips deload and taper
   weeks, gives 0.5 km of slack for rounding, and does not call a rise of no more than the growth floor aggressive.
6. **Timeline verdicts (sections 5 and 14).** Section 14 says "short but close" without defining it, and
   the minimum weeks in section 3 can disagree with what the growth can deliver. So:
   - **TOO_SHORT** (no plan is built): fewer than 4 weeks, or fewer than 75% of the minimum weeks, or the
     plan cannot get even halfway to its long-run target.
   - **AGGRESSIVE** (a conservative plan is built): fewer than the minimum weeks, or the plan reaches under
     85% of its long-run target. Hard sessions are replaced with strides ("reduced intensity"), and the
     app says how many weeks would be comfortable.
   - **OK** otherwise.

   "Its long-run target" is `min(target peak long run, target peak weekly volume x long-run share)`.
7. **Small things.** Start values are limited to the targets. Weeks between two dates are counted from
   whole days, so a daylight-saving change cannot lose a week. The plan is the length of the time available.

## What was deliberately not changed

- The deload week every 4th week. The milestone table has none, so from a 0 km start the long run reaches
  21 km in week 25 of a plan with deloads, not week 18 (32 weeks is comfortable; 18 is not enough).
- All the constants in sections 3 to 11 other than the ones above, the taper tables, the phase split, the
  run types, the marathon and ultra long-run targets and every level's quality sessions.
- Peak weekly volume targets for the marathon and ultras, including the very large ones (100K on 5 days is
  160 km a week). They follow from the formula and are only reachable with a very long timeline.
- (Earlier versions of the code also spread growth out so the peak landed just before the taper, and raised
  an ultra's long run to at least 32 km. Both were the implementer's own changes and were removed.)

## How the app uses it

- The plan form asks for the inputs in section 1: goal, race date, **longest run you can do comfortably
  now** (the document's `startingDistanceKm`), training days per week, and experience (beginner /
  intermediate / advanced). It no longer asks for weekly volume or a fitness level, because the document
  uses neither. 50K and 100K are `ULTRA` with `goalDistanceKm` 50 and 100.
- The starting experience level is suggested from the longest run (under 8 km beginner, 16 km or more on
  4+ days advanced, otherwise intermediate) and can be changed.
- OK builds the plan. AGGRESSIVE shows what is tight and offers "Build it anyway". TOO_SHORT builds nothing
  and offers to move the race to a date that works, or to train for a shorter race that does.
- A plan records `status`, `warnings`, `startingDistanceKm`, and for each week `deload`, `longRunKm` and
  the safety validator's `warnings`. Sessions record their `workout`.
