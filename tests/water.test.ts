import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { initialState, zoneUnlocked, type Duck, type GameState, type Genotype } from '../src/game/state';
import {
  waterCapacity,
  waterAccess,
  waterCurve,
  waterConditionMult,
  waterWoundMult,
  canBuildWaterFeatures,
} from '../src/game/water';
import { buildWaterFeature, unlockZone } from '../src/game/actions';
import { runPredators } from '../src/game/predators';
import { serialize, deserialize, runOfflineCatchUp } from '../src/game/save';
import { setHens, stockAll, fullSetup, run } from './helpers';

const W = BALANCE.WATER;
const HOUR = 3600 * 1000;

function ducks(n: number, stage: Duck['stage'] = 'adult'): Duck[] {
  return Array.from({ length: n }, (_, i): Duck => ({
    id: `w${i}`,
    genotype: ['bl', 'bl'] as Genotype,
    vigor: 1,
    sex: i % 2 ? 'hen' : 'drake',
    stage,
    ageTicks: 0,
  }));
}

describe('pond zone is pure config (no new architecture)', () => {
  it('the pond is a ZONE_DEFS entry with the standard unlock shape + water', () => {
    const s = initialState(0);
    expect(zoneUnlocked(s, 'pond')).toBe(false); // teased + locked, like the pasture
    s.rank = BALANCE.ZONES.POND.rankRequired;
    s.resources.eggs = BALANCE.ZONES.POND.eggCost;
    expect(unlockZone(s, 'pond').ok).toBe(true);
    expect(zoneUnlocked(s, 'pond')).toBe(true);
  });
});

describe('water capacity is structural (built, never consumed)', () => {
  it('yard baseline only at first; pond unlock is a big jump; features scale further', () => {
    const s = initialState(0);
    expect(waterCapacity(s)).toBe(W.YARD_BASELINE); // pond locked -> yard only
    s.zones.pond.unlocked = true;
    expect(waterCapacity(s)).toBe(W.YARD_BASELINE + W.POND_BASE);
    s.waterFeatures = 2;
    expect(waterCapacity(s)).toBe(W.YARD_BASELINE + W.POND_BASE + 2 * W.FEATURE_CAPACITY);
  });

  it('water features are gated behind the pond and hold once built', () => {
    const s = initialState(0);
    s.resources.eggs = 1e6;
    expect(canBuildWaterFeatures(s)).toBe(false);
    expect(buildWaterFeature(s).ok).toBe(false); // pond locked
    s.zones.pond.unlocked = true;
    expect(canBuildWaterFeatures(s)).toBe(true);
    expect(buildWaterFeature(s).ok).toBe(true);
    expect(s.waterFeatures).toBe(1);
    // Structural: nothing consumes it over time.
    s.ducks = ducks(3);
    run(s, 120);
    expect(s.waterFeatures).toBe(1);
  });
});

describe('the saturation curve', () => {
  it('hits its anchors: neutral at 1, atHalf at 0.5, atDouble at 2, flat beyond', () => {
    expect(waterCurve(1, 0.6, 1.4)).toBeCloseTo(1, 6);
    expect(waterCurve(0.5, 0.6, 1.4)).toBeCloseTo(0.6, 6);
    expect(waterCurve(2, 0.6, 1.4)).toBeCloseTo(1.4, 6);
    expect(waterCurve(5, 0.6, 1.4)).toBeCloseTo(1.4, 6); // saturates flat past 2
  });

  it('declines below 1 (scaled by shortfall) and rewards above 1 with diminishing returns', () => {
    // monotonic decline below 1
    expect(waterCurve(0.75, 0.6, 1.4)).toBeGreaterThan(waterCurve(0.5, 0.6, 1.4));
    expect(waterCurve(0.5, 0.6, 1.4)).toBeLessThan(1);
    // diminishing returns above 1: first half of the climb gives MORE than the second
    const at1_5 = waterCurve(1.5, 0.6, 1.4);
    expect(at1_5 - 1).toBeGreaterThan(1.4 - at1_5); // concave
  });

  it('access ratio = capacity / flock; infinite (neutral-safe) with no flock', () => {
    const s = initialState(0);
    expect(waterAccess(s)).toBe(Infinity);
    s.ducks = ducks(3); // cap 6 / 3 = 2.0
    expect(waterAccess(s)).toBeCloseTo(W.YARD_BASELINE / 3, 6);
  });
});

describe('water modifies condition + wound recovery — and nothing else', () => {
  it('a well-watered flock regenerates condition faster than a thirsty one', () => {
    const flush = setHens(stockAll(fullSetup()), 1); // cap 6 / 1 hen = 6 -> reward
    const thirsty = setHens(stockAll(fullSetup()), 30); // cap 6 / 30 -> deep decline
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
    // Hold the flock (heads/ration/stock) fixed and change ONLY water capacity.
    const dry = setHens(stockAll(fullSetup()), 4); // cap 6 / 4 = 1.5
    const wet = setHens(stockAll(fullSetup()), 4);
    wet.zones.pond.unlocked = true; // cap 30 / 4 = 7.5 — very different water, same flock
    run(dry, 60);
    run(wet, 60);
    expect(wet.nutrition!.requirement).toEqual(dry.nutrition!.requirement);
    for (const a of ['energy', 'protein', 'niacin', 'calcium'] as const) {
      expect(wet.nutrition!.satisfaction[a]).toBeCloseTo(dry.nutrition!.satisfaction[a], 5);
    }
  });
});

describe('NO new death path (4d locked constraint)', () => {
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
    s.ducks = ducks(40); // low water (cap 6 / 40)
    s.predatorsIntroduced = true;
    s.secureCoops = 10; // enough slots
    for (let i = 0; i < 5; i++) s.deterrents += 1;
    for (const d of s.ducks) d.secured = true;
    // Worst case: every roll lands, an hour online, bone-dry water.
    for (let t = 0; t < 3600; t++) runPredators(s, 1, { mode: 'online', rng: () => 0 });
    expect(s.ducks).toHaveLength(40); // secured => never targeted => no wounds => no losses
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

  it('a pre-4d save loads with yard baseline only, pond locked, no features', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { eggs: 100 },
      stations: [],
      rank: 20,
      ducks: [{ id: 'd0', genotype: ['Bl', 'bl'], vigor: 1, sex: 'hen', stage: 'adult', ageTicks: 0 }],
    });
    const s = deserialize(legacy, 0);
    expect(s.waterFeatures).toBe(0);
    expect(zoneUnlocked(s, 'pond')).toBe(false);
    expect(waterCapacity(s)).toBe(W.YARD_BASELINE);
  });

  it('water state round-trips through serialize', () => {
    const s = initialState(0);
    s.zones.pond.unlocked = true;
    s.waterFeatures = 3;
    const r = deserialize(serialize(s), 0);
    expect(r.waterFeatures).toBe(3);
    expect(zoneUnlocked(r, 'pond')).toBe(true);
    expect(waterCapacity(r)).toBe(W.YARD_BASELINE + W.POND_BASE + 3 * W.FEATURE_CAPACITY);
  });
});
