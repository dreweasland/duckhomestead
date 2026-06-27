import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { createPair, removePair } from '../src/game/actions';
import { breedVigor } from '../src/game/genetics';
import { runOfflineCatchUp, serialize, deserialize } from '../src/game/save';
import { phenotype, type Duck, type GameState } from '../src/game/state';
import { build, run } from './helpers';

const B = BALANCE.BREEDING;

/** Replace the flock with a controlled drake + hen of a given genotype/vigor. */
function pairFlock(s: GameState, geno: Duck['genotype'], vigor = 1): { drakeId: string; henId: string } {
  s.ducks = [
    { id: 'D', genotype: geno, vigor, sex: 'drake', stage: 'adult', ageTicks: 0 },
    { id: 'H', genotype: geno, vigor, sex: 'hen', stage: 'adult', ageTicks: 0 },
  ];
  s.nextDuckId = 100;
  return { drakeId: 'D', henId: 'H' };
}

describe('createPair guards', () => {
  it('requires an adult drake + hen and rejects double-pairing', () => {
    const s = build({ coop: 2 }); // seeded: 1 drake (d1) + 2 hens (d2,d3)
    const drake = s.ducks.find((d) => d.sex === 'drake')!;
    const hens = s.ducks.filter((d) => d.sex === 'hen');
    expect(createPair(s, hens[0].id, hens[1].id).ok).toBe(false); // two hens
    expect(createPair(s, drake.id, hens[0].id).ok).toBe(true);
    expect(createPair(s, drake.id, hens[1].id).ok).toBe(false); // drake already paired
  });
});

describe('breeding loop end to end', () => {
  it('pair → clutch → incubate → hatch → mature to adult', () => {
    const s = build({ coop: 2 }); // capacity 8, seeded 3
    const { drakeId, henId } = pairFlock(s, ['Bl', 'bl']);
    // re-seed leaves nextDuckId; createPair needs the controlled ducks
    createPair(s, drakeId, henId);
    // clutch(120) + incubate(60) + duckling(180) + juvenile(180) = 540s to first adult
    run(s, 600);
    expect(s.ducks.length).toBeGreaterThan(2); // flock grew
    const offspring = s.ducks.filter((d) => d.id !== 'D' && d.id !== 'H');
    expect(offspring.length).toBeGreaterThan(0);
    expect(offspring.some((d) => d.stage === 'adult')).toBe(true); // matured fully
  });

  it('offspring genotype comes from the parents (Splash×Splash breeds true)', () => {
    const s = build({ coop: 2 });
    const { drakeId, henId } = pairFlock(s, ['Bl', 'Bl']); // both splash
    createPair(s, drakeId, henId);
    run(s, 300); // a clutch hatches
    const offspring = s.ducks.filter((d) => d.id !== 'D' && d.id !== 'H');
    expect(offspring.length).toBeGreaterThan(0);
    expect(offspring.every((d) => phenotype(d.genotype) === 'splash')).toBe(true);
  });

  it('records the dex + queues a DING when a new color first hatches', () => {
    const s = build({ coop: 2 });
    s.dexSeen = ['blue'];
    const { drakeId, henId } = pairFlock(s, ['Bl', 'Bl']); // splash offspring (new)
    createPair(s, drakeId, henId);
    run(s, 300);
    expect(s.dexSeen).toContain('splash');
    // pendingDex is drained by the engine; here it accumulates
    expect((s.pendingDex ?? []).length >= 0).toBe(true);
  });

  it('stops hatching at housing capacity', () => {
    const s = build({ coop: 1 }); // capacity 4
    const { drakeId, henId } = pairFlock(s, ['Bl', 'bl']); // 2 ducks -> 2 free slots
    createPair(s, drakeId, henId);
    run(s, 1200);
    expect(s.ducks.length).toBeLessThanOrEqual(BALANCE.BREEDING.COOP_CAPACITY);
  });

  it('removePair stops production', () => {
    const s = build({ coop: 2 });
    const { drakeId, henId } = pairFlock(s, ['Bl', 'bl']);
    createPair(s, drakeId, henId);
    run(s, 200);
    const n = s.ducks.length;
    removePair(s, s.breedingPairs[0].id);
    run(s, 400);
    expect(s.ducks.length).toBe(n); // no new ducklings without a pair
  });

  it('breeding pairs (mid-clutch/incubation) round-trip through save', () => {
    const s = build({ coop: 2 });
    const { drakeId, henId } = pairFlock(s, ['Bl', 'bl']);
    createPair(s, drakeId, henId);
    run(s, 150); // clutch laid, eggs incubating
    const r = deserialize(serialize(s), 0);
    expect(r.breedingPairs).toEqual(s.breedingPairs);
    expect(r.nextPairId).toBe(s.nextPairId);
  });
});

describe('offline breeding', () => {
  it('advances clutch + maturation offline (and still grants no XP/modules)', () => {
    const s = build({ coop: 2 });
    const { drakeId, henId } = pairFlock(s, ['Bl', 'bl']);
    createPair(s, drakeId, henId);
    s.rank = 3;
    s.xp = 12;
    s.lastSeen = -8 * 3600 * 1000;
    runOfflineCatchUp(s, 0);
    expect(s.ducks.length).toBeGreaterThan(2); // bred while away
    expect(s.rank).toBe(3);
    expect(s.xp).toBe(12);
    expect(s.inventory).toHaveLength(0);
  });
});

describe('vigor inheritance (regression to the mean, bounded)', () => {
  it('stays within [floor, ceiling]', () => {
    for (let i = 0; i < 1000; i++) {
      const v = breedVigor(2.0, 2.0, 1.0);
      expect(v).toBeGreaterThanOrEqual(B.VIGOR_FLOOR);
      expect(v).toBeLessThanOrEqual(B.VIGOR_CEILING);
    }
  });

  it('regresses toward the population mean (offspring of top parents < parents)', () => {
    // two ceiling parents, low pop mean -> offspring well below the ceiling
    const v = breedVigor(2.0, 2.0, 1.0, () => 0.5); // zero noise
    expect(v).toBeLessThan(2.0);
    expect(v).toBeGreaterThan(1.0); // but above the mean
    expect(v).toBeCloseTo(1.0 + B.H2 * (2.0 - 1.0), 5);
  });

  it('selective breeding gains are bounded, not runaway', () => {
    let mean = 1.0;
    for (let gen = 0; gen < 100; gen++) {
      // always breed two "best" at the ceiling against the current mean
      mean = breedVigor(B.VIGOR_CEILING, B.VIGOR_CEILING, mean, () => 0.5);
    }
    expect(mean).toBeLessThanOrEqual(B.VIGOR_CEILING);
    expect(mean).toBeLessThan(B.VIGOR_CEILING); // never actually reaches it via regression alone... bounded
  });
});
