import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { initialState, type Duck, type GameState, type Genotype } from '../src/game/state';
import {
  circulationHealth,
  isCovered,
  liveFountains,
  pondLayoutBase,
  runCirculation,
} from '../src/game/pond';
import { waterProvision, waterWoundMult } from '../src/game/water';

const W = BALANCE.WATER;
const C = W.CIRCULATION;
const FLOOR = C.circulationFloor;

function ducks(n: number): Duck[] {
  return Array.from({ length: n }, (_, i): Duck => ({
    id: `c${i}`,
    genotype: ['bl', 'bl'] as Genotype,
    genome: ['D', 'D', 'D', 'D', 'D', 'D'],
    sex: 'hen',
    stage: 'adult',
    ageTicks: 0,
  }));
}

/** Pond + Waterworks unlocked, with a flock so fouling is in play. */
function worksState(flock = 20): GameState {
  const s = initialState(0);
  s.zones.pond.unlocked = true;
  s.zones.backPasture.unlocked = true; // Waterworks
  s.resources.eggs = 1e6;
  s.ducks = ducks(flock);
  return s;
}

const freshOf = (s: GameState, x: number, y: number) => s.pond.freshness[`${x},${y}`] ?? 1;
const advance = (s: GameState, secs: number, rate = 1) => {
  // 1s steps (the loop is gentle/linear; coarse steps are fine).
  for (let t = 0; t < secs; t++) runCirculation(s, 1, rate);
};

describe('Stage 2: circulation connectivity + coverage', () => {
  it('a fountain is live only when its flow network connects an intake to an outflow', () => {
    const s = worksState();
    // intake — fountain — outflow, orthogonally connected.
    s.pond.flow = [
      { x: 1, y: 2, type: 'intake' },
      { x: 2, y: 2, type: 'fountain' },
      { x: 3, y: 2, type: 'outflow' },
    ];
    expect(liveFountains(s)).toHaveLength(1);
    expect(isCovered(liveFountains(s), 3, 2)).toBe(true); // within radius of the live fountain

    // Remove the outflow → the fountain is a dead end → inert.
    s.pond.flow = s.pond.flow.filter((f) => f.type !== 'outflow');
    expect(liveFountains(s)).toHaveLength(0);
    expect(isCovered(liveFountains(s), 3, 2)).toBe(false);
  });
});

describe('Stage 2: the upkeep loop (floor / peak)', () => {
  it('does nothing while Waterworks is locked (staging)', () => {
    const s = worksState();
    s.zones.backPasture.unlocked = false; // Waterworks locked again
    s.pond.features = [{ x: 0, y: 0, type: 'deepZone' }];
    advance(s, 1000);
    expect(freshOf(s, 0, 0)).toBe(1); // passively clean
  });

  it('an uncovered feature coasts toward the floor — and never past it', () => {
    const s = worksState(20);
    s.pond.features = [{ x: 0, y: 0, type: 'bathingPool' }];
    advance(s, 60);
    const partway = freshOf(s, 0, 0);
    expect(partway).toBeLessThan(1); // fouling has begun
    expect(partway).toBeGreaterThan(FLOOR);
    advance(s, 100000); // long neglect
    expect(freshOf(s, 0, 0)).toBeCloseTo(FLOOR, 5); // coasts to the floor, never zero
    expect(freshOf(s, 0, 0)).toBeGreaterThanOrEqual(FLOOR);
  });

  it('a covered feature is held at peak (and recovers from a fouled state)', () => {
    const s = worksState(40); // a big, fouling flock
    s.pond.features = [{ x: 3, y: 2, type: 'deepZone' }];
    s.pond.freshness['3,2'] = FLOOR; // start fully stagnant
    // A live circuit whose fountain sits within range of the deep zone.
    s.pond.flow = [
      { x: 1, y: 2, type: 'intake' },
      { x: 2, y: 2, type: 'fountain' },
      { x: 2, y: 3, type: 'outflow' },
    ];
    advance(s, 100000);
    expect(freshOf(s, 3, 2)).toBeCloseTo(1, 5); // circulation restores it to peak
  });

  it('maintained circulation keeps provision near peak; neglect coasts to the floor (never zero)', () => {
    const base = () => {
      const s = worksState(25);
      s.pond.features = [{ x: 3, y: 2, type: 'deepZone' }];
      return s;
    };
    const maintained = base();
    maintained.pond.flow = [
      { x: 1, y: 2, type: 'intake' },
      { x: 2, y: 2, type: 'fountain' },
      { x: 2, y: 3, type: 'outflow' },
    ];
    const neglected = base();
    advance(maintained, 100000);
    advance(neglected, 100000);

    const peak = pondLayoutBase(neglected); // layout is identical
    expect(waterProvision(maintained)).toBeCloseTo(peak, 4); // covered → full provision
    const floorProvision = waterProvision(neglected);
    expect(floorProvision).toBeLessThan(peak);
    expect(floorProvision).toBeGreaterThan(W.YARD_BASELINE_PROVISION * 0.99); // baseline never fouls
  });

  it('fouling scales with flock size (a bigger flock fouls faster)', () => {
    const small = worksState(8);
    const big = worksState(40);
    small.pond.features = [{ x: 0, y: 0, type: 'bathingPool' }];
    big.pond.features = [{ x: 0, y: 0, type: 'bathingPool' }];
    advance(small, 200);
    advance(big, 200);
    expect(freshOf(big, 0, 0)).toBeLessThan(freshOf(small, 0, 0));
  });

  it('the deep zone (wantsCirculation) fouls faster than a plain feature', () => {
    const s = worksState(10);
    s.pond.features = [
      { x: 0, y: 0, type: 'deepZone' },
      { x: 4, y: 4, type: 'bathingPool' }, // far apart; neither covered
    ];
    advance(s, 300);
    expect(freshOf(s, 0, 0)).toBeLessThan(freshOf(s, 4, 4));
  });

  it('resolves fouling at the offline rate (slower while away)', () => {
    const online = worksState(20);
    const offline = worksState(20);
    online.pond.features = [{ x: 0, y: 0, type: 'bathingPool' }];
    offline.pond.features = [{ x: 0, y: 0, type: 'bathingPool' }];
    advance(online, 200, 1);
    advance(offline, 200, BALANCE.OFFLINE_RATE_MULT);
    expect(freshOf(offline, 0, 0)).toBeGreaterThan(freshOf(online, 0, 0));
  });
});

describe('Stage 2: circulationHealth + the no-new-death-path guarantee', () => {
  it('circulationHealth reflects coverage (≈1 covered, → floor fully stagnant)', () => {
    const s = worksState(25);
    s.pond.features = [{ x: 0, y: 0, type: 'deepZone' }];
    advance(s, 100000); // no flow → fully stagnant
    expect(circulationHealth(s)).toBeLessThan(1);
    expect(circulationHealth(s)).toBeGreaterThanOrEqual(FLOOR);
  });

  it('provision can never drop below the always-on baseline, even fully stagnant', () => {
    const s = worksState(500); // huge flock, bone-dry circulation
    s.pond.features = [
      { x: 0, y: 0, type: 'deepZone' },
      { x: 6, y: 4, type: 'bathingPool' },
    ];
    advance(s, 100000);
    // The baseline is held out of fouling → a wound always keeps time to treat.
    expect(waterProvision(s)).toBeGreaterThanOrEqual(W.YARD_BASELINE_PROVISION);
    expect(BALANCE.PREDATORS.WOUND_ESCALATE_SEC * waterWoundMult(s)).toBeGreaterThan(0);
  });
});
