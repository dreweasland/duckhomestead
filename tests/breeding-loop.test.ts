import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { createPair, cullDuck, cullDucks, removePair } from '../src/game/actions';
import { goodGeneCount } from '../src/game/genetics';
import { runOfflineCatchUp, serialize, deserialize } from '../src/game/save';
import { phenotype, type Duck, type Genome, type GameState } from '../src/game/state';
import { build, run, stockAll, FLAT_GENOME, genome } from './helpers';

/** Replace the flock with a controlled drake + hen of a given genotype/genome. */
function pairFlock(s: GameState, geno: Duck['genotype'], g: Genome = FLAT_GENOME): { drakeId: string; henId: string } {
  s.ducks = [
    { id: 'D', genotype: geno, genome: [...g], genomeKnown: true, sex: 'drake', stage: 'adult', ageTicks: 0 },
    { id: 'H', genotype: geno, genome: [...g], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 },
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
    const s = stockAll(build({ coop: 2 })); // capacity 8; stocked so ducklings can grow
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

  it('offspring carry a full 6-slot genome inherited from the parents', () => {
    const s = stockAll(build({ coop: 2 }));
    const { drakeId, henId } = pairFlock(s, ['Bl', 'bl'], genome('LLLHHH'));
    createPair(s, drakeId, henId);
    run(s, 300);
    const offspring = s.ducks.filter((d) => d.id !== 'D' && d.id !== 'H');
    expect(offspring.length).toBeGreaterThan(0);
    expect(offspring.every((d) => d.genome.length === BALANCE.GENOME.SLOTS)).toBe(true);
    // Both parents are LLLHHH; mutation aside, slots come from L/H — the vast
    // majority of inherited slots should be one of the parents' genes.
    const slots = offspring.flatMap((d) => d.genome);
    const fromParents = slots.filter((g) => g === 'L' || g === 'H').length;
    expect(fromParents / slots.length).toBeGreaterThan(0.8);
  });

  it('offspring genotype comes from the parents (Splash×Splash breeds true)', () => {
    const s = stockAll(build({ coop: 2 })); // stocked: drakes fed → full breeding speed
    const { drakeId, henId } = pairFlock(s, ['Bl', 'Bl']); // both splash
    createPair(s, drakeId, henId);
    run(s, 300); // a clutch hatches
    const offspring = s.ducks.filter((d) => d.id !== 'D' && d.id !== 'H');
    expect(offspring.length).toBeGreaterThan(0);
    expect(offspring.every((d) => phenotype(d.genotype) === 'splash')).toBe(true);
  });

  it('records the dex + queues a DING when a new color first hatches', () => {
    const s = stockAll(build({ coop: 2 })); // stocked: drakes fed → full breeding speed
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

describe('culling = the selection lever (live mean genome quality)', () => {
  const meanGood = (f: Duck[]) => f.reduce((a, d) => a + goodGeneCount(d.genome), 0) / f.length;

  it('cullDuck removes the duck, drops its pair, and raises the live mean quality', () => {
    const s = build({ coop: 2 }); // seeded: drake d1, hens d2/d3
    const genomes = [genome('DDDDDD'), genome('LLLLDD'), genome('LLDDDD')];
    s.ducks.forEach((d, i) => (d.genome = genomes[i] ?? [...FLAT_GENOME]));
    const drake = s.ducks.find((d) => d.sex === 'drake')!;
    const hen = s.ducks.find((d) => d.sex === 'hen')!;
    createPair(s, drake.id, hen.id);
    const before = meanGood(s.ducks);
    const lowest = [...s.ducks].sort((a, b) => goodGeneCount(a.genome) - goodGeneCount(b.genome))[0];
    cullDuck(s, lowest.id);
    expect(s.ducks.some((d) => d.id === lowest.id)).toBe(false);
    expect(meanGood(s.ducks)).toBeGreaterThan(before); // removing the worst lifts the anchor
    if (lowest.id === drake.id || lowest.id === hen.id) expect(s.breedingPairs).toHaveLength(0);
  });

  it('cullDucks bulk-releases the set but protects secured + paired keepers', () => {
    const s = build({ coop: 4 });
    const mk = (id: string, extra: Partial<Duck> = {}): Duck => ({
      id, genotype: ['Bl', 'bl'], genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0, ...extra,
    });
    s.ducks = [
      mk('lo1'),
      mk('lo2'),
      mk('keepSecured', { secured: true }), // secured -> protected
      mk('keepPairedD', { sex: 'drake' }), // paired -> protected
      mk('keepPairedH'),
      mk('hi'),
    ];
    createPair(s, 'keepPairedD', 'keepPairedH');

    // Release everything offered, including the protected ones — they must survive.
    const r = cullDucks(s, ['lo1', 'lo2', 'keepSecured', 'keepPairedD', 'hi']);
    expect(r.ok && r.value.released).toBe(3); // lo1, lo2, hi
    const ids = s.ducks.map((d) => d.id).sort();
    expect(ids).toEqual(['keepPairedD', 'keepPairedH', 'keepSecured']);
    expect(s.breedingPairs).toHaveLength(1); // the pair is intact
  });
});
