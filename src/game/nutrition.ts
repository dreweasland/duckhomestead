import { BALANCE } from '../config/balance';
import { UPGRADE_OUTPUT } from './actions';
import { conditionRegenMult, globalBonus, millThroughputMult } from './loot';
import { adultDucks, adultLayers, AXES, INGREDIENTS, type Axis, type GameState, type Ingredient } from './state';

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
  // Phase 4a: the layer ration now feeds ADULT DUCKS (requirement driver) and
  // ADULT HENS lay (output). The throttle / satisfaction / condition math below
  // is byte-for-byte Phase 2 — only the driver changed from coop count to heads.
  const layers = adultLayers(state);
  const adultCount = adultDucks(state).length;
  if (adultCount === 0) {
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
    wantRate[ing] = ((state.ration[ing] ?? 0) * adultCount) / coopCycle;
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
    requirement[axis] = (N.REQUIREMENT[axis] * adultCount) / coopCycle;
    const instant = requirement[axis] > 0 ? supply[axis] / requirement[axis] : 1;
    satisfaction[axis] = prior ? prior[axis] + (instant - prior[axis]) * alpha : instant;
  }

  // Flock condition (battery): relaxes toward where the flock's nutrition
  // actually sits — a target set by the worst egg axis. Below target it rises
  // (regen rate, module-boosted); above target it drains (faster the more
  // undernourished the flock). This lag IS the buffer that smooths brief dips,
  // and it avoids the old hard threshold that left a 99%-fed flock frozen
  // mid-range (could never recover without every axis strictly over 100%).
  const minEggSat = Math.min(...EGG_AXES.map((a) => satisfaction[a]));
  const target = (hasMill ? clamp01(minEggSat) : 0) * N.CONDITION_MAX;
  if (state.condition < target) {
    const rise = N.CONDITION_RISE_PER_S * conditionRegenMult(state);
    state.condition = Math.min(target, state.condition + rise * step);
  } else if (state.condition > target) {
    const severity = clamp01(1 - minEggSat);
    state.condition = Math.max(target, state.condition - N.CONDITION_DRAIN_PER_S * severity * step);
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
      const healthy = layers.find((d) => !d.debuffed); // a leg debuff hits a laying hen
      if (healthy) healthy.debuffed = true;
      else break; // whole laying flock already debuffed
    }
  } else {
    state.niacinShortfall = Math.max(0, state.niacinShortfall - step);
  }

  // Lay eggs: sum over adult hens of base × VIGOR × nutrition throttle × leg
  // debuff, then × the flock-wide eggOutput module bonus. Vigor and modules
  // multiply OUTPUT only — never the f(axis)/requirement math above.
  let flockRate = 0; // eggs per second from the whole laying flock
  for (const hen of layers) {
    const debuff = hen.debuffed ? N.DEBUFF_COOP_OUTPUT_MULT : 1;
    flockRate += (BALANCE.COOP.eggPerCycle / coopCycle) * hen.vigor * debuff;
  }
  const eggModuleMult = 1 + globalBonus(state, 'eggOutput'); // coop modules buff the flock
  const eggsThisStep = flockRate * eggMult * eggModuleMult * step;
  // Deposit into coop buffers (split evenly) so Collect / Auto-Haul / the buffer
  // chips keep working unchanged. Coops are the flock's collection points.
  if (coops.length > 0 && eggsThisStep > 0) {
    const share = eggsThisStep / coops.length;
    for (const coop of coops) {
      coop.cycleProgress = (coop.cycleProgress + step) % coopCycle; // cosmetic lay bar
      coop.buffer.eggs = (coop.buffer.eggs ?? 0) + share;
      if (willHaul) {
        state.resources.eggs += coop.buffer.eggs ?? 0;
        coop.buffer = {};
      }
    }
  }
}
