import { BALANCE } from '../config/balance';
import type { Allele, Color, GameState, Genotype } from './state';
import { phenotype } from './state';

type Rng = () => number;

/** Current mean vigor of the whole flock (the regression target). */
export function populationMeanVigor(state: GameState): number {
  if (state.ducks.length === 0) return 1;
  return state.ducks.reduce((a, d) => a + d.vigor, 0) / state.ducks.length;
}

/**
 * Heritable vigor via the breeder's equation — regression toward the mean:
 *   offspring = popMean + H2·(midparent − popMean) + noise, clamped.
 * With H2 < 1 the offspring regress toward the population mean, so selective
 * breeding makes steady but BOUNDED progress (it asymptotes below the ceiling,
 * never compounding to infinity).
 *
 * NOTE: the kickoff spec wrote `midparent + H2·(midparent − popMean)`, but that
 * amplifies the deviation (offspring exceed parents → rushes to the ceiling),
 * contradicting the constraint's own "regression toward the mean / never
 * compounding" intent. Implemented the standard regression form to match intent.
 */
const clampVigor = (v: number): number =>
  Math.max(BALANCE.BREEDING.VIGOR_FLOOR, Math.min(BALANCE.BREEDING.VIGOR_CEILING, v));

/** The regression core (unclamped, noiseless): popMean + H2·(midparent − popMean). */
const regressVigor = (a: number, b: number, popMean: number): number =>
  popMean + BALANCE.BREEDING.H2 * ((a + b) / 2 - popMean);

/**
 * Deterministic EXPECTED offspring vigor for a pairing (regression, no noise),
 * clamped — what a cross will average toward. Powers the breeding-pair preview
 * so the player can see whether a pairing lifts or drags the line.
 */
export function expectedVigor(a: number, b: number, popMean: number): number {
  return clampVigor(regressVigor(a, b, popMean));
}

export function breedVigor(a: number, b: number, popMean: number, rng: Rng = Math.random): number {
  const noise = (rng() * 2 - 1) * BALANCE.BREEDING.VIGOR_NOISE;
  return clampVigor(regressVigor(a, b, popMean) + noise);
}

/** Roll a seed-flock vigor uniformly in the configured seed range. */
export function rollSeedVigor(rng: Rng = Math.random): number {
  const [lo, hi] = BALANCE.BREEDING.VIGOR_SEED_RANGE;
  return lo + rng() * (hi - lo);
}

/** Mendelian: a parent passes one of its two alleles at random. */
export function inheritAllele(g: Genotype, rng: Rng = Math.random): Allele {
  return g[rng() < 0.5 ? 0 : 1];
}

/** Cross two genotypes — each parent contributes one random allele. */
export function breedGenotype(a: Genotype, b: Genotype, rng: Rng = Math.random): Genotype {
  return [inheritAllele(a, rng), inheritAllele(b, rng)];
}

/**
 * Record a produced color in the flock dex. Returns true if it's the first of
 * that color ever (the collection DING beat). Mutates state.dexSeen.
 */
export function recordColor(state: GameState, color: Color): boolean {
  if (state.dexSeen.includes(color)) return false;
  state.dexSeen.push(color);
  return true;
}

/** Phenotype of a genotype (re-exported for convenience). */
export const colorOf = (g: Genotype): Color => phenotype(g);
