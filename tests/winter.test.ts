import { describe, it, expect } from 'vitest';
import { BALANCE, EXCLUSIVE_STATIONS, ZONE_DEFS } from '../src/config/balance';
import {
  assignToWinter,
  placeStation,
  recallFromWinter,
  removeStation,
  unlockZone,
  upgradeStation,
} from '../src/game/actions';
import { hardinessMult, layMult } from '../src/game/genetics';
import { prestigeReset } from '../src/game/prestige';
import { deserialize, serialize } from '../src/game/save';
import { tick } from '../src/game/tick';
import { flockRequirement } from '../src/game/water';
import {
  flockRatio,
  initialState,
  winterCapacity,
  winterHens,
  zoneUnlocked,
  type Duck,
  type GameState,
  type Genome,
} from '../src/game/state';
import { build, FLAT_GENOME, fullSetup, genome, run, setHens, stockAll } from './helpers';

const W = BALANCE.WINTER;

/** A state with Winterstead unlocked (bypassing the gates — they're tested separately). */
function withWinter(s: GameState = build({})): GameState {
  s.zones.winterstead = { unlocked: true };
  s.resources.eggs = 1_000_000;
  return s;
}

describe('Winterstead — the triple-gated unlock (Phase 6d Step 1)', () => {
  it('is gated on legacy tier FIRST, then rank, then eggs', () => {
    const s = initialState(0);
    s.resources.eggs = W.UNLOCK.eggCost + 1;
    s.rank = W.UNLOCK.rankRequired;

    s.legacyTier = W.UNLOCK.minLegacyTier - 1;
    const tierFail = unlockZone(s, 'winterstead');
    expect(tierFail.ok).toBe(false);
    if (!tierFail.ok) expect(tierFail.reason).toContain('Legacy Tier');

    s.legacyTier = W.UNLOCK.minLegacyTier;
    s.rank = W.UNLOCK.rankRequired - 1;
    const rankFail = unlockZone(s, 'winterstead');
    expect(rankFail.ok).toBe(false);
    if (!rankFail.ok) expect(rankFail.reason).toContain('Rank');

    s.rank = W.UNLOCK.rankRequired;
    s.resources.eggs = W.UNLOCK.eggCost - 1;
    expect(unlockZone(s, 'winterstead').ok).toBe(false);

    s.resources.eggs = W.UNLOCK.eggCost;
    expect(unlockZone(s, 'winterstead').ok).toBe(true);
    expect(zoneUnlocked(s, 'winterstead')).toBe(true);
    expect(s.resources.eggs).toBe(0); // the sink sank
  });

  it('prestige re-locks Winterstead like every zone', () => {
    const s = withWinter();
    s.dexSeen = ['black', 'blue', 'splash'];
    const reset = prestigeReset(s, 0);
    expect(zoneUnlocked(reset, 'winterstead')).toBe(false);
  });
});

describe('zone-station compatibility (both directions)', () => {
  it('winter stations are zone-exclusive: the yard rejects them', () => {
    const s = withWinter();
    const r = placeStation(s, 'seedStore', 0, 0, 'yard');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Winterstead');
  });

  it('Winterstead rejects yard stations', () => {
    const s = withWinter();
    expect(placeStation(s, 'plot', 0, 0, 'winterstead').ok).toBe(false);
    expect(placeStation(s, 'coop', 1, 0, 'winterstead').ok).toBe(false);
  });

  it('Winterstead accepts exactly its allowed set', () => {
    const s = withWinter();
    const allowed = ZONE_DEFS.find((z) => z.id === 'winterstead')!.allowedStations!;
    allowed.forEach((t, i) => {
      expect(placeStation(s, t, i, 0, 'winterstead').ok).toBe(true);
    });
  });

  it('EXCLUSIVE_STATIONS derives from ZONE_DEFS (not hand-kept)', () => {
    for (const t of ['seedStore', 'fodderRack', 'winterCoop', 'heater', 'heatedWaterer'] as const) {
      expect(EXCLUSIVE_STATIONS.has(t)).toBe(true);
    }
    expect(EXCLUSIVE_STATIONS.has('plot')).toBe(false);
  });
});

describe('winter producers + infrastructure safety', () => {
  it('seed store + fodder rack produce the winter lines into SHARED storage', () => {
    const s = withWinter();
    placeStation(s, 'seedStore', 0, 0, 'winterstead');
    placeStation(s, 'fodderRack', 1, 0, 'winterstead');
    run(s, 30); // auto-haul on
    expect(s.resources.sunflowerSeeds).toBeGreaterThan(0);
    expect(s.resources.fodderSprouts).toBeGreaterThan(0);
  });

  it('zero-cycle infrastructure (heater/waterer) never cycles, never hangs the loop', () => {
    const s = withWinter();
    placeStation(s, 'heater', 0, 0, 'winterstead');
    placeStation(s, 'heatedWaterer', 1, 0, 'winterstead');
    run(s, 10);
    for (const st of s.stations.filter((x) => x.zoneId === 'winterstead')) {
      expect(Object.keys(st.buffer)).toHaveLength(0);
    }
  });

  it('a winter coop lays NOTHING via the generic producer path (the winter pool owns lay)', () => {
    const s = withWinter();
    placeStation(s, 'winterCoop', 0, 0, 'winterstead');
    const eggs0 = s.resources.eggs;
    run(s, 60);
    expect(s.resources.eggs).toBe(eggs0);
  });

  it('infrastructure does not upgrade; winter producers upgrade on the capped curve', () => {
    const s = withWinter();
    placeStation(s, 'winterCoop', 0, 0, 'winterstead');
    placeStation(s, 'seedStore', 1, 0, 'winterstead');
    const coop = s.stations.find((x) => x.type === 'winterCoop')!;
    const store = s.stations.find((x) => x.type === 'seedStore')!;
    expect(upgradeStation(s, coop.id).ok).toBe(false);
    expect(upgradeStation(s, store.id).ok).toBe(true);
    expect(store.level).toBe(2);
  });
});

// ── Step 2: assignment + the winter pool + premium lay ───────────────
const duck = (id: string, g: Genome = FLAT_GENOME, o: Partial<Duck> = {}): Duck => ({
  id,
  genotype: ['Bl', 'bl'],
  genome: [...g],
  genomeKnown: true,
  sex: 'hen',
  stage: 'adult',
  ageTicks: 0,
  ...o,
});

/** A stocked site: full home setup + N winter coops + the winter default ration. */
function winterSite(nCoops = 2): GameState {
  const s = withWinter(stockAll(fullSetup()));
  for (let i = 0; i < nCoops; i++) placeStation(s, 'winterCoop', i, 0, 'winterstead');
  s.winterRation = { ...BALANCE.WINTER.DEFAULT_RATION };
  s.ration = { ...BALANCE.NUTRITION.DEFAULT_RATION };
  return s;
}

describe('assignment: adults-only, hens-only, capacity-gated, always recallable', () => {
  it('enforces the assignment rules', () => {
    const s = winterSite(1); // capacity 4
    s.ducks = [
      duck('hen1'),
      duck('drake1', FLAT_GENOME, { sex: 'drake' }),
      duck('kid1', FLAT_GENOME, { stage: 'duckling' }),
      duck('hurt1', FLAT_GENOME, { wounded: true }),
      duck('paired1'),
      duck('hen2'),
      duck('hen3'),
      duck('hen4'),
      duck('hen5'),
    ];
    s.breedingPairs = [{ id: 'p1', drakeId: 'drake1', henId: 'paired1', clutchProgress: 0, incubating: [] }];
    expect(assignToWinter(s, 'drake1').ok).toBe(false);
    expect(assignToWinter(s, 'kid1').ok).toBe(false);
    expect(assignToWinter(s, 'hurt1').ok).toBe(false);
    expect(assignToWinter(s, 'paired1').ok).toBe(false);
    for (const id of ['hen1', 'hen2', 'hen3', 'hen4']) expect(assignToWinter(s, id).ok).toBe(true);
    expect(assignToWinter(s, 'hen5').ok).toBe(false); // capacity 4 — full
    expect(winterHens(s)).toHaveLength(4);
    expect(recallFromWinter(s, 'hen1').ok).toBe(true);
    expect(assignToWinter(s, 'hen5').ok).toBe(true); // freed slot
  });

  it('is gated on the zone being unlocked', () => {
    const s = stockAll(fullSetup());
    s.ducks = [duck('h1')];
    expect(assignToWinter(s, 'h1').ok).toBe(false);
  });

  it('demolishing a winter coop auto-recalls the stranded excess (never a loss)', () => {
    const s = winterSite(2); // capacity 8
    s.ducks = Array.from({ length: 8 }, (_, i) => duck(`h${i}`));
    for (const d of s.ducks) expect(assignToWinter(s, d.id).ok).toBe(true);
    const coop = s.stations.find((x) => x.type === 'winterCoop')!;
    removeStation(s, coop.id);
    expect(winterCapacity(s)).toBe(4);
    expect(winterHens(s)).toHaveLength(4); // 4 walked home
    expect(s.ducks).toHaveLength(8); // nobody died — cold never kills
  });
});

describe('pool exclusivity (the correctness heart): one duck, exactly one pool', () => {
  it('an assigned hen leaves the HOME feed/lay pools and joins the WINTER ones', () => {
    const s = winterSite(1);
    s.ducks = [duck('h1'), duck('h2'), duck('h3')];
    assignToWinter(s, 'h3');
    run(s, 30);
    const N = BALANCE.NUTRITION;
    const W = BALANCE.WINTER;
    const cycle = BALANCE.COOP.cycleSeconds;
    // Home requirement scales off the 2 hens AT HOME; winter off the 1 assigned.
    expect(s.nutrition!.requirement.energy).toBeCloseTo((N.REQUIREMENT.energy * 2) / cycle, 6);
    expect(s.winter!.henCount).toBe(1);
    expect(s.winter!.requirement.energy).toBeCloseTo((W.REQUIREMENT.energy * 1) / cycle, 6);
  });

  it('she lays in the winter pool ONLY (home egg rate drops when she leaves)', () => {
    const allHome = winterSite(1);
    allHome.ducks = [duck('a1'), duck('a2'), duck('a3')];
    const oneWinter = winterSite(1);
    oneWinter.ducks = [duck('b1'), duck('b2'), duck('b3')];
    assignToWinter(oneWinter, 'b3');
    run(allHome, 60);
    run(oneWinter, 60);
    expect(oneWinter.nutrition!.eggRate).toBeLessThan(allHome.nutrition!.eggRate);
    expect(oneWinter.winter!.eggRate).toBeGreaterThan(0);
    expect(allHome.winter).toBeUndefined(); // no assigned flock ⇒ no winter pool
  });

  it('she is ELSEWHERE for every home system: water demand + flock ratio', () => {
    const s = winterSite(1);
    s.ducks = [duck('h1'), duck('h2')];
    const before = flockRequirement(s);
    const hensBefore = flockRatio(s).hens;
    assignToWinter(s, 'h1');
    expect(flockRequirement(s)).toBeLessThan(before);
    expect(flockRatio(s).hens).toBe(hensBefore - 1);
  });
});

describe('winter eats LAST under scarcity (the ★ locked order)', () => {
  it('a shared shortage starves the winter pool before the home layers', () => {
    const s = winterSite(1);
    // Corn-only diets on both pools, no producers running fast enough for both.
    s.stations = s.stations.filter((x) => x.type !== 'plot'); // trickle only from stock
    s.ducks = [duck('h1'), duck('h2'), duck('w1')];
    assignToWinter(s, 'w1');
    for (const k of ['corn', 'peas', 'mealworms', 'brewersYeast', 'oysterShell', 'sunflowerSeeds', 'fodderSprouts'] as const)
      s.resources[k] = 0;
    s.resources.corn = 30; // a small shared pot, drained over the run
    s.ration = { ...s.ration, corn: 2.5 };
    s.winterRation = { corn: 5, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0, sunflowerSeeds: 0, fodderSprouts: 0 };
    run(s, 90);
    // Home drew from the shared pot FIRST each tick; winter got the leftovers.
    expect(s.nutrition!.satisfaction.energy).toBeGreaterThan(s.winter!.satisfaction.energy);
  });
});

describe('hardiness pays at Winterstead — and only there (the 6d thesis)', () => {
  it('hardinessMult counts literal H genes (P never counts toward stats)', () => {
    expect(hardinessMult(genome('HHHDDD'))).toBeCloseTo(1 + 3 * BALANCE.WINTER.HARDINESS_PER_H, 6);
    expect(hardinessMult(genome('LLLLLL'))).toBe(1);
    expect(hardinessMult(genome('PPPPPP'))).toBe(1);
  });

  it('LLLHHH out-earns the all-L god clone AT WINTERSTEAD…', () => {
    const mk = (g: Genome) => {
      const s = winterSite(1);
      s.ducks = [duck('w', g)];
      assignToWinter(s, 'w');
      run(s, 120);
      return s.winter!.eggRate;
    };
    expect(mk(genome('LLLHHH'))).toBeGreaterThan(mk(genome('LLLLLL')));
  });

  it('…and under-earns it AT HOME (best duck is contextual, economically)', () => {
    const mk = (g: Genome) => {
      const s = setHens(stockAll(fullSetup()), 1, g);
      run(s, 120);
      return s.nutrition!.eggRate;
    };
    expect(mk(genome('LLLHHH'))).toBeLessThan(mk(genome('LLLLLL')));
  });

  it('winter lay carries the premium and lands in the SHARED egg pool', () => {
    const s = winterSite(1);
    s.ducks = [duck('w', genome('LLLHHH'))];
    assignToWinter(s, 'w');
    const eggsBefore = s.resources.eggs; // placement costs already paid
    run(s, 120); // EMA warm-up + steady lay
    const W = BALANCE.WINTER;
    const expected =
      layMult(genome('LLLHHH')) *
      hardinessMult(genome('LLLHHH')) *
      (BALANCE.COOP.eggPerCycle / BALANCE.COOP.cycleSeconds) *
      s.winter!.eggMult *
      W.PREMIUM_EGG_MULT;
    expect(s.winter!.eggRate).toBeCloseTo(expected, 4);
    expect(s.resources.eggs).toBeGreaterThan(eggsBefore); // hauled into SHARED storage
  });
});

describe('winter lay obeys the Grange + online-only laws', () => {
  it('an active delivery diverts ONLINE winter lay; offline lay never diverts', () => {
    const mk = () => {
      const s = winterSite(1);
      s.legacyTier = 3;
      s.ducks = [duck('w')];
      assignToWinter(s, 'w');
      s.contracts.active = {
        id: 'ct1',
        type: 'delivery',
        notch: 0,
        reward: { dust: 1, shards: 0 },
        completed: false,
        quota: 1_000_000,
        delivered: 0,
        limitRemaining: 9999,
      };
      return s;
    };
    const online = mk();
    run(online, 30);
    expect(online.contracts.active && 'delivered' in online.contracts.active ? online.contracts.active.delivered : 0).toBeGreaterThan(0);

    const offline = mk();
    for (let i = 0; i < 300; i++) tick(offline, 0.1, { mode: 'offline', autoHaul: true });
    expect(offline.contracts.active && 'delivered' in offline.contracts.active ? offline.contracts.active.delivered : 0).toBe(0);
  });
});

describe('save round-trip + back-compat (the union-growth sweep)', () => {
  it('a pre-6d save (no winter resources/keys) loads with the new lines at 0', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { corn: 5, eggs: 100 },
      ration: { corn: 2 },
      stations: [],
    });
    const r = deserialize(legacy, 0);
    expect(r.resources.sunflowerSeeds).toBe(0);
    expect(r.resources.fodderSprouts).toBe(0);
    expect(r.ration.sunflowerSeeds).toBe(0);
    expect(r.ration.fodderSprouts).toBe(0);
    expect(r.resources.corn).toBe(5); // old values intact
  });

  it('round-trips a live Winterstead (zone + stations + winter stock)', () => {
    const s = withWinter(fullSetup());
    placeStation(s, 'seedStore', 0, 0, 'winterstead');
    run(s, 10);
    const r = deserialize(serialize(s), 0);
    expect(zoneUnlocked(r, 'winterstead')).toBe(true);
    expect(r.stations.some((x) => x.type === 'seedStore' && x.zoneId === 'winterstead')).toBe(true);
    expect(r.resources.sunflowerSeeds).toBeCloseTo(s.resources.sunflowerSeeds, 6);
  });

  it('round-trips an assignment (site) + the winter ration; pre-6d saves default both', () => {
    const s = winterSite(1);
    s.ducks = [duck('w1')];
    assignToWinter(s, 'w1');
    const r = deserialize(serialize(s), 0);
    expect(r.ducks[0].site).toBe('winter');
    expect(r.winterRation).toEqual(s.winterRation);

    const legacy = deserialize(JSON.stringify({ resources: { eggs: 1 }, stations: [], ducks: [] }), 0);
    expect(legacy.winterRation).toEqual({ corn: 0, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0, sunflowerSeeds: 0, fodderSprouts: 0 });
  });

  it('prestige wipes assignments with the flock (reset = fresh game)', () => {
    const s = winterSite(1);
    s.ducks = [duck('w1')];
    assignToWinter(s, 'w1');
    const reset = prestigeReset(s, 0);
    expect(reset.ducks).toEqual([]);
    expect(reset.winter).toBeUndefined();
    expect(reset.winterRation).toEqual({ corn: 0, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0, sunflowerSeeds: 0, fodderSprouts: 0 });
  });
});
