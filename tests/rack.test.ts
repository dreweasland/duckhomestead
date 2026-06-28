import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { rackSockets, type Module, type ModuleStat } from '../src/game/state';
import {
  installModule,
  uninstallModule,
  swapInModule,
  autoFillRack,
} from '../src/game/actions';
import { spareOutlook, rackBonus } from '../src/game/loot';
import { build } from './helpers';

let id = 0;
const mod = (stat: ModuleStat, rarity: Module['rarity'], magnitude: number): Module => ({
  id: `r${id++}`,
  stat,
  rarity,
  magnitude,
});

describe('rack sockets grow with rank (capped)', () => {
  it('starts at baseSockets and steps up, never past maxSockets', () => {
    const R = BALANCE.LOOT.RACK;
    const s = build({});
    s.rank = 1;
    expect(rackSockets(s)).toBe(R.baseSockets);
    s.rank = 1 + R.ranksPerSocket;
    expect(rackSockets(s)).toBe(R.baseSockets + 1);
    s.rank = 1000;
    expect(rackSockets(s)).toBe(R.maxSockets);
  });
});

describe('global effect: one installed module covers its whole category', () => {
  it('a single rack module sets the homestead-wide bonus for its stat', () => {
    const s = build({ plot: 1, peaPatch: 1 });
    s.inventory.push(mod('stationSpeed', 'epic', 0.3));
    installModule(s, s.inventory[0].id);
    expect(rackBonus(s, 'stationSpeed')).toBeGreaterThan(0);
    // It isn't tied to any one station — it's a homestead value.
    expect(rackBonus(s, 'stationYield')).toBe(0);
  });
});

describe('Auto-fill optimizer', () => {
  it('fills every socket with the highest-value spares, leaving the weakest out', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    const egg = mod('eggOutput', 'legendary', 0.5); // highest value×magnitude
    const yield_ = mod('stationYield', 'epic', 0.3);
    const speed = mod('stationSpeed', 'rare', 0.2);
    const weak = mod('tendCooldown', 'common', 0.08); // lowest value×magnitude
    s.inventory.push(weak, speed, yield_, egg);

    const r = autoFillRack(s);
    expect(r.ok).toBe(true);
    expect(s.rack).toHaveLength(3);
    expect(s.inventory.map((m) => m.id)).toEqual([weak.id]); // the dud stays a spare
    expect(s.rack.map((m) => m.stat).sort()).toEqual(['eggOutput', 'stationSpeed', 'stationYield']);
  });

  it('diversifies across stats rather than overstacking one (soft cap)', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    // Four speed modules + one egg module: a sane optimizer takes the egg over a
    // 3rd speed (diminishing returns on a single stat).
    for (let i = 0; i < 4; i++) s.inventory.push(mod('stationSpeed', 'rare', 0.2));
    s.inventory.push(mod('eggOutput', 'rare', 0.2));
    autoFillRack(s);
    expect(s.rack.some((m) => m.stat === 'eggOutput')).toBe(true);
  });

  it('makes strictly-improving swaps when the rack is already full', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    // Rack full of weak modules; a strong spare should swap in.
    for (let i = 0; i < 3; i++) s.rack.push(mod('tendCooldown', 'common', 0.06));
    const strong = mod('eggOutput', 'legendary', 0.5);
    s.inventory.push(strong);
    const r = autoFillRack(s);
    expect(r.ok && r.value.swapped).toBeGreaterThan(0);
    expect(s.rack.some((m) => m.id === strong.id)).toBe(true);
    expect(s.rack).toHaveLength(3);
    expect(s.inventory.some((m) => m.stat === 'tendCooldown')).toBe(true); // the dud got bumped
  });
});

describe('install / swap / uninstall flow + outlook', () => {
  it('spareOutlook reports install when a socket is free, upgrade/none when full', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    const a = mod('eggOutput', 'rare', 0.2);
    s.inventory.push(a);
    expect(spareOutlook(s, a).kind).toBe('install');

    // Fill the rack with weak modules.
    s.rack = [
      mod('tendCooldown', 'common', 0.06),
      mod('tendCooldown', 'common', 0.06),
      mod('tendCooldown', 'common', 0.06),
    ];
    const strong = mod('eggOutput', 'legendary', 0.5);
    const weakSpare = mod('tendCooldown', 'common', 0.05);
    expect(spareOutlook(s, strong).kind).toBe('upgrade'); // beats a weak installed
    expect(spareOutlook(s, weakSpare).kind).toBe('none'); // wouldn't improve the loadout
  });

  it('swapInModule installs into a free socket, then swaps in once full', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    const m1 = mod('stationSpeed', 'rare', 0.2);
    s.inventory.push(m1);
    expect(swapInModule(s, m1.id).ok).toBe(true);
    expect(s.rack).toHaveLength(1); // free socket -> plain install

    // Fill the rest with weak ones, then swap a strong module in.
    s.rack.push(mod('tendCooldown', 'common', 0.06), mod('tendCooldown', 'common', 0.06));
    const strong = mod('eggOutput', 'legendary', 0.5);
    s.inventory.push(strong);
    expect(swapInModule(s, strong.id).ok).toBe(true);
    expect(s.rack.some((m) => m.id === strong.id)).toBe(true);
    expect(s.rack).toHaveLength(3);
  });

  it('uninstall frees a socket and returns the module to spares', () => {
    const s = build({});
    const m = mod('eggOutput', 'rare', 0.2);
    s.inventory.push(m);
    installModule(s, m.id);
    expect(s.rack).toHaveLength(1);
    expect(uninstallModule(s, m.id).ok).toBe(true);
    expect(s.rack).toHaveLength(0);
    expect(s.inventory.some((x) => x.id === m.id)).toBe(true);
  });
});
