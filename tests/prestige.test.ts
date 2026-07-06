import { describe, it, expect, vi, afterEach } from 'vitest';
import { runBreeding } from '../src/game/breeding';
import { BALANCE } from '../src/config/balance';
import {
  initialState,
  zoneUnlocked,
  type Duck,
  type Gene,
  type Genotype,
  type GameState,
  type Module,
} from '../src/game/state';
import {
  championGoal,
  meanQuality,
  rankRenownShards,
  sizeTarget,
  qualityGate,
  canPrestige,
  currencyAtSize,
  prestigeCurrency,
  prestigeReset,
  championSnapshot,
  targetForTier,
  boostCost,
  buyBoost,
  boostMult,
} from '../src/game/prestige';
import { tend } from '../src/game/actions';
import { deserialize, newGame } from '../src/game/save';
import { build, fullSetup, stockAll, setHens, run, FLAT_GENOME } from './helpers';

const NOW = 1_700_000_000_000;
/**
 * A test duck whose genome matches the default (all-Lay) Standard in `q`
 * of its 6 slots — so meanQuality of a flock of duck(_, q) is exactly q.
 */
const duck = (id: string, q: number, o: Partial<Duck> = {}): Duck => {
  const m = Math.max(0, Math.min(BALANCE.GENOME.SLOTS, Math.round(q)));
  const genome = Array.from({ length: BALANCE.GENOME.SLOTS }, (_, i): Gene => (i < m ? 'L' : 'D'));
  return {
    id,
    genotype: ['Bl', 'bl'] as Genotype,
    genome,
    genomeKnown: true,
    sex: 'hen',
    stage: 'adult',
    ageTicks: 5,
    ...o,
  };
};

/** A duck matching the GIVEN target in its first `q` slots ('D' elsewhere — no
 *  rotation target contains a Dud, so unmatched slots never match by accident). */
const duckFor = (id: string, target: Gene[], q: number, o: Partial<Duck> = {}): Duck => {
  const m = Math.max(0, Math.min(BALANCE.GENOME.SLOTS, Math.round(q)));
  const genome = Array.from({ length: BALANCE.GENOME.SLOTS }, (_, i): Gene => (i < m ? target[i] : 'D'));
  return { ...duck(id, 0, o), genome };
};

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
    duck('d1', 5, { sex: 'drake' }),
    duck('d2', 4, { wounded: true, woundElapsed: 120 }),
    duck('d3', 3, { secured: true }),
    duck('d4', 1, { debuffed: true, stage: 'duckling' }),
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
    { tier: 1, meanQuality: 4.5, bestQuality: 5, flockSize: 10, colors: ['blue'], timestamp: 1 },
    { tier: 2, meanQuality: 4.8, bestQuality: 6, flockSize: 14, colors: ['blue', 'black'], timestamp: 2 },
  ];
  return s;
}

describe('RESET VALIDITY (the highest-risk guarantee)', () => {
  it('prestigeReset == a fresh NEW GAME except carried meta — zero dangling references', () => {
    const s = messyRun();
    const reset = prestigeReset(s, NOW);

    // The single strongest assertion: the reset deep-equals newGame() — the
    // REAL fresh-game state, starter engine + seeded flock included, so run 2+
    // never starts poorer than run 1 — with ONLY the meta fields (+ the new
    // tier's tracking target) overridden. If any run field survived (a duck, a
    // pair, an unlocked zone, a non-default ration, a stray module/wound),
    // this fails. Seed genomes are random rolls, so compare them by shape.
    const expected = newGame(NOW);
    expected.legacyTier = 3;
    expected.legacyCurrency = 7 + prestigeCurrency(s);
    expected.purchasedBoosts = { output: 3, eggValue: 1 };
    expected.legacyHall = [...s.legacyHall, championSnapshot(s, NOW)];
    expected.genomeTarget = targetForTier(3); // tracking starts on the new tier's puzzle
    expected.pondTerrainTier = 3; // Phase 5 juice: the new tier's pond terrain also takes effect now
    const scrubGenomes = (st: GameState) => ({
      ...st,
      ducks: st.ducks.map((d) => ({ ...d, genome: d.genome.length })),
    });
    expect(scrubGenomes(reset)).toEqual(scrubGenomes(expected));
  });

  it('re-locks the zones and clears every run reference (fresh starter engine + seed flock)', () => {
    const reset = prestigeReset(messyRun(), NOW);
    // The fresh game's floor, not the wiped run's flock: the seeded starters.
    const seedCount = BALANCE.BREEDING.SEED_DRAKES + BALANCE.BREEDING.SEED_HENS;
    expect(reset.ducks).toHaveLength(seedCount);
    expect(reset.ducks.every((d) => !d.wounded && !d.secured && d.site !== 'winter')).toBe(true);
    expect(reset.breedingPairs).toEqual([]); // no pair pointing at a wiped duck
    expect(reset.stations.map((st) => st.type).sort()).toEqual(['coop', 'mill', 'plot']); // the free starter engine
    expect(reset.resources.eggs).toBe(BALANCE.STARTING_EGGS); // stipend intact — starters are free
    expect(reset.rack).toEqual([]); // no module on a removed station
    expect(reset.inventory).toEqual([]);
    expect(reset.deterrents).toBe(0);
    expect(reset.pond).toEqual({ features: [], flow: [], freshness: {} }); // water canvas wiped
    expect(reset.secureCoops).toBe(0);
    expect(reset.dust).toBe(0);
    expect(reset.rank).toBe(1);
    expect(reset.geneReader).toBe(false); // a fresh run must re-build the reader
    expect(reset.genomeTarget).toEqual(targetForTier(3)); // tracking = the new tier's gate target
    expect(reset.predatorsIntroduced).toBe(false);
    expect(reset.ration).toEqual({ corn: 0, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0, sunflowerSeeds: 0, fodderSprouts: 0 });
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
    expect(reset.legacyHall[2].meanQuality).toBeCloseTo(meanQuality(s), 6);
    // The next tier's target is strictly larger (rounding makes the exact value
    // the formula at the new tier, not a re-round of the old one).
    expect(sizeTarget(reset)).toBeGreaterThan(sizeTarget(s));
    expect(sizeTarget(reset)).toBe(
      Math.round(BALANCE.PRESTIGE.SIZE_BASE * BALANCE.PRESTIGE.SIZE_GROWTH ** reset.legacyTier),
    );
  });
});

/** A flock that clears all three tier-0 champion requirements. */
function championRun(): GameState {
  const s = initialState(0);
  // 120 ducks (> tier-0 target 100), mean quality 5 (> tier-0 gate 4.5), all colours.
  s.ducks = Array.from({ length: 120 }, (_, i) => duck(`c${i}`, 5));
  s.dexSeen = ['black', 'blue', 'splash'];
  return s;
}

describe('champion goal: three concrete requirements', () => {
  it('reports each requirement’s progress + met state', () => {
    const s = initialState(0);
    s.ducks = [duck('a', 5), duck('b', 1)]; // mean quality 3
    s.dexSeen = ['blue']; // 1 of 3 colours
    const g = championGoal(s);
    expect(g.colors.bred).toBe(1);
    expect(g.colors.met).toBe(false);
    expect(g.quality.value).toBeCloseTo(3, 6);
    expect(g.quality.met).toBe(false); // 3 < gate 4.5
    expect(g.size.value).toBe(2);
    expect(g.size.met).toBe(false); // 2 < target 100
    expect(g.readiness).toBeLessThan(1);
  });

  it('CANNOT be brute-forced by flock size alone — quality + colours still gate it', () => {
    const s = initialState(0);
    // A massive flock of mediocre, single-colour ducks: huge size, no mastery.
    s.ducks = Array.from({ length: 500 }, (_, i) => duck(`b${i}`, 1));
    s.dexSeen = ['blue'];
    expect(championGoal(s).size.met).toBe(true); // size is trivially cleared...
    expect(canPrestige(s)).toBe(false); // ...but quality + colours block prestige
    expect(prestigeCurrency(s)).toBe(0);
  });

  it('unlocks once all three are met; gated otherwise', () => {
    expect(canPrestige(initialState(0))).toBe(false); // empty run
    const champ = championRun();
    const g = championGoal(champ);
    expect(g.colors.met && g.quality.met && g.size.met).toBe(true);
    expect(canPrestige(champ)).toBe(true);
  });

  it('currency is ≥ the base grant and scales with BOTH size and quality overshoot', () => {
    const champ = championRun(); // 120 ducks vs target 100, quality 5 vs gate 4.5
    const Pp = BALANCE.PRESTIGE;
    const expected = Math.round(
      Pp.CURRENCY_AT_THRESHOLD *
        Math.pow(champ.ducks.length / sizeTarget(champ), Pp.CURRENCY_OVERSHOOT_EXP) *
        Math.pow(meanQuality(champ) / qualityGate(champ), Pp.CURRENCY_QUALITY_EXP),
    );
    expect(prestigeCurrency(champ)).toBe(expected);
    expect(prestigeCurrency(champ)).toBeGreaterThanOrEqual(Pp.CURRENCY_AT_THRESHOLD);
  });

  it('a higher-quality flock out-earns a merely-bigger one (quality now pays)', () => {
    const lo = championRun(); // quality 5
    const hi = championRun();
    hi.ducks = hi.ducks.map((d) => ({ ...d, genome: ['L', 'L', 'L', 'L', 'L', 'L'] as Gene[] })); // quality 6
    expect(prestigeCurrency(hi)).toBeGreaterThan(prestigeCurrency(lo));
  });

  it('the quality gate rises each tier, capped below the perfect genome', () => {
    const Pp = BALANCE.PRESTIGE;
    const t0 = { ...initialState(0), legacyTier: 0 };
    const t1 = { ...initialState(0), legacyTier: 1 };
    expect(qualityGate(t1)).toBeGreaterThan(qualityGate(t0));
    expect(championGoal(t1).quality.gate).toBe(qualityGate(t1)); // the goal reads the tiered gate
    const tHigh = { ...initialState(0), legacyTier: 99 };
    expect(qualityGate(tHigh)).toBe(Pp.QUALITY_GATE_MAX); // capped, always reachable
    expect(qualityGate(tHigh)).toBeLessThan(BALANCE.GENOME.SLOTS);
  });

  it('a flock that clears tier 0 can FAIL the higher tier-1 quality gate', () => {
    // mean quality 4.55 AGAINST EACH TIER'S OWN TARGET: clears tier-0's gate 4.5,
    // but not tier-1's 4.6 — the bar itself rises even at equal mastery.
    const mk = (tier: number) => {
      const s = { ...initialState(0), legacyTier: tier };
      // 110 ducks at quality 5 + 90 at quality 4 → mean 4.55 (built vs the tier's target).
      s.ducks = Array.from({ length: 200 }, (_, i) => duckFor(`v${i}`, targetForTier(tier), i < 110 ? 5 : 4));
      s.dexSeen = ['black', 'blue', 'splash'];
      return s;
    };
    expect(championGoal(mk(0)).quality.met).toBe(true);
    expect(championGoal(mk(1)).quality.met).toBe(false);
  });
});

describe('Phase 6a: the gate target is tier-authoritative and ROTATES', () => {
  it('targetForTier cycles through TARGETS_BY_TIER (and tier 0 matches the old default)', () => {
    const targets = BALANCE.PRESTIGE.TARGETS_BY_TIER;
    expect(targetForTier(0)).toEqual([...BALANCE.GENOME.DEFAULT_TARGET]);
    for (let t = 0; t < targets.length; t++) expect(targetForTier(t)).toEqual([...targets[t]]);
    expect(targetForTier(targets.length)).toEqual(targetForTier(0)); // cycles
    expect(targetForTier(targets.length + 2)).toEqual(targetForTier(2));
  });

  it('every rotation target is a valid Dud-free profile (always breedable-toward)', () => {
    for (const t of BALANCE.PRESTIGE.TARGETS_BY_TIER) {
      expect(t).toHaveLength(BALANCE.GENOME.SLOTS);
      for (const g of t) expect(['L', 'V', 'H']).toContain(g);
    }
  });

  it('the gate IGNORES the player-set tracking target (the self-set-gate exploit is closed)', () => {
    const champ = championRun();
    const before = meanQuality(champ);
    expect(championGoal(champ).quality.met).toBe(true);
    // Point the tracking target at the flock's exact profile — the old exploit.
    champ.genomeTarget = ['L', 'L', 'L', 'L', 'L', 'D'] as Gene[];
    expect(meanQuality(champ)).toBe(before);
    expect(prestigeCurrency(champ)).toBe(currencyAtSize(champ, champ.ducks.length));
    // And pointing it somewhere absurd doesn't break readiness either.
    champ.genomeTarget = ['D', 'D', 'D', 'D', 'D', 'D'] as Gene[];
    expect(canPrestige(champ)).toBe(true);
  });

  it('quality is judged per-tier: a lay flock aces T0 (all-L) but flunks T2 (all-H)', () => {
    const mk = (tier: number) => {
      const s = { ...initialState(0), legacyTier: tier };
      s.ducks = Array.from({ length: 10 }, (_, i) => duck(`q${i}`, 6)); // all-L truebreds
      return s;
    };
    expect(meanQuality(mk(0))).toBe(BALANCE.GENOME.SLOTS); // perfect vs LLLLLL
    expect(meanQuality(mk(2))).toBe(0); // worthless vs HHHHHH — a NEW puzzle
  });

  it('the threshold grant rises with tier at the SAME relative mastery', () => {
    const mk = (tier: number) => {
      const s = { ...initialState(0), legacyTier: tier };
      // Exactly at the size target, perfect quality vs the tier's own target.
      s.ducks = Array.from({ length: sizeTarget(s) }, (_, i) =>
        duckFor(`g${i}`, targetForTier(tier), BALANCE.GENOME.SLOTS),
      );
      s.dexSeen = ['black', 'blue', 'splash'];
      return s;
    };
    const g0 = prestigeCurrency(mk(0));
    const g1 = prestigeCurrency(mk(1));
    expect(g0).toBeGreaterThanOrEqual(BALANCE.PRESTIGE.CURRENCY_AT_THRESHOLD);
    expect(g1).toBeGreaterThan(g0); // deeper legacies bank more — boost costs keep escalating
  });
});

describe('Phase 6a: the truebred DING judges the TIER target, not tracking', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a hatch matching the tier target DINGs even when tracking points elsewhere', () => {
    // rng 0.4: never mutates (0.4 > MUTATION_CHANCE) and every contested L-vs-D
    // slot resolves to L (0.4·(3+1) < 3 picks the L parent; ≥ 1 rejects the D one),
    // so complementary LDLDLD × DLDLDL half-clones deterministically ASSEMBLE an
    // all-L truebred — neither parent is one, so the first-clone DING must fire.
    vi.spyOn(Math, 'random').mockReturnValue(0.4);
    const s = build({ coop: 1 });
    const half = (id: string, sex: 'drake' | 'hen', evenSlots: boolean): Duck => ({
      id,
      genotype: ['Bl', 'bl'] as Genotype,
      genome: Array.from({ length: 6 }, (_, i): Gene => (i % 2 === (evenSlots ? 0 : 1) ? 'L' : 'D')),
      genomeKnown: true,
      sex,
      stage: 'adult',
      ageTicks: 0,
    });
    s.ducks = [half('dr', 'drake', true), half('he', 'hen', false)];
    s.breedingPairs = [{ id: 'p1', drakeId: 'dr', henId: 'he', clutchProgress: 0, incubating: [] }];
    s.genomeTarget = ['H', 'H', 'H', 'H', 'H', 'H'] as Gene[]; // tracking points elsewhere
    runBreeding(s, BALANCE.BREEDING.CLUTCH_INTERVAL_S + BALANCE.BREEDING.INCUBATE_S + 1);
    expect(s.ducks.length).toBeGreaterThan(2); // something hatched
    expect(s.pendingTruebred ?? 0).toBeGreaterThan(0); // tier-0 target (all-L) → DING
  });
});

describe('Phase 6a: the push-vs-reset currency curve', () => {
  it('overshoot is SUPERLINEAR in size — pushing past the gate out-earns resetting', () => {
    const champ = championRun();
    const target = sizeTarget(champ);
    const atGate = currencyAtSize(champ, target);
    const atDouble = currencyAtSize(champ, target * 2);
    // Superlinear: doubling the flock more than doubles the grant (2^EXP, EXP > 1).
    expect(BALANCE.PRESTIGE.CURRENCY_OVERSHOOT_EXP).toBeGreaterThan(1);
    expect(atDouble / atGate).toBeCloseTo(Math.pow(2, BALANCE.PRESTIGE.CURRENCY_OVERSHOOT_EXP), 1);
    expect(atDouble).toBeGreaterThan(atGate * 2);
  });

  it('prestigeCurrency IS currencyAtSize at the live flock size (the projection never lies)', () => {
    const champ = championRun();
    expect(prestigeCurrency(champ)).toBe(currencyAtSize(champ, champ.ducks.length));
  });

  it('the projection is 0 until the champion goal is met (no phantom payouts)', () => {
    const s = initialState(0);
    s.ducks = [duck('a', 6)];
    expect(currencyAtSize(s, 500)).toBe(0);
  });
});

describe('Phase 6a: Renown scales active-action XP (the re-run rank clock)', () => {
  it('a tend grants TEND_XP × the renown multiplier', () => {
    const plain = build({ plot: 1 });
    const boosted = build({ plot: 1 });
    boosted.purchasedBoosts = { renown: 5 }; // +50%
    plain.stations[0].tendCooldownRemaining = 0; // fresh builds start on cooldown
    boosted.stations[0].tendCooldownRemaining = 0;
    const rp = tend(plain, plain.stations[0].id);
    const rb = tend(boosted, boosted.stations[0].id);
    if (!rp.ok || !rb.ok) throw new Error('tend failed');
    expect(rp.value.xp.xpGained).toBe(BALANCE.TEND_XP);
    expect(rb.value.xp.xpGained).toBe(Math.round(BALANCE.TEND_XP * 1.5));
  });
});

describe('Phase 6a: Husbandry scales the breeding clocks (never the puzzle)', () => {
  /** A stocked full setup with one adult pairable flock + one duckling. */
  const withDuckling = (): GameState => {
    const s = setHens(stockAll(fullSetup()), 1);
    s.ducks.push({
      id: 'dk1',
      genotype: ['Bl', 'bl'],
      genome: [...FLAT_GENOME],
      genomeKnown: true,
      sex: 'hen',
      stage: 'duckling',
      ageTicks: 0,
    });
    return s;
  };

  it('ducklings mature proportionally faster under a husbandry boost', () => {
    const plain = withDuckling();
    const boosted = withDuckling();
    boosted.purchasedBoosts = { husbandry: 5 }; // +50%
    run(plain, 60);
    run(boosted, 60);
    const age = (s: GameState) => s.ducks.find((d) => d.id === 'dk1')!.ageTicks;
    expect(age(plain)).toBeGreaterThan(0);
    expect(age(boosted) / age(plain)).toBeCloseTo(1.5, 1);
  });

  it('pairs accrue clutch progress proportionally faster — and the RATION SIDE is untouched', () => {
    const mk = (): GameState => {
      const s = stockAll(fullSetup());
      s.ducks = [
        { id: 'dr', genotype: ['Bl', 'bl'], genome: [...FLAT_GENOME], genomeKnown: true, sex: 'drake', stage: 'adult', ageTicks: 0 },
        { id: 'he', genotype: ['Bl', 'bl'], genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 },
      ];
      s.breedingPairs = [{ id: 'p1', drakeId: 'dr', henId: 'he', clutchProgress: 0, incubating: [] }];
      return s;
    };
    const plain = mk();
    const boosted = mk();
    boosted.purchasedBoosts = { husbandry: 5 };
    run(plain, 60);
    run(boosted, 60);
    expect(boosted.breedingPairs[0].clutchProgress / plain.breedingPairs[0].clutchProgress).toBeCloseTo(1.5, 1);
    // Guardrail: husbandry never touches the duckling/drake REQUIREMENT profiles.
    expect(BALANCE.BREEDING.DUCKLING_REQUIREMENT).toEqual({ energy: 1, protein: 3, niacin: 2, calcium: 0 });
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

describe('back-compat: legacy Hall entries migrate from older fields', () => {
  it('an old hall entry (vigor/score era, no meanQuality) loads with meanQuality defaulted', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { eggs: 1 },
      stations: [],
      legacyTier: 2,
      legacyHall: [{ tier: 1, meanVigor: 1.7, bestVigor: 1.8, flockSize: 30, colors: ['blue', 'black'], timestamp: 5 }],
    });
    const r = deserialize(legacy, 0);
    expect(r.legacyHall).toHaveLength(1);
    expect(r.legacyHall[0].meanQuality).toBe(0); // no genome data to derive — defaults, doesn't crash
    expect(typeof r.legacyHall[0].meanQuality).toBe('number');
    expect(r.legacyHall[0].flockSize).toBe(30);
  });

  it('a pre-6a save (no renown/husbandry keys) loads with the new boosts at level 0', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { eggs: 1 },
      stations: [],
      purchasedBoosts: { output: 2 },
    });
    const r = deserialize(legacy, 0);
    expect(boostMult(r, 'renown')).toBe(1);
    expect(boostMult(r, 'husbandry')).toBe(1);
    expect(boostMult(r, 'output')).toBeCloseTo(1 + 2 * BALANCE.PRESTIGE.BOOSTS.output.perLevel, 6);
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

it('RANK OVERSHOOT PAYS: ranks above the floor add flat shards to the payout', () => {
  const P2 = BALANCE.PRESTIGE;
  expect(rankRenownShards({ rank: P2.RENOWN_RANK_FLOOR } as GameState)).toBe(0);
  expect(rankRenownShards({ rank: P2.RENOWN_RANK_FLOOR + 8 } as GameState)).toBe(8 * P2.SHARDS_PER_RANK_ABOVE);
});
