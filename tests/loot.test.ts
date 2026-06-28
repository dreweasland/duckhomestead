import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { RARITIES, type Module, type ModuleStat } from '../src/game/state';
import {
  appliedBonus,
  moduleFits,
  rackBonus,
  rollRarity,
  rollMagnitude,
  STAT_CATEGORIES,
} from '../src/game/loot';
import { build } from './helpers';

const L = BALANCE.LOOT;
const mod = (stat: ModuleStat, magnitude: number): Module => ({ id: 'x', stat, rarity: 'common', magnitude });

describe('soft-cap stacking', () => {
  it('is additive but diminishing and never exceeds the cap', () => {
    const cap = 0.6;
    const one = appliedBonus(0.2, cap);
    const two = appliedBonus(0.4, cap);
    expect(two).toBeGreaterThan(one); // more modules -> more bonus
    expect(two - one).toBeLessThan(one); // ...but diminishing
    expect(appliedBonus(2, cap)).toBeLessThan(cap); // a finite stack stays under
    expect(appliedBonus(100, cap)).toBeLessThanOrEqual(cap); // asymptote: never above
    expect(appliedBonus(100, cap)).toBeGreaterThan(cap * 0.99);
    expect(appliedBonus(0, cap)).toBe(0);
  });

  it('a legendary stacked many times still cannot run away past the cap', () => {
    const s = build({ plot: 1 });
    s.rack = Array.from({ length: 8 }, () => mod('stationYield', 0.5));
    expect(rackBonus(s, 'stationYield')).toBeLessThan(L.SOFT_CAP.stationYield);
  });
});

describe('category fit', () => {
  it('speed/yield fit production, eggOutput/conditionRegen fit coops, tend fits both', () => {
    expect(moduleFits('stationSpeed', 'plot')).toBe(true);
    expect(moduleFits('stationSpeed', 'coop')).toBe(false);
    expect(moduleFits('eggOutput', 'coop')).toBe(true);
    expect(moduleFits('eggOutput', 'plot')).toBe(false);
    expect(moduleFits('conditionRegen', 'coop')).toBe(true);
    expect(moduleFits('tendPower', 'mealwormFarm')).toBe(true);
    expect(moduleFits('tendPower', 'coop')).toBe(true);
  });

  it('every stat is only a throughput lever (never nutrition)', () => {
    const nutritionWords = ['requirement', 'matrix', 'satisfaction', 'throttle'];
    for (const stat of Object.keys(STAT_CATEGORIES)) {
      expect(nutritionWords.some((w) => stat.toLowerCase().includes(w))).toBe(false);
    }
  });
});

describe('rolls', () => {
  it('rarity roll respects the weighted table (common most likely)', () => {
    let rng = 0;
    const seq = () => rng; // deterministic
    rng = 0.0001;
    expect(rollRarity(seq)).toBe('common');
    rng = 0.999;
    expect(rollRarity(seq)).toBe('legendary');
  });

  it('magnitude rolls land inside the rarity band', () => {
    for (const r of RARITIES) {
      const [min, max] = L.RARITY_BAND[r];
      expect(rollMagnitude(r, () => 0)).toBeCloseTo(min, 6);
      expect(rollMagnitude(r, () => 0.999999)).toBeLessThanOrEqual(max);
      expect(rollMagnitude(r, () => 0.5)).toBeGreaterThanOrEqual(min);
    }
  });
});
