import { describe, it, expect, vi } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { gainXP } from '../src/game/actions';
import { tryTendDrop } from '../src/game/loot';
import { xpForLevel } from '../src/game/rank';
import { runOfflineCatchUp } from '../src/game/save';
import { GameEngine } from '../src/game/engine';
import type { LootEvent } from '../src/game/engine';
import { build, fullSetup, stockAll, run } from './helpers';

describe('milestone grants (online only, via gainXP)', () => {
  it('grants a fixed-rarity module when crossing a grant rank', () => {
    const s = build({ coop: 1 });
    const r = gainXP(s, xpForLevel(1) + xpForLevel(2) + 1); // rank 1 -> 3
    expect(s.rank).toBe(3);
    expect(r.grantedModules).toHaveLength(1);
    expect(r.grantedModules[0].rarity).toBe(BALANCE.LOOT.MILESTONE_GRANTS[3]);
    expect(s.inventory).toHaveLength(1);
  });

  it('grants escalate across multiple milestone ranks', () => {
    const s = build({ coop: 1 });
    let need = 0;
    for (let r = 1; r < 7; r++) need += xpForLevel(r);
    gainXP(s, need + 1); // reach rank 7 -> grants at 3 and 7
    const rarities = s.inventory.map((m) => m.rarity);
    expect(rarities).toContain(BALANCE.LOOT.MILESTONE_GRANTS[3]);
    expect(rarities).toContain(BALANCE.LOOT.MILESTONE_GRANTS[7]);
  });
});

describe('active drops', () => {
  it('tryTendDrop respects the chance gate and keeps an installable drop', () => {
    const s = build({ plot: 1 }); // empty rack, free sockets -> any drop is a keeper
    expect(tryTendDrop(s, () => 0.99)).toBeNull(); // above TEND_DROP_CHANCE
    expect(s.inventory).toHaveLength(0);
    const drop = tryTendDrop(s, () => 0.0); // below chance -> drop into a free socket
    expect(drop).not.toBeNull();
    expect(drop!.outcome).toBe('keep');
    expect(s.inventory).toHaveLength(1);
  });

  it('auto-salvages only a drop a perfect reroll could never promote', () => {
    const s = build({ plot: 1 });
    s.rank = 1; // 3 sockets
    // Maxed legendaries: a common's band ceiling (0.10) can't beat 0.50 — true junk.
    s.rack = [
      { id: 'k1', stat: 'stationSpeed', rarity: 'legendary', magnitude: 0.5 },
      { id: 'k2', stat: 'stationYield', rarity: 'legendary', magnitude: 0.5 },
      { id: 'k3', stat: 'eggOutput', rarity: 'legendary', magnitude: 0.5 },
    ];
    const dust0 = s.dust;
    const drop = tryTendDrop(s, () => 0); // common stationSpeed +0.05
    expect(drop!.outcome).toBe('salvaged');
    expect(drop!.dust).toBe(BALANCE.LOOT.SALVAGE_DUST.common);
    expect(s.inventory).toHaveLength(0); // nothing piled up
    expect(s.dust).toBe(dust0 + BALANCE.LOOT.SALVAGE_DUST.common);
  });

  it('keeps a reroll candidate (potential) rather than salvaging it', () => {
    const s = build({ plot: 1 });
    s.rank = 1; // 3 sockets
    // Rack of weak commons: a common drop can't win NOW, but its band ceiling
    // (0.10) could beat the installed 0.06 — so it must be kept, not salvaged.
    s.rack = [
      { id: 'k1', stat: 'stationSpeed', rarity: 'common', magnitude: 0.06 },
      { id: 'k2', stat: 'stationYield', rarity: 'common', magnitude: 0.06 },
      { id: 'k3', stat: 'eggOutput', rarity: 'common', magnitude: 0.06 },
    ];
    const dust0 = s.dust;
    const drop = tryTendDrop(s, () => 0); // common stationSpeed +0.05 (not an upgrade NOW)
    expect(drop!.outcome).toBe('potential');
    expect(s.inventory).toHaveLength(1); // kept for rerolling
    expect(s.dust).toBe(dust0); // not salvaged
  });

  it('engine.tend emits a loot event when a drop fires', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.001); // force a drop
    try {
      const eng = new GameEngine(0);
      eng.state = stockAll(fullSetup());
      const events: LootEvent[] = [];
      eng.onLoot((e) => events.push(e));
      const coop = eng.state.stations.find((s) => s.type === 'coop')!;
      eng.tend(coop.id);
      expect(events.some((e) => e.source === 'drop')).toBe(true);
      expect(eng.state.inventory.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('engine.tend auto-salvages (no loot banner) when the rack is full', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0); // force a common drop
    try {
      const eng = new GameEngine(0);
      eng.state = stockAll(fullSetup());
      eng.state.rank = 1;
      eng.state.rack = [
        { id: 'k1', stat: 'stationSpeed', rarity: 'legendary', magnitude: 0.5 },
        { id: 'k2', stat: 'stationYield', rarity: 'legendary', magnitude: 0.5 },
        { id: 'k3', stat: 'eggOutput', rarity: 'legendary', magnitude: 0.5 },
      ];
      const loot: LootEvent[] = [];
      let salvaged = 0;
      eng.onLoot((e) => loot.push(e));
      eng.onAutosalvage((d) => (salvaged += d));
      const coop = eng.state.stations.find((s) => s.type === 'coop')!;
      coop.tendCooldownRemaining = 0;
      eng.tend(coop.id);
      expect(loot.some((e) => e.source === 'drop')).toBe(false); // no banner for junk
      expect(salvaged).toBeGreaterThan(0); // quiet dust beat instead
      expect(eng.state.inventory).toHaveLength(0); // no spare pile
    } finally {
      spy.mockRestore();
    }
  });

  it('engine.tend emits a milestone loot event when a rank grant is crossed', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.99); // suppress random drop
    try {
      const eng = new GameEngine(0);
      eng.state = stockAll(fullSetup());
      eng.state.rank = 2;
      eng.state.xp = xpForLevel(2) - 1; // one tend crosses to rank 3
      const events: LootEvent[] = [];
      eng.onLoot((e) => events.push(e));
      const coop = eng.state.stations.find((s) => s.type === 'coop')!;
      coop.tendCooldownRemaining = 0;
      eng.tend(coop.id);
      expect(events.some((e) => e.source === 'milestone')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GUARDRAIL: zero modules from passive or offline', () => {
  it('passive production over a long run drops nothing', () => {
    const s = stockAll(fullSetup());
    run(s, 1200); // 20 minutes, no tending
    expect(s.inventory).toHaveLength(0);
    expect(s.dust).toBe(0);
  });

  it('offline catch-up grants no modules (and still no XP)', () => {
    const s = stockAll(fullSetup());
    s.rank = 2;
    s.xp = 40;
    s.lastSeen = -8 * 3600 * 1000;
    runOfflineCatchUp(s, 0);
    expect(s.inventory).toHaveLength(0);
    expect(s.rank).toBe(2);
    expect(s.xp).toBe(40);
  });
});
