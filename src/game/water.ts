import { BALANCE, ZONE_DEFS } from '../config/balance';
import { zoneUnlocked, type GameState } from './state';

/**
 * water.ts — Phase 4d water access.
 *
 * Water is STRUCTURAL capacity (built, never refilled per-cycle), scored as ONE
 * ratio on a saturation curve:  access = builtWaterCapacity / flockSize.
 *   - below 1 → a gentle throttle (the baseline need), scaled by shortfall,
 *   - at 1   → neutral,
 *   - above 1 → a BOUNDED, DIMINISHING resilience bonus (the reward), flat past 2.
 *
 * It only ever modifies two existing systems via multipliers: flock CONDITION
 * regen (nutrition.ts) and the wound-escalation timer (predators.ts). It never
 * touches the nutrition axes and never creates a new death path — the timer
 * multiplier stays comfortably above zero, so a wound always leaves time to treat.
 */

const W = BALANCE.WATER;

/** Total structural water capacity: every unlocked zone's baseline + built features. */
export function waterCapacity(state: GameState): number {
  let base = 0;
  for (const z of ZONE_DEFS) {
    if (z.water && zoneUnlocked(state, z.id)) base += z.water.baseCapacity;
  }
  return base + state.waterFeatures * W.FEATURE_CAPACITY;
}

/** Access ratio = capacity / flock. Infinite when there's no flock (no constraint). */
export function waterAccess(state: GameState): number {
  const n = state.ducks.length;
  return n > 0 ? waterCapacity(state) / n : Infinity;
}

/** Whether the player can build water features yet (any unlocked non-yard water zone). */
export function canBuildWaterFeatures(state: GameState): boolean {
  return ZONE_DEFS.some((z) => z.id !== 'yard' && z.water != null && zoneUnlocked(state, z.id));
}

/**
 * The saturation curve. 1.0 at ratio 1.0. Below 1 it declines LINEARLY (scaled by
 * shortfall) toward `atHalf` at ratio 0.5. Above 1 it rises with DIMINISHING
 * returns (ease-out) toward `atDouble` at ratio 2.0, then saturates flat. Pure;
 * exported for tests.
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

/** Condition-regen multiplier from water access (slower when thirsty, faster when flush). */
export function waterConditionMult(state: GameState): number {
  return waterCurve(waterAccess(state), W.CONDITION_REGEN_AT_HALF, W.CONDITION_REGEN_AT_DOUBLE);
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
