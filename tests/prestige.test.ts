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
  legacyScore,
  currentThreshold,
  canPrestige,
  prestigeCurrency,
  prestigeReset,
  championSnapshot,
  boostCost,
  buyBoost,
  boostMult,
} from '../src/game/prestige';
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
    yard: { unlocked: true, forageProgress: 0 },
    backPasture: { unlocked: true, forageProgress: 7 },
    pond: { unlocked: true, forageProgress: 0 },
  };
  s.predators = { owl: { timeToNextWindow: 50, windowRemaining: 12, windowElapsed: 3, attacksFired: 1 } };
  s.deterrents = 4;
  s.deterrentIntegrity = 0.55;
  s.secureCoops = 2;
  s.waterFeatures = 3;
  s.predatorsIntroduced = true;
  s.legacyTier = 2;
  s.legacyCurrency = 7;
  s.purchasedBoosts = { output: 3, eggValue: 1 };
  s.legacyHall = [
    { tier: 1, score: 520, bestVigor: 1.5, flockSize: 10, colors: ['blue'], timestamp: 1 },
    { tier: 2, score: 900, bestVigor: 1.7, flockSize: 14, colors: ['blue', 'black'], timestamp: 2 },
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
    expect(reset.waterFeatures).toBe(0);
    expect(reset.secureCoops).toBe(0);
    expect(reset.dust).toBe(0);
    expect(reset.rank).toBe(1);
    expect(reset.predatorsIntroduced).toBe(false);
    expect(reset.ration).toEqual(BALANCE.NUTRITION.DEFAULT_RATION);
    expect(zoneUnlocked(reset, 'yard')).toBe(true);
    expect(zoneUnlocked(reset, 'backPasture')).toBe(false);
    expect(zoneUnlocked(reset, 'pond')).toBe(false);
  });

  it('preserves + grows the meta, and raises the next threshold', () => {
    const s = messyRun();
    const reset = prestigeReset(s, NOW);
    expect(reset.legacyTier).toBe(3);
    expect(reset.legacyCurrency).toBe(7 + prestigeCurrency(s));
    expect(reset.purchasedBoosts).toEqual({ output: 3, eggValue: 1 });
    expect(reset.legacyHall).toHaveLength(3);
    expect(reset.legacyHall[2].score).toBe(Math.round(legacyScore(s)));
    expect(currentThreshold(reset)).toBeCloseTo(currentThreshold(s) * BALANCE.PRESTIGE.THRESHOLD_GROWTH, 6);
  });
});

/** A flock engineered to clear the tier-0 threshold (500). */
function championRun(): GameState {
  const s = initialState(0);
  s.ducks = Array.from({ length: 90 }, (_, i) => duck(`c${i}`, 1.5));
  s.dexSeen = ['black', 'blue', 'splash'];
  return s;
}

describe('Legacy Score + threshold + currency', () => {
  it('score aggregates vigor + dex completion + flock size', () => {
    const s = initialState(0);
    s.ducks = [duck('a', 1.5), duck('b', 0.5)];
    s.dexSeen = ['blue'];
    const W = BALANCE.PRESTIGE.SCORE_WEIGHTS;
    expect(legacyScore(s)).toBeCloseTo(W.vigor * 2.0 + W.dexCompletion * (1 / 3) + W.flockSize * 2, 6);
  });

  it('prestige is gated below the threshold, available at/above it', () => {
    expect(canPrestige(initialState(0))).toBe(false); // empty run, score 0
    expect(prestigeCurrency(initialState(0))).toBe(0);
    const champ = championRun();
    expect(legacyScore(champ)).toBeGreaterThanOrEqual(currentThreshold(champ));
    expect(canPrestige(champ)).toBe(true);
  });

  it('currency is ≥ the at-threshold grant and scales with overshoot', () => {
    const champ = championRun();
    const P = BALANCE.PRESTIGE;
    const expected = Math.round(P.CURRENCY_AT_THRESHOLD * Math.pow(legacyScore(champ) / currentThreshold(champ), P.CURRENCY_OVERSHOOT_EXP));
    expect(prestigeCurrency(champ)).toBe(expected);
    expect(prestigeCurrency(champ)).toBeGreaterThanOrEqual(P.CURRENCY_AT_THRESHOLD);
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
