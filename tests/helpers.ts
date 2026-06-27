import { initialState, type GameState } from '../src/game/state';
import { placeStation } from '../src/game/actions';
import { tick } from '../src/game/tick';
import type { StationType } from '../src/config/balance';

export const INGREDIENTS = ['corn', 'peas', 'mealworms', 'brewersYeast', 'oysterShell'] as const;

/** Build a state with the given station counts, laid out across the grid. */
export function build(counts: Partial<Record<StationType, number>>): GameState {
  const s = initialState(0);
  s.resources.eggs = 1_000_000;
  let x = 0;
  for (const [type, n] of Object.entries(counts)) {
    for (let i = 0; i < (n ?? 0); i++) {
      placeStation(s, type as StationType, x % 8, Math.floor(x / 8));
      x++;
    }
  }
  return s;
}

/** A complete one-of-each nutrition setup feeding a single coop. */
export function fullSetup(): GameState {
  return build({
    plot: 1,
    peaPatch: 1,
    mealwormFarm: 1,
    yeastVat: 1,
    oysterSource: 1,
    mill: 1,
    coop: 1,
  });
}

/** Flood storage with every ingredient so production is never the limiter. */
export function stockAll(s: GameState, v = 1_000_000): GameState {
  for (const k of INGREDIENTS) s.resources[k] = v;
  return s;
}

/** Advance the sim by `seconds` of online time in 0.1s steps (auto-haul on). */
export function run(s: GameState, seconds: number, autoHaul = true): GameState {
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) tick(s, 0.1, { mode: 'online', autoHaul });
  return s;
}

/**
 * Replace the seeded flock with a controlled set of adult hens (vigor 1.0).
 * A 1-hen flock makes the layer nutrition match Phase 2's single coop exactly
 * (adultCount = 1), so the green-bar / 15-eggs-min assertions still hold.
 */
export function setHens(s: GameState, count: number, vigor = 1): GameState {
  s.ducks = Array.from({ length: count }, (_, i) => ({
    id: `h${i}`,
    genotype: ['Bl', 'bl'] as ['Bl', 'bl'],
    vigor,
    sex: 'hen' as const,
    stage: 'adult' as const,
    ageTicks: 0,
  }));
  return s;
}
