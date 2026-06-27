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
  | 'mealwormFarm'
  | 'yeastVat'
  | 'oysterSource';

/** Phase 2 ingredient-producing stations (raw producers, like the plot). */
export const INGREDIENT_STATIONS: StationType[] = ['mealwormFarm', 'yeastVat', 'oysterSource'];

export const BALANCE = {
  /** Bounded play area. Stations occupy one tile each. */
  GRID: { width: 8, height: 8 },

  /** Decorative duck pond (non-buildable tiles) in a corner of the grid. */
  POND: { x: 6, y: 6, w: 2, h: 2 },

  // ── Production chain ────────────────────────────────────────────────
  // Each station runs cycles. A cycle takes `cycleSeconds` and, if its
  // inputs are available, consumes inputs and emits outputs.

  // Chain is tuned so each stage OVER-supplies the next: a lone plot+mill+coop
  // never starves itself, and the growing upstream surplus (corn, then pellets)
  // is the signal to expand ("lots of corn -> build another mill"). Coop output
  // is the throughput cap. Rates (per second):
  //   plot 0.67 corn  >  mill demand 0.33 corn  ->  mill 0.33 pellet
  //   mill 0.33 pellet > coop demand 0.25 pellet -> coop 0.25 egg = 15 eggs/min

  /** Feed Plot: produces corn from nothing. The chain's root. */
  PLOT: {
    cornPerCycle: 2,
    cycleSeconds: 3,
  },
  /** Feed Mill: consumes corn, produces pellets. */
  MILL: {
    cornPerPellet: 1, // corn consumed per pellet produced
    pelletPerCycle: 1,
    cycleSeconds: 3,
  },
  /** Coop: consumes pellets, produces eggs (the primary currency). */
  COOP: {
    pelletPerEgg: 1, // pellets consumed per egg produced
    eggPerCycle: 1,
    cycleSeconds: 4,
  },

  /** Cost in EGGS to place each station type. */
  COSTS: {
    plot: 10,
    mill: 25,
    coop: 50,
    mealwormFarm: 60,
    yeastVat: 75,
    oysterSource: 50,
  } as Record<StationType, number>,

  /** Fraction of a station's PLACEMENT cost refunded when removed (0..1). */
  REFUND_FRACTION: 0.5,

  /**
   * Eggs the player starts with. MUST cover the full starter chain
   * (plot 10 + mill 25 + coop 50 = 85) or the economy softlocks: eggs only
   * come from a Coop, so you can't bootstrap without affording one. The
   * surplus lets you misplace once or grab an early upgrade.
   */
  STARTING_EGGS: 100,

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
      mealwormFarm: 80,
      yeastVat: 100,
      oysterSource: 70,
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
  INGREDIENT_PROD: {
    mealwormFarm: { resource: 'mealworms', perCycle: 1, cycleSeconds: 8 },
    yeastVat: { resource: 'brewersYeast', perCycle: 1, cycleSeconds: 6 },
    oysterSource: { resource: 'oysterShell', perCycle: 1, cycleSeconds: 5 },
  } as const,

  // ── Phase 2: the nutrition grid (the homestead's "power grid") ───────
  // A coop's lay rate is throttled by how well the active ration meets the
  // flock's per-axis nutritional requirement. Deficiency throttles (never a
  // hard wall); flock condition buffers small imbalances and powers offline.
  NUTRITION: {
    /** Per-coop per-cycle requirement on each axis. */
    REQUIREMENT: { energy: 3, protein: 2, niacin: 1, calcium: 1 },
    /** Nutritional value contributed per unit of each ingredient. */
    INGREDIENT: {
      corn: { energy: 1, protein: 0, niacin: 0, calcium: 0 },
      mealworms: { energy: 0, protein: 1, niacin: 0, calcium: 0 },
      brewersYeast: { energy: 0, protein: 0, niacin: 1, calcium: 0 },
      oysterShell: { energy: 0, protein: 0, niacin: 0, calcium: 1 },
    },
    /** Output multiplier floor when an axis is fully starved (throttle, not wall). */
    THROTTLE_FLOOR: 0.2,
    /** Flock condition reserve (the "battery"). */
    CONDITION_MAX: 100,
    CONDITION_RISE_PER_S: 0.5, // when all axes satisfied
    CONDITION_DRAIN_PER_S: 1.0, // when short
    /** Niacin debuff. */
    NIACIN_DEBUFF_THRESHOLD: 0.6, // satisfaction below this accrues risk
    NIACIN_DEBUFF_ONSET_S: 300, // sustained shortfall before a duck is debuffed
    DEBUFF_COOP_OUTPUT_MULT: 0.5, // a debuffed coop's output
    DOSE_COOLDOWN_S: 60,
    DOSE_XP: 8,
  },

  // ── Milestones ──────────────────────────────────────────────────────
  /** Rank at which the Auto-Haul Cart unlocks (auto-collect output). */
  MILESTONE_AUTOHAUL_RANK: 5,

  // ── Simulation ──────────────────────────────────────────────────────
  /** Fixed-timestep rate for the sim loop. Render is decoupled (rAF). */
  TICKS_PER_SECOND: 10,

  /** Debounce for autosave writes to localStorage, in milliseconds. */
  AUTOSAVE_DEBOUNCE_MS: 1500,
} as const;

type ResourceKey = 'corn' | 'mealworms' | 'brewersYeast' | 'oysterShell' | 'pellets' | 'eggs';

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
    label: 'Feed Mill',
    color: 0xb87333,
    cycleSeconds: BALANCE.MILL.cycleSeconds,
    inputs: { corn: BALANCE.MILL.cornPerPellet * BALANCE.MILL.pelletPerCycle },
    outputs: { pellets: BALANCE.MILL.pelletPerCycle },
  },
  coop: {
    label: 'Coop',
    color: 0xd95f5f,
    cycleSeconds: BALANCE.COOP.cycleSeconds,
    inputs: { pellets: BALANCE.COOP.pelletPerEgg * BALANCE.COOP.eggPerCycle },
    outputs: { eggs: BALANCE.COOP.eggPerCycle },
  },
  // Phase 2 ingredient producers — raw, no inputs (like the plot).
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
  'mealwormFarm',
  'yeastVat',
  'oysterSource',
];
