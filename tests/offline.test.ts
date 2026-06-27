import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { runOfflineCatchUp } from '../src/game/save';
import { build, fullSetup, stockAll, INGREDIENTS } from './helpers';

const N = BALANCE.NUTRITION;
const HOUR = 3600 * 1000;

describe('offline catch-up × nutrition', () => {
  it('grants no XP or rank while running nutrition', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    s.resources.corn = 1e6;
    s.rank = 4;
    s.xp = 33;
    s.lastSeen = -HOUR;
    const away = runOfflineCatchUp(s, 0);
    expect(s.rank).toBe(4);
    expect(s.xp).toBe(33);
    expect(away.produced.eggs ?? 0).toBeGreaterThan(0); // floored, still lays
  });

  it('a fed flock out-lays (and out-conditions) a starved one offline', () => {
    const fed = stockAll(fullSetup());
    fed.lastSeen = -HOUR;
    const starved = build({ plot: 1, mill: 1, coop: 1 });
    starved.resources.corn = 1e6;
    starved.lastSeen = -HOUR;
    const aFed = runOfflineCatchUp(fed, 0);
    const aStarved = runOfflineCatchUp(starved, 0);
    expect(aFed.produced.eggs ?? 0).toBeGreaterThan((aStarved.produced.eggs ?? 0) * 1.5);
    expect(fed.condition).toBeGreaterThan(starved.condition);
  });

  it('the away summary reflects the throttle (good ration > bad ration)', () => {
    const good = stockAll(fullSetup());
    good.lastSeen = -HOUR;
    const bad = stockAll(fullSetup());
    bad.ration = { corn: 0.1, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0 };
    bad.condition = 0;
    bad.lastSeen = -HOUR;
    const ag = runOfflineCatchUp(good, 0);
    const ab = runOfflineCatchUp(bad, 0);
    expect(ag.produced.eggs ?? 0).toBeGreaterThan((ab.produced.eggs ?? 0) * 2);
  });

  it('caps at OFFLINE_CAP_HOURS and survives clock skew without negative storage', () => {
    const s = stockAll(fullSetup());
    s.lastSeen = -(BALANCE.OFFLINE_CAP_HOURS + 10) * HOUR;
    const away = runOfflineCatchUp(s, 0);
    expect(away.capped).toBe(true);
    expect(Math.abs(away.creditedSeconds - BALANCE.OFFLINE_CAP_HOURS * 3600)).toBeLessThan(1);
    expect(INGREDIENTS.every((k) => s.resources[k] >= 0)).toBe(true);

    const future = build({ plot: 1, mill: 1, coop: 1 });
    future.lastSeen = 5000; // ahead of "now"
    const a2 = runOfflineCatchUp(future, 0);
    expect(a2.creditedSeconds).toBe(0);
    expect(Object.keys(a2.produced)).toHaveLength(0);
  });

  it('idle exposes you: long offline with no niacin leaves the flock limping', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    s.resources.corn = 1e6;
    s.lastSeen = -8 * HOUR;
    runOfflineCatchUp(s, 0);
    expect(s.stations.find((x) => x.type === 'coop')!.debuffed).toBe(true);
  });

  it('but a well-conditioned flock resists the debuff offline', () => {
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, oysterSource: 1, mill: 1, coop: 1 }));
    s.resources.brewersYeast = 0; // niacin 0, but E/P/Ca fed -> condition holds
    s.lastSeen = -8 * HOUR;
    runOfflineCatchUp(s, 0);
    expect(s.stations.find((x) => x.type === 'coop')!.debuffed).toBeFalsy();
  });
});
