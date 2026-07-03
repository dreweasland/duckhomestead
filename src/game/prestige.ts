import { BALANCE } from '../config/balance';
// Circular at module level (actions → prestige for the boost multipliers), but
// both sides only use the other inside function bodies, so ESM resolves it.
import { placeStarterEngine } from './actions';
import { targetMatch } from './genetics';
import { COLORS, initialState, type ChampionSnapshot, type GameState, type Genome } from './state';

/**
 * prestige.ts — Phase 4e meta loop.
 *
 * Prestige is MULTIPLIER-ONLY, CLEAN-SLATE. A champion-flock goal (Legacy Score)
 * gates an explicit, confirmed reset that wipes the entire run and grants legacy
 * currency for permanent GLOBAL-SCALAR boosts. The reset is built by composing a
 * fresh `initialState()` with the carried meta — NOT by deleting run fields — so
 * the next run is provably identical to a new game (no dangling references).
 *
 * Hard guardrail: boosts are uniform top-level scalars on production/output only.
 * They NEVER touch a nutrition requirement, the ingredient matrix, satisfaction,
 * or any puzzle tradeoff — same law as throughput-only loot and vigor.
 */

const P = BALANCE.PRESTIGE;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export type BoostId = 'output' | 'stationSpeed' | 'eggValue' | 'waterProvision' | 'renown' | 'husbandry';
export const BOOST_IDS: BoostId[] = [
  'output',
  'stationSpeed',
  'eggValue',
  'waterProvision',
  'renown',
  'husbandry',
];

// ── The champion goal: three concrete requirements ───────────────────
/**
 * The tier-authoritative champion target. The gate, currency, snapshot, and
 * truebred DING all read THIS — never the player-set tracking target (which
 * would let you point the gate at whatever the flock already is). Rotates
 * through hand-authored profiles so each tier is a NEW breeding puzzle, then
 * cycles. Returns a fresh copy (callers may hold/mutate it).
 */
export function targetForTier(tier: number): Genome {
  const targets = P.TARGETS_BY_TIER;
  return [...targets[tier % targets.length]] as Genome;
}

/** Live average flock GENOME QUALITY = mean slots matching the TIER's champion
 *  target (0..GENOME.SLOTS; 0 when there's no flock). The breeding-mastery axis. */
export function meanQuality(state: GameState): number {
  const n = state.ducks.length;
  if (n === 0) return 0;
  const target = targetForTier(state.legacyTier);
  return state.ducks.reduce((a, d) => a + targetMatch(d.genome, target), 0) / n;
}

/** Distinct colours bred this run (the dex). */
export function colorsBred(state: GameState): number {
  return state.dexSeen.length;
}

/** True once every colour has been bred. */
export function dexComplete(state: GameState): boolean {
  return colorsBred(state) >= COLORS.length;
}

/** The flock-size target for the current tier (rises each prestige). */
export function sizeTarget(state: GameState): number {
  return Math.round(P.SIZE_BASE * Math.pow(P.SIZE_GROWTH, state.legacyTier));
}

/** The genome-quality gate for the current tier — RISES each prestige (breeding
 *  mastery escalates), capped below the perfect 6 so it stays reachable. */
export function qualityGate(state: GameState): number {
  return Math.min(P.QUALITY_GATE_MAX, P.QUALITY_GATE_BASE + P.QUALITY_GATE_PER_TIER * state.legacyTier);
}

export interface ChampionReq {
  /** 0..1 progress toward this requirement. */
  progress: number;
  met: boolean;
}
export interface ChampionGoal {
  colors: ChampionReq & { bred: number; total: number };
  quality: ChampionReq & { value: number; gate: number };
  size: ChampionReq & { value: number; target: number };
  /** Overall readiness: 1 only when ALL three are met (the limiting requirement). */
  readiness: number;
}

/** The full champion-goal status — what the UI renders and the gate reads. */
export function championGoal(state: GameState): ChampionGoal {
  const bred = colorsBred(state);
  const total = COLORS.length;
  const mq = meanQuality(state);
  const size = state.ducks.length;
  const target = sizeTarget(state);
  const gate = qualityGate(state);
  const colors = { bred, total, progress: clamp01(bred / total), met: bred >= total };
  const quality = { value: mq, gate, progress: clamp01(mq / gate), met: mq >= gate };
  const sz = { value: size, target, progress: clamp01(size / target), met: size >= target };
  return {
    colors,
    quality,
    size: sz,
    readiness: Math.min(colors.progress, quality.progress, sz.progress),
  };
}

/** Prestige is gated: unavailable until ALL three champion requirements are met. */
export function canPrestige(state: GameState): boolean {
  const g = championGoal(state);
  return g.colors.met && g.quality.met && g.size.met;
}

/** Overall readiness [0,1] toward the champion goal (1 ⇒ ready). */
export function championReadiness(state: GameState): number {
  return championGoal(state).readiness;
}

/**
 * The grant IF the run were prestiged with `size` ducks at the current quality —
 * powers both the real grant and the UI's push-vs-reset projection ("prestige
 * now: +X · at N ducks: +Y"). The base scales with tier (TIER_CURRENCY_GROWTH,
 * tracking the rising size target) and the size exponent is SUPERLINEAR, so
 * pushing past the gate genuinely out-earns an immediate reset for a while.
 * Returns 0 unless the champion goal is currently met.
 */
export function currencyAtSize(state: GameState, size: number): number {
  if (!canPrestige(state)) return 0;
  const sizeOver = size / sizeTarget(state); // ≥ 1 (size met)
  const qualityOver = meanQuality(state) / qualityGate(state); // ≥ 1 (quality met)
  return Math.round(
    P.CURRENCY_AT_THRESHOLD *
      Math.pow(P.TIER_CURRENCY_GROWTH, state.legacyTier) *
      Math.pow(sizeOver, P.CURRENCY_OVERSHOOT_EXP) *
      Math.pow(qualityOver, P.CURRENCY_QUALITY_EXP),
  );
}

/** Legacy currency this run would grant — scales with how far the flock overshoots
 *  BOTH the size target and the quality gate (all requirements must be met first),
 *  so a championship flock out-earns a merely-bigger one. */
export function prestigeCurrency(state: GameState): number {
  return currencyAtSize(state, state.ducks.length);
}

// ── Boosts (global scalars) ──────────────────────────────────────────
export function boostLevel(state: GameState, id: BoostId): number {
  return state.purchasedBoosts[id] ?? 0;
}

/** The multiplier a boost contributes (1 = none). Output/eggValue scale up;
 *  stationSpeed is applied as a cycle-time divisor by the sim (so it speeds up). */
export function boostMult(state: GameState, id: BoostId): number {
  return 1 + P.BOOSTS[id].perLevel * boostLevel(state, id);
}

/** Cost (legacy currency) to buy the NEXT level of a boost. */
export function boostCost(state: GameState, id: BoostId): number {
  const def = P.BOOSTS[id];
  return Math.round(def.baseCost * Math.pow(def.costGrowth, boostLevel(state, id)));
}

// Convenience multipliers used at the sim's final output/rate computations.
export const outputBoostMult = (state: GameState): number => boostMult(state, 'output');
export const speedBoostMult = (state: GameState): number => boostMult(state, 'stationSpeed');
export const eggValueBoostMult = (state: GameState): number => boostMult(state, 'eggValue');
export const waterProvisionBoostMult = (state: GameState): number => boostMult(state, 'waterProvision');
/** Renown scales XP from ACTIVE actions (tend/dose) — the online-only XP law holds. */
export const renownBoostMult = (state: GameState): number => boostMult(state, 'renown');
/** Husbandry scales breeding + maturation SPEED (a rate scalar, so it applies
 *  offline too, like output) — never clutch size, rations, or genome odds. */
export const husbandryBoostMult = (state: GameState): number => boostMult(state, 'husbandry');

// ── The reset ────────────────────────────────────────────────────────
/** A memorial snapshot of the flock about to be wiped. */
export function championSnapshot(state: GameState, now: number): ChampionSnapshot {
  const target = targetForTier(state.legacyTier);
  return {
    tier: state.legacyTier + 1,
    meanQuality: meanQuality(state),
    bestQuality: state.ducks.reduce((m, d) => Math.max(m, targetMatch(d.genome, target)), 0),
    flockSize: state.ducks.length,
    colors: [...state.dexSeen],
    timestamp: now,
  };
}

/**
 * Produce the post-prestige state: a FRESH game carrying only the meta —
 * incremented tier, accrued currency, kept boosts, and the new Hall entry.
 * Everything else matches a brand-new game — INCLUDING the free pre-placed
 * starter engine (plot + mill + coop, which seeds the flock), so run 2+ never
 * starts poorer than run 1 (it used to: an empty board + the same 70-egg
 * stipend, ~85 eggs of stations behind a new player). Zones re-lock and no run
 * reference can dangle. The caller (engine) gates on canPrestige, supplies
 * `now`, and saves.
 */
export function prestigeReset(state: GameState, now: number): GameState {
  const granted = prestigeCurrency(state);
  const snapshot = championSnapshot(state, now);
  const fresh = initialState(now);
  placeStarterEngine(fresh); // the same floor a brand-new game gets (save.ts newGame)
  fresh.legacyTier = state.legacyTier + 1;
  fresh.legacyCurrency = state.legacyCurrency + granted;
  fresh.purchasedBoosts = { ...state.purchasedBoosts };
  fresh.legacyHall = [...state.legacyHall, snapshot];
  // Start the tracking target on the NEW tier's puzzle (the player can retune it;
  // the gate reads targetForTier regardless).
  fresh.genomeTarget = targetForTier(fresh.legacyTier);
  return fresh;
}

/** Buy the next level of a boost (mutates). Returns the new level, or null if
 *  unaffordable. */
export function buyBoost(state: GameState, id: BoostId): number | null {
  const cost = boostCost(state, id);
  if (state.legacyCurrency < cost) return null;
  state.legacyCurrency -= cost;
  state.purchasedBoosts[id] = boostLevel(state, id) + 1;
  return state.purchasedBoosts[id];
}
