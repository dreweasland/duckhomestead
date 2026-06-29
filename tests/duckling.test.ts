import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { runDucklingNutrition } from '../src/game/nutrition';
import { serialize, deserialize, runOfflineCatchUp } from '../src/game/save';
import type { Duck } from '../src/game/state';
import { build, fullSetup, stockAll, run, setHens } from './helpers';

const B = BALANCE.BREEDING;
let n = 0;
const duckling = (): Duck => ({ id: `k${n++}`, genotype: ['Bl', 'bl'], genome: ['D', 'D', 'D', 'D', 'D', 'D'], sex: 'hen', stage: 'duckling', ageTicks: 0 });

describe('duckling ration gates maturation', () => {
  it('matureRate is full when fed, near the floor when starved', () => {
    const fed = stockAll(build({ coop: 1 }));
    fed.ducks = [duckling(), duckling()];
    let mr = 1;
    for (let i = 0; i < 200; i++) mr = runDucklingNutrition(fed, 0.1, 1);
    expect(mr).toBeGreaterThan(0.95);

    const starved = build({ coop: 1 }); // no ingredient stock/production
    starved.ducks = [duckling()];
    mr = 1;
    for (let i = 0; i < 200; i++) mr = runDucklingNutrition(starved, 0.1, 1);
    expect(mr).toBeCloseTo(B.DUCKLING_RATION_MATURE_PENALTY_FLOOR, 1);
  });

  it('no immature ducks -> no gating (rate 1, snapshot cleared)', () => {
    const s = stockAll(build({ coop: 1 }));
    s.ducks = s.ducks.filter((d) => d.stage === 'adult');
    expect(runDucklingNutrition(s, 0.1, 1)).toBe(1);
    expect(s.ducklingNutrition).toBeUndefined();
  });

  it('well-fed ducklings reach adulthood; starved ones stall', () => {
    const fed = stockAll(build({ coop: 2 }));
    fed.ducks = [duckling()];
    run(fed, 400); // 360s at full rate -> adult
    expect(fed.ducks[0].stage).toBe('adult');

    const starved = build({ coop: 2 });
    starved.ducks = [duckling()];
    run(starved, 400); // at the floor: ~120 ageTicks < 180 -> still a duckling
    expect(starved.ducks[0].stage).toBe('duckling');
  });

  it('advances maturation offline (at the offline rate) and grants no XP', () => {
    const s = stockAll(build({ coop: 2 }));
    s.ducks = [duckling()];
    s.rank = 3;
    s.xp = 10;
    s.lastSeen = -8 * 3600 * 1000;
    runOfflineCatchUp(s, 0);
    expect(s.ducks[0].stage).toBe('adult'); // 8h * 0.4 >> 360s
    expect(s.rank).toBe(3);
    expect(s.xp).toBe(10);
  });
});

describe('GUARDRAIL: duckling ration never alters the layer nutrition math', () => {
  it('layer requirement + throttle are identical with or without ducklings', () => {
    const withK = setHens(stockAll(fullSetup()), 2);
    withK.ducks.push(duckling(), duckling());
    const without = setHens(stockAll(fullSetup()), 2);
    run(withK, 60);
    run(without, 60);
    expect(withK.nutrition!.requirement).toEqual(without.nutrition!.requirement);
    expect(withK.nutrition!.eggMult).toBeCloseTo(without.nutrition!.eggMult, 5);
  });
});

describe('save', () => {
  it('round-trips the duckling ration', () => {
    const s = build({ coop: 1 });
    s.ducklingRation = { corn: 5, peas: 1, mealworms: 0, brewersYeast: 3, oysterShell: 0 };
    expect(deserialize(serialize(s), 0).ducklingRation).toEqual(s.ducklingRation);
  });

  it('defaults the duckling ration for a pre-step-5 save', () => {
    const r = deserialize(JSON.stringify({ ducks: [], stations: [] }), 0);
    expect(r.ducklingRation).toEqual(BALANCE.BREEDING.DEFAULT_DUCKLING_RATION);
  });
});
