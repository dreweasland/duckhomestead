import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import {
  phenotype,
  seedFlock,
  coopCapacity,
  adultDucks,
  adultLayers,
  initialState,
  type Genotype,
} from '../src/game/state';
import { placeStation } from '../src/game/actions';
import { serialize, deserialize } from '../src/game/save';
import { build } from './helpers';

describe('Bl-locus phenotype', () => {
  it('maps blue-allele count to color', () => {
    expect(phenotype(['bl', 'bl'])).toBe('black');
    expect(phenotype(['Bl', 'bl'])).toBe('blue');
    expect(phenotype(['bl', 'Bl'])).toBe('blue');
    expect(phenotype(['Bl', 'Bl'])).toBe('splash');
  });
});

describe('seed flock', () => {
  it('seeds Blue carriers (drakes + hens) and records the dex', () => {
    const s = initialState(0);
    seedFlock(s);
    const B = BALANCE.BREEDING;
    expect(s.ducks).toHaveLength(B.SEED_DRAKES + B.SEED_HENS);
    expect(s.ducks.every((d) => phenotype(d.genotype) === 'blue')).toBe(true);
    expect(s.ducks.filter((d) => d.sex === 'drake')).toHaveLength(B.SEED_DRAKES);
    expect(s.ducks.filter((d) => d.sex === 'hen')).toHaveLength(B.SEED_HENS);
    expect(s.ducks.every((d) => d.stage === 'adult')).toBe(true);
    expect(s.dexSeen).toContain('blue');
  });

  it('the first coop placed seeds the flock; later coops do not re-seed', () => {
    const s = initialState(0);
    s.resources.eggs = 1000;
    placeStation(s, 'coop', 0, 0);
    const n = s.ducks.length;
    expect(n).toBeGreaterThan(0);
    placeStation(s, 'coop', 1, 0);
    expect(s.ducks).toHaveLength(n); // no duplicate seeding
  });
});

describe('housing capacity', () => {
  it('scales with coop count and level', () => {
    const s = build({ coop: 2 });
    expect(coopCapacity(s)).toBe(2 * BALANCE.BREEDING.COOP_CAPACITY);
    s.stations.find((x) => x.type === 'coop')!.level = 3;
    expect(coopCapacity(s)).toBe((3 + 1) * BALANCE.BREEDING.COOP_CAPACITY);
  });
});

describe('adult selectors', () => {
  it('adultLayers are adult hens; adultDucks are all adults', () => {
    const s = build({ coop: 1 }); // seeded: 1 drake + 2 hens, all adult
    expect(adultDucks(s).length).toBe(3);
    expect(adultLayers(s).length).toBe(2);
    s.ducks.push({ id: 'x', genotype: ['bl', 'bl'] as Genotype, vigor: 1, sex: 'hen', stage: 'duckling', ageTicks: 0 });
    expect(adultLayers(s).length).toBe(2); // ducklings don't lay
  });
});

describe('save round-trip', () => {
  it('preserves the flock + dex + id counter', () => {
    const s = build({ coop: 1 });
    s.ducks[0].vigor = 1.37;
    s.ducks[0].genotype = ['Bl', 'Bl'];
    const r = deserialize(serialize(s), 0);
    expect(r.ducks).toEqual(s.ducks);
    expect(r.nextDuckId).toBe(s.nextDuckId);
    expect(r.dexSeen).toEqual(s.dexSeen);
  });

  it('migrates a pre-breeding save (coops, no ducks) by seeding', () => {
    const legacy = JSON.stringify({
      version: 1,
      stations: [{ id: 'c1', type: 'coop', x: 0, y: 0, level: 1 }],
      resources: { eggs: 50 },
    });
    const r = deserialize(legacy, 0);
    expect(r.ducks.length).toBeGreaterThan(0);
  });
});
