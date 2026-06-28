import { BALANCE } from '../config/balance';
import { UPGRADE_OUTPUT } from './actions';
import { conditionRegenMult, globalBonus, millThroughputMult } from './loot';
import { adultLayers, AXES, INGREDIENTS, type Axis, type GameState, type Ingredient } from './state';

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
  // Phase 4a: the LAYER ration feeds the laying hens that actually earn — NOT
  // the whole adult flock. A seeded/bred drake eats no layer feed (it's breeding
  // stock); ducklings have their own grow-out ration. Driving demand off every
  // adult (incl. the seeded drake) tripled cold-start demand and starved even
  // the energy axis the starter plot covers — so demand scales with hens.
  const layers = adultLayers(state);
  const layerCount = layers.length;
  if (layerCount === 0) {
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
    wantRate[ing] = ((state.ration[ing] ?? 0) * layerCount) / coopCycle;
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

  // Phase 4b: free-range forage is pure-ENERGY feed (zone signature), auto-eaten
  // from shared storage to fill ONLY the flock's energy gap — never protein /
  // niacin / calcium. It's non-scaling at the source, so it's self-diminishing
  // as the flock grows; excess stays banked. The throttle / satisfaction /
  // condition math below is unchanged — it just sees more energy supplied. (When
  // no forage is stocked this is a no-op, so the Phase 2 math is byte-for-byte.)
  const energyReqRate = (N.REQUIREMENT.energy * layerCount) / coopCycle;
  const forageEat = Math.min(Math.max(0, energyReqRate - supply.energy) * step, state.resources.forage);
  let forageEnergy = 0; // energy/s the forage actually supplied this step (for the dashboard)
  if (forageEat > 0) {
    state.resources.forage -= forageEat;
    forageEnergy = step > 0 ? forageEat / step : 0;
    supply.energy += forageEnergy;
  }

  // Requirement (rate) + satisfaction. The instantaneous ratio is noisy (chunky
  // production vs continuous eating), so smooth it with an EMA — the bars and
  // throttle then read steady and only move when a line genuinely can't keep up.
  const requirement = zeroAxes();
  const satisfaction = zeroAxes();
  const prior = state.nutrition?.satisfaction;
  const alpha = N.SMOOTH_TAU_S > 0 ? Math.min(1, step / N.SMOOTH_TAU_S) : 1;
  for (const axis of AXES) {
    requirement[axis] = (N.REQUIREMENT[axis] * layerCount) / coopCycle;
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

  state.nutrition = { satisfaction, supply, requirement, eggMultRaw, eggMult, feedScale, hasMill, forageEnergy };

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

  layNutritionTail(state, willHaul, coops, eggMult, layers, coopCycle, step);
}

// Split out so runDucklingNutrition can sit beside the layer logic below.
function layNutritionTail(
  state: GameState,
  willHaul: boolean,
  coops: GameState['stations'],
  eggMult: number,
  layers: ReturnType<typeof adultLayers>,
  coopCycle: number,
  step: number,
): void {
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

/** Axes the duckling grow-out ration must cover (calcium isn't required). */
const DUCKLING_AXES: Axis[] = ['energy', 'protein', 'niacin'];

/**
 * Advance the duckling grow-out ration: immature ducks consume ingredients from
 * the SAME storage pool as the layers (so feeding the flock competes with growing
 * it). Returns a maturation-speed multiplier (1 = full, down to the penalty floor)
 * from the worst required axis. Runs online & offline; never grants XP. Uses the
 * same satisfaction math as the layer ration — a throttle, never a wall.
 */
export function runDucklingNutrition(state: GameState, dt: number, rateMult: number): number {
  const B = BALANCE.BREEDING;
  const immature = state.ducks.filter((d) => d.stage !== 'adult');
  if (immature.length === 0) {
    state.ducklingNutrition = undefined;
    return 1;
  }
  const step = dt * rateMult;
  const coopCycle = BALANCE.COOP.cycleSeconds;
  const n = immature.length;

  const supply = zeroAxes();
  for (const ing of INGREDIENTS) {
    const want = (((state.ducklingRation[ing] ?? 0) * n) / coopCycle) * step;
    const consume = Math.min(want, state.resources[ing as Ingredient]);
    if (consume > 0) state.resources[ing as Ingredient] -= consume;
    const rate = step > 0 ? consume / step : 0;
    const vals = N.INGREDIENT[ing as Ingredient] as Record<Axis, number>;
    for (const axis of AXES) supply[axis] += rate * (vals[axis] ?? 0);
  }

  const requirement = zeroAxes();
  const satisfaction = zeroAxes();
  const prior = state.ducklingNutrition?.satisfaction;
  const alpha = N.SMOOTH_TAU_S > 0 ? Math.min(1, step / N.SMOOTH_TAU_S) : 1;
  for (const axis of AXES) {
    requirement[axis] = (B.DUCKLING_REQUIREMENT[axis] * n) / coopCycle;
    const instant = requirement[axis] > 0 ? supply[axis] / requirement[axis] : 1;
    satisfaction[axis] = prior ? prior[axis] + (instant - prior[axis]) * alpha : instant;
  }

  const minSat = Math.min(...DUCKLING_AXES.map((a) => satisfaction[a]));
  const floor = B.DUCKLING_RATION_MATURE_PENALTY_FLOOR;
  const matureRate = floor + (1 - floor) * clamp01(minSat);
  state.ducklingNutrition = { satisfaction, requirement, matureRate, immatureCount: n };
  return matureRate;
}
