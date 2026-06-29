import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import {
  breedGenotype,
  goodGeneCount,
  inheritAllele,
  layMult,
  maturationMult,
  recordColor,
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

describe('color dex', () => {
  it('records first-of-color and reports the milestone', () => {
    const s = initialState(0);
    expect(recordColor(s, 'splash')).toBe(true); // first ever
    expect(s.dexSeen).toContain('splash');
    expect(recordColor(s, 'splash')).toBe(false); // already seen
  });
});
