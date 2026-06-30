import {
  BALANCE,
  DEFAULT_STAT_WEIGHTS,
  PREDATOR_DEFS,
  ZONE_DEFS,
  zoneDef,
  type StationType,
} from '../config/balance';

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

/** An all-zero ration (the empty starting point — nothing fed until the player sets it). */
export const zeroRation = (): Record<Ingredient, number> =>
  ({ corn: 0, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0 });
/** True when a ration is entirely unset (every ingredient is 0). */
export const rationUnset = (ration: Record<Ingredient, number>): boolean =>
  INGREDIENTS.every((i) => (ration[i] ?? 0) === 0);

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
  /** LEGACY (pre-rack): modules used to slot per-station. Now they live in the
   *  homestead rack (GameState.rack); this field is only read once, on load, to
   *  migrate old saves into the rack. New stations never populate it. */
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
  /** Total mill blend throughput available (units/sec) — the supply side of the
   *  feed bottleneck. Scales with mill count, level, and throughput modules. */
  millCapacity: number;
  /** Total feed the flock wants blended right now (units/sec) — the demand side.
   *  When feedDemand > millCapacity the ration is throttled (feedScale < 1). */
  feedDemand: number;
  /** Eggs laid per second by the whole flock right now (for the currency-flow
   *  breakdown). Output rate, after nutrition throttle + modules + legacy. */
  eggRate: number;
}

/** Derived duckling-ration snapshot (gates maturation speed). */
export interface DucklingNutritionState {
  satisfaction: Record<Axis, number>;
  requirement: Record<Axis, number>;
  /** Maturation speed multiplier (1 = full, down to the penalty floor). */
  matureRate: number;
  immatureCount: number;
}

export interface DrakeNutritionState {
  satisfaction: Record<Axis, number>;
  requirement: Record<Axis, number>;
  /** Clutch-rate (breeding speed) multiplier (1 = full, down to the penalty floor). */
  breedRate: number;
  drakeCount: number;
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

// ── Breeding rework: the hidden 6-gene genome ────────────────────────
/** A single gene: Lay, Vigor, Hardy, or Dud. */
export type Gene = 'L' | 'V' | 'H' | 'D';
export const GENES: Gene[] = ['L', 'V', 'H', 'D'];
/** A duck's heritable quality: GENOME.SLOTS genes, position-linked. */
export type Genome = Gene[];

export interface Duck {
  id: string;
  genotype: Genotype;
  /** Heritable quality (throughput only) — drives stats via the gene profile.
   *  Replaces the old vigor scalar. See game/genetics.ts. */
  genome: Genome;
  /** Whether this duck's genome has been read (gene-reader). Hidden ("?") until
   *  true; phone-it-in pairing works off visible colour without ever reading. */
  genomeKnown?: boolean;
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
  /** What inflicted the wound — so the away summary attributes it correctly (an
   *  owl attack vs flock overcrowding), rather than blaming everything on the owl. */
  woundSource?: 'predator' | 'overcrowd';
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

/** How many module-rack sockets the homestead has (grows with rank, capped). */
export function rackSockets(state: GameState): number {
  const R = BALANCE.LOOT.RACK;
  return Math.min(R.maxSockets, R.baseSockets + Math.floor((state.rank - 1) / R.ranksPerSocket));
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
/** Adult drakes — breeding males that eat the maintenance ration (no calcium). */
export const adultDrakes = (state: GameState): Duck[] =>
  state.ducks.filter((d) => d.stage === 'adult' && d.sex === 'drake');

/** Flock RATIO health: adult hen/drake counts vs the ideal drake:hen ratio. Past
 *  the flock-size gate, drakes beyond `maxHealthyDrakes` are `excess` and the
 *  flock is `injuring` (overcrowding stress accrues). Pure read — drives the sim,
 *  the Flock Health card, and the Flock-button warning. */
export function flockRatio(state: GameState): {
  hens: number;
  drakes: number;
  flock: number;
  gated: boolean;
  maxHealthyDrakes: number;
  excess: number;
  injuring: boolean;
} {
  const B = BALANCE.BREEDING;
  // Single pass — counts only, no intermediate arrays (runs every tick + render).
  // SECURED ducks are in separate housing, not part of the free-roaming flock, so
  // they don't count toward the over-ratio (and can't be injured/culled by it —
  // counting them would make the injuries permanently unfixable).
  let hens = 0;
  let drakes = 0;
  for (const d of state.ducks) {
    if (d.stage !== 'adult' || d.secured) continue;
    if (d.sex === 'hen') hens++;
    else if (d.sex === 'drake') drakes++;
  }
  const flock = state.ducks.length;
  // An over-drake flock only ever arises from breeding, so gate on that too (also
  // keeps a tiny seeded/un-bred flock — and isolated tests — free of ratio stress).
  const gated = flock >= B.OVERCROWD_MIN_FLOCK && breedingEstablished(state);
  const maxHealthyDrakes = Math.max(1, Math.floor(hens / B.IDEAL_HENS_PER_DRAKE));
  const excess = Math.max(0, drakes - maxHealthyDrakes);
  return { hens, drakes, flock, gated, maxHealthyDrakes, excess, injuring: gated && excess > 0 };
}
/** Breeding is "established" — the drake ration only kicks in past this so a
 *  cold-start flock is never taxed. True once the gene reader is built or any
 *  pairing has been made. */
export const breedingEstablished = (state: GameState): boolean =>
  state.geneReader || state.breedingPairs.length > 0;

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
  /** Maintenance ration fed to adult drakes (gates breeding speed, no calcium). */
  drakeRation: Record<Ingredient, number>;
  /** Derived drake-nutrition snapshot (recomputed each tick). */
  drakeNutrition?: DrakeNutritionState;
  /** Flock condition reserve (0..CONDITION_MAX) — the battery that buffers
   *  shortfalls and powers offline. */
  condition: number;
  /** Seconds of sustained niacin shortfall accrued toward the next leg debuff. */
  niacinShortfall: number;
  /** Overcrowding stress accrued toward the next ratio-injury (over-drake flock). */
  overcrowdStress: number;
  /** Seconds left of "active" play (any recent action refreshes it). While > 0 the
   *  player is clearly here, so predator dives drop the passive floor and demand an
   *  active scare. Runtime-only — starts at 0 (guard) on load. */
  activeRemaining: number;
  /** Global cooldown (s) on the active "Dose Brewer's Yeast" intervention. */
  doseCooldownRemaining: number;
  /** Derived nutrition snapshot (recomputed each tick; not authoritative). */
  nutrition?: NutritionState;

  // ── Phase 3: loot ──
  /** Spare modules held in stock (not installed). */
  inventory: Module[];
  /** The homestead module RACK: installed modules, each applying to its whole
   *  category. Length is bounded by rackSockets(state). */
  rack: Module[];
  /** Reroll currency from salvaging modules. */
  dust: number;
  /** Monotonic id counter for modules. */
  nextModuleId: number;
  /** Auto-fill optimizer's per-stat priority weights (the live STAT_VALUE). Set by
   *  a playstyle preset or hand-edited. Pure assist heuristic — never the sim. */
  statWeights: Record<ModuleStat, number>;
  /** Which playstyle preset is selected ('custom' once the weights are hand-edited). */
  statWeightPreset: string;

  // ── Phase 4a: breeding ──
  /** The flock — individual ducks (housed up to coopCapacity). */
  ducks: Duck[];
  /** Monotonic id counter for ducks. */
  nextDuckId: number;
  /** Active breeding pairs. */
  breedingPairs: BreedingPair[];
  /** Monotonic id counter for pairs. */
  nextPairId: number;
  /** The god-clone target profile the player steers toward (length GENOME.SLOTS).
   *  Drives genome-quality progress + the Legacy Score. */
  genomeTarget: Genome;
  /** Whether the gene-reader is built (reveals genomes passively/in bulk). */
  geneReader: boolean;
  /** Transient: god-clone hatches this tick (drained by the engine for DINGs). */
  pendingGodClone?: number;
  /** Colors ever produced (the dex) — drives first-of-color DINGs. */
  dexSeen: Color[];
  /** Transient: colors discovered this tick, drained by the engine for DINGs. */
  pendingDex?: Color[];

  // ── Phase 4b: zones ──
  /** Per-zone dynamic state, keyed by zone id (defs live in config/balance). */
  zones: Record<string, ZoneState>;

  // ── THE WATER SYSTEM: one shared canvas, two staged unlocks ──
  /** The Pond layout features + the Waterworks circulation features + per-feature
   *  freshness. Drives flock WELLNESS ONLY (provision → condition + wound timer);
   *  never income, never a nutrition axis. See game/pond.ts + game/water.ts. */
  pond: PondState;

  // ── Phase 4c: predators (the risk layer) ──
  /** Per-predator window/schedule state, keyed by predator id (defs in config). */
  predators: Record<string, PredatorState>;
  /** Built deterrents (count) — each raises the homestead-wide protection floor. */
  deterrents: number;
  /** Deterrent integrity (0..1): the floor scales with it. Worn by threat windows
   *  + breaches; restored by the Repair action. The defense upkeep loop. */
  deterrentIntegrity: number;

  // ── Phase 4c: secure housing ──
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
  /** Monotonic counter for telegraphed strikes, so each dive carries a distinct
   *  id the UI can key its swoop animation on. Runtime-only. */
  predatorStrikeSeq?: number;

  // ── Phase 4e: prestige (META — the ONLY state that survives a reset) ──
  /** Times prestiged. Drives the current Legacy Score threshold. */
  legacyTier: number;
  /** Spendable legacy currency (earned at prestige, spent in the legacy shop). */
  legacyCurrency: number;
  /** Purchased global-scalar boost levels, keyed by boost id. */
  purchasedBoosts: Record<string, number>;
  /** Memorial snapshots of each champion flock that earned a prestige (display only). */
  legacyHall: ChampionSnapshot[];

  /** Wall-clock ms of last save; used for offline catch-up on load. */
  lastSeen: number;
}

/** A frozen record of the champion flock that earned a prestige. No mechanical
 *  effect — the Legacy Hall sendoff for a wiped flock. */
export interface ChampionSnapshot {
  /** The legacy tier this prestige earned. */
  tier: number;
  /** Average flock genome quality (mean slots matching target) at reset. */
  meanQuality: number;
  /** Best genome quality in the flock (most slots matching target). */
  bestQuality: number;
  flockSize: number;
  /** Colors the flock had achieved (the dex at reset). */
  colors: Color[];
  /** Wall-clock ms at prestige. */
  timestamp: number;
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
  /** Online only: an in-flight, telegraphed strike — the owl is visibly diving at
   *  a duck and will land when the wind-up expires unless the player scares it.
   *  Never set offline (catch-up resolves immediately) and dropped on load, so it
   *  is pure runtime feedback, never authoritative. */
  strike?: PendingStrike;
}

/** A telegraphed strike mid-dive: which duck, and how long until it lands. The
 *  reaction window for the active scare (clicking the owl). */
export interface PendingStrike {
  /** The duck being dived on (re-validated at landing — it may slip away). */
  targetId: string;
  /** Seconds left before the strike lands (counts down). Reset on each feint. */
  windupRemaining: number;
  /** The full wind-up duration (for the UI dive progress). */
  windupTotal: number;
  /** Monotonic id so the UI can key one dive's animation distinctly from the next. */
  id: number;
  /** Which dive spot (0..STRIKE_DIVE_SPOTS-1) the owl is currently diving at. */
  spot: number;
  /** How many scare clicks it takes to foil this strike (1..3). */
  clicksRequired: number;
  /** Clicks landed so far; at clicksRequired the strike is foiled, else a feint. */
  clicksLanded: number;
}

/** Transient predator events for UI feedback + the away summary. Not authoritative. */
export type PredatorEvent =
  | { kind: 'introduced' }
  | { kind: 'incoming'; predatorId: string }
  | { kind: 'open'; predatorId: string }
  // The owl committed a dive (online): the telegraphed wind-up began — scare it!
  | { kind: 'winding'; predatorId: string; duckId: string }
  // A non-final scare click: the owl juked to another spot and re-dove (not done yet).
  | { kind: 'feint'; predatorId: string; duckId: string }
  // The player scared the owl off mid-dive: the strike was foiled (no wound).
  | { kind: 'scared'; predatorId: string; duckId: string }
  // An over-drake flock injured one of its own (overcrowding — not a predator).
  | { kind: 'crowdInjury'; duckId: string }
  | { kind: 'wound'; predatorId: string; duckId: string }
  | { kind: 'snatched'; predatorId: string; duckId: string }
  | { kind: 'escalated'; duckId: string; source?: 'predator' | 'overcrowd' };

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

/** Homestead-wide protection floor from built deterrents (capped), scaled by their
 *  integrity. Passive and offline-safe, but it WEARS — a neglected floor sags
 *  toward zero, so it must be repaired to keep its full value. */
export function defenseFloor(state: GameState): number {
  const P = BALANCE.PREDATORS;
  const raw = state.deterrents * P.DEFENSE_FLOOR_PER_DETERRENT * state.deterrentIntegrity;
  return Math.min(P.DEFENSE_FLOOR_CAP, raw);
}

/** Mutable per-zone state (the static shape lives in ZONE_DEFS). */
export interface ZoneState {
  unlocked: boolean;
}

/** Fresh zone state from the defs: a zone starts unlocked iff it has no gate. */
export function initialZones(): Record<string, ZoneState> {
  const zones: Record<string, ZoneState> = {};
  for (const def of ZONE_DEFS) zones[def.id] = { unlocked: !def.unlock };
  return zones;
}

// ── THE WATER SYSTEM: the shared pond canvas ─────────────────────────
/** Stage 1 (Pond) provision features — arrangement drives `layoutBase`. */
export type PondFeatureType = 'spring' | 'bathingPool' | 'plantBed' | 'deepZone';
/** Stage 2 (Waterworks) circulation features — coverage drives `circulationHealth`. */
export type FlowFeatureType = 'intake' | 'fountain' | 'outflow';

export interface PondFeature {
  x: number;
  y: number;
  type: PondFeatureType;
  /** Upgrade level (1 = placed). Each level scales the feature's provision — the
   *  pre-prestige egg sink that grows water past the fixed-canvas layout ceiling.
   *  Optional so pre-upgrade saves load as level 1. */
  level?: number;
}
export interface FlowFeature {
  x: number;
  y: number;
  type: FlowFeatureType;
}

/**
 * The water canvas state. Both zone tabs edit the SAME coordinate space:
 * `features` is the Pond layout (provision); `flow` is the Waterworks
 * circulation (coverage). `freshness` is the ONE upkeep accumulator — per
 * provision-feature 0..1 (1 = fresh/peak), pushed down by fouling and held up
 * by circulation coverage. No income, no nutrition axis, ever.
 */
export interface PondState {
  features: PondFeature[];
  flow: FlowFeature[];
  /** Per provision-feature freshness 0..1, keyed "x,y". */
  freshness: Record<string, number>;
}

export function initialPond(): PondState {
  return { features: [], flow: [], freshness: {} };
}

/** Cell key helper for the water canvas (and the legacy irrigation grid). */
export const cellKey = (x: number, y: number): string => `${x},${y}`;

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
    // Rations start EMPTY — nothing is silently drained before the player has set
    // a ration. The Nutrition panel flags an unset ration and offers a one-tap
    // "Suggested" fill (the balanced defaults live in BALANCE for that).
    ration: zeroRation(),
    ducklingRation: zeroRation(),
    drakeRation: zeroRation(),
    condition: BALANCE.NUTRITION.CONDITION_MAX,
    niacinShortfall: 0,
    overcrowdStress: 0,
    activeRemaining: 0,
    doseCooldownRemaining: 0,
    inventory: [],
    rack: [],
    dust: 0,
    nextModuleId: 1,
    statWeights: { ...DEFAULT_STAT_WEIGHTS } as Record<ModuleStat, number>,
    statWeightPreset: 'balanced',
    ducks: [],
    nextDuckId: 1,
    breedingPairs: [],
    nextPairId: 1,
    genomeTarget: [...BALANCE.GENOME.DEFAULT_TARGET],
    geneReader: false,
    dexSeen: [],
    zones: initialZones(),
    pond: initialPond(),
    predators: initialPredators(),
    deterrents: 0,
    deterrentIntegrity: 1,
    secureCoops: 0,
    predatorsIntroduced: false,
    legacyTier: 0,
    legacyCurrency: 0,
    purchasedBoosts: {},
    legacyHall: [],
    lastSeen: now,
  };
}

/** Roll one seed-flock genome: each slot a gene drawn from the Dud-leaning seed
 *  weights, so a fresh flock is middling with real room to breed up. */
function rollSeedGenome(): Genome {
  const w = BALANCE.GENOME.SEED_GENE_WEIGHTS;
  const total = GENES.reduce((a, g) => a + (w[g] ?? 0), 0);
  const genome: Genome = [];
  for (let i = 0; i < BALANCE.GENOME.SLOTS; i++) {
    let r = Math.random() * total;
    let pick: Gene = GENES[GENES.length - 1];
    for (const g of GENES) {
      r -= w[g] ?? 0;
      if (r < 0) {
        pick = g;
        break;
      }
    }
    genome.push(pick);
  }
  return genome;
}

/**
 * Seed the starting flock into the first coop: a few Blue carriers (Bl/bl) so
 * the player can breed out all three colors, with a mixed (middling) genome.
 * Mutates state.
 */
export function seedFlock(state: GameState): void {
  const B = BALANCE.BREEDING;
  const make = (sex: Sex): Duck => ({
    id: `d${state.nextDuckId++}`,
    genotype: ['Bl', 'bl'],
    genome: rollSeedGenome(),
    genomeKnown: false, // hidden until a gene-reader is built
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
