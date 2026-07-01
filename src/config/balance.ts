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
    cycleSeconds: 2,
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
    /**
     * Ingredient producers (the plot + the four ingredient farms) scale on a
     * GENTLER, CAPPED curve instead of the geometric one above. With the full
     * 1.5^(N-1) curve a single upgraded tile feeds thousands, so a big flock never
     * needs a second producer — you can bulldoze ~90% of the board. The capped curve
     * makes producer COUNT scale with the flock: the board fills (build wide first —
     * placement is already cheaper per unit than upgrading — then top out at the
     * cap), and the per-zone board size bounds the flock (grow by unlocking the next
     * zone). Housing (coops) + mill blend capacity keep the full uncapped curve.
     */
    PRODUCER: { outputMultPerLevel: 1.3, levelCap: 14 },
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
  // Rates bumped so the flock doesn't demand ~1 producer PER laying hen (a full
  // coop used to need ~3-4 of every line). Now ~0.5 producers/hen; you build a
  // handful and lean on UPGRADES once the yard fills. Rates/s: peas 0.75,
  // mealworms 0.50, yeast 0.50, shell 0.50 (+ plot corn 1.00).
  INGREDIENT_PROD: {
    peaPatch: { resource: 'peas', perCycle: 3, cycleSeconds: 4 },
    mealwormFarm: { resource: 'mealworms', perCycle: 1, cycleSeconds: 2 },
    yeastVat: { resource: 'brewersYeast', perCycle: 1, cycleSeconds: 2 },
    oysterSource: { resource: 'oysterShell', perCycle: 1, cycleSeconds: 2 },
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
    // On-grid (0.25 slider step) so every default is settable; yeast/shell 1.25
    // keep ~25% niacin/calcium headroom.
    DEFAULT_RATION: { corn: 2.5, peas: 1.5, mealworms: 1, brewersYeast: 1.25, oysterShell: 1.25 },
    /** Feed throughput a single mill can blend per second (level-scaled). Raised
     * with the producer rates so mills don't also need ~1 per hen (~0.5/hen now). */
    MILL_CAPACITY: 4,
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

  // ── THE WATER SYSTEM (wellness-only): two staged unlocks, one canvas ─
  // The flock's water is ONE self-contained system surfaced as two zone tabs
  // onto a shared canvas (WATER.CANVAS):
  //   1. The Pond  — a layout-adjacency puzzle: arrange provision features so a
  //      thoughtful layout beats a scattered dump → `layoutBase`.
  //   2. Waterworks — a flow-routing puzzle that keeps the pond CIRCULATING as
  //      a growing flock fouls it faster; coverage → `circulationHealth` (the
  //      ONE upkeep loop in the game). Reuses the old back-pasture zone slot.
  // provision = layoutBase × circulationHealth; provision / (flock ×
  // REQUIREMENT_PER_DUCK) feeds the EXISTING saturation curve → flock condition
  // regen + the wound-escalation timer (see game/water.ts, game/pond.ts).
  // It NEVER produces eggs/currency and never touches a nutrition axis.
  WATER: {
    /** Stage 1 — the Pond (layout). Teased + locked like any zone. Cost kept
     *  modest — it's a wellness feature (no income) and is re-paid each prestige. */
    POND_UNLOCK: { rankRequired: 12, eggCost: 1500 },
    /** Stage 2 — Waterworks (circulation). Arrives later, as fouling bites. */
    WORKS_UNLOCK: { rankRequired: 17, eggCost: 3000 },
    /** The shared water canvas (pond shape). Both tabs edit these coordinates. */
    CANVAS: { width: 7, height: 5 },
    /** Always-on baseline provision (the yard's puddle) so a small flock with no
     *  pond is never punished — matches the old yard-baseline feel. */
    YARD_BASELINE_PROVISION: 6,
    /** provision / (flock × this) = the access ratio fed to the saturation curve. */
    REQUIREMENT_PER_DUCK: 1.0,

    /** Pond LAYOUT features (Stage 1). baseProvision is the feature's own water;
     *  the bonuses reward arrangement (a great layout must beat a random dump). */
    FEATURES: {
      spring: { costEggs: 150, baseProvision: 0, feedsPools: true }, // source: feeds adjacent pools
      bathingPool: { costEggs: 120, baseProvision: 4, springBonus: 3 }, // +3 when spring-fed (adjacent)
      plantBed: { costEggs: 80, baseProvision: 1, adjacentQualityBonus: 0.25 }, // +25% to each adjacent feature
      deepZone: { costEggs: 180, baseProvision: 6, wantsCirculation: true }, // high provision; fouls fastest
    },
    /**
     * Pond feature UPGRADES — the pre-prestige water scaler + a deep egg sink.
     * Each level multiplies a feature's provision; the cost escalates per level
     * (base = the feature's place cost). Lets a maxed layout keep scaling water
     * past the fixed-canvas ceiling without waiting for prestige.
     */
    UPGRADE: {
      provisionMult: 1.5, // provision ×= this per level above 1
      costGrowth: 1.7, // upgrade cost = placeCost × costGrowth^level
    },
    /** Circulation FLOW features (Stage 2). A fountain is "live" (projects
     *  coverage) only on a path that connects an intake to an outflow. */
    FLOW: {
      intake: { costEggs: 100 }, // where fresh water enters the circuit
      fountain: { costEggs: 90 }, // aerator: keeps the nearby pond fresh (when live)
      outflow: { costEggs: 60 }, // where stale water leaves — closes the circuit
    },

    /** The ONE upkeep loop: fouling pressure vs circulation coverage. */
    CIRCULATION: {
      foulPerDuckPerSec: 0.02, // fouling pressure scales with flock size
      circulationFloor: 0.45, // a fully-stagnant feature still gives ~45% of its provision
      foulToFloorSec: 600, // an uncovered feature coasts to the floor this slowly
      fountainCoverageRadius: 2, // tiles a LIVE fountain keeps fresh (Chebyshev)
      /** deepZone (wantsCirculation) fouls this much faster than a plain feature. */
      wantsCirculationFoulMult: 2,
    },

    // Saturation-curve anchors (UNCHANGED — the existing wellness math). The
    // modifier is 1.0 at access ratio 1.0 and saturates flat beyond 2.0.
    CONDITION_REGEN_AT_HALF: 0.6, // condition-regen mult at access 0.5 (decline)
    CONDITION_REGEN_AT_DOUBLE: 1.4, // condition-regen mult at access 2.0 (bounded reward)
    WOUND_TIMER_AT_HALF: 0.7, // wound-timer mult at access 0.5 (less time)
    WOUND_TIMER_AT_DOUBLE: 1.5, // wound-timer mult at access 2.0 (more time to treat)
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
    /** Passive cover applied to attack success while the player is PRESENT (online)
     *  during an open window — a partial "I'm watching" deterrent that holds even
     *  if you don't react. Absence removes it; the built floor is all that's left.
     *  The FULL save is the active scare (see STRIKE_WINDUP_SEC) — presence is the
     *  floor under that, not a substitute for it. */
    PRESENCE_FACTOR: 0.6,
    /** Online only: the active "be present" save. When a strike is committed
     *  during an open window the owl makes a VISIBLE dive for this many seconds
     *  before it lands — the reaction window in which clicking (scaring) the owl
     *  foils the strike. Let it expire and the strike resolves against the built
     *  floor + passive presence only. This is the real work behind "or be
     *  present": presence that you DO, not presence you merely have. */
    STRIKE_WINDUP_SEC: 2.6,
    /** How many distinct spots the owl can dive-bomb. A strike picks one to dive
     *  at, and a non-final scare click jukes it to a DIFFERENT one. */
    STRIKE_DIVE_SPOTS: 5,
    /**
     * ACTIVE vs GUARD. Any meaningful player action marks the homestead "active"
     * for this long; after it lapses (no actions), it reverts to "guard". While
     * ACTIVE the player is clearly here, so the passive floor + presence are
     * SUPPRESSED — a committed dive you don't scare lands an injury (scaring is the
     * only defense). While GUARD (online idle) or OFFLINE, the built defenses carry
     * you as before. Built deterrents are your away/guard armor; the scare is your
     * at-the-keyboard one. */
    ACTIVE_WINDOW_S: 150,
    /**
     * Rank difficulty ramp for the SCARE: the owl gets meaner to fend off as the
     * homestead climbs. Linear from INTRO_RANK (easy, d=0) to RANK_DIFF_TO (hard,
     * d=1): the dive wind-up shrinks toward windupMinScale (less reaction time) and
     * the 1/2/3-click weighting slides from easy → hard (more multi-click feints).
     */
    RANK_DIFF_TO: 25, // rank at which the scare hits peak difficulty
    RANK_WINDUP_MIN_SCALE: 0.5, // wind-up shrinks to this fraction at peak
    STRIKE_CLICK_WEIGHTS_HARD: [0.2, 0.4, 0.4], // peak-rank click distribution (vs the easy default)
    /** Weighted distribution of how many clicks a strike needs to be scared off:
     *  index 0 → 1 click, 1 → 2 clicks, 2 → 3 clicks. A click that isn't the last
     *  is a FEINT — the owl jukes to another spot and re-dives (a fresh reaction
     *  window). Tilt toward 1 so most strikes are still a single tap. */
    STRIKE_CLICK_WEIGHTS: [0.55, 0.3, 0.15],

    /** A wound escalates to a PERMANENT loss this many seconds after it lands if
     *  the duck is never treated. The save is the active Treat action. */
    WOUND_ESCALATE_SEC: 240,
    /** A wounded duck's egg output while injured (flows through the per-duck
     *  output chain alongside vigor/nutrition/modules). It also can't breed. A
     *  RECOVERING duck (admitted to the infirmary) lays nothing instead. */
    WOUND_OUTPUT_MULT: 0.5,

    /** Every BUILT defense (nets, cloth, secure coops, infirmaries) escalates in cost:
     *  the Nth of a kind costs its base × DEFENSE_COST_GROWTH^(N-1). Eggs are abundant
     *  by the time predators bite, so flat costs were trivially cheap — escalation
     *  makes each additional defense a real decision. (Repairs stay wear-prorated.) */
    DEFENSE_COST_GROWTH: 1.6,
    /** Eggs to build the FIRST deterrent (then × DEFENSE_COST_GROWTH each). */
    DETERRENT_COST_EGGS: 150,
    /** Eggs to build one length of hardware cloth (the GROUND defense — raises the
     *  floor against the raccoon, exactly as nets do against the owl, but a separate
     *  pool: nets don't stop raccoons and cloth doesn't stop owls). */
    HARDWARE_CLOTH_COST_EGGS: 180,
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
    /** The FIRST secure coop adds this many slots; each additional one adds
     *  SECURE_SLOTS_ADDITIONAL. Diminishing slots + escalating cost together keep
     *  securing to a few PRIZE breeders — securing the whole flock is prohibitive. */
    SECURE_SLOTS_PER_COOP: 4,
    SECURE_SLOTS_ADDITIONAL: 2,

    /**
     * The Infirmary. Wounds are no longer instantly cured for eggs — a wounded duck
     * must be ADMITTED to a limited recovery slot, where it heals over time (severity
     * + water scaled), holds the slot, eats extra feed, and lays nothing. A wound not
     * admitted before WOUND_ESCALATE_SEC still escalates to a loss — the save is now
     * capacity + attention, not 30 eggs. Build more infirmaries to weather a bad
     * night; offline the infirmary auto-admits up to capacity.
     */
    INFIRMARY: {
      COST_EGGS: 250, // eggs for the FIRST infirmary (then × DEFENSE_COST_GROWTH each)
      SLOTS_PER: 2, // recovery slots each infirmary adds
      /** Recovery time (seconds) by injury severity, before the water multiplier
       *  (recovery = RECOVERY_SEC / waterWoundMult — good water heals faster). */
      RECOVERY_SEC: { minor: 90, serious: 300, critical: 600 } as Record<string, number>,
      /** A recovering duck eats this multiple of the layer ration and lays nothing. */
      FEED_MULT: 1.5,
      /** Severity roll weights [minor, serious, critical]. A GUARD-mode/defended hit
       *  uses the base set; an ACTIVE (defenses-down) landed hit rolls the worse set.
       *  Hardy (H genes) shifts a roll one step milder. */
      SEVERITY_WEIGHTS: [0.6, 0.3, 0.1],
      SEVERITY_WEIGHTS_CAUGHT: [0.3, 0.4, 0.3],
    },

    /** Targeting weights by stage (juveniles count as adults). Secured ducks are
     *  excluded entirely; ducklings are the most exposed. */
    TARGET_WEIGHTS: { duckling: 3, adult: 1 } as Record<string, number>,

    /** Predators stay dormant until the player has a flock AND reaches this rank,
     *  so the risk layer never ambushes a brand-new homestead mid-onboarding. */
    INTRO_RANK: 4,
    /** Rank the raccoon (the second, ground predator) debuts — later than the owl,
     *  so a second threat + defense line arrives as the homestead grows. (Kept off
     *  rank 8 so it doesn't share a rank with the guaranteed-rare loot grant.) */
    RACCOON_INTRO_RANK: 9,

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
      attacksPerWindow: 2, // fallback / mean
      // Hidden per-window roll: sometimes 1 dive (quiet), usually 2, sometimes 3 (a
      // swarm). Mean stays 2, but you can never bank on "2 already hit, I'm safe."
      attackCountWeights: [0.25, 0.5, 0.25],
    },
    /** The RACCOON: a ground raider. Rarer, longer windows than the owl, stopped by
     *  hardware cloth (not nets). Debuts at RACCOON_INTRO_RANK. */
    RACCOON: {
      windowEverySec: 360, // prowls a bit less often than the owl
      windowDurationSec: 90, // but lingers longer once it's in
      warningLeadSec: 20,
      baseAttackChance: 0.4,
      attacksPerWindow: 2,
      attackCountWeights: [0.3, 0.45, 0.25],
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
    MILESTONE_GRANTS: { 3: 'uncommon', 8: 'rare', 13: 'epic', 18: 'legendary' } as Record<number, string>,
    /** Salvage yields dust by rarity; reroll spends dust. */
    SALVAGE_DUST: { common: 1, uncommon: 3, rare: 8, epic: 20, legendary: 50 } as Record<string, number>,
    REROLL_DUST_COST: 10,
  },

  // ── Phase 4a: breeding & genetics ───────────────────────────────────
  // Two orthogonal axes: COLOR (Bl locus, Mendelian — the collection grind) and
  // the hidden 6-gene GENOME (the heritable quality — see GENOME below). The
  // genome drives a duck's stats and is throughput-only: it NEVER touches
  // nutrition requirements/matrix/throttle (see game/genetics.ts).
  BREEDING: {
    COOP_CAPACITY: 4, // adult-equivalent ducks housed per coop level
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
    /**
     * Drake maintenance ration — adult breeding males eat too, but lay no eggs, so
     * they need NO calcium (the layers' eggshell cost). Per-drake demand matches a
     * laying hen on energy/protein/niacin, making a big breeding pool a real
     * end-game ingredient drain that spares oyster shell. Only kicks in once
     * breeding is established (gene reader built or a pair made), so a cold-start
     * flock is never taxed. Feeding drakes well speeds breeding; starving them
     * throttles clutch production (never a hard stop — a floor like the others).
     */
    DRAKE_REQUIREMENT: { energy: 3, protein: 2, niacin: 1, calcium: 0 },
    DRAKE_BREED_PENALTY_FLOOR: 0.4, // worst-case clutch-rate mult when underfed
    /** Default drake ration — the layer default minus the (unneeded) oyster shell. */
    DEFAULT_DRAKE_RATION: { corn: 2.5, peas: 1.5, mealworms: 1, brewersYeast: 1.25, oysterShell: 0 },

    /**
     * Flock RATIO health — an over-drake flock harasses itself into injury (drakes
     * fight + over-mate the hens). Past a flock-size gate, drakes beyond the ideal
     * ratio (1 drake per IDEAL_HENS_PER_DRAKE hens, but always ≥1 stud allowed)
     * accrue overcrowding stress; each onset interval injures a random non-secured
     * adult — reusing the predator WOUND (treatable, escalates to loss if ignored).
     * The fix is the ratio: cull surplus drakes. Small flocks are exempt so a
     * starter pair is never punished. Stress accrues faster the more over-drake.
     */
    OVERCROWD_MIN_FLOCK: 10, // ratio health is dormant below this flock size
    IDEAL_HENS_PER_DRAKE: 4, // healthy: ≤ 1 drake per this many hens
    OVERCROWD_INJURY_ONSET_S: 240, // seconds per injury at 1 excess drake (faster with more)
    OVERCROWD_RATE_CAP: 4, // …but the excess speed-up is capped here, so a badly over-drake
    // flock injures at most ~1/min (240/4) instead of a flood. With the cap:
    //   1 excess → 1 injury / 4 min · 2 → /2 min · 3 → /80s · 4+ → /60s (capped).
    /** Starting flock seeded into the first coop (Blue carriers, mixed genome). */
    SEED_DRAKES: 1,
    SEED_HENS: 2,
  },

  // ── Breeding rework: the hidden 6-gene GENOME (heritable quality) ────
  // A duck's quality is a 6-slot genome, each slot a gene ∈ {L,V,H,D}. Stats
  // derive from the gene PROFILE (the three good genes do DIFFERENT things, so
  // the genome can't collapse to one scalar): L→egg output, V→growth/maturation
  // (+ a smaller output bump), H→resilience (wound resistance + water synergy),
  // D→nothing. THROUGHPUT-ONLY: genome-derived stats boost output/resilience and
  // NEVER reduce a nutrition/water requirement. Inheritance is position-linked +
  // dominance-weighted + per-slot mutation. See game/genetics.ts.
  GENOME: {
    SLOTS: 6,
    GENES: ['L', 'V', 'H', 'D'] as const, // Lay, Vigor, Hardy, Dud
    /** Expressed stat contribution per gene of each type (profile → stats).
     *  Summed across the 6 slots, then folded into the existing output/resilience
     *  chains as multipliers (1 + Σ). Never a nutrition/water requirement. */
    STAT_PER_GENE: {
      L: { eggOutput: 0.12 },
      V: { eggOutput: 0.05, maturationSpeed: 0.1 },
      H: { woundResist: 0.1, waterSynergy: 0.08 },
      D: {},
    } as Record<string, { eggOutput?: number; maturationSpeed?: number; woundResist?: number; waterSynergy?: number }>,
    /** Hard ceiling on derived wound-resist (a chance to shrug off a wound), so a
     *  full-Hardy clone is very tanky but never invulnerable. */
    WOUND_RESIST_CAP: 0.6,
    // ── inheritance ──
    /** Relative weight a gene passes its slot (good genes weighted to pass → the
     *  cross is plannable; D rarely wins a contested slot). */
    DOMINANCE: { L: 3, V: 3, H: 3, D: 1 } as Record<string, number>,
    /** Per-slot chance the inherited gene is replaced by a uniformly-random gene
     *  (the occasional upgrade / escape from two-Dud parents). */
    MUTATION_CHANCE: 0.04,
    // ── gene-reader (Step 3) ──
    /** Eggs to build the gene-reader. Once built it reveals genomes passively/in
     *  bulk (the whole flock at build time, then every new duck auto-reads on
     *  arrival) — NEVER a per-duck click. */
    READER_COST_EGGS: 1500,
    // ── god clone (Step 5) ──
    /** Default target profile a player steers toward (all-Lay god clone). */
    DEFAULT_TARGET: ['L', 'L', 'L', 'L', 'L', 'L'] as const,
    /** Seed-flock genomes: per-slot gene weights (Dud-leaning so a fresh flock is
     *  middling — accessible floor, real room to breed up toward a god clone). */
    SEED_GENE_WEIGHTS: { L: 1, V: 1, H: 1, D: 2 } as Record<string, number>,
  },

  // ── Phenotype band: the free, always-visible "phone-it-in" floor ─────
  // Every duck shows a COARSE performance band per axis (Lay / Vigor / Hardy),
  // visible from turn one with no gene-reader. The band is derived from the
  // duck's INTRINSIC genome potential (the STAT_PER_GENE profile), NOT its live
  // egg output — so a starving gem still reads strong and a well-fed dud still
  // reads weak. It is deliberately coarse: it buckets each axis into a few tiers
  // and NEVER reveals the exact genes/slots (those stay gene-reader-gated). See
  // game/genetics.ts (axisScore / axisTier).
  PHENOTYPE: {
    TIERS: 5, // pips / bands per axis
    // Bucket thresholds on the intrinsic axis score (0..1, where a 6-of-the-axis-
    // gene genome reads 1.0 and a 6-Dud genome reads 0). A score lands in tier
    // = (count of thresholds it meets), so there are TIERS = thresholds+1 buckets.
    AXIS_THRESHOLDS: [0.15, 0.35, 0.6, 0.85],
  },

  // ── Phase 4e: prestige (the meta loop) ──────────────────────────────
  // Multiplier-only, clean slate. A CHAMPION-FLOCK goal gates an explicit,
  // confirmed reset that wipes the WHOLE run and grants legacy currency for
  // permanent GLOBAL-SCALAR boosts. Boosts NEVER touch a nutrition requirement or
  // any puzzle structure — same throughput-only guardrail as loot + vigor.
  //
  // The goal is THREE concrete requirements, so it can't be brute-forced by raw
  // headcount and the player can read exactly what's left:
  //   1. all colours bred (collection mastery),
  //   2. average flock GENOME QUALITY ≥ the tier's gate (breeding mastery — the
  //      mean number of slots matching the god-clone target, 0..6; needs real
  //      selective crossbreeding + culling, and the gate RISES each prestige),
  //   3. flock size ≥ the tier's target (which scales each prestige).
  PRESTIGE: {
    /** Required average flock GENOME QUALITY = mean slots matching the god-clone
     *  target (range 0..GENOME.SLOTS; a fresh flock ≈ 2). A mastery bar that
     *  RISES each tier: gate(tier) = min(MAX, BASE + PER_TIER·tier). Capped below
     *  the 6-slot perfect so it always stays reachable. */
    QUALITY_GATE_BASE: 4.5,
    QUALITY_GATE_PER_TIER: 0.1,
    QUALITY_GATE_MAX: 5.7,
    /** Flock-size target at tier 0; each tier multiplies it by SIZE_GROWTH.
     *  A real grind that forces deep coop upgrades, not a formality
     *  (≈100, 150, 225, 337, …). */
    SIZE_BASE: 100,
    SIZE_GROWTH: 1.5,
    /** Legacy currency = CURRENCY_AT_THRESHOLD · TIER_CURRENCY_GROWTH^tier scaled
     *  by BOTH overshoots: (size/target)^OVERSHOOT_EXP × (meanQuality/gate)^QUALITY_EXP.
     *  Phase 6a: the base is a POWER SURGE (the first reset must feel like ~1.5×,
     *  not a rounding error), the tier growth tracks SIZE_GROWTH (each reset buys a
     *  similar number of escalating-cost boost levels), and the size exponent is
     *  SUPERLINEAR — pushing past the gate out-earns resetting up to ~1.5–2× the
     *  size target, so push-vs-reset is a live decision (the endgame of a run). */
    CURRENCY_AT_THRESHOLD: 50,
    TIER_CURRENCY_GROWTH: 1.5,
    CURRENCY_OVERSHOOT_EXP: 1.3,
    CURRENCY_QUALITY_EXP: 1.5,
    /**
     * The champion gate's target profile per tier — AUTHORITATIVE (the player's
     * genomeTarget is a tracking aid only; letting it drive the gate meant you
     * could point the gate at whatever the flock already was). Hand-authored so
     * each tier demands a genuinely different breeding LINE; cycles past the end.
     * Patterned entries (alternating/paired slots) are real new puzzles because
     * inheritance is position-linked. Tier 0 matches GENOME.DEFAULT_TARGET.
     */
    TARGETS_BY_TIER: [
      ['L', 'L', 'L', 'L', 'L', 'L'], // T0: the classic lay god-clone
      ['L', 'L', 'V', 'V', 'H', 'H'], // T1: the generalist — three lines at once
      ['H', 'H', 'H', 'H', 'H', 'H'], // T2: the tank (pairs with 6c siege predators)
      ['V', 'V', 'V', 'V', 'L', 'L'], // T3: growth-heavy
      ['L', 'H', 'L', 'H', 'L', 'H'], // T4: alternating — a pure position puzzle
      ['H', 'H', 'V', 'V', 'L', 'L'], // T5: the generalist, re-slotted
    ] as readonly (readonly string[])[],
    /** Stackable global-scalar boosts. perLevel = fractional bump per level;
     *  cost for level L = round(baseCost · costGrowth^L). Renown/Husbandry (6a)
     *  hit the two clocks that actually pace a re-run — rank XP and the breeding
     *  timers — delivering the "retrace the arc far faster" promise. Pacing
     *  scalars ONLY: never a requirement, ration, clutch size, or genome odds. */
    BOOSTS: {
      output: { perLevel: 0.05, baseCost: 5, costGrowth: 1.5 }, // +5% station output / level
      stationSpeed: { perLevel: 0.05, baseCost: 5, costGrowth: 1.5 }, // +5% cycle speed / level
      eggValue: { perLevel: 0.08, baseCost: 8, costGrowth: 1.6 }, // +8% eggs laid / level
      // The Pond canvas is a fixed size, so layout provision caps out (~216 ducks
      // watered). This scales total water provision so a huge end-game flock can
      // still be kept watered — the meta lever past the layout ceiling.
      waterProvision: { perLevel: 0.1, baseCost: 6, costGrowth: 1.5 }, // +10% water provision / level
      renown: { perLevel: 0.1, baseCost: 5, costGrowth: 1.5 }, // +10% tend/dose XP / level (online-only XP law holds)
      husbandry: { perLevel: 0.1, baseCost: 6, costGrowth: 1.5 }, // +10% breeding & maturation speed / level
    } as Record<string, { perLevel: number; baseCost: number; costGrowth: number }>,
  },

  // ── Phase 6b: THE GRANGE (contracts board, unlocks at legacy tier 1) ─
  // A rotating offer board: ONE active contract at a time diverts laid eggs /
  // breeds to spec / defends a window, paying dust + a trickle of legacy
  // shards (+ a guaranteed module at the top notch). ALL contract clocks and
  // progress are ONLINE-ONLY (see game/contracts.ts) — offline catch-up never
  // advances a deadline, diverts an egg, or counts a hatch/scare. Contracts
  // NEVER touch the sim: they only observe existing lay/hatch/predator events
  // and divert already-produced eggs. Rewards are dust/shards/modules ONLY —
  // never eggs, resources, or XP.
  CONTRACTS: {
    UNLOCK_TIER: 1,
    OFFER_SLOTS: 3,
    OFFER_REFRESH_S: 600,
    REROLL_DUST: 5,
    /** Relative weights for the offer's TYPE roll. */
    TYPE_WEIGHTS: { delivery: 1, hatch: 1, defense: 1 } as Record<string, number>,
    /** Relative weights for the offer's difficulty NOTCH roll (easy-leaning). */
    NOTCH_WEIGHTS: [50, 35, 15],
    /** Per-notch reward band: dust (the bulk) + a small legacy-shard trickle.
     *  Only the top notch guarantees a module (fixed rarity, via loot.ts
     *  grantModule) — matches rank-milestone grants. All provisional pending
     *  playtest; watch-item: if shard farming ever beats prestiging, cut the
     *  shard bands here, not the dust. */
    REWARD_BY_NOTCH: [
      { dust: [10, 15], shards: [2, 3] },
      { dust: [18, 28], shards: [3, 5] },
      { dust: [35, 50], shards: [6, 9], moduleRarity: 'rare' },
    ] as { dust: [number, number]; shards: [number, number]; moduleRarity?: string }[],
    DELIVERY: {
      QUOTA_MINUTES: 10,
      MIN_QUOTA: 300,
      LIMIT_MIN: 15,
      /** Notch scales the snapshotted quota (self-balancing to live eggRate). */
      QUOTA_MULT_BY_NOTCH: [0.7, 1, 1.4],
    },
    HATCH: {
      /** Hard ceiling on specified slots — never all 6, always breedable-toward. */
      SPEC_MAX_SLOTS: 4,
      /** Specified-slot COUNT by notch (unspecified slots are "don't care"). */
      SLOTS_BY_NOTCH: [2, 3, 4],
      /** Chance a spec also requires a specific color, on top of the pattern. */
      COLOR_CHANCE: 0.4,
    },
    DEFENSE: {
      SCARE_COUNT_BY_NOTCH: [2, 3, 5],
    },
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
 * A zone is space with a signature. Adding one is a new entry in ZONE_DEFS —
 * NOT new code: the unlock flow, placement, and rendering iterate these defs.
 * The Yard is zone 0 and always unlocked. The two water canvases carry a
 * signature flag (`pondLayout` / `waterworks`) instead of being build space.
 */
export interface ZoneDef {
  id: string;
  name: string;
  /** This zone's own buildable tile grid (local coordinates). For the water
   *  canvases this is the puzzle surface, not build space. */
  grid: { width: number; height: number };
  /** Non-buildable region within the grid (e.g. the Yard pond). */
  blocked?: { x: number; y: number; w: number; h: number };
  /** Double-gated unlock. Absent ⇒ always unlocked (the Yard). */
  unlock?: { rankRequired: number; eggCost: number };
  /** Stage 1: the Pond layout-adjacency canvas (place provision features). */
  pondLayout?: boolean;
  /** Stage 2: the Waterworks circulation canvas (route flow over the pond). */
  waterworks?: boolean;
}

export const ZONE_DEFS: ZoneDef[] = [
  {
    id: 'yard',
    name: 'Yard',
    grid: BALANCE.GRID,
    blocked: BALANCE.POND,
  },
  {
    // Stage 1 — the Pond: a layout-adjacency canvas, not build space.
    id: 'pond',
    name: 'The Pond',
    grid: BALANCE.WATER.CANVAS,
    unlock: BALANCE.WATER.POND_UNLOCK,
    pondLayout: true,
  },
  {
    // Stage 2 — Waterworks (reuses the old back-pasture slot/id so a save that
    // already unlocked that zone keeps it). Circulation over the same canvas.
    id: 'backPasture',
    name: 'Waterworks',
    grid: BALANCE.WATER.CANVAS,
    unlock: BALANCE.WATER.WORKS_UNLOCK,
    waterworks: true,
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
/** Which built defense line protects against a predator: nets (aerial) or hardware
 *  cloth (ground). Each predator reads its OWN floor, so defense is a portfolio. */
export type DefenseType = 'net' | 'cloth';

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
  /** Attack attempts spread across each open window (fallback / mean). */
  attacksPerWindow: number;
  /** Optional weighted distribution of how many attempts THIS window brings — index
   *  i → i+1 attacks. Rolled hidden at each window open so the count is never
   *  predictable ("2 and done"). Falls back to attacksPerWindow when absent. */
  attackCountWeights?: readonly number[];
  /** Which built defense line reduces this predator's attack chance. */
  defense: DefenseType;
  /** Rank at which this predator starts hunting (debuts online, telegraphed). Lets
   *  new threats arrive as the homestead grows rather than all at once. */
  introRank: number;
}

export const PREDATOR_DEFS: PredatorDef[] = [
  {
    id: 'owl',
    name: 'Owl',
    ...BALANCE.PREDATORS.OWL,
    defense: 'net',
    introRank: BALANCE.PREDATORS.INTRO_RANK,
  },
  {
    id: 'raccoon',
    name: 'Raccoon',
    ...BALANCE.PREDATORS.RACCOON,
    defense: 'cloth',
    introRank: BALANCE.PREDATORS.RACCOON_INTRO_RANK,
  },
];

export const predatorDef = (id: string): PredatorDef | undefined =>
  PREDATOR_DEFS.find((p) => p.id === id);

/**
 * Auto-fill PLAYSTYLE PRESETS — selectable weightings for the rack optimizer.
 * Each preset is a full set of per-stat STAT_VALUE weights; selecting one tells
 * Auto-fill what to prefer when sockets are scarce. The weights are a pure assist
 * heuristic (they only order the optimizer's choices, never the sim). 'balanced'
 * mirrors the base STAT_VALUE. The player can also hand-edit the weights, which
 * switches the active preset to 'custom'. Keyed as Record<string, number> since
 * ModuleStat lives in state.ts (balance.ts must not import from it).
 */
export interface PlaystylePreset {
  id: string;
  label: string;
  /** One-line "when to pick this". */
  desc: string;
  weights: Record<string, number>;
}
export const PLAYSTYLE_PRESETS: PlaystylePreset[] = [
  {
    id: 'balanced',
    label: 'Balanced',
    desc: 'A sensible all-rounder — egg output first, production next, tending last.',
    weights: { ...BALANCE.LOOT.STAT_VALUE },
  },
  {
    id: 'active',
    label: 'Active Tender',
    desc: 'You’re here and tending: value the tend levers (bigger bursts, shorter cooldowns) and condition recovery.',
    weights: {
      eggOutput: 1.3,
      stationSpeed: 0.9,
      stationYield: 0.9,
      conditionRegen: 0.9,
      tendPower: 1.5,
      tendCooldown: 1.5,
    },
  },
  {
    id: 'idle',
    label: 'Idle / AFK',
    desc: 'Going away: tending does nothing offline, so go all-in on passive production + egg output.',
    weights: {
      eggOutput: 1.6,
      stationSpeed: 1.3,
      stationYield: 1.3,
      conditionRegen: 0.7,
      tendPower: 0,
      tendCooldown: 0,
    },
  },
];

/** The default (Balanced) weights — the seed for a fresh save + old-save fallback. */
export const DEFAULT_STAT_WEIGHTS: Record<string, number> = PLAYSTYLE_PRESETS[0].weights;

export const playstylePreset = (id: string): PlaystylePreset | undefined =>
  PLAYSTYLE_PRESETS.find((p) => p.id === id);
