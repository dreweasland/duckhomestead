import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { initialState } from '../src/game/state';
import { doseNiacin } from '../src/game/actions';
import { build, fullSetup, stockAll, run } from './helpers';

const N = BALANCE.NUTRITION;

describe('satisfaction + throttle', () => {
  it('a stocked, balanced ration satisfies every axis and lays at full rate', () => {
    const s = stockAll(fullSetup());
    run(s, 120);
    for (const a of ['energy', 'protein', 'niacin', 'calcium'] as const) {
      expect(s.nutrition!.satisfaction[a]).toBeGreaterThanOrEqual(1);
    }
    expect(s.nutrition!.eggMult).toBeGreaterThan(0.98);
    expect(s.resources.pellets).toBe(0); // pellets retired
  });

  it('full nutrition lays ~15 eggs/min for one coop (matches Phase 1)', () => {
    const s = stockAll(fullSetup());
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

  it('an empty battery applies the full penalty', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    s.resources.corn = 1e6;
    s.condition = 0;
    run(s, 1);
    expect(s.nutrition!.eggMult).toBeCloseTo(s.nutrition!.eggMultRaw, 5);
  });
});

describe('satisfaction is smoothed (no strobe)', () => {
  it('holds steady on a marginal line instead of bouncing', () => {
    // 1 plot (~0.667 corn/s) barely feeds 1 coop (~0.625/s) — the strobe case.
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
    expect(maxSwing).toBeLessThan(0.02);
  });
});

describe('niacin leg debuff + dose', () => {
  it('applies after sustained shortfall once the flock is run down', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    s.resources.corn = 1e6; // energy ok, niacin 0 forever, condition will drain
    const coop = s.stations.find((x) => x.type === 'coop')!;
    run(s, N.NIACIN_DEBUFF_ONSET_S + 400);
    expect(coop.debuffed).toBe(true);
  });

  it('a well-conditioned flock resists the debuff (bootstrap guard)', () => {
    // E/P/Ca fed (condition stays high) but no yeast -> niacin 0.
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, oysterSource: 1, mill: 1, coop: 1 }));
    s.resources.brewersYeast = 0;
    run(s, N.NIACIN_DEBUFF_ONSET_S + 400);
    expect(s.stations.find((x) => x.type === 'coop')!.debuffed).toBeFalsy();
  });

  it('dose clears a debuff: costs yeast, sets a cooldown, needs a debuffed coop', () => {
    const s = build({ mill: 1, coop: 1 });
    const coop = s.stations.find((x) => x.type === 'coop')!;
    coop.debuffed = true;
    expect(doseNiacin(s, coop.id).ok).toBe(false); // no yeast
    s.resources.brewersYeast = 10;
    const r = doseNiacin(s, coop.id);
    expect(r.ok).toBe(true);
    expect(coop.debuffed).toBe(false);
    expect(s.resources.brewersYeast).toBe(10 - N.DOSE_COST_YEAST);
    expect(s.doseCooldownRemaining).toBeGreaterThan(0);
    expect(doseNiacin(s, coop.id).ok).toBe(false); // healthy now
  });

  it('halves a debuffed coop output', () => {
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, yeastVat: 1, oysterSource: 1, mill: 1, coop: 1 }), 1e9);
    run(s, 30);
    const coop = s.stations.find((x) => x.type === 'coop')!;
    let e0 = s.resources.eggs;
    run(s, 600);
    const healthy = s.resources.eggs - e0;
    coop.debuffed = true;
    e0 = s.resources.eggs;
    run(s, 600);
    const limp = s.resources.eggs - e0;
    expect(limp / healthy).toBeCloseTo(N.DEBUFF_COOP_OUTPUT_MULT, 2);
  });
});
