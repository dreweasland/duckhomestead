import { BALANCE, STATION_DEFS } from '../config/balance';
import { collectAll, placeStarterEngine } from './actions';
import { validPost } from './posts';
import { rewindWoundsToBrink } from './predators';
import { initialState, rackSockets, seedFlock, type Duck, type Gene, type GameState, type Genome, type Resource } from './state';
import { tick } from './tick';

const SAVE_KEY = 'duck-homestead-save-v1';

/**
 * Breeding rework migration: convert a pre-rework duck's `vigor` scalar into a
 * plausible 6-gene genome. Higher vigor → more good genes (spread across L/V/H,
 * the rest Dud), so a strong old bird stays strong and a weak one has room to
 * breed up. A re-roll would also satisfy the spec; this keeps the conversion
 * monotonic so players don't feel robbed of a prized line.
 */
function migrateGenome(vigor: number | undefined): Genome {
  const SLOTS = BALANCE.GENOME.SLOTS;
  const v = typeof vigor === 'number' ? vigor : 1;
  const t = Math.max(0, Math.min(1, (v - 0.5) / 1.5)); // old VIGOR_FLOOR..CEILING → 0..1
  const good = Math.round(t * SLOTS);
  const order: Gene[] = ['L', 'V', 'H'];
  const genome: Genome = [];
  for (let i = 0; i < SLOTS; i++) genome.push(i < good ? order[i % order.length] : 'D');
  return genome;
}

/** A genome is valid iff it's an array of SLOTS genes from the gene set. Must
 *  accept 'P' (Phase 6c Prime, mutation-only) — otherwise every Prime-carrying
 *  save gets its genomes silently rejected (re-rolled) on load. */
function validGenome(g: unknown): g is Genome {
  return (
    Array.isArray(g) &&
    g.length === BALANCE.GENOME.SLOTS &&
    g.every((x) => x === 'L' || x === 'V' || x === 'H' || x === 'D' || x === 'P')
  );
}

/** Phase 8 GRANGE 2.0 retired the `delivery`/`hatch` contract shapes — a saved
 *  offer/active contract of either is silently dropped on load (see the
 *  `contracts` block below): no penalty, no toast, the board re-rolls the
 *  freed slot on its normal clock. Commission v2 (same day) reshaped `order`
 *  from a gene spec to color LINES — a v1 order (has `constraints`, no
 *  `lines`) is likewise a retired shape. */
const KNOWN_CONTRACT_TYPES = new Set(['order', 'provision', 'defense']);
const contractShapeValid = (o: { type?: string; lines?: unknown }): boolean =>
  KNOWN_CONTRACT_TYPES.has(o?.type ?? '') && (o.type !== 'order' || Array.isArray(o.lines));

export interface AwaySummary {
  /** Real seconds elapsed since last seen (uncapped, for display). */
  elapsedSeconds: number;
  /** Seconds actually simulated (capped at OFFLINE_CAP_HOURS). */
  creditedSeconds: number;
  capped: boolean;
  /** Net resources gained during catch-up. NEVER includes XP. */
  produced: Partial<Record<Resource, number>>;
  /** Phase 4c: predator toll while away — ducks currently wounded (treatable)
   *  and ducks permanently lost. Absent when nothing happened. */
  predator?: { wounded: number; lost: number };
  /** Flock-overcrowding toll while away — ducks injured (treatable) and lost to an
   *  over-drake flock. Separate from the predator toll so it's attributed honestly. */
  overcrowd?: { injured: number; lost: number };
  /** Ducks limping from a niacin shortfall on return (laying at half) — the third
   *  flock toll, so the summary surfaces every offline loss, not just predators. */
  debuffed?: number;
  /** Player-NAMED victims of this catch-up, by name — a named duck's fate is a
   *  story, not a statistic. Wounded = survivors you can still save. */
  names?: { wounded: string[]; lost: string[] };
  /** THE PRIME DUCK hatched overnight — too big to bury with the other muted
   *  offline beats, so the away summary announces it instead of the live DING. */
  primeDuck?: boolean;
}

export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

/**
 * A light shape-sniff for imported files (Phase 5 juice) — checks for a
 * couple of fields every real save has always had, so a completely unrelated
 * JSON file is rejected with a readable message BEFORE deserialize's tolerant
 * defaulting quietly turns it into a fresh game. NOT a parallel parser: it
 * reads nothing deserialize doesn't already read, it just gates the call.
 */
export function looksLikeSave(parsed: unknown): parsed is Partial<GameState> {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  return typeof p.rank === 'number' && Array.isArray(p.ducks) && typeof p.resources === 'object' && p.resources !== null;
}

/** Parse a saved state, tolerating older/partial shapes by merging defaults. */
export function deserialize(raw: string, now: number): GameState {
  const base = initialState(now);
  try {
    const parsed = JSON.parse(raw) as Partial<GameState>;
    const result: GameState = {
      ...base,
      ...parsed,
      resources: { ...base.resources, ...(parsed.resources ?? {}) },
      // Default Phase 2 fields for Phase 1 saves; merge ration so a partial
      // saved ration still has every ingredient key.
      ration: { ...base.ration, ...(parsed.ration ?? {}) },
      ducklingRation: { ...base.ducklingRation, ...(parsed.ducklingRation ?? {}) },
      drakeRation: { ...base.drakeRation, ...(parsed.drakeRation ?? {}) },
      // Phase 6d: the Winterstead ration — pre-6d saves start it empty (unset).
      winterRation: { ...base.winterRation, ...(parsed.winterRation ?? {}) },
      condition: parsed.condition ?? base.condition,
      niacinShortfall: parsed.niacinShortfall ?? 0,
      overcrowdStress: parsed.overcrowdStress ?? 0,
      activeRemaining: 0, // always start in guard; the first action arms active mode
      guardElapsed: 0, // fresh guard clock — the away gap was already offline-rated
      doseCooldownRemaining: parsed.doseCooldownRemaining ?? 0,
      // Phase 3 loot defaults for older saves.
      inventory: parsed.inventory ?? [],
      rack: parsed.rack ?? [],
      dust: parsed.dust ?? 0,
      nextModuleId: parsed.nextModuleId ?? 1,
      // Auto-fill playstyle weights: pre-feature saves default to Balanced. Merge
      // so a partial saved map still carries every stat (new stats get the default).
      statWeights: { ...base.statWeights, ...(parsed.statWeights ?? {}) },
      statWeightPreset: parsed.statWeightPreset ?? 'balanced',
      // Phase 4a breeding defaults for older saves. Breeding rework: migrate each
      // duck's vigor → a genome (drop the dead vigor field). A pre-rework save has
      // no gene-reader, so migrated genomes start hidden until one is built.
      ducks: (parsed.ducks ?? []).map((raw) => {
        const { vigor: _vigor, ...d } = raw as Duck & { vigor?: number };
        const genome = validGenome(d.genome) ? d.genome : migrateGenome(_vigor);
        // Phase 9a: an unknown post value (hand-edit, newer build) loads as
        // unposted — never a crash, never a phantom worker. 9b: ancestry must
        // be a string array or it's dropped (pre-9b ducks are unrelated).
        const ancestors =
          Array.isArray(d.ancestors) && d.ancestors.every((x) => typeof x === 'string')
            ? d.ancestors
            : undefined;
        return { ...d, genome, post: validPost(d.post), ancestors, genomeKnown: d.genomeKnown ?? (parsed.geneReader ?? false) };
      }),
      nextDuckId: parsed.nextDuckId ?? 1,
      breedingPairs: parsed.breedingPairs ?? [],
      nextPairId: parsed.nextPairId ?? 1,
      // Breeding rework: the Standard + the gene-reader flag.
      genomeTarget: validGenome(parsed.genomeTarget) ? parsed.genomeTarget : [...base.genomeTarget],
      geneReader: parsed.geneReader ?? false,
      dexSeen: parsed.dexSeen ?? [],
      // Phase 4b zones: pre-4b saves get the default (Yard-only unlocked); merge
      // so a partial saved zone map still has every known zone present. (The old
      // per-zone `forageProgress` field, if present, is simply ignored.)
      zones: { ...base.zones, ...(parsed.zones ?? {}) },
      // THE WATER SYSTEM: pre-rework saves (the irrigation-farm / water-capacity /
      // forage era) have no `pond` block → start empty (pond unbuilt, both stages
      // locked/empty as appropriate). Merge so a partial saved pond still has all
      // three sub-fields. Old `irrigation`/`waterFeatures`/`forage` are dropped.
      pond: {
        features: parsed.pond?.features ?? [],
        flow: parsed.pond?.flow ?? [],
        freshness: parsed.pond?.freshness ?? {},
      },
      // Phase 5 juice: pre-terrain saves default to 0 (the open canvas) — NOT
      // parsed.legacyTier — so a returning player's already-placed features
      // never retroactively sit on a newly-blocked tile. Only prestige (which
      // also wipes pond.features) ever advances this.
      pondTerrainTier: parsed.pondTerrainTier ?? 0,
      // Phase 4c predators: pre-4c saves load with no windows in flight, no
      // deterrents, and no secure coops. Merge so a partial saved map still has
      // every known predator present; drop any stale transient events and any
      // in-flight telegraphed strike (online-only runtime feedback — a fresh
      // window will come; a returning player is never mid-dive on load).
      predators: Object.fromEntries(
        Object.entries({ ...base.predators, ...(parsed.predators ?? {}) }).map(([id, ps]) => [
          id,
          { ...ps, strike: undefined },
        ]),
      ),
      deterrents: parsed.deterrents ?? 0,
      deterrentIntegrity: parsed.deterrentIntegrity ?? 1,
      secureCoops: parsed.secureCoops ?? 0,
      infirmaries: parsed.infirmaries ?? 0,
      hardwareCloth: parsed.hardwareCloth ?? 0,
      hardwareClothIntegrity: parsed.hardwareClothIntegrity ?? 1,
      predatorsSeen: parsed.predatorsSeen ?? [],
      // THE PAIRED HUNT clock persists (else every reload resets the ~40min timer).
      pairedHunt: parsed.pairedHunt ?? undefined,
      // Phase 4e prestige meta — persists across resets; pre-4e saves load at
      // tier 0 with no currency/boosts/hall.
      legacyTier: parsed.legacyTier ?? 0,
      legacyCurrency: parsed.legacyCurrency ?? 0,
      purchasedBoosts: { ...(parsed.purchasedBoosts ?? {}) },
      // Champion-goal rework: hall entries now store genome `meanQuality`.
      // Normalise older entries (vigor-era or score-era — no genome data to derive
      // from → 0) so the Hall still renders.
      legacyHall: (parsed.legacyHall ?? []).map((c) => ({
        tier: c.tier,
        meanQuality: typeof c.meanQuality === 'number' ? c.meanQuality : 0,
        bestQuality: typeof c.bestQuality === 'number' ? c.bestQuality : 0,
        flockSize: c.flockSize ?? 0,
        // THE PRIME DUCK mark — this explicit field list DROPPED it for a day
        // (2026-07-06 playtest: 'my prime gene badge disappeared'): the flag
        // survived in memory, then one reload lost it and the next autosave
        // wrote the hall without it. Lesson (again): when a persistent shape
        // gains a field, grep for explicit-list deserializers over that shape.
        primeDuck: c.primeDuck || undefined,
        colors: c.colors ?? [],
        timestamp: c.timestamp ?? 0,
      })),
      // Phase 6b: The Grange. Pre-6b saves have no `contracts` block at all —
      // merge onto the fresh default so a partial/missing shape still loads
      // with a valid (empty) board; a fresh refresh timer re-fills it shortly.
      // Phase 8: drop any offer/active contract of a retired shape (see
      // KNOWN_CONTRACT_TYPES) — a pre-8 save's board simply re-rolls those slots.
      contracts: {
        offers: (parsed.contracts?.offers ?? base.contracts.offers).filter(contractShapeValid),
        active:
          parsed.contracts?.active && contractShapeValid(parsed.contracts.active)
            ? parsed.contracts.active
            : base.contracts.active,
        nextContractId: parsed.contracts?.nextContractId ?? base.contracts.nextContractId,
        refreshRemaining: parsed.contracts?.refreshRemaining ?? base.contracts.refreshRemaining,
        peakEggRate: parsed.contracts?.peakEggRate ?? 0,
      },
      // Pre-4c saves (and any not-yet-introduced save) keep the first-contact
      // grace: predators won't resolve their first window until the player is
      // back online to see them. So a returning player is never first-exposed
      // during the load's offline catch-up.
      predatorsIntroduced: parsed.predatorsIntroduced ?? false,
      pendingPredatorEvents: undefined,
      // Never replay a previous session's expiry/attribution toasts on load.
      pendingContractExpired: 0,
      pendingWoundSaved: undefined,
      stations: (parsed.stations ?? [])
        // A station type this build doesn't know (a newer build's save, or a
        // type ever removed) would crash EVERY load inside the catch-up tick
        // (STATION_DEFS[type].cycleSeconds) — an unrecoverable boot loop. Drop
        // the foreign stations; keep the save.
        .filter((s) => s.type in STATION_DEFS)
        .map((s) => ({
          ...s,
          zoneId: s.zoneId ?? 'yard', // pre-4b stations all lived in the Yard
          level: s.level ?? 1,
          cycleProgress: s.cycleProgress ?? 0,
          buffer: s.buffer ?? {},
          tendCooldownRemaining: s.tendCooldownRemaining ?? 0,
          modules: s.modules ?? [],
        })),
    };
    // Sanitize numerics: a NaN/negative resource (hand-edit, old bug) passes the
    // affordability checks (`NaN < need` is false), gets consumed, and spreads
    // NaN permanently through storage/production. Reset any such value.
    for (const key of Object.keys(result.resources) as Resource[]) {
      const v = result.resources[key];
      if (!Number.isFinite(v) || v < 0) result.resources[key] = base.resources[key];
    }
    if (!Number.isFinite(result.dust) || result.dust < 0) result.dust = 0;
    if (!Number.isFinite(result.legacyCurrency) || result.legacyCurrency < 0) result.legacyCurrency = 0;
    if (!Number.isFinite(result.condition)) result.condition = base.condition;
    result.condition = Math.max(0, Math.min(BALANCE.NUTRITION.CONDITION_MAX, result.condition));
    // A winter-assigned duck whose zone isn't unlocked (rollback/hand-edit) is
    // unreachable limbo — invulnerable, feed-eating, un-recallable. Walk it home.
    if (!result.zones['winterstead']?.unlocked) {
      for (const d of result.ducks) if (d.site === 'winter') d.site = 'home';
    }
    // Migrate a pre-breeding save that has coops but no flock yet.
    if (result.ducks.length === 0 && result.stations.some((s) => s.type === 'coop')) {
      seedFlock(result);
    }
    // Phase 3 rework: pre-rack saves slotted modules per-station. Pull them into
    // the homestead rack (install up to capacity; overflow becomes spares), then
    // clear the legacy field so stations never carry modules again.
    if (result.rack.length === 0) {
      const slotted = result.stations.flatMap((s) => s.modules ?? []);
      if (slotted.length > 0) {
        const cap = rackSockets(result);
        result.rack = slotted.slice(0, cap);
        result.inventory.push(...slotted.slice(cap));
      }
    }
    for (const s of result.stations) s.modules = [];
    // Guard the id counters against collisions: a save whose counter is missing or
    // has fallen behind its existing ids (an older shape, a hand-edit, the pre-rack
    // module pull-in above) would otherwise mint a DUPLICATE id — silently merging
    // two ducks/modules/pairs in every id-keyed lookup (byId maps, cull, pair/secure
    // targeting). Ids are `<prefix><n>`; take each counter past its highest live id.
    const maxIdNum = (ids: string[]): number =>
      ids.reduce((m, id) => Math.max(m, parseInt(id.slice(1), 10) || 0), 0);
    result.nextDuckId = Math.max(result.nextDuckId, maxIdNum(result.ducks.map((d) => d.id)) + 1);
    result.nextModuleId = Math.max(
      result.nextModuleId,
      maxIdNum([...result.rack, ...result.inventory].map((m) => m.id)) + 1,
    );
    result.nextPairId = Math.max(result.nextPairId, maxIdNum(result.breedingPairs.map((p) => p.id)) + 1);
    // Back-derive milestone unlocks from rank so a save from before the milestone
    // existed gets it immediately (not only on the next rank-up). Mirror BOTH
    // rank-gated flags set at rank-up (actions.ts) — Auto-Haul was previously missed,
    // leaving a past-rank-5 legacy save collecting by hand until its next rank-up.
    if (result.rank >= BALANCE.MILESTONE_AUTOHAUL_RANK) result.autoHaulUnlocked = true;
    if (result.rank >= BALANCE.MILESTONE_TENDALL_RANK) result.tendAllUnlocked = true;
    return result;
  } catch {
    // Corrupt beyond parsing: fall back to a REAL fresh game (starter engine +
    // seeded flock), not the bare initialState template — an empty board with a
    // 70-egg stipend is strictly poorer than any new player ever starts.
    return newGame(now);
  }
}

export function saveToStorage(state: GameState, now: number): void {
  state.lastSeen = now;
  try {
    localStorage.setItem(SAVE_KEY, serialize(state));
  } catch {
    // Storage full / unavailable — non-fatal.
  }
}

export function clearStorage(): void {
  try {
    // Wipe the save AND the onboarding flags (welcome, defenses-down, water
    // help) so a full reset really is a fresh start. The mute key survives —
    // it's a device preference, not game state.
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('duck-homestead-') && k !== 'duck-homestead-muted') doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/**
 * Run offline catch-up. Resources accumulate at OFFLINE_RATE_MULT, capped at
 * OFFLINE_CAP_HOURS. Offline grants NO XP and NO rank progress — it only
 * advances production (via tick in 'offline' mode, which always hauls so the
 * chain flows hands-free while away). Returns a "While you were away" summary.
 */
export function runOfflineCatchUp(state: GameState, now: number): AwaySummary {
  const elapsedSeconds = Math.max(0, (now - state.lastSeen) / 1000);
  const capSeconds = BALANCE.OFFLINE_CAP_HOURS * 3600;
  const creditedSeconds = Math.min(elapsedSeconds, capSeconds);

  const before = { ...state.resources };

  // Phase 4c offline mercy rail: cap permanent predator losses this catch-up at
  // a fraction of the NON-secured flock (computed once, up front) so a defended/
  // secured overnight is soft losses, not a wipe — for ANY absence length.
  // Secured ducks never count and never die. Reset any leftover transient events
  // so the toll we summarize is purely from this catch-up.
  state.pendingPredatorEvents = [];
  // Only afflictions that BEGIN during this catch-up belong in the away toll — a duck
  // already wounded/limping when you left was reported live (a banner), so counting
  // its still-present wound here would double-report it as "the owl, in the night."
  // Losses are event-based (net-new by construction); snapshot wounds/debuffs so those
  // counts are net-new too.
  const preWounded = new Set(state.ducks.filter((d) => d.wounded).map((d) => d.id));
  const preDebuffed = new Set(state.ducks.filter((d) => d.debuffed).map((d) => d.id));
  const unsecured = state.ducks.filter((d) => !d.secured).length;
  const predatorLossBudget = {
    remaining: Math.floor(unsecured * BALANCE.PREDATORS.MAX_OFFLINE_LOSS_FRACTION),
  };

  // Simulate in coarse 1-second steps for speed (up to 8h = 28800 steps).
  const STEP = 1;
  let remaining = creditedSeconds;
  while (remaining > 0) {
    const dt = Math.min(STEP, remaining);
    tick(state, dt, { mode: 'offline', autoHaul: true, predatorLossBudget });
    remaining -= dt;
  }
  // Sweep any residual buffers into storage so the summary is complete.
  collectAll(state);

  // The mercy rail holds budget-exhausted wounds AT the escalation brink — but
  // active online, permanent loss is uncapped, so without a rewind every
  // brink-held duck would escalate the moment play resumes, behind the Away
  // modal, before any admit is possible (and the toll reported below would
  // already be false). Rewind every un-admitted wound to a real triage window
  // (shared with the guard→active edge in GameEngine.markActive).
  rewindWoundsToBrink(state);

  const produced: Partial<Record<Resource, number>> = {};
  for (const key of Object.keys(state.resources) as Resource[]) {
    const delta = state.resources[key] - before[key];
    if (delta > 0) produced[key] = delta;
  }

  // Toll while away — attributed by SOURCE (owl vs flock overcrowding) so an
  // overcrowding injury never shows as if the owl did it. Lost = deaths from this
  // catch-up's events (escalated carries its source); wounded = current survivors
  // carrying a treatable wound, split by woundSource. Clear the transient.
  const events = state.pendingPredatorEvents ?? [];
  const isOvercrowd = (e: (typeof events)[number]) =>
    e.kind === 'escalated' && e.source === 'overcrowd';
  const predatorLost = events.filter(
    (e) => e.kind === 'snatched' || (e.kind === 'escalated' && e.source !== 'overcrowd'),
  ).length;
  const overcrowdLost = events.filter(isOvercrowd).length;
  const woundedDucks = state.ducks.filter((d) => d.wounded && !preWounded.has(d.id));
  const predatorWounded = woundedDucks.filter((d) => d.woundSource !== 'overcrowd').length;
  const overcrowdWounded = woundedDucks.filter((d) => d.woundSource === 'overcrowd').length;
  // Named victims by NAME — events carry duckName captured at emit time (a lost
  // duck is long gone from state by now), wounded survivors read theirs live.
  const namedLost = events
    .filter((e) => (e.kind === 'snatched' || e.kind === 'escalated') && e.duckName)
    .map((e) => (e as { duckName: string }).duckName);
  const namedWounded = woundedDucks.filter((d) => d.name).map((d) => d.name!);
  const names =
    namedLost.length > 0 || namedWounded.length > 0 ? { wounded: namedWounded, lost: namedLost } : undefined;
  state.pendingPredatorEvents = [];
  // Offline hatches still record colors (dexSeen) and create truebred ducks, but
  // the live DING queues must not fire on load — an offline event isn't a live
  // moment, and a truebred fanfare right after the Away modal reads as a bug.
  // (Same treatment as the predator events above; the achievements persist in
  // dexSeen / the flock.)
  state.pendingDex = [];
  const primeDuckOvernight = (state.pendingPrimeDuck ?? 0) > 0;
  state.pendingTruebred = 0;
  state.pendingPrimeDuck = 0;
  state.pendingPrimeTruebred = 0;
  const predator =
    predatorLost > 0 || predatorWounded > 0 ? { wounded: predatorWounded, lost: predatorLost } : undefined;
  const overcrowd =
    overcrowdLost > 0 || overcrowdWounded > 0 ? { injured: overcrowdWounded, lost: overcrowdLost } : undefined;
  const debuffedCount = state.ducks.filter((d) => d.debuffed && !preDebuffed.has(d.id)).length;
  const debuffed = debuffedCount > 0 ? debuffedCount : undefined;

  state.lastSeen = now;
  return {
    elapsedSeconds,
    creditedSeconds,
    capped: elapsedSeconds > capSeconds,
    produced,
    predator,
    overcrowd,
    debuffed,
    names,
    primeDuck: primeDuckOvernight || undefined,
  };
}

/**
 * Load saved state and apply offline catch-up. If no save exists, returns a
 * fresh state and no summary.
 */
/**
 * A genuinely fresh homestead. The starter engine — plot + mill + coop — is
 * pre-placed for FREE so eggs flow from t=0, the core loop is legible, and
 * nothing can softlock; the flock auto-seeds on the coop. The player keeps a
 * small egg stipend so their FIRST build is the meaningful one: the protein
 * (Mealworm Farm) + calcium (Oyster Source) producers that fix the flock's
 * nutrition. Only the real new-game path uses this — `initialState` stays an
 * empty board for tests and the deserialize template.
 */
export function newGame(now: number): GameState {
  const state = initialState(now);
  // The shared starter helper (actions.ts) — prestigeReset uses the SAME one,
  // so a post-prestige run never starts poorer than a brand-new game.
  placeStarterEngine(state);
  return state;
}

/** Whether an away summary is worth a modal: meaningful time passed AND
 *  something happened — resources made OR a flock toll (predator/overcrowding).
 *  Gating on production alone hid the toll when nothing was produced (e.g. an
 *  all-drake flock with no laying hens), so the player returned to wounded/
 *  missing ducks with no explanation. Shared by the load path and the
 *  hidden-tab resume path (GameEngine.resumeFromHidden). */
export function meaningfulAway(away: AwaySummary): boolean {
  return (
    away.elapsedSeconds > 5 &&
    (Object.keys(away.produced).length > 0 ||
      away.predator != null ||
      away.overcrowd != null ||
      (away.debuffed ?? 0) > 0)
  );
}

export function loadGame(now: number): { state: GameState; away: AwaySummary | null } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return { state: newGame(now), away: null };

  const state = deserialize(raw, now);
  const away = runOfflineCatchUp(state, now);
  return { state, away: meaningfulAway(away) ? away : null };
}
