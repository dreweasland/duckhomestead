import { describe, it, expect, afterEach } from 'vitest';
import { BALANCE, PREDATOR_DEFS, predatorDef } from '../src/config/balance';
import {
  initialState,
  defenseFloor,
  secureCapacity,
  type Duck,
  type GameState,
  type Genotype,
} from '../src/game/state';
import {
  runPredators,
  attackChance,
  predatorsActive,
  incoming,
  windowOpen,
} from '../src/game/predators';
import {
  buildDeterrent,
  buildSecureCoop,
  repairDeterrents,
  setSecured,
  treatDuck,
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
    vigor: 1,
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

describe('predator config is generic (owl is data, not hardcoded)', () => {
  it('the owl is the first PREDATOR_DEF and carries the OWL balance numbers', () => {
    expect(PREDATOR_DEFS[0].id).toBe('owl');
    expect(PREDATOR_DEFS[0].baseAttackChance).toBe(P.OWL.baseAttackChance);
    expect(PREDATOR_DEFS[0].windowEverySec).toBe(P.OWL.windowEverySec);
  });

  it('ships exactly one predator this phase (more are later config)', () => {
    expect(PREDATOR_DEFS).toHaveLength(1);
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

describe('wound → escalation → treat (the checkpoint)', () => {
  it('an untended wound escalates to a permanent loss after WOUND_ESCALATE_SEC', () => {
    const s = flock(3);
    s.ducks[0].wounded = true;
    s.ducks[0].woundElapsed = 0;
    // Park the schedule so no NEW attacks confound the count.
    s.predators.owl.timeToNextWindow = 1e9;
    runPredators(s, P.WOUND_ESCALATE_SEC + 1, { mode: 'online', rng: never });
    expect(s.ducks.find((d) => d.id === 'd0')).toBeUndefined();
    expect(events(s).some((e) => e.kind === 'escalated')).toBe(true);
  });

  it('treating a wound before the timer saves the duck', () => {
    const s = flock(3);
    s.resources.eggs = 1000;
    s.ducks[0].wounded = true;
    s.ducks[0].woundElapsed = P.WOUND_ESCALATE_SEC - 10;
    expect(treatDuck(s, 'd0').ok).toBe(true);
    expect(s.ducks[0].wounded).toBe(false);
    s.predators.owl.timeToNextWindow = 1e9;
    runPredators(s, 100, { mode: 'online', rng: never });
    expect(s.ducks.find((d) => d.id === 'd0')).toBeDefined(); // treated -> safe
    expect(s.resources.eggs).toBe(1000 - P.TREAT_COST_EGGS);
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
});
