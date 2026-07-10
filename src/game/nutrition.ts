import { BALANCE } from '../config/balance';
import { UPGRADE_OUTPUT } from './actions';
import { hardinessMult, layMult } from './genetics';
import { conditionRegenMult, eggOutputMult, millThroughputMult } from './loot';
import { seasonDemandDelta } from './season';
import { waterConditionMult } from './water';
import { flockWarmth, winterSupportFactor } from './winter';
import { eggValueBoostMult } from './prestige';
import {
  adultLayers,
  AXES,
  breedingEstablished,
  INGREDIENTS,
  type Axis,
  type GameState,
  type Ingredient,
} from './state';

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

/** The condition battery's current target — mirrors runNutrition's own
 *  formula, read from the persisted post-tick snapshot. Exported for the
 *  water attribution beat (Phase 5 juice), which detects a dip-recovery edge
 *  engine-side without re-deriving nutrition math. Pure; changes nothing. */
export function conditionTarget(state: GameState): number {
  const n = state.nutrition;
  if (!n || !n.hasMill) return 0;
  const minEggSat = Math.min(...EGG_AXES.map((a) => n.satisfaction[a]));
  return clamp01(minEggSat) * N.CONDITION_MAX;
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
  // Recovering hens eat extra (INFIRMARY.FEED_MULT) while healing, so demand +
  // requirement scale off a weighted "layer-feed-equivalent" count, not the raw head
  // count. (They also lay nothing — handled in layNutritionTail.)
  const recoverFeed = BALANCE.PREDATORS.INFIRMARY.FEED_MULT;
  let feedWeight = 0;
  for (const d of layers) feedWeight += d.recovering ? recoverFeed : 1;
  const hasMill = mills.length > 0;
  const coopCycle = BALANCE.COOP.cycleSeconds;
  const step = dt * rateMult;

  // Desired ingredient draw (units/sec), capped by total mill capacity.
  // Mill blend capacity (a throughput cap — NOT a nutrition requirement); speed
  // and yield modules raise it. The requirement/matrix/satisfaction math below
  // is untouched by modules.
  const capacity =
    mills.reduce((a, m) => a + UPGRADE_OUTPUT(m.level), 0) * N.MILL_CAPACITY * millThroughputMult(state);
  const wantRate: Record<string, number> = {};
  let totalWant = 0;
  for (const ing of INGREDIENTS) {
    wantRate[ing] = ((state.ration[ing] ?? 0) * feedWeight) / coopCycle;
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
    // Phase 9c: the season tilts the LAYER demand profile (summer eats light,
    // winter eats heavy, the autumn molt wants calcium). Sim-level, never a
    // module/genome effect; floored so an axis demand can't go negative.
    const perDuck = Math.max(0, N.REQUIREMENT[axis] + seasonDemandDelta(state, axis));
    requirement[axis] = (perDuck * feedWeight) / coopCycle;
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
    // Phase 4d: water access scales regen — thirsty flocks recover slower, well-
    // watered ones faster (bounded). A multiplier alongside the rack regen bonus;
    // the satisfaction/throttle math above is untouched.
    const rise = N.CONDITION_RISE_PER_S * conditionRegenMult(state) * waterConditionMult(state);
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
  const masked = eggMultRaw + (1 - eggMultRaw) * cond;
  // CONDITION REWORK (see BALANCE.NUTRITION.STRESS): a rattled flock — condition
  // knocked down by harm events — lays at a direct, gentle penalty even on a
  // green ration. The throttle FADES IN only as nutrition approaches green
  // (FED_BLEND on eggMultRaw), so it acts exactly where the mask above is inert
  // and can never stack onto a feed shortfall the mask already handles. Floored:
  // a throttle, never a wall. Winter hens are insulated (their pool reads winter
  // satisfaction only — stress is a home-flock phenomenon).
  const S = N.STRESS;
  const stressRaw = S.THROTTLE_FLOOR + (1 - S.THROTTLE_FLOOR) * clamp01(cond / S.THROTTLE_BELOW);
  const fedWeight = clamp01((eggMultRaw - S.FED_BLEND[0]) / (S.FED_BLEND[1] - S.FED_BLEND[0]));
  const stressMult = 1 - fedWeight * (1 - stressRaw);
  const eggMult = masked * stressMult;

  state.nutrition = {
    satisfaction,
    supply,
    requirement,
    eggMultRaw,
    eggMult,
    stressMult,
    feedScale,
    hasMill,
    eggRate: 0,
    millCapacity: capacity,
    feedDemand: totalWant,
  };

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
  // Lay eggs: sum over adult hens of base × GENOME layMult × nutrition throttle ×
  // leg debuff × predator wound, then × the flock-wide eggOutput module bonus.
  // The genome (via layMult), modules, and the wound penalty multiply OUTPUT only
  // — never the f(axis)/requirement math above. (Phase 4c: a wounded hen lays at
  // WOUND_OUTPUT_MULT.)
  let flockRate = 0; // eggs per second from the whole laying flock
  for (const hen of layers) {
    const debuff = hen.debuffed ? N.DEBUFF_COOP_OUTPUT_MULT : 1;
    // Recovering in the infirmary → lays nothing; wounded-but-not-admitted → half.
    const wound = hen.recovering ? 0 : hen.wounded ? BALANCE.PREDATORS.WOUND_OUTPUT_MULT : 1;
    flockRate += (BALANCE.COOP.eggPerCycle / coopCycle) * layMult(hen.genome) * debuff * wound;
  }
  const eggModuleMult = eggOutputMult(state); // rack eggOutput modules buff the flock
  // Phase 4e: the legacy eggValue boost is a uniform scalar on eggs laid (never
  // the satisfaction/throttle math above — the nutrition puzzle is untouched).
  const eggRate = flockRate * eggMult * eggModuleMult * eggValueBoostMult(state); // eggs/sec
  if (state.nutrition) state.nutrition.eggRate = eggRate;
  const eggsThisStep = eggRate * step;
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
  // Only the head COUNT drives demand — count immature ducks instead of allocating
  // a filtered array every tick.
  let n = 0;
  for (const d of state.ducks) if (d.stage !== 'adult') n++;
  if (n === 0) {
    state.ducklingNutrition = undefined;
    return 1;
  }
  const step = dt * rateMult;
  const coopCycle = BALANCE.COOP.cycleSeconds;

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

/** Axes the drake maintenance ration must cover (no calcium — drakes don't lay). */
const DRAKE_AXES: Axis[] = ['energy', 'protein', 'niacin'];

/**
 * Advance the drake maintenance ration: adult drakes consume ingredients from the
 * SAME storage pool as everyone else (a real end-game drain that spares oyster
 * shell). Returns a clutch-rate multiplier (1 = full, down to the penalty floor)
 * from the worst required axis — well-fed drakes breed faster; starved ones slow
 * (a throttle, never a wall). Gated on breedingEstablished so a cold-start flock
 * is untouched. Runs online & offline; never grants XP.
 */
export function runDrakeNutrition(state: GameState, dt: number, rateMult: number): number {
  const B = BALANCE.BREEDING;
  // Only the head COUNT drives demand — no array allocation. The pool is
  // adult drakes (once breeding's established — a cold-start flock is never
  // taxed) PLUS posted workers (9a: a posted duck always eats its keep; the
  // same underfed floor that slows clutches slows post output — see
  // posts.ts's postWorkRate reading this pool's breedRate).
  const established = breedingEstablished(state);
  let n = 0;
  for (const d of state.ducks) {
    if (d.stage !== 'adult') continue;
    if (d.post) n++;
    else if (established && d.sex === 'drake') n++;
  }
  if (n === 0) {
    state.drakeNutrition = undefined;
    return 1;
  }
  const step = dt * rateMult;
  const coopCycle = BALANCE.COOP.cycleSeconds;

  const supply = zeroAxes();
  for (const ing of INGREDIENTS) {
    const want = (((state.drakeRation[ing] ?? 0) * n) / coopCycle) * step;
    const consume = Math.min(want, state.resources[ing as Ingredient]);
    if (consume > 0) state.resources[ing as Ingredient] -= consume;
    const rate = step > 0 ? consume / step : 0;
    const vals = N.INGREDIENT[ing as Ingredient] as Record<Axis, number>;
    for (const axis of AXES) supply[axis] += rate * (vals[axis] ?? 0);
  }

  const requirement = zeroAxes();
  const satisfaction = zeroAxes();
  const prior = state.drakeNutrition?.satisfaction;
  const alpha = N.SMOOTH_TAU_S > 0 ? Math.min(1, step / N.SMOOTH_TAU_S) : 1;
  for (const axis of AXES) {
    requirement[axis] = (B.DRAKE_REQUIREMENT[axis] * n) / coopCycle;
    const instant = requirement[axis] > 0 ? supply[axis] / requirement[axis] : 1;
    satisfaction[axis] = prior ? prior[axis] + (instant - prior[axis]) * alpha : instant;
  }

  const minSat = Math.min(...DRAKE_AXES.map((a) => satisfaction[a]));
  const floor = B.DRAKE_BREED_PENALTY_FLOOR;
  const breedRate = floor + (1 - floor) * clamp01(minSat);
  state.drakeNutrition = { satisfaction, requirement, breedRate, drakeCount: n };
  return breedRate;
}

/**
 * Phase 6d: the WINTERSTEAD pool — the 4th and LAST-fed ration (tick.ts calls it
 * after layers → ducklings → drakes, so scarcity throttles the luxury site
 * first, never the core engine). Assigned winter hens consume the winterRation
 * from the SAME shared storage against the cold, energy-dominant WINTER
 * requirement, then lay PREMIUM eggs:
 *
 *   perHen = layMult(genome) × hardinessMult(genome)   ← where H finally pays
 *   rate   = Σ perHen × (base/coopCycle) × nutritionMult × warmth × support
 *              × PREMIUM_EGG_MULT × eggValueBoost
 *
 * into the winter coops' buffers (shared egg pool on haul). `warmth`/`support`
 * arrive in Step 3 (heater layout + waterers) — 1 until then. Cold/hunger only
 * ever THROTTLE (floors, never walls, no death path). Runs online & offline;
 * never grants XP.
 */
export function runWinterNutrition(state: GameState, dt: number, rateMult: number, willHaul: boolean): void {
  const W = BALANCE.WINTER;
  // Head count first (O(ducks), cheap): no assigned hens ⇒ no pool at all.
  let n = 0;
  for (const d of state.ducks) if (d.stage === 'adult' && d.sex === 'hen' && d.site === 'winter') n++;
  if (n === 0) {
    state.winter = undefined;
    return;
  }
  const step = dt * rateMult;
  const coopCycle = BALANCE.COOP.cycleSeconds;

  const supply = zeroAxes();
  for (const ing of INGREDIENTS) {
    const want = (((state.winterRation[ing] ?? 0) * n) / coopCycle) * step;
    const consume = Math.min(want, state.resources[ing as Ingredient]);
    if (consume > 0) state.resources[ing as Ingredient] -= consume;
    const rate = step > 0 ? consume / step : 0;
    const vals = N.INGREDIENT[ing as Ingredient] as Record<Axis, number>;
    for (const axis of AXES) supply[axis] += rate * (vals[axis] ?? 0);
  }

  const requirement = zeroAxes();
  const satisfaction = zeroAxes();
  const prior = state.winter?.satisfaction;
  const alpha = N.SMOOTH_TAU_S > 0 ? Math.min(1, step / N.SMOOTH_TAU_S) : 1;
  for (const axis of AXES) {
    requirement[axis] = (W.REQUIREMENT[axis] * n) / coopCycle;
    const instant = requirement[axis] > 0 ? supply[axis] / requirement[axis] : 1;
    satisfaction[axis] = prior ? prior[axis] + (instant - prior[axis]) * alpha : instant;
  }

  // Worst required axis → the nutrition throttle (floor, never a wall).
  const minSat = Math.min(...AXES.map((a) => satisfaction[a]));
  const eggMult = W.PENALTY_FLOOR + (1 - W.PENALTY_FLOOR) * clamp01(minSat);

  // Warmth (heater layout, warmest coops fill first) + waterer support — pure
  // layout reads, set-and-holds (see winter.ts). Floors, never walls.
  const warmth = flockWarmth(state);
  const support = winterSupportFactor(state);

  // Premium lay — genome-scaled per hen (lay × HARDINESS), into winter coops.
  // Mirrors the home per-duck chain: a lingering leg debuff still halves her lay
  // (wounded/recovering hens can't be assigned at all), and the rack's flock-wide
  // eggOutput modules apply — a wintering hen is still your flock.
  const winterCoops = state.stations.filter((s) => s.type === 'winterCoop');
  let flockMult = 0;
  for (const d of state.ducks) {
    if (d.stage === 'adult' && d.sex === 'hen' && d.site === 'winter') {
      const debuff = d.debuffed ? N.DEBUFF_COOP_OUTPUT_MULT : 1;
      flockMult += layMult(d.genome) * hardinessMult(d.genome) * debuff;
    }
  }
  const basePerHen = BALANCE.COOP.eggPerCycle / coopCycle;
  const eggRate =
    flockMult *
    basePerHen *
    eggMult *
    warmth *
    support *
    W.PREMIUM_EGG_MULT *
    eggOutputMult(state) *
    eggValueBoostMult(state);
  const eggsThisStep = eggRate * step;
  if (eggsThisStep > 0 && winterCoops.length > 0) {
    const share = eggsThisStep / winterCoops.length;
    for (const coop of winterCoops) {
      coop.cycleProgress = (coop.cycleProgress + step) % coopCycle; // cosmetic lay bar
      coop.buffer.eggs = (coop.buffer.eggs ?? 0) + share;
      if (willHaul) {
        state.resources.eggs += coop.buffer.eggs ?? 0;
        coop.buffer = {};
      }
    }
  }

  state.winter = { satisfaction, requirement, eggMult, eggRate, henCount: n, warmth, support };
}
