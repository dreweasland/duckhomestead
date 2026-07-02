import { BALANCE } from '../config/balance';
import { watererSupport, winterHens, type GameState, type Station } from './state';

/**
 * winter.ts — Phase 6d Step 3: the WARMTH LAYOUT + waterer support.
 *
 * Warmth is a pure LAYOUT read — heaters warm tiles within a Chebyshev radius,
 * winter coops are warm or cold by position, and hens fill the warmest coops
 * first. SET-AND-HOLDS: there is no fouling analogue, no decay, no repair —
 * rearranging heaters is a decision, not a chore (the water system remains the
 * game's ONE upkeep loop). Cold only ever THROTTLES via COLD_FLOOR; it never
 * kills. Recomputed from GameState each tick/render — no stored warmth state.
 */

const W = BALANCE.WINTER;

/** A winter coop's warmth factor: 1 when any heater covers it, else COLD_FLOOR.
 *  Binary v1 — legible; the puzzle is radius-packing vs producer board space. */
export function coopWarmth(state: GameState, coop: Station): number {
  const r = W.STATIONS.heater.warmthRadius;
  for (const s of state.stations) {
    if (s.type !== 'heater' || s.zoneId !== coop.zoneId) continue;
    if (Math.max(Math.abs(s.x - coop.x), Math.abs(s.y - coop.y)) <= r) return 1;
  }
  return W.COLD_FLOOR;
}

/**
 * The flock-wide warmth factor: hens fill the WARMEST coops first (they're not
 * stupid), so the factor is the occupied-slot-weighted mean warmth. 1 with no
 * hens (nothing to chill); a lone cold coop only bites once the warm ones fill.
 */
export function flockWarmth(state: GameState): number {
  const hens = winterHens(state).length;
  if (hens === 0) return 1;
  const cap = W.STATIONS.winterCoop.capacity;
  const coops = state.stations
    .filter((s) => s.type === 'winterCoop')
    .map((c) => coopWarmth(state, c))
    .sort((a, b) => b - a); // warmest first
  if (coops.length === 0) return W.COLD_FLOOR; // housed nowhere — fully cold
  let remaining = hens;
  let total = 0;
  for (const warmth of coops) {
    if (remaining <= 0) break;
    const housed = Math.min(cap, remaining);
    total += warmth * housed;
    remaining -= housed;
  }
  // Any overflow (capacity shrank under the assigned count mid-tick) sits cold.
  total += Math.max(0, remaining) * W.COLD_FLOOR;
  return total / hens;
}

/** Heated-waterer support factor: 1 while every winter duck is covered, easing
 *  toward WATERER_FLOOR as the site outgrows its waterers. A floor, never a wall. */
export function winterSupportFactor(state: GameState): number {
  const hens = winterHens(state).length;
  if (hens === 0) return 1;
  const ratio = Math.min(1, watererSupport(state) / hens);
  return W.WATERER_FLOOR + (1 - W.WATERER_FLOOR) * ratio;
}
