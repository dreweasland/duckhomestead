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

**Nutrition = the "power grid" (first-class constraint):**
- Balanced feed (energy + niacin/riboflavin) keeps ducks at full lay.
- Deficiency throttles output / causes "off" ducks → an optimization puzzle, not a hard wall.
- "Batteries" = feed storage + the flock's condition reserve (the offline buffer).

**Loot / modules (machine-centric):**
- Stations have N slots; modules give stacking % boosts, rarity-scaled.
- Drop from production (loot-table dopamine) + craftable for deterministic progress.
- Salvage/reroll so dupes aren't dead.

**Breeding & genetics:**
- Swedish color genetics (incomplete-dominance Bl locus) gate breed unlocks → Blue / Splash / Black outcomes as collectible milestones.

**Predators (Dane County owls):**
- Threat events that active play defends against; pure idle leaves you slightly exposed — another reason active > idle.

**Empire / prestige:**
- Yard → back pasture → pond → second homestead.
- Prestige = "raise a champion flock / start a new legacy" for a permanent multiplier.

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

**Phase 1 — Prove the loop + the DING (MVP):**
- Bounded tile grid render, place 2–3 station types
- One chain: feed plot → feed mill → coop (produces eggs)
- Tick loop with **online vs offline rate split**
- **Minimal Homestead Rank bar + one milestone unlock** (so the grind→DING feel is testable)
- Save/load to localStorage with capped offline catch-up
- *Goal: earn → away → return → play → DING works end to end, and the active/idle balance* feels *right.*

**Phase 2 — Nutrition grid:** feed balance, deficiency throttling, storage/reserve caps.

**Phase 3 — Loot:** module system, rarity, drop tables, slotting/salvage/reroll UI.

**Phase 4 — Depth & scale:** breeding/genetics, predators, zone expansion, prestige.

**Phase 5 — Juice:** pixel-art pass, number-pops, DING sound/banner, save export/import, Supabase sync.

## 9. Decisions — LOCKED

- ✅ **Loot:** machine-centric (stations only, no character avatar)
- ✅ **Map:** bounded first, expansion in Phase 4
- ✅ **Theme:** duck-homestead reskin
- ✅ **Offline cap:** ~8h (one night's sleep); idle is a floor, never a substitute for play

---

*v2 — economy philosophy is now the spine. Tighten Phase 1 ruthlessly; prove the active/idle feel before adding systems.*