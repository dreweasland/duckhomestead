import { BALANCE, PREDATOR_DEFS, ZONE_DEFS, zoneDef, type StationType } from '../config/balance';

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
  | 'forage'
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
  /** Which zone this station lives in (Phase 4b). Defaults to 'yard'. */
  zoneId: string;
  /** Tile coordinates within its zone's local grid. */
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
  /** Energy/s supplied passively by free-range forage this tick (Phase 4b). */
  forageEnergy?: number;
}

/** Derived duckling-ration snapshot (gates maturation speed). */
export interface DucklingNutritionState {
  satisfaction: Record<Axis, number>;
  requirement: Record<Axis, number>;
  /** Maturation speed multiplier (1 = full, down to the penalty floor). */
  matureRate: number;
  immatureCount: number;
}

// ── Phase 4a: breeding & genetics ──
/** Blue-dilution locus alleles. `Bl` = blue allele, `bl` = wild-type. */
export type Allele = 'Bl' | 'bl';
export type Genotype = [Allele, Allele];
/** Phenotype by blue-allele count: 0 = black, 1 = blue, 2 = splash. */
export type Color = 'black' | 'blue' | 'splash';
export const COLORS: Color[] = ['black', 'blue', 'splash'];
export type Sex = 'drake' | 'hen';
export type Stage = 'duckling' | 'juvenile' | 'adult';

export interface Duck {
  id: string;
  genotype: Genotype;
  /** Heritable egg-output multiplier (throughput only). */
  vigor: number;
  sex: Sex;
  stage: Stage;
  /** Seconds accrued in the current life stage (drives maturation). */
  ageTicks: number;
  /** Niacin leg debuff (halves this duck's lay until dosed). */
  debuffed?: boolean;
  /** Phase 4c: a predator wound (soft). Reduces output, blocks breeding, and
   *  escalates to a permanent loss if untended past WOUND_ESCALATE_SEC. Cleared
   *  by the Treat action. */
  wounded?: boolean;
  /** Seconds since this wound landed (the escalation timer). Runs online & offline. */
  woundElapsed?: number;
  /** Phase 4c: marked secured (housed in a Secure Coop slot) — excluded from
   *  predator targeting during windows. The lever for protecting prize breeders. */
  secured?: boolean;
}

/** An active breeding pair: lays fertilized clutches that incubate into ducklings. */
export interface BreedingPair {
  id: string;
  drakeId: string;
  henId: string;
  /** Seconds toward the next fertilized clutch. */
  clutchProgress: number;
  /** Incubation progress (seconds) per fertilized egg currently incubating. */
  incubating: number[];
}

/** Phenotype from genotype: blue-allele count -> color. */
export function phenotype(g: Genotype): Color {
  const blue = (g[0] === 'Bl' ? 1 : 0) + (g[1] === 'Bl' ? 1 : 0);
  return blue === 0 ? 'black' : blue === 1 ? 'blue' : 'splash';
}

/** Total housing across all coops (capacity scales with coop level). */
export function coopCapacity(state: GameState): number {
  return state.stations
    .filter((s) => s.type === 'coop')
    .reduce((a, c) => a + BALANCE.BREEDING.COOP_CAPACITY * c.level, 0);
}

export const isAdult = (d: Duck): boolean => d.stage === 'adult';
/** Adult hens — the laying population that drives egg output. */
export const adultLayers = (state: GameState): Duck[] =>
  state.ducks.filter((d) => d.stage === 'adult' && d.sex === 'hen');
/** All adult ducks — what the layer ration must feed. */
export const adultDucks = (state: GameState): Duck[] => state.ducks.filter(isAdult);

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
  /** Tending Whistle: the "Tend All" sweep (unlocks at MILESTONE_TENDALL_RANK). */
  tendAllUnlocked: boolean;

  // ── Phase 2: nutrition ──
  /** Active layer ration: units of each ingredient fed per adult duck per cycle. */
  ration: Record<Ingredient, number>;
  /** Grow-out ration fed to immature ducks (gates maturation). */
  ducklingRation: Record<Ingredient, number>;
  /** Derived duckling-nutrition snapshot (recomputed each tick). */
  ducklingNutrition?: DucklingNutritionState;
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

  // ── Phase 4a: breeding ──
  /** The flock — individual ducks (housed up to coopCapacity). */
  ducks: Duck[];
  /** Monotonic id counter for ducks. */
  nextDuckId: number;
  /** Active breeding pairs. */
  breedingPairs: BreedingPair[];
  /** Monotonic id counter for pairs. */
  nextPairId: number;
  /** Colors ever produced (the dex) — drives first-of-color DINGs. */
  dexSeen: Color[];
  /** Transient: colors discovered this tick, drained by the engine for DINGs. */
  pendingDex?: Color[];

  // ── Phase 4b: zones ──
  /** Per-zone dynamic state, keyed by zone id (defs live in config/balance). */
  zones: Record<string, ZoneState>;

  // ── Phase 4c: predators (the risk layer) ──
  /** Per-predator window/schedule state, keyed by predator id (defs in config). */
  predators: Record<string, PredatorState>;
  /** Built deterrents (count) — each raises the homestead-wide protection floor. */
  deterrents: number;
  /** Built Secure Coops (count) — each adds SECURE_SLOTS_PER_COOP secure slots. */
  secureCoops: number;
  /** First-contact grace: predators only ever resolve their first window once the
   *  player is PRESENT (online) to see the new threat and set up defenses — never
   *  first during an absence. Set true the moment predators activate online; once
   *  set, absence becomes a real (attributable) choice. Keeps the feature's debut
   *  from ever being a bolt from the blue. */
  predatorsIntroduced: boolean;
  /** Transient: predator events accrued this tick, drained by the engine (banners
   *  + SFX) and aggregated by offline catch-up. Never serialized meaningfully. */
  pendingPredatorEvents?: PredatorEvent[];

  /** Wall-clock ms of last save; used for offline catch-up on load. */
  lastSeen: number;
}

/** Mutable per-predator state (the static schedule/params live in PREDATOR_DEFS). */
export interface PredatorState {
  /** Seconds until the next window opens (counts down). When it dips under the
   *  def's warningLeadSec the telegraph fires; at 0 the window opens. */
  timeToNextWindow: number;
  /** Seconds left in the currently-open window (0 = closed). */
  windowRemaining: number;
  /** Seconds elapsed within the current open window (staggers the attacks). */
  windowElapsed: number;
  /** Attacks already resolved in the current window. */
  attacksFired: number;
}

/** Transient predator events for UI feedback + the away summary. Not authoritative. */
export type PredatorEvent =
  | { kind: 'introduced' }
  | { kind: 'incoming'; predatorId: string }
  | { kind: 'open'; predatorId: string }
  | { kind: 'wound'; predatorId: string; duckId: string }
  | { kind: 'snatched'; predatorId: string; duckId: string }
  | { kind: 'escalated'; duckId: string };

/** Fresh per-predator state from the defs: first window is a full interval out. */
export function initialPredators(): Record<string, PredatorState> {
  const out: Record<string, PredatorState> = {};
  for (const def of PREDATOR_DEFS) {
    out[def.id] = {
      timeToNextWindow: def.windowEverySec,
      windowRemaining: 0,
      windowElapsed: 0,
      attacksFired: 0,
    };
  }
  return out;
}

/** Total secure slots from built Secure Coops. A duck can be secured (excluded
 *  from targeting) only while secured ducks ≤ this. */
export function secureCapacity(state: GameState): number {
  return state.secureCoops * BALANCE.PREDATORS.SECURE_SLOTS_PER_COOP;
}

/** Homestead-wide protection floor from built deterrents (capped). Passive,
 *  always-on, works offline — the floor that survives your absence. */
export function defenseFloor(state: GameState): number {
  const P = BALANCE.PREDATORS;
  return Math.min(P.DEFENSE_FLOOR_CAP, state.deterrents * P.DEFENSE_FLOOR_PER_DETERRENT);
}

/** Mutable per-zone state (the static shape lives in ZONE_DEFS). */
export interface ZoneState {
  unlocked: boolean;
  /** Seconds accrued toward the next forage cycle (signature node). */
  forageProgress: number;
}

/** Fresh zone state from the defs: a zone starts unlocked iff it has no gate. */
export function initialZones(): Record<string, ZoneState> {
  const zones: Record<string, ZoneState> = {};
  for (const def of ZONE_DEFS) zones[def.id] = { unlocked: !def.unlock, forageProgress: 0 };
  return zones;
}

export function initialResources(): Resources {
  return { corn: 0, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0, forage: 0, pellets: 0, eggs: 0 };
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
    tendAllUnlocked: false,
    ration: { ...BALANCE.NUTRITION.DEFAULT_RATION },
    ducklingRation: { ...BALANCE.BREEDING.DEFAULT_DUCKLING_RATION },
    condition: BALANCE.NUTRITION.CONDITION_MAX,
    niacinShortfall: 0,
    doseCooldownRemaining: 0,
    inventory: [],
    dust: 0,
    nextModuleId: 1,
    ducks: [],
    nextDuckId: 1,
    breedingPairs: [],
    nextPairId: 1,
    dexSeen: [],
    zones: initialZones(),
    predators: initialPredators(),
    deterrents: 0,
    secureCoops: 0,
    predatorsIntroduced: false,
    lastSeen: now,
  };
}

/**
 * Seed the starting flock into the first coop: a few Blue carriers (Bl/bl) so
 * the player can breed out all three colors, mid vigor. Mutates state.
 */
export function seedFlock(state: GameState): void {
  const B = BALANCE.BREEDING;
  const [lo, hi] = B.VIGOR_SEED_RANGE;
  const make = (sex: Sex): Duck => ({
    id: `d${state.nextDuckId++}`,
    genotype: ['Bl', 'bl'],
    vigor: lo + Math.random() * (hi - lo),
    sex,
    stage: 'adult',
    ageTicks: 0,
  });
  for (let i = 0; i < B.SEED_DRAKES; i++) state.ducks.push(make('drake'));
  for (let i = 0; i < B.SEED_HENS; i++) state.ducks.push(make('hen'));
  for (const c of state.ducks.map((d) => phenotype(d.genotype))) {
    if (!state.dexSeen.includes(c)) state.dexSeen.push(c);
  }
}

/** True if tile (x,y) is occupied by a station. */
export function stationAt(
  state: GameState,
  x: number,
  y: number,
  zoneId = 'yard',
): Station | undefined {
  return state.stations.find((s) => s.zoneId === zoneId && s.x === x && s.y === y);
}

/** True if (x,y) is part of the Yard's decorative pond (kept for water render). */
export function isPondTile(x: number, y: number): boolean {
  const p = BALANCE.POND;
  return x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
}

/** True if a tile is non-buildable within a zone (e.g. the Yard pond). */
export function isBlockedTile(zoneId: string, x: number, y: number): boolean {
  const b = zoneDef(zoneId)?.blocked;
  return !!b && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
}

/** Whether a zone is currently unlocked (the Yard always is). */
export function zoneUnlocked(state: GameState, zoneId: string): boolean {
  return state.zones[zoneId]?.unlocked ?? false;
}
