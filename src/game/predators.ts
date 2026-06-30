import { BALANCE, PREDATOR_DEFS, type PredatorDef } from '../config/balance';
import {
  defenseFloor,
  type Duck,
  type GameState,
  type PredatorEvent,
  type PredatorState,
} from './state';
import { woundResistChance } from './genetics';
import { waterWoundMult } from './water';

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
  /** ACTIVE play (online + recently interacting): the passive floor + presence are
   *  suppressed, so a committed dive the player doesn't scare lands an injury — the
   *  scare is the only defense. Guard/offline keep the built-defense roll. */
  activeDefense?: boolean;
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

/** Weather the deterrent floor (no-op without deterrents). Clamped at 0; only the
 *  Repair action brings it back up. */
function wearDeterrents(state: GameState, amount: number): void {
  if (state.deterrents <= 0) return;
  state.deterrentIntegrity = Math.max(0, state.deterrentIntegrity - amount);
}

/** Land a hit that got past the floor onto a specific (already-chosen) target:
 *  a snatch (brutality dial), a shrugged-off resist, or a soft wound. Shared by
 *  offline immediate attacks and online telegraphed strikes. */
function landHit(state: GameState, def: PredatorDef, opts: PredatorOpts, target: Duck, rng: () => number): void {
  // Brutality dial: a rare landed attack may skip the wound and take the duck
  // outright. Default OFF — every death otherwise passes through a wound.
  if (P.ALLOW_INSTANT_SNATCH && rng() < P.INSTANT_SNATCH_CHANCE && permitPermanentLoss(opts)) {
    emit(state, { kind: 'snatched', predatorId: def.id, duckId: target.id });
    removeDuck(state, target.id);
    return;
  }

  // Resilience: a Hardy (H-gene) duck has a chance to shrug off the wound
  // entirely. Throughput-only — it can't reduce a requirement, just survive a hit.
  if (rng() < woundResistChance(target.genome)) return;

  target.wounded = true;
  target.woundSource = 'predator';
  target.woundElapsed = 0;
  emit(state, { kind: 'wound', predatorId: def.id, duckId: target.id });
}

/** Resolve one attack attempt immediately (offline catch-up): roll against the
 *  built floor, pick a target, land the hit. No telegraph — the player isn't
 *  here to react, so the dive is the resolution. */
function resolveAttack(state: GameState, def: PredatorDef, opts: PredatorOpts, rng: () => number): void {
  const success = attackChance(state, def, opts.mode === 'online');
  if (rng() >= success) return; // attack missed (defenses/presence held)

  // A breach — the attack got past the floor — tears the netting extra.
  wearDeterrents(state, P.DETERRENT_WEAR_PER_HIT);

  const target = pickTarget(state, rng);
  if (!target) return; // nothing exposed (all secured / none eligible) — no effect
  landHit(state, def, opts, target, rng);
}

/** Scare difficulty 0..1 from homestead rank: 0 at the intro rank, 1 at RANK_DIFF_TO.
 *  Drives faster dives + more multi-click feints as the homestead climbs. */
export function rankDifficulty(state: GameState): number {
  const span = P.RANK_DIFF_TO - P.INTRO_RANK;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (state.rank - P.INTRO_RANK) / span));
}

/** Dive wind-up (reaction window) in seconds, shrinking with rank difficulty. */
export function strikeWindupSec(state: GameState): number {
  const d = rankDifficulty(state);
  return P.STRIKE_WINDUP_SEC * (1 + (P.RANK_WINDUP_MIN_SCALE - 1) * d);
}

/** Weighted pick of how many scare clicks a strike needs (1..3), interpolating the
 *  distribution from the easy default toward the hard one as rank climbs. */
function pickClicksRequired(state: GameState, rng: () => number): number {
  const d = rankDifficulty(state);
  const easy = P.STRIKE_CLICK_WEIGHTS;
  const hard = P.STRIKE_CLICK_WEIGHTS_HARD;
  const w = easy.map((e, i) => e + ((hard[i] ?? e) - e) * d);
  const total = w.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r < 0) return i + 1;
  }
  return 1;
}

/** A random dive spot index in [0, STRIKE_DIVE_SPOTS), optionally excluding the
 *  current one (so a feint always visibly relocates). */
function pickSpot(rng: () => number, exclude = -1): number {
  const n = P.STRIKE_DIVE_SPOTS;
  if (n <= 1) return 0;
  if (exclude < 0) return Math.floor(rng() * n);
  let s = Math.floor(rng() * (n - 1));
  if (s >= exclude) s += 1; // skip the excluded index
  return s;
}

/** Commit a telegraphed strike (online): pick a target NOW and open a visible
 *  wind-up dive at a random spot. Nothing lands yet — the player gets
 *  STRIKE_WINDUP_SEC to scare the owl off, and the strike may need up to 3 clicks
 *  (each non-final one jukes it to another spot). The roll happens only when a
 *  wind-up expires un-foiled (resolveStrike). */
function beginStrike(state: GameState, def: PredatorDef, ps: PredatorState, rng: () => number): void {
  if (ps.strike) return; // a dive is already in flight — don't stack
  const target = pickTarget(state, rng);
  if (!target) return; // nothing exposed — no dive
  const id = (state.predatorStrikeSeq = (state.predatorStrikeSeq ?? 0) + 1);
  const windup = strikeWindupSec(state);
  ps.strike = {
    targetId: target.id,
    windupRemaining: windup,
    windupTotal: windup,
    id,
    spot: pickSpot(rng),
    clicksRequired: pickClicksRequired(state, rng),
    clicksLanded: 0,
  };
  emit(state, { kind: 'winding', predatorId: def.id, duckId: target.id });
}

/** A telegraphed strike's wind-up expired without a scare — resolve it now. Rolls
 *  against the built floor + passive presence (you were online, just didn't
 *  react), then lands on the original target if it's still exposed. The target
 *  may have been secured/treated/lost during the dive, in which case it slips
 *  away harmlessly — re-validate before biting. */
function resolveStrike(state: GameState, def: PredatorDef, opts: PredatorOpts, ps: PredatorState, rng: () => number): void {
  const strike = ps.strike;
  if (!strike) return;
  const target = state.ducks.find((d) => d.id === strike.targetId && !d.secured && !d.wounded);
  if (!target) return; // slipped away (secured/treated/gone) — the dive misses

  if (opts.activeDefense) {
    // ACTIVE: the player is here, so the built floor + presence are off — an
    // un-scared committed dive lands. The scare was the only defense.
    wearDeterrents(state, P.DETERRENT_WEAR_PER_HIT);
    landHit(state, def, opts, target, rng);
    return;
  }

  // GUARD (online idle): the built floor + passive presence get a roll to hold.
  const success = attackChance(state, def, true);
  if (rng() >= success) return; // missed — defenses/presence held
  wearDeterrents(state, P.DETERRENT_WEAR_PER_HIT);
  landHit(state, def, opts, target, rng);
}

/** Result of a scare click: 'foiled' (strike beaten, duck safe), 'feint' (the owl
 *  juked to another spot — click again), or null (nothing was diving). */
export type ScareResult =
  | { kind: 'foiled'; duckId: string }
  | { kind: 'feint'; duckId: string }
  | null;

/** Player intervention (online, active): a scare click on an in-flight strike.
 *  The final required click FOILS it (duck safe); any earlier click is a FEINT —
 *  the owl jukes to a different spot and re-opens its reaction window. This is the
 *  real "be present" save, now a 1–3 click skill check. */
export function scareOff(
  state: GameState,
  predatorId: string,
  rng: () => number = Math.random,
): ScareResult {
  const ps = state.predators[predatorId];
  if (!ps?.strike) return null;
  const s = ps.strike;
  const duckId = s.targetId;
  s.clicksLanded += 1;
  if (s.clicksLanded >= s.clicksRequired) {
    ps.strike = undefined;
    emit(state, { kind: 'scared', predatorId, duckId });
    return { kind: 'foiled', duckId };
  }
  // Feint: relocate to a fresh spot and re-arm the wind-up for the next dive.
  s.spot = pickSpot(rng, s.spot);
  s.windupRemaining = s.windupTotal;
  emit(state, { kind: 'feint', predatorId, duckId });
  return { kind: 'feint', duckId };
}

/** The in-flight telegraphed strike for the UI's interactive owl, or null when no
 *  dive is committed. Pure read off GameState (the UI never simulates). */
export interface ActiveStrike {
  def: PredatorDef;
  predatorId: string;
  strike: NonNullable<PredatorState['strike']>;
}
export function activeStrike(state: GameState): ActiveStrike | null {
  for (const def of PREDATOR_DEFS) {
    const ps = state.predators[def.id];
    if (ps?.strike) return { def, predatorId: def.id, strike: ps.strike };
  }
  return null;
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

  // Telegraphed strikes are an online affair. Offline catch-up resolves attacks
  // immediately (no player to react), so clear any stale dive a crash left mid-air.
  if (opts.mode === 'offline') {
    ps.strike = undefined;
  } else if (ps.strike) {
    // Advance an in-flight dive's wind-up; resolve it the instant it lands. Done
    // first so a dive committed near the window's close still gets to bite (the
    // owl already committed) even as the window itself ticks shut this step.
    ps.strike.windupRemaining -= dt;
    if (ps.strike.windupRemaining <= 0) {
      resolveStrike(state, def, opts, ps, rng);
      ps.strike = undefined;
    }
  }

  if (windowOpen(ps)) {
    ps.windowRemaining = Math.max(0, ps.windowRemaining - dt);
    ps.windowElapsed += dt;
    // Attacks are staggered across the window so a player who reacts to the
    // telegraph (secure / be present) is covered before they land. Online each
    // attack opens a visible, scareable dive; offline it resolves at once.
    const n = def.attacksPerWindow;
    while (ps.attacksFired < n && ps.windowElapsed >= ((ps.attacksFired + 1) * def.windowDurationSec) / (n + 1)) {
      ps.attacksFired += 1;
      if (opts.mode === 'online') beginStrike(state, def, ps, rng);
      else resolveAttack(state, def, opts, rng);
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
    wearDeterrents(state, P.DETERRENT_WEAR_PER_WINDOW); // the night weathers the nets
    emit(state, { kind: 'open', predatorId: def.id });
  }
}

/** Age every wound by raw `dt`; escalate any that pass the recovery window into
 *  a permanent loss (subject to the offline mercy rail). Runs online & offline.
 *  Phase 4d: water access stretches/tightens the recovery window (the timer
 *  multiplier stays > 0, so there is always time to treat — no new death path). */
function escalateWounds(state: GameState, dt: number, opts: PredatorOpts): void {
  const threshold = P.WOUND_ESCALATE_SEC * waterWoundMult(state);
  // Iterate the live array (no per-tick copy); defer removals so we never mutate
  // state.ducks mid-loop. `lost` stays null unless something actually escalates.
  let lost: string[] | null = null;
  for (const d of state.ducks) {
    if (!d.wounded) continue;
    d.woundElapsed = (d.woundElapsed ?? 0) + dt;
    if (d.woundElapsed < threshold) continue;
    if (permitPermanentLoss(opts)) {
      emit(state, { kind: 'escalated', duckId: d.id, source: d.woundSource ?? 'predator' });
      (lost ??= []).push(d.id);
    } else {
      // Mercy rail (offline budget spent): hold at the brink. The player returns
      // to a wounded duck to TREAT, not a corpse.
      d.woundElapsed = threshold;
    }
  }
  if (lost) for (const id of lost) removeDuck(state, id);
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
