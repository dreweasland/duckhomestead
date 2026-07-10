import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { GUIDE_DEFS, guideStorageKey } from '../src/config/guides';
import { targetForTier } from '../src/game/prestige';
import { tick } from '../src/game/tick';
import {
  COLORS,
  zeroRation,
  type Duck,
  type GameState,
  type Module,
  type NutritionState,
} from '../src/game/state';
import { build, run } from './helpers';

const P = BALANCE.PRESTIGE;

/** A full, self-consistent-enough NutritionState stub — the rattled predicate
 *  only reads `.stressMult`, but the field is typed, so every field needs a
 *  plausible value. */
function stubNutrition(overrides: Partial<NutritionState> = {}): NutritionState {
  const axes = { energy: 1, protein: 1, niacin: 1, calcium: 1 };
  return {
    satisfaction: { ...axes },
    supply: { ...axes },
    requirement: { ...axes },
    eggMultRaw: 1,
    eggMult: 1,
    stressMult: 1,
    feedScale: 1,
    hasMill: true,
    millCapacity: 10,
    feedDemand: 5,
    eggRate: 1,
    ...overrides,
  };
}

/** Force a champion flock exactly meeting the CURRENT tier's goal — mirrors
 *  engine.test.ts's makeChampion (every color dexed + SIZE_BASE truebred hens
 *  matching targetForTier(legacyTier), so meanQuality comfortably clears the
 *  quality gate). */
function makeChampion(s: GameState): void {
  s.dexSeen = [...COLORS];
  const target = targetForTier(s.legacyTier);
  s.ducks = Array.from({ length: P.SIZE_BASE }, (_, i): Duck => ({
    id: `champ${i + 1}`,
    genotype: ['Bl', 'bl'] as ['Bl', 'bl'],
    genome: [...target],
    genomeKnown: true,
    sex: 'hen',
    stage: 'adult',
    ageTicks: 5,
  }));
}

function makeModule(): Module {
  return { id: 'm1', stat: 'eggOutput', rarity: 'common', magnitude: 0.1 };
}

const defOf = (id: string) => {
  const def = GUIDE_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`no such guide: ${id}`);
  return def;
};

let nextDuckId = 1;
function makeDuck(sex: Duck['sex'], stage: Duck['stage'] = 'adult'): Duck {
  return {
    id: `t${nextDuckId++}`,
    genotype: ['bl', 'bl'] as ['bl', 'bl'],
    genome: ['D', 'D', 'D', 'D', 'D', 'D'],
    genomeKnown: true,
    sex,
    stage,
    ageTicks: 0,
  };
}

describe('guides.ts — storage keys', () => {
  it('migrated pages keep their legacy pre-Almanac keys', () => {
    expect(guideStorageKey(defOf('welcome'))).toBe('duck-homestead-welcome-seen');
    expect(guideStorageKey(defOf('defenses-down'))).toBe('duck-homestead-defenses-down-seen');
  });
  it('new pages get the duck-homestead-guide-<id> key', () => {
    expect(guideStorageKey(defOf('rations-unset'))).toBe('duck-homestead-guide-rations-unset');
    expect(guideStorageKey(defOf('breeding-nudge'))).toBe('duck-homestead-guide-breeding-nudge');
  });
  it('every id is unique', () => {
    const ids = GUIDE_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('guide: rations-unset', () => {
  const when = defOf('rations-unset').when;

  it('fires when a coop exists, the ration is untouched, and — once the condition battery drains — output is throttled', () => {
    const s = build({ plot: 1, coop: 1 });
    s.ration = zeroRation(); // build() seeds a fed default ration for sim tests; this page needs an UNSET one
    s.ducks.push(makeDuck('hen'));
    // A single tick reads as fine (condition still full, buffering the zero
    // ration) — this predicate is about a SUSTAINED unset ration, not turn one.
    tick(s, 1, { mode: 'online', autoHaul: true });
    expect(s.nutrition).toBeDefined();
    expect(when(s)).toBe(false);
    run(s, 600); // drain the condition battery
    expect(when(s)).toBe(true);
  });

  it('does NOT fire before any coop exists (no nutrition snapshot yet)', () => {
    const s = build({ plot: 1 });
    expect(when(s)).toBe(false);
  });

  it('does NOT fire once the ration is set', () => {
    const s = build({ plot: 1, coop: 1 });
    s.ducks.push(makeDuck('hen'));
    s.ration = { ...BALANCE.NUTRITION.DEFAULT_RATION };
    tick(s, 1, { mode: 'online', autoHaul: true });
    expect(when(s)).toBe(false);
  });
});

describe('guide: breeding-nudge', () => {
  const when = defOf('breeding-nudge').when;

  it('fires at rank 6+ with an adult drake and hen but no pairs and no reader', () => {
    const s = build({});
    s.rank = 6;
    s.ducks.push(makeDuck('drake'), makeDuck('hen'));
    expect(when(s)).toBe(true);
  });

  it('does NOT fire below rank 6', () => {
    const s = build({});
    s.rank = 5;
    s.ducks.push(makeDuck('drake'), makeDuck('hen'));
    expect(when(s)).toBe(false);
  });

  it('does NOT fire once a pair exists', () => {
    const s = build({});
    s.rank = 6;
    const drake = makeDuck('drake');
    const hen = makeDuck('hen');
    s.ducks.push(drake, hen);
    s.breedingPairs.push({ id: 'p1', drakeId: drake.id, henId: hen.id, clutchProgress: 0, incubating: [] });
    expect(when(s)).toBe(false);
  });

  it('does NOT fire without both an adult drake and hen', () => {
    const s = build({});
    s.rank = 6;
    s.ducks.push(makeDuck('drake'));
    expect(when(s)).toBe(false);
  });

  it('does NOT fire once the gene-reader is built (breeding already established)', () => {
    const s = build({});
    s.rank = 6;
    s.ducks.push(makeDuck('drake'), makeDuck('hen'));
    s.geneReader = true;
    expect(when(s)).toBe(false);
  });
});

describe('guide: welcome (migrated)', () => {
  const when = defOf('welcome').when;

  it('fires once the starter coop is up but protein+calcium producers are missing', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    expect(when(s)).toBe(true);
  });

  it('does NOT fire before the coop is placed', () => {
    const s = build({ plot: 1, mill: 1 });
    expect(when(s)).toBe(false);
  });

  it('does NOT fire once both missing producers are built', () => {
    const s = build({ plot: 1, mill: 1, coop: 1, mealwormFarm: 1, oysterSource: 1 });
    expect(when(s)).toBe(false);
  });
});

describe('guide: defenses-down (migrated)', () => {
  const when = defOf('defenses-down').when;

  function activeState(): GameState {
    const s = build({});
    s.rank = BALANCE.PREDATORS.INTRO_RANK;
    s.ducks.push(makeDuck('hen'));
    s.activeRemaining = BALANCE.PREDATORS.ACTIVE_WINDOW_S;
    s.predators.owl.windowRemaining = BALANCE.PREDATORS.OWL.windowDurationSec;
    return s;
  }

  it('fires when a window is open, the player is active, and predators are live', () => {
    const s = activeState();
    expect(when(s)).toBe(true);
  });

  it('does NOT fire while guarded (activeRemaining 0)', () => {
    const s = activeState();
    s.activeRemaining = 0;
    expect(when(s)).toBe(false);
  });

  it('does NOT fire before predators are active (below intro rank / no flock)', () => {
    const s = activeState();
    s.rank = BALANCE.PREDATORS.INTRO_RANK - 1;
    expect(when(s)).toBe(false);
  });

  it('does NOT fire with no window open or incoming', () => {
    const s = activeState();
    s.predators.owl.windowRemaining = 0;
    s.predators.owl.timeToNextWindow = BALANCE.PREDATORS.OWL.windowEverySec;
    expect(when(s)).toBe(false);
  });
});

describe('guide: housing-full', () => {
  const when = defOf('housing-full').when;

  it('fires when the flock has reached coop capacity', () => {
    const s = build({ coop: 1 }); // COOP_CAPACITY(4) × level 1 = 4 slots
    s.ducks = []; // placing the first coop auto-seeds a flock; start from a known count
    for (let i = 0; i < 4; i++) s.ducks.push(makeDuck('hen'));
    expect(when(s)).toBe(true);
  });

  it('does NOT fire below capacity', () => {
    const s = build({ coop: 1 });
    s.ducks = [];
    s.ducks.push(makeDuck('hen'));
    expect(when(s)).toBe(false);
  });

  it('does NOT fire with zero ducks and zero coops (0 >= 0 is not "full")', () => {
    const s = build({});
    expect(when(s)).toBe(false);
  });
});

describe('guide: duckling-ration', () => {
  const when = defOf('duckling-ration').when;

  it('fires when a duckling exists and the duckling ration is unset', () => {
    const s = build({});
    s.ducklingRation = zeroRation();
    s.ducks.push(makeDuck('hen', 'duckling'));
    expect(when(s)).toBe(true);
  });

  it('does NOT fire before any duckling exists', () => {
    const s = build({});
    s.ducklingRation = zeroRation();
    s.ducks.push(makeDuck('hen'));
    expect(when(s)).toBe(false);
  });

  it('does NOT fire once the duckling ration is set', () => {
    const s = build({}); // build() seeds DEFAULT_DUCKLING_RATION
    s.ducks.push(makeDuck('hen', 'duckling'));
    expect(when(s)).toBe(false);
  });
});

describe('guide: drake-ration', () => {
  const when = defOf('drake-ration').when;

  it('fires once breeding is established, a drake exists, and the drake ration is unset', () => {
    const s = build({});
    s.drakeRation = zeroRation();
    s.geneReader = true; // breedingEstablished
    s.ducks.push(makeDuck('drake'));
    expect(when(s)).toBe(true);
  });

  it('does NOT fire before breeding is established', () => {
    const s = build({});
    s.drakeRation = zeroRation();
    s.ducks.push(makeDuck('drake'));
    expect(when(s)).toBe(false);
  });

  it('does NOT fire without an adult drake', () => {
    const s = build({});
    s.drakeRation = zeroRation();
    s.geneReader = true;
    expect(when(s)).toBe(false);
  });

  it('does NOT fire once the drake ration is set', () => {
    const s = build({}); // build() seeds DEFAULT_DRAKE_RATION
    s.geneReader = true;
    s.ducks.push(makeDuck('drake'));
    expect(when(s)).toBe(false);
  });
});

describe('guide: gene-reader', () => {
  const when = defOf('gene-reader').when;

  it('fires once a pair exists, the reader is unbuilt, and eggs cover the cost', () => {
    const s = build({});
    const drake = makeDuck('drake');
    const hen = makeDuck('hen');
    s.ducks.push(drake, hen);
    s.breedingPairs.push({ id: 'p1', drakeId: drake.id, henId: hen.id, clutchProgress: 0, incubating: [] });
    expect(s.resources.eggs).toBeGreaterThanOrEqual(BALANCE.GENOME.READER_COST_EGGS); // build() stocks 1e6
    expect(when(s)).toBe(true);
  });

  it('does NOT fire without a pair', () => {
    const s = build({});
    expect(when(s)).toBe(false);
  });

  it('does NOT fire once the reader is built', () => {
    const s = build({});
    const drake = makeDuck('drake');
    const hen = makeDuck('hen');
    s.ducks.push(drake, hen);
    s.breedingPairs.push({ id: 'p1', drakeId: drake.id, henId: hen.id, clutchProgress: 0, incubating: [] });
    s.geneReader = true;
    expect(when(s)).toBe(false);
  });

  it('does NOT fire short of the egg cost', () => {
    const s = build({});
    const drake = makeDuck('drake');
    const hen = makeDuck('hen');
    s.ducks.push(drake, hen);
    s.breedingPairs.push({ id: 'p1', drakeId: drake.id, henId: hen.id, clutchProgress: 0, incubating: [] });
    s.resources.eggs = BALANCE.GENOME.READER_COST_EGGS - 1;
    expect(when(s)).toBe(false);
  });
});

describe('guide: clutch-economy', () => {
  const when = defOf('clutch-economy').when;

  it('fires the first time a pair exists', () => {
    const s = build({});
    const drake = makeDuck('drake');
    const hen = makeDuck('hen');
    s.ducks.push(drake, hen);
    s.breedingPairs.push({ id: 'p1', drakeId: drake.id, henId: hen.id, clutchProgress: 0, incubating: [] });
    expect(when(s)).toBe(true);
  });

  it('does NOT fire before any pair exists', () => {
    const s = build({});
    expect(when(s)).toBe(false);
  });
});

describe('guide: modules', () => {
  const when = defOf('modules').when;

  it('fires once a module lands in inventory', () => {
    const s = build({});
    s.inventory.push(makeModule());
    expect(when(s)).toBe(true);
  });

  it('fires once a module lands in the rack', () => {
    const s = build({});
    s.rack.push(makeModule());
    expect(when(s)).toBe(true);
  });

  it('does NOT fire with no modules anywhere', () => {
    const s = build({});
    expect(when(s)).toBe(false);
  });
});

describe('guide: wound-care', () => {
  const when = defOf('wound-care').when;

  it('fires once a duck is wounded', () => {
    const s = build({});
    const duck = makeDuck('hen');
    duck.wounded = true;
    s.ducks.push(duck);
    expect(when(s)).toBe(true);
  });

  it('does NOT fire with no wounded ducks', () => {
    const s = build({});
    s.ducks.push(makeDuck('hen'));
    expect(when(s)).toBe(false);
  });
});

describe('guide: rattled', () => {
  const when = defOf('rattled').when;

  it('fires the first time stressMult dips below 0.995', () => {
    const s = build({});
    s.nutrition = stubNutrition({ stressMult: 0.9 });
    expect(when(s)).toBe(true);
  });

  it('does NOT fire at full stressMult (calm/fed)', () => {
    const s = build({});
    s.nutrition = stubNutrition({ stressMult: 1 });
    expect(when(s)).toBe(false);
  });

  it('does NOT fire before nutrition has ever been computed', () => {
    const s = build({});
    expect(when(s)).toBe(false);
  });
});

describe('guide: overcrowding', () => {
  const when = defOf('overcrowding').when;

  function flock(hens: number, drakes: number, established = true): GameState {
    const s = build({});
    s.geneReader = established; // breedingEstablished
    for (let i = 0; i < hens; i++) s.ducks.push(makeDuck('hen'));
    for (let i = 0; i < drakes; i++) s.ducks.push(makeDuck('drake'));
    return s;
  }

  it('fires once the flock is over-drake past the size gate', () => {
    const s = flock(2, 9); // 11 ducks ≥ OVERCROWD_MIN_FLOCK(10); way over 1 drake per 4 hens
    expect(when(s)).toBe(true);
  });

  it('does NOT fire below the flock-size gate, even badly over-drake', () => {
    const s = flock(1, 4); // 5 ducks — exempt, a starter pair is never punished
    expect(when(s)).toBe(false);
  });

  it('does NOT fire at a healthy ratio', () => {
    const s = flock(8, 2); // 10 ducks, ratio fine (≤1 drake per 4 hens)
    expect(when(s)).toBe(false);
  });
});

describe('guide: champion-goal', () => {
  const when = defOf('champion-goal').when;

  it('fires at rank 14+ regardless of readiness', () => {
    const s = build({});
    s.rank = 14;
    expect(when(s)).toBe(true);
  });

  it('fires below rank 14 once readiness reaches 25%', () => {
    const s = build({});
    s.rank = 1;
    makeChampion(s); // full champion flock → readiness 1.0 ≥ 0.25
    expect(when(s)).toBe(true);
  });

  it('does NOT fire on a fresh flock well below rank 14', () => {
    const s = build({});
    s.rank = 1;
    expect(when(s)).toBe(false);
  });
});

describe('guide: prestige-ready', () => {
  const when = defOf('prestige-ready').when;

  it('fires once canPrestige is true', () => {
    const s = build({});
    makeChampion(s);
    expect(when(s)).toBe(true);
  });

  it('does NOT fire on a fresh flock', () => {
    const s = build({});
    expect(when(s)).toBe(false);
  });
});

describe('guide: grange', () => {
  const when = defOf('grange').when;

  it('fires once legacyTier reaches the Grange unlock tier', () => {
    const s = build({});
    s.legacyTier = BALANCE.CONTRACTS.UNLOCK_TIER;
    expect(when(s)).toBe(true);
  });

  it('does NOT fire pre-prestige (tier 0)', () => {
    const s = build({});
    expect(when(s)).toBe(false);
  });
});

describe('guide: winterstead', () => {
  const when = defOf('winterstead').when;

  it('fires once Winterstead unlocks', () => {
    const s = build({});
    s.zones.winterstead.unlocked = true;
    expect(when(s)).toBe(true);
  });

  it('does NOT fire while still locked', () => {
    const s = build({});
    expect(when(s)).toBe(false);
  });
});

describe('guide: backup', () => {
  const when = defOf('backup').when;

  it('fires at rank 10+', () => {
    const s = build({});
    s.rank = 10;
    expect(when(s)).toBe(true);
  });

  it('does NOT fire below rank 10', () => {
    const s = build({});
    s.rank = 9;
    expect(when(s)).toBe(false);
  });
});

describe('zone-unlockable announcements (pond / works / winterstead)', () => {
  const W = BALANCE.WATER;

  it('pond-ready fires only with rank AND eggs met, and never once unlocked', () => {
    const when = defOf('pond-ready').when;
    const s = build({});
    s.rank = W.POND_UNLOCK.rankRequired;
    s.resources.eggs = W.POND_UNLOCK.eggCost - 1;
    expect(when(s)).toBe(false); // eggs short
    s.resources.eggs = W.POND_UNLOCK.eggCost;
    expect(when(s)).toBe(true);
    s.rank = W.POND_UNLOCK.rankRequired - 1;
    expect(when(s)).toBe(false); // rank short
    s.rank = W.POND_UNLOCK.rankRequired;
    s.zones['pond'] = { unlocked: true };
    expect(when(s)).toBe(false); // already dug
  });

  it('works-ready additionally waits for the pond (nothing to freshen without it)', () => {
    const when = defOf('works-ready').when;
    const s = build({});
    s.rank = W.WORKS_UNLOCK.rankRequired;
    s.resources.eggs = W.WORKS_UNLOCK.eggCost;
    expect(when(s)).toBe(false); // pond not dug yet
    s.zones['pond'] = { unlocked: true };
    expect(when(s)).toBe(true);
    s.zones['backPasture'] = { unlocked: true };
    expect(when(s)).toBe(false);
  });

  it('winterstead-ready is triple-gated: rank, TIER, and the 20k eggs', () => {
    const when = defOf('winterstead-ready').when;
    const U = BALANCE.WINTER.UNLOCK;
    const s = build({});
    s.rank = U.rankRequired;
    s.resources.eggs = U.eggCost;
    expect(when(s)).toBe(false); // tier short
    s.legacyTier = U.minLegacyTier;
    expect(when(s)).toBe(true);
    s.zones['winterstead'] = { unlocked: true };
    expect(when(s)).toBe(false);
  });

  it('each carries a zone CTA pointing at its own board', () => {
    expect(defOf('pond-ready').cta).toMatchObject({ open: 'zone', zone: 'pond' });
    expect(defOf('works-ready').cta).toMatchObject({ open: 'zone', zone: 'backPasture' });
    expect(defOf('winterstead-ready').cta).toMatchObject({ open: 'zone', zone: 'winterstead' });
  });
});
