import { BALANCE, PREDATOR_DEFS, type PredatorDef } from '../config/balance';
import {
  defenseFloor,
  type Duck,
  type GameState,
  type PredatorEvent,
  type PredatorState,
} from './state';

const P = BALANCE.PREDATORS;

/**
 * predators.ts — Phase 4c risk layer.
 *
 * The locked principle (do not break in code): EVERY permanent loss must trace
 * to a CHOICE — absence, under-defense, or a neglected wound — never a bolt
 * from the blue. Concretely that means:
 *   - Danger only ever arrives in TELEGRAPHED windows (a warning fires before
 *     each window opens). No silent, unwarned kills.
 *   - A landed attack almost always WOUNDS (soft): reduced output + can't breed.
 *     A wound escalates to a permanent loss ONLY if left untended past
 *     WOUND_ESCALATE_SEC. The active Treat action is the save.
 *   - Built deterrents set a passive protection FLOOR (works offline). Being
 *     PRESENT (online) during an open window adds active cover. SECURED ducks
 *     are excluded from targeting entirely (the breeder-protection lever).
 *   - Offline catch-up resolves the windows that passed with the built floor
 *     only (no presence), and an offline mercy rail caps permanent losses so a
 *     defended/secured overnight is soft losses, not a wipe.
 *
 * This module is data-driven over PREDATOR_DEFS: the owl is the first instance,
 * "owl" never appears here. Adding a fox/hawk is a new def, not new code.
 */

export type SimPresence = 'online' | 'offline';

export interface PredatorOpts {
  /** Presence: 'online' applies the active-cover PRESENCE_FACTOR; 'offline'
   *  (catch-up) resolves with the built floor only. */
  mode: SimPresence;
  /** Injectable RNG for deterministic tests. Defaults to Math.random. */
  rng?: () => number;
  /** Offline mercy rail: a mutable budget of permanent losses this catch-up may
   *  still take. When present (offline) and exhausted, escalating wounds are
   *  held at the brink instead of killing. Absent online (uncapped — the player
   *  is here and every loss is attributable to ignoring a visible wound). */
  lossBudget?: { remaining: number };
}

/** Predators stay dormant until the player has a flock AND reaches the intro
 *  rank — the risk layer never ambushes a brand-new homestead. */
export function predatorsActive(state: GameState): boolean {
  return state.ducks.length > 0 && state.rank >= P.INTRO_RANK;
}

/** True while the named predator's window is currently open. */
export function windowOpen(ps: PredatorState): boolean {
  return ps.windowRemaining > 0;
}

/** True while the telegraph should show: a window is incoming within the lead. */
export function incoming(ps: PredatorState, def: PredatorDef): boolean {
  return !windowOpen(ps) && ps.timeToNextWindow <= def.warningLeadSec;
}

/**
 * Per-attack success chance, fully transparent for the UI/tests:
 *   success = baseChance × (1 − defenseFloor) × (1 − presenceFactor)
 * `present` adds the active-cover term (online only).
 */
export function attackChance(state: GameState, def: PredatorDef, present: boolean): number {
  const presence = present ? P.PRESENCE_FACTOR : 0;
  return def.baseAttackChance * (1 - defenseFloor(state)) * (1 - presence);
}

/** The most urgent predator state for the UI telegraph: an open window outranks
 *  an incoming one; among equals, the soonest. Null when all is calm. Pure read
 *  off GameState (the UI never simulates). */
export interface Threat {
  def: PredatorDef;
  phase: 'open' | 'incoming';
  /** Seconds left in the open window, or seconds until the incoming one opens. */
  seconds: number;
}
export function currentThreat(state: GameState): Threat | null {
  if (!predatorsActive(state)) return null;
  let best: Threat | null = null;
  for (const def of PREDATOR_DEFS) {
    const ps = state.predators[def.id];
    if (!ps) continue;
    let t: Threat | null = null;
    if (windowOpen(ps)) t = { def, phase: 'open', seconds: ps.windowRemaining };
    else if (incoming(ps, def)) t = { def, phase: 'incoming', seconds: ps.timeToNextWindow };
    if (!t) continue;
    if (!best) {
      best = t;
    } else if (t.phase === 'open' && best.phase === 'incoming') {
      best = t;
    } else if (t.phase === best.phase && t.seconds < best.seconds) {
      best = t;
    }
  }
  return best;
}

/** Ducks that may be targeted by a fresh attack: not secured, not already
 *  wounded. Secured ducks are excluded entirely; an already-wounded duck's
 *  danger is escalation (governed by Treat), not a second wound. */
function eligibleTargets(state: GameState): Duck[] {
  return state.ducks.filter((d) => !d.secured && !d.wounded);
}

function targetWeight(d: Duck): number {
  return P.TARGET_WEIGHTS[d.stage === 'duckling' ? 'duckling' : 'adult'] ?? 1;
}

/** Weighted target pick (ducklings the most exposed). Undefined if none eligible. */
function pickTarget(state: GameState, rng: () => number): Duck | undefined {
  const pool = eligibleTargets(state);
  if (pool.length === 0) return undefined;
  const total = pool.reduce((a, d) => a + targetWeight(d), 0);
  let r = rng() * total;
  for (const d of pool) {
    r -= targetWeight(d);
    if (r < 0) return d;
  }
  return pool[pool.length - 1];
}

/** Remove a duck from the flock and drop any breeding pair it belonged to. */
function removeDuck(state: GameState, duckId: string): void {
  state.ducks = state.ducks.filter((d) => d.id !== duckId);
  state.breedingPairs = state.breedingPairs.filter(
    (p) => p.drakeId !== duckId && p.henId !== duckId,
  );
}

/** Whether a permanent removal is allowed right now. Online: always (the loss is
 *  attributable to a visible, ignored wound). Offline: only while the mercy
 *  budget holds — past it, escalating wounds are held at the brink. */
function permitPermanentLoss(opts: PredatorOpts): boolean {
  if (opts.mode === 'online' || !opts.lossBudget) return true;
  if (opts.lossBudget.remaining > 0) {
    opts.lossBudget.remaining -= 1;
    return true;
  }
  return false;
}

function emit(state: GameState, e: PredatorEvent): void {
  (state.pendingPredatorEvents ??= []).push(e);
}

/** Resolve one attack attempt for a predator during its open window. */
function resolveAttack(state: GameState, def: PredatorDef, opts: PredatorOpts, rng: () => number): void {
  const success = attackChance(state, def, opts.mode === 'online');
  if (rng() >= success) return; // attack missed (defenses/presence held)

  const target = pickTarget(state, rng);
  if (!target) return; // nothing exposed (all secured / none eligible) — no effect

  // Brutality dial: a rare landed attack may skip the wound and take the duck
  // outright. Default OFF — every death otherwise passes through a wound.
  if (P.ALLOW_INSTANT_SNATCH && rng() < P.INSTANT_SNATCH_CHANCE && permitPermanentLoss(opts)) {
    emit(state, { kind: 'snatched', predatorId: def.id, duckId: target.id });
    removeDuck(state, target.id);
    return;
  }

  target.wounded = true;
  target.woundElapsed = 0;
  emit(state, { kind: 'wound', predatorId: def.id, duckId: target.id });
}

/** Advance one predator's window machine by raw `dt` seconds and resolve any
 *  attacks whose moment falls in this step. Windows are wall-clock danger, so
 *  `dt` is REAL seconds (never the offline rate-scaled step). */
function advancePredator(state: GameState, def: PredatorDef, opts: PredatorOpts, dt: number, rng: () => number): void {
  const ps = (state.predators[def.id] ??= {
    timeToNextWindow: def.windowEverySec,
    windowRemaining: 0,
    windowElapsed: 0,
    attacksFired: 0,
  });

  if (windowOpen(ps)) {
    ps.windowRemaining = Math.max(0, ps.windowRemaining - dt);
    ps.windowElapsed += dt;
    // Attacks are staggered across the window so a player who reacts to the
    // telegraph (secure / be present) is covered before they land.
    const n = def.attacksPerWindow;
    while (ps.attacksFired < n && ps.windowElapsed >= ((ps.attacksFired + 1) * def.windowDurationSec) / (n + 1)) {
      ps.attacksFired += 1;
      resolveAttack(state, def, opts, rng);
    }
    if (ps.windowRemaining <= 0) {
      // Window closed — schedule the next interval.
      ps.windowElapsed = 0;
      ps.attacksFired = 0;
      ps.timeToNextWindow = def.windowEverySec;
    }
    return;
  }

  // Window closed: count down to the next one, firing the telegraph as it nears.
  const wasAboveLead = ps.timeToNextWindow > def.warningLeadSec;
  ps.timeToNextWindow = Math.max(0, ps.timeToNextWindow - dt);
  if (wasAboveLead && ps.timeToNextWindow <= def.warningLeadSec && ps.timeToNextWindow > 0) {
    emit(state, { kind: 'incoming', predatorId: def.id });
  }
  if (ps.timeToNextWindow <= 0) {
    ps.windowRemaining = def.windowDurationSec;
    ps.windowElapsed = 0;
    ps.attacksFired = 0;
    emit(state, { kind: 'open', predatorId: def.id });
  }
}

/** Age every wound by raw `dt`; escalate any that pass the recovery window into
 *  a permanent loss (subject to the offline mercy rail). Runs online & offline. */
function escalateWounds(state: GameState, dt: number, opts: PredatorOpts): void {
  for (const d of [...state.ducks]) {
    if (!d.wounded) continue;
    d.woundElapsed = (d.woundElapsed ?? 0) + dt;
    if (d.woundElapsed < P.WOUND_ESCALATE_SEC) continue;
    if (permitPermanentLoss(opts)) {
      emit(state, { kind: 'escalated', duckId: d.id });
      removeDuck(state, d.id);
    } else {
      // Mercy rail (offline budget spent): hold at the brink. The player returns
      // to a wounded duck to TREAT, not a corpse.
      d.woundElapsed = P.WOUND_ESCALATE_SEC;
    }
  }
}

/**
 * Advance the whole predator layer by raw `dt` seconds (wall-clock — pass the
 * real step, not the offline rate-scaled one). Schedules/telegraphs windows,
 * resolves attacks, and ages/escalates wounds. Mutates state; pushes UI events
 * to state.pendingPredatorEvents. Never grants XP (offline-safe).
 */
export function runPredators(state: GameState, dt: number, opts: PredatorOpts): void {
  const rng = opts.rng ?? Math.random;

  if (predatorsActive(state)) {
    // First-contact grace: predators may ONLY debut while the player is present
    // (online). If they would first activate during an absence (offline catch-up
    // — e.g. a returning player's first 4c load), hold them entirely so nobody
    // is exposed before they ever saw the threat. Introduction resets the
    // schedule so the first window is a full, telegraphed interval away.
    if (!state.predatorsIntroduced) {
      if (opts.mode === 'offline') {
        escalateWounds(state, dt, opts);
        return;
      }
      state.predatorsIntroduced = true;
      for (const def of PREDATOR_DEFS) {
        state.predators[def.id] = {
          timeToNextWindow: def.windowEverySec,
          windowRemaining: 0,
          windowElapsed: 0,
          attacksFired: 0,
        };
      }
      emit(state, { kind: 'introduced' });
    }
    for (const def of PREDATOR_DEFS) advancePredator(state, def, opts, dt, rng);
  }
  // Wounds always age/escalate — even if predators went dormant, an existing
  // wound still needs treating or it's lost. (Attributable: it was visible.)
  escalateWounds(state, dt, opts);
}
