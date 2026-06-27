import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import type { Module, ModuleStat } from '../src/game/state';
import {
  assignModule,
  removeStation,
  salvageModule,
  rerollModule,
  gainXP,
} from '../src/game/actions';
import { stationBonus, makeModule } from '../src/game/loot';
import { serialize, deserialize, runOfflineCatchUp } from '../src/game/save';
import { build, fullSetup, stockAll, run } from './helpers';

let id = 0;
const mod = (stat: ModuleStat, rarity: Module['rarity'] = 'legendary', magnitude = 0.5): Module => ({
  id: `h${id++}`,
  stat,
  rarity,
  magnitude,
});

describe('remove station returns slotted modules', () => {
  it('does not destroy the player loot', () => {
    const s = build({ plot: 1 });
    const plot = s.stations[0];
    const m = mod('stationYield');
    s.inventory.push(m);
    assignModule(s, plot.id, m.id);
    expect(s.inventory).toHaveLength(0);
    removeStation(s, plot.id);
    expect(s.inventory).toHaveLength(1);
    expect(s.inventory[0].id).toBe(m.id);
  });
});

describe('module effects apply offline, but drops never do', () => {
  it('a yield module raises offline production; no modules drop offline', () => {
    const plain = stockAll(fullSetup());
    const boosted = stockAll(fullSetup());
    boosted.stations.find((x) => x.type === 'plot')!.modules = [mod('stationYield', 'legendary', 0.5)];
    plain.lastSeen = -3600 * 1000;
    boosted.lastSeen = -3600 * 1000;
    const pCorn = plain.resources.corn;
    const bCorn = boosted.resources.corn;
    runOfflineCatchUp(plain, 0);
    runOfflineCatchUp(boosted, 0);
    // both consumed/produced corn; the boosted plot net-produces more
    expect(boosted.resources.corn - bCorn).toBeGreaterThan(plain.resources.corn - pCorn);
    // ...but no module ever dropped from offline production
    expect(plain.inventory).toHaveLength(0);
    expect(boosted.inventory).toHaveLength(0);
  });
});

describe('salvage/reroll guard assigned modules', () => {
  it('cannot salvage or reroll a slotted module (must unassign first)', () => {
    const s = build({ plot: 1 });
    s.dust = 100;
    const m = mod('stationSpeed');
    s.inventory.push(m);
    assignModule(s, s.stations[0].id, m.id);
    expect(salvageModule(s, m.id).ok).toBe(false);
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
  it('caps every stat even with maxed legendaries in every slot', () => {
    const s = stockAll(fullSetup());
    const stats: ModuleStat[] = ['stationSpeed', 'stationYield', 'eggOutput', 'conditionRegen', 'tendPower', 'tendCooldown'];
    for (const st of s.stations) {
      st.modules = Array.from({ length: BALANCE.LOOT.SLOTS_PER_STATION }, () => mod('stationYield', 'legendary', 0.5));
    }
    for (const st of s.stations) {
      for (const stat of stats) {
        expect(stationBonus(st, stat)).toBeLessThanOrEqual(BALANCE.LOOT.SOFT_CAP[stat]);
      }
    }
    // and even a fully-juiced coop can't lay more than ~ (1 + cap) of base
    const base = stockAll(fullSetup());
    run(base, 200);
    let e0 = base.resources.eggs;
    run(base, 60);
    const basePerMin = base.resources.eggs - e0;
    const juiced = stockAll(fullSetup());
    juiced.stations.find((x) => x.type === 'coop')!.modules = [mod('eggOutput', 'legendary', 0.5), mod('eggOutput', 'legendary', 0.5)];
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
