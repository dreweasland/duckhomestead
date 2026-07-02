import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { initialState } from '../src/game/state';
import { doseNiacin } from '../src/game/actions';
import { axisFactor, conditionTarget } from '../src/game/nutrition';
import { build, fullSetup, stockAll, run, setHens } from './helpers';

const N = BALANCE.NUTRITION;

describe('axisFactor — the per-axis output throttle curve', () => {
  it('floors at a starved axis, reaches 1.0 at full, and interpolates linearly', () => {
    expect(axisFactor(0)).toBeCloseTo(N.THROTTLE_FLOOR, 10); // starved ≠ zero output
    expect(axisFactor(1)).toBeCloseTo(1, 10); // fully fed → full output
    expect(axisFactor(0.5)).toBeCloseTo(N.THROTTLE_FLOOR + (1 - N.THROTTLE_FLOOR) * 0.5, 10);
  });

  it('is monotonic and clamps outside [0,1] (no runaway bonus, never below the floor)', () => {
    expect(axisFactor(0.75)).toBeGreaterThan(axisFactor(0.25));
    expect(axisFactor(2)).toBeCloseTo(1, 10); // over-fed gives no extra
    expect(axisFactor(-1)).toBeCloseTo(N.THROTTLE_FLOOR, 10); // never below the floor
  });
});

describe('a recovering hen: lays nothing, eats extra feed', () => {
  it('drops flock egg rate and raises feed demand vs the same flock healthy', () => {
    const healthy = setHens(stockAll(fullSetup()), 2);
    run(healthy, 30);
    const rateHealthy = healthy.nutrition!.eggRate;
    const demandHealthy = healthy.nutrition!.feedDemand;

    const s = setHens(stockAll(fullSetup()), 2);
    s.ducks[0].wounded = true;
    s.ducks[0].recovering = true; // in an infirmary slot
    run(s, 30);
    expect(s.nutrition!.eggRate).toBeLessThan(rateHealthy); // one hen laying 0
    expect(s.nutrition!.feedDemand).toBeGreaterThan(demandHealthy); // eats FEED_MULT×
  });
});

describe('niacin is a debuff driver, NOT an output throttle', () => {
  it('eggMultRaw is exactly the energy×protein×calcium product — niacin is excluded', () => {
    // E/P/Ca fed from their producers, but the niacin source (brewer's yeast) is gone.
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, oysterSource: 1, mill: 1, coop: 1 }));
    setHens(s, 1);
    s.resources.brewersYeast = 0;
    run(s, 1); // one tick — before the condition battery or debuff timer moves
    const sat = s.nutrition!.satisfaction;
    expect(sat.niacin).toBeLessThan(1); // setup is non-vacuous: niacin IS short
    expect(Math.min(sat.energy, sat.protein, sat.calcium)).toBeGreaterThanOrEqual(1); // others fed
    // The raw multiplier is the E/P/Ca product only — the niacin shortfall never appears.
    const expected = axisFactor(sat.energy) * axisFactor(sat.protein) * axisFactor(sat.calcium);
    expect(s.nutrition!.eggMultRaw).toBeCloseTo(expected, 10);
    expect(s.nutrition!.eggMultRaw).toBeCloseTo(1, 6); // full output despite a starved niacin axis
  });
});

describe('satisfaction + throttle', () => {
  it('a stocked, balanced ration satisfies every axis and lays at full rate', () => {
    const s = setHens(stockAll(fullSetup()), 1); // 1 adult layer == Phase 2's 1 coop
    run(s, 120);
    for (const a of ['energy', 'protein', 'niacin', 'calcium'] as const) {
      expect(s.nutrition!.satisfaction[a]).toBeGreaterThanOrEqual(1);
    }
    expect(s.nutrition!.eggMult).toBeGreaterThan(0.98);
    expect(s.resources.pellets).toBe(0); // pellets retired
  });

  it('one adult layer at full nutrition lays ~15 eggs/min (Phase 2 equivalence)', () => {
    const s = setHens(stockAll(fullSetup()), 1);
    run(s, 120);
    const before = s.resources.eggs;
    run(s, 60);
    expect(s.resources.eggs - before).toBeCloseTo(15, 0);
  });

  it('a corn-only flock craters below the floor cap but never to zero', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    s.resources.corn = 1e6;
    run(s, 1); // one moment before condition drains
    expect(s.nutrition!.eggMultRaw).toBe(N.MIN_EGG_MULT); // floored, not 0.008
    expect(s.nutrition!.eggMult).toBeGreaterThan(0.9); // full condition masks it
  });

  it('without a mill, coops fall back to the floor multiplier', () => {
    const s = stockAll(build({ coop: 1 }));
    run(s, 1);
    expect(s.nutrition!.eggMultRaw).toBe(N.MIN_EGG_MULT);
  });
});

describe('flock condition battery', () => {
  it('drains under shortfall and recovers when well fed', () => {
    const starved = build({ plot: 1, mill: 1, coop: 1 });
    starved.resources.corn = 1e6;
    const c0 = starved.condition;
    run(starved, 60);
    expect(starved.condition).toBeLessThan(c0);

    const fed = stockAll(fullSetup());
    fed.condition = 20;
    run(fed, 30);
    expect(fed.condition).toBeGreaterThan(20);
  });

  it('relaxes toward the nutrition level from both directions (never frozen mid)', () => {
    // Calcium pinned to ~50% via the ration -> condition should settle ~50,
    // converging from both 100 and 0 (the old hard threshold could freeze a
    // near-fed flock mid-range and never recover).
    const settle = (start: number) => {
      const s = setHens(stockAll(fullSetup()), 1);
      s.ration = { ...s.ration, oysterShell: 0.5 };
      s.condition = start;
      run(s, 600);
      return s.condition;
    };
    expect(settle(100)).toBeGreaterThan(40);
    expect(settle(100)).toBeLessThan(60);
    expect(settle(0)).toBeGreaterThan(40); // can RISE up to the target, not stuck at 0
    expect(Math.abs(settle(100) - settle(0))).toBeLessThan(5); // same equilibrium
  });

  it('an empty battery applies the full penalty', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    s.resources.corn = 1e6;
    s.condition = 0;
    run(s, 1);
    expect(s.nutrition!.eggMult).toBeCloseTo(s.nutrition!.eggMultRaw, 5);
  });
});

describe('conditionTarget — the battery target mirror (Phase 5 water attribution beat)', () => {
  it('is 0 with no mill (there IS a nutrition snapshot — hasMill just reads false)', () => {
    const s = setHens(build({ plot: 1, coop: 1 }), 1); // no mill
    run(s, 1);
    expect(s.nutrition?.hasMill).toBe(false);
    expect(conditionTarget(s)).toBe(0);
  });

  it('mirrors the tick’s own target once nutrition has run — a fully-fed flock converges to it', () => {
    const s = stockAll(fullSetup());
    run(s, 120);
    expect(conditionTarget(s)).toBeCloseTo(N.CONDITION_MAX, 5);
    expect(s.condition).toBeCloseTo(conditionTarget(s), 3);
  });
});

describe('satisfaction is smoothed (no strobe)', () => {
  it('holds steady on a marginal line instead of bouncing', () => {
    // 1 plot (~1.0 corn/s) short-feeds 1 coop (~1.25 corn/s for 2 hens): a chunky,
    // near-margin line where stock hovers low. The EMA must keep energy steady —
    // a smoothing regression would swing it several times harder (~0.3+).
    const s = build({ plot: 1, mill: 1, coop: 1 });
    run(s, 30);
    let prev = s.nutrition!.satisfaction.energy;
    let maxSwing = 0;
    for (let i = 0; i < 600; i++) {
      run(s, 0.1);
      const e = s.nutrition!.satisfaction.energy;
      maxSwing = Math.max(maxSwing, Math.abs(e - prev));
      prev = e;
    }
    expect(maxSwing).toBeLessThan(0.1);
  });
});

describe('niacin leg debuff + dose', () => {
  it('applies to a duck after sustained shortfall once the flock is run down', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    s.resources.corn = 1e6; // energy ok, niacin 0 forever, condition will drain
    run(s, N.NIACIN_DEBUFF_ONSET_S + 400);
    expect(s.ducks.some((d) => d.debuffed)).toBe(true);
  });

  it('a well-conditioned flock resists the debuff (bootstrap guard)', () => {
    // E/P/Ca fed (condition stays high) but no yeast -> niacin 0.
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, oysterSource: 1, mill: 1, coop: 1 }));
    setHens(s, 1);
    s.resources.brewersYeast = 0;
    run(s, N.NIACIN_DEBUFF_ONSET_S + 400);
    expect(s.ducks.some((d) => d.debuffed)).toBe(false);
  });

  it('dose clears a duck debuff: costs yeast, sets a cooldown, needs a debuffed duck', () => {
    const s = setHens(build({ mill: 1, coop: 1 }), 1);
    s.ducks[0].debuffed = true;
    expect(doseNiacin(s).ok).toBe(false); // no yeast
    s.resources.brewersYeast = 10;
    const r = doseNiacin(s);
    expect(r.ok).toBe(true);
    expect(s.ducks[0].debuffed).toBe(false);
    expect(s.resources.brewersYeast).toBe(10 - N.DOSE_COST_YEAST);
    expect(s.doseCooldownRemaining).toBeGreaterThan(0);
    expect(doseNiacin(s).ok).toBe(false); // none left to dose
  });

  it('halves a debuffed duck output', () => {
    const s = setHens(stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, yeastVat: 1, oysterSource: 1, mill: 1, coop: 1 }), 1e9), 1);
    run(s, 30);
    let e0 = s.resources.eggs;
    run(s, 600);
    const healthy = s.resources.eggs - e0;
    s.ducks[0].debuffed = true;
    e0 = s.resources.eggs;
    run(s, 600);
    const limp = s.resources.eggs - e0;
    expect(limp / healthy).toBeCloseTo(N.DEBUFF_COOP_OUTPUT_MULT, 2);
  });
});
