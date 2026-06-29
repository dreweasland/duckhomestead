import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import {
  initialState,
  zoneUnlocked,
  type Duck,
  type GameState,
  type Genotype,
  type Module,
} from '../src/game/state';
import {
  championGoal,
  meanVigor,
  sizeTarget,
  canPrestige,
  prestigeCurrency,
  prestigeReset,
  championSnapshot,
  boostCost,
  buyBoost,
  boostMult,
} from '../src/game/prestige';
import { deserialize } from '../src/game/save';
import { build, fullSetup, stockAll, setHens, run } from './helpers';

const NOW = 1_700_000_000_000;
const duck = (id: string, v: number, o: Partial<Duck> = {}): Duck => ({
  id,
  genotype: ['Bl', 'bl'] as Genotype,
  vigor: v,
  sex: 'hen',
  stage: 'adult',
  ageTicks: 5,
  ...o,
});

/** A deliberately messy, deep-into-the-game run — everything that could dangle. */
function messyRun(): GameState {
  const s = initialState(0);
  s.resources = { corn: 50, peas: 20, mealworms: 10, brewersYeast: 5, oysterShell: 5, forage: 3, pellets: 0, eggs: 9999 };
  s.rank = 22;
  s.xp = 137;
  s.autoHaulUnlocked = true;
  s.tendAllUnlocked = true;
  s.ration = { corn: 4, peas: 2, mealworms: 1, brewersYeast: 1, oysterShell: 1 };
  s.condition = 42;
  s.niacinShortfall = 12;
  s.doseCooldownRemaining = 8;
  s.stations = [
    { id: 's1', type: 'coop', zoneId: 'yard', x: 3, y: 3, level: 2, cycleProgress: 1, buffer: { eggs: 4 }, tendCooldownRemaining: 10, modules: [] },
    { id: 's2', type: 'plot', zoneId: 'backPasture', x: 0, y: 0, level: 1, cycleProgress: 0, buffer: {}, tendCooldownRemaining: 0, modules: [] },
  ];
  s.nextStationId = 9;
  const mod = (id: string, stat: Module['stat']): Module => ({ id, stat, rarity: 'epic', magnitude: 0.3 });
  s.inventory = [mod('m1', 'stationYield')];
  s.rack = [mod('m2', 'eggOutput'), mod('m3', 'stationSpeed')];
  s.dust = 44;
  s.nextModuleId = 12;
  s.ducks = [
    duck('d1', 1.6, { sex: 'drake' }),
    duck('d2', 1.4, { wounded: true, woundElapsed: 120 }),
    duck('d3', 1.2, { secured: true }),
    duck('d4', 0.9, { debuffed: true, stage: 'duckling' }),
  ];
  s.nextDuckId = 20;
  s.breedingPairs = [{ id: 'p1', drakeId: 'd1', henId: 'd2', clutchProgress: 30, incubating: [10, 20] }];
  s.nextPairId = 5;
  s.dexSeen = ['black', 'blue', 'splash'];
  s.zones = {
    yard: { unlocked: true },
    backPasture: { unlocked: true },
    pond: { unlocked: true },
  };
  // A messy water canvas (features + circulation + fouled freshness) must wipe.
  s.pond = {
    features: [{ x: 0, y: 0, type: 'deepZone' }],
    flow: [{ x: 1, y: 0, type: 'fountain' }],
    freshness: { '0,0': 0.5 },
  };
  s.predators = { owl: { timeToNextWindow: 50, windowRemaining: 12, windowElapsed: 3, attacksFired: 1 } };
  s.deterrents = 4;
  s.deterrentIntegrity = 0.55;
  s.secureCoops = 2;
  s.predatorsIntroduced = true;
  s.legacyTier = 2;
  s.legacyCurrency = 7;
  s.purchasedBoosts = { output: 3, eggValue: 1 };
  s.legacyHall = [
    { tier: 1, meanVigor: 1.5, bestVigor: 1.6, flockSize: 10, colors: ['blue'], timestamp: 1 },
    { tier: 2, meanVigor: 1.7, bestVigor: 1.8, flockSize: 14, colors: ['blue', 'black'], timestamp: 2 },
  ];
  return s;
}

describe('RESET VALIDITY (the highest-risk guarantee)', () => {
  it('prestigeReset == a fresh game except carried meta — zero dangling references', () => {
    const s = messyRun();
    const reset = prestigeReset(s, NOW);

    // The single strongest assertion: the reset deep-equals initialState() with
    // ONLY the four meta fields overridden. If any run field survived (a duck, a
    // pair, an unlocked zone, a non-default ration, a stray module/wound), this fails.
    const expected = initialState(NOW);
    expected.legacyTier = 3;
    expected.legacyCurrency = 7 + prestigeCurrency(s);
    expected.purchasedBoosts = { output: 3, eggValue: 1 };
    expected.legacyHall = [...s.legacyHall, championSnapshot(s, NOW)];
    expect(reset).toEqual(expected);
  });

  it('re-locks the zones and clears every run reference', () => {
    const reset = prestigeReset(messyRun(), NOW);
    expect(reset.ducks).toEqual([]);
    expect(reset.breedingPairs).toEqual([]); // no pair pointing at a wiped duck
    expect(reset.stations).toEqual([]);
    expect(reset.rack).toEqual([]); // no module on a removed station
    expect(reset.inventory).toEqual([]);
    expect(reset.deterrents).toBe(0);
    expect(reset.pond).toEqual({ features: [], flow: [], freshness: {} }); // water canvas wiped
    expect(reset.secureCoops).toBe(0);
    expect(reset.dust).toBe(0);
    expect(reset.rank).toBe(1);
    expect(reset.predatorsIntroduced).toBe(false);
    expect(reset.ration).toEqual(BALANCE.NUTRITION.DEFAULT_RATION);
    expect(zoneUnlocked(reset, 'yard')).toBe(true);
    expect(zoneUnlocked(reset, 'backPasture')).toBe(false);
    expect(zoneUnlocked(reset, 'pond')).toBe(false);
  });

  it('preserves + grows the meta, and raises the next size target', () => {
    const s = messyRun();
    const reset = prestigeReset(s, NOW);
    expect(reset.legacyTier).toBe(3);
    expect(reset.legacyCurrency).toBe(7 + prestigeCurrency(s));
    expect(reset.purchasedBoosts).toEqual({ output: 3, eggValue: 1 });
    expect(reset.legacyHall).toHaveLength(3);
    expect(reset.legacyHall[2].meanVigor).toBeCloseTo(meanVigor(s), 6);
    expect(sizeTarget(reset)).toBe(Math.round(sizeTarget(s) * BALANCE.PRESTIGE.SIZE_GROWTH));
  });
});

/** A flock that clears all three tier-0 champion requirements. */
function championRun(): GameState {
  const s = initialState(0);
  // 30 ducks, mean vigor 1.7 (> gate 1.5), all colours bred.
  s.ducks = Array.from({ length: 30 }, (_, i) => duck(`c${i}`, 1.7));
  s.dexSeen = ['black', 'blue', 'splash'];
  return s;
}

describe('champion goal: three concrete requirements', () => {
  it('reports each requirement’s progress + met state', () => {
    const s = initialState(0);
    s.ducks = [duck('a', 1.5), duck('b', 0.5)]; // mean 1.0
    s.dexSeen = ['blue']; // 1 of 3 colours
    const g = championGoal(s);
    expect(g.colors.bred).toBe(1);
    expect(g.colors.met).toBe(false);
    expect(g.vigor.value).toBeCloseTo(1.0, 6);
    expect(g.vigor.met).toBe(false); // 1.0 < gate 1.5
    expect(g.size.value).toBe(2);
    expect(g.size.met).toBe(false); // 2 < target 20
    expect(g.readiness).toBeLessThan(1);
  });

  it('CANNOT be brute-forced by flock size alone — vigor + colours still gate it', () => {
    const s = initialState(0);
    // A massive flock of mediocre, single-colour ducks: huge size, no mastery.
    s.ducks = Array.from({ length: 500 }, (_, i) => duck(`b${i}`, 1.0));
    s.dexSeen = ['blue'];
    expect(championGoal(s).size.met).toBe(true); // size is trivially cleared...
    expect(canPrestige(s)).toBe(false); // ...but vigor + colours block prestige
    expect(prestigeCurrency(s)).toBe(0);
  });

  it('unlocks once all three are met; gated otherwise', () => {
    expect(canPrestige(initialState(0))).toBe(false); // empty run
    const champ = championRun();
    const g = championGoal(champ);
    expect(g.colors.met && g.vigor.met && g.size.met).toBe(true);
    expect(canPrestige(champ)).toBe(true);
  });

  it('currency is ≥ the base grant and scales with flock-size overshoot', () => {
    const champ = championRun(); // 30 ducks vs target 20 → overshoot
    const Pp = BALANCE.PRESTIGE;
    const expected = Math.round(Pp.CURRENCY_AT_THRESHOLD * Math.pow(champ.ducks.length / sizeTarget(champ), Pp.CURRENCY_OVERSHOOT_EXP));
    expect(prestigeCurrency(champ)).toBe(expected);
    expect(prestigeCurrency(champ)).toBeGreaterThanOrEqual(Pp.CURRENCY_AT_THRESHOLD);
  });
});

describe('legacy boosts are stackable global scalars with escalating cost', () => {
  it('buyBoost spends currency, raises the level, and escalates the next cost', () => {
    const s = initialState(0);
    s.legacyCurrency = 100;
    const c0 = boostCost(s, 'output');
    expect(buyBoost(s, 'output')).toBe(1);
    expect(s.legacyCurrency).toBe(100 - c0);
    expect(boostCost(s, 'output')).toBeGreaterThan(c0);
    expect(boostMult(s, 'output')).toBeCloseTo(1 + BALANCE.PRESTIGE.BOOSTS.output.perLevel, 6);
  });

  it('rejects an unaffordable buy', () => {
    const s = initialState(0);
    s.legacyCurrency = 0;
    expect(buyBoost(s, 'eggValue')).toBeNull();
    expect(s.purchasedBoosts.eggValue ?? 0).toBe(0);
  });
});

describe('back-compat: legacy Hall entries migrate from the old `score` field', () => {
  it('an old hall entry (score, no meanVigor) loads with meanVigor defaulted', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { eggs: 1 },
      stations: [],
      legacyTier: 2,
      legacyHall: [{ tier: 1, score: 620, bestVigor: 1.7, flockSize: 30, colors: ['blue', 'black'], timestamp: 5 }],
    });
    const r = deserialize(legacy, 0);
    expect(r.legacyHall).toHaveLength(1);
    expect(r.legacyHall[0].meanVigor).toBe(0); // no live data to derive — defaults, doesn't crash
    expect(typeof r.legacyHall[0].meanVigor).toBe('number');
    expect(r.legacyHall[0].flockSize).toBe(30);
  });
});

describe('boosts feed the production math as global scalars (and nowhere else)', () => {
  it('an output boost raises raw production', () => {
    const plain = build({ plot: 1 });
    const boosted = build({ plot: 1 });
    boosted.purchasedBoosts = { output: 5 }; // +25%
    run(plain, 60, false);
    run(boosted, 60, false);
    expect(boosted.stations[0].buffer.corn ?? 0).toBeGreaterThan((plain.stations[0].buffer.corn ?? 0) * 1.2);
  });

  it('a speed boost cycles producers faster', () => {
    const plain = build({ plot: 1 });
    const boosted = build({ plot: 1 });
    boosted.purchasedBoosts = { stationSpeed: 5 };
    run(plain, 60, false);
    run(boosted, 60, false);
    expect(boosted.stations[0].buffer.corn ?? 0).toBeGreaterThan(plain.stations[0].buffer.corn ?? 0);
  });

  it('an eggValue boost scales eggs but never the nutrition axes', () => {
    const plain = setHens(stockAll(fullSetup()), 1);
    const boosted = setHens(stockAll(fullSetup()), 1);
    boosted.purchasedBoosts = { eggValue: 5 };
    plain.resources.eggs = 0;
    boosted.resources.eggs = 0;
    run(plain, 120);
    run(boosted, 120);
    expect(boosted.resources.eggs).toBeGreaterThan(plain.resources.eggs * 1.2);
    // the puzzle structure is untouched
    expect(boosted.nutrition!.requirement).toEqual(plain.nutrition!.requirement);
    for (const a of ['energy', 'protein', 'niacin', 'calcium'] as const) {
      expect(boosted.nutrition!.satisfaction[a]).toBeCloseTo(plain.nutrition!.satisfaction[a], 5);
    }
  });
});
