import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { GameEngine } from '../src/game/engine';
import { gainXP } from '../src/game/actions';

describe('Tending Whistle (Tend All sweep)', () => {
  it('unlocks at its milestone rank via XP', () => {
    const eng = new GameEngine(0);
    expect(eng.state.tendAllUnlocked).toBe(false);
    // Vault to the milestone rank.
    for (let i = 0; i < 50 && eng.state.rank < BALANCE.MILESTONE_TENDALL_RANK; i++) {
      gainXP(eng.state, 100000);
    }
    expect(eng.state.rank).toBeGreaterThanOrEqual(BALANCE.MILESTONE_TENDALL_RANK);
    expect(eng.state.tendAllUnlocked).toBe(true);
  });

  it('tends every ready station at once and re-syncs their cooldowns', () => {
    const eng = new GameEngine(0); // newGame pre-places plot+mill+coop
    const s = eng.state;
    s.stations.forEach((st) => (st.tendCooldownRemaining = 0));
    const n = s.stations.length;
    expect(n).toBeGreaterThan(0);
    const rankXp0 = s.rank * 1e6 + s.xp; // monotonic proxy for total XP

    const res = eng.tendAll();
    expect(res.tended).toBe(n); // all ready stations swept
    // Every station now on a fresh cooldown -> a real breather.
    expect(s.stations.every((st) => st.tendCooldownRemaining > 0)).toBe(true);
    expect(s.rank * 1e6 + s.xp).toBeGreaterThan(rankXp0); // granted XP (n * TEND_XP)

    // Immediately sweeping again does nothing (all cooling down).
    expect(eng.tendAll().tended).toBe(0);
  });

  it('grants the same XP as tending each station individually', () => {
    const sweep = new GameEngine(0);
    sweep.state.stations.forEach((st) => (st.tendCooldownRemaining = 0));
    const manual = new GameEngine(0);
    manual.state.stations.forEach((st) => (st.tendCooldownRemaining = 0));

    sweep.tendAll();
    for (const st of manual.state.stations) manual.tend(st.id);

    expect(sweep.state.rank).toBe(manual.state.rank);
    expect(sweep.state.xp).toBeCloseTo(manual.state.xp, 5);
  });
});
