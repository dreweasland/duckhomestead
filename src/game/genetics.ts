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
  const p: Record<Gene, number> = { L: 0, V: 0, H: 0, D: 0, P: 0 };
  for (const gene of genome) p[gene] += 1;
  return p;
}

/**
 * A duck's egg-output multiplier — REPLACES the old vigor scalar in the per-duck
 * output chain (nutrition.ts). L drives most of it; V adds a smaller bump; H/D
 * add nothing. A genome of all-Dud lays at the ×1.0 floor; an all-Lay truebred
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

/**
 * Phase 6d: a duck's WINTER output multiplier from Hardy genes — where H finally
 * pays economically ("best duck is contextual", delivered). Counts literal H
 * genes only: Prime's wildcard applies to TARGET-matching, never to expressed
 * stats (P carries its own modest woundResist instead). Throughput-only.
 */
export function hardinessMult(genome: Genome): number {
  let h = 0;
  for (const g of genome) if (g === 'H') h += 1;
  return 1 + BALANCE.WINTER.HARDINESS_PER_H * h;
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

// ── Phenotype band: free, coarse, INTRINSIC (the phone-it-in floor) ──
/** The three observable performance axes a duck's band reports. */
export type PhenoAxis = 'lay' | 'vigor' | 'hardy';
type AxisStat = 'eggOutput' | 'maturationSpeed' | 'woundResist';
const AXIS_STAT: Record<PhenoAxis, AxisStat> = {
  lay: 'eggOutput',
  vigor: 'maturationSpeed',
  hardy: 'woundResist',
};
export const PHENO_AXES: PhenoAxis[] = ['lay', 'vigor', 'hardy'];

/** Best single-gene contribution to a stat (the per-slot ceiling) — the
 *  normaliser so a genome maxed on this axis scores 1.0. */
function maxStatPerGene(stat: AxisStat): number {
  return Math.max(0, ...GENES.map((g) => G.STAT_PER_GENE[g]?.[stat] ?? 0));
}

/**
 * Intrinsic 0..1 potential of a genome on an axis — read straight off the
 * STAT_PER_GENE profile, so it reflects the genome's CEILING, never its live
 * (nutrition/water/module-scaled) output. all-of-the-axis-gene → 1.0; all-Dud → 0.
 */
export function axisScore(genome: Genome, axis: PhenoAxis): number {
  const stat = AXIS_STAT[axis];
  const max = maxStatPerGene(stat) * genome.length;
  if (max <= 0) return 0;
  return Math.min(1, sumStat(genome, stat) / max);
}

/**
 * Coarse band tier (0..PHENOTYPE.TIERS-1) for an axis — the free, always-visible
 * read. Bucketed via AXIS_THRESHOLDS; deliberately lossy so it can never be
 * inverted back to the exact genome (which stays gene-reader-gated).
 */
export function axisTier(genome: Genome, axis: PhenoAxis): number {
  const score = axisScore(genome, axis);
  return BALANCE.PHENOTYPE.AXIS_THRESHOLDS.reduce((n, t) => n + (score >= t ? 1 : 0), 0);
}

/** Whether a genome slot counts as matching a wanted gene — the ONE rule for
 *  "does this gene satisfy this target/spec slot", shared by every place a
 *  genome is judged against a profile (targetMatch below AND the Grange's
 *  hatch-spec check, contracts.ts onHatch) so they can't drift. Prime (`P`) is
 *  a WILDCARD: it counts as matching ANY wanted gene. */
export function slotMatches(gene: Gene, want: Gene): boolean {
  return gene === 'P' || gene === want;
}

/** Slots matching the target profile (0..SLOTS) — distance-to-truebred,
 *  inverted. A Prime slot counts as a match against ANY target gene (the
 *  wildcard) — meanQuality/isTruebred inherit this for free. */
export function targetMatch(genome: Genome, target: Genome): number {
  let n = 0;
  for (let i = 0; i < genome.length; i++) if (slotMatches(genome[i], target[i])) n += 1;
  return n;
}

/** True iff this genome exactly matches the target (a truebred). */
export function isTruebred(genome: Genome, target: Genome): boolean {
  return genome.length === target.length && targetMatch(genome, target) === target.length;
}

// ── Inheritance ──────────────────────────────────────────────────────
/**
 * Cross two genomes into an offspring genome — the assembly puzzle. Three rules:
 *   1. POSITION-LINKED: offspring slot i inherits from one parent's slot i (never
 *      a reshuffle), so you build a truebred by pairing parents each strong in
 *      DIFFERENT slots.
 *   2. DOMINANCE-WEIGHTED: which parent wins slot i is a weighted coin — a good
 *      gene (DOMINANCE) is likelier to pass than a Dud, so the cross is plannable
 *      (pairing complementary parents reliably lifts the offspring).
 *   3. PER-SLOT MUTATION: a small chance the slot is replaced by a uniformly
 *      random gene — the occasional upgrade, and the escape hatch from a flock of
 *      two-Dud parents.
 */
/**
 * `primeEligible` (Phase 6c: state.legacyTier >= GENOME.PRIME_MIN_TIER) gates a
 * MUTATION roll toward the Prime wildcard: with prob PRIME_MUTATION_SHARE it
 * becomes 'P' instead of the ordinary uniform {L,V,H,D} mutation. Ineligible
 * (or a plain miss) mutates exactly as before — 'P' NEVER appears otherwise
 * (never seeded, never a hatch-spec/target gene). Must mirror slotOdds exactly
 * (see the preview-mirror test) so the odds preview never lies.
 */
export function breedGenome(a: Genome, b: Genome, rng: Rng = Math.random, primeEligible = false): Genome {
  const dom = G.DOMINANCE;
  const genes = G.GENES;
  const out: Genome = [];
  for (let i = 0; i < a.length; i++) {
    const ga = a[i];
    const gb = b[i];
    const wa = dom[ga] ?? 1;
    const wb = dom[gb] ?? 1;
    let gene: Gene = rng() * (wa + wb) < wa ? ga : gb;
    if (rng() < G.MUTATION_CHANCE) {
      gene = primeEligible && rng() < G.PRIME_MUTATION_SHARE ? 'P' : ((genes[Math.floor(rng() * genes.length)] as Gene) ?? gene);
    }
    out.push(gene);
  }
  return out;
}

/**
 * Per-slot offspring gene probabilities for a cross — the in-game crossbreed
 * calculator. For each slot, returns P(gene) over {L,V,H,D} combining the
 * dominance-weighted parent pick with the per-slot mutation smear. Mirrors
 * breedGenome exactly, so the preview never lies. Both parents' genomes must be
 * known to the caller (a "?" genome can't be previewed).
 */
export function slotOdds(a: Genome, b: Genome, primeEligible = false): Record<Gene, number>[] {
  const dom = G.DOMINANCE;
  const m = G.MUTATION_CHANCE;
  const genes = G.GENES; // the uniform-mutation pool — excludes P by design
  const primeShare = primeEligible ? G.PRIME_MUTATION_SHARE : 0;
  const out: Record<Gene, number>[] = [];
  for (let i = 0; i < a.length; i++) {
    const ga = a[i];
    const gb = b[i];
    const wa = dom[ga] ?? 1;
    const wb = dom[gb] ?? 1;
    const pa = wa / (wa + wb);
    const pb = wb / (wa + wb);
    const dist: Record<Gene, number> = { L: 0, V: 0, H: 0, D: 0, P: 0 };
    dist[ga] += (1 - m) * pa; // parent a wins this slot (no mutation)
    dist[gb] += (1 - m) * pb; // parent b wins this slot (no mutation)
    dist.P += m * primeShare; // mutation → Prime (eligible crosses only)
    const uniformShare = m * (1 - primeShare);
    for (const gn of genes) dist[gn] += uniformShare / genes.length; // mutation: uniform over {L,V,H,D}
    out.push(dist);
  }
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
