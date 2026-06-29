import { BALANCE } from '../config/balance';
import { COLORS, initialState, type ChampionSnapshot, type GameState } from './state';

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

export type BoostId = 'output' | 'stationSpeed' | 'eggValue';
export const BOOST_IDS: BoostId[] = ['output', 'stationSpeed', 'eggValue'];

// ── Legacy Score + threshold ─────────────────────────────────────────
/** Live run-mastery aggregate: flock vigor + dex completion + flock size. */
export function legacyScore(state: GameState): number {
  const W = P.SCORE_WEIGHTS;
  const vigorSum = state.ducks.reduce((a, d) => a + d.vigor, 0);
  const dexCompletion = state.dexSeen.length / COLORS.length; // 0..1
  return W.vigor * vigorSum + W.dexCompletion * dexCompletion + W.flockSize * state.ducks.length;
}

/** The champion goal for the current tier (rises each prestige). */
export function currentThreshold(state: GameState): number {
  return P.BASE_THRESHOLD * Math.pow(P.THRESHOLD_GROWTH, state.legacyTier);
}

/** Fraction [0,1] of the way to the current champion goal (for the progress bar). */
export function thresholdProgress(state: GameState): number {
  return Math.min(1, legacyScore(state) / currentThreshold(state));
}

/** Prestige is gated: unavailable until the run reaches the champion goal. */
export function canPrestige(state: GameState): boolean {
  return legacyScore(state) >= currentThreshold(state);
}

/** Legacy currency this run would grant — scales with overshoot past threshold. */
export function prestigeCurrency(state: GameState): number {
  const score = legacyScore(state);
  const threshold = currentThreshold(state);
  if (score < threshold) return 0;
  return Math.round(P.CURRENCY_AT_THRESHOLD * Math.pow(score / threshold, P.CURRENCY_OVERSHOOT_EXP));
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

// ── The reset ────────────────────────────────────────────────────────
/** A memorial snapshot of the flock about to be wiped. */
export function championSnapshot(state: GameState, now: number): ChampionSnapshot {
  return {
    tier: state.legacyTier + 1,
    score: Math.round(legacyScore(state)),
    bestVigor: state.ducks.reduce((m, d) => Math.max(m, d.vigor), 0),
    flockSize: state.ducks.length,
    colors: [...state.dexSeen],
    timestamp: now,
  };
}

/**
 * Produce the post-prestige state: a FRESH game (initialState) carrying only the
 * meta — incremented tier, accrued currency, kept boosts, and the new Hall entry.
 * Everything else is initialState's, so zones re-lock and no run reference can
 * dangle. Pure; the caller (engine) gates on canPrestige and supplies `now`.
 */
export function prestigeReset(state: GameState, now: number): GameState {
  const granted = prestigeCurrency(state);
  const snapshot = championSnapshot(state, now);
  const fresh = initialState(now);
  fresh.legacyTier = state.legacyTier + 1;
  fresh.legacyCurrency = state.legacyCurrency + granted;
  fresh.purchasedBoosts = { ...state.purchasedBoosts };
  fresh.legacyHall = [...state.legacyHall, snapshot];
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
