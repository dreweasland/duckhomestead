import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { unlockZone } from '../src/game/actions';
import { runOfflineCatchUp } from '../src/game/save';
import { build, fullSetup, setHens, run } from './helpers';

const F = BALANCE.ZONES.FORAGE;
const ratePerS = F.energyPerCycle / F.cycleSeconds; // flat, non-scaling

/** A fresh state with the back pasture forced unlocked. */
function withPasture() {
  const s = build({});
  s.zones.backPasture.unlocked = true;
  return s;
}

describe('free-range forage', () => {
  it('drips a flat, non-scaling energy feed into shared storage', () => {
    const s = withPasture(); // no ducks -> forage just accumulates
    run(s, 100);
    expect(s.resources.forage).toBeCloseTo(100 * ratePerS, 0);
  });

  it('production does NOT scale with flock size', () => {
    const small = withPasture();
    const big = withPasture();
    setHens(small, 0); // ensure no consumers in either
    setHens(big, 0);
    // (no ducks in either; the node rate must be identical regardless)
    run(small, 60);
    run(big, 60);
    expect(small.resources.forage).toBeCloseTo(big.resources.forage, 5);
    expect(small.resources.forage).toBeCloseTo(60 * ratePerS, 0);
  });

  it('a locked zone produces no forage', () => {
    const s = build({}); // backPasture locked by default
    run(s, 100);
    expect(s.resources.forage).toBe(0);
  });

  it('feeds ENERGY only — never protein, niacin, or calcium', () => {
    // A laying flock with NO ingredients in storage, only foraged feed.
    const s = setHens(build({ mill: 1, coop: 1 }), 2);
    s.zones.backPasture.unlocked = true;
    s.resources.forage = 1e6; // plenty of forage, zero ingredients
    run(s, 30);
    const sup = s.nutrition!.supply;
    expect(sup.energy).toBeGreaterThan(0); // forage covered energy
    expect(sup.protein).toBe(0);
    expect(sup.niacin).toBe(0);
    expect(sup.calcium).toBe(0);
    expect(s.resources.forage).toBeLessThan(1e6); // and it was actually eaten
  });

  it('lets the player drop corn from the ration (energy relief)', () => {
    // Same flock, corn ration zeroed: forage holds energy satisfaction up.
    const withForage = setHens(stockNoForage(fullSetup()), 2);
    withForage.ration = { ...withForage.ration, corn: 0 };
    withForage.zones.backPasture.unlocked = true;
    withForage.resources.forage = 1e6;
    run(withForage, 60);

    const withoutForage = setHens(stockNoForage(fullSetup()), 2);
    withoutForage.ration = { ...withoutForage.ration, corn: 0 };
    run(withoutForage, 60);

    expect(withForage.nutrition!.satisfaction.energy).toBeGreaterThan(
      withoutForage.nutrition!.satisfaction.energy + 0.3,
    );
  });

  it('accrues offline at the reduced rate and grants no XP', () => {
    const s = withPasture();
    s.rank = 4;
    s.xp = 12;
    s.lastSeen = -3600 * 1000; // 1h ago
    runOfflineCatchUp(s, 0);
    // ~1h at the offline rate (within a cycle of float drift over 3600 steps).
    const expected = 3600 * ratePerS * BALANCE.OFFLINE_RATE_MULT;
    expect(s.resources.forage).toBeGreaterThan(expected * 0.99);
    expect(s.resources.forage).toBeLessThanOrEqual(expected);
    expect(s.rank).toBe(4);
    expect(s.xp).toBe(12);
  });
});

describe('zone unlock gate', () => {
  it('is double-gated: needs the rank AND the egg cost', () => {
    const z = BALANCE.ZONES.BACK_PASTURE;
    const poor = build({});
    poor.rank = z.rankRequired;
    poor.resources.eggs = z.eggCost - 1;
    expect(unlockZone(poor, 'backPasture').ok).toBe(false); // can't afford

    const lowRank = build({});
    lowRank.rank = z.rankRequired - 1;
    lowRank.resources.eggs = z.eggCost;
    expect(unlockZone(lowRank, 'backPasture').ok).toBe(false); // under-ranked

    const ready = build({});
    ready.rank = z.rankRequired;
    ready.resources.eggs = z.eggCost + 10;
    const r = unlockZone(ready, 'backPasture');
    expect(r.ok).toBe(true);
    expect(ready.zones.backPasture.unlocked).toBe(true);
    expect(ready.resources.eggs).toBe(10); // the big sink was paid
    expect(unlockZone(ready, 'backPasture').ok).toBe(false); // not twice
  });
});

/** fullSetup but ensure forage starts empty (helpers.stockAll skips forage). */
function stockNoForage(s: ReturnType<typeof fullSetup>) {
  for (const k of ['corn', 'peas', 'mealworms', 'brewersYeast', 'oysterShell'] as const) {
    s.resources[k] = 1e6;
  }
  s.resources.forage = 0;
  return s;
}
