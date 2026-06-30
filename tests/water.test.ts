import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { initialState, zoneUnlocked, type Duck, type GameState, type Genotype } from '../src/game/state';
import {
  waterProvision,
  flockRequirement,
  waterAccess,
  waterCurve,
  waterConditionMult,
  waterWoundMult,
} from '../src/game/water';
import { unlockZone } from '../src/game/actions';
import { placePondFeature, pondFeatureUpgradeCost, upgradePondFeature } from '../src/game/pond';
import { runPredators } from '../src/game/predators';
import { serialize, deserialize, runOfflineCatchUp } from '../src/game/save';
import { setHens, stockAll, fullSetup, run } from './helpers';

const W = BALANCE.WATER;
const HOUR = 3600 * 1000;

function ducks(n: number, stage: Duck['stage'] = 'adult'): Duck[] {
  return Array.from({ length: n }, (_, i): Duck => ({
    id: `w${i}`,
    genotype: ['bl', 'bl'] as Genotype,
    genome: ['D', 'D', 'D', 'D', 'D', 'D'],
    sex: i % 2 ? 'hen' : 'drake',
    stage,
    ageTicks: 0,
  }));
}

describe('the Pond is a standard staged zone unlock', () => {
  it('teased + locked, then unlockable at its rank + egg gate', () => {
    const s = initialState(0);
    expect(zoneUnlocked(s, 'pond')).toBe(false);
    s.rank = W.POND_UNLOCK.rankRequired;
    s.resources.eggs = W.POND_UNLOCK.eggCost;
    expect(unlockZone(s, 'pond').ok).toBe(true);
    expect(zoneUnlocked(s, 'pond')).toBe(true);
  });
});

describe('provision = layoutBase × circulationHealth, scored vs the flock', () => {
  it('an empty pond gives the always-on baseline provision (never punishes a small flock)', () => {
    const s = initialState(0);
    expect(waterProvision(s)).toBe(W.YARD_BASELINE_PROVISION);
  });

  it('a placed pond feature raises provision (layoutBase grows)', () => {
    const s = initialState(0);
    s.zones.pond.unlocked = true;
    s.pond.features.push({ x: 0, y: 0, type: 'deepZone' });
    expect(waterProvision(s)).toBe(W.YARD_BASELINE_PROVISION + W.FEATURES.deepZone.baseProvision);
  });

  it('access = provision / (flock × REQUIREMENT_PER_DUCK); infinite (neutral-safe) with no flock', () => {
    const s = initialState(0);
    expect(waterAccess(s)).toBe(Infinity);
    s.ducks = ducks(3); // 6 / (3 × 1) = 2.0
    expect(flockRequirement(s)).toBeCloseTo(3 * W.REQUIREMENT_PER_DUCK, 6);
    expect(waterAccess(s)).toBeCloseTo(W.YARD_BASELINE_PROVISION / 3, 6);
  });

  it('upgrading a pond feature scales its provision (the pre-prestige water sink)', () => {
    const s = initialState(0);
    s.zones.pond.unlocked = true;
    s.resources.eggs = 1e7;
    placePondFeature(s, 'deepZone', 0, 0);
    const featProv = waterProvision(s) - W.YARD_BASELINE_PROVISION; // the deepZone's contribution
    const cost = pondFeatureUpgradeCost(s, 0, 0);
    expect(cost).toBe(Math.round(W.FEATURES.deepZone.costEggs * W.UPGRADE.costGrowth)); // level 1 → ^1
    expect(upgradePondFeature(s, 0, 0).ok).toBe(true);
    expect(s.pond.features[0].level).toBe(2);
    const after = waterProvision(s) - W.YARD_BASELINE_PROVISION;
    expect(after).toBeCloseTo(featProv * W.UPGRADE.provisionMult, 6);
    expect(s.resources.eggs).toBe(1e7 - W.FEATURES.deepZone.costEggs - cost); // place + upgrade
  });

  it('a spring cannot be upgraded — positional, no own provision to scale (no wasted eggs)', () => {
    const s = initialState(0);
    s.zones.pond.unlocked = true;
    s.resources.eggs = 1e6;
    placePondFeature(s, 'spring', 0, 0);
    const r = upgradePondFeature(s, 0, 0);
    expect(r.ok).toBe(false);
    expect(s.pond.features[0].level ?? 1).toBe(1); // not leveled
    expect(s.resources.eggs).toBe(1e6 - W.FEATURES.spring.costEggs); // only the place cost spent
  });

  it('the legacy Water Capacity boost scales provision past the fixed-pond ceiling', () => {
    const s = initialState(0);
    const base = waterProvision(s);
    const lvls = 5;
    s.purchasedBoosts.waterProvision = lvls; // +10%/level
    const expected = base * (1 + BALANCE.PRESTIGE.BOOSTS.waterProvision.perLevel * lvls);
    expect(waterProvision(s)).toBeCloseTo(expected, 6);
    expect(waterProvision(s)).toBeGreaterThan(base); // a bigger flock can now be watered
  });
});

describe('the saturation curve (unchanged wellness math)', () => {
  it('hits its anchors: neutral at 1, atHalf at 0.5, atDouble at 2, flat beyond', () => {
    expect(waterCurve(1, 0.6, 1.4)).toBeCloseTo(1, 6);
    expect(waterCurve(0.5, 0.6, 1.4)).toBeCloseTo(0.6, 6);
    expect(waterCurve(2, 0.6, 1.4)).toBeCloseTo(1.4, 6);
    expect(waterCurve(5, 0.6, 1.4)).toBeCloseTo(1.4, 6); // saturates flat past 2
  });

  it('declines below 1 (scaled by shortfall) and rewards above 1 with diminishing returns', () => {
    expect(waterCurve(0.75, 0.6, 1.4)).toBeGreaterThan(waterCurve(0.5, 0.6, 1.4));
    expect(waterCurve(0.5, 0.6, 1.4)).toBeLessThan(1);
    const at1_5 = waterCurve(1.5, 0.6, 1.4);
    expect(at1_5 - 1).toBeGreaterThan(1.4 - at1_5); // concave
  });
});

describe('water modifies condition + wound recovery — and nothing else', () => {
  it('a well-watered flock regenerates condition faster than a thirsty one', () => {
    const flush = setHens(stockAll(fullSetup()), 1); // 6 / 1 → reward
    const thirsty = setHens(stockAll(fullSetup()), 30); // 6 / 30 → deep decline
    flush.condition = 20;
    thirsty.condition = 20;
    run(flush, 30);
    run(thirsty, 30);
    expect(flush.condition).toBeGreaterThan(thirsty.condition);
  });

  it('water stretches/tightens the wound-escalation timer', () => {
    expect(waterWoundMult({ ...initialState(0), ducks: ducks(1) } as GameState)).toBeGreaterThan(1); // flush
    const thirsty = { ...initialState(0), ducks: ducks(30) } as GameState;
    expect(waterWoundMult(thirsty)).toBeLessThan(1);
  });

  it('never touches the nutrition axes (same flock, different water → axes identical)', () => {
    // Hold the flock (heads/ration/stock) fixed and change ONLY the water layout.
    const dry = setHens(stockAll(fullSetup()), 4); // provision 6 / 4 = 1.5
    const wet = setHens(stockAll(fullSetup()), 4);
    wet.zones.pond.unlocked = true;
    wet.pond.features.push({ x: 0, y: 0, type: 'deepZone' }); // much more water, same flock
    run(dry, 60);
    run(wet, 60);
    expect(wet.nutrition!.requirement).toEqual(dry.nutrition!.requirement);
    for (const a of ['energy', 'protein', 'niacin', 'calcium'] as const) {
      expect(wet.nutrition!.satisfaction[a]).toBeCloseTo(dry.nutrition!.satisfaction[a], 5);
    }
  });
});

describe('NO new death path (locked constraint)', () => {
  it('even at the lowest water, a wound keeps a real window to treat (> 0)', () => {
    const s = { ...initialState(0), ducks: ducks(200) } as GameState; // extreme thirst
    const mult = waterWoundMult(s);
    expect(mult).toBeGreaterThan(0.3); // timer never collapses to an instant kill
    expect(BALANCE.PREDATORS.WOUND_ESCALATE_SEC * mult).toBeGreaterThan(60); // still > a minute
  });

  it('attributability holds under low water: secured+defended flock takes no losses', () => {
    const s = initialState(0);
    s.rank = 5;
    s.resources.eggs = 1e7;
    s.ducks = ducks(40); // low water (6 / 40)
    s.predatorsIntroduced = true;
    s.secureCoops = 10;
    for (let i = 0; i < 5; i++) s.deterrents += 1;
    for (const d of s.ducks) d.secured = true;
    for (let t = 0; t < 3600; t++) runPredators(s, 1, { mode: 'online', rng: () => 0 });
    expect(s.ducks).toHaveLength(40);
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
  });
});

describe('offline + back-compat', () => {
  it('water modifiers apply during offline catch-up (no XP)', () => {
    const flush = setHens(stockAll(fullSetup()), 1);
    const thirsty = setHens(stockAll(fullSetup()), 30);
    flush.condition = 20;
    thirsty.condition = 20;
    flush.rank = 4;
    flush.xp = 12;
    flush.lastSeen = -HOUR;
    thirsty.lastSeen = -HOUR;
    runOfflineCatchUp(flush, 0);
    runOfflineCatchUp(thirsty, 0);
    expect(flush.condition).toBeGreaterThan(thirsty.condition);
    expect(flush.rank).toBe(4); // offline grants no XP
    expect(flush.xp).toBe(12);
  });

  it('a pre-rework save loads with the pond locked + empty, baseline provision only', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { eggs: 100 },
      stations: [],
      rank: 20,
      // pre-rework fields that must be dropped cleanly:
      irrigation: { channels: { '3,1': 0.5 }, crop: [1], health: 0.3 },
      waterFeatures: 5,
      ducks: [{ id: 'd0', genotype: ['Bl', 'bl'], vigor: 1, sex: 'hen', stage: 'adult', ageTicks: 0 }],
    });
    const s = deserialize(legacy, 0);
    expect(zoneUnlocked(s, 'pond')).toBe(false);
    expect(s.pond).toEqual({ features: [], flow: [], freshness: {} });
    expect(waterProvision(s)).toBe(W.YARD_BASELINE_PROVISION);
  });

  it('water-system state round-trips through serialize', () => {
    const s = initialState(0);
    s.zones.pond.unlocked = true;
    s.pond.features.push({ x: 1, y: 1, type: 'bathingPool' });
    s.pond.flow.push({ x: 2, y: 1, type: 'fountain' });
    s.pond.freshness['1,1'] = 0.7;
    const r = deserialize(serialize(s), 0);
    expect(r.pond).toEqual(s.pond);
    expect(waterProvision(r)).toBe(waterProvision(s));
  });
});
