import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import type { Module } from '../src/game/state';
import {
  installModule,
  uninstallModule,
  salvageModule,
  rerollModule,
} from '../src/game/actions';
import { rackSockets } from '../src/game/state';
import { build } from './helpers';

let id = 0;
const mod = (stat: Module['stat'], rarity: Module['rarity'] = 'rare', magnitude = 0.2): Module => ({
  id: `inv${id++}`,
  stat,
  rarity,
  magnitude,
});

describe('install / uninstall', () => {
  it('installs a spare into a free rack socket (any stat fits any socket)', () => {
    const s = build({ plot: 1, coop: 1 });
    const speed = mod('stationSpeed');
    const egg = mod('eggOutput');
    s.inventory.push(speed, egg);

    expect(installModule(s, speed.id).ok).toBe(true);
    expect(installModule(s, egg.id).ok).toBe(true); // no category gating on the rack
    expect(s.rack).toHaveLength(2);
    expect(s.inventory).toHaveLength(0);
  });

  it('respects the socket cap (overflow stays a spare)', () => {
    const s = build({ plot: 1 }); // rank 1 -> baseSockets
    const sockets = rackSockets(s);
    const mods = Array.from({ length: sockets + 1 }, () => mod('stationYield'));
    s.inventory.push(...mods);
    for (const m of mods) installModule(s, m.id);
    expect(s.rack).toHaveLength(sockets);
    expect(s.inventory).toHaveLength(1);
  });

  it('uninstall returns a module to spares', () => {
    const s = build({ plot: 1 });
    const m = mod('stationSpeed');
    s.inventory.push(m);
    installModule(s, m.id);
    expect(uninstallModule(s, m.id).ok).toBe(true);
    expect(s.rack).toHaveLength(0);
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
