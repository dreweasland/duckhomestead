import { BALANCE, type StationType } from '../config/balance';

/**
 * Storage resources. `eggs` is the primary spendable currency. `corn`,
 * `mealworms`, `brewersYeast`, and `oysterShell` are the Phase 2 nutrition
 * ingredients (energy / protein / niacin / calcium). `pellets` is the legacy
 * Phase 1 intermediate, kept for save back-compat.
 */
export type Resource =
  | 'corn'
  | 'peas'
  | 'mealworms'
  | 'brewersYeast'
  | 'oysterShell'
  | 'pellets'
  | 'eggs';

export type Resources = Record<Resource, number>;

/** The five nutrition ingredients (overlapping axis matrix lives in balance.ts). */
export const INGREDIENTS = ['corn', 'peas', 'mealworms', 'brewersYeast', 'oysterShell'] as const;
export type Ingredient = (typeof INGREDIENTS)[number];

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
  /** Coops only: a leg debuff from sustained niacin shortfall (halves output). */
  debuffed?: boolean;
  /** Slotted modules (length <= LOOT.SLOTS_PER_STATION). Throughput boosts only. */
  modules?: Module[];
}

export type Axis = 'energy' | 'protein' | 'niacin' | 'calcium';
export const AXES: Axis[] = ['energy', 'protein', 'niacin', 'calcium'];

// ── Phase 3: loot / modules ──
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Throughput levers a module can boost. NEVER nutrition requirements/matrix. */
export type ModuleStat =
  | 'stationSpeed'
  | 'stationYield'
  | 'eggOutput'
  | 'conditionRegen'
  | 'tendPower'
  | 'tendCooldown';
export const MODULE_STATS: ModuleStat[] = [
  'stationSpeed',
  'stationYield',
  'eggOutput',
  'conditionRegen',
  'tendPower',
  'tendCooldown',
];

export interface Module {
  id: string;
  stat: ModuleStat;
  rarity: Rarity;
  /** Rolled magnitude (fraction) within the rarity's band. */
  magnitude: number;
}

/** Derived nutrition snapshot, recomputed every tick (for the dashboard + tend). */
export interface NutritionState {
  satisfaction: Record<Axis, number>; // supply / requirement (raw, can exceed 1)
  supply: Record<Axis, number>;
  requirement: Record<Axis, number>;
  /** Raw egg multiplier from the egg axes (energy·protein·calcium), pre-condition. */
  eggMultRaw: number;
  /** Egg multiplier actually applied (raw, buffered by flock condition). */
  eggMult: number;
  /** Mill-capacity scaling on feed throughput (1 = enough mills). */
  feedScale: number;
  hasMill: boolean;
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

  // ── Phase 2: nutrition ──
  /** Active ration: units of each ingredient fed per coop per cycle. */
  ration: Record<Ingredient, number>;
  /** Flock condition reserve (0..CONDITION_MAX) — the battery that buffers
   *  shortfalls and powers offline. */
  condition: number;
  /** Seconds of sustained niacin shortfall accrued toward the next leg debuff. */
  niacinShortfall: number;
  /** Global cooldown (s) on the active "Dose Brewer's Yeast" intervention. */
  doseCooldownRemaining: number;
  /** Derived nutrition snapshot (recomputed each tick; not authoritative). */
  nutrition?: NutritionState;

  // ── Phase 3: loot ──
  /** Unassigned modules held in stock. */
  inventory: Module[];
  /** Reroll currency from salvaging modules. */
  dust: number;
  /** Monotonic id counter for modules. */
  nextModuleId: number;

  /** Wall-clock ms of last save; used for offline catch-up on load. */
  lastSeen: number;
}

export function initialResources(): Resources {
  return { corn: 0, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0, pellets: 0, eggs: 0 };
}

export function initialState(now: number): GameState {
  return {
    version: 1,
    // Seed enough eggs to build the full starter chain (see STARTING_EGGS).
    resources: { ...initialResources(), eggs: BALANCE.STARTING_EGGS },
    stations: [],
    nextStationId: 1,
    rank: 1,
    xp: 0,
    autoHaulUnlocked: false,
    ration: { ...BALANCE.NUTRITION.DEFAULT_RATION },
    condition: BALANCE.NUTRITION.CONDITION_MAX,
    niacinShortfall: 0,
    doseCooldownRemaining: 0,
    inventory: [],
    dust: 0,
    nextModuleId: 1,
    lastSeen: now,
  };
}

/** True if tile (x,y) is occupied by a station. */
export function stationAt(state: GameState, x: number, y: number): Station | undefined {
  return state.stations.find((s) => s.x === x && s.y === y);
}

/** True if (x,y) is part of the decorative pond (not buildable). */
export function isPondTile(x: number, y: number): boolean {
  const p = BALANCE.POND;
  return x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
}
