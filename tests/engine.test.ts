import { describe, it, expect } from 'vitest';
import { GameEngine } from '../src/game/engine';
import { COLORS, type Duck, type Gene, type Genotype } from '../src/game/state';
import { BALANCE } from '../src/config/balance';

// Engine-level coverage: the composite behaviour the class adds ON TOP of the pure
// actions (gating, whole-state replacement, in-flight strike bookkeeping) — none of
// which the action-level suites exercise.

const P = BALANCE.PRESTIGE;

/** Force a champion flock exactly meeting the tier-0 goal: every colour dexed, plus
 *  SIZE_BASE god-clone hens (each genome == the target, so meanQuality == SLOTS,
 *  comfortably over the quality gate). */
function makeChampion(eng: GameEngine): void {
  eng.state.dexSeen = [...COLORS];
  const target = [...eng.state.genomeTarget] as Gene[];
  eng.state.ducks = Array.from({ length: P.SIZE_BASE }, (_, i): Duck => ({
    id: `d${i + 1}`,
    genotype: ['Bl', 'bl'] as Genotype,
    genome: [...target],
    genomeKnown: true,
    sex: 'hen',
    stage: 'adult',
    ageTicks: 5,
  }));
}

describe('GameEngine.prestige()', () => {
  it('is gated: a fresh homestead cannot prestige — a no-op that keeps the same state object', () => {
    const eng = new GameEngine(0);
    const before = eng.state;
    const r = eng.prestige();
    expect(r).toEqual({ ok: false, granted: 0, tier: 0 });
    expect(eng.state).toBe(before); // state was NOT replaced
    expect(eng.state.legacyTier).toBe(0);
  });

  it('when the champion goal is met: wipes the run, carries the meta forward, grants currency', () => {
    const eng = new GameEngine(0);
    makeChampion(eng);
    eng.state.legacyCurrency = 3;
    eng.state.purchasedBoosts = { output: 2 };

    const r = eng.prestige();
    expect(r.ok).toBe(true);
    expect(r.tier).toBe(1);
    expect(r.granted).toBeGreaterThan(0);

    // Meta carried forward onto the fresh run.
    expect(eng.state.legacyTier).toBe(1);
    expect(eng.state.legacyCurrency).toBe(3 + r.granted);
    expect(eng.state.purchasedBoosts.output).toBe(2);
    // The wiped champion flock is memorialised in the Hall at its true size.
    expect(eng.state.legacyHall).toHaveLength(1);
    expect(eng.state.legacyHall[0].flockSize).toBe(P.SIZE_BASE);
    // ...and the run itself is a clean slate — the 100-strong flock is gone.
    expect(eng.state.ducks.length).toBeLessThan(P.SIZE_BASE);
    expect(eng.away).toBeNull();
  });
});

describe('GameEngine.scare()', () => {
  function armStrike(eng: GameEngine, clicksRequired: number): void {
    eng.state.predators.owl = {
      timeToNextWindow: 0,
      windowRemaining: 10,
      windowElapsed: 0,
      attacksFired: 1,
      strike: {
        targetId: 'd1',
        windupRemaining: 2,
        windupTotal: 5,
        id: 1,
        spot: 0,
        clicksRequired,
        clicksLanded: 0,
      },
    };
  }

  it('returns null when nothing is diving', () => {
    const eng = new GameEngine(0);
    expect(eng.scare('owl')).toBeNull();
  });

  it('a single-click strike is foiled — the duck is spared and the dive is cleared', () => {
    const eng = new GameEngine(0);
    armStrike(eng, 1);
    const r = eng.scare('owl');
    expect(r).toEqual({ kind: 'foiled', duckId: 'd1' });
    expect(eng.state.predators.owl.strike).toBeUndefined();
  });

  it('an early click on a multi-click strike feints — the dive re-arms its full window', () => {
    const eng = new GameEngine(0);
    armStrike(eng, 2);
    const r = eng.scare('owl');
    expect(r?.kind).toBe('feint');
    const strike = eng.state.predators.owl.strike;
    expect(strike).toBeDefined();
    expect(strike!.clicksLanded).toBe(1);
    expect(strike!.windupRemaining).toBe(strike!.windupTotal); // reaction window fully reset
  });
});

describe('GameEngine.cullExcessDrakes()', () => {
  // 6-slot genome with exactly `good` non-Dud genes (so goodGeneCount === good).
  const withGenes = (good: number): Gene[] =>
    Array.from({ length: 6 }, (_, i): Gene => (i < good ? 'L' : 'D'));
  const hen = (id: string): Duck => ({
    id, genotype: ['bl', 'bl'] as Genotype, genome: withGenes(6),
    genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 5,
  });
  const drake = (id: string, good: number): Duck => ({
    id, genotype: ['bl', 'bl'] as Genotype, genome: withGenes(good),
    genomeKnown: true, sex: 'drake', stage: 'adult', ageTicks: 5,
  });
  const drakeIds = (eng: GameEngine): string[] =>
    eng.state.ducks.filter((d) => d.sex === 'drake').map((d) => d.id).sort();

  // 8 hens → maxHealthyDrakes = floor(8 / IDEAL_HENS_PER_DRAKE=4) = 2.
  const eightHens = (): Duck[] => Array.from({ length: 8 }, (_, i) => hen(`h${i}`));

  it('fails when the drake:hen ratio is already healthy (nothing to cull)', () => {
    const eng = new GameEngine(0);
    eng.state.ducks = [...eightHens(), drake('d1', 3), drake('d2', 3)]; // 2 drakes ≤ 2 healthy
    const r = eng.cullExcessDrakes();
    expect(r.ok).toBe(false);
    expect(drakeIds(eng)).toHaveLength(2); // untouched
  });

  it('releases exactly the excess, worst genome first, keeping the best studs', () => {
    const eng = new GameEngine(0);
    eng.state.ducks = [
      ...eightHens(),
      drake('worst', 0), drake('bad', 1), drake('mid', 2), drake('good', 3), drake('best', 6),
    ]; // 5 drakes, 2 healthy → excess 3
    const r = eng.cullExcessDrakes();
    expect(r.ok && r.value.released).toBe(3);
    expect(drakeIds(eng)).toEqual(['best', 'good']); // 3 weakest culled
  });

  it('never releases a paired stud — a stronger drake is culled in its place', () => {
    const eng = new GameEngine(0);
    eng.state.ducks = [
      ...eightHens(),
      drake('worst', 0), drake('bad', 1), drake('mid', 2), drake('good', 3), drake('best', 6),
    ];
    // Pair the WEAKEST drake: it must survive despite being the prime cull candidate,
    // so the next three weakest (bad/mid/good) go instead.
    eng.state.breedingPairs = [{ id: 'p1', drakeId: 'worst', henId: 'h0', clutchProgress: 0, incubating: [] }];
    const r = eng.cullExcessDrakes();
    expect(r.ok && r.value.released).toBe(3);
    expect(drakeIds(eng)).toEqual(['best', 'worst']);
  });
});
