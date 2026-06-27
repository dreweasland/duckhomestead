import type { Allele, Color, GameState, Genotype } from './state';
import { phenotype } from './state';

type Rng = () => number;

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
