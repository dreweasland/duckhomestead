import { initialState, type Gene, type Genome, type GameState } from '../src/game/state';
import { placeStation } from '../src/game/actions';
import { tick } from '../src/game/tick';
import { BALANCE, type StationType } from '../src/config/balance';

/** All-Dud genome → layMult 1.0 (the old "vigor 1.0" baseline for sim tests). */
export const FLAT_GENOME: Genome = ['D', 'D', 'D', 'D', 'D', 'D'];
/** Build a 6-slot genome from a gene string like "LLLDDD". */
export const genome = (s: string): Genome => s.split('') as Gene[];

export const INGREDIENTS = [
  'corn',
  'peas',
  'mealworms',
  'brewersYeast',
  'oysterShell',
  'sunflowerSeeds',
  'fodderSprouts',
] as const;

/** Build a state with the given station counts, laid out across the grid. The
 *  game now starts with EMPTY rations (the player sets them), but sim tests want a
 *  fed flock, so seed the balanced default rations here. */
export function build(counts: Partial<Record<StationType, number>>): GameState {
  const s = initialState(0);
  s.resources.eggs = 1_000_000;
  s.ration = { ...BALANCE.NUTRITION.DEFAULT_RATION };
  s.ducklingRation = { ...BALANCE.BREEDING.DEFAULT_DUCKLING_RATION };
  s.drakeRation = { ...BALANCE.BREEDING.DEFAULT_DRAKE_RATION };
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

/** Advance the sim by `seconds` of online time in 0.1s steps (auto-haul on).
 *  Pins guardElapsed at 0 (fresh guard) each step so long runs measure the
 *  full 1× online rate — the guard production ease has its own tests
 *  (guard-idle.test.ts) and would otherwise skew every duration-based
 *  assertion past GUARD_RATE.GRACE_S. */
export function run(s: GameState, seconds: number, autoHaul = true): GameState {
  const steps = Math.round(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    s.guardElapsed = 0;
    tick(s, 0.1, { mode: 'online', autoHaul });
  }
  return s;
}

/**
 * Replace the seeded flock with a controlled set of adult hens. The default
 * all-Dud genome lays at layMult 1.0 (the old "vigor 1.0" baseline), so a 1-hen
 * flock matches Phase 2's single coop exactly and the green-bar / 15-eggs-min
 * assertions still hold. Pass a genome to vary output.
 */
export function setHens(s: GameState, count: number, g: Genome = FLAT_GENOME): GameState {
  s.ducks = Array.from({ length: count }, (_, i) => ({
    id: `h${i}`,
    genotype: ['Bl', 'bl'] as ['Bl', 'bl'],
    genome: [...g],
    genomeKnown: true,
    sex: 'hen' as const,
    stage: 'adult' as const,
    ageTicks: 0,
  }));
  return s;
}
