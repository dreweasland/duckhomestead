import { describe, it, expect } from 'vitest';
import { BALANCE, type StationType } from '../src/config/balance';
import { resourceFlow } from '../src/game/actions';
import { INGREDIENTS, type Duck, type GameState } from '../src/game/state';
import { build, run, stockAll, FLAT_GENOME } from './helpers';

/** Build a fed setup with `n` adult drakes (+ one hen so layers exist too). */
function withDrakes(n: number, stations: Partial<Record<StationType, number>>): GameState {
  const s = build(stations);
  s.ducks = [
    { id: 'h0', genotype: ['Bl', 'bl'], genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 },
    ...Array.from({ length: n }, (_, i): Duck => ({
      id: `dr${i}`,
      genotype: ['Bl', 'bl'],
      genome: [...FLAT_GENOME],
      genomeKnown: true,
      sex: 'drake',
      stage: 'adult',
      ageTicks: 0,
    })),
  ];
  return s;
}

const FULL = { plot: 1, peaPatch: 1, mealwormFarm: 1, yeastVat: 1, oysterSource: 1, mill: 1, coop: 1 };

describe('drake maintenance ration', () => {
  it('drakes do not eat until breeding is established', () => {
    const s = stockAll(withDrakes(3, FULL));
    s.geneReader = false;
    s.breedingPairs = [];
    run(s, 3);
    expect(s.drakeNutrition).toBeUndefined();
  });

  it('established + fed drakes breed at full speed', () => {
    const s = stockAll(withDrakes(3, FULL));
    s.geneReader = true; // breeding established
    run(s, 5);
    expect(s.drakeNutrition).toBeDefined();
    expect(s.drakeNutrition!.breedRate).toBeGreaterThan(0.95);
  });

  it('starved drakes throttle breeding down to the floor (never a stop)', () => {
    // No producers, no stock → drakes can never eat.
    const s = withDrakes(3, { coop: 1 });
    s.geneReader = true;
    for (const k of INGREDIENTS) s.resources[k] = 0;
    run(s, 5);
    expect(s.drakeNutrition!.breedRate).toBeCloseTo(BALANCE.BREEDING.DRAKE_BREED_PENALTY_FLOOR, 5);
  });

  it('establishing breeding adds drake draw to ingredient outflow (the end-game drain)', () => {
    const s = stockAll(withDrakes(5, FULL));
    run(s, 3); // populate the nutrition snapshot (feedScale)
    s.geneReader = false;
    s.breedingPairs = [];
    const before = resourceFlow(s, 'corn').out;
    s.geneReader = true;
    const after = resourceFlow(s, 'corn').out;
    expect(after).toBeGreaterThan(before);
  });

  it('the drake ration needs no calcium (spares oyster shell)', () => {
    expect(BALANCE.BREEDING.DRAKE_REQUIREMENT.calcium).toBe(0);
    expect(BALANCE.BREEDING.DEFAULT_DRAKE_RATION.oysterShell).toBe(0);
  });
});
