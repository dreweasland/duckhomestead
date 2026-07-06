import {
  BALANCE,
  DEFAULT_STAT_WEIGHTS,
  PREDATOR_DEFS,
  ZONE_DEFS,
  zoneDef,
  type DefenseType,
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
  | 'sunflowerSeeds' // Phase 6d: Winterstead's energy-rich line
  | 'fodderSprouts' // Phase 6d: Winterstead's multi-axis overlap line
  | 'forage'
  | 'pellets'
  | 'eggs';

export type Resources = Record<Resource, number>;

/** The nutrition ingredients (overlapping axis matrix lives in balance.ts).
 *  The last two are Winterstead's local lines (6d) — producible only there,
 *  but usable in ANY ration (one shared storage; overlap is the point). */
export const INGREDIENTS = [
  'corn',
  'peas',
  'mealworms',
  'brewersYeast',
  'oysterShell',
  'sunflowerSeeds',
  'fodderSprouts',
] as const;
export type Ingredient = (typeof INGREDIENTS)[number];

/** The per-ingredient storage cap: a base cushion + every placed SILO's
 *  capacity (standard uncapped upgrade curve — the capacity ladder). Eggs are
 *  currency and never capped. Stock above the cap (a pre-Feed-Store save, or a
 *  demolished silo) is grandfathered: adds clamp, existing stock drains
 *  normally — never confiscated. */
export function ingredientCap(state: GameState): number {
  const S = BALANCE.STORAGE;
  let cap = S.BASE_CAP;
  for (const st of state.stations) {
    if (st.type === 'silo') {
      cap += S.CAP_PER_SILO * Math.pow(BALANCE.UPGRADE.outputMultPerLevel, st.level - 1);
    }
  }
  return Math.round(cap);
}

/** Add to storage, clamping INGREDIENTS at the Feed Store cap (overflow is
 *  discarded — a full store simply can't take more). Eggs and legacy resources
 *  pass through uncapped. The ONE accrual choke point for hauls/collects. */
export function addResource(state: GameState, res: Resource, amount: number): void {
  if (amount <= 0) return;
  if ((INGREDIENTS as readonly string[]).includes(res)) {
    const cap = ingredientCap(state);
    state.resources[res] = Math.min(Math.max(state.resources[res], cap), state.resources[res] + amount);
    // (max() grandfathers over-cap legacy stock: never confiscate, never add.)
    return;
  }
  state.resources[res] += amount;
}

/** An all-zero ration (the empty starting point — nothing fed until the player sets it). */
export const zeroRation = (): Record<Ingredient, number> =>
  ({ corn: 0, peas: 0, mealworms: 0, brewersYeast: 0, oysterShell: 0, sunflowerSeeds: 0, fodderSprouts: 0 });
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
  /** Egg multiplier actually applied (raw, buffered by flock condition, then
   *  shaved by the stress throttle when the flock is rattled). */
  eggMult: number;
  /** The stress throttle actually applied this tick (1 = calm/fed; < 1 = a
   *  rattled flock laying slower on a green ration). For the "rattled" UI read. */
  stressMult: number;
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

/** Phase 6d: derived Winterstead snapshot (recomputed each tick; undefined when
 *  no hens are assigned). Mirrors the other pools — the winter dashboard's read. */
export interface WinterNutritionState {
  satisfaction: Record<Axis, number>;
  requirement: Record<Axis, number>;
  /** Winter output multiplier from nutrition alone (floor..1). */
  eggMult: number;
  /** Live premium winter lay, eggs/sec (after warmth/support/premium). */
  eggRate: number;
  henCount: number;
  /** Mean warmth factor across occupied winter coops (COLD_FLOOR..1). Step 3. */
  warmth: number;
  /** Heated-waterer support factor (WATERER_FLOOR..1). Step 3. */
  support: number;
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
/** A single gene: Lay, Vigor, Hardy, Dud, or (Phase 6c) the mutation-only Prime
 *  wildcard. `P` is never seeded, never a hatch-spec/target gene — see
 *  BALANCE.GENOME.PRIME_MIN_TIER and genetics.ts's breedGenome/targetMatch. */
export type Gene = 'L' | 'V' | 'H' | 'D' | 'P';
export const GENES: Gene[] = ['L', 'V', 'H', 'D', 'P'];
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
  /** Injury severity, rolled when the wound lands — drives recovery time (worse when
   *  the hit landed with defenses down; milder for Hardy ducks). */
  severity?: WoundSeverity;
  /** A player-given name (opt-in, adults you care about — breeders, truebreds).
   *  Named ducks get STORIES: their harm events toast by name, and the away
   *  summary lists them. Unnamed ducks stay compact rows. Max ~16 chars. */
  name?: string;
  /** Phase 6d: where this duck lives. Absent/'home' = the main homestead;
   *  'winter' = assigned to Winterstead — it then feeds/lays via the WINTER pool
   *  and is ELSEWHERE for every home system (predators, overcrowding, water,
   *  home housing). Adults-only; set by assign/recall. */
  site?: 'home' | 'winter';
  /** In an Infirmary recovery slot: healing over time, holds a slot, eats extra feed,
   *  lays nothing, and no longer escalates. Set by Admit; cleared when recovered. */
  recovering?: boolean;
  /** Seconds accrued toward this recovery (vs the severity's RECOVERY_SEC). */
  recoveryElapsed?: number;
}

export type WoundSeverity = 'minor' | 'serious' | 'critical';

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

/** Condition-stress drain (playtest rework): harm events knock a chunk off the
 *  flock-condition battery — see BALANCE.NUTRITION.STRESS. Every call site is a
 *  VISIBLE event (wound / overcrowd injury / permanent loss), so a low battery
 *  is always attributable. Lives here (zero-dep) so predators/breeding can call
 *  it without touching nutrition's import graph. */
export function drainCondition(state: GameState, amount: number): void {
  state.condition = Math.max(0, state.condition - amount);
}

/** Phenotype from genotype: blue-allele count -> color. */
export function phenotype(g: Genotype): Color {
  const blue = (g[0] === 'Bl' ? 1 : 0) + (g[1] === 'Bl' ? 1 : 0);
  return blue === 0 ? 'black' : blue === 1 ? 'blue' : 'splash';
}

/** How many module-rack sockets the homestead has (grows with rank, capped). */
export function rackSockets(state: GameState): number {
  const R = BALANCE.LOOT.RACK;
  const base = Math.min(R.maxSockets, R.baseSockets + Math.floor((state.rank - 1) / R.ranksPerSocket));
  return base + (state.rank >= R.bonusSocketRank ? 1 : 0);
}

/** Total housing across all coops (capacity scales with coop level). */
export function coopCapacity(state: GameState): number {
  return state.stations
    .filter((s) => s.type === 'coop')
    .reduce((a, c) => a + BALANCE.BREEDING.COOP_CAPACITY * c.level, 0);
}

export const isAdult = (d: Duck): boolean => d.stage === 'adult';
/** Phase 6d: true when a duck lives at the main homestead (not winter-assigned).
 *  Every HOME pool/system filters on this — a winter duck is elsewhere. */
export const atHome = (d: Duck): boolean => d.site !== 'winter';
/** Adult hens AT HOME — the laying population that drives home egg output. */
export const adultLayers = (state: GameState): Duck[] =>
  state.ducks.filter((d) => d.stage === 'adult' && d.sex === 'hen' && atHome(d));
/** All adult ducks AT HOME — what the layer ration must feed. */
export const adultDucks = (state: GameState): Duck[] =>
  state.ducks.filter((d) => isAdult(d) && atHome(d));
/** Adult drakes — breeding males that eat the maintenance ration (no calcium).
 *  Drakes are never winter-assignable, but filter defensively. */
export const adultDrakes = (state: GameState): Duck[] =>
  state.ducks.filter((d) => d.stage === 'adult' && d.sex === 'drake' && atHome(d));

// ── Phase 6d: Winterstead selectors ──────────────────────────────────
/** Adult hens assigned to Winterstead — the WINTER pool (feed + premium lay). */
export const winterHens = (state: GameState): Duck[] =>
  state.ducks.filter((d) => d.stage === 'adult' && d.sex === 'hen' && d.site === 'winter');
/** Winter housing: assigned ducks per winter coop (flat — no upgrades in v1). */
export function winterCapacity(state: GameState): number {
  return (
    state.stations.filter((s) => s.type === 'winterCoop').length *
    BALANCE.WINTER.STATIONS.winterCoop.capacity
  );
}
/** Winter ducks supported by heated waterers (their water; the pond is frozen). */
export function watererSupport(state: GameState): number {
  return (
    state.stations.filter((s) => s.type === 'heatedWaterer').length *
    BALANCE.WINTER.STATIONS.heatedWaterer.supports
  );
}

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
    // Secured ducks are in separate housing; winter-assigned ducks (6d) are at
    // another SITE — neither is part of the free-roaming home flock. (Yes, that
    // means wintering your hens worsens the home drake:hen ratio — honestly.)
    if (d.stage !== 'adult' || d.secured || !atHome(d)) continue;
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
  /** Phase 6d: the Winterstead ration (per winter hen per coop-cycle) — the 4th
   *  pool, drawing from the SAME shared storage, and it eats LAST. */
  winterRation: Record<Ingredient, number>;
  /** Derived Winterstead snapshot (recomputed each tick). */
  winter?: WinterNutritionState;
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
  /** The player's TRACKING target (length GENOME.SLOTS) — a browser/sort/preview
   *  aid only. The champion gate, currency, and truebred DING read the
   *  tier-authoritative targetForTier() instead (see prestige.ts), so pointing
   *  this at the flock's existing profile can't game the gate. */
  genomeTarget: Genome;
  /** Whether the gene-reader is built (reveals genomes passively/in bulk). */
  geneReader: boolean;
  /** Transient: truebred hatches this tick (drained by the engine for DINGs). */
  pendingTruebred?: number;
  /** Transient: full-Prime (PPPPPP) hatches this tick — THE PRIME DUCK, the
   *  rarest hatch in the game. Drained by the engine for its own DING. */
  pendingPrimeDuck?: number;
  /** Transient: a truebred hatched carrying a NEW BEST Prime-wildcard count
   *  for the flock (the value = that count) — a rung on the Prime chase's
   *  celebration ladder. Drained by the engine. */
  pendingPrimeTruebred?: number;
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
  /** Phase 5 juice (water assessment fix ③): which tier's terrain (blocked
   *  rocks/reeds) applies to THIS run's pond canvas. Stamped at prestige, not
   *  read live off `legacyTier` — so a save from before this field existed
   *  (default 0 ⇒ the open canvas) never has its already-placed features
   *  retroactively sit on a newly-blocked tile. See game/pond.ts's
   *  terrainForTier(). */
  pondTerrainTier: number;

  // ── Phase 4c: predators (the risk layer) ──
  /** Per-predator window/schedule state, keyed by predator id (defs in config). */
  predators: Record<string, PredatorState>;
  /** Built deterrents (count) — each raises the homestead-wide protection floor. */
  deterrents: number;
  /** Deterrent integrity (0..1): the floor scales with it. Worn by threat windows
   *  + breaches; restored by the Repair action. The defense upkeep loop. */
  deterrentIntegrity: number;
  /** Hardware cloth — the GROUND defense line (vs the raccoon). A separate pool from
   *  nets, with its own integrity + upkeep. */
  hardwareCloth: number;
  hardwareClothIntegrity: number;
  /** Predator ids that have DEBUTED (been seen online). Drives the "no bolt from the
   *  blue" grace for later predators (the raccoon) just as predatorsIntroduced does
   *  for the owl. */
  predatorsSeen?: string[];

  // ── Phase 4c: secure housing ──
  /** Built Secure Coops (count) — each adds SECURE_SLOTS_PER_COOP secure slots. */
  secureCoops: number;
  /** Built infirmaries — each adds INFIRMARY.SLOTS_PER recovery slots. */
  infirmaries: number;
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
  /** Phase 6c: consecutive FLAWLESS jackpot-eligible siege windows this run (a
   *  landed hit voids the current window's jackpot AND resets this to 0). At
   *  def.jackpot.streakForLegendary it upgrades the grant to the streak rarity.
   *  Resets to 0 on prestige for free (a fresh initialState omits it). */
  predatorFlawlessStreak?: number;
  /** THE PAIRED HUNT (rank ladder): the coordinated-window clock. Run-scoped;
   *  ticks online only (an active set-piece). */
  pairedHunt?: { timeToNext: number; active: boolean; remaining: number; harmed: boolean };

  // ── Phase 4e: prestige (META — the ONLY state that survives a reset) ──
  /** Times prestiged. Drives the current Legacy Score threshold. */
  legacyTier: number;
  /** Spendable legacy currency (earned at prestige, spent in the legacy shop). */
  legacyCurrency: number;
  /** Purchased global-scalar boost levels, keyed by boost id. */
  purchasedBoosts: Record<string, number>;
  /** Memorial snapshots of each champion flock that earned a prestige (display only). */
  legacyHall: ChampionSnapshot[];

  // ── Phase 6b: The Grange (contracts board, unlocks at legacy tier 1) ──
  /** The rotating offer board + at most one active contract. Wiped by prestige
   *  (composed fresh in initialState()) exactly like every other run field. */
  contracts: ContractsState;
  /** Transient: delivery contracts that hit their deadline this tick, drained by
   *  the engine for a quiet "contract expired" toast. Only ever set online
   *  (expiry clocks are online-only), so it can't accrue during catch-up. */
  pendingContractExpired?: number;

  // ── Phase 5 juice: water attribution beats (assessment fix ①, pure UI over
  // existing water math — see game/water.ts) ──
  /** Transient: infirmary admissions that beat the escalation clock while the
   *  pond ran above par, drained by the engine for a "seconds bought" toast.
   *  Set only by the live admit action (never during offline catch-up). */
  pendingWoundSaved?: { spareSec: number; boughtSec: number }[];

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
  /** This run bred THE PRIME DUCK (a full-PPPPPP hatch) — remembered forever. */
  primeDuck?: boolean;
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
  /** How many attacks THIS window will bring — rolled hidden when it opens (from the
   *  def's attackCountWeights). Absent → the def's fixed attacksPerWindow. */
  windowAttacks?: number;
  /** Online only: an in-flight, telegraphed strike — the owl is visibly diving at
   *  a duck and will land when the wind-up expires unless the player scares it.
   *  Never set offline (catch-up resolves immediately) and dropped on load, so it
   *  is pure runtime feedback, never authoritative. */
  strike?: PendingStrike;
  /** Phase 6c (jackpot-eligible predators only, i.e. def.jackpot is set): dives
   *  committed / landed THIS window, reset when the window opens. A window
   *  closing with ≥1 committed dive and zero landed is a flawless defense — the
   *  jackpot grant. Unused (stays undefined) for non-jackpot predators. */
  jackpotDives?: number;
  jackpotLanded?: number;
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
  | { kind: 'introduced'; predatorId?: string }
  | { kind: 'incoming'; predatorId: string }
  | { kind: 'open'; predatorId: string }
  // The owl committed a dive (online): the telegraphed wind-up began — scare it!
  | { kind: 'winding'; predatorId: string; duckId: string }
  // A non-final scare click: the owl juked to another spot and re-dove (not done yet).
  | { kind: 'feint'; predatorId: string; duckId: string }
  // The player scared the owl off mid-dive: the strike was foiled (no wound).
  | { kind: 'scared'; predatorId: string; duckId: string }
  // An over-drake flock injured one of its own (overcrowding — not a predator).
  // duckName rides along when the victim is player-named (captured at emit time —
  // a lost duck is removed from state before the engine drains the event).
  | { kind: 'crowdInjury'; duckId: string; duckName?: string }
  | { kind: 'wound'; predatorId: string; duckId: string; duckName?: string }
  | { kind: 'snatched'; predatorId: string; duckId: string; duckName?: string }
  // The two formerly-INVISIBLE strike outcomes (pure feedback, no mechanics):
  // the built floor/presence beat the attack, or a Hardy duck shrugged the hit.
  | { kind: 'repelled'; predatorId: string; duckId: string }
  | { kind: 'shrugged'; predatorId: string; duckId: string; duckName?: string }
  | { kind: 'escalated'; duckId: string; source?: 'predator' | 'overcrowd'; duckName?: string }
  // Phase 6c: a jackpot-eligible siege window closed flawless (≥1 committed
  // dive, zero landed) — grantModule already ran sim-side; the engine drain
  // surfaces this as the loot banner (the module is already in state.inventory).
  | { kind: 'siegeFoiled'; predatorId: string; dust: number; moduleId: string }
  // THE PAIRED HUNT (rank ladder): the coordinated owl+raccoon window.
  | { kind: 'huntBegins' }
  | { kind: 'huntFoiled'; dust: number; moduleId: string };

// ── Phase 8: THE GRANGE 2.0 (contracts become JOBS) ───────────────────
/** The three contract shapes — a discriminated union so a new type later is a
 *  new generator, not new architecture. See game/contracts.ts. Phase 8 retired
 *  the old `delivery` (egg-banking receipt) and `hatch` (spammable-by-mass-
 *  breeding bounty) shapes for `order` and `provision` — jobs that cost a real
 *  detour, never a receipt for default play. */
export type ContractType = 'order' | 'provision' | 'defense';

/** Dust (the bulk) + a small legacy-shard trickle; a module only at the top
 *  difficulty notch. NEVER eggs/resources/XP — the online-only law's payout side. */
export interface ContractReward {
  dust: number;
  shards: number;
  moduleRarity?: Rarity;
}

interface ContractCommon {
  id: string;
  /** Difficulty notch this contract rolled (0..NOTCH_WEIGHTS.length-1) — sets
   *  its reward band and, per type, its constraint-count/amount/scare-count. */
  notch: number;
  reward: ContractReward;
  /** True once the active contract's goal has been met — awaiting Claim. */
  completed: boolean;
}

/**
 * A duck bred to the Grange's spec, delivered (removed from the flock) in
 * exchange for the reward. `constraints` (length GENOME.SLOTS; null =
 * unconstrained) always CONTRADICT `target` at every constrained slot — the
 * generator snapshots `target` (the tier Standard at generation time) and
 * picks a DIFFERENT {L,V,H} gene there, so a Standard-line pair can never
 * fill the order by accident (see contracts.ts generateOrder). Higher notches
 * also raise `minTargetQuality`, a floor on how many of the UNCONSTRAINED
 * slots must still match `target` — the order wants odd blood, not junk.
 */
/** One line item of a breeding commission: N ducks of a color+sex. */
export interface OrderLine {
  color: Color;
  sex: 'hen' | 'drake';
  count: number;
}

export interface OrderContract extends ContractCommon {
  type: 'order';
  /** 1–3 distinct color+sex line items (see contracts.ts generateOrder). */
  lines: OrderLine[];
  /** Every delivered duck must match the generation-time Standard at ≥ this
   *  many slots — good fresh stock, not junk in the right feathers. */
  minQuality: number;
  /** The target snapshotted at generation (quality is scored against it). */
  target: Genome;
  /** Only ducks hatched AFTER acceptance count: their numeric id must be ≥
   *  this snapshot of nextDuckId (set in acceptContract; -1 = not yet
   *  accepted, under which nothing is eligible — JSON-safe sentinel). */
  sinceDuckId: number;
}

/** Hand over a fixed amount of one produced ingredient from central storage —
 *  the Feed Store's first customer. Amount is priced off the player's OWN
 *  production rate at generation (see contracts.ts generateProvision), capped
 *  well under the Feed Store ceiling so it's always fulfillable with silo
 *  investment, never a request for more than the store could ever hold. */
export interface ProvisionContract extends ContractCommon {
  type: 'provision';
  ingredient: Ingredient;
  amount: number;
  /** Seconds left once ACCEPTED (0 while still just an offer). */
  limitRemaining: number;
}

/** Prove the watch: foil `scareTarget` committed dives (the 'scared' event)
 *  without a landed injury ('wound'/'snatched' resets progress to 0). */
export interface DefenseContract extends ContractCommon {
  type: 'defense';
  scareTarget: number;
  scareProgress: number;
}

export type Contract = OrderContract | ProvisionContract | DefenseContract;

/** The board: a few open offers + at most ONE active contract (choosing which
 *  offer to run is the decision). Wiped by prestige (part of initialState()). */
export interface ContractsState {
  offers: Contract[];
  active: Contract | null;
  /** Monotonic id counter for contracts. */
  nextContractId: number;
  /** Seconds until every offer fully refreshes (a manual reroll is separate,
   *  costs dust, and doesn't reset this timer). */
  refreshRemaining: number;
  /** The run's PEAK egg rate (home + winter, eggs/sec) — the honest base clutch
   *  costs (breeding.ts), net pricing, and pond upgrade costs price against, so
   *  a parked/throttled flock can't talk its way down to the floor. Survived
   *  Phase 8's egg-delivery retirement (it's hoisted above the tier gate in
   *  runContracts on purpose). Updated online-only; wiped with the run by prestige. */
  peakEggRate?: number;
}

export function initialContracts(): ContractsState {
  return {
    offers: [],
    active: null,
    nextContractId: 1,
    refreshRemaining: BALANCE.CONTRACTS.OFFER_REFRESH_S,
    peakEggRate: 0,
  };
}

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
  const P = BALANCE.PREDATORS;
  if (state.secureCoops <= 0) return 0;
  // First coop = SECURE_SLOTS_PER_COOP; each additional = SECURE_SLOTS_ADDITIONAL.
  return P.SECURE_SLOTS_PER_COOP + (state.secureCoops - 1) * P.SECURE_SLOTS_ADDITIONAL;
}

/** Total recovery slots across all built infirmaries. */
export function infirmaryCapacity(state: GameState): number {
  return state.infirmaries * BALANCE.PREDATORS.INFIRMARY.SLOTS_PER;
}

/** How many recovery slots are currently occupied (ducks mid-recovery). */
export function infirmaryOccupied(state: GameState): number {
  let n = 0;
  for (const d of state.ducks) if (d.recovering) n++;
  return n;
}

/** Escalating build cost: the (built+1)th defense of a kind costs base ×
 *  DEFENSE_COST_GROWTH^built — so each additional one is a real decision.
 *  Right for CAPPED goods (secure coops, infirmaries — bounded demand). */
function defenseBuildCost(base: number, built: number): number {
  return Math.round(base * Math.pow(BALANCE.PREDATORS.DEFENSE_COST_GROWTH, built));
}

/** Net/cloth build cost: coverage made these FLOCK-PROPORTIONAL (+15 ducks
 *  each, linearly), so past the knee the price is seconds of the run's peak
 *  egg rate — constant benefit, constant effort — instead of a geometric
 *  curve that walls a big flock (see DEFENSE_COST_KNEE in balance.ts). */
function coverageBuildCost(state: GameState, base: number, built: number): number {
  const P = BALANCE.PREDATORS;
  const flat = base * Math.pow(P.DEFENSE_COST_GROWTH, Math.min(built, P.DEFENSE_COST_KNEE));
  const peak = (state.contracts.peakEggRate ?? 0) * P.DETERRENT_BUY_PEAK_SECONDS;
  return Math.round(built < P.DEFENSE_COST_KNEE ? flat : Math.max(flat, peak));
}
export const deterrentCost = (state: GameState): number =>
  coverageBuildCost(state, BALANCE.PREDATORS.DETERRENT_COST_EGGS, state.deterrents);
export const hardwareClothCost = (state: GameState): number =>
  coverageBuildCost(state, BALANCE.PREDATORS.HARDWARE_CLOTH_COST_EGGS, state.hardwareCloth);
export const secureCoopCost = (state: GameState): number =>
  defenseBuildCost(BALANCE.PREDATORS.SECURE_COOP_COST_EGGS, state.secureCoops);
export const infirmaryCost = (state: GameState): number =>
  defenseBuildCost(BALANCE.PREDATORS.INFIRMARY.COST_EGGS, state.infirmaries);

/** The ducks a defense line must actually cover: home (winter has no predators)
 *  and unsecured (the vault is its own protection — securing REDUCES exposure). */
export function exposedFlock(state: GameState): number {
  let n = 0;
  for (const d of state.ducks) if (!d.secured && d.site !== 'winter') n++;
  return n;
}

/** A defense line's coverage ratio: 1 while every exposed duck is under the
 *  netting, thinning proportionally as the flock outgrows the line. */
export function defenseCoverage(state: GameState, type: DefenseType = 'net'): number {
  const P = BALANCE.PREDATORS;
  const count = type === 'cloth' ? state.hardwareCloth : state.deterrents;
  const exposed = exposedFlock(state);
  if (exposed <= 0 || count <= 0) return count > 0 ? 1 : 0;
  return Math.min(1, (count * P.DUCKS_COVERED_PER_UNIT) / exposed);
}

/** Homestead-wide protection floor from built deterrents (capped), scaled by
 *  their integrity AND their coverage (a line stretched over too many ducks
 *  protects each of them less — the flock-proportional defense ladder). Passive
 *  and offline-safe, but it WEARS — a neglected floor sags toward zero, so it
 *  must be repaired to keep its full value. */
export function defenseFloor(state: GameState, type: DefenseType = 'net'): number {
  const P = BALANCE.PREDATORS;
  const count = type === 'cloth' ? state.hardwareCloth : state.deterrents;
  const integrity = type === 'cloth' ? state.hardwareClothIntegrity : state.deterrentIntegrity;
  return (
    Math.min(P.DEFENSE_FLOOR_CAP, count * P.DEFENSE_FLOOR_PER_DETERRENT) *
    integrity *
    defenseCoverage(state, type)
  );
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
export type FlowFeatureType = 'intake' | 'fountain' | 'outflow' | 'pipe';

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
  return {
    corn: 0,
    peas: 0,
    mealworms: 0,
    brewersYeast: 0,
    oysterShell: 0,
    sunflowerSeeds: 0,
    fodderSprouts: 0,
    forage: 0,
    pellets: 0,
    eggs: 0,
  };
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
    winterRation: zeroRation(),
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
    pondTerrainTier: 0,
    predators: initialPredators(),
    deterrents: 0,
    deterrentIntegrity: 1,
    hardwareCloth: 0,
    hardwareClothIntegrity: 1,
    predatorsSeen: [],
    secureCoops: 0,
    infirmaries: 0,
    predatorsIntroduced: false,
    legacyTier: 0,
    legacyCurrency: 0,
    purchasedBoosts: {},
    legacyHall: [],
    contracts: initialContracts(),
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
    // Fallback must be a HARMLESS gene: GENES' last entry became 'P' (Phase 6c,
    // mutation-only) — an FP-rounding miss in the weighted walk must never seed
    // a Prime. 'D' matches the Dud-leaning intent of the seed roll.
    let pick: Gene = 'D';
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
