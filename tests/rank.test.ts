import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { xpForLevel } from '../src/game/rank';
import { gainXP, tend } from '../src/game/actions';
import { fullSetup, stockAll, run } from './helpers';

describe('rank curve', () => {
  it('follows BASE * GROWTH^(n-1)', () => {
    expect(xpForLevel(1)).toBe(BALANCE.RANK_BASE_XP);
    expect(xpForLevel(2)).toBe(Math.round(BALANCE.RANK_BASE_XP * BALANCE.RANK_GROWTH));
  });
});

describe('gainXP', () => {
  it('cascades through multiple level-ups and reports milestones', () => {
    const s = fullSetup();
    const need = xpForLevel(1) + xpForLevel(2) + xpForLevel(3) + xpForLevel(4);
    const r = gainXP(s, need + 1); // enough to reach rank 5
    expect(s.rank).toBe(5);
    expect(r.levelsGained).toBe(4);
    expect(r.milestones.some((m) => m.rank === BALANCE.MILESTONE_AUTOHAUL_RANK)).toBe(true);
    expect(s.autoHaulUnlocked).toBe(true);
  });
});

describe('tend', () => {
  it('grants XP + a burst and sets a cooldown', () => {
    const s = stockAll(fullSetup());
    run(s, 60); // let the flock settle so the coop has full nutrition
    const coop = s.stations.find((x) => x.type === 'coop')!;
    coop.tendCooldownRemaining = 0;
    const x0 = s.xp;
    const before = coop.buffer.eggs ?? 0;
    const r = tend(s, coop.id);
    expect(r.ok).toBe(true);
    expect(s.xp).toBe(x0 + BALANCE.TEND_XP);
    expect((coop.buffer.eggs ?? 0)).toBeGreaterThan(before);
    expect(coop.tendCooldownRemaining).toBeGreaterThan(0);
    expect(tend(s, coop.id).ok).toBe(false); // on cooldown
  });

  it('is the path to the Rank-5 Auto-Haul milestone', () => {
    const s = stockAll(fullSetup());
    let guard = 0;
    while (s.rank < 5 && guard++ < 10000) {
      for (const st of s.stations) {
        st.tendCooldownRemaining = 0;
        tend(s, st.id);
      }
    }
    expect(s.rank).toBeGreaterThanOrEqual(5);
    expect(s.autoHaulUnlocked).toBe(true);
  });
});
