import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { resourceFlow, setDoubleClutch } from '../src/game/actions';
import { clutchCost, pairClutchSize, runBreeding } from '../src/game/breeding';
import { deserialize, serialize } from '../src/game/save';
import { type Duck, type GameState } from '../src/game/state';
import { FLAT_GENOME, fullSetup, stockAll } from './helpers';

/**
 * DOUBLE CLUTCH — the endgame throughput premium: a per-pair toggle that lays
 * 2× the ducklings at 3× the egg cost. The quality phase's activity is
 * generating and filtering genome rolls; this is the repeatable, scale-proof
 * price on rolling faster.
 */

const B = BALANCE.BREEDING;
const COST = B.CLUTCH_COST_MIN; // cold-start floor (no peak yet)
const DOUBLE_COST = COST * B.DOUBLE_CLUTCH_COST_MULT;
const DOUBLE_SIZE = B.CLUTCH_SIZE * B.DOUBLE_CLUTCH_SIZE_MULT;

function pairFarm(eggs: number): GameState {
  const s = stockAll(fullSetup());
  s.resources.eggs = eggs;
  const duck = (id: string, sex: 'drake' | 'hen'): Duck => ({
    id,
    genotype: ['Bl', 'bl'],
    genome: [...FLAT_GENOME],
    genomeKnown: true,
    sex,
    stage: 'adult',
    ageTicks: 0,
  });
  s.ducks = [duck('dr', 'drake'), duck('he', 'hen')];
  s.breedingPairs = [{ id: 'p1', drakeId: 'dr', henId: 'he', clutchProgress: 0, incubating: [] }];
  return s;
}

describe('the toggle', () => {
  it('sets and clears the flag; refuses an unknown pair', () => {
    const s = pairFarm(1000);
    expect(setDoubleClutch(s, 'p1', true).ok).toBe(true);
    expect(s.breedingPairs[0].doubleClutch).toBe(true);
    expect(setDoubleClutch(s, 'p1', false).ok).toBe(true);
    expect(s.breedingPairs[0].doubleClutch).toBeUndefined();
    expect(setDoubleClutch(s, 'nope', true).ok).toBe(false);
  });

  it('prices the premium off the same peak-seconds base', () => {
    const s = pairFarm(1000);
    expect(clutchCost(s, true)).toBe(COST * B.DOUBLE_CLUTCH_COST_MULT);
    s.contracts.peakEggRate = 80;
    expect(clutchCost(s, true)).toBe(clutchCost(s) * B.DOUBLE_CLUTCH_COST_MULT);
    expect(pairClutchSize({ doubleClutch: true })).toBe(DOUBLE_SIZE);
    expect(pairClutchSize({})).toBe(B.CLUTCH_SIZE);
  });
});

describe('laying at the premium', () => {
  it('a double clutch draws 3× the eggs and lays 2× the fertilized eggs', () => {
    const s = pairFarm(1000);
    s.breedingPairs[0].doubleClutch = true;
    // Room for the whole brood: the coop (cap 4) holds 2 parents, so raise it.
    s.stations.find((st) => st.type === 'coop')!.level = 3; // cap 12
    runBreeding(s, B.CLUTCH_INTERVAL_S - 1);
    runBreeding(s, 2);
    expect(s.breedingPairs[0].incubating).toHaveLength(DOUBLE_SIZE);
    expect(s.resources.eggs).toBe(1000 - DOUBLE_COST);
  });

  it('waits at the threshold until the FULL premium is funded', () => {
    const s = pairFarm(DOUBLE_COST - 1); // affords a plain clutch, not the premium
    s.breedingPairs[0].doubleClutch = true;
    s.stations.find((st) => st.type === 'coop')!.level = 3;
    runBreeding(s, B.CLUTCH_INTERVAL_S * 3);
    expect(s.breedingPairs[0].incubating).toHaveLength(0);
    expect(s.breedingPairs[0].clutchProgress).toBe(B.CLUTCH_INTERVAL_S); // held at the brink
    expect(s.resources.eggs).toBe(DOUBLE_COST - 1);
    s.resources.eggs += 1;
    runBreeding(s, 0.1);
    expect(s.breedingPairs[0].incubating).toHaveLength(DOUBLE_SIZE);
    expect(s.resources.eggs).toBe(0);
  });

  it('toggling off mid-program: the next clutch pays and lays plain', () => {
    const s = pairFarm(1_000_000);
    s.breedingPairs[0].doubleClutch = true;
    s.stations.find((st) => st.type === 'coop')!.level = 5;
    runBreeding(s, B.CLUTCH_INTERVAL_S - 1);
    runBreeding(s, 2);
    expect(s.breedingPairs[0].incubating).toHaveLength(DOUBLE_SIZE);
    setDoubleClutch(s, 'p1', false);
    const eggs0 = s.resources.eggs;
    s.breedingPairs[0].incubating = []; // clear the paid queue for a clean read
    s.breedingPairs[0].clutchProgress = 0; // fresh clock so the lay lands in the short step
    runBreeding(s, B.CLUTCH_INTERVAL_S - 1);
    runBreeding(s, 2);
    expect(s.breedingPairs[0].incubating).toHaveLength(B.CLUTCH_SIZE);
    expect(s.resources.eggs).toBe(eggs0 - COST);
  });

  it('the queue bound scales with the pair’s clutch size (two broods max)', () => {
    const s = pairFarm(1_000_000);
    s.breedingPairs[0].doubleClutch = true;
    s.stations.find((st) => st.type === 'coop')!.level = 5; // room to lay…
    s.breedingPairs[0].incubating = Array(DOUBLE_SIZE * 2 - 1).fill(0); // …but the queue is near-full
    s.breedingPairs[0].clutchProgress = B.CLUTCH_INTERVAL_S; // clutch ready NOW
    runBreeding(s, 0.1); // short step: nothing hatches, the lay is the only question
    expect(s.breedingPairs[0].incubating).toHaveLength(DOUBLE_SIZE * 2 - 1); // no third brood squeezed in
    expect(s.resources.eggs).toBe(1_000_000); // and nothing spent
    s.breedingPairs[0].incubating = Array(DOUBLE_SIZE).fill(0); // one brood queued — room for one more
    runBreeding(s, 0.1);
    expect(s.breedingPairs[0].incubating).toHaveLength(DOUBLE_SIZE * 2);
    expect(s.resources.eggs).toBe(1_000_000 - DOUBLE_COST);
  });
});

describe('the ledgers agree', () => {
  it('the flow panel drain sums per-pair costs — a double pair pays its premium', () => {
    const s = pairFarm(1000);
    s.contracts.peakEggRate = 8;
    const plain = resourceFlow(s, 'eggs').out;
    s.breedingPairs[0].doubleClutch = true;
    expect(resourceFlow(s, 'eggs').out).toBeCloseTo(plain * B.DOUBLE_CLUTCH_COST_MULT, 6);
  });

  it('the flag survives a save round-trip', () => {
    const s = pairFarm(1000);
    s.breedingPairs[0].doubleClutch = true;
    const back = deserialize(serialize(s), 0);
    expect(back.breedingPairs[0].doubleClutch).toBe(true);
  });
});
