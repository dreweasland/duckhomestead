import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { serialize, deserialize } from '../src/game/save';
import { fullSetup } from './helpers';

const N = BALANCE.NUTRITION;

describe('save round-trip', () => {
  it('preserves all Phase 1 + Phase 2 state', () => {
    const s = fullSetup();
    s.ration = { corn: 3, peas: 2, mealworms: 0.5, brewersYeast: 1, oysterShell: 1.5 };
    s.condition = 42.5;
    s.niacinShortfall = 123;
    s.doseCooldownRemaining = 17;
    s.rank = 4;
    s.xp = 88;
    s.resources.mealworms = 88;
    s.stations.find((x) => x.type === 'coop')!.debuffed = true;
    s.stations[0].level = 3;

    const r = deserialize(serialize(s), 999);
    expect(r.ration).toEqual(s.ration);
    expect(r.condition).toBe(42.5);
    expect(r.niacinShortfall).toBe(123);
    expect(r.doseCooldownRemaining).toBe(17);
    expect(r.rank).toBe(4);
    expect(r.resources.mealworms).toBe(88);
    expect(r.stations.find((x) => x.type === 'coop')!.debuffed).toBe(true);
    expect(r.stations[0].level).toBe(3);
  });
});

describe('back-compat + robustness', () => {
  it('loads a legacy Phase 1 save with defaults; keeps pellets as a dead field', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { corn: 2, pellets: 9, eggs: 200 },
      stations: [{ id: 'c1', type: 'coop', x: 0, y: 0, level: 1 }],
      rank: 3,
      xp: 5,
      autoHaulUnlocked: true,
      lastSeen: 0,
    });
    const r = deserialize(legacy, 1000);
    expect(r.ration.corn).toBe(N.DEFAULT_RATION.corn);
    expect(r.condition).toBe(N.CONDITION_MAX);
    expect(r.niacinShortfall).toBe(0);
    expect(r.doseCooldownRemaining).toBe(0);
    expect((r.resources as Record<string, number>).pellets).toBe(9);
    expect(r.resources.mealworms).toBe(0);
  });

  it('falls back to a fresh state on corrupt JSON', () => {
    const r = deserialize('}{ not json', 0);
    expect(r.stations).toHaveLength(0);
    expect(r.resources.eggs).toBe(BALANCE.STARTING_EGGS);
  });

  it('merges a partial saved ration with defaults', () => {
    const r = deserialize(JSON.stringify({ ration: { corn: 9 } }), 0);
    expect(r.ration.corn).toBe(9);
    expect(r.ration.oysterShell).toBe(N.DEFAULT_RATION.oysterShell);
  });

  it('defaults loot fields for a pre-Phase-3 save', () => {
    const r = deserialize(JSON.stringify({ ration: { corn: 2 }, condition: 50 }), 0);
    expect(r.inventory).toEqual([]);
    expect(r.dust).toBe(0);
    expect(r.nextModuleId).toBe(1);
    expect(r.stations).toEqual([]);
  });
});

describe('loot save round-trip', () => {
  it('preserves inventory, slotted modules, dust, and the id counter', () => {
    const s = fullSetup();
    s.dust = 42;
    s.nextModuleId = 7;
    s.inventory = [{ id: 'm1', stat: 'stationYield', rarity: 'epic', magnitude: 0.3 }];
    s.stations[0].modules = [{ id: 'm2', stat: 'stationSpeed', rarity: 'rare', magnitude: 0.2 }];
    const r = deserialize(serialize(s), 0);
    expect(r.dust).toBe(42);
    expect(r.nextModuleId).toBe(7);
    expect(r.inventory).toEqual(s.inventory);
    expect(r.stations[0].modules).toEqual(s.stations[0].modules);
  });
});
