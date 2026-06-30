import { BALANCE } from '../config/balance';
import { targetMatch } from './genetics';
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

export type BoostId = 'output' | 'stationSpeed' | 'eggValue' | 'waterProvision';
export const BOOST_IDS: BoostId[] = ['output', 'stationSpeed', 'eggValue', 'waterProvision'];

// ── The champion goal: three concrete requirements ───────────────────
/** Live average flock GENOME QUALITY = mean slots matching the god-clone target
 *  (0..GENOME.SLOTS; 0 when there's no flock). The breeding-mastery axis. */
export function meanQuality(state: GameState): number {
  const n = state.ducks.length;
  if (n === 0) return 0;
  return state.ducks.reduce((a, d) => a + targetMatch(d.genome, state.genomeTarget), 0) / n;
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

/** Legacy currency this run would grant — scales with how far the flock overshoots
 *  BOTH the size target and the vigor gate (all requirements must be met first),
 *  so a championship flock out-earns a merely-bigger one. */
export function prestigeCurrency(state: GameState): number {
  if (!canPrestige(state)) return 0;
  const sizeOver = state.ducks.length / sizeTarget(state); // ≥ 1 (size met)
  const qualityOver = meanQuality(state) / qualityGate(state); // ≥ 1 (quality met)
  return Math.round(
    P.CURRENCY_AT_THRESHOLD *
      Math.pow(sizeOver, P.CURRENCY_OVERSHOOT_EXP) *
      Math.pow(qualityOver, P.CURRENCY_QUALITY_EXP),
  );
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

// ── The reset ────────────────────────────────────────────────────────
/** A memorial snapshot of the flock about to be wiped. */
export function championSnapshot(state: GameState, now: number): ChampionSnapshot {
  return {
    tier: state.legacyTier + 1,
    meanQuality: meanQuality(state),
    bestQuality: state.ducks.reduce((m, d) => Math.max(m, targetMatch(d.genome, state.genomeTarget)), 0),
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
