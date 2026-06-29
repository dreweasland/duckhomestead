import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import {
  axisScore,
  axisTier,
  breedGenome,
  breedGenotype,
  goodGeneCount,
  inheritAllele,
  layMult,
  maturationMult,
  recordColor,
  slotOdds,
  targetMatch,
  woundResistChance,
} from '../src/game/genetics';
import { phenotype, type Color, type Gene, type Genotype } from '../src/game/state';
import { initialState } from '../src/game/state';

const g = (s: string): Gene[] => s.split('') as Gene[];

/** Deterministic rng cycling through a fixed sequence. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('Mendelian inheritance', () => {
  it('inheritAllele picks each allele by a coin flip', () => {
    const g: Genotype = ['Bl', 'bl'];
    expect(inheritAllele(g, () => 0.2)).toBe('Bl'); // <0.5 -> first
    expect(inheritAllele(g, () => 0.8)).toBe('bl'); // >=0.5 -> second
  });

  it('Black (bl/bl) × Splash (Bl/Bl) → all Blue', () => {
    for (let i = 0; i < 50; i++) {
      const child = breedGenotype(['bl', 'bl'], ['Bl', 'Bl']);
      expect(phenotype(child)).toBe('blue');
    }
  });

  it('Blue × Blue → ~1 black : 2 blue : 1 splash', () => {
    const counts: Record<Color, number> = { black: 0, blue: 0, splash: 0 };
    const N = 20000;
    for (let i = 0; i < N; i++) {
      counts[phenotype(breedGenotype(['Bl', 'bl'], ['Bl', 'bl']))]++;
    }
    // expected fractions 0.25 / 0.5 / 0.25
    expect(counts.black / N).toBeCloseTo(0.25, 1);
    expect(counts.blue / N).toBeCloseTo(0.5, 1);
    expect(counts.splash / N).toBeCloseTo(0.25, 1);
  });

  it('Splash × Splash → always Splash (Bl/Bl fixed)', () => {
    for (let i = 0; i < 30; i++) {
      expect(phenotype(breedGenotype(['Bl', 'Bl'], ['Bl', 'Bl']))).toBe('splash');
    }
  });

  it('Black × Black → always Black', () => {
    for (let i = 0; i < 30; i++) {
      expect(phenotype(breedGenotype(['bl', 'bl'], ['bl', 'bl']))).toBe('black');
    }
  });

  it('a specific allele pass is reproducible from the rng', () => {
    // first parent passes allele[0]=Bl (rng<.5), second passes allele[1]=bl (rng>=.5)
    expect(breedGenotype(['Bl', 'bl'], ['Bl', 'bl'], seq([0.1, 0.9]))).toEqual(['Bl', 'bl']);
  });
});

describe('genome-derived stats (the profile, provably NOT one scalar)', () => {
  it('L drives egg output; all-Dud is the ×1.0 floor', () => {
    expect(layMult(g('DDDDDD'))).toBeCloseTo(1.0, 6);
    expect(layMult(g('LLLLLL'))).toBeGreaterThan(layMult(g('VVVVVV')));
    expect(layMult(g('HHHHHH'))).toBeCloseTo(1.0, 6); // Hardy adds no output
  });

  it('V drives maturation speed; L and H do not', () => {
    expect(maturationMult(g('VVVVVV'))).toBeGreaterThan(1);
    expect(maturationMult(g('LLLLLL'))).toBe(1);
    expect(maturationMult(g('HHHHHH'))).toBe(1);
  });

  it('H drives wound resistance (capped); L and V do not', () => {
    expect(woundResistChance(g('HHHHHH'))).toBeGreaterThan(0);
    expect(woundResistChance(g('HHHHHH'))).toBeLessThanOrEqual(BALANCE.GENOME.WOUND_RESIST_CAP);
    expect(woundResistChance(g('LLLLLL'))).toBe(0);
    expect(woundResistChance(g('VVVVVV'))).toBe(0);
  });

  it('"best duck" depends on the goal — there is no single ranking', () => {
    const layGod = g('LLLLLL');
    const tank = g('HHHHHH');
    expect(layMult(layGod)).toBeGreaterThan(layMult(tank)); // best layer
    expect(woundResistChance(tank)).toBeGreaterThan(woundResistChance(layGod)); // best survivor
  });

  it('goodGeneCount + targetMatch read the profile', () => {
    expect(goodGeneCount(g('LVHDDD'))).toBe(3);
    expect(targetMatch(g('LLLLLL'), g('LLLLLL'))).toBe(6);
    expect(targetMatch(g('LLLDDD'), g('LLLLLL'))).toBe(3);
  });
});

describe('crossbreeding: position-linked + dominance-weighted + mutation', () => {
  it('is position-linked: each offspring slot comes from a parent slot i', () => {
    // rng [choice, mutation] per slot. choice 0 → always parent a; mutation 0.99
    // → never mutate. So offspring == parent a, slot for slot.
    const a = g('LVHDLV');
    const b = g('DDDDDD');
    expect(breedGenome(a, b, seq([0, 0.99]))).toEqual(a);
    // choice 0.99 → parent b wins every slot.
    expect(breedGenome(a, b, seq([0.99, 0.99]))).toEqual(b);
  });

  it('dominance: a good gene out-passes a Dud at a contested slot', () => {
    // Cross all-L vs all-D: each slot is L (dom 3) vs D (dom 1) → P(L) ≈ 3/4.
    let lWins = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const child = breedGenome(g('LLLLLL'), g('DDDDDD'));
      lWins += child.filter((x) => x === 'L').length;
    }
    const pL = lWins / (N * 6);
    expect(pL).toBeGreaterThan(0.68); // ~0.73 after the small mutation smear
    expect(pL).toBeLessThan(0.78);
  });

  it('mutation: an offspring slot can become a gene neither parent has', () => {
    // Two all-Dud parents: only mutation can introduce a non-D gene (the escape
    // hatch). Force mutation every slot (mutation rng 0) to a non-D gene.
    const child = breedGenome(g('DDDDDD'), g('DDDDDD'), seq([0.5, 0, 0.0]));
    expect(child.some((x) => x !== 'D')).toBe(true);
  });

  it('slotOdds is a valid per-slot distribution that mirrors breedGenome', () => {
    const odds = slotOdds(g('LLLLLL'), g('DDDDDD'));
    expect(odds).toHaveLength(6);
    for (const dist of odds) {
      const sum = dist.L + dist.V + dist.H + dist.D;
      expect(sum).toBeCloseTo(1, 6);
    }
    // L (dom 3) vs D (dom 1): P(L) = (1-m)·3/4 + m·1/4.
    const m = BALANCE.GENOME.MUTATION_CHANCE;
    expect(odds[0].L).toBeCloseTo((1 - m) * 0.75 + m * 0.25, 6);
    expect(odds[0].D).toBeCloseTo((1 - m) * 0.25 + m * 0.25, 6);
    // and V/H only reachable by mutation here.
    expect(odds[0].V).toBeCloseTo(m * 0.25, 6);
  });

  it('combining COMPLEMENTARY parents can beat BOTH (the assembly puzzle)', () => {
    // drake strong in the first 3 slots, hen strong in the last 3. Position-linked
    // inheritance + dominance means an offspring can collect all 6 good genes —
    // richer than either parent (each only has 3).
    const drake = g('LLLDDD');
    const hen = g('DDDLLL');
    let best = 0;
    for (let i = 0; i < 400; i++) {
      best = Math.max(best, goodGeneCount(breedGenome(drake, hen)));
    }
    expect(goodGeneCount(drake)).toBe(3);
    expect(goodGeneCount(hen)).toBe(3);
    expect(best).toBeGreaterThan(3); // an offspring richer than either parent
  });
});

describe('phenotype band (free, coarse, intrinsic — the phone-it-in floor)', () => {
  const TIERS = BALANCE.PHENOTYPE.TIERS;

  it('all-of-axis reads top tier, all-Dud reads bottom — clearly different', () => {
    expect(axisTier(g('LLLLLL'), 'lay')).toBe(TIERS - 1);
    expect(axisTier(g('DDDDDD'), 'lay')).toBe(0);
    expect(axisTier(g('LLLLLL'), 'lay')).toBeGreaterThan(axisTier(g('DDDDDD'), 'lay'));
    // a maxed axis scores 1.0, a dud 0.
    expect(axisScore(g('LLLLLL'), 'lay')).toBeCloseTo(1, 6);
    expect(axisScore(g('DDDDDD'), 'lay')).toBe(0);
  });

  it('reads the right axis: a Vigor genome is a strong vigor / weak lay+hardy band', () => {
    expect(axisTier(g('VVVVVV'), 'vigor')).toBe(TIERS - 1);
    expect(axisTier(g('VVVVVV'), 'hardy')).toBe(0);
    // Hardy genome: top hardy, no lay/vigor.
    expect(axisTier(g('HHHHHH'), 'hardy')).toBe(TIERS - 1);
    expect(axisTier(g('HHHHHH'), 'lay')).toBe(0);
  });

  it('is COARSE: middling genomes spread but never expose exact good-gene counts', () => {
    // 3 different genomes with the same lay-gene count can share a lay tier (coarse),
    // while clearly distinct genomes separate — the band buckets, it does not count.
    const a = axisTier(g('LLLDDD'), 'lay');
    expect(a).toBeGreaterThan(axisTier(g('DDDDDD'), 'lay'));
    expect(a).toBeLessThan(axisTier(g('LLLLLL'), 'lay'));
  });

  it('is INTRINSIC: the band is a pure function of the genome (ignores live state)', () => {
    // axisTier takes only the genome — no nutrition/water/module inputs exist, so a
    // starving high-genome duck and a well-fed one read identically.
    const gem = g('LLLLLL');
    expect(axisTier(gem, 'lay')).toBe(axisTier([...gem], 'lay'));
    // and a high-genome duck out-bands a dud regardless of any feed multiplier — the
    // band never multiplies by output, it reads the STAT_PER_GENE ceiling.
    expect(axisTier(g('LLLLLL'), 'lay')).toBeGreaterThan(axisTier(g('DDDDDD'), 'lay'));
  });
});

describe('color dex', () => {
  it('records first-of-color and reports the milestone', () => {
    const s = initialState(0);
    expect(recordColor(s, 'splash')).toBe(true); // first ever
    expect(s.dexSeen).toContain('splash');
    expect(recordColor(s, 'splash')).toBe(false); // already seen
  });
});
