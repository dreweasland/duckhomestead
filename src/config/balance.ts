/**
 * balance.ts — THE SINGLE SOURCE OF FEEL.
 *
 * Every tunable number in the game lives here. Nothing balance-related is
 * hardcoded anywhere else. Tweak values in this file to dial the loop; the
 * sim, rank curve, save catch-up, and UI all read from BALANCE.
 *
 * Design law (do not break in code):
 *   - Idle is the floor: offline production runs at a REDUCED rate, resources only.
 *   - Active play is the engine: rank XP comes ONLY from tending, which is online-only.
 */

export type StationType =
  | 'plot'
  | 'mill'
  | 'coop'
  | 'peaPatch'
  | 'mealwormFarm'
  | 'yeastVat'
  | 'oysterSource';

/** Phase 2 ingredient-producing stations (raw producers, like the plot). */
export const INGREDIENT_STATIONS: StationType[] = [
  'peaPatch',
  'mealwormFarm',
  'yeastVat',
  'oysterSource',
];

export const BALANCE = {
  /** Bounded play area. Stations occupy one tile each. */
  GRID: { width: 8, height: 8 },

  /** Decorative duck pond (non-buildable tiles) in a corner of the grid. */
  POND: { x: 6, y: 6, w: 2, h: 2 },

  // ── Production chain ────────────────────────────────────────────────
  // Each station runs cycles. A cycle takes `cycleSeconds` and, if its
  // inputs are available, consumes inputs and emits outputs.

  // The plot (and the Phase 2 ingredient stations) make raw ingredients via the
  // generic timed-cycle path. The mill and coop are driven by the NUTRITION grid
  // (see game/nutrition.ts): the mill blends the ration / provides feed capacity,
  // and the coop lays eggs throttled by per-axis satisfaction. The legacy
  // pellet constants below are unused (kept only so cycleSeconds stays here).

  /** Feed Plot: produces corn from nothing. The chain's root. */
  PLOT: {
    cornPerCycle: 2,
    cycleSeconds: 3,
  },
  /** Feed Mill: blends the ration (formulation + feed capacity), not pellets. */
  MILL: {
    cornPerPellet: 1, // legacy / unused
    pelletPerCycle: 1, // legacy / unused
    cycleSeconds: 3,
  },
  /** Coop: lays eggs, throttled by nutrition (see NUTRITION + nutrition.ts). */
  COOP: {
    pelletPerEgg: 1, // legacy / unused
    eggPerCycle: 1,
    cycleSeconds: 4,
  },

  /** Cost in EGGS to place each station type. */
  COSTS: {
    plot: 10,
    mill: 25,
    coop: 50,
    peaPatch: 25,
    mealwormFarm: 35,
    yeastVat: 45,
    oysterSource: 30,
  } as Record<StationType, number>,

  /** Fraction of a station's PLACEMENT cost refunded when removed (0..1). */
  REFUND_FRACTION: 0.5,

  /**
   * Egg stipend a fresh game starts with. The starter engine (plot + mill +
   * coop) is now PRE-PLACED for free by newGame(), so this only has to fund the
   * player's first meaningful build: the protein (mealwormFarm 35) + calcium
   * (oysterSource 30) producers that fix the flock's nutrition, with a little
   * slack to misplace once. Peas/niacin come later, earned from eggs.
   */
  STARTING_EGGS: 70,

  /**
   * Cost in EGGS to upgrade a station to the next level.
   * Cost for level L -> L+1 = base * growth^(L-1). Each level multiplies the
   * station's output by UPGRADE_OUTPUT_MULT per level above 1.
   */
  UPGRADE: {
    baseCost: {
      plot: 15,
      mill: 35,
      coop: 70,
      peaPatch: 35,
      mealwormFarm: 50,
      yeastVat: 60,
      oysterSource: 45,
    } as Record<StationType, number>,
    costGrowth: 1.6,
    /** Output multiplier per level. Level N output = base * mult^(N-1). */
    outputMultPerLevel: 1.5,
  },

  // ── Online vs Offline (the core law) ────────────────────────────────
  /** Fraction of full rate applied while offline. Resources only, no XP. */
  OFFLINE_RATE_MULT: 0.4,
  /** Max hours of offline catch-up credited on load. */
  OFFLINE_CAP_HOURS: 8,

  // ── Tending (the active engine + the ONLY XP source) ────────────────
  // Cooldown is set long enough that tending the whole homestead leaves a
  // breather before the first station is ready again. XP-per-tend is scaled
  // together with the cooldown so rank pacing stays put (chunkier rank gains,
  // fewer total tends) — keep their ratio if you retune one.
  /** Per-station cooldown between tends, in seconds. */
  TEND_COOLDOWN_S: 60,
  /** A tend instantly grants this many cycles' worth of output. */
  TEND_BURST_MULT: 5,
  /** Rank XP granted per tend. Online-only — offline never grants XP. */
  TEND_XP: 20,

  // ── Homestead Rank + the DING ───────────────────────────────────────
  /** XP needed for level n = BASE * GROWTH^(n-1). */
  RANK_BASE_XP: 50,
  RANK_GROWTH: 1.5,

  // ── Phase 2: ingredient producers (raw, like the plot) ──────────────
  /** Each ingredient station produces `perCycle` of its resource every cycle. */
  // Tuned so one ingredient station roughly feeds one coop at the default
  // ration (with ~30% headroom so stock grows and axes hold green). Rates/s:
  // peas 0.50, mealworms 0.33, yeast 0.40, shell 0.40 (+ plot corn 0.67).
  INGREDIENT_PROD: {
    peaPatch: { resource: 'peas', perCycle: 2, cycleSeconds: 4 },
    mealwormFarm: { resource: 'mealworms', perCycle: 1, cycleSeconds: 3 },
    yeastVat: { resource: 'brewersYeast', perCycle: 1, cycleSeconds: 2.5 },
    oysterSource: { resource: 'oysterShell', perCycle: 1, cycleSeconds: 2.5 },
  } as const,

  // ── Phase 2: the nutrition grid (the homestead's "power grid") ───────
  // A coop's lay rate is throttled by how well the active ration meets the
  // flock's per-axis nutritional requirement. Deficiency throttles (never a
  // hard wall); flock condition buffers small imbalances and powers offline.
  NUTRITION: {
    /** Per-coop per-cycle requirement on each axis. */
    REQUIREMENT: { energy: 3, protein: 2, niacin: 1, calcium: 1 },
    /**
     * Overlapping ingredient -> axis matrix (NOT diagonal): hitting one axis
     * nudges others, so formulating the ration is a real tradeoff. Calcium is
     * single-source (minerals). Nutritional value contributed per unit.
     */
    INGREDIENT: {
      corn: { energy: 1.0, protein: 0.1, niacin: 0, calcium: 0 },
      peas: { energy: 0.4, protein: 0.6, niacin: 0, calcium: 0 },
      mealworms: { energy: 0.2, protein: 1.0, niacin: 0, calcium: 0 },
      brewersYeast: { energy: 0, protein: 0.3, niacin: 1.0, calcium: 0 },
      oysterShell: { energy: 0, protein: 0, niacin: 0, calcium: 1.0 },
    },
    /**
     * The active ration: units of each ingredient fed per coop per coop-cycle.
     * Players retune this in the dashboard. Default satisfies all axes once all
     * five ingredient lines exist and keep up; a corn-only starter covers energy
     * but is short on the rest (throttled, buffered by flock condition).
     * Satisfaction[axis] (fully stocked) = Σ ration[i]·INGREDIENT[i][axis] / REQUIREMENT[axis].
     */
    DEFAULT_RATION: { corn: 2.5, peas: 1.5, mealworms: 1, brewersYeast: 1.2, oysterShell: 1.2 },
    /** Feed throughput a single mill can blend per second (level-scaled). A coop
     * eats ~1.85 feed/s at the default ration, so ~1 mill per coop. */
    MILL_CAPACITY: 2,
    /** Per-axis output factor floor when an axis is fully starved. */
    THROTTLE_FLOOR: 0.2,
    /**
     * Global floor on the egg multiplier (before condition). The per-axis
     * factors multiply, so a multi-axis shortfall would otherwise crater output
     * toward zero and softlock the build-out (you need eggs to afford the
     * ingredient stations that fix nutrition). This keeps eggs trickling so a
     * starved flock can always bootstrap — throttle, never a wall.
     */
    MIN_EGG_MULT: 0.5,
    /**
     * Smoothing time constant (s) for displayed/throttle satisfaction. Ingredient
     * production is chunky (a plot drops 2 corn every 3s) while the flock eats
     * continuously, so the raw per-tick ratio strobes for any line near its
     * margin. An EMA over ~this many seconds keeps the bars (and egg rate) steady.
     */
    SMOOTH_TAU_S: 1.5,
    /** Flock condition reserve (the "battery"). */
    CONDITION_MAX: 100,
    CONDITION_RISE_PER_S: 0.5, // when all axes satisfied
    CONDITION_DRAIN_PER_S: 0.3, // when short (gentle -> ~5min grace to build lines)
    /** Niacin debuff. */
    NIACIN_DEBUFF_THRESHOLD: 0.6, // satisfaction below this accrues risk
    /** A healthy flock resists the leg debuff: niacin shortfall only accrues
     *  once condition has run down below this fraction. Prevents a bootstrap
     *  catch-22 (debuff needs yeast to cure, which you can't yet afford). */
    NIACIN_DEBUFF_CONDITION_GATE: 0.4,
    NIACIN_DEBUFF_ONSET_S: 300, // sustained shortfall before a duck is debuffed
    DEBUFF_COOP_OUTPUT_MULT: 0.5, // a debuffed coop's output
    DOSE_COOLDOWN_S: 60,
    DOSE_COST_YEAST: 3, // brewer's yeast spent per dose
    DOSE_XP: 8,
  },

  // ── Milestones ──────────────────────────────────────────────────────
  /** Rank at which the Auto-Haul Cart unlocks (auto-collect output). */
  MILESTONE_AUTOHAUL_RANK: 5,
  /**
   * Rank at which the Tending Whistle unlocks: a "Tend All" sweep that tends
   * every ready station at once. Per-station tending is the tactile early loop;
   * once the homestead is big enough that round-robin clicking is a chore, the
   * whistle collapses it to one click AND re-syncs every cooldown so a sweep
   * buys a real ~TEND_COOLDOWN_S breather. Tune later than Auto-Haul.
   */
  MILESTONE_TENDALL_RANK: 10,

  // ── Phase 4b: zones (data-driven; see ZONE_DEFS below) ──────────────
  ZONES: {
    /** The first zone beyond the always-unlocked Yard. */
    BACK_PASTURE: {
      rankRequired: 15, // gate against the rank curve — tune
      eggCost: 4000, // the big egg sink — tune to feel like a real milestone
      tileRegionSize: { width: 6, height: 8 }, // added buildable space
    },
    /**
     * Free-range forage: a fixed-rate node that drips the ENERGY axis only into
     * shared storage (never protein/niacin/calcium — energy was never the
     * bottleneck, so a passive trickle can't trivialize the puzzle). NON-scaling
     * by design, so it's self-diminishing: real relief when the pasture unlocks,
     * a rounding error once the flock/economy grows.
     */
    FORAGE: {
      energyPerCycle: 2, // flat energy yield — must not scale with anything
      cycleSeconds: 4,
    },
  },

  // ── Phase 4c: predators (the risk layer) ────────────────────────────
  // The locked principle: EVERY permanent loss must trace to a CHOICE —
  // absence, under-defense, or a neglected wound — never a bolt from the blue.
  // Danger arrives only in TELEGRAPHED windows; a landed attack almost always
  // WOUNDS (soft) and escalates to a permanent loss only if left untended.
  // Built deterrents set a passive protection FLOOR (works offline); being
  // present (online) during an open window adds active cover; securing a duck
  // excludes it from targeting entirely. See game/predators.ts. Per-predator
  // schedule/attack params live in PREDATOR_DEFS below (owl is the first); the
  // globals here apply across all predators.
  PREDATORS: {
    /** Brutality dial — when ON, a rare landed attack skips the wound phase and
     *  takes a duck outright. Default OFF: every death passes through a wound
     *  checkpoint the player could have caught. */
    ALLOW_INSTANT_SNATCH: false,
    /** Only consulted when ALLOW_INSTANT_SNATCH is true. */
    INSTANT_SNATCH_CHANCE: 0.03,

    /** Each built deterrent raises the homestead-wide protection floor by this. */
    DEFENSE_FLOOR_PER_DETERRENT: 0.18,
    /** Built defenses alone can never exceed this floor (can't be 100% passive —
     *  presence and securing remain the levers for the rest). */
    DEFENSE_FLOOR_CAP: 0.7,
    /** Active cover applied to attack success while the player is PRESENT (online)
     *  during an open window. Absence removes it — only the built floor remains. */
    PRESENCE_FACTOR: 0.6,

    /** A wound escalates to a PERMANENT loss this many seconds after it lands if
     *  the duck is never treated. The save is the active Treat action. */
    WOUND_ESCALATE_SEC: 240,
    /** A wounded duck's egg output while injured (flows through the per-duck
     *  output chain alongside vigor/nutrition/modules). It also can't breed. */
    WOUND_OUTPUT_MULT: 0.5,
    /** Eggs spent to Treat (heal) one wounded duck. */
    TREAT_COST_EGGS: 30,

    /** Eggs to build one deterrent (raises the floor). */
    DETERRENT_COST_EGGS: 150,
    /**
     * Deterrents weather: their protection floor scales with an integrity meter
     * (1 = pristine). Each threat window weathers them a little; a landed attack
     * (a breach of the floor) tears them more. They never repair themselves —
     * Repair (active, eggs) is the upkeep. So a defended homestead is never
     * "done": idle erodes the floor too, not just exposes ducks. Secured housing
     * stays reliable (it carries the no-wipe guarantee), so a worn-down offline
     * night is still soft, capped losses on the UNSECURED flock — not a wipe.
     */
    DETERRENT_WEAR_PER_WINDOW: 0.03, // ambient weathering per threat window
    DETERRENT_WEAR_PER_HIT: 0.12, // extra damage when an attack breaches the floor
    DETERRENT_REPAIR_COST_PER_NET: 50, // eggs to fully repair one net (prorated by wear)
    /** Eggs to build one Secure Coop. Each adds SECURE_SLOTS_PER_COOP slots; a
     *  duck marked secured (up to the slot total) is excluded from targeting. */
    SECURE_COOP_COST_EGGS: 400,
    SECURE_SLOTS_PER_COOP: 4,

    /** Targeting weights by stage (juveniles count as adults). Secured ducks are
     *  excluded entirely; ducklings are the most exposed. */
    TARGET_WEIGHTS: { duckling: 3, adult: 1 } as Record<string, number>,

    /** Predators stay dormant until the player has a flock AND reaches this rank,
     *  so the risk layer never ambushes a brand-new homestead mid-onboarding. */
    INTRO_RANK: 3,

    /** Offline mercy rail: a single catch-up can permanently lose AT MOST this
     *  fraction of the (non-secured) flock — past it, escalating wounds are held
     *  at the brink so the player returns to woundeds to TREAT, not a wipe. This
     *  guarantees "a defended/secured overnight is soft losses, not a wipe" for
     *  any absence length. Secured ducks never count against it (they're safe). */
    MAX_OFFLINE_LOSS_FRACTION: 0.25,

    /** The owl — first predator instance. Aerial, dusk/night windows. Foxes/hawks
     *  are later config: add an entry to PREDATOR_DEFS, no core changes. */
    OWL: {
      windowEverySec: 300, // a risk window opens this often (real seconds)
      windowDurationSec: 60, // how long the window stays open
      warningLeadSec: 20, // telegraph: warn this long BEFORE the window opens
      baseAttackChance: 0.45, // per attack attempt, before defenses/presence
      attacksPerWindow: 2, // attempts spread across each open window
    },
  },

  // ── Phase 3: loot / modules (throughput boosts ONLY) ────────────────
  // Hard guardrail: modules NEVER touch nutrition requirements, the ingredient
  // matrix, or the satisfaction/throttle math — only production throughput,
  // egg output, condition regen, and tend levers. See game/loot.ts.
  LOOT: {
    /**
     * The homestead MODULE RACK (Phase 3 rework): modules are no longer slotted
     * per-tile — they install into ONE homestead-wide rack and each applies to
     * its whole category (all producers / the flock / tending). Sockets are
     * scarce and grow with rank, so the choice is "which few modules to run",
     * not per-tile babysitting. Stacking is still governed by SOFT_CAP per stat.
     */
    RACK: {
      baseSockets: 3, // sockets at rank 1
      ranksPerSocket: 4, // +1 socket every this many ranks
      maxSockets: 8, // hard ceiling
    },
    /**
     * Relative value weight per stat for the Auto-fill optimizer — what to prefer
     * when sockets are scarce (egg output earns most). PURE assist heuristic: it
     * only orders the optimizer's choices and never touches the sim math.
     */
    STAT_VALUE: {
      eggOutput: 1.5,
      stationSpeed: 1.0,
      stationYield: 1.0,
      conditionRegen: 0.6,
      tendPower: 0.6,
      tendCooldown: 0.6,
    } as Record<string, number>,
    /** Per-stat soft cap for diminishing returns: applied = cap*(1 - e^(-rawSum/cap)). */
    SOFT_CAP: {
      stationSpeed: 0.6,
      stationYield: 0.6,
      eggOutput: 0.5,
      conditionRegen: 1.0,
      tendPower: 1.0,
      tendCooldown: 0.5,
    } as Record<string, number>,
    /** Rolled magnitude band [min,max] (fraction) per rarity. Higher = stronger. */
    RARITY_BAND: {
      common: [0.05, 0.1],
      uncommon: [0.1, 0.16],
      rare: [0.16, 0.24],
      epic: [0.24, 0.34],
      legendary: [0.34, 0.5],
    } as Record<string, [number, number]>,
    /** Active-drop: chance per tend, then a weighted rarity roll. With the small
     *  module rack, drops that can't improve your loadout auto-salvage to dust
     *  (see tryTendDrop), so this is tuned lower than the old per-tile era — a
     *  drop you KEEP should feel like an event, not a constant trickle. */
    TEND_DROP_CHANCE: 0.04,
    DROP_RARITY_WEIGHTS: { common: 60, uncommon: 25, rare: 11, epic: 6, legendary: 1.5 } as Record<string, number>,
    /** Guaranteed module of a fixed rarity at these ranks. */
    MILESTONE_GRANTS: { 3: 'uncommon', 7: 'rare', 12: 'epic', 18: 'legendary' } as Record<number, string>,
    /** Salvage yields dust by rarity; reroll spends dust. */
    SALVAGE_DUST: { common: 1, uncommon: 3, rare: 8, epic: 20, legendary: 50 } as Record<string, number>,
    REROLL_DUST_COST: 10,
  },

  // ── Phase 4a: breeding & genetics ───────────────────────────────────
  // Two orthogonal axes: COLOR (Bl locus, Mendelian — the collection grind) and
  // VIGOR (continuous heritable egg-output multiplier — the power grind). Vigor
  // is throughput-only and NEVER touches nutrition requirements/matrix/throttle.
  BREEDING: {
    COOP_CAPACITY: 4, // adult-equivalent ducks housed per coop level
    /** Vigor is a duck's egg-output multiplier. Bounded so breeding can't run away. */
    VIGOR_FLOOR: 0.5,
    VIGOR_CEILING: 2.0,
    VIGOR_SEED_RANGE: [0.8, 1.2] as [number, number],
    H2: 0.4, // heritability — offspring regress toward the population mean
    VIGOR_NOISE: 0.1, // env variance per offspring
    /** Breeding loop timers (seconds). */
    CLUTCH_INTERVAL_S: 120, // a pair lays a fertilized clutch this often
    CLUTCH_SIZE: 4, // fertilized eggs per clutch
    INCUBATE_S: 60, // fertilized egg -> duckling
    MATURE_DUCKLING_S: 180, // duckling -> juvenile (gated by duckling ration)
    MATURE_JUVENILE_S: 180, // juvenile -> adult
    /** Duckling ration profile — high protein/niacin (per immature duck per cycle). */
    DUCKLING_REQUIREMENT: { energy: 1, protein: 3, niacin: 2, calcium: 0 },
    DUCKLING_RATION_MATURE_PENALTY_FLOOR: 0.3, // worst-case maturation speed mult
    /** Default grow-out ration fed to immature ducks (satisfies E/P/N when stocked). */
    DEFAULT_DUCKLING_RATION: { corn: 1, peas: 0, mealworms: 2.5, brewersYeast: 2, oysterShell: 0 },
    /** Starting flock seeded into the first coop (Blue carriers, mid vigor). */
    SEED_DRAKES: 1,
    SEED_HENS: 2,
  },

  // ── Simulation ──────────────────────────────────────────────────────
  /** Fixed-timestep rate for the sim loop. Render is decoupled (rAF). */
  TICKS_PER_SECOND: 10,

  /** Debounce for autosave writes to localStorage, in milliseconds. */
  AUTOSAVE_DEBOUNCE_MS: 1500,
} as const;

type ResourceKey =
  | 'corn'
  | 'peas'
  | 'mealworms'
  | 'brewersYeast'
  | 'oysterShell'
  | 'forage'
  | 'pellets'
  | 'eggs';

/** Per-type static config, keyed for convenience in the sim. */
export const STATION_DEFS: Record<
  StationType,
  {
    label: string;
    /** Color used for the placeholder Pixi sprite. */
    color: number;
    cycleSeconds: number;
    /** Inputs consumed per cycle (resource -> amount). */
    inputs: Partial<Record<ResourceKey, number>>;
    /** Outputs produced per cycle (resource -> amount). */
    outputs: Partial<Record<ResourceKey, number>>;
  }
> = {
  plot: {
    label: 'Feed Plot',
    color: 0xe2b94f,
    cycleSeconds: BALANCE.PLOT.cycleSeconds,
    inputs: {},
    outputs: { corn: BALANCE.PLOT.cornPerCycle },
  },
  mill: {
    // Phase 2: the mill blends the active ration (formulation + feed capacity);
    // it no longer makes pellets. Production is handled in nutrition.ts.
    label: 'Feed Mill',
    color: 0xb87333,
    cycleSeconds: BALANCE.MILL.cycleSeconds,
    inputs: {},
    outputs: {},
  },
  coop: {
    // Phase 2: coops lay eggs throttled by ration satisfaction (nutrition.ts),
    // not by consuming pellets. `outputs.eggs` is the base lay used there + tend.
    label: 'Coop',
    color: 0xd95f5f,
    cycleSeconds: BALANCE.COOP.cycleSeconds,
    inputs: {},
    outputs: { eggs: BALANCE.COOP.eggPerCycle },
  },
  // Phase 2 ingredient producers — raw, no inputs (like the plot).
  peaPatch: {
    label: 'Pea Patch',
    color: 0x7fae54,
    cycleSeconds: BALANCE.INGREDIENT_PROD.peaPatch.cycleSeconds,
    inputs: {},
    outputs: { peas: BALANCE.INGREDIENT_PROD.peaPatch.perCycle },
  },
  mealwormFarm: {
    label: 'Mealworm Bed',
    color: 0x9a6a3f,
    cycleSeconds: BALANCE.INGREDIENT_PROD.mealwormFarm.cycleSeconds,
    inputs: {},
    outputs: { mealworms: BALANCE.INGREDIENT_PROD.mealwormFarm.perCycle },
  },
  yeastVat: {
    label: 'Yeast Vat',
    color: 0xcaa24a,
    cycleSeconds: BALANCE.INGREDIENT_PROD.yeastVat.cycleSeconds,
    inputs: {},
    outputs: { brewersYeast: BALANCE.INGREDIENT_PROD.yeastVat.perCycle },
  },
  oysterSource: {
    label: 'Shell Bin',
    color: 0xaeb4ba,
    cycleSeconds: BALANCE.INGREDIENT_PROD.oysterSource.cycleSeconds,
    inputs: {},
    outputs: { oysterShell: BALANCE.INGREDIENT_PROD.oysterSource.perCycle },
  },
};

export const STATION_ORDER: StationType[] = [
  'plot',
  'mill',
  'coop',
  'peaPatch',
  'mealwormFarm',
  'yeastVat',
  'oysterSource',
];

// ── Phase 4b: data-driven zones ──────────────────────────────────────
/**
 * A zone is buildable space. Adding a new one (the pond, a far field, …) is a
 * new entry in ZONE_DEFS — NOT new code: the unlock flow, placement, rendering,
 * and forage all iterate these defs. The Yard is zone 0 and always unlocked.
 */
export interface ForageDef {
  /** Flat energy per cycle into shared storage. ENERGY axis only; non-scaling. */
  energyPerCycle: number;
  cycleSeconds: number;
}
export interface ZoneDef {
  id: string;
  name: string;
  /** This zone's own buildable tile grid (local coordinates). */
  grid: { width: number; height: number };
  /** Non-buildable region within the grid (e.g. the Yard pond). */
  blocked?: { x: number; y: number; w: number; h: number };
  /** Double-gated unlock. Absent ⇒ always unlocked (the Yard). */
  unlock?: { rankRequired: number; eggCost: number };
  /** Signature node that activates on unlock (the pasture's free-range forage). */
  forage?: ForageDef;
}

export const ZONE_DEFS: ZoneDef[] = [
  {
    id: 'yard',
    name: 'Yard',
    grid: BALANCE.GRID,
    blocked: BALANCE.POND,
  },
  {
    id: 'backPasture',
    name: 'Back Pasture',
    grid: BALANCE.ZONES.BACK_PASTURE.tileRegionSize,
    unlock: {
      rankRequired: BALANCE.ZONES.BACK_PASTURE.rankRequired,
      eggCost: BALANCE.ZONES.BACK_PASTURE.eggCost,
    },
    forage: BALANCE.ZONES.FORAGE,
  },
];

export const zoneDef = (id: string): ZoneDef | undefined => ZONE_DEFS.find((z) => z.id === id);

// ── Phase 4c: data-driven predators ──────────────────────────────────
/**
 * A predator is pure data: its window schedule + attack params. The window
 * scheduler, telegraph, attack resolution, wound/escalation, and offline
 * catch-up all iterate these defs — adding a fox or a hawk is a NEW ENTRY here,
 * not new code. The owl is the first instance; "owl" never appears in core
 * logic. The numbers live in BALANCE.PREDATORS so balance.ts stays the single
 * source of feel.
 */
export interface PredatorDef {
  id: string;
  name: string;
  /** A risk window opens this often (real seconds). */
  windowEverySec: number;
  /** How long a window stays open. */
  windowDurationSec: number;
  /** Telegraph: a warning fires this long before the window opens. */
  warningLeadSec: number;
  /** Per-attack success before defenses/presence. */
  baseAttackChance: number;
  /** Attack attempts spread across each open window. */
  attacksPerWindow: number;
}

export const PREDATOR_DEFS: PredatorDef[] = [
  {
    id: 'owl',
    name: 'Owl',
    ...BALANCE.PREDATORS.OWL,
  },
];

export const predatorDef = (id: string): PredatorDef | undefined =>
  PREDATOR_DEFS.find((p) => p.id === id);
