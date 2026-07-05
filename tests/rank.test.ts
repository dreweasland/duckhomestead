import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { xpForLevel, rankProgress, milestoneAtRank } from '../src/game/rank';
import { gainXP, tend } from '../src/game/actions';
import { build, fullSetup, stockAll, run } from './helpers';

const GRANTS = BALANCE.LOOT.MILESTONE_GRANTS;

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

  it('grants a guaranteed module of the configured rarity when a grant rank is crossed', () => {
    const s = fullSetup();
    s.rank = 2;
    s.xp = 0;
    s.inventory = [];
    const r = gainXP(s, xpForLevel(2) + 1); // 2 → 3, crossing the rank-3 grant
    expect(s.rank).toBe(3);
    expect(r.grantedModules).toHaveLength(1);
    expect(r.grantedModules[0].rarity).toBe(GRANTS[3]); // 'uncommon'
    expect(s.inventory).toContain(r.grantedModules[0]); // landed in spares
  });

  it('a big jump crossing several grant ranks grants each, in ascending rank order', () => {
    const s = fullSetup();
    s.rank = 1;
    s.xp = 0;
    s.inventory = [];
    let need = 0;
    for (let n = 1; n <= 7; n++) need += xpForLevel(n); // 1 → 8, crossing grants at 3 and 8
    const r = gainXP(s, need);
    expect(s.rank).toBe(8);
    expect(r.grantedModules.map((m) => m.rarity)).toEqual([GRANTS[3], GRANTS[8]]);
    expect(s.inventory).toHaveLength(2);
  });
});

describe('rankProgress + milestoneAtRank', () => {
  it('rankProgress is xp / needed, clamped to [0,1]', () => {
    const need = xpForLevel(3);
    expect(rankProgress(3, 0)).toBe(0);
    expect(rankProgress(3, need / 2)).toBeCloseTo(0.5, 6);
    expect(rankProgress(3, need)).toBe(1);
    expect(rankProgress(3, need * 5)).toBe(1); // never over-fills the bar
  });

  it('milestoneAtRank returns a milestone only at its exact rank', () => {
    expect(milestoneAtRank(BALANCE.MILESTONE_AUTOHAUL_RANK)?.rank).toBe(BALANCE.MILESTONE_AUTOHAUL_RANK);
    expect(milestoneAtRank(BALANCE.MILESTONE_TENDALL_RANK)?.kind).toBe('tend');
    expect(milestoneAtRank(2)).toBeUndefined(); // a plain rank has no milestone
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

describe('the kneed rank curve + level-scaled tend XP (rank 25 must be reachable)', () => {
  it('early curve is byte-identical; the tail grows gently from the knee', () => {
    const B = BALANCE;
    for (let n = 1; n <= B.RANK_SOFT_KNEE; n++) {
      expect(xpForLevel(n)).toBe(Math.round(B.RANK_BASE_XP * Math.pow(B.RANK_GROWTH, n - 1)));
    }
    // Continuity at the knee: the first tail step is knee-value × tail growth.
    expect(xpForLevel(B.RANK_SOFT_KNEE + 1)).toBe(
      Math.round(B.RANK_BASE_XP * Math.pow(B.RANK_GROWTH, B.RANK_SOFT_KNEE - 1) * B.RANK_TAIL_GROWTH),
    );
    // The playtest wall: 22→23 must be a session, not an era (was ~246k).
    expect(xpForLevel(22)).toBeLessThan(60_000);
    // …and 25 (the siege debut) affordable within a deep run.
    const to25 = xpForLevel(22) + xpForLevel(23) + xpForLevel(24);
    expect(to25).toBeLessThan(220_000);
  });

  it('tend XP rides the station level (an L1 pays the classic 20)', () => {
    const s = build({ plot: 1 });
    run(s, 100); // ready to tend
    const before = s.xp;
    tend(s, s.stations[0].id);
    expect(s.xp - before).toBe(BALANCE.TEND_XP); // L1 unchanged
    const s2 = build({ plot: 1 });
    s2.stations[0].level = 10;
    s2.rank = 20; // far from the next level — no cascade eats the measurement
    run(s2, 100);
    const b2 = s2.xp;
    tend(s2, s2.stations[0].id);
    expect(s2.xp - b2).toBe(BALANCE.TEND_XP * 10);
  });
});
