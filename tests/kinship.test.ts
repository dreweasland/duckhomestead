import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { breedGenome, childAncestors, kinship, slotOdds } from '../src/game/genetics';
import { runBreeding } from '../src/game/breeding';
import { initialState, type Duck, type Genome } from '../src/game/state';
import { build, genome } from './helpers';

const K = BALANCE.GENOME.KINSHIP;

const duck = (id: string, ancestors?: string[]): { id: string; ancestors?: string[] } => ({ id, ancestors });

describe('kinship: computed from recorded lineage, never a flock lookup', () => {
  it('lineage-less ducks (seed flock, migrations) are unrelated', () => {
    expect(kinship(duck('a'), duck('b'))).toBe(0);
  });
  it('full siblings 0.5, half siblings 0.25', () => {
    expect(kinship(duck('a', ['p1', 'p2']), duck('b', ['p1', 'p2']))).toBe(K.FULL_SIB);
    expect(kinship(duck('a', ['p1', 'p2']), duck('b', ['p1', 'p3']))).toBe(K.HALF_SIB);
  });
  it('parent-child 0.25 (either direction)', () => {
    expect(kinship(duck('p1'), duck('kid', ['p1', 'p2']))).toBe(K.PARENT_CHILD);
    expect(kinship(duck('kid', ['p1', 'p2']), duck('p1'))).toBe(K.PARENT_CHILD);
  });
  it('a shared grandparent line reads 0.125 per link, capped', () => {
    // Cousins: parents differ, one grandparent shared.
    const a = duck('a', ['pa', 'pb', 'g1', 'g2']);
    const b = duck('b', ['pc', 'pd', 'g1', 'g3']);
    expect(kinship(a, b)).toBe(K.GRANDPARENT);
    // Aunt/uncle: a's parent is b's grandparent.
    expect(kinship(duck('a', ['g1', 'x']), duck('b', ['pc', 'pd', 'g1', 'g3']))).toBe(K.GRANDPARENT);
    // Grandparent-grandchild directly.
    expect(kinship(duck('g1'), duck('b', ['pc', 'pd', 'g1', 'g3']))).toBe(K.GRANDPARENT);
    // Many links cap out below sibling-level.
    const heavy = kinship(duck('a', ['pa', 'pb', 'g1', 'g2', 'g3', 'g4']), duck('b', ['pc', 'pd', 'g1', 'g2', 'g3', 'g4']));
    expect(heavy).toBe(Math.min(K.CAP, 4 * K.GRANDPARENT));
  });
  it('culling an ancestor cannot launder the relationship (no lookups by design)', () => {
    // The parents "p1"/"p2" exist nowhere — kinship still reads full-sib.
    expect(kinship(duck('a', ['p1', 'p2']), duck('b', ['p1', 'p2']))).toBe(K.FULL_SIB);
  });
});

describe('inbreeding depression in the cross (and its honest preview)', () => {
  const L6: Genome = genome('LLLLLL');

  it('breedGenome consumes no extra rng at kinship 0 (legacy streams unchanged)', () => {
    // Two rolls per slot (pick, no-mutation) — a third would misalign this rig.
    const rolls: number[] = [];
    const rng = () => {
      rolls.push(1);
      return 0.99;
    };
    breedGenome(L6, L6, rng, false, 0);
    expect(rolls.length).toBe(12);
  });

  it('a close-kin cross degrades slots to Dud; unrelated does not', () => {
    // rng per slot: pick 0.0 → parent a; mutation 0.99 → none; kin 0.0 → degrade.
    let i = 0;
    const seq = [0.0, 0.99, 0.0];
    const rng = () => seq[i++ % seq.length];
    const inbred = breedGenome(L6, L6, rng, false, K.FULL_SIB);
    expect(inbred.every((g) => g === 'D')).toBe(true);
    i = 0;
    const outbred = breedGenome(L6, L6, rng, false, 0);
    // kinship 0 consumes no kin roll, so the same seq covers pick+mutation cleanly
    expect(outbred.filter((g) => g === 'L').length).toBeGreaterThan(0);
  });

  it('slotOdds mirrors the degrade exactly (sums to 1, D absorbs the kin share)', () => {
    const clean = slotOdds(L6, L6, false, 0)[0];
    const kin = slotOdds(L6, L6, false, K.FULL_SIB)[0];
    const dud = K.FULL_SIB * K.DUD_CHANCE;
    const sum = (d: Record<string, number>) => Object.values(d).reduce((a, b) => a + b, 0);
    expect(sum(kin)).toBeCloseTo(1, 9);
    expect(kin.L).toBeCloseTo(clean.L * (1 - dud), 9);
    expect(kin.D).toBeCloseTo(clean.D * (1 - dud) + dud, 9);
  });
});

describe('hatches record their lineage', () => {
  it('a duckling carries [drake, hen, ...their parents]', () => {
    const s = build({ coop: 1 });
    s.ration = { ...BALANCE.NUTRITION.DEFAULT_RATION };
    const mk = (id: string, sex: Duck['sex'], ancestors?: string[]): Duck => ({
      id,
      genotype: ['Bl', 'bl'],
      genome: genome('LLLDDD'),
      genomeKnown: true,
      sex,
      stage: 'adult',
      ageTicks: 0,
      ancestors,
    });
    s.ducks = [mk('sire', 'drake', ['gpa', 'gma']), mk('dam', 'hen')];
    s.breedingPairs = [{ id: 'p1', drakeId: 'sire', henId: 'dam', clutchProgress: 0, incubating: [BALANCE.BREEDING.INCUBATE_S] }];
    s.resources.eggs = 1e6;
    runBreeding(s, 0.1, 1, 1);
    const hatched = s.ducks.find((d) => d.stage === 'duckling');
    expect(hatched).toBeDefined();
    expect(hatched!.ancestors).toEqual(['sire', 'dam', 'gpa', 'gma']);
    expect(childAncestors(s.ducks[0], s.ducks[1])).toEqual(['sire', 'dam', 'gpa', 'gma']);
    // Generation flavor: founders carry none (gen 0), so the hatch is G1.
    expect(hatched!.gen).toBe(1);
  });

  it('sibling hatches from the same pair read as full kin', () => {
    const a = duck('c1', ['sire', 'dam', 'gpa', 'gma']);
    const b = duck('c2', ['sire', 'dam', 'gpa', 'gma']);
    expect(kinship(a, b)).toBe(K.FULL_SIB);
  });

  it('pre-9b saves round-trip unrelated (no ancestry invented)', () => {
    const s = initialState(0);
    void s;
    expect(kinship(duck('a'), duck('b', ['x', 'y']))).toBe(0);
  });
});
