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
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export type BoostId = 'output' | 'stationSpeed' | 'eggValue';
export const BOOST_IDS: BoostId[] = ['output', 'stationSpeed', 'eggValue'];

// ── The champion goal: three concrete requirements ───────────────────
/** Live average flock vigor (0 when there's no flock). The breeding-mastery axis. */
export function meanVigor(state: GameState): number {
  const n = state.ducks.length;
  return n > 0 ? state.ducks.reduce((a, d) => a + d.vigor, 0) / n : 0;
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

export interface ChampionReq {
  /** 0..1 progress toward this requirement. */
  progress: number;
  met: boolean;
}
export interface ChampionGoal {
  colors: ChampionReq & { bred: number; total: number };
  vigor: ChampionReq & { value: number; gate: number };
  size: ChampionReq & { value: number; target: number };
  /** Overall readiness: 1 only when ALL three are met (the limiting requirement). */
  readiness: number;
}

/** The full champion-goal status — what the UI renders and the gate reads. */
export function championGoal(state: GameState): ChampionGoal {
  const bred = colorsBred(state);
  const total = COLORS.length;
  const mv = meanVigor(state);
  const size = state.ducks.length;
  const target = sizeTarget(state);
  const colors = { bred, total, progress: clamp01(bred / total), met: bred >= total };
  const vigor = { value: mv, gate: P.VIGOR_GATE, progress: clamp01(mv / P.VIGOR_GATE), met: mv >= P.VIGOR_GATE };
  const sz = { value: size, target, progress: clamp01(size / target), met: size >= target };
  return {
    colors,
    vigor,
    size: sz,
    readiness: Math.min(colors.progress, vigor.progress, sz.progress),
  };
}

/** Prestige is gated: unavailable until ALL three champion requirements are met. */
export function canPrestige(state: GameState): boolean {
  const g = championGoal(state);
  return g.colors.met && g.vigor.met && g.size.met;
}

/** Overall readiness [0,1] toward the champion goal (1 ⇒ ready). */
export function championReadiness(state: GameState): number {
  return championGoal(state).readiness;
}

/** Legacy currency this run would grant — scales with how far the flock overshoots
 *  the size target (the requirements must all be met first). */
export function prestigeCurrency(state: GameState): number {
  if (!canPrestige(state)) return 0;
  const over = state.ducks.length / sizeTarget(state); // ≥ 1
  return Math.round(P.CURRENCY_AT_THRESHOLD * Math.pow(over, P.CURRENCY_OVERSHOOT_EXP));
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
    meanVigor: meanVigor(state),
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
