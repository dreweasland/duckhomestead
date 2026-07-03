import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { resourceFlow } from '../src/game/actions';
import { runBreeding } from '../src/game/breeding';
import { type Duck, type GameState } from '../src/game/state';
import { FLAT_GENOME, fullSetup, run, stockAll } from './helpers';

/**
 * The 4a dual-purpose law, finally implemented: a clutch IS eggs. Laying one
 * draws CLUTCH_SIZE × FERTILIZED_EGG_COST from storage; unaffordable → the
 * clutch WAITS at the threshold (throttle) and fires the instant it's funded.
 */

const B = BALANCE.BREEDING;
const COST = B.CLUTCH_SIZE * B.FERTILIZED_EGG_COST;

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

describe('the clutch egg cost (spend-vs-grow, restored)', () => {
  it('laying a clutch draws CLUTCH_SIZE × FERTILIZED_EGG_COST from storage', () => {
    const s = pairFarm(1000);
    // Two steps so the fresh clutch doesn't also incubate+hatch within one call.
    runBreeding(s, B.CLUTCH_INTERVAL_S - 1);
    runBreeding(s, 2);
    expect(s.breedingPairs[0].incubating).toHaveLength(B.CLUTCH_SIZE);
    expect(s.resources.eggs).toBe(1000 - COST);
  });

  it('an unaffordable clutch WAITS at the threshold and fires the instant it is funded', () => {
    const s = pairFarm(COST - 1);
    runBreeding(s, B.CLUTCH_INTERVAL_S * 3); // three intervals of progress, zero funding
    expect(s.breedingPairs[0].incubating).toHaveLength(0); // nothing laid…
    expect(s.breedingPairs[0].clutchProgress).toBe(B.CLUTCH_INTERVAL_S); // …held AT the brink
    expect(s.resources.eggs).toBe(COST - 1); // and nothing spent

    s.resources.eggs += 1; // fund it
    runBreeding(s, 0.1); // the very next step
    expect(s.breedingPairs[0].incubating).toHaveLength(B.CLUTCH_SIZE);
    expect(s.resources.eggs).toBe(0);
  });

  it('a funded program is undisturbed end to end (hatch pipeline unchanged)', () => {
    const s = pairFarm(1_000_000);
    s.ration = { ...BALANCE.NUTRITION.DEFAULT_RATION };
    s.ducklingRation = { ...BALANCE.BREEDING.DEFAULT_DUCKLING_RATION };
    run(s, B.CLUTCH_INTERVAL_S + B.INCUBATE_S + 5);
    expect(s.ducks.length).toBeGreaterThan(2); // clutch laid, incubated, hatched
  });

  it('the flow panel reports the clutch drain as a recurring egg outflow', () => {
    const s = pairFarm(1000);
    const flow = resourceFlow(s, 'eggs');
    expect(flow.out).toBeCloseTo(COST / B.CLUTCH_INTERVAL_S, 6);
    // A wounded hen freezes the pair — the drain must vanish with it.
    s.ducks[1].wounded = true;
    expect(resourceFlow(s, 'eggs').out).toBe(0);
  });
});
