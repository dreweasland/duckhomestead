import { BALANCE } from '../config/balance';
import { collectAll } from './actions';
import { initialState, seedFlock, type GameState, type Resource } from './state';
import { tick } from './tick';

const SAVE_KEY = 'duck-homestead-save-v1';

export interface AwaySummary {
  /** Real seconds elapsed since last seen (uncapped, for display). */
  elapsedSeconds: number;
  /** Seconds actually simulated (capped at OFFLINE_CAP_HOURS). */
  creditedSeconds: number;
  capped: boolean;
  /** Net resources gained during catch-up. NEVER includes XP. */
  produced: Partial<Record<Resource, number>>;
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
      condition: parsed.condition ?? base.condition,
      niacinShortfall: parsed.niacinShortfall ?? 0,
      doseCooldownRemaining: parsed.doseCooldownRemaining ?? 0,
      // Phase 3 loot defaults for older saves.
      inventory: parsed.inventory ?? [],
      dust: parsed.dust ?? 0,
      nextModuleId: parsed.nextModuleId ?? 1,
      // Phase 4a breeding defaults for older saves.
      ducks: parsed.ducks ?? [],
      nextDuckId: parsed.nextDuckId ?? 1,
      breedingPairs: parsed.breedingPairs ?? [],
      nextPairId: parsed.nextPairId ?? 1,
      dexSeen: parsed.dexSeen ?? [],
      stations: (parsed.stations ?? []).map((s) => ({
        ...s,
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

  // Simulate in coarse 1-second steps for speed (up to 8h = 28800 steps).
  const STEP = 1;
  let remaining = creditedSeconds;
  while (remaining > 0) {
    const dt = Math.min(STEP, remaining);
    tick(state, dt, { mode: 'offline', autoHaul: true });
    remaining -= dt;
  }
  // Sweep any residual buffers into storage so the summary is complete.
  collectAll(state);

  const produced: Partial<Record<Resource, number>> = {};
  for (const key of Object.keys(state.resources) as Resource[]) {
    const delta = state.resources[key] - before[key];
    if (delta > 0) produced[key] = delta;
  }

  state.lastSeen = now;
  return {
    elapsedSeconds,
    creditedSeconds,
    capped: elapsedSeconds > capSeconds,
    produced,
  };
}

/**
 * Load saved state and apply offline catch-up. If no save exists, returns a
 * fresh state and no summary.
 */
export function loadGame(now: number): { state: GameState; away: AwaySummary | null } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SAVE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return { state: initialState(now), away: null };

  const state = deserialize(raw, now);
  const away = runOfflineCatchUp(state, now);
  // Only surface the summary if meaningful time passed and something was made.
  const meaningful = away.elapsedSeconds > 5 && Object.keys(away.produced).length > 0;
  return { state, away: meaningful ? away : null };
}
