import { BALANCE } from '../config/balance';
import { UPGRADE_OUTPUT } from './actions';
import { conditionRegenMult, eggOutputMult, millThroughputMult } from './loot';
import { AXES, INGREDIENTS, type Axis, type GameState, type Ingredient } from './state';

const N = BALANCE.NUTRITION;
/** Axes that multiply egg output. Niacin is excluded — it drives the debuff. */
const EGG_AXES: Axis[] = ['energy', 'protein', 'calcium'];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Per-axis output factor: 1.0 at/above 100% satisfaction, down to FLOOR at 0. */
export function axisFactor(sat: number): number {
  return N.THROTTLE_FLOOR + (1 - N.THROTTLE_FLOOR) * clamp01(sat);
}

function zeroAxes(): Record<Axis, number> {
  return { energy: 0, protein: 0, niacin: 0, calcium: 0 };
}

/**
 * Advance the nutrition grid by `dt`: consume ingredients from storage per the
 * active ration (stock-limited — supply IS the stock read this tick), compute
 * per-axis satisfaction, update the flock-condition battery, and lay eggs for
 * each coop at base × throttle (buffered by condition). Mutates state and stores
 * the snapshot on state.nutrition. Never grants XP (offline-safe).
 */
export function runNutrition(state: GameState, dt: number, rateMult: number, willHaul: boolean): void {
  const coops = state.stations.filter((s) => s.type === 'coop');
  const mills = state.stations.filter((s) => s.type === 'mill');
  const effCoops = coops.reduce((a, c) => a + UPGRADE_OUTPUT(c.level), 0);
  if (effCoops === 0) {
    state.nutrition = undefined;
    return;
  }
  const hasMill = mills.length > 0;
  const coopCycle = BALANCE.COOP.cycleSeconds;
  const step = dt * rateMult;

  // Desired ingredient draw (units/sec), capped by total mill capacity.
  // Mill blend capacity (a throughput cap — NOT a nutrition requirement); speed
  // and yield modules raise it. The requirement/matrix/satisfaction math below
  // is untouched by modules.
  const capacity =
    mills.reduce((a, m) => a + UPGRADE_OUTPUT(m.level) * millThroughputMult(m), 0) * N.MILL_CAPACITY;
  const wantRate: Record<string, number> = {};
  let totalWant = 0;
  for (const ing of INGREDIENTS) {
    wantRate[ing] = ((state.ration[ing] ?? 0) * effCoops) / coopCycle;
    totalWant += wantRate[ing];
  }
  const feedScale = hasMill ? (totalWant > 0 ? Math.min(1, capacity / totalWant) : 1) : 0;

  // Consume from storage; per-axis supply is what we could actually draw.
  const supply = zeroAxes();
  for (const ing of INGREDIENTS) {
    const want = wantRate[ing] * feedScale * step;
    const consume = Math.min(want, state.resources[ing as Ingredient]);
    if (consume > 0) state.resources[ing as Ingredient] -= consume;
    const rate = step > 0 ? consume / step : 0;
    const vals = N.INGREDIENT[ing as Ingredient] as Record<Axis, number>;
    for (const axis of AXES) supply[axis] += rate * (vals[axis] ?? 0);
  }

  // Requirement (rate) + satisfaction. The instantaneous ratio is noisy (chunky
  // production vs continuous eating), so smooth it with an EMA — the bars and
  // throttle then read steady and only move when a line genuinely can't keep up.
  const requirement = zeroAxes();
  const satisfaction = zeroAxes();
  const prior = state.nutrition?.satisfaction;
  const alpha = N.SMOOTH_TAU_S > 0 ? Math.min(1, step / N.SMOOTH_TAU_S) : 1;
  for (const axis of AXES) {
    requirement[axis] = (N.REQUIREMENT[axis] * effCoops) / coopCycle;
    const instant = requirement[axis] > 0 ? supply[axis] / requirement[axis] : 1;
    satisfaction[axis] = prior ? prior[axis] + (instant - prior[axis]) * alpha : instant;
  }

  // Flock condition (battery): rises when the egg axes are all satisfied,
  // drains (severity-scaled) when short. Buffers the throttle so brief dips
  // don't strobe egg output.
  const minEggSat = Math.min(...EGG_AXES.map((a) => satisfaction[a]));
  if (hasMill && minEggSat >= 1) {
    const rise = N.CONDITION_RISE_PER_S * conditionRegenMult(state); // module-boosted regen
    state.condition = Math.min(N.CONDITION_MAX, state.condition + rise * step);
  } else {
    const severity = clamp01(1 - minEggSat);
    state.condition = Math.max(0, state.condition - N.CONDITION_DRAIN_PER_S * severity * step);
  }
  const cond = state.condition / N.CONDITION_MAX;

  const eggMultRaw = Math.max(
    N.MIN_EGG_MULT,
    hasMill
      ? axisFactor(satisfaction.energy) * axisFactor(satisfaction.protein) * axisFactor(satisfaction.calcium)
      : 0,
  );
  // Condition buffers: full condition masks the penalty; empty applies it fully.
  const eggMult = eggMultRaw + (1 - eggMultRaw) * cond;

  state.nutrition = { satisfaction, supply, requirement, eggMultRaw, eggMult, feedScale, hasMill };

  // Niacin debuff: sustained shortfall accrues a timer; each time it crosses the
  // onset threshold, one healthy coop's duck gets a leg debuff (halves output).
  // Accrual happens offline too (idle leaves you exposed); only the Dose
  // intervention that clears it is active-only.
  if (satisfaction.niacin < N.NIACIN_DEBUFF_THRESHOLD && cond < N.NIACIN_DEBUFF_CONDITION_GATE) {
    state.niacinShortfall += step;
    while (state.niacinShortfall >= N.NIACIN_DEBUFF_ONSET_S) {
      state.niacinShortfall -= N.NIACIN_DEBUFF_ONSET_S;
      const healthy = coops.find((c) => !c.debuffed);
      if (healthy) healthy.debuffed = true;
      else break; // whole flock already debuffed
    }
  } else {
    state.niacinShortfall = Math.max(0, state.niacinShortfall - step);
  }

  // Lay eggs per coop at base × eggMult (× debuff penalty for limping ducks).
  for (const coop of coops) {
    coop.cycleProgress += step;
    let guard = 100000;
    while (coop.cycleProgress >= coopCycle && guard-- > 0) {
      coop.cycleProgress -= coopCycle;
      const debuff = coop.debuffed ? N.DEBUFF_COOP_OUTPUT_MULT : 1;
      // eggOutput modules multiply the lay; the nutrition eggMult (f(axis) terms)
      // is unchanged — modules boost output, never the satisfaction math.
      coop.buffer.eggs =
        (coop.buffer.eggs ?? 0) +
        BALANCE.COOP.eggPerCycle * UPGRADE_OUTPUT(coop.level) * eggMult * debuff * eggOutputMult(coop);
      if (willHaul) {
        state.resources.eggs += coop.buffer.eggs ?? 0;
        coop.buffer = {};
      }
    }
  }
}
