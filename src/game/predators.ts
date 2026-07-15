import { BALANCE, PREDATOR_DEFS, type PredatorDef } from '../config/balance';
import {
  defenseFloor,
  drainCondition,
  infirmaryCapacity,
  infirmaryOccupied,
  type Duck,
  type GameState,
  type Genome,
  type PredatorEvent,
  type PredatorState,
  type Rarity,
  type WoundSeverity,
} from './state';
import { woundResistChance } from './genetics';
import { sentryRepelChance, sentryWindupMult } from './posts';
import { waterWoundMult } from './water';
import { grantModule } from './loot';

const P = BALANCE.PREDATORS;
const SEVERITIES: WoundSeverity[] = ['minor', 'serious', 'critical'];

/** Roll an injury's severity when it lands. `caught` (a defenses-down active hit)
 *  rolls the harsher distribution; a Hardy (H-gene) duck has a chance to shrug one
 *  step milder. Severity drives infirmary recovery time. Shared by predator strikes
 *  and flock overcrowding. */
export function rollWoundSeverity(caught: boolean, genome: Genome, rng: () => number): WoundSeverity {
  const I = P.INFIRMARY;
  const weights = caught ? I.SEVERITY_WEIGHTS_CAUGHT : I.SEVERITY_WEIGHTS;
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  let idx = weights.length - 1;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) {
      idx = i;
      break;
    }
  }
  if (idx > 0 && rng() < woundResistChance(genome)) idx -= 1; // Hardy shrugs milder
  return SEVERITIES[idx];
}

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

/** Whether this def's rank + (Phase 6c) legacy-tier gates are BOTH met — the
 *  same two checks runPredators' per-def loop gates on. The single source of
 *  truth for "has this predator actually debuted", so the UI (e.g. The Watch's
 *  calm-state listing) never names a not-yet-live threat ahead of its tease. */
export function predatorLive(state: GameState, def: PredatorDef): boolean {
  if (state.rank < def.introRank) return false;
  if (def.minLegacyTier != null && state.legacyTier < def.minLegacyTier) return false;
  return true;
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
  return def.baseAttackChance * (1 - defenseFloor(state, def.defense)) * (1 - presence);
}

/** A predator state for the UI telegraph. Pure read off GameState (the UI
 *  never simulates). */
export interface Threat {
  def: PredatorDef;
  phase: 'open' | 'incoming';
  /** Seconds left in the open window, or seconds until the incoming one opens. */
  seconds: number;
}
/** EVERY live threat, most urgent first: open windows before incoming ones,
 *  soonest first within each phase. Overlapping windows (owl + raccoon can
 *  hunt at once) are all reported — the telegraph shows the whole night, never
 *  just the winner. Empty when all is calm. */
export function currentThreats(state: GameState): Threat[] {
  if (!predatorsActive(state)) return [];
  const out: Threat[] = [];
  for (const def of PREDATOR_DEFS) {
    const ps = state.predators[def.id];
    if (!ps) continue;
    if (windowOpen(ps)) out.push({ def, phase: 'open', seconds: ps.windowRemaining });
    else if (incoming(ps, def)) out.push({ def, phase: 'incoming', seconds: ps.timeToNextWindow });
  }
  return out.sort((a, b) =>
    a.phase !== b.phase ? (a.phase === 'open' ? -1 : 1) : a.seconds - b.seconds,
  );
}
/** The single most urgent threat — the head of currentThreats (for the spots
 *  that only fit one: the Watch header, guide gating, layout offsets). */
export function currentThreat(state: GameState): Threat | null {
  return currentThreats(state)[0] ?? null;
}

/** Ducks that may be targeted by a fresh attack: not secured, not already
 *  wounded. Secured ducks are excluded entirely; an already-wounded duck's
 *  danger is escalation (governed by Treat), not a second wound. */
function eligibleTargets(state: GameState): Duck[] {
  // Winter-assigned ducks (6d) are at another SITE — predators hunt the main
  // homestead only (the cold is Winterstead's antagonist, and it never kills).
  return state.ducks.filter((d) => !d.secured && !d.wounded && d.site !== 'winter');
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

/** A fresh window schedule for a predator (first window a full interval away). */
function freshSchedule(def: PredatorDef): PredatorState {
  return { timeToNextWindow: def.windowEverySec, windowRemaining: 0, windowElapsed: 0, attacksFired: 0 };
}

/** Weather the deterrent floor (no-op without deterrents). Clamped at 0; only the
 *  Repair action brings it back up. */
function wearDefense(state: GameState, type: PredatorDef['defense'], amount: number): void {
  if (type === 'cloth') {
    if (state.hardwareCloth <= 0) return;
    state.hardwareClothIntegrity = Math.max(0, state.hardwareClothIntegrity - amount);
  } else {
    if (state.deterrents <= 0) return;
    state.deterrentIntegrity = Math.max(0, state.deterrentIntegrity - amount);
  }
}

/** Land a hit that got past the floor onto a specific (already-chosen) target:
 *  a snatch (brutality dial), a shrugged-off resist, or a soft wound. Shared by
 *  offline immediate attacks and online telegraphed strikes. Returns the
 *  outcome so callers can gate per-hit netting wear on actual harm (a shrug
 *  doesn't tear the line — see the 2026-07-07 wear retune in balance.ts). */
function landHit(
  state: GameState,
  def: PredatorDef,
  opts: PredatorOpts,
  target: Duck,
  rng: () => number,
): 'snatched' | 'shrugged' | 'wounded' {
  // Brutality dial: a rare landed attack may skip the wound and take the duck
  // outright. Default OFF — every death otherwise passes through a wound.
  if (P.ALLOW_INSTANT_SNATCH && rng() < P.INSTANT_SNATCH_CHANCE && permitPermanentLoss(opts)) {
    if (state.pairedHunt?.active) state.pairedHunt.harmed = true;
    emit(state, { kind: 'snatched', predatorId: def.id, duckId: target.id, duckName: target.name });
    removeDuck(state, target.id);
    drainCondition(state, BALANCE.NUTRITION.STRESS.DRAIN.loss); // a taken duck rattles the flock
    return 'snatched';
  }

  // Resilience: a Hardy (H-gene) duck has a chance to shrug off the wound
  // entirely. Throughput-only — it can't reduce a requirement, just survive a hit.
  if (rng() < woundResistChance(target.genome)) {
    // The H-gene's proudest moment was invisible — announce it (pure feedback).
    emit(state, { kind: 'shrugged', predatorId: def.id, duckId: target.id, duckName: target.name });
    return 'shrugged';
  }

  // THE PAIRED HUNT: actual harm (not a shrug) voids the bounty.
  if (state.pairedHunt?.active) state.pairedHunt.harmed = true;

  target.wounded = true;
  target.woundSource = 'predator';
  target.woundElapsed = 0;
  target.severity = rollWoundSeverity(!!opts.activeDefense, target.genome, rng);
  emit(state, { kind: 'wound', predatorId: def.id, duckId: target.id, duckName: target.name });
  // Condition stress: a landed hit rattles the whole flock (a blip alone; a bad
  // night compounds into a real dent to nurse back). A shrugged-off hit doesn't.
  drainCondition(state, BALANCE.NUTRITION.STRESS.DRAIN.wound);
  return 'wounded';
}

/** Resolve one attack attempt immediately (offline catch-up): roll against the
 *  built floor, pick a target, land the hit. No telegraph — the player isn't
 *  here to react, so the dive is the resolution. */
function resolveAttack(state: GameState, def: PredatorDef, opts: PredatorOpts, rng: () => number): void {
  const success = attackChance(state, def, opts.mode === 'online');
  if (rng() >= success) return; // attack missed (defenses/presence held)

  const target = pickTarget(state, rng);
  if (!target) return; // nothing exposed (all secured / none eligible) — no effect
  // SENTRY (9a): the watch gets its own roll on an attack that beat the floor
  // — duck-shaped built defense, on duty offline exactly like deterrents.
  if (rng() < sentryRepelChance(state)) {
    emit(state, { kind: 'repelled', predatorId: def.id, duckId: target.id });
    return;
  }
  // Per-hit wear only when the hit actually harms: a shrugged-off (or empty-
  // yard) breach doesn't tear the netting. Breach wear used to fire on every
  // success and dominated the ambient rate — see the balance.ts wear note.
  if (landHit(state, def, opts, target, rng) !== 'shrugged') {
    wearDefense(state, def.defense, P.DETERRENT_WEAR_PER_HIT);
  }
}

/** Scare difficulty 0..1 from homestead rank: 0 at the intro rank, 1 at RANK_DIFF_TO.
 *  Drives faster dives + more multi-click feints as the homestead climbs. */
export function rankDifficulty(state: GameState): number {
  const span = P.RANK_DIFF_TO - P.INTRO_RANK;
  if (span <= 0) return 1;
  return Math.max(0, Math.min(1, (state.rank - P.INTRO_RANK) / span));
}

/** Dive wind-up (reaction window) in seconds, shrinking with rank difficulty.
 *  A def with `windupScale` set (siege) OVERRIDES the rank ramp with a fixed
 *  fraction of STRIKE_WINDUP_SEC — a siege stays harsh regardless of rank.
 *  Sentries (9a) stretch every wind-up — the watch buys you reaction time. */
export function strikeWindupSec(state: GameState, def?: PredatorDef): number {
  const base =
    def?.windupScale != null
      ? P.STRIKE_WINDUP_SEC * def.windupScale
      : P.STRIKE_WINDUP_SEC * (1 + (P.RANK_WINDUP_MIN_SCALE - 1) * rankDifficulty(state));
  return base * sentryWindupMult(state);
}

/** Weighted pick of how many scare clicks a strike needs (1..N), interpolating the
 *  distribution from the easy default toward the hard one as rank climbs. A def
 *  with `clickWeights` set (siege) OVERRIDES this with a fixed distribution. */
function pickClicksRequired(state: GameState, rng: () => number, def?: PredatorDef): number {
  let w: readonly number[];
  if (def?.clickWeights != null) {
    w = def.clickWeights;
  } else {
    const d = rankDifficulty(state);
    const easy = P.STRIKE_CLICK_WEIGHTS;
    const hard = P.STRIKE_CLICK_WEIGHTS_HARD;
    w = easy.map((e, i) => e + ((hard[i] ?? e) - e) * d);
  }
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
/**
 * THE PAIRED HUNT (rank ladder, 2026-07-06): on its clock, force-open the owl
 * AND raccoon windows together — the one-dive-at-a-time rule queues their
 * strikes back-to-back. Online-only (nothing here runs during catch-up), and
 * the scheduling clock only runs while ACTIVE (idle playstyle review,
 * 2026-07-07): an attended set-piece must never open against an unwatched
 * guard tab — unattended hunts were ~81% passive rare-module bounties, and
 * the unlucky rest landed harm nobody chose. A hunt already running when the
 * active window lapses still resolves and grades (the player just fought it).
 * Flawless (no landed harm while the hunt runs, tracked via landHit) pays a
 * guaranteed bounty. Requires the rank plus BOTH base predators established.
 */
function runPairedHunt(state: GameState, dt: number, active: boolean, rng: () => number): void {
  const PH = P.PAIRED_HUNT;
  if (state.rank < PH.INTRO_RANK) return;
  const seen = state.predatorsSeen ?? [];
  if (!seen.includes('owl') || !seen.includes('raccoon')) return;
  const h = (state.pairedHunt ??= { timeToNext: PH.everySec, active: false, remaining: 0, harmed: false });
  if (!h.active) {
    if (!active) return; // the clock FREEZES at guard — an event you attend
    h.timeToNext -= dt;
    if (h.timeToNext > 0) return;
    for (const id of ['owl', 'raccoon'] as const) {
      const ps = state.predators[id];
      if (!ps) return; // schedules not initialised — try again next tick
      ps.windowRemaining = PH.windowDurationSec;
      ps.windowElapsed = 0;
      ps.attacksFired = 0;
      ps.windowAttacks = PH.attacksEach;
    }
    h.active = true;
    h.remaining = PH.windowDurationSec + PH.graceSec;
    h.harmed = false;
    emit(state, { kind: 'huntBegins' });
    return;
  }
  h.remaining -= dt;
  if (h.remaining > 0) return;
  h.active = false;
  h.timeToNext = PH.everySec;
  if (!h.harmed) {
    state.dust += PH.JACKPOT.dust;
    const module = grantModule(state, PH.JACKPOT.moduleRarity as Rarity, rng);
    emit(state, { kind: 'huntFoiled', dust: PH.JACKPOT.dust, moduleId: module.id });
  }
}

/** Any predator's dive currently in flight (the UI can only present one). */
export function anyStrikeInFlight(state: GameState): boolean {
  for (const ps of Object.values(state.predators)) if (ps?.strike) return true;
  return false;
}

function beginStrike(state: GameState, def: PredatorDef, ps: PredatorState, rng: () => number): void {
  if (ps.strike) return; // a dive is already in flight — don't stack
  const target = pickTarget(state, rng);
  if (!target) return; // nothing exposed — no dive
  const id = (state.predatorStrikeSeq = (state.predatorStrikeSeq ?? 0) + 1);
  const windup = strikeWindupSec(state, def);
  ps.strike = {
    targetId: target.id,
    windupRemaining: windup,
    windupTotal: windup,
    id,
    spot: pickSpot(rng),
    clicksRequired: pickClicksRequired(state, rng, def),
    clicksLanded: 0,
  };
  // Jackpot-eligible predators (siege) count each COMMITTED dive this window —
  // the flawless-defense grant needs ≥1 to ever pay out.
  if (def.jackpot) ps.jackpotDives = (ps.jackpotDives ?? 0) + 1;
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
    // ACTIVE: the player is here, so the built floor + presence are OFF — an un-scared
    // committed dive lands (the scare was the only defense). The floor didn't engage,
    // so it doesn't wear: your nets/cloth only erode while they're actually doing the
    // job (idle/offline). Actively scaring keeps them pristine.
    if (def.jackpot) ps.jackpotLanded = (ps.jackpotLanded ?? 0) + 1;
    landHit(state, def, opts, target, rng);
    return;
  }

  // GUARD (online idle): the built floor + passive presence get a roll to hold.
  const success = attackChance(state, def, true);
  if (rng() >= success) {
    // Formerly silent — the nets' finest work deserves a beat (pure feedback).
    emit(state, { kind: 'repelled', predatorId: def.id, duckId: target.id });
    return; // missed — defenses/presence held
  }
  // SENTRY (9a): the watch's own roll after the floor gives way (guard only —
  // in ACTIVE play the sentries instead stretch the wind-up for YOUR scare).
  if (rng() < sentryRepelChance(state)) {
    emit(state, { kind: 'repelled', predatorId: def.id, duckId: target.id });
    return;
  }
  if (def.jackpot) ps.jackpotLanded = (ps.jackpotLanded ?? 0) + 1;
  // Per-hit wear only on actual harm — a shrug doesn't tear the line (see
  // resolveAttack / the balance.ts wear note).
  if (landHit(state, def, opts, target, rng) !== 'shrugged') {
    wearDefense(state, def.defense, P.DETERRENT_WEAR_PER_HIT);
  }
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
/** How many attacks THIS window brings — a hidden per-window roll from the def's
 *  weighted distribution (so the count is never "2 and done"). Falls back to the fixed
 *  attacksPerWindow for a def without weights. */
export function rollWindowAttacks(def: PredatorDef, rng: () => number): number {
  const weights = def.attackCountWeights;
  if (!weights || weights.length === 0) return def.attacksPerWindow;
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i + 1;
  }
  return weights.length;
}

function advancePredator(state: GameState, def: PredatorDef, opts: PredatorOpts, dt: number, rng: () => number): void {
  const ps = (state.predators[def.id] ??= {
    timeToNextWindow: def.windowEverySec,
    windowRemaining: 0,
    windowElapsed: 0,
    attacksFired: 0,
  });

  // Siege predators (minLegacyTier set) are an EVENT, never simulated
  // unattended: the schedule is FROZEN (doesn't advance) while away — offline
  // OR at guard (idle playstyle review, 2026-07-07: a guard tab both farmed
  // ~1.5 unattended epic jackpots per idle hour AND ate streak-resetting hits
  // nobody chose) — and an already-open window FIZZLES (rescheduled fresh, no
  // jackpot, no streak grade) rather than resolving unattended. A siege is
  // something you attend, never something that mauls you in your sleep or
  // pays you for lunch. Normal predators (no minLegacyTier) are untouched.
  if (def.minLegacyTier != null && (opts.mode === 'offline' || !opts.activeDefense)) {
    if (windowOpen(ps)) state.predators[def.id] = freshSchedule(def);
    return;
  }

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
    const n = ps.windowAttacks ?? def.attacksPerWindow;
    while (ps.attacksFired < n && ps.windowElapsed >= ((ps.attacksFired + 1) * def.windowDurationSec) / (n + 1)) {
      // ONE DIVE IN THE AIR AT A TIME (playtest: overlapping owl+raccoon
      // windows both committed strikes; the UI can only show one, so the
      // hidden dive expired unclickable and wounded 'without landing').
      // A due attack DEFERS while any strike is in flight — the schedule
      // check re-fires it the moment the lane clears; attacks still pending
      // when the window closes are simply forfeited (player-favorable).
      if (opts.mode === 'online' && anyStrikeInFlight(state)) break;
      ps.attacksFired += 1;
      if (opts.mode === 'online') beginStrike(state, def, ps, rng);
      else resolveAttack(state, def, opts, rng);
    }
    if (ps.windowRemaining <= 0) {
      // Window closed — grade any jackpot-eligible flawless defense, then schedule
      // the next interval.
      resolveJackpot(state, def, ps, rng);
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
    ps.windowAttacks = rollWindowAttacks(def, rng); // hidden 1..3 — no "2 and done"
    // Jackpot-eligible predators re-arm their per-window dive/landed tally.
    if (def.jackpot) {
      ps.jackpotDives = 0;
      ps.jackpotLanded = 0;
    }
    // The window weathers the floor only when the floor is on duty (idle/offline). An
    // actively-scaring player isn't relying on it, so it doesn't erode.
    if (!opts.activeDefense) wearDefense(state, def.defense, P.DETERRENT_WEAR_PER_WINDOW);
    emit(state, { kind: 'open', predatorId: def.id });
  }
}

/** Grade a jackpot-eligible predator's window at close: a flawless defense (≥1
 *  committed dive, zero landed) grants dust + a guaranteed module — upgraded to
 *  the streak rarity once the same-run flawless streak crosses
 *  streakForLegendary. A landed hit voids this window's grant AND resets the
 *  streak. A window with zero committed dives (nothing was ever exposed) grades
 *  neither way. Sim-side grant; surfaced via a 'siegeFoiled' event so the engine
 *  drain fires the loot banner (the module is already in state.inventory). */
function resolveJackpot(state: GameState, def: PredatorDef, ps: PredatorState, rng: () => number): void {
  const jackpot = def.jackpot;
  if (!jackpot) return;
  const dives = ps.jackpotDives ?? 0;
  const landed = ps.jackpotLanded ?? 0;
  if (dives === 0) return;
  if (landed > 0) {
    state.predatorFlawlessStreak = 0;
    return;
  }
  const streak = (state.predatorFlawlessStreak = (state.predatorFlawlessStreak ?? 0) + 1);
  const rarity = (streak >= jackpot.streakForLegendary ? jackpot.flawlessStreakRarity : jackpot.moduleRarity) as Rarity;
  state.dust += jackpot.dust;
  const module = grantModule(state, rarity, rng);
  emit(state, { kind: 'siegeFoiled', predatorId: def.id, dust: jackpot.dust, moduleId: module.id });
}

/** Advance every wound by raw `dt`. Three cases per wounded duck:
 *   - RECOVERING (in an infirmary slot): heal over time (severity + water scaled),
 *     no escalation; returns to the flock when done.
 *   - OFFLINE, not admitted: the infirmary auto-admits into any free slot (you're
 *     away — it runs itself), overflow falls through to escalation.
 *   - not admitted: age the escalation timer; past the window it's a permanent loss
 *     (subject to the offline mercy rail).
 *  Runs online & offline. Water access stretches the escalation window AND speeds
 *  recovery (the timer multiplier stays > 0 — no new death path). */
function escalateWounds(state: GameState, dt: number, opts: PredatorOpts): void {
  const I = P.INFIRMARY;
  // Lazy — only touched once we hit a wounded duck (the common tick has none). The
  // water chain (waterWoundMult) and slot count are each O(work), so compute once.
  let woundMult = -1;
  let freeSlots = -1;
  let lost: string[] | null = null;
  for (const d of state.ducks) {
    if (!d.wounded) continue;
    if (woundMult < 0) woundMult = waterWoundMult(state);

    if (d.recovering) {
      // Healing in a slot — good water heals faster (divide by the same mult that
      // stretches the escalation window). No escalation while recovering.
      const recSec = (I.RECOVERY_SEC[d.severity ?? 'serious'] ?? I.RECOVERY_SEC.serious) / woundMult;
      d.recoveryElapsed = (d.recoveryElapsed ?? 0) + dt;
      if (d.recoveryElapsed >= recSec) {
        d.wounded = false;
        d.recovering = false;
        d.severity = undefined;
        d.woundElapsed = 0;
        d.recoveryElapsed = 0;
      }
      continue;
    }

    // When the player is NOT actively here — offline catch-up OR guard-idle (the
    // active window lapsed with the tab open) — the infirmary triages itself:
    // auto-admit waiting wounds into free slots. Gating this on offline alone
    // made tab-open-AFK strictly deadlier than closing the browser (no
    // auto-admit, no mercy rail, full wall-clock escalation) — a perverse
    // incentive. While ACTIVE, triage stays the player's job (the 150s active
    // window is the "actually here" signal). Losses at guard now only occur on
    // infirmary overflow — the same exposure as a night away.
    if (opts.mode === 'offline' || !opts.activeDefense) {
      if (freeSlots < 0) freeSlots = infirmaryCapacity(state) - infirmaryOccupied(state);
      if (freeSlots > 0) {
        d.recovering = true;
        d.recoveryElapsed = 0;
        freeSlots -= 1;
        continue;
      }
    }

    // Not admitted — age the escalation timer toward a permanent loss.
    const threshold = P.WOUND_ESCALATE_SEC * woundMult;
    d.woundElapsed = (d.woundElapsed ?? 0) + dt;
    if (d.woundElapsed < threshold) continue;
    // GUARD brink-hold (idle playstyle review, 2026-07-07): at guard the
    // auto-admit above already triaged into every free slot, so reaching here
    // means infirmary OVERFLOW with nobody watching — where offline the mercy
    // rail would cap the toll, guard had NO cap, making a tab left open
    // deadlier than a closed browser. Hold at the brink instead: a duck only
    // ever dies while the player is actually here (an ignored, visible wound)
    // or within the offline budget. markActive rewinds these to a real triage
    // window on return (see rewindWoundsToBrink), mirroring the offline
    // return grace.
    if (opts.mode === 'online' && !opts.activeDefense) {
      d.woundElapsed = threshold;
      continue;
    }
    if (permitPermanentLoss(opts)) {
      emit(state, { kind: 'escalated', duckId: d.id, source: d.woundSource ?? 'predator', duckName: d.name });
      drainCondition(state, BALANCE.NUTRITION.STRESS.DRAIN.loss); // losing one rattles the rest
      (lost ??= []).push(d.id);
    } else {
      // Mercy rail (offline budget spent): hold at the brink, don't kill.
      d.woundElapsed = threshold;
    }
  }
  if (lost) for (const id of lost) removeDuck(state, id);
}

/**
 * Rewind every un-admitted wound to at least OFFLINE_RETURN_WOUND_GRACE_S
 * before escalation. Both unattended modes hold budget-blocked wounds AT the
 * brink (offline: mercy rail spent; guard: the brink-hold above) — without
 * this rewind at the return boundary they'd all escalate on the first
 * attended frame, before any triage is possible. Called by save.ts after
 * offline catch-up and by GameEngine.markActive on the guard→active edge.
 */
export function rewindWoundsToBrink(state: GameState): void {
  const threshold = P.WOUND_ESCALATE_SEC * waterWoundMult(state);
  const brink = Math.max(0, threshold - P.OFFLINE_RETURN_WOUND_GRACE_S);
  for (const d of state.ducks) {
    if (d.wounded && !d.recovering) d.woundElapsed = Math.min(d.woundElapsed ?? 0, brink);
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
    // First-contact grace: the base predator(s) may ONLY debut while the player is
    // present (online). If they would first activate during an absence (offline
    // catch-up), hold them entirely so nobody is exposed before they ever saw the
    // threat. Introduction resets every schedule so the first window is a full,
    // telegraphed interval away.
    if (!state.predatorsIntroduced) {
      if (opts.mode === 'offline') {
        escalateWounds(state, dt, opts);
        return;
      }
      state.predatorsIntroduced = true;
      for (const def of PREDATOR_DEFS) state.predators[def.id] = freshSchedule(def);
      emit(state, { kind: 'introduced', predatorId: PREDATOR_DEFS[0].id });
    }
    if (opts.mode === 'online') runPairedHunt(state, dt, !!opts.activeDefense, rng);
    for (const def of PREDATOR_DEFS) {
      if (state.rank < def.introRank) continue; // not yet at this predator's rank
      // Siege predators (Phase 6c) additionally never schedule/resolve below
      // their legacy-tier gate — a tier-0/1 run never sees the def at all.
      if (def.minLegacyTier != null && state.legacyTier < def.minLegacyTier) continue;
      // Later predators (e.g. the raccoon) debut lazily as their rank is reached —
      // online only (the same grace), announced, and never mid-window on arrival.
      if (def.introRank > P.INTRO_RANK) {
        const seen = (state.predatorsSeen ??= []);
        if (!seen.includes(def.id)) {
          if (opts.mode === 'offline') continue;
          seen.push(def.id);
          state.predators[def.id] = freshSchedule(def);
          emit(state, { kind: 'introduced', predatorId: def.id });
          continue; // no attack the tick it arrives
        }
      }
      advancePredator(state, def, opts, dt, rng);
    }
  }
  // Wounds always age/escalate — even if predators went dormant, an existing
  // wound still needs treating or it's lost. (Attributable: it was visible.)
  escalateWounds(state, dt, opts);
}
