import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import type { Module } from '../src/game/state';
import {
  assignModule,
  unassignModule,
  salvageModule,
  rerollModule,
} from '../src/game/actions';
import { build } from './helpers';

let id = 0;
const mod = (stat: Module['stat'], rarity: Module['rarity'] = 'rare', magnitude = 0.2): Module => ({
  id: `inv${id++}`,
  stat,
  rarity,
  magnitude,
});

describe('assign / unassign', () => {
  it('slots a fitting module and rejects mismatched category', () => {
    const s = build({ plot: 1, coop: 1 });
    const plot = s.stations.find((x) => x.type === 'plot')!;
    const speed = mod('stationSpeed');
    const egg = mod('eggOutput');
    s.inventory.push(speed, egg);

    expect(assignModule(s, plot.id, egg.id).ok).toBe(false); // eggOutput can't fit a plot
    expect(assignModule(s, plot.id, speed.id).ok).toBe(true);
    expect(plot.modules).toHaveLength(1);
    expect(s.inventory).toHaveLength(1);
  });

  it('respects the slot cap', () => {
    const s = build({ plot: 1 });
    const plot = s.stations.find((x) => x.type === 'plot')!;
    const mods = Array.from({ length: BALANCE.LOOT.SLOTS_PER_STATION + 1 }, () => mod('stationYield'));
    s.inventory.push(...mods);
    for (const m of mods) assignModule(s, plot.id, m.id);
    expect(plot.modules).toHaveLength(BALANCE.LOOT.SLOTS_PER_STATION);
    expect(s.inventory).toHaveLength(1); // the overflow stayed in inventory
  });

  it('unassign returns a module to inventory', () => {
    const s = build({ plot: 1 });
    const plot = s.stations.find((x) => x.type === 'plot')!;
    const m = mod('stationSpeed');
    s.inventory.push(m);
    assignModule(s, plot.id, m.id);
    expect(unassignModule(s, m.id).ok).toBe(true);
    expect(plot.modules).toHaveLength(0);
    expect(s.inventory).toHaveLength(1);
  });
});

describe('salvage / reroll', () => {
  it('salvage yields rarity-scaled dust and removes the module', () => {
    const s = build({});
    const m = mod('stationYield', 'epic');
    s.inventory.push(m);
    const r = salvageModule(s, m.id);
    expect(r.ok).toBe(true);
    expect(s.dust).toBe(BALANCE.LOOT.SALVAGE_DUST.epic);
    expect(s.inventory).toHaveLength(0);
  });

  it('reroll costs dust and re-rolls magnitude within the same rarity band', () => {
    const s = build({});
    const m = mod('stationYield', 'rare', 0.16);
    s.inventory.push(m);
    expect(rerollModule(s, m.id).ok).toBe(false); // no dust
    s.dust = BALANCE.LOOT.REROLL_DUST_COST + 2;
    const r = rerollModule(s, m.id, () => 0.999); // roll high end
    expect(r.ok).toBe(true);
    expect(s.dust).toBe(2);
    const [min, max] = BALANCE.LOOT.RARITY_BAND.rare;
    expect(m.magnitude).toBeGreaterThanOrEqual(min);
    expect(m.magnitude).toBeLessThanOrEqual(max);
    expect(m.rarity).toBe('rare'); // rarity unchanged
  });
});
