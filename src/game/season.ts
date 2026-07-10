import { BALANCE } from '../config/balance';
import type { GameState } from './state';

/**
 * season.ts — Phase 9c: SEASONS, the non-stationary economy.
 *
 * A four-season year on an ACTIVE-ONLY clock (tick.ts advances it only while
 * the player is present — the attended-event law): each season re-tilts
 * producer rates and the layer demand profile, turning the solved-once ration
 * into a quarterly puzzle. Offline and guard hold the current season frozen
 * but its multipliers still apply — catch-up production is season-honest.
 *
 * Everything here is a pure read of BALANCE.SEASONS + state.season; dormant
 * (identity multipliers) below INTRO_RANK so onboarding is untouched.
 */

const S = BALANCE.SEASONS;
export type SeasonId = (typeof S.ORDER)[number];

export function seasonsActive(state: GameState): boolean {
  return state.rank >= S.INTRO_RANK;
}

export function currentSeasonId(state: GameState): SeasonId {
  return S.ORDER[state.season.index % S.ORDER.length];
}

export function currentSeason(state: GameState) {
  return S.DEFS[currentSeasonId(state)];
}

/** Seconds of active play left in the current season. */
export function seasonRemaining(state: GameState): number {
  return Math.max(0, S.LENGTH_S - state.season.elapsed);
}

/** Producer cycle-rate multiplier for a station type this season. */
export function seasonProducerMult(state: GameState, stationType: string): number {
  if (!seasonsActive(state)) return 1;
  return currentSeason(state).producers[stationType] ?? 1;
}

/** Additive tilt to the LAYER per-axis requirement (units per coop-cycle). */
export function seasonDemandDelta(state: GameState, axis: string): number {
  if (!seasonsActive(state)) return 0;
  return currentSeason(state).demand[axis] ?? 0;
}

/** Clutch progress rate multiplier (spring breeds faster). */
export function seasonClutchRate(state: GameState): number {
  if (!seasonsActive(state)) return 1;
  return currentSeason(state).clutchRate;
}

/** Forager output multiplier (rich in spring, lean in winter). */
export function seasonForageMult(state: GameState): number {
  if (!seasonsActive(state)) return 1;
  return currentSeason(state).forageMult;
}

/** Pond fouling multiplier (summer blooms, winter keeps). */
export function seasonFoulMult(state: GameState): number {
  if (!seasonsActive(state)) return 1;
  return currentSeason(state).foulMult;
}

/**
 * Advance the season clock by dt seconds of ACTIVE play (the caller gates on
 * presence). On rollover, queue the announcement toast (drained by the
 * engine — never replayed from a save).
 */
export function advanceSeason(state: GameState, dt: number): void {
  if (!seasonsActive(state)) return;
  state.season.elapsed += dt;
  while (state.season.elapsed >= S.LENGTH_S) {
    state.season.elapsed -= S.LENGTH_S;
    state.season.index = (state.season.index + 1) % S.ORDER.length;
    state.pendingSeasonChange = currentSeasonId(state);
  }
}
