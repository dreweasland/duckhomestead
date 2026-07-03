import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { GUIDE_DEFS, guideStorageKey } from '../src/config/guides';
import { tick } from '../src/game/tick';
import { zeroRation, type Duck, type GameState } from '../src/game/state';
import { build, run } from './helpers';

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
