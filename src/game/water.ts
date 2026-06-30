import { BALANCE } from '../config/balance';
import type { GameState } from './state';
import { flockWaterSynergy } from './genetics';
import { circulationHealth, featureProvisions, pondLayoutBase } from './pond';
import { waterProvisionBoostMult } from './prestige';

/**
 * water.ts — the provision → wellness bridge of THE WATER SYSTEM.
 *
 * The water system produces ONE number, `provision = layoutBase ×
 * circulationHealth` (the Pond layout × how fresh the Waterworks keeps it).
 * Scored as a single ratio on the EXISTING saturation curve:
 *   access = provision / (flock × REQUIREMENT_PER_DUCK)
 *     - below 1 → a gentle throttle (the baseline need), scaled by shortfall,
 *     - at 1   → neutral,
 *     - above 1 → a BOUNDED, DIMINISHING resilience bonus (the reward), flat past 2.
 *
 * It only ever modifies two existing systems via multipliers: flock CONDITION
 * regen (nutrition.ts) and the wound-escalation timer (predators.ts). It never
 * touches the nutrition axes, never produces eggs, and never creates a new death
 * path — the timer multiplier stays comfortably above zero, so a wound always
 * leaves time to treat. (The layout/circulation puzzles live in game/pond.ts.)
 */

const W = BALANCE.WATER;

/** Total water provision the system supplies: layout × circulation freshness, ×
 *  the legacy water boost (the meta lever that scales provision past the fixed
 *  Pond canvas's layout ceiling — so a huge end-game flock can stay watered). */
export function waterProvision(state: GameState): number {
  // Build the per-feature provisions once and feed both halves (each used to
  // recompute it independently — doubling the work on a per-tick path).
  const provs = featureProvisions(state);
  return pondLayoutBase(state, provs) * circulationHealth(state, provs) * waterProvisionBoostMult(state);
}

/** What the flock asks of the water (heads × per-duck requirement). */
export function flockRequirement(state: GameState): number {
  return state.ducks.length * W.REQUIREMENT_PER_DUCK;
}

/** Access ratio = provision / requirement. Infinite when there's no flock. */
export function waterAccess(state: GameState): number {
  const req = flockRequirement(state);
  return req > 0 ? waterProvision(state) / req : Infinity;
}

/**
 * The saturation curve. 1.0 at ratio 1.0. Below 1 it declines LINEARLY (scaled by
 * shortfall) toward `atHalf` at ratio 0.5. Above 1 it rises with DIMINISHING
 * returns (ease-out) toward `atDouble` at ratio 2.0, then saturates flat. Pure;
 * exported for tests. (Unchanged from the original water math.)
 */
export function waterCurve(ratio: number, atHalf: number, atDouble: number): number {
  if (!Number.isFinite(ratio)) return atDouble; // no flock → max (harmless; unused)
  if (ratio >= 1) {
    const t = Math.min(1, ratio - 1); // 0 at r=1 .. 1 at r=2 (clamped → flat beyond)
    const eased = 1 - (1 - t) * (1 - t); // ease-out: most of the bonus comes early
    return 1 + (atDouble - 1) * eased;
  }
  const shortfall = (1 - ratio) / 0.5; // 1.0 at r=0.5, grows below it
  return Math.max(0, 1 + (atHalf - 1) * shortfall);
}

/** Condition-regen multiplier from water access (slower when thirsty, faster when
 *  flush), lifted by the flock's mean H-gene water synergy (a wellness reward —
 *  it never reduces the water requirement, only gets more condition from access). */
export function waterConditionMult(state: GameState): number {
  const base = waterCurve(waterAccess(state), W.CONDITION_REGEN_AT_HALF, W.CONDITION_REGEN_AT_DOUBLE);
  return base * (1 + flockWaterSynergy(state));
}

/** Wound-escalation-timer multiplier from water access (less/more time to treat). */
export function waterWoundMult(state: GameState): number {
  return waterCurve(waterAccess(state), W.WOUND_TIMER_AT_HALF, W.WOUND_TIMER_AT_DOUBLE);
}

/** UI status bucket for the access readout. */
export type WaterStatus = 'good' | 'ok' | 'low';
export function waterStatus(ratio: number): WaterStatus {
  if (!Number.isFinite(ratio) || ratio >= 1) return 'good';
  if (ratio >= 0.75) return 'ok';
  return 'low';
}
