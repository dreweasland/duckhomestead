# Project Brief — Duck Homestead (Automation Incremental)

> Working title ideas: **Homestead**, **Lay of the Land**, **Quack & Tend**, **The Flock**.
> A single-player, browser-based automation incremental for personal use. Tend and optimize a pixel-art duck homestead on a bounded tile grid; baseline production trickles while away; **active play** drives the leveling grind, loot modules, and milestone unlocks.

---

## 0. Economy Philosophy (the core design law)

**Idle is the floor. Active play is the engine.**

Two failure modes to avoid:
- **Idle that blocks** — timers forcing you to wait to progress. (Frustrating; feels like a mobile cash-grab.)
- **Idle that replaces play** — offline gains so generous that logging in is collect → upgrade → log off. (Brainless; no engagement.)

The rule:
- **Offline** runs at a *reduced rate* (start ~40% of online) and only the **base tiers** tick — advanced chains and any decision step pause. Coming back always gives a cushion to *do something*; it never hands you the good stuff.
- **Active** is where levels, rare modules, and milestones come from — via actions the sim can't auto-do: tending, collecting at peak, breeding/routing decisions, predator defense, hand-crafting.
- Result: **never blocked waiting, never able to skip play.**

Tuning dials: the online:offline rate ratio, the offline cap (~8h = one night's sleep), and milestone spacing.

## 1. The Progression Spine — "the DING"

The WoW leveling grind is the model: tedious at times *by design*, because that tension is what makes the payoff land.

- **Homestead Rank** bar, filled mostly by active play. Big, juicy level-up feedback — sound, banner, screen pop.
- **Milestone ranks** = identity-defining unlocks, spaced so each is an *event* (the "first mount at 40" feeling):
  - First new duck **breed** (Blue / Splash / Black via Swedish color genetics)
  - **Auto-haul cart** — the literal "first mount": a QoL unlock that changes how the whole homestead runs
  - Unlock the **pond** (new production + water requirement)
  - First **Legendary bloodline** (top-tier prize module)
  - The **back pasture** (zone expansion)
  - **Predator defenses** (owl deterrents)
- Curve has slight grind-tension right before each milestone so the DING pays off.

## 2. The Core Fusion

Three reward axes feeding one loop, all driven by active play:
- **Throughput / automation:** place stations, route feed, scale egg/duckling output.
- **Loot (machine-centric):** rarity-tiered **modules** (Common → Uncommon → Rare → Epic → Legendary) slot into stations for % boosts (yield, speed, uptime, feed-efficiency). Drop probabilistically from production + a craft path.
- **Empire / number-go-up:** unlock zones with richer resources; prestige for a permanent "legacy flock" multiplier.

Loop: **tend → throughput climbs → funds modules/upgrades → climbs higher → expand → DING.**

## 3. Session Rhythm (hybrid)

- **Active session:** lay out stations, balance the feed/nutrition grid, slot/reroll modules, make breeding calls, plan the next expansion, defend against predators.
- **Away phase (≤8h cap):** base production trickles at reduced rate, gated by storage + the flock's nutrition reserve.
- **Return:** collect the cushion, then *play* — that's where ranks and loot happen.

## 4. Systems

**Resource tiers:**
- T1 raw: corn, greens, mealworms, water, straw
- T2 processed: cracked corn, pellets, clean water (feed mill)
- T3 components: balanced rations, bedding, **eggs** (coop)
- T4 advanced: **ducklings**, breeding stock, premium genetics

**Nutrition Grid = the "power grid" (first-class constraint):**

This is what turns the game from a linear chain into a balancing act — the homestead's electricity. The key move is making nutrition **multi-dimensional**: you don't stockpile one feed number, you *compose a ration* that must hit several targets at once.

- **Four nutritional axes** (all grounded in real duck nutrition):
  - **Energy** (corn, scratch) — cheap, fast; general activity / baseline output multiplier. Corn-heavy = empty calories.
  - **Protein** (mealworms, peas) — drives lay rate (and duckling growth once breeding exists); slower/costlier to produce.
  - **Niacin** (brewer's yeast) — the duck one. Sustained deficiency builds a leg/joint debuff on individual ducks (Potato's real issue, as a mechanic).
  - **Calcium** (oyster shell) — eggshell quality; short on it → soft eggs get discarded → egg output drops.
- **It's a real grid, not a slider:** each ingredient costs **grid space + throughput** to produce (mealworms slow, corn fast, brewer's yeast its own line). So balancing nutrition is a *layout & throughput* problem — the optimization itch in duck form.
- **Feed-formulation dashboard:** set the ration proportions; live per-axis readout (supply vs requirement, green/yellow/red); shows resulting output modifiers. `balance.ts` made visible and playable.
- **Ingredients are multi-axis (overlapping), not one-per-axis.** A diagonal matrix makes formulation trivial — proportions are forced. Overlap is what makes the dashboard a real tradeoff: hitting one axis nudges another. Starting matrix (tunable):
  ```
  corn           energy 1.0   protein 0.1
  peas           energy 0.4   protein 0.6
  mealworms      energy 0.2   protein 1.0
  brewers yeast  protein 0.3  niacin  1.0
  oyster shell   calcium 1.0
  ```
  Calcium stays single-source (realistic for a mineral). The puzzle isn't *in* the system until the matrix overlaps.
- **Supply = current storage stock, read each tick** (not production rate). `satisfaction = stock-for-axis / requirement`. While ingredient lines keep up, stock stays positive → satisfaction holds; it only dips when a line can't keep pace, which is exactly when the throttle should show. Flock condition buffers brief stock-outs so output reads stable, not strobing.
- **Throttle, not wall:** a deficiency reduces the *specific* output tied to that axis, scaled by severity (20% short = gentle penalty, not a stop). Never hard-blocked — just suboptimal, with the dashboard pointing at the fix.
- **Flock condition = the battery:** a slow-moving reserve well-fed ducks build up. It carries the flock through brief shortfalls (like an accumulator through a power dip) and governs offline: while you sleep, the flock coasts on the reserve at the ration you left set. Balanced → wake up fine; marginal → wake to a throttled, degraded homestead (another nudge toward active play).
- **Interventions are active-only:** dosing a niacin-deficient duck with brewer's yeast to clear its leg debuff is something *you* do — idle never resolves problems for you.
- **Keep it from becoming chore-y:** a good mix *holds* once set (only revisit on new axis / scale-up); the condition reserve smooths small imbalances; the throttle is fully legible so every fix is a clear decision, not guesswork.

Later stages deepen it: different life stages want different profiles (ducklings = high niacin + protein, laying hens = calcium), so once breeding lands you can't run one universal ration.

**Architecture (locked, Phase 2):** Nutrition *replaces* the pellet step — it isn't layered on top. Egg output = base × f(energy)·f(protein)·f(calcium). `pellets` is retired: kept as a dead field in `GameState`/saves for back-compat, but nothing produces or consumes it. (Considered and deferred: a *stored feed intermediate* where the Mill produces a feed buffer the coop draws down — preserves an extra throughput layer + smoother offline accounting, but buffered feed bakes in its composition at mill-time. Clean, isolated upgrade for later if the Mill ever feels hollow; not worth the cost during the feel-test.)

**Loot / modules (machine-centric) — locked design:**
- **Throughput only.** Modules boost station speed/yield, egg output, condition regen, tend levers — they **never touch nutrition requirements or the axis/satisfaction math.** A speed/yield module *re-tilts* the formulation optimum (shifts where peas-vs-mealworms crosses); it can't delete a constraint. This is the primary guardrail protecting the validated nutrition puzzle.
- **Rarity tiers** Common → Uncommon → Rare → Epic → Legendary, each with a **rolled magnitude range** (a Rare rolls within a band, not a fixed value) — so a drop is a "good roll?" moment and reroll has purpose.
- **Two sources:** guaranteed module grants at **rank milestones** (predictable, ties to the DING) + **random drops from active play** (loot-table thrill). **Modules never drop offline/passively** — they're "the good stuff," and idle never hands you that.
- **Additive + diminishing returns** stacking, per-stat soft cap (`applied = cap·(1−e^(−rawSum/cap))`): early modules feel full-value, later ones taper, power can't run away.
- **Limited slots** per station (start ~2) force which-boost-where choices — the fourth guardrail.
- **Salvage → dust → reroll** so dupes aren't dead.
- *The four guardrails together (throughput-only · diminishing returns · limited slots · active-only drops) are what keep a lucky Legendary from trivializing the economy.*

**Breeding & genetics — locked design (Phase 4a):**
- **Two orthogonal axes.** *Color* = the Bl locus (Mendelian, incomplete dominance: 0 blue alleles = Black, 1 = Blue, 2 = Splash; Blue×Blue → 1:2:1 Black:Blue:Splash; Black×Splash → all Blue) — the **collection** grind, popping a rare Splash is a DING. *Vigor* = a continuous heritable production stat — the **power** grind. Independent: a pretty Splash can be a poor layer → the breeder's real dilemma (breed for the dex or for production).
- **Vigor is throughput-only.** It boosts egg output, never reduces a duck's nutrition requirement (same guardrail as loot).
- **Vigor inheritance = regression toward the mean (breeder's equation).** `offspring ≈ popMean + h²·(midparent − popMean) + noise`, clamped to a ceiling. **`popMean` must be the *live* flock mean** (recomputed as you cull/replace), or the grind plateaus/decays instead of climbing. Self-limiting → steady, *bounded* cumulative progress toward the ceiling, never runaway. (NB: an earlier draft wrote `midparent + h²·(…)`, which compounds — wrong; the `popMean +` form is correct.)
- **Selection needs BOTH halves.** Pairing your best (positive selection) *and* releasing your worst (culling = truncation selection). Culling frees housing and lifts the live `popMean`, raising the breeding target so the flock climbs. Without a release action the flock dilutes with regression-to-mean offspring and housing deadlocks — the power grind stalls (~1.15) and is non-functional. A per-duck "release" action is required. Orthogonality is what keeps releasing from being a brainless treadmill (a low-vigor duck may be a rare color worth keeping).
- **Population is the scaling lever.** Adult layers are the output unit (total eggs = Σ per-duck base × vigor × nutrition throttle × module boosts). Nutrition re-points from **per-coop → per-duck** (the validated layer puzzle math is untouched — just driven by adult count). Coops become **housing/capacity** (cap on ducks).
- **Eggs are dual-purpose** — currency *or* future duck. A breeding pair (drake + hen) throws a clutch of fertilized eggs; incubate (consuming the **separate duckling ration**) → hatch with genotype + vigor rolled from parents. Surplus eggs stay currency. Every clutch is a spend-vs-grow choice.
- **Separate duckling ration** (high niacin + protein, its own formulation) gates maturation rate/health → the throughput pipe for flock growth. Crucially it draws from the **same ingredient storage as layers — layers eat first** — so growing the flock *competes* with feeding it; the growth puzzle threads back into the validated layer economy rather than running as a parallel supply chain. Under scarcity, growth throttles before laying does (penalty floor 0.3, never a hard wall); sustained tight protein/niacin → slow grow-out → natural pressure toward feed-economy & grid expansion (a key motivator for zones, 4b). Maturation runs online & offline, but only as well as the ration left set.
- Build order puts the duckling ration **last** (clean cut-point if the session runs long).

**Predators — locked design (4c):**
- **Stakes are real (Drew's pick): any duck can be targeted, breeders included; losses are mixed — usually soft, rare permanent.** Defense is *both* a built floor and active cover.
- **Locked principle — attributability:** every permanent loss must trace to a *choice* (absence, under-defense, or a neglected wound), **never pure RNG out of nowhere.** This is what makes high stakes feel earned instead of griefed (and kills the save-scum urge).
- **Mechanisms:** (a) **telegraphed windows** — danger is signaled (dusk/warning), so risk is a decision not an ambush; (b) **built deterrents = protection floor**, **active presence during a window = full cover**; (c) a landed attack is almost always a **wound (soft)**; a wounded duck **escalates to permanent loss only if untended** within a recovery window → active care is the save; (d) **securable breeders** (defended coop / lockdown) — nothing inherently safe, but the irreplaceable is protectable if you invest/act.
- **Brutality dial:** default = wound-escalation only (every death preventable). Optional `balance.ts` toggle for a **rare instant snatch** (owl just takes a duck, no wound phase) — more brutal/memorable, save-scum-tempting.
- **Offline = exposure:** windows that pass while away get only the built floor (no presence); unsecured wounds escalate past the timer. A careful player (defenses up, breeders secured) takes soft losses, not a wipe — extended absence during risk windows is where it bites. Enforces active > idle.
- **Scope:** one predator (the owl — Dane County) as extensible template; foxes/hawks later config.

**Zones / empire — locked design (4b onward):**
- **Extensible, data-driven zone system.** Yard → back pasture → pond → second homestead. Each unlocked zone adds buildable space **and a signature resource/mechanic**. Build the *system* once; each new zone is config, not new architecture. Back pasture is the first instance (template).
- **Shared economy, NO inter-zone logistics.** Zones add space + local nodes to the single shared storage. No transport/belts/routing layer (that's a different game). The one formulation economy stays intact.
- **Double-gated unlock:** reach a **rank threshold** AND pay a **big egg sink**. Zones show **teased-but-locked** on the map from the start (the aspirational silhouette you climb toward — the "first mount" feeling). Unlocking is a milestone DING.
- **Back pasture signature = free-range forage, ENERGY-ONLY.** The locked principle that lets "passive cheap feed" coexist with idle-is-the-floor: forage passively produces *only energy* — the cheapest, least-constraining axis — and nothing else. Passivity is harmless because energy was never the bottleneck (protein/niacin/calcium are), so it can't trivialize the puzzle. Fixed-rate node → **self-diminishing** (early relief, late irrelevance). Runs offline at reduced rate, no XP. (Veto path: nutritionally-complete forage would trade away puzzle integrity.)
- Unlocking the pasture also **relieves 4a's cramp** — more space for coops (housing) + the energy floor — so the breeding number-go-up engine finally has room.
- Prestige (4d) = "raise a champion flock / start a new legacy" for a permanent multiplier.

## 5. Duck-Homestead Reskin Map

| Industrial concept | Duck-homestead skin |
|---|---|
| Miner / gatherer | Feed plot / forager |
| Smelter / processor | Feed mill |
| Assembler | Coop / nesting station (→ eggs → ducklings) |
| Power grid | Nutrition (balanced feed; deficiency throttles) |
| Batteries (offline buffer) | Feed storage + flock condition |
| Modules (loot) | Feeders, heated coops, waterers, bloodlines |
| Module rarity | Equipment quality / bloodline prestige |
| "First mount" milestone | Auto-haul cart |
| Zones | Yard → back pasture → pond → 2nd homestead |
| Prestige | Start a new legacy flock (permanent multiplier) |

## 6. Tech Stack

- **UI (menus, inventory, modules, rank screen):** React + Vite + Tailwind (your TOY stack — most of an incremental is UI).
- **Tile world:** **PixiJS** (fast WebGL 2D, you own the sim) or **Phaser 3** (more built-in tilemap tooling) as a canvas panel inside React.
- **State:** single serializable game-state object; sim decoupled from rendering.
- **Persistence:** localStorage to start; Supabase later for cloud saves.
- **Assets:** [Kenney.nl](https://kenney.nl) (CC0 pixel packs) for fastest start; hand-make hero duck sprites.

## 7. Tick Engine & Offline Progress

- **Fixed-timestep tick loop** (e.g. 10/sec) updates production; rendering separate via requestAnimationFrame.
- **Two production rates:** `online` (full) vs `offline` (~40%, base tiers only). The single most important number to tune.
- **Offline catch-up:** on load, compute elapsed time (capped ~8h), run catch-up ticks at the offline rate, clamped by storage + nutrition reserve. Start with **capped catch-up ticking** (correct by construction); optimize to closed-form later if needed.

## 8. Phased Build Plan (Claude Code milestones)

**Phase 1 — Core loop + the DING ✅ BUILT & VALIDATED**
**Phase 2 — Nutrition grid ✅ BUILT & VALIDATED** (peas-vs-mealworms confirmed a real throughput-vs-density puzzle)
**Phase 3 — Loot / modules ✅ BUILT & VALIDATED** (throughput-only; power cap holds at ~+41-45%/station; tail weights nudged for in-session high-end drops)

**Phase 4 — Depth & scale (split into sub-phases; do NOT build as one):**
- **4a — Breeding & genetics** (keystone): two-axis selective breeding (color collection × heritable vigor), population scales output, separate duckling ration. ← *current*
- **4b / 4c — Zones & predators** (scale pressure + risk pressure), order TBD. Predators threaten the duckling pipeline → why breeding goes first.
- **4d — Prestige** (last): legacy-flock reset for a permanent multiplier — only meaningful once the full game exists.

**Phase 5 — Juice:** pixel-art pass, number-pops, DING sound/banner, save export/import, Supabase sync.

## 9. Decisions — LOCKED

- ✅ **Loot:** machine-centric (stations only, no character avatar)
- ✅ **Map:** bounded first, expansion in Phase 4
- ✅ **Theme:** duck-homestead reskin
- ✅ **Offline cap:** ~8h (one night's sleep); idle is a floor, never a substitute for play

---

*v8 — Phase 4b (back pasture) built & validated. Predators (4c) locked: real stakes (any duck, mixed soft/rare-permanent), both-defense (floor + active), with the attributability principle — every permanent loss traces to a choice (absence/under-defense/neglected wound), never pure RNG. Telegraphed windows + wound-escalation + securable breeders; instant-snatch on a toggle. One owl, extensible. Phase 4c prompt written from this section.*