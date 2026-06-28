import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import type { Module, ModuleStat } from '../src/game/state';
import {
  installModule,
  removeStation,
  salvageModule,
  rerollModule,
  gainXP,
} from '../src/game/actions';
import { rackBonus, makeModule } from '../src/game/loot';
import { serialize, deserialize, runOfflineCatchUp } from '../src/game/save';
import { build, fullSetup, stockAll, run, setHens } from './helpers';

let id = 0;
const mod = (stat: ModuleStat, rarity: Module['rarity'] = 'legendary', magnitude = 0.5): Module => ({
  id: `h${id++}`,
  stat,
  rarity,
  magnitude,
});

describe('the rack is independent of stations', () => {
  it('removing a station leaves installed modules untouched (loot is never destroyed)', () => {
    const s = build({ plot: 1 });
    const m = mod('stationYield');
    s.rack = [m];
    removeStation(s, s.stations[0].id);
    expect(s.rack).toHaveLength(1);
    expect(s.rack[0].id).toBe(m.id);
    expect(s.inventory).toHaveLength(0);
  });
});

describe('module effects apply offline, but drops never do', () => {
  it('a rack yield module raises offline production; no modules drop offline', () => {
    // Plot-only (no flock consuming corn) isolates the producer-yield effect.
    const plain = build({ plot: 1 });
    const boosted = build({ plot: 1 });
    boosted.rack = [mod('stationYield', 'legendary', 0.5)];
    plain.lastSeen = -3600 * 1000;
    boosted.lastSeen = -3600 * 1000;
    runOfflineCatchUp(plain, 0);
    runOfflineCatchUp(boosted, 0);
    expect(boosted.resources.corn).toBeGreaterThan(plain.resources.corn);
    // ...but no module ever dropped from offline production
    expect(plain.inventory).toHaveLength(0);
    expect(boosted.inventory).toHaveLength(0);
  });
});

describe('salvage/reroll guard installed modules', () => {
  it('cannot salvage or reroll an installed module (must uninstall first)', () => {
    const s = build({ plot: 1 });
    s.dust = 100;
    const m = mod('stationSpeed');
    s.inventory.push(m);
    installModule(s, m.id);
    expect(salvageModule(s, m.id).ok).toBe(false); // it's in the rack, not a spare
    expect(rerollModule(s, m.id).ok).toBe(false);
  });
});

describe('module ids stay unique across minting + save/load', () => {
  it('never collides after reload', () => {
    const s = build({ coop: 1 });
    for (let i = 0; i < 5; i++) makeModule(s, 'rare', () => 0.5);
    const r = deserialize(serialize(s), 0);
    const fresh = makeModule(r, 'epic', () => 0.5);
    const ids = [...r.inventory.map((m) => m.id), fresh.id];
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });
});

describe('stacked power cannot run away past the soft cap', () => {
  it('caps every stat even with a rack overflowing with maxed legendaries', () => {
    const s = stockAll(fullSetup());
    const stats: ModuleStat[] = ['stationSpeed', 'stationYield', 'eggOutput', 'conditionRegen', 'tendPower', 'tendCooldown'];
    // Cram many of every stat into the rack (bypassing sockets) — the soft cap
    // must still bound each stat's applied bonus.
    s.rack = stats.flatMap((stat) => Array.from({ length: 5 }, () => mod(stat, 'legendary', 0.5)));
    for (const stat of stats) {
      expect(rackBonus(s, stat)).toBeLessThanOrEqual(BALANCE.LOOT.SOFT_CAP[stat]);
    }
    // and even a fully-juiced flock can't lay more than ~ (1 + cap) of base.
    // Fixed-vigor flock so the comparison isolates the module (not seed-vigor RNG).
    const base = setHens(stockAll(fullSetup()), 1);
    run(base, 200);
    let e0 = base.resources.eggs;
    run(base, 60);
    const basePerMin = base.resources.eggs - e0;
    const juiced = setHens(stockAll(fullSetup()), 1);
    juiced.rack = [mod('eggOutput', 'legendary', 0.5), mod('eggOutput', 'legendary', 0.5)];
    run(juiced, 200);
    e0 = juiced.resources.eggs;
    run(juiced, 60);
    const juicedPerMin = juiced.resources.eggs - e0;
    expect(juicedPerMin / basePerMin).toBeLessThanOrEqual(1 + BALANCE.LOOT.SOFT_CAP.eggOutput + 0.01);
  });
});

describe('milestone grants do not fire offline', () => {
  it('crossing rank thresholds offline is impossible (no XP), so no grants', () => {
    const s = stockAll(fullSetup());
    s.rank = 2;
    s.xp = 49;
    s.lastSeen = -8 * 3600 * 1000;
    runOfflineCatchUp(s, 0);
    expect(s.rank).toBe(2);
    expect(s.inventory).toHaveLength(0);
    // sanity: the same XP gained online WOULD grant at rank 3
    const online = build({ coop: 1 });
    gainXP(online, xpToRank3());
    expect(online.inventory.length).toBeGreaterThan(0);
  });
});

function xpToRank3(): number {
  // rank 1->2 + 2->3 + a touch
  const a = Math.round(BALANCE.RANK_BASE_XP * Math.pow(BALANCE.RANK_GROWTH, 0));
  const b = Math.round(BALANCE.RANK_BASE_XP * Math.pow(BALANCE.RANK_GROWTH, 1));
  return a + b + 1;
}
