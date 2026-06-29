import { BALANCE } from '../config/balance';
import type { Allele, Color, Gene, GameState, Genome, Genotype } from './state';
import { GENES, phenotype } from './state';

type Rng = () => number;

const G = BALANCE.GENOME;

// ── The genome: derived stats from the gene PROFILE ──────────────────
// A duck's quality is its 6-slot genome. Stats derive from the gene profile —
// L/V/H do DIFFERENT things, so the genome can't collapse back to one scalar.
// Everything here is THROUGHPUT-ONLY: it boosts output/resilience and NEVER
// reduces a nutrition/water requirement.

/** Sum one expressed-stat contribution across all genes in the genome. */
function sumStat(genome: Genome, key: 'eggOutput' | 'maturationSpeed' | 'woundResist' | 'waterSynergy'): number {
  let total = 0;
  for (const gene of genome) total += G.STAT_PER_GENE[gene]?.[key] ?? 0;
  return total;
}

/** Count of each gene in a genome — the profile the stats read from. */
export function geneProfile(genome: Genome): Record<Gene, number> {
  const p: Record<Gene, number> = { L: 0, V: 0, H: 0, D: 0 };
  for (const gene of genome) p[gene] += 1;
  return p;
}

/**
 * A duck's egg-output multiplier — REPLACES the old vigor scalar in the per-duck
 * output chain (nutrition.ts). L drives most of it; V adds a smaller bump; H/D
 * add nothing. A genome of all-Dud lays at the ×1.0 floor; an all-Lay god clone
 * lays far above it. Throughput-only.
 */
export function layMult(genome: Genome): number {
  return 1 + sumStat(genome, 'eggOutput');
}

/** Maturation-speed multiplier (V genes grow ducklings up faster). 1 = baseline. */
export function maturationMult(genome: Genome): number {
  return 1 + sumStat(genome, 'maturationSpeed');
}

/** Chance (0..cap) a duck shrugs off a predator wound entirely (H = Hardy). */
export function woundResistChance(genome: Genome): number {
  return Math.min(G.WOUND_RESIST_CAP, sumStat(genome, 'woundResist'));
}

/** Per-duck water-synergy bonus (H genes get more out of the same water). */
export function waterSynergy(genome: Genome): number {
  return sumStat(genome, 'waterSynergy');
}

/** Flock-mean water synergy (a wellness multiplier, never a water requirement). */
export function flockWaterSynergy(state: GameState): number {
  if (state.ducks.length === 0) return 0;
  return state.ducks.reduce((a, d) => a + waterSynergy(d.genome), 0) / state.ducks.length;
}

/** Number of "good" (non-Dud) genes — the at-a-glance quality read. */
export function goodGeneCount(genome: Genome): number {
  return genome.reduce((a, g) => a + (g === 'D' ? 0 : 1), 0);
}

/** Slots matching the target profile (0..SLOTS) — distance-to-god-clone, inverted. */
export function targetMatch(genome: Genome, target: Genome): number {
  let n = 0;
  for (let i = 0; i < genome.length; i++) if (genome[i] === target[i]) n += 1;
  return n;
}

/** True iff this genome exactly matches the target (a god clone). */
export function isGodClone(genome: Genome, target: Genome): boolean {
  return genome.length === target.length && targetMatch(genome, target) === target.length;
}

// ── Inheritance ──────────────────────────────────────────────────────
/**
 * Cross two genomes into an offspring genome. Position-linked: offspring slot i
 * comes from one parent's slot i.
 *
 * STEP 1 PLACEHOLDER: each slot is taken from a parent at random (50/50), no
 * dominance weighting and no mutation yet. Step 2 replaces this with the
 * dominance-weighted + per-slot-mutation cross (the real assembly puzzle).
 */
export function breedGenome(a: Genome, b: Genome, rng: Rng = Math.random): Genome {
  const out: Genome = [];
  for (let i = 0; i < a.length; i++) out.push(rng() < 0.5 ? a[i] : b[i]);
  return out;
}

// ── Colour locus (Bl) — unchanged; the dex survives ──────────────────
/** Mendelian: a parent passes one of its two alleles at random. */
export function inheritAllele(g: Genotype, rng: Rng = Math.random): Allele {
  return g[rng() < 0.5 ? 0 : 1];
}

/** Cross two genotypes — each parent contributes one random allele. */
export function breedGenotype(a: Genotype, b: Genotype, rng: Rng = Math.random): Genotype {
  return [inheritAllele(a, rng), inheritAllele(b, rng)];
}

/**
 * Offspring color probabilities for a cross — the Punnett square on the Bl
 * locus. Each parent passes Bl with probability (its Bl count)/2; phenotype is
 * the blue-allele count (0 black, 1 blue, 2 splash). Powers the pair preview.
 */
export function colorOdds(a: Genotype, b: Genotype): Record<Color, number> {
  const pBl = (g: Genotype) => ((g[0] === 'Bl' ? 1 : 0) + (g[1] === 'Bl' ? 1 : 0)) / 2;
  const pa = pBl(a);
  const pb = pBl(b);
  const splash = pa * pb; // both pass Bl
  const black = (1 - pa) * (1 - pb); // neither passes Bl
  return { black, blue: 1 - splash - black, splash };
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

/** Re-export so callers don't reach into state for the gene list. */
export { GENES };
