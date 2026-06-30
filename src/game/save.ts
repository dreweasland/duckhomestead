import { BALANCE } from '../config/balance';
import { collectAll, placeStation } from './actions';
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

/** A genome is valid iff it's an array of SLOTS genes from the gene set. */
function validGenome(g: unknown): g is Genome {
  return (
    Array.isArray(g) &&
    g.length === BALANCE.GENOME.SLOTS &&
    g.every((x) => x === 'L' || x === 'V' || x === 'H' || x === 'D')
  );
}

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
}

export function serialize(state: GameState): string {
  return JSON.stringify(state);
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
      condition: parsed.condition ?? base.condition,
      niacinShortfall: parsed.niacinShortfall ?? 0,
      overcrowdStress: parsed.overcrowdStress ?? 0,
      activeRemaining: 0, // always start in guard; the first action arms active mode
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
        return { ...d, genome, genomeKnown: d.genomeKnown ?? (parsed.geneReader ?? false) };
      }),
      nextDuckId: parsed.nextDuckId ?? 1,
      breedingPairs: parsed.breedingPairs ?? [],
      nextPairId: parsed.nextPairId ?? 1,
      // Breeding rework: the god-clone target + the gene-reader flag.
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
        colors: c.colors ?? [],
        timestamp: c.timestamp ?? 0,
      })),
      // Pre-4c saves (and any not-yet-introduced save) keep the first-contact
      // grace: predators won't resolve their first window until the player is
      // back online to see them. So a returning player is never first-exposed
      // during the load's offline catch-up.
      predatorsIntroduced: parsed.predatorsIntroduced ?? false,
      pendingPredatorEvents: undefined,
      stations: (parsed.stations ?? []).map((s) => ({
        ...s,
        zoneId: s.zoneId ?? 'yard', // pre-4b stations all lived in the Yard
        level: s.level ?? 1,
        cycleProgress: s.cycleProgress ?? 0,
        buffer: s.buffer ?? {},
        tendCooldownRemaining: s.tendCooldownRemaining ?? 0,
        modules: s.modules ?? [],
      })),
    };
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
    // Back-derive milestone unlocks from rank so a save from before the milestone
    // existed gets it immediately (not only on the next rank-up).
    if (result.rank >= BALANCE.MILESTONE_TENDALL_RANK) result.tendAllUnlocked = true;
    return result;
  } catch {
    return base;
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
    localStorage.removeItem(SAVE_KEY);
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
  const woundedDucks = state.ducks.filter((d) => d.wounded);
  const predatorWounded = woundedDucks.filter((d) => d.woundSource !== 'overcrowd').length;
  const overcrowdWounded = woundedDucks.filter((d) => d.woundSource === 'overcrowd').length;
  state.pendingPredatorEvents = [];
  // Offline hatches still record colors (dexSeen) and create god-clone ducks, but
  // the live DING queues must not fire on load — an offline event isn't a live
  // moment, and a god-clone fanfare right after the Away modal reads as a bug.
  // (Same treatment as the predator events above; the achievements persist in
  // dexSeen / the flock.)
  state.pendingDex = [];
  state.pendingGodClone = 0;
  const predator =
    predatorLost > 0 || predatorWounded > 0 ? { wounded: predatorWounded, lost: predatorLost } : undefined;
  const overcrowd =
    overcrowdLost > 0 || overcrowdWounded > 0 ? { injured: overcrowdWounded, lost: overcrowdLost } : undefined;
  const debuffedCount = state.ducks.filter((d) => d.debuffed).length;
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
  // placeStation charges eggs and seeds the flock on the first coop, so fund it
  // generously, place the engine, then set the actual starting stipend.
  state.resources.eggs = Number.MAX_SAFE_INTEGER;
  placeStation(state, 'plot', 2, 3);
  placeStation(state, 'mill', 3, 3);
  placeStation(state, 'coop', 4, 3);
  state.resources.eggs = BALANCE.STARTING_EGGS;
  return state;
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
  // Surface the summary if meaningful time passed AND something happened — resources
  // made OR a flock toll (predator/overcrowding). Gating on production alone hid the
  // toll when nothing was produced (e.g. an all-drake flock with no laying hens),
  // so the player returned to wounded/missing ducks with no explanation.
  const meaningful =
    away.elapsedSeconds > 5 &&
    (Object.keys(away.produced).length > 0 ||
      away.predator != null ||
      away.overcrowd != null ||
      (away.debuffed ?? 0) > 0);
  return { state, away: meaningful ? away : null };
}
