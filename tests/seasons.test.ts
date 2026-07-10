import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import {
  advanceSeason,
  currentSeasonId,
  seasonClutchRate,
  seasonDemandDelta,
  seasonForageMult,
  seasonFoulMult,
  seasonProducerMult,
  seasonsActive,
} from '../src/game/season';
import { deserialize, serialize } from '../src/game/save';
import { initialState } from '../src/game/state';
import { tick } from '../src/game/tick';
import { build } from './helpers';

const S = BALANCE.SEASONS;

describe('the season clock: active-only, attended, persistent', () => {
  it('dormant below INTRO_RANK — onboarding demand never shifts', () => {
    const s = initialState(0);
    s.rank = S.INTRO_RANK - 1;
    expect(seasonsActive(s)).toBe(false);
    advanceSeason(s, S.LENGTH_S * 3);
    expect(s.season.index).toBe(0);
    expect(seasonProducerMult(s, 'peaPatch')).toBe(1);
    expect(seasonDemandDelta(s, 'energy')).toBe(0);
  });

  it('rolls through the year in order, queueing one announcement per turn', () => {
    const s = initialState(0);
    s.rank = S.INTRO_RANK;
    expect(currentSeasonId(s)).toBe('spring');
    advanceSeason(s, S.LENGTH_S);
    expect(currentSeasonId(s)).toBe('summer');
    expect(s.pendingSeasonChange).toBe('summer');
    advanceSeason(s, S.LENGTH_S * 3); // the rest of the year → back to spring
    expect(currentSeasonId(s)).toBe('spring');
  });

  it('only ACTIVE online play advances it (guard + offline hold the season)', () => {
    const s = build({ plot: 1 });
    s.rank = S.INTRO_RANK;
    // Guard (activeRemaining 0): frozen.
    for (let i = 0; i < 100; i++) tick(s, 10, { mode: 'online', autoHaul: true });
    expect(s.season.elapsed).toBe(0);
    // Offline: frozen.
    for (let i = 0; i < 100; i++) tick(s, 10, { mode: 'offline', autoHaul: true });
    expect(s.season.elapsed).toBe(0);
    // Active: it runs.
    s.activeRemaining = 1e9;
    tick(s, 10, { mode: 'online', autoHaul: true });
    expect(s.season.elapsed).toBe(10);
  });

  it('persists across a save round-trip; the toast never replays', () => {
    const s = initialState(0);
    s.rank = S.INTRO_RANK;
    advanceSeason(s, S.LENGTH_S + 5);
    const back = deserialize(serialize(s), 0);
    expect(back.season.index).toBe(1);
    expect(back.season.elapsed).toBeCloseTo(5, 6);
    expect(back.pendingSeasonChange).toBeUndefined();
  });
});

describe('seasonal tilts reach the systems they name', () => {
  const at = (id: string): ReturnType<typeof initialState> => {
    const s = initialState(0);
    s.rank = S.INTRO_RANK;
    s.season.index = (S.ORDER as readonly string[]).indexOf(id);
    return s;
  };

  it('producer rates: spring peas, autumn corn, lean winter', () => {
    expect(seasonProducerMult(at('spring'), 'peaPatch')).toBe(1.5);
    expect(seasonProducerMult(at('autumn'), 'plot')).toBe(1.5);
    expect(seasonProducerMult(at('winter'), 'plot')).toBe(0.8);
    expect(seasonProducerMult(at('spring'), 'plot')).toBe(1); // untouched types stay 1
  });

  it('a seasonal producer tilt shows up in real output', () => {
    const spring = build({ peaPatch: 1 });
    spring.rank = S.INTRO_RANK;
    const winter = build({ peaPatch: 1 });
    winter.rank = S.INTRO_RANK;
    winter.season.index = 3;
    for (let i = 0; i < 1200; i++) {
      tick(spring, 0.1, { mode: 'online', autoHaul: true });
      tick(winter, 0.1, { mode: 'online', autoHaul: true });
    }
    // 120s: spring peas at 1.5× vs winter at 0.8× — a real, visible gap.
    expect(spring.resources.peas).toBeGreaterThan(winter.resources.peas * 1.5);
  });

  it('demand tilts: summer eats light, winter heavy, autumn wants calcium', () => {
    expect(seasonDemandDelta(at('summer'), 'energy')).toBe(-1);
    expect(seasonDemandDelta(at('winter'), 'energy')).toBe(1.5);
    expect(seasonDemandDelta(at('autumn'), 'calcium')).toBe(0.5);
    expect(seasonDemandDelta(at('spring'), 'energy')).toBe(0);
  });

  it('clutch, forage, and fouling rates carry their season', () => {
    expect(seasonClutchRate(at('spring'))).toBe(1.25);
    expect(seasonForageMult(at('winter'))).toBe(0.5);
    expect(seasonFoulMult(at('summer'))).toBe(1.5);
    expect(seasonFoulMult(at('winter'))).toBe(0.75);
  });
});
