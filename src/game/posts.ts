import { BALANCE } from '../config/balance';
import { axisScore } from './genetics';
import { addResource, POST_IDS, type Duck, type GameState, type PostId } from './state';

/**
 * posts.ts — Phase 9a: WORKING POSTS (the flock becomes a portfolio).
 *
 * An adult duck assigned to a post stops laying, eats the drake maintenance
 * ration (same pool, same underfed floor — see nutrition.ts), and converts a
 * gene AXIS into a working effect:
 *   - SENTRY (H): stretches dive wind-ups while you play; a chance to repel
 *     landing attacks outright at guard/offline (duck-shaped built defense).
 *   - FORAGER (V): trickles peas + mealworms into storage.
 *   - BROODY (V): speeds duckling grow-out.
 * The design point is breeding MULTI-OBJECTIVITY: a duck that's junk against
 * the Standard can be a prize sentry — culls become line decisions, and the
 * game runs several breeding lines at once (see docs/PHASE9-DEPTH.md).
 *
 * Guardrails: throughput-only — no effect here ever touches a nutrition
 * requirement, the ingredient matrix, or the satisfaction/throttle math.
 * Forage ADDS supply (clamped by the Feed Store like any producer); underfed
 * workers throttle post output through workRate, never a wall.
 */

const P = BALANCE.POSTS;

export const POST_META: Record<
  PostId,
  { label: string; axis: 'lay' | 'vigor' | 'hardy'; blurb: string }
> = {
  sentry: { label: 'Sentry', axis: 'hardy', blurb: 'slows dives; repels attacks while you’re away' },
  forager: { label: 'Forager', axis: 'vigor', blurb: 'gathers peas + mealworms into storage' },
  broody: { label: 'Broody', axis: 'vigor', blurb: 'speeds every duckling’s grow-out' },
};

export function postsUnlocked(state: GameState): boolean {
  return state.rank >= P.INTRO_RANK;
}

export function postCapacity(id: PostId): number {
  return P.SLOTS[id] ?? 0;
}

/** A posted duck actually WORKING — wounded/recovering workers contribute
 *  nothing until healed (they keep the post; the roster shows why it's idle). */
export const working = (d: Duck): boolean => !d.wounded && !d.recovering;

export function postedDucks(state: GameState, id?: PostId): Duck[] {
  return state.ducks.filter((d) => (id ? d.post === id : d.post != null));
}

/** Underfed workers slow down: the drake maintenance pool's floor curve is the
 *  posts' work rate too (breedRate IS that curve — see runDrakeNutrition). */
export function postWorkRate(state: GameState): number {
  return state.drakeNutrition?.breedRate ?? 1;
}

/** Σ axis score over the working occupants of a post (each 0..1). */
function postScore(state: GameState, id: PostId): number {
  const axis = POST_META[id].axis;
  let sum = 0;
  for (const d of state.ducks) {
    if (d.post === id && working(d)) sum += axisScore(d.genome, axis);
  }
  return sum;
}

// ── SENTRY ────────────────────────────────────────────────────────────
/** Dive wind-up multiplier while the player is present (≥ 1, capped). */
export function sentryWindupMult(state: GameState): number {
  const bonus = P.SENTRY.WINDUP_PER_SCORE * postScore(state, 'sentry') * postWorkRate(state);
  return 1 + Math.min(P.SENTRY.WINDUP_CAP, bonus);
}

/** Guard/offline: chance a landing attack is repelled outright by the watch. */
export function sentryRepelChance(state: GameState): number {
  return Math.min(
    P.SENTRY.REPEL_CAP,
    P.SENTRY.REPEL_PER_SCORE * postScore(state, 'sentry') * postWorkRate(state),
  );
}

// ── BROODY ────────────────────────────────────────────────────────────
/** Duckling grow-out speed multiplier (≥ 1) — multiplies with the duckling
 *  ration's matureRate and the Husbandry legacy boost. */
export function broodyMatureMult(state: GameState): number {
  return 1 + P.BROODY.MATURE_PER_SCORE * postScore(state, 'broody') * postWorkRate(state);
}

// ── FORAGER ───────────────────────────────────────────────────────────
/** Per-forager output scale: a flat floor so even a dud forages something,
 *  rising with the V score — the line is worth breeding. */
function forageScale(d: Duck): number {
  const F = P.FORAGER;
  return F.SCORE_FLOOR + (1 - F.SCORE_FLOOR) * axisScore(d.genome, 'vigor');
}

/** The live forage rate per second, per resource (for readouts + the sim). */
export function forageRates(state: GameState): { peas: number; mealworms: number } {
  let scale = 0;
  for (const d of state.ducks) if (d.post === 'forager' && working(d)) scale += forageScale(d);
  scale *= postWorkRate(state);
  return { peas: P.FORAGER.PEAS_PER_S * scale, mealworms: P.FORAGER.MEALWORMS_PER_S * scale };
}

/** Advance the foragers by dt (rate-scaled like every producer — offline runs
 *  at the reduced mult). addResource clamps at the Feed Store cap, so a full
 *  line simply wastes the forage — same rule as an idling producer. */
export function runForagers(state: GameState, dt: number, rateMult: number): void {
  const rates = forageRates(state);
  const step = dt * rateMult;
  if (rates.peas > 0) addResource(state, 'peas', rates.peas * step);
  if (rates.mealworms > 0) addResource(state, 'mealworms', rates.mealworms * step);
}

/** Sanitize a save's post value (hand-edits / future shapes): unknown → unposted. */
export function validPost(post: unknown): PostId | undefined {
  return POST_IDS.includes(post as PostId) ? (post as PostId) : undefined;
}
