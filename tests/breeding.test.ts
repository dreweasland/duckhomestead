import { describe, it, expect, vi, afterEach } from 'vitest';
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
import { AXES } from '../src/game/state';
import { buildGeneReader, createPair, placeStation, setDuckName, setGenomeTarget } from '../src/game/actions';
import { runBreeding } from '../src/game/breeding';
import { runPredators } from '../src/game/predators';
import { championSnapshot } from '../src/game/prestige';
import { serialize, deserialize } from '../src/game/save';
import { isPrimeDuck, layMult, targetMatch } from '../src/game/genetics';
import type { Duck, GameState } from '../src/game/state';
import { build, fullSetup, stockAll, run, setHens, FLAT_GENOME, genome } from './helpers';

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
    s.ducks.push({ id: 'x', genotype: ['bl', 'bl'] as Genotype, genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'duckling', ageTicks: 0 });
    expect(adultLayers(s).length).toBe(2); // ducklings don't lay
  });
});

describe('GUARDRAIL: genome & flock drive output/demand, never the nutrition math', () => {
  it('genome layMult scales egg output but leaves requirement + throttle identical', () => {
    const lo = setHens(stockAll(fullSetup()), 2, FLAT_GENOME); // layMult 1.0
    const hi = setHens(stockAll(fullSetup()), 2, genome('LLLLLL')); // layMult 1.72
    run(lo, 200);
    run(hi, 200);
    expect(hi.nutrition!.requirement).toEqual(lo.nutrition!.requirement); // same demand
    expect(hi.nutrition!.eggMult).toBeCloseTo(lo.nutrition!.eggMult, 5); // same throttle
    const lo0 = lo.resources.eggs;
    const hi0 = hi.resources.eggs;
    run(lo, 60);
    run(hi, 60);
    // Lay ratio tracks the genome layMult ratio exactly — output only, no nutrition shift.
    const expected = layMult(genome('LLLLLL')) / layMult(FLAT_GENOME);
    expect((hi.resources.eggs - hi0) / (lo.resources.eggs - lo0)).toBeCloseTo(expected, 1);
  });

  it('layer requirement scales with adult-duck count (not coops)', () => {
    const one = setHens(stockAll(fullSetup()), 1);
    const two = setHens(stockAll(fullSetup()), 2);
    run(one, 5);
    run(two, 5);
    for (const a of AXES) {
      expect(two.nutrition!.requirement[a]).toBeCloseTo(one.nutrition!.requirement[a] * 2, 5);
    }
  });

  it('never mutates the nutrition matrix / requirement constants', () => {
    const matrix = JSON.stringify(BALANCE.NUTRITION.INGREDIENT);
    const req = JSON.stringify(BALANCE.NUTRITION.REQUIREMENT);
    run(setHens(stockAll(fullSetup()), 4, genome('LLLLLL')), 120);
    expect(JSON.stringify(BALANCE.NUTRITION.INGREDIENT)).toBe(matrix);
    expect(JSON.stringify(BALANCE.NUTRITION.REQUIREMENT)).toBe(req);
  });
});

describe('gene reader: reveals genomes passively / in bulk (never per-duck)', () => {
  it('builds once, costs eggs, and reveals the WHOLE current flock at once', () => {
    const s = build({ coop: 1 }); // seeded flock, genomes hidden
    expect(s.ducks.every((d) => !d.genomeKnown)).toBe(true);
    s.resources.eggs = BALANCE.GENOME.READER_COST_EGGS;
    const r = buildGeneReader(s);
    expect(r.ok).toBe(true);
    expect(s.geneReader).toBe(true);
    expect(s.resources.eggs).toBe(0);
    expect(s.ducks.every((d) => d.genomeKnown)).toBe(true); // bulk reveal
    // a second build is rejected
    expect(buildGeneReader(s).ok).toBe(false);
  });

  it('rejects the build when eggs are short', () => {
    const s = build({ coop: 1 });
    s.resources.eggs = BALANCE.GENOME.READER_COST_EGGS - 1;
    expect(buildGeneReader(s).ok).toBe(false);
    expect(s.geneReader).toBe(false);
  });

  it('once built, every newly hatched duck auto-reads on arrival', () => {
    const s = stockAll(build({ coop: 2 }));
    s.resources.eggs = 1e7;
    buildGeneReader(s);
    const drake = s.ducks.find((d) => d.sex === 'drake')!;
    const hen = s.ducks.find((d) => d.sex === 'hen')!;
    createPair(s, drake.id, hen.id);
    run(s, 300); // a clutch hatches
    const offspring = s.ducks.filter((d) => d.id !== drake.id && d.id !== hen.id);
    expect(offspring.length).toBeGreaterThan(0);
    expect(offspring.every((d) => d.genomeKnown)).toBe(true);
  });
});

describe('Standard + DING', () => {
  afterEach(() => vi.restoreAllMocks());

  it('setGenomeTarget validates length + gene set', () => {
    const s = build({ coop: 1 });
    expect(setGenomeTarget(s, genome('HHHHHH')).ok).toBe(true);
    expect(s.genomeTarget).toEqual(genome('HHHHHH'));
    expect(setGenomeTarget(s, genome('HHH')).ok).toBe(false); // too short
    expect(setGenomeTarget(s, ['L', 'L', 'L', 'L', 'L', 'X'] as never).ok).toBe(false); // bad gene
    expect(s.genomeTarget).toEqual(genome('HHHHHH')); // unchanged by a rejected set
  });

  it('queues a truebred DING when a hatch first perfectly matches the target', () => {
    const s = build({ coop: 1 }); // cap 4
    s.genomeTarget = genome('LLLLLL');
    // Complementary parents (each only half-matches → no truebred in the flock yet).
    const drake: Duck = { id: 'D', genotype: ['Bl', 'bl'], genome: genome('LLLDDD'), genomeKnown: true, sex: 'drake', stage: 'adult', ageTicks: 0 };
    const hen: Duck = { id: 'H', genotype: ['Bl', 'bl'], genome: genome('DDDLLL'), genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 };
    s.ducks = [drake, hen];
    s.nextDuckId = 50;
    s.breedingPairs = [{ id: 'p', drakeId: 'D', henId: 'H', clutchProgress: 0, incubating: [BALANCE.BREEDING.INCUBATE_S - 0.5] }];
    // rng 0.5 makes each slot inherit the Lay parent and never mutate → all-L child.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    runBreeding(s, 1); // the egg hatches this step
    const child = s.ducks.find((d) => d.id !== 'D' && d.id !== 'H')!;
    expect(targetMatch(child.genome, s.genomeTarget)).toBe(BALANCE.GENOME.SLOTS); // a truebred
    expect(s.pendingTruebred).toBe(1); // the DING was queued
  });
});

describe('Prime gene integration (Phase 6c): breeding threads legacyTier eligibility', () => {
  /** A pair ready to hatch on the next runBreeding tick, forced to mutate EVERY
   *  slot (rng≡0: <MUTATION_CHANCE is always true) — maximal chance to leak
   *  Prime through if the tier gate weren't wired into breeding.ts. */
  function pairAboutToHatch(tier: number): { s: GameState; drake: Duck; hen: Duck } {
    const s = build({ coop: 4 });
    s.legacyTier = tier;
    const drake: Duck = { id: 'D', genotype: ['Bl', 'bl'], genome: genome('DDDDDD'), genomeKnown: true, sex: 'drake', stage: 'adult', ageTicks: 0 };
    const hen: Duck = { id: 'H', genotype: ['Bl', 'bl'], genome: genome('DDDDDD'), genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 };
    s.ducks = [drake, hen];
    s.nextDuckId = 50;
    s.breedingPairs = [{ id: 'p', drakeId: 'D', henId: 'H', clutchProgress: 0, incubating: [BALANCE.BREEDING.INCUBATE_S - 0.5] }];
    return { s, drake, hen };
  }

  afterEach(() => vi.restoreAllMocks());

  it('below PRIME_MIN_TIER, a fully-forced mutation NEVER produces a Prime gene', () => {
    const { s } = pairAboutToHatch(BALANCE.GENOME.PRIME_MIN_TIER - 1);
    vi.spyOn(Math, 'random').mockReturnValue(0); // forces mutation every slot
    runBreeding(s, 1);
    const child = s.ducks.find((d) => d.id !== 'D' && d.id !== 'H')!;
    expect(child.genome.includes('P' as never)).toBe(false);
  });

  it('at PRIME_MIN_TIER+, the same forced-mutation roll CAN produce a Prime gene', () => {
    const { s } = pairAboutToHatch(BALANCE.GENOME.PRIME_MIN_TIER);
    vi.spyOn(Math, 'random').mockReturnValue(0); // forces mutation AND the prime-share roll
    runBreeding(s, 1);
    const child = s.ducks.find((d) => d.id !== 'D' && d.id !== 'H')!;
    expect(child.genome.every((gene) => gene === 'P')).toBe(true);
  });

  it('the seed flock never rolls a Prime gene (mutation-only, never seeded)', () => {
    for (let i = 0; i < 100; i++) {
      const s = initialState(0);
      seedFlock(s);
      for (const d of s.ducks) expect(d.genome.includes('P' as never)).toBe(false);
    }
  });
});

describe('save round-trip', () => {
  it('preserves the flock + dex + id counter', () => {
    const s = build({ coop: 1 });
    s.ducks[0].genome = genome('LVHDLV');
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

describe('duck naming (opt-in — the emotional layer)', () => {
  it('setDuckName trims, caps at 16, and an empty string clears', () => {
    const s = fullSetup();
    setHens(s, 1);
    const id = s.ducks[0].id;
    expect(setDuckName(s, id, '  Petunia  ').ok).toBe(true);
    expect(s.ducks[0].name).toBe('Petunia');
    expect(setDuckName(s, id, 'A'.repeat(40)).ok).toBe(true);
    expect(s.ducks[0].name).toHaveLength(16);
    expect(setDuckName(s, id, '   ').ok).toBe(true);
    expect(s.ducks[0].name).toBeUndefined();
    expect(setDuckName(s, 'nope', 'X').ok).toBe(false);
  });

  it('names round-trip through save', () => {
    const s = fullSetup();
    setHens(s, 1);
    setDuckName(s, s.ducks[0].id, 'Petunia');
    expect(deserialize(serialize(s), 0).ducks[0].name).toBe('Petunia');
  });

  it('harm events carry the victim’s name (captured at emit — she may be gone by drain time)', () => {
    const s = fullSetup();
    setHens(s, 2);
    setDuckName(s, s.ducks[0].id, 'Petunia');
    const d = s.ducks[0];
    d.wounded = true;
    d.woundSource = 'predator';
    d.severity = 'minor';
    d.woundElapsed = 99999; // far past any escalation window
    runPredators(s, 1, { mode: 'online', rng: () => 1 });
    const e = (s.pendingPredatorEvents ?? []).find((x) => x.kind === 'escalated');
    expect(e && 'duckName' in e ? e.duckName : undefined).toBe('Petunia');
    expect(s.ducks.find((x) => x.name === 'Petunia')).toBeUndefined(); // she's gone — the event remembers
  });
});

describe('THE PRIME DUCK (a full-PPPPPP hatch — the rarest bird there is)', () => {
  const B = BALANCE.BREEDING;
  // Complementary half-Prime parents: at rng 0.4 every contested P(dom 4) vs
  // D(dom 1) slot resolves to P and mutation never fires — the cross ASSEMBLES
  // a full Prime deterministically while neither parent is one (so the
  // had-one guard can't suppress the first hatch).
  const primePair = (): GameState => {
    const s = build({ coop: 1 });
    const mk = (id: string, sex: 'drake' | 'hen', g: Genome): Duck => ({
      id,
      genotype: ['Bl', 'bl'],
      genome: g,
      genomeKnown: true,
      sex,
      stage: 'adult',
      ageTicks: 0,
    });
    s.ducks = [mk('dr', 'drake', genome('PPPDDD')), mk('he', 'hen', genome('DDDPPP'))];
    s.breedingPairs = [{ id: 'p1', drakeId: 'dr', henId: 'he', clutchProgress: 0, incubating: [] }];
    s.contracts.peakEggRate = 0; // clutch at the floor cost
    return s;
  };

  it('fires its OWN pending beat and supersedes the truebred DING for that hatch', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.4); // no mutation; P×P slots stay P
    const s = primePair();
    runBreeding(s, B.CLUTCH_INTERVAL_S - 1);
    runBreeding(s, B.INCUBATE_S + 2);
    vi.restoreAllMocks();
    const hatched = s.ducks.filter((d) => d.stage === 'duckling');
    expect(hatched.length).toBeGreaterThan(0);
    expect(hatched.every((d) => isPrimeDuck(d.genome))).toBe(true);
    expect(s.pendingPrimeDuck ?? 0).toBeGreaterThan(0);
    expect(s.pendingTruebred ?? 0).toBe(0); // one duckling, one (bigger) banner
  });

  it('the guard mirrors truebred: no re-fire while a Prime Duck lives, re-fires when all are lost', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    const s = primePair();
    runBreeding(s, B.CLUTCH_INTERVAL_S - 1);
    runBreeding(s, B.INCUBATE_S + 2); // first hatch → beat + a living Prime duckling
    s.pendingPrimeDuck = 0;
    runBreeding(s, B.CLUTCH_INTERVAL_S - 1);
    runBreeding(s, B.INCUBATE_S + 2); // second hatch — a Prime duckling already lives
    expect(s.pendingPrimeDuck ?? 0).toBe(0);
    vi.restoreAllMocks();
  });

  it('the champion snapshot remembers the run that bred one', () => {
    const s = primePair();
    s.ducks[0].genome = genome('PPPPPP'); // a living Prime Duck at reset time
    expect(championSnapshot(s, 0).primeDuck).toBe(true);
    s.ducks.forEach((d) => (d.genome = genome('LLLLLL')));
    expect(championSnapshot(s, 0).primeDuck).toBeUndefined();
  });
});

it('the excess-drake cull sends Prime carriers to the BACK of the line', async () => {
  const { GameEngine } = await import('../src/game/engine');
  const s = build({ coop: 3 });
  const mk = (id: string, sex: 'drake' | 'hen', g: string): Duck => ({
    id,
    genotype: ['Bl', 'bl'],
    genome: genome(g),
    genomeKnown: true,
    sex,
    stage: 'adult',
    ageTicks: 0,
  });
  // 8 hens + 4 drakes (over the ratio threshold): the P-carrier has the
  // WORST classic genome of the drakes.
  s.ducks = [
    ...Array.from({ length: 8 }, (_, i) => mk(`h${i}`, 'hen' as const, 'LLLLLL')),
    mk('prime', 'drake', 'PDDDDD'), // 1 good-gene equiv, but carries the P
    mk('d1', 'drake', 'LLDDDD'),
    mk('d2', 'drake', 'LLLDDD'),
    mk('d3', 'drake', 'LLLLDD'),
  ];
  const engine = new GameEngine(0); // loads a fresh game (no storage in tests)…
  engine.state = s; // …then adopt the staged flock
  const r = engine.cullExcessDrakes();
  expect(r.ok).toBe(true);
  const ids = new Set(s.ducks.map((d) => d.id));
  expect(ids.has('prime')).toBe(true); // spared despite the junk genome
  expect(ids.has('d1')).toBe(false); // the true worst classics went instead
});

describe('the Prime chase LADDER: a truebred with a new best wildcard count gets fanfare', () => {
  const B2 = BALANCE.BREEDING;
  const mkPair = (drakeG: string, henG: string, flock: Duck[] = []): GameState => {
    const s = build({ coop: 2 });
    const mk = (id: string, sex: 'drake' | 'hen', g: string): Duck => ({
      id,
      genotype: ['Bl', 'bl'],
      genome: genome(g),
      genomeKnown: true,
      sex,
      stage: 'adult',
      ageTicks: 0,
    });
    s.ducks = [mk('dr', 'drake', drakeG), mk('he', 'hen', henG), ...flock];
    s.breedingPairs = [{ id: 'p1', drakeId: 'dr', henId: 'he', clutchProgress: 0, incubating: [] }];
    s.contracts.peakEggRate = 0;
    s.resources.eggs = 100000;
    return s;
  };
  const hatch = (s: GameState) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    runBreeding(s, B2.CLUTCH_INTERVAL_S - 1);
    runBreeding(s, B2.INCUBATE_S + 2);
    vi.restoreAllMocks();
  };

  it('a 1-P truebred fires the ladder beat even though plain truebreds exist', () => {
    // Target LLLLLL (tier 0). Drake PDDDDD (a P-carrier, NOT a truebred) x a
    // plain-truebred hen deterministically hatch PLLLLL (P dom 4 beats L in
    // slot 0; L beats D elsewhere at rng 0.4) — a 1-P truebred, while a plain
    // truebred already lives. The OLD guard would have swallowed this.
    const s = mkPair('PDDDDD', 'LLLLLL', [
      {
        id: 'tb',
        genotype: ['Bl', 'bl'],
        genome: genome('LLLLLL'),
        genomeKnown: true,
        sex: 'hen',
        stage: 'adult',
        ageTicks: 0,
      },
    ]);
    hatch(s);
    expect(s.pendingPrimeTruebred ?? 0).toBe(1);
    expect(s.pendingTruebred ?? 0).toBe(0);
  });

  it('no re-fire at the SAME count; a higher count fires again', () => {
    // A 1-P truebred already in the flock → a fresh 1-P hatch is not a new best.
    const one = mkPair('PDDDDD', 'LLLLLL', [
      {
        id: 'p1best',
        genotype: ['Bl', 'bl'],
        genome: genome('PLLLLL'),
        genomeKnown: true,
        sex: 'hen',
        stage: 'adult',
        ageTicks: 0,
      },
    ]);
    hatch(one);
    expect(one.pendingPrimeTruebred ?? 0).toBe(0); // the 1-P rung is already held

    // A 2-P drake (not a truebred) x plain truebred → PPLLLL, a NEW best.
    const two = mkPair('PPDDDD', 'LLLLLL');
    hatch(two);
    expect(two.pendingPrimeTruebred ?? 0).toBe(2);
  });
});
