import { BALANCE, type StationType } from '../config/balance';

/** The three chain resources. `eggs` is the primary spendable currency. */
export type Resource = 'corn' | 'pellets' | 'eggs';

export type Resources = Record<Resource, number>;

/**
 * A placed station. Production deposits outputs into `buffer`; "hauling"
 * (manual Collect, the Auto-Haul cart, or offline catch-up) moves the buffer
 * into central `resources`. The chain consumes inputs from central resources.
 */
export interface Station {
  id: string;
  type: StationType;
  /** Tile coordinates on the bounded grid. */
  x: number;
  y: number;
  /** Upgrade level, starts at 1. Higher = more output per cycle. */
  level: number;
  /** Seconds accumulated toward the next cycle. */
  cycleProgress: number;
  /** Produced-but-unhauled output sitting at the station. */
  buffer: Partial<Record<Resource, number>>;
  /** Seconds remaining on the tend cooldown (0 = ready). */
  tendCooldownRemaining: number;
}

export interface GameState {
  /** Schema version for save migration. */
  version: number;
  /** Central storage. The chain consumes from here; eggs are spent from here. */
  resources: Resources;
  stations: Station[];
  /** Monotonic id counter for stations. */
  nextStationId: number;

  // Rank / progression
  rank: number;
  /** XP accumulated toward the next rank. */
  xp: number;

  // Milestones / unlocks
  autoHaulUnlocked: boolean;

  /** Wall-clock ms of last save; used for offline catch-up on load. */
  lastSeen: number;
}

export function initialResources(): Resources {
  return { corn: 0, pellets: 0, eggs: 0 };
}

export function initialState(now: number): GameState {
  return {
    version: 1,
    // Seed enough eggs to build the full starter chain (see STARTING_EGGS).
    resources: { corn: 0, pellets: 0, eggs: BALANCE.STARTING_EGGS },
    stations: [],
    nextStationId: 1,
    rank: 1,
    xp: 0,
    autoHaulUnlocked: false,
    lastSeen: now,
  };
}

/** True if tile (x,y) is occupied by a station. */
export function stationAt(state: GameState, x: number, y: number): Station | undefined {
  return state.stations.find((s) => s.x === x && s.y === y);
}
