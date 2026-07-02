import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { runOfflineCatchUp } from '../src/game/save';
import { tick } from '../src/game/tick';
import { waterWoundMult } from '../src/game/water';
import { build, fullSetup, stockAll, setHens, run, INGREDIENTS } from './helpers';

const N = BALANCE.NUTRITION;
const HOUR = 3600 * 1000;

describe('offline catch-up × the mercy rail boundary', () => {
  it('rewinds brink-held wounds on return — they must NOT escalate on the first online frame', () => {
    const s = setHens(stockAll(fullSetup()), 2);
    // A wound at the very brink of escalation (what the exhausted mercy budget
    // leaves behind), with no infirmary to auto-admit it.
    s.ducks[0].wounded = true;
    s.ducks[0].woundSource = 'predator';
    s.ducks[0].woundElapsed = BALANCE.PREDATORS.WOUND_ESCALATE_SEC * waterWoundMult(s);
    s.lastSeen = -60 * 1000; // a real (short) absence
    runOfflineCatchUp(s, 0);

    // Still alive, and rewound to a real triage window…
    const survivor = s.ducks.find((d) => d.id === 'h0');
    expect(survivor?.wounded).toBe(true);
    const threshold = BALANCE.PREDATORS.WOUND_ESCALATE_SEC * waterWoundMult(s);
    expect(survivor!.woundElapsed!).toBeLessThanOrEqual(
      threshold - BALANCE.PREDATORS.OFFLINE_RETURN_WOUND_GRACE_S,
    );
    // …so the first online frames (behind the Away modal) can't kill it.
    for (let i = 0; i < 10; i++) tick(s, 0.1, { mode: 'online', autoHaul: true });
    expect(s.ducks.some((d) => d.id === 'h0')).toBe(true);
  });
});

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
    const fed = setHens(stockAll(fullSetup()), 1); // fixed vigor for a fair compare
    fed.lastSeen = -HOUR;
    const starved = setHens(build({ plot: 1, mill: 1, coop: 1 }), 1);
    starved.resources.corn = 1e6;
    starved.lastSeen = -HOUR;
    const aFed = runOfflineCatchUp(fed, 0);
    const aStarved = runOfflineCatchUp(starved, 0);
    expect(aFed.produced.eggs ?? 0).toBeGreaterThan((aStarved.produced.eggs ?? 0) * 1.5);
    expect(fed.condition).toBeGreaterThan(starved.condition);
  });

  it('the away summary reflects the throttle (good ration > bad ration)', () => {
    const good = setHens(stockAll(fullSetup()), 1);
    good.lastSeen = -HOUR;
    const bad = setHens(stockAll(fullSetup()), 1);
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

  it('offline production equals online production × OFFLINE_RATE_MULT (raw producers)', () => {
    const T = 3600; // 1 hour, well under the 8h cap
    const mult = BALANCE.OFFLINE_RATE_MULT;

    // Lone plots: no flock → no nutrition or predators to muddy the comparison.
    const online = build({ plot: 3 });
    const beforeOn = online.resources.corn;
    run(online, T);
    const gainedOnline = online.resources.corn - beforeOn;

    const offline = build({ plot: 3 });
    const beforeOff = offline.resources.corn;
    offline.lastSeen = -T * 1000;
    runOfflineCatchUp(offline, 0);
    const gainedOffline = offline.resources.corn - beforeOff;

    expect(gainedOnline).toBeGreaterThan(0);
    // Offline is the same sim, only throttled by the rate multiplier.
    expect(gainedOffline / gainedOnline).toBeCloseTo(mult, 2);
  });

  it('idle exposes you: long offline with no niacin leaves a duck limping', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    s.resources.corn = 1e6;
    s.lastSeen = -8 * HOUR;
    const away = runOfflineCatchUp(s, 0);
    expect(s.ducks.some((d) => d.debuffed)).toBe(true);
    expect(away.debuffed ?? 0).toBeGreaterThan(0); // and the away toll surfaces the NEW limp
  });

  it('away toll counts only NET-NEW afflictions, not pre-existing wounds/debuffs', () => {
    // Leaving already afflicted (each reported live at the time) and taking no fresh
    // hits offline must yield a clean toll — no double-report as "the owl, in the night."
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, oysterSource: 1, mill: 1, coop: 1 }));
    setHens(s, 2);
    s.ducks[0].wounded = true;
    s.ducks[0].woundSource = 'predator';
    s.ducks[1].debuffed = true;
    s.lastSeen = -60 * 1000; // 60s: well-fed (no new debuff), < 240s escalate (wound survives)
    const away = runOfflineCatchUp(s, 0);
    expect(s.ducks[0].wounded).toBe(true); // still wounded — but it predates the trip
    expect(away.predator).toBeUndefined();
    expect(away.overcrowd).toBeUndefined();
    expect(away.debuffed).toBeUndefined();
  });

  it('but a well-conditioned flock resists the debuff offline', () => {
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, oysterSource: 1, mill: 1, coop: 1 }));
    setHens(s, 1);
    s.resources.brewersYeast = 0; // niacin 0, but E/P/Ca fed -> condition holds
    s.lastSeen = -8 * HOUR;
    runOfflineCatchUp(s, 0);
    expect(s.ducks.some((d) => d.debuffed)).toBe(false);
  });

  it('offline: the infirmary auto-admits a wounded duck and heals it (no loss)', () => {
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, oysterSource: 1, mill: 1, coop: 1 }));
    setHens(s, 3);
    s.infirmaries = 1; // recovery slots; predators not introduced → no NEW attacks
    s.ducks[0].wounded = true;
    s.ducks[0].severity = 'minor';
    s.ducks[0].woundElapsed = 0;
    s.lastSeen = -1 * HOUR; // >> the 90s minor recovery, well past the 240s deadline
    runOfflineCatchUp(s, 0);
    const d0 = s.ducks.find((d) => d.id === 'h0');
    expect(d0).toBeDefined(); // survived — auto-admitted, not escalated
    expect(d0!.wounded).toBe(false); // fully recovered while away
  });

  it('offline: WITHOUT an infirmary, an untended wound still escalates to a loss', () => {
    const s = stockAll(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, oysterSource: 1, mill: 1, coop: 1 }));
    setHens(s, 12); // mercy-rail budget = floor(12 × 0.25) = 3 permits this loss
    s.infirmaries = 0; // no slots → no admission → the wound ages out
    s.ducks[0].wounded = true;
    s.ducks[0].severity = 'minor';
    s.ducks[0].woundElapsed = 0;
    s.lastSeen = -1 * HOUR; // past the 240s escalation deadline
    const away = runOfflineCatchUp(s, 0);
    expect(s.ducks.find((d) => d.id === 'h0')).toBeUndefined(); // lost — the death path survives
    expect(away.predator?.lost ?? 0).toBeGreaterThan(0);
  });
});
