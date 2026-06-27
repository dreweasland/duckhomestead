import { describe, it, expect } from 'vitest';
import { breedGenotype, inheritAllele, recordColor } from '../src/game/genetics';
import { phenotype, type Color, type Genotype } from '../src/game/state';
import { initialState } from '../src/game/state';

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

describe('color dex', () => {
  it('records first-of-color and reports the milestone', () => {
    const s = initialState(0);
    expect(recordColor(s, 'splash')).toBe(true); // first ever
    expect(s.dexSeen).toContain('splash');
    expect(recordColor(s, 'splash')).toBe(false); // already seen
  });
});
