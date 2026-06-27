import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import type { Module, ModuleStat } from '../src/game/state';
import { eggOutputMult } from '../src/game/loot';
import { build, fullSetup, stockAll, run } from './helpers';

let nextId = 0;
const mod = (stat: ModuleStat, magnitude: number, rarity: Module['rarity'] = 'epic'): Module => ({
  id: `t${nextId++}`,
  stat,
  rarity,
  magnitude,
});

function eggsPerMin(withMods: (coop: any) => void): { eggMult: number; perMin: number } {
  const s = stockAll(fullSetup());
  withMods(s.stations.find((x) => x.type === 'coop')!);
  run(s, 200); // settle
  const before = s.resources.eggs;
  run(s, 60);
  return { eggMult: s.nutrition!.eggMult, perMin: s.resources.eggs - before };
}

describe('throughput wiring', () => {
  it('a yield module makes a producer output more per cycle', () => {
    const plain = build({ plot: 1 });
    const boosted = build({ plot: 1 });
    boosted.stations[0].modules = [mod('stationYield', 0.4)];
    run(plain, 60, false);
    run(boosted, 60, false);
    const a = plain.stations[0].buffer.corn ?? 0;
    const b = boosted.stations[0].buffer.corn ?? 0;
    expect(b).toBeGreaterThan(a * 1.2);
  });

  it('a speed module makes a producer cycle faster', () => {
    const plain = build({ plot: 1 });
    const boosted = build({ plot: 1 });
    boosted.stations[0].modules = [mod('stationSpeed', 0.5)];
    run(plain, 60, false);
    run(boosted, 60, false);
    expect(boosted.stations[0].buffer.corn ?? 0).toBeGreaterThan(plain.stations[0].buffer.corn ?? 0);
  });

  it('conditionRegen module speeds flock recovery', () => {
    const plain = stockAll(fullSetup());
    const boosted = stockAll(fullSetup());
    plain.condition = 20;
    boosted.condition = 20;
    boosted.stations.find((x) => x.type === 'coop')!.modules = [mod('conditionRegen', 0.8)];
    run(plain, 20);
    run(boosted, 20);
    expect(boosted.condition).toBeGreaterThan(plain.condition);
  });
});

describe('GUARDRAIL: modules boost output, never the nutrition math', () => {
  it('an eggOutput module scales eggs but leaves eggMult/satisfaction identical', () => {
    const base = eggsPerMin(() => {});
    const m = mod('eggOutput', 0.5);
    const boosted = eggsPerMin((coop) => (coop.modules = [m]));

    // satisfaction-derived throttle is identical...
    expect(boosted.eggMult).toBeCloseTo(base.eggMult, 5);
    // ...but eggs produced scale by exactly the module multiplier.
    const expected = 1 + (BALANCE.LOOT.SOFT_CAP.eggOutput * (1 - Math.exp(-m.magnitude / BALANCE.LOOT.SOFT_CAP.eggOutput)));
    expect(boosted.perMin / base.perMin).toBeCloseTo(expected, 2);
  });

  it('per-axis requirement is unchanged whether or not modules are slotted', () => {
    const plain = stockAll(fullSetup());
    const boosted = stockAll(fullSetup());
    boosted.stations.find((x) => x.type === 'coop')!.modules = [mod('eggOutput', 0.5)];
    boosted.stations.find((x) => x.type === 'plot')!.modules = [mod('stationYield', 0.4)];
    run(plain, 60);
    run(boosted, 60);
    expect(boosted.nutrition!.requirement).toEqual(plain.nutrition!.requirement);
  });

  it('the ingredient matrix and requirement constants are never mutated', () => {
    const snapMatrix = JSON.stringify(BALANCE.NUTRITION.INGREDIENT);
    const snapReq = JSON.stringify(BALANCE.NUTRITION.REQUIREMENT);
    const s = stockAll(fullSetup());
    s.stations.forEach((st) => (st.modules = [mod('stationYield', 0.5), mod('eggOutput', 0.5)]));
    run(s, 120);
    expect(JSON.stringify(BALANCE.NUTRITION.INGREDIENT)).toBe(snapMatrix);
    expect(JSON.stringify(BALANCE.NUTRITION.REQUIREMENT)).toBe(snapReq);
  });
});

describe('eggOutputMult helper', () => {
  it('returns 1 with no modules and >1 with an eggOutput module', () => {
    const s = build({ coop: 1 });
    expect(eggOutputMult(s.stations[0])).toBe(1);
    s.stations[0].modules = [mod('eggOutput', 0.3)];
    expect(eggOutputMult(s.stations[0])).toBeGreaterThan(1);
  });
});
