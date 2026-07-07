import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { GameEngine } from '../src/game/engine';
import { generateOffer } from '../src/game/contracts';
import { initialState, type GameState } from '../src/game/state';
import { deserialize, serialize } from '../src/game/save';
import { guardRateMult, tick } from '../src/game/tick';
import { waterWoundMult } from '../src/game/water';
import { build } from './helpers';

// The idle-playstyle rework (2026-07-07): the de facto playstyle is a browser
// left open with the tab drifting between guard and hidden. These tests cover
// the two production-side pieces — the guard rate ease and the paused
// provision clock — plus the hidden-tab catch-up and the guard→active wound
// grace at the engine boundary. (The predator-side pieces — event-clock
// freezes, brink-hold, wound-only wear — live in predators.test.ts.)

const G = BALANCE.GUARD_RATE;
const FLOOR = BALANCE.OFFLINE_RATE_MULT;

describe('guardRateMult: full rate through the grace, easing to the offline floor', () => {
  const at = (guardElapsed: number): number => {
    const s = initialState(0);
    s.guardElapsed = guardElapsed;
    return guardRateMult(s);
  };

  it('is 1 while active/fresh-guard and through the whole grace window', () => {
    expect(at(0)).toBe(1);
    expect(at(G.GRACE_S)).toBe(1);
  });

  it('eases linearly: halfway through EASE_S sits halfway to the floor', () => {
    expect(at(G.GRACE_S + G.EASE_S / 2)).toBeCloseTo(1 + (FLOOR - 1) / 2, 6);
  });

  it('bottoms out at OFFLINE_RATE_MULT and stays there', () => {
    expect(at(G.GRACE_S + G.EASE_S)).toBeCloseTo(FLOOR, 6);
    expect(at(G.GRACE_S + G.EASE_S + 100_000)).toBeCloseTo(FLOOR, 6);
  });
});

describe('tick × guard ease: a parked tab converges on the offline rate', () => {
  /** Corn gained over `seconds` of online guard starting at `guardElapsed`. */
  function gain(guardElapsed: number, seconds: number): number {
    const s = build({ plot: 3 });
    s.guardElapsed = guardElapsed;
    const before = s.resources.corn;
    for (let i = 0; i < seconds * 10; i++) tick(s, 0.1, { mode: 'online', autoHaul: true });
    return s.resources.corn - before;
  }

  it('short guard (inside the grace) produces at the full 1× rate', () => {
    expect(gain(G.GRACE_S - 120, 60)).toBe(gain(0, 60));
  });

  it('deep guard produces at exactly the offline mult', () => {
    // 100s keeps totals well under the Feed Store cap (500) so the ratio is pure rate.
    const fresh = gain(0, 100);
    const parked = gain(G.GRACE_S + G.EASE_S, 100);
    expect(parked / fresh).toBeCloseTo(FLOOR, 2);
  });

  it('any interaction snaps production straight back to 1× (guardElapsed resets)', () => {
    const s = build({ plot: 3 });
    s.guardElapsed = G.GRACE_S + G.EASE_S; // fully eased
    s.activeRemaining = BALANCE.PREDATORS.ACTIVE_WINDOW_S; // markActive fired
    const before = s.resources.corn;
    for (let i = 0; i < 600; i++) tick(s, 0.1, { mode: 'online', autoHaul: true });
    expect(s.guardElapsed).toBe(0);
    expect(s.resources.corn - before).toBe(gain(0, 60));
  });

  it('offline mode is untouched by the guard clock (flat OFFLINE_RATE_MULT)', () => {
    const a = build({ plot: 3 });
    const b = build({ plot: 3 });
    b.guardElapsed = 123456;
    for (let i = 0; i < 60; i++) {
      tick(a, 1, { mode: 'offline', autoHaul: true });
      tick(b, 1, { mode: 'offline', autoHaul: true });
    }
    expect(a.resources.corn).toBe(b.resources.corn);
  });
});

describe('provision deadline pauses at guard (clocks only run while you are there)', () => {
  function withProvision(): GameState {
    const s = initialState(0);
    s.legacyTier = BALANCE.CONTRACTS.UNLOCK_TIER;
    s.contracts.active = {
      id: 'ct1',
      type: 'provision',
      notch: 0,
      reward: { dust: 10, shards: 2 },
      completed: false,
      ingredient: 'corn',
      amount: 15,
      limitRemaining: 60,
    };
    return s;
  }

  it('ticks down while ACTIVE, and expires with the toast flag', () => {
    const s = withProvision();
    s.activeRemaining = 1e9; // stays active for the whole run
    for (let i = 0; i < 59; i++) tick(s, 1, { mode: 'online', autoHaul: false });
    expect(s.contracts.active).not.toBeNull();
    for (let i = 0; i < 5; i++) tick(s, 1, { mode: 'online', autoHaul: false });
    expect(s.contracts.active).toBeNull();
    expect(s.pendingContractExpired).toBe(1);
  });

  it('FREEZES at guard — an accepted order never expires behind an unwatched tab', () => {
    const s = withProvision();
    for (let i = 0; i < 600; i++) tick(s, 1, { mode: 'online', autoHaul: false }); // 10 idle minutes
    expect(s.contracts.active).not.toBeNull();
    expect(s.contracts.active!.limitRemaining).toBe(60); // untouched
  });

  it('the offer board still rotates at guard (upkeep, not a deadline)', () => {
    const s = withProvision();
    s.contracts.offers = [generateOffer(s, () => 0.5)];
    s.contracts.refreshRemaining = 30;
    for (let i = 0; i < 60; i++) tick(s, 1, { mode: 'online', autoHaul: false });
    expect(s.contracts.refreshRemaining).toBeGreaterThan(30); // rolled over → re-armed
    expect(s.contracts.offers).toHaveLength(BALANCE.CONTRACTS.OFFER_SLOTS);
  });
});

describe('GameEngine.resumeFromHidden: hidden time IS offline time', () => {
  it('credits a real gap through offline catch-up and surfaces the Away summary', () => {
    const eng = new GameEngine(0);
    eng.reset(); // a clean fresh game regardless of any save the env carries
    eng.state.lastSeen = 0;
    const cornBefore = eng.state.resources.corn;
    eng.resumeFromHidden(3600_000); // the tab was dark for an hour
    expect(eng.state.resources.corn).toBeGreaterThan(cornBefore); // the plot ran at 0.4×
    expect(eng.state.lastSeen).toBe(3600_000);
    expect(eng.away).not.toBeNull(); // the "While you were away" beat fires mid-session
    // Returning to the tab IS being present — same as the page-load path.
    expect(eng.state.activeRemaining).toBe(BALANCE.PREDATORS.ACTIVE_WINDOW_S);
  });

  it('no-ops for blips under VISIBILITY_CATCHUP_MIN_S (quick tab flips cost nothing)', () => {
    const eng = new GameEngine(0);
    eng.reset();
    eng.state.lastSeen = 0;
    eng.away = null;
    const before = eng.state.resources.corn;
    eng.resumeFromHidden(BALANCE.VISIBILITY_CATCHUP_MIN_S * 1000 - 1000);
    expect(eng.state.resources.corn).toBe(before);
    expect(eng.state.lastSeen).toBe(0); // untouched — no catch-up ran
    expect(eng.away).toBeNull();
  });
});

describe('GameEngine.markActive: the guard→active edge grants brink-held wounds triage time', () => {
  it('rewinds un-admitted wounds to the return grace on the edge only', () => {
    const eng = new GameEngine(0);
    eng.reset();
    const d = eng.state.ducks[0];
    d.wounded = true;
    d.severity = 'minor';
    d.woundElapsed = 1e9; // brink-held far past the threshold (guard overflow)
    eng.state.activeRemaining = 0; // at guard
    eng.markActive();
    const threshold = BALANCE.PREDATORS.WOUND_ESCALATE_SEC * waterWoundMult(eng.state);
    expect(d.woundElapsed).toBe(
      Math.max(0, threshold - BALANCE.PREDATORS.OFFLINE_RETURN_WOUND_GRACE_S),
    );
    expect(eng.state.activeRemaining).toBe(BALANCE.PREDATORS.ACTIVE_WINDOW_S);
    // Already active: markActive refreshes the window but never rewinds again.
    d.woundElapsed = 12345;
    eng.markActive();
    expect(d.woundElapsed).toBe(12345);
  });
});

describe('persistence: the guard clock never survives a reload', () => {
  it('deserialize resets guardElapsed (the away gap was already offline-rated)', () => {
    const s = initialState(0);
    s.guardElapsed = 5000;
    expect(deserialize(serialize(s), 0).guardElapsed).toBe(0);
  });
});
