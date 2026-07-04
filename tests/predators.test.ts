import { describe, it, expect, afterEach } from 'vitest';
import { BALANCE, PREDATOR_DEFS, predatorDef } from '../src/config/balance';
import {
  initialState,
  defenseCoverage,
  defenseFloor,
  exposedFlock,
  deterrentCost,
  secureCapacity,
  type Duck,
  type GameState,
  type Gene,
  type Genotype,
} from '../src/game/state';
import {
  runPredators,
  attackChance,
  predatorsActive,
  incoming,
  windowOpen,
  activeStrike,
  currentThreat,
  rollWindowAttacks,
  rollWoundSeverity,
  scareOff,
  rankDifficulty,
  strikeWindupSec,
} from '../src/game/predators';
import { waterWoundMult } from '../src/game/water';
import {
  buildDeterrent,
  buildInfirmary,
  buildSecureCoop,
  repairDeterrents,
  setSecured,
  admitToInfirmary,
  buildHardwareCloth,
  repairHardwareCloth,
} from '../src/game/actions';
import { runOfflineCatchUp, deserialize, serialize } from '../src/game/save';
import { fullSetup, stockAll, setHens, run } from './helpers';

const P = BALANCE.PREDATORS;
const OWL = predatorDef('owl')!;
const HOUR = 3600 * 1000;

// Deterministic RNGs for the stochastic roll. `always` => every attack lands
// (0 >= success is false for success>0, so the attempt proceeds; target pick
// also takes the first eligible). `never` => every attack misses.
const always = () => 0;
const never = () => 1;

/** A predator-ready flock: past the intro rank, n adult ducks (alternating sex). */
function flock(n: number): GameState {
  const s = initialState(0);
  s.resources.eggs = 1e7; // fund deterrents / secure coops freely
  s.rank = P.INTRO_RANK;
  s.predatorsIntroduced = true; // most tests exercise post-introduction behavior
  s.ducks = Array.from({ length: n }, (_, i): Duck => ({
    id: `d${i}`,
    genotype: ['bl', 'bl'] as Genotype,
    genome: ['D', 'D', 'D', 'D', 'D', 'D'],
    sex: i % 2 === 0 ? 'hen' : 'drake',
    stage: 'adult',
    ageTicks: 0,
  }));
  s.nextDuckId = n + 1;
  return s;
}

/** Force the owl's window open at t=0 of the window. */
function openWindow(s: GameState): void {
  s.predators.owl = { timeToNextWindow: 0, windowRemaining: OWL.windowDurationSec, windowElapsed: 0, attacksFired: 0 };
}

const events = (s: GameState) => s.pendingPredatorEvents ?? [];

afterEach(() => {
  // Restore the brutality dial in case a test flipped it.
  (BALANCE.PREDATORS as { ALLOW_INSTANT_SNATCH: boolean }).ALLOW_INSTANT_SNATCH = false;
});

describe('rollWindowAttacks — variable hidden per-window count (no "2 and done")', () => {
  it('rolls a weighted 1..3 (all occur), and falls back to attacksPerWindow without weights', () => {
    const owl = PREDATOR_DEFS[0];
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rollWindowAttacks(owl, Math.random));
    expect([...seen].every((n) => n >= 1 && n <= 3)).toBe(true);
    expect(seen.has(1) && seen.has(2) && seen.has(3)).toBe(true); // all three show up
    // A def with no weights → the fixed count (backward compatible).
    expect(rollWindowAttacks({ ...owl, attackCountWeights: undefined }, Math.random)).toBe(owl.attacksPerWindow);
  });

  it('a window stores its rolled count when it opens (1..3)', () => {
    const s = flock(6);
    s.predators.owl = { timeToNextWindow: 0.5, windowRemaining: 0, windowElapsed: 0, attacksFired: 0 };
    runPredators(s, 1, { mode: 'online', rng: Math.random }); // crosses the counter → window opens
    const n = s.predators.owl.windowAttacks!;
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(3);
  });
});

describe('currentThreat — the UI telegraph selector', () => {
  const owl = PREDATOR_DEFS[0]; // warningLeadSec / windowDurationSec drive the buckets
  const setOwl = (s: GameState, ps: Partial<GameState['predators'][string]>): void => {
    s.predators.owl = { timeToNextWindow: owl.windowEverySec, windowRemaining: 0, windowElapsed: 0, attacksFired: 0, ...ps };
  };

  it('is null when predators are dormant (no flock, or below the intro rank)', () => {
    const noFlock = flock(0);
    setOwl(noFlock, { windowRemaining: 30 });
    expect(currentThreat(noFlock)).toBeNull(); // no ducks → dormant

    const early = flock(4);
    early.rank = P.INTRO_RANK - 1;
    setOwl(early, { windowRemaining: 30 });
    expect(currentThreat(early)).toBeNull(); // pre-intro rank → dormant
  });

  it('is null when all is calm (window closed and the next one is beyond the warning lead)', () => {
    const s = flock(4);
    setOwl(s, { timeToNextWindow: owl.warningLeadSec + 100 });
    expect(currentThreat(s)).toBeNull();
  });

  it('reports an INCOMING window once inside the warning lead, with seconds-to-open', () => {
    const s = flock(4);
    setOwl(s, { timeToNextWindow: owl.warningLeadSec - 5 });
    const t = currentThreat(s);
    expect(t?.phase).toBe('incoming');
    expect(t?.seconds).toBe(owl.warningLeadSec - 5);
    expect(t?.def.id).toBe('owl');
  });

  it('reports an OPEN window with the seconds remaining (open beats an imminent next window)', () => {
    const s = flock(4);
    // Window open now AND the counter to the next one is tiny — open must win.
    setOwl(s, { windowRemaining: 30, windowElapsed: 30, timeToNextWindow: 1, attacksFired: 1 });
    const t = currentThreat(s);
    expect(t?.phase).toBe('open');
    expect(t?.seconds).toBe(30);
  });
});

describe('predator config is generic (owl is data, not hardcoded)', () => {
  it('the owl is the first PREDATOR_DEF and carries the OWL balance numbers', () => {
    expect(PREDATOR_DEFS[0].id).toBe('owl');
    expect(PREDATOR_DEFS[0].baseAttackChance).toBe(P.OWL.baseAttackChance);
    expect(PREDATOR_DEFS[0].windowEverySec).toBe(P.OWL.windowEverySec);
  });

  it('the raccoon is a second data-driven predator on its own defense line', () => {
    const rac = PREDATOR_DEFS.find((d) => d.id === 'raccoon')!;
    expect(rac.defense).toBe('cloth'); // stopped by hardware cloth, not nets
    expect(PREDATOR_DEFS.find((d) => d.id === 'owl')!.defense).toBe('net');
    expect(rac.introRank).toBeGreaterThan(BALANCE.PREDATORS.INTRO_RANK); // debuts later
  });
});

describe('per-predator defense: nets stop the owl, hardware cloth stops the raccoon', () => {
  const owl = PREDATOR_DEFS.find((d) => d.id === 'owl')!;
  const rac = PREDATOR_DEFS.find((d) => d.id === 'raccoon')!;

  it('a defense line only lowers ITS predator, not the other', () => {
    const s = flock(4);
    s.deterrents = 3; // nets only
    s.hardwareCloth = 0;
    expect(attackChance(s, owl, false)).toBeLessThan(owl.baseAttackChance); // nets cut the owl
    expect(attackChance(s, rac, false)).toBeCloseTo(rac.baseAttackChance, 6); // ...not the raccoon

    s.deterrents = 0;
    s.hardwareCloth = 3; // cloth only
    expect(attackChance(s, rac, false)).toBeLessThan(rac.baseAttackChance); // cloth cuts the raccoon
    expect(attackChance(s, owl, false)).toBeCloseTo(owl.baseAttackChance, 6); // ...not the owl
  });

  it('build-defense cost escalates with each of a kind already built', () => {
    const s = flock(4);
    s.resources.eggs = 1e7;
    const c1 = deterrentCost(s);
    buildDeterrent(s);
    const c2 = deterrentCost(s);
    expect(c2).toBe(Math.round(c1 * BALANCE.PREDATORS.DEFENSE_COST_GROWTH)); // × growth each
    expect(c2).toBeGreaterThan(c1);
  });

  it('secure coops give +4 slots for the first, +2 for each additional (diminishing)', () => {
    const s = flock(4);
    s.resources.eggs = 1e7;
    expect(secureCapacity(s)).toBe(0);
    buildSecureCoop(s);
    expect(secureCapacity(s)).toBe(BALANCE.PREDATORS.SECURE_SLOTS_PER_COOP); // 4
    buildSecureCoop(s);
    expect(secureCapacity(s)).toBe(
      BALANCE.PREDATORS.SECURE_SLOTS_PER_COOP + BALANCE.PREDATORS.SECURE_SLOTS_ADDITIONAL, // 6
    );
  });

  it('build/repair hardware cloth raises then restores the ground floor (its own pool)', () => {
    const s = flock(4);
    s.resources.eggs = 1e6;
    expect(buildHardwareCloth(s).ok).toBe(true);
    expect(s.hardwareCloth).toBe(1);
    expect(defenseFloor(s, 'cloth')).toBeGreaterThan(0);
    expect(defenseFloor(s, 'net')).toBe(0); // nets untouched — separate pool
    s.hardwareClothIntegrity = 0.4; // worn by a raid
    const before = s.resources.eggs;
    expect(repairHardwareCloth(s).ok).toBe(true);
    expect(s.hardwareClothIntegrity).toBe(1);
    expect(s.resources.eggs).toBeLessThan(before); // repair costs eggs
  });
});

describe('the raccoon debuts at its rank (never a bolt from the blue)', () => {
  const RANK = BALANCE.PREDATORS.RACCOON_INTRO_RANK;

  it('stays dormant below its intro rank', () => {
    const s = flock(6);
    s.rank = RANK - 1;
    runPredators(s, 1, { mode: 'online', rng: never });
    expect(s.predatorsSeen ?? []).not.toContain('raccoon');
  });

  it('debuts online at its rank with its own introduced beat', () => {
    const s = flock(6);
    s.rank = RANK;
    runPredators(s, 1, { mode: 'online', rng: never });
    expect(s.predatorsSeen).toContain('raccoon');
    expect(events(s).some((e) => e.kind === 'introduced' && e.predatorId === 'raccoon')).toBe(true);
  });

  it('does NOT debut offline — a returning player who ranked past it is not ambushed', () => {
    const s = flock(6);
    s.rank = RANK;
    runPredators(s, 1, { mode: 'offline', rng: never });
    expect(s.predatorsSeen ?? []).not.toContain('raccoon');
  });
});

describe('the siege (The Great Horned) — tier-gated, offline-frozen EVENT (Phase 6c)', () => {
  const SIEGE = PREDATOR_DEFS.find((d) => d.id === 'greatHorned')!;
  const RANK = SIEGE.introRank;
  const TIER = SIEGE.minLegacyTier!;

  it('is data-driven: minLegacyTier + the SIEGE balance numbers, no id in core logic', () => {
    expect(SIEGE.minLegacyTier).toBe(BALANCE.PREDATORS.SIEGE.MIN_LEGACY_TIER);
    expect(SIEGE.introRank).toBe(BALANCE.PREDATORS.SIEGE.INTRO_RANK);
    expect(SIEGE.windupScale).toBe(BALANCE.PREDATORS.SIEGE.WINDUP_SCALE);
    expect(SIEGE.jackpot?.dust).toBe(BALANCE.PREDATORS.SIEGE.JACKPOT.dust);
  });

  it('never schedules below tier 2, even past its intro rank', () => {
    const s = flock(6);
    s.rank = RANK;
    s.legacyTier = TIER - 1;
    runPredators(s, 1, { mode: 'online', rng: never });
    expect(s.predatorsSeen ?? []).not.toContain('greatHorned');
  });

  it('never schedules below its intro rank, even at tier 2+', () => {
    const s = flock(6);
    s.rank = RANK - 1;
    s.legacyTier = TIER;
    runPredators(s, 1, { mode: 'online', rng: never });
    expect(s.predatorsSeen ?? []).not.toContain('greatHorned');
  });

  it('debuts online once both the rank AND tier gates are met', () => {
    const s = flock(6);
    s.rank = RANK;
    s.legacyTier = TIER;
    runPredators(s, 1, { mode: 'online', rng: never });
    expect(s.predatorsSeen).toContain('greatHorned');
    expect(events(s).some((e) => e.kind === 'introduced' && e.predatorId === 'greatHorned')).toBe(true);
  });

  it('does not debut offline, same as any other predator\'s first-contact grace', () => {
    const s = flock(6);
    s.rank = RANK;
    s.legacyTier = TIER;
    runPredators(s, 1, { mode: 'offline', rng: never });
    expect(s.predatorsSeen ?? []).not.toContain('greatHorned');
  });

  it("the schedule's clock is FROZEN offline — timeToNextWindow does not advance", () => {
    const s = flock(6);
    s.rank = RANK;
    s.legacyTier = TIER;
    s.predatorsSeen = ['greatHorned'];
    s.predators.greatHorned = { timeToNextWindow: 500, windowRemaining: 0, windowElapsed: 0, attacksFired: 0 };
    runPredators(s, 3600, { mode: 'offline', rng: never }); // a whole offline hour
    expect(s.predators.greatHorned.timeToNextWindow).toBe(500); // untouched
  });

  it('an OPEN window fizzles on offline catch-up: cleared, rescheduled fresh, no jackpot', () => {
    const s = flock(6);
    s.rank = RANK;
    s.legacyTier = TIER;
    s.predatorsSeen = ['greatHorned'];
    s.predators.greatHorned = {
      timeToNextWindow: 0,
      windowRemaining: 40,
      windowElapsed: 35,
      attacksFired: 2,
    };
    runPredators(s, 60, { mode: 'offline', rng: never });
    const ps = s.predators.greatHorned;
    expect(ps.windowRemaining).toBe(0); // window cleared, not resolved
    expect(ps.timeToNextWindow).toBe(SIEGE.windowEverySec); // rescheduled a full interval out
    expect(ps.attacksFired).toBe(0);
    expect(events(s).some((e) => e.kind === 'siegeFoiled')).toBe(false); // no jackpot
  });

  it('a full offline catch-up (save.ts) never opens/resolves/expires a siege window', () => {
    const s = flock(6);
    s.rank = RANK;
    s.legacyTier = TIER;
    s.predatorsIntroduced = true;
    s.predatorsSeen = ['greatHorned'];
    s.predators.greatHorned = { timeToNextWindow: 10, windowRemaining: 0, windowElapsed: 0, attacksFired: 0 };
    s.lastSeen = 0;
    runOfflineCatchUp(s, HOUR); // 1h away — would cross several windows if it ran
    expect(s.predators.greatHorned.timeToNextWindow).toBe(10); // frozen the whole catch-up
  });

  it('normal predators (owl/raccoon) are unaffected by the siege gating/freeze', () => {
    const s = flock(6);
    s.rank = P.INTRO_RANK;
    s.legacyTier = 0; // well below the siege's gate
    openWindow(s);
    runPredators(s, 3600, { mode: 'offline', rng: always }); // owl still simulates offline
    expect(s.predators.owl.windowRemaining).not.toBe(OWL.windowDurationSec); // it advanced/resolved
  });
});

describe('the siege jackpot — flawless-defense grant + streak (Phase 6c)', () => {
  const SIEGE = PREDATOR_DEFS.find((d) => d.id === 'greatHorned')!;
  const JACKPOT = SIEGE.jackpot!;

  /** Force greatHorned's window to close THIS tick with a given committed-dive /
   *  landed tally, so resolveJackpot's grading fires deterministically. */
  function closeWindow(s: GameState, dives: number, landed: number): void {
    s.predators.greatHorned = {
      timeToNextWindow: 0,
      windowRemaining: 0.5,
      windowElapsed: 10,
      attacksFired: dives,
      jackpotDives: dives,
      jackpotLanded: landed,
    };
    runPredators(s, 1, { mode: 'online', rng: never }); // dt exceeds remaining -> closes
  }

  function readySiege(): GameState {
    const s = flock(6);
    s.rank = SIEGE.introRank;
    s.legacyTier = SIEGE.minLegacyTier!;
    s.predatorsSeen = ['greatHorned'];
    return s;
  }

  it('a flawless window (≥1 committed dive, zero landed) pays dust + a guaranteed module exactly once', () => {
    const s = readySiege();
    const before = s.dust;
    closeWindow(s, 3, 0);
    expect(s.dust).toBe(before + JACKPOT.dust);
    expect(s.inventory.length).toBe(1);
    expect(s.inventory[0].rarity).toBe(JACKPOT.moduleRarity);
    const ev = events(s).find((e) => e.kind === 'siegeFoiled') as { moduleId: string; dust: number } | undefined;
    expect(ev).toBeTruthy();
    expect(ev!.dust).toBe(JACKPOT.dust);
    expect(ev!.moduleId).toBe(s.inventory[0].id);
    expect(s.predatorFlawlessStreak).toBe(1);
  });

  it('one landed hit voids the jackpot AND resets the flawless streak', () => {
    const s = readySiege();
    s.predatorFlawlessStreak = 2; // two prior flawless sieges this run
    const before = s.dust;
    closeWindow(s, 3, 1); // one of the three dives landed
    expect(s.dust).toBe(before); // no grant
    expect(s.inventory.length).toBe(0);
    expect(events(s).some((e) => e.kind === 'siegeFoiled')).toBe(false);
    expect(s.predatorFlawlessStreak).toBe(0); // voided
  });

  it('a window with zero committed dives grades neither way (streak untouched)', () => {
    const s = readySiege();
    s.predatorFlawlessStreak = 2;
    closeWindow(s, 0, 0);
    expect(s.predatorFlawlessStreak).toBe(2); // untouched — nothing to grade
    expect(events(s).some((e) => e.kind === 'siegeFoiled')).toBe(false);
  });

  it('the streak\'s Nth consecutive flawless siege upgrades the grant to the streak rarity', () => {
    const s = readySiege();
    closeWindow(s, 1, 0); // streak 1
    expect(s.inventory[0].rarity).toBe(JACKPOT.moduleRarity);
    closeWindow(s, 1, 0); // streak 2
    expect(s.inventory[1].rarity).toBe(JACKPOT.moduleRarity);
    closeWindow(s, 1, 0); // streak 3 === streakForLegendary -> upgraded
    expect(s.predatorFlawlessStreak).toBe(3);
    expect(s.inventory[2].rarity).toBe(JACKPOT.flawlessStreakRarity);
  });
});

describe('brutality dial defaults OFF', () => {
  it('ALLOW_INSTANT_SNATCH is false', () => {
    expect(P.ALLOW_INSTANT_SNATCH).toBe(false);
  });
});

describe('attack success formula', () => {
  it('= base × (1 − floor) × (1 − presence)', () => {
    const s = flock(4);
    // No deterrents, absent.
    expect(attackChance(s, OWL, false)).toBeCloseTo(OWL.baseAttackChance, 6);
    // Absent, with deterrents raising the floor.
    buildDeterrent(s);
    const floor = defenseFloor(s);
    expect(floor).toBeCloseTo(P.DEFENSE_FLOOR_PER_DETERRENT, 6);
    expect(attackChance(s, OWL, false)).toBeCloseTo(OWL.baseAttackChance * (1 - floor), 6);
    // Present adds active cover.
    expect(attackChance(s, OWL, true)).toBeCloseTo(
      OWL.baseAttackChance * (1 - floor) * (1 - P.PRESENCE_FACTOR),
      6,
    );
  });

  it('built defenses alone are capped (can never be 100% passive)', () => {
    const s = flock(4);
    for (let i = 0; i < 20; i++) buildDeterrent(s);
    expect(defenseFloor(s)).toBe(P.DEFENSE_FLOOR_CAP);
    expect(attackChance(s, OWL, false)).toBeGreaterThan(0);
  });
});

describe('deterrent integrity — the defense upkeep loop', () => {
  it('the floor scales with integrity (a worn floor protects less)', () => {
    const s = flock(4);
    buildDeterrent(s); // 1 pristine net
    const full = defenseFloor(s);
    s.deterrentIntegrity = 0.5;
    expect(defenseFloor(s)).toBeCloseTo(full * 0.5, 6);
  });

  it('a threat window weathers the nets (ambient wear)', () => {
    const s = flock(4);
    s.deterrents = 4;
    s.deterrentIntegrity = 1;
    s.predators.owl.timeToNextWindow = 0; // opens this step
    runPredators(s, 1, { mode: 'online', rng: never }); // no attacks land
    expect(s.deterrentIntegrity).toBeCloseTo(1 - P.DETERRENT_WEAR_PER_WINDOW, 6);
  });

  it('a breach tears the nets harder than ambient wear', () => {
    const s = flock(4);
    s.deterrents = 1; // low floor -> the attack breaches
    s.deterrentIntegrity = 1;
    openWindow(s);
    runPredators(s, OWL.windowDurationSec / (OWL.attacksPerWindow + 1), { mode: 'offline', rng: always });
    expect(s.deterrentIntegrity).toBeCloseTo(1 - P.DETERRENT_WEAR_PER_HIT, 6);
    expect(P.DETERRENT_WEAR_PER_HIT).toBeGreaterThan(P.DETERRENT_WEAR_PER_WINDOW);
  });

  it('active play does NOT wear the floor — nets erode only while on duty', () => {
    const s = flock(4);
    s.deterrents = 2;
    s.deterrentIntegrity = 1;
    // An in-flight dive that resolves THIS tick, in active mode (floor suppressed).
    s.predators.owl = {
      timeToNextWindow: 1e9, // no new window opens (isolate the hit)
      windowRemaining: 30,
      windowElapsed: 10,
      attacksFired: 1,
      strike: { targetId: 'd0', windupRemaining: 0.001, windupTotal: 5, id: 1, spot: 0, clicksRequired: 1, clicksLanded: 0 },
    };
    runPredators(s, 1, { mode: 'online', rng: always, activeDefense: true });
    expect(s.ducks.some((d) => d.wounded)).toBe(true); // the un-scared dive landed
    expect(s.deterrentIntegrity).toBe(1); // ...but the floor wasn't engaged, so no wear
  });

  it('Repair restores integrity to pristine for a wear-prorated cost', () => {
    const s = flock(4);
    s.resources.eggs = 1000;
    s.deterrents = 4;
    s.deterrentIntegrity = 0.5;
    const expectedCost = Math.round(4 * P.DETERRENT_REPAIR_COST_PER_NET * 0.5);
    const r = repairDeterrents(s);
    expect(r.ok).toBe(true);
    expect(s.deterrentIntegrity).toBe(1);
    expect(s.resources.eggs).toBe(1000 - expectedCost);
    expect(repairDeterrents(s).ok).toBe(false); // already pristine
  });

  it('building a fresh net raises the average integrity of a worn set', () => {
    const s = flock(4);
    s.resources.eggs = 1e7;
    s.deterrents = 3;
    s.deterrentIntegrity = 0; // three fully-worn nets
    buildDeterrent(s);
    expect(s.deterrents).toBe(4);
    expect(s.deterrentIntegrity).toBeCloseTo((0 * 3 + 1) / 4, 6);
  });

  it('the floor weathers down while you are away (offline)', () => {
    const s = flock(8);
    s.rank = 5;
    s.deterrents = 4;
    s.deterrentIntegrity = 1;
    s.lastSeen = -8 * HOUR;
    runOfflineCatchUp(s, 0);
    expect(s.deterrentIntegrity).toBeLessThan(1); // can't repair while away
  });
});

describe('telegraph — never an ambush', () => {
  it('fires an "incoming" warning before the window opens, then "open"', () => {
    const s = flock(4);
    // Park the schedule just above the warning lead, closed.
    s.predators.owl.timeToNextWindow = OWL.warningLeadSec + 5;
    s.predators.owl.windowRemaining = 0;
    runPredators(s, 10, { mode: 'online', rng: never }); // crosses into the lead
    expect(events(s).some((e) => e.kind === 'incoming')).toBe(true);
    expect(incoming(s.predators.owl, OWL)).toBe(true);
    expect(windowOpen(s.predators.owl)).toBe(false);

    s.pendingPredatorEvents = [];
    runPredators(s, OWL.warningLeadSec, { mode: 'online', rng: never }); // reaches 0 -> opens
    expect(events(s).some((e) => e.kind === 'open')).toBe(true);
    expect(windowOpen(s.predators.owl)).toBe(true);
  });

  it('stays dormant before the intro rank (no windows for a fresh homestead)', () => {
    const s = flock(4);
    s.rank = P.INTRO_RANK - 1;
    expect(predatorsActive(s)).toBe(false);
    for (let t = 0; t < 1000; t++) runPredators(s, 1, { mode: 'online', rng: always });
    expect(events(s).filter((e) => e.kind === 'open')).toHaveLength(0);
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
  });
});

describe('first-contact grace — the feature never debuts as a bolt from the blue', () => {
  it('predators do NOT first activate during an absence (offline catch-up)', () => {
    const s = flock(12);
    s.predatorsIntroduced = false; // never been online with predators active
    s.rank = 5;
    s.lastSeen = -8 * HOUR;
    const away = runOfflineCatchUp(s, 0);
    expect(s.predatorsIntroduced).toBe(false); // still not introduced
    expect(s.ducks).toHaveLength(12); // nobody touched
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
    expect(away.predator).toBeUndefined();
  });

  it('introduces only while present (online), with a full telegraphed lead before the first window', () => {
    const s = flock(6);
    s.predatorsIntroduced = false;
    // A short online spell — well under the warning lead + interval.
    for (let t = 0; t < 100; t++) runPredators(s, 1, { mode: 'online', rng: always });
    expect(s.predatorsIntroduced).toBe(true);
    expect(events(s).some((e) => e.kind === 'introduced')).toBe(true);
    // No window has opened yet (first one is a full interval out), so no wounds.
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
    expect(s.predators.owl.timeToNextWindow).toBeGreaterThan(OWL.windowDurationSec);
  });
});

describe('a landed attack wounds (it does not kill)', () => {
  it('inflicts a soft wound on a fresh duck; no permanent loss', () => {
    const s = flock(4);
    openWindow(s);
    // Advance to the first staggered attack moment.
    runPredators(s, OWL.windowDurationSec / (OWL.attacksPerWindow + 1), { mode: 'offline', rng: always });
    expect(s.ducks).toHaveLength(4); // nobody removed
    expect(s.ducks.filter((d) => d.wounded)).toHaveLength(1);
    expect(events(s).some((e) => e.kind === 'wound')).toBe(true);
  });

  it('weights ducklings over adults as targets', () => {
    expect(P.TARGET_WEIGHTS.duckling).toBeGreaterThan(P.TARGET_WEIGHTS.adult);
  });
});

describe('the interactive owl — telegraphed strikes you can scare off (online)', () => {
  // The first staggered attack moment of an open window.
  const firstAttackAt = OWL.windowDurationSec / (OWL.attacksPerWindow + 1);

  it('online, an attack opens a SCAREABLE dive (a wind-up) instead of landing at once', () => {
    const s = flock(4);
    openWindow(s);
    runPredators(s, firstAttackAt, { mode: 'online', rng: always });
    // A dive is in flight, telegraphed — but nothing has landed yet.
    const strike = activeStrike(s);
    expect(strike).not.toBeNull();
    expect(strike!.predatorId).toBe('owl');
    expect(strike!.strike.windupRemaining).toBeCloseTo(P.STRIKE_WINDUP_SEC, 6);
    expect(events(s).some((e) => e.kind === 'winding')).toBe(true);
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
  });

  it('a dive left alone lands when its wind-up expires', () => {
    const s = flock(4);
    openWindow(s);
    runPredators(s, firstAttackAt, { mode: 'online', rng: always });
    const target = activeStrike(s)!.strike.targetId;
    runPredators(s, P.STRIKE_WINDUP_SEC + 0.1, { mode: 'online', rng: always });
    expect(activeStrike(s)).toBeNull(); // resolved + cleared
    expect(s.ducks.find((d) => d.id === target)!.wounded).toBe(true);
    expect(events(s).some((e) => e.kind === 'wound')).toBe(true);
  });

  it('SCARING the owl mid-dive foils the strike entirely (the active "be present" save)', () => {
    const s = flock(4);
    openWindow(s);
    // rng=always ⇒ this strike needs exactly 1 click (clicks weighting picks 1).
    runPredators(s, firstAttackAt, { mode: 'online', rng: always });
    const target = activeStrike(s)!.strike.targetId;
    expect(activeStrike(s)!.strike.clicksRequired).toBe(1);

    const res = scareOff(s, 'owl');
    expect(res).toEqual({ kind: 'foiled', duckId: target });
    expect(activeStrike(s)).toBeNull();
    expect(events(s).some((e) => e.kind === 'scared')).toBe(true);

    // Even with every roll set to land, the scared duck takes no wound.
    runPredators(s, P.STRIKE_WINDUP_SEC + 5, { mode: 'online', rng: always });
    expect(s.ducks.find((d) => d.id === target)!.wounded).not.toBe(true);
  });

  it('a multi-click strike FEINTS to a new spot, then foils on the final click', () => {
    const s = flock(4);
    // Construct a 2-click strike at spot 0 directly (deterministic, no rng roll).
    s.predators.owl.strike = {
      targetId: 'd0',
      windupRemaining: 1,
      windupTotal: P.STRIKE_WINDUP_SEC,
      id: 1,
      spot: 0,
      clicksRequired: 2,
      clicksLanded: 0,
    };

    // First click: a feint — the owl jukes to a different spot and re-arms.
    const r1 = scareOff(s, 'owl', () => 0);
    expect(r1).toEqual({ kind: 'feint', duckId: 'd0' });
    expect(activeStrike(s)).not.toBeNull();
    expect(s.predators.owl.strike!.spot).not.toBe(0); // relocated
    expect(s.predators.owl.strike!.windupRemaining).toBe(P.STRIKE_WINDUP_SEC); // fresh window
    expect(events(s).some((e) => e.kind === 'feint')).toBe(true);

    // Second (final) click: foiled.
    const r2 = scareOff(s, 'owl', () => 0);
    expect(r2).toEqual({ kind: 'foiled', duckId: 'd0' });
    expect(activeStrike(s)).toBeNull();
  });

  it('a target secured/treated DURING the dive slips away (the strike fizzles)', () => {
    const s = flock(4);
    s.resources.eggs = 1e6;
    buildSecureCoop(s);
    openWindow(s);
    runPredators(s, firstAttackAt, { mode: 'online', rng: always });
    const target = activeStrike(s)!.strike.targetId;
    // Secure the very duck being dived on, mid-wind-up.
    expect(setSecured(s, target, true).ok).toBe(true);
    runPredators(s, P.STRIKE_WINDUP_SEC + 0.1, { mode: 'online', rng: always });
    expect(s.ducks.find((d) => d.id === target)!.wounded).not.toBe(true);
  });

  it('scareOff is a no-op (returns null) when no dive is in flight', () => {
    const s = flock(4);
    expect(scareOff(s, 'owl')).toBeNull();
  });

  it('ACTIVE play drops the floor — an un-scared dive injures even with max defenses', () => {
    const s = flock(4);
    s.resources.eggs = 1e7;
    for (let i = 0; i < 5; i++) buildDeterrent(s); // max the floor
    expect(defenseFloor(s)).toBe(P.DEFENSE_FLOOR_CAP);
    openWindow(s);
    runPredators(s, firstAttackAt, { mode: 'online', rng: never, activeDefense: true });
    const target = activeStrike(s)!.strike.targetId;
    // rng=never would make any defensive roll MISS — but active mode bypasses it.
    runPredators(s, P.STRIKE_WINDUP_SEC + 0.1, { mode: 'online', rng: never, activeDefense: true });
    expect(s.ducks.find((d) => d.id === target)!.wounded).toBe(true); // the floor didn't save it
  });

  it('GUARD mode keeps the floor — the same un-scared dive can be blocked', () => {
    const s = flock(4);
    s.resources.eggs = 1e7;
    for (let i = 0; i < 5; i++) buildDeterrent(s);
    openWindow(s);
    runPredators(s, firstAttackAt, { mode: 'online', rng: never }); // guard (no activeDefense)
    runPredators(s, P.STRIKE_WINDUP_SEC + 0.1, { mode: 'online', rng: never });
    expect(s.ducks.every((d) => !d.wounded)).toBe(true); // floor + presence held
  });

  it('rank scales the scare: a shorter wind-up at high rank', () => {
    const lo = flock(4);
    lo.rank = P.INTRO_RANK; // difficulty 0
    const hi = flock(4);
    hi.rank = P.RANK_DIFF_TO; // difficulty 1
    expect(rankDifficulty(lo)).toBe(0);
    expect(rankDifficulty(hi)).toBe(1);
    expect(strikeWindupSec(lo)).toBeCloseTo(P.STRIKE_WINDUP_SEC, 6);
    expect(strikeWindupSec(hi)).toBeCloseTo(P.STRIKE_WINDUP_SEC * P.RANK_WINDUP_MIN_SCALE, 6);
    expect(strikeWindupSec(hi)).toBeLessThan(strikeWindupSec(lo));
  });

  it('offline catch-up never telegraphs — attacks resolve immediately (no scare possible)', () => {
    const s = flock(4);
    openWindow(s);
    runPredators(s, firstAttackAt, { mode: 'offline', rng: always });
    expect(activeStrike(s)).toBeNull();
    expect(s.ducks.filter((d) => d.wounded)).toHaveLength(1);
  });

  it('a stale in-flight dive does not survive a save round-trip (online-only feedback)', () => {
    const s = flock(4);
    openWindow(s);
    runPredators(s, firstAttackAt, { mode: 'online', rng: always });
    expect(activeStrike(s)).not.toBeNull();
    const restored = deserialize(serialize(s), 0);
    expect(activeStrike(restored)).toBeNull();
  });
});

describe('wound → escalation → admit to infirmary (the checkpoint)', () => {
  it('an untended, un-admitted wound escalates to a permanent loss after the window', () => {
    const s = flock(3);
    s.ducks[0].wounded = true;
    s.ducks[0].woundElapsed = 0;
    // Park the schedule so no NEW attacks confound the count.
    s.predators.owl.timeToNextWindow = 1e9;
    // The window is the base timer stretched/tightened by water access (Phase 4d).
    const escalateAt = P.WOUND_ESCALATE_SEC * waterWoundMult(s);
    runPredators(s, escalateAt + 1, { mode: 'online', rng: never });
    expect(s.ducks.find((d) => d.id === 'd0')).toBeUndefined();
    expect(events(s).some((e) => e.kind === 'escalated')).toBe(true);
  });

  it('admitting before the timer saves the duck — for free (no egg cost), holding a slot', () => {
    const s = flock(3);
    s.infirmaries = 1; // 1 infirmary = SLOTS_PER recovery slots
    s.resources.eggs = 1000;
    s.ducks[0].wounded = true;
    s.ducks[0].severity = 'minor';
    s.ducks[0].woundElapsed = P.WOUND_ESCALATE_SEC - 10;
    expect(admitToInfirmary(s, 'd0').ok).toBe(true);
    expect(s.ducks[0].recovering).toBe(true); // in a slot, no longer escalating
    expect(s.resources.eggs).toBe(1000); // admission is free
    s.predators.owl.timeToNextWindow = 1e9;
    runPredators(s, 100, { mode: 'online', rng: never }); // past the old deadline
    expect(s.ducks.find((d) => d.id === 'd0')).toBeDefined(); // admitted → safe
  });

  it('admitting with above-par water queues a pendingWoundSaved attribution beat', () => {
    const s = flock(3); // access = 6/3 = 2.0 → waterWoundMult = WOUND_TIMER_AT_DOUBLE (1.5, > 1)
    s.infirmaries = 1;
    s.ducks[0].wounded = true;
    s.ducks[0].severity = 'minor';
    s.ducks[0].woundElapsed = 100;
    const mult = waterWoundMult(s);
    expect(mult).toBeGreaterThan(1);
    const threshold = P.WOUND_ESCALATE_SEC * mult;
    expect(admitToInfirmary(s, 'd0').ok).toBe(true);
    expect(s.pendingWoundSaved).toHaveLength(1);
    const [e] = s.pendingWoundSaved!;
    expect(e.spareSec).toBeCloseTo(threshold - 100, 5);
    expect(e.boughtSec).toBeCloseTo(((threshold - 100) * (mult - 1)) / mult, 5);
    expect(e.boughtSec).toBeGreaterThan(0);
  });

  it('does NOT queue a wound-saved beat at/below par water (no pond bonus to credit)', () => {
    const s = flock(20); // access = 6/20 = 0.3 < 1 → a PENALTY mult, not a bonus
    s.infirmaries = 1;
    s.ducks[0].wounded = true;
    s.ducks[0].severity = 'minor';
    s.ducks[0].woundElapsed = 50;
    expect(waterWoundMult(s)).toBeLessThanOrEqual(1);
    admitToInfirmary(s, 'd0');
    expect(s.pendingWoundSaved ?? []).toHaveLength(0);
  });

  it('re-admitting an already-recovering duck (a no-op) never double-queues the beat', () => {
    const s = flock(3);
    s.infirmaries = 1;
    s.ducks[0].wounded = true;
    s.ducks[0].severity = 'minor';
    s.ducks[0].woundElapsed = 100;
    admitToInfirmary(s, 'd0');
    expect(s.pendingWoundSaved).toHaveLength(1);
    admitToInfirmary(s, 'd0'); // already recovering — early-return, no new event
    expect(s.pendingWoundSaved).toHaveLength(1);
  });

  it('a recovering duck heals and rejoins the flock after RECOVERY_SEC (water-scaled)', () => {
    const s = flock(3);
    s.infirmaries = 1;
    s.ducks[0].wounded = true;
    s.ducks[0].severity = 'minor';
    s.predators.owl.timeToNextWindow = 1e9;
    admitToInfirmary(s, 'd0');
    const recSec = P.INFIRMARY.RECOVERY_SEC.minor / waterWoundMult(s);
    runPredators(s, recSec + 1, { mode: 'online', rng: never });
    const d0 = s.ducks.find((d) => d.id === 'd0')!;
    expect(d0.wounded).toBe(false); // fully healed
    expect(d0.recovering).toBe(false); // slot freed
    expect(d0.severity).toBeUndefined();
  });

  it('rejects a missing duck and a healthy (unwounded) duck', () => {
    const s = flock(4);
    s.infirmaries = 1;
    expect(admitToInfirmary(s, 'nope').ok).toBe(false); // no such duck
    expect(admitToInfirmary(s, 'd0').ok).toBe(false); // d0 exists but isn't wounded
  });

  it('rollWoundSeverity: a defenses-down (caught) hit skews harsher; Hardy shrugs milder', () => {
    const flatD: Gene[] = ['D', 'D', 'D', 'D', 'D', 'D'];
    const fullH: Gene[] = ['H', 'H', 'H', 'H', 'H', 'H'];
    const critRate = (caught: boolean, genome: Gene[]) => {
      let crit = 0;
      for (let i = 0; i < 3000; i++) if (rollWoundSeverity(caught, genome, Math.random) === 'critical') crit++;
      return crit / 3000;
    };
    expect(critRate(true, flatD)).toBeGreaterThan(critRate(false, flatD)); // caught → worse
    expect(critRate(true, fullH)).toBeLessThan(critRate(true, flatD)); // Hardy → milder
  });

  it('is gated by SLOTS: with the infirmary full, a wound can’t be admitted (triage)', () => {
    const s = flock(6);
    s.infirmaries = 1; // SLOTS_PER slots
    const cap = P.INFIRMARY.SLOTS_PER;
    // Fill every slot.
    for (let i = 0; i < cap; i++) {
      s.ducks[i].wounded = true;
      expect(admitToInfirmary(s, s.ducks[i].id).ok).toBe(true);
    }
    // One more wound has nowhere to go.
    s.ducks[cap].wounded = true;
    const r = admitToInfirmary(s, s.ducks[cap].id);
    expect(r.ok).toBe(false); // infirmary full
    expect(s.ducks[cap].recovering).toBeFalsy(); // stays wounded, still escalating
  });
});

describe('secured ducks are excluded from targeting', () => {
  it('a fully-secured flock takes no wounds even under constant attacks', () => {
    const s = flock(4);
    s.resources.eggs = 1e6;
    buildSecureCoop(s);
    expect(secureCapacity(s)).toBe(P.SECURE_SLOTS_PER_COOP);
    for (const d of s.ducks) expect(setSecured(s, d.id, true).ok).toBe(true);
    openWindow(s);
    // Run the whole window with always-land rolls.
    for (let t = 0; t < OWL.windowDurationSec; t++) runPredators(s, 1, { mode: 'offline', rng: always });
    expect(s.ducks).toHaveLength(4);
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
  });

  it('securing is bounded by built slots', () => {
    const s = flock(8);
    s.resources.eggs = 1e6;
    buildSecureCoop(s); // SECURE_SLOTS_PER_COOP slots
    const results = s.ducks.map((d) => setSecured(s, d.id, true).ok);
    expect(results.filter(Boolean)).toHaveLength(P.SECURE_SLOTS_PER_COOP);
    expect(s.ducks.filter((d) => d.secured)).toHaveLength(P.SECURE_SLOTS_PER_COOP);
  });
});

describe('the brutality dial, when ON, can snatch outright', () => {
  it('a landed attack may skip the wound and permanently take a duck', () => {
    (BALANCE.PREDATORS as { ALLOW_INSTANT_SNATCH: boolean }).ALLOW_INSTANT_SNATCH = true;
    const s = flock(6);
    openWindow(s);
    // rng=0 => attack lands, snatch roll (0 < chance) succeeds.
    runPredators(s, OWL.windowDurationSec / (OWL.attacksPerWindow + 1), { mode: 'offline', rng: always });
    expect(events(s).some((e) => e.kind === 'snatched')).toBe(true);
    expect(s.ducks.length).toBeLessThan(6); // a duck is gone, no wound checkpoint
  });
});

describe('the wound output penalty flows through the per-duck egg chain', () => {
  it('a wounded hen lays at WOUND_OUTPUT_MULT of a healthy one', () => {
    const healthy = setHens(stockAll(fullSetup()), 1);
    healthy.resources.eggs = 0; // measure PRODUCED eggs, not the build stipend
    run(healthy, 60);
    const wounded = setHens(stockAll(fullSetup()), 1);
    wounded.resources.eggs = 0;
    wounded.ducks[0].wounded = true;
    run(wounded, 60);
    const ratio = wounded.resources.eggs / healthy.resources.eggs;
    expect(ratio).toBeCloseTo(P.WOUND_OUTPUT_MULT, 1);
  });
});

describe('THE GUARDRAIL: fully-defended + secured + present takes ZERO permanent losses', () => {
  it('over many windows online, no duck is wounded or lost', () => {
    const s = flock(4);
    s.resources.eggs = 1e7;
    // Max the floor and secure every duck.
    for (let i = 0; i < 5; i++) buildDeterrent(s);
    expect(defenseFloor(s)).toBe(P.DEFENSE_FLOOR_CAP);
    buildSecureCoop(s);
    for (const d of s.ducks) setSecured(s, d.id, true);
    // Worst case: every roll lands, for an hour of online time.
    for (let t = 0; t < 3600; t++) runPredators(s, 1, { mode: 'online', rng: always });
    expect(s.ducks).toHaveLength(4);
    expect(s.ducks.every((d) => !d.wounded && d.secured)).toBe(true);
  });
});

describe('save back-compat', () => {
  it('a pre-4c save loads with no predators in flight, no defenses, ungraced', () => {
    // A save shaped like Phase 4b: no predator/deterrent/secure fields at all.
    const legacy = JSON.stringify({
      version: 1,
      resources: { eggs: 500 },
      stations: [],
      rank: 8,
      ducks: [{ id: 'd0', genotype: ['Bl', 'bl'], vigor: 1, sex: 'hen', stage: 'adult', ageTicks: 0 }],
    });
    const s = deserialize(legacy, 0);
    expect(s.deterrents).toBe(0);
    expect(s.secureCoops).toBe(0);
    expect(s.predatorsIntroduced).toBe(false); // first-contact grace preserved
    expect(s.predators.owl).toBeDefined();
    expect(s.ducks[0].wounded).toBeUndefined();
    expect(s.ducks[0].secured).toBeUndefined();
  });

  it('predator/wound/defense state round-trips through serialize', () => {
    const s = flock(3);
    s.deterrents = 2;
    s.secureCoops = 1;
    s.ducks[0].wounded = true;
    s.ducks[0].woundElapsed = 42;
    s.ducks[1].secured = true;
    const r = deserialize(serialize(s), 0);
    expect(r.deterrents).toBe(2);
    expect(r.secureCoops).toBe(1);
    expect(r.ducks[0].wounded).toBe(true);
    expect(r.ducks[0].woundElapsed).toBe(42);
    expect(r.ducks[1].secured).toBe(true);
  });
});

describe('offline catch-up = exposure (built floor only, but never a wipe)', () => {
  it('secured breeders always survive an overnight; losses are capped, not a wipe', () => {
    const s = flock(20);
    s.resources.eggs = 1e6;
    s.rank = 5;
    // Secure 4 prize breeders; leave the rest exposed and under-defended.
    buildSecureCoop(s);
    const secured = s.ducks.slice(0, 4);
    for (const d of secured) setSecured(s, d.id, true);
    s.lastSeen = -8 * HOUR;

    const away = runOfflineCatchUp(s, 0);

    // Every secured breeder is still alive and unwounded.
    for (const d of secured) {
      const live = s.ducks.find((x) => x.id === d.id);
      expect(live).toBeDefined();
      expect(live!.wounded).not.toBe(true);
    }
    // Not a wipe: permanent losses are bounded by the mercy cap on the unsecured.
    const cap = Math.floor(16 * P.MAX_OFFLINE_LOSS_FRACTION);
    expect(away.predator?.lost ?? 0).toBeLessThanOrEqual(cap);
    expect(s.ducks.length).toBeGreaterThanOrEqual(20 - cap);
    // Exposure still bites: some toll registered (wounds and/or losses).
    expect((away.predator?.lost ?? 0) + (away.predator?.wounded ?? 0)).toBeGreaterThan(0);
  });

  it('offline grants no XP (the core law holds with predators present)', () => {
    const s = flock(8);
    s.rank = 5;
    s.xp = 10;
    s.lastSeen = -8 * HOUR;
    runOfflineCatchUp(s, 0);
    expect(s.rank).toBe(5);
    expect(s.xp).toBe(10);
  });

  it('away toll ignores a debuff that predates the trip (net-new only)', () => {
    const s = setHens(stockAll(fullSetup()), 2); // fed flock → no NEW debuffs accrue
    s.rank = 5;
    s.ducks[0].debuffed = true; // already limping when they left — reported live then
    s.lastSeen = -1 * HOUR;
    const away = runOfflineCatchUp(s, 0);
    expect(away.debuffed).toBeUndefined(); // not re-reported as a "while away" toll
  });
});

describe('guard-idle wound care (tab open, player away)', () => {
  const mkWounded = () => {
    const s = flock(4);
    s.rank = 1; // no windows — only the wound clock
    buildInfirmary(s);
    const d = s.ducks[0];
    d.wounded = true;
    d.woundSource = 'predator';
    d.severity = 'minor';
    d.woundElapsed = 5;
    return { s, d };
  };

  it('GUARDED (online, active lapsed): the infirmary auto-admits — same as offline', () => {
    const { s, d } = mkWounded();
    runPredators(s, 1, { mode: 'online', rng: never, activeDefense: false });
    expect(d.recovering).toBe(true);
  });

  it('ACTIVE (player demonstrably here): triage stays manual', () => {
    const { s, d } = mkWounded();
    runPredators(s, 1, { mode: 'online', rng: never, activeDefense: true });
    expect(d.recovering).toBeFalsy();
  });

  it('guard overflow still escalates — the exposure matches a night away', () => {
    const { s } = mkWounded();
    // Fill every slot, then wound one more past its timer.
    for (const d of s.ducks) {
      d.wounded = true;
      d.severity = 'minor';
      d.recovering = true;
    }
    const extra = s.ducks[1];
    extra.recovering = false;
    extra.woundElapsed = BALANCE.PREDATORS.WOUND_ESCALATE_SEC * 2;
    runPredators(s, 1, { mode: 'online', rng: never, activeDefense: false });
    expect(s.ducks).not.toContain(extra);
  });
});

describe('strike outcomes all SPEAK (repelled + shrugged events — pure feedback)', () => {
  const openStrike = (s: GameState) => {
    s.rank = BALANCE.PREDATORS.INTRO_RANK;
    s.predatorsIntroduced = true;
    s.predatorsSeen = ['owl'];
    s.predators.owl = { timeToNextWindow: 0, windowRemaining: 60, windowElapsed: 0, attacksFired: 0 };
  };

  it('a guard-mode miss against the floor emits repelled', () => {
    const s = flock(6);
    openStrike(s);
    for (let i = 0; i < 5; i++) buildDeterrent(s); // a real floor to hold the line
    s.resources.eggs = 1e9;
    // Drive to a committed dive, then let it expire in GUARD with rng that FAILS
    // the attack roll (rng 0.99 ≥ any success chance) — formerly silent.
    let calls = 0;
    const rig = () => (calls++ === 0 ? 0.0 : 0.99); // first roll commits scheduling paths deterministically-ish
    runPredators(s, 30, { mode: 'online', rng: rig, activeDefense: false });
    runPredators(s, 30, { mode: 'online', rng: () => 0.99, activeDefense: false });
    const kinds = events(s).map((e) => e.kind);
    expect(kinds).toContain('repelled');
    expect(s.ducks.some((d) => d.wounded)).toBe(false);
  });

  it('a Hardy shrug emits shrugged (with the duck’s name riding along)', () => {
    const s = flock(6);
    openStrike(s);
    s.ducks.forEach((d) => {
      d.genome = ['H', 'H', 'H', 'H', 'H', 'H'];
      d.name = 'Tank';
    });
    // rng 0.1: attack roll SUCCEEDS (0.1 < 0.45), resist roll SUCCEEDS (0.1 < 0.6 cap).
    runPredators(s, 45, { mode: 'offline', rng: () => 0.1, lossBudget: { remaining: 10 } });
    const shrug = events(s).find((e) => e.kind === 'shrugged');
    expect(shrug).toBeDefined();
    expect(shrug && 'duckName' in shrug ? shrug.duckName : undefined).toBe('Tank');
    expect(s.ducks.some((d) => d.wounded)).toBe(false);
  });
});

describe('defense COVERAGE: the floor stretches thin as the flock outgrows the netting', () => {
  const N = BALANCE.PREDATORS.DUCKS_COVERED_PER_UNIT;

  it('full floor while covered; proportional degradation past coverage; more nets restore', () => {
    const s = flock(6); // small — one net covers everyone
    buildDeterrent(s);
    s.resources.eggs = 1e9;
    const full = defenseFloor(s);
    expect(defenseCoverage(s)).toBe(1);
    // Outgrow one net's coverage 2:1 → the floor halves.
    while (s.ducks.length < N * 2) s.ducks.push({ ...s.ducks[0], id: `x${s.ducks.length}` });
    expect(defenseCoverage(s)).toBeCloseTo(0.5, 6);
    expect(defenseFloor(s)).toBeCloseTo(full * 0.5, 6);
    // A second net restores full coverage (and its own floor contribution).
    buildDeterrent(s);
    expect(defenseCoverage(s)).toBe(1);
    expect(defenseFloor(s)).toBeGreaterThan(full);
  });

  it('securing and wintering REDUCE exposure (the vault is a coverage lever)', () => {
    const s = flock(6);
    buildDeterrent(s);
    while (s.ducks.length < N + 5) s.ducks.push({ ...s.ducks[0], id: `x${s.ducks.length}` });
    expect(defenseCoverage(s)).toBeLessThan(1);
    for (let i = 0; i < 3; i++) s.ducks[i].secured = true;
    s.ducks[3].site = 'winter';
    s.ducks[4].site = 'winter';
    expect(exposedFlock(s)).toBe(N);
    expect(defenseCoverage(s)).toBe(1); // back under the netting
  });

  it('the cap still binds: coverage never pushes the floor past DEFENSE_FLOOR_CAP', () => {
    const s = flock(4);
    s.resources.eggs = 1e9;
    for (let i = 0; i < 10; i++) buildDeterrent(s); // way past the cap count
    expect(defenseFloor(s)).toBeCloseTo(BALANCE.PREDATORS.DEFENSE_FLOOR_CAP, 6);
  });
});
