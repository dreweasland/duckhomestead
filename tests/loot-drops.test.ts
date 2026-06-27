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
  it('tryTendDrop respects the chance gate and rolls into inventory', () => {
    const s = build({ plot: 1 });
    expect(tryTendDrop(s, () => 0.99)).toBeNull(); // above TEND_DROP_CHANCE
    expect(s.inventory).toHaveLength(0);
    const m = tryTendDrop(s, () => 0.0); // below chance -> drop
    expect(m).not.toBeNull();
    expect(s.inventory).toHaveLength(1);
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
