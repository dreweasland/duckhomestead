import { BALANCE, EXCLUSIVE_STATIONS, STATION_DEFS, ZONE_DEFS, zoneDef, type StationType } from '../config/balance';
import { clutchCost } from './breeding';
import { onEggsLaid } from './contracts';
import {
  activeStatWeights,
  cycleMult,
  grantModule,
  rackScore,
  rollMagnitude,
  salvageDust,
  spareOutlook,
  tendCooldownMult,
  tendPowerMult,
  yieldMult,
} from './loot';
import { outputBoostMult, renownBoostMult, speedBoostMult } from './prestige';
import { milestoneAtRank, xpForLevel, type Milestone } from './rank';
import { waterWoundMult } from './water';
import type { Gene, GameState, Ingredient, Module, Rarity, Resource, Station } from './state';
import {
  adultDrakes,
  adultLayers,
  breedingEstablished,
  deterrentCost,
  hardwareClothCost,
  infirmaryCapacity,
  infirmaryCost,
  infirmaryOccupied,
  INGREDIENTS,
  isBlockedTile,
  rackSockets,
  secureCapacity,
  secureCoopCost,
  winterCapacity,
  seedFlock,
  stationAt,
  zoneUnlocked,
} from './state';

/** Output/throughput multiplier for a station at a given level. */
export function UPGRADE_OUTPUT(level: number): number {
  return Math.pow(BALANCE.UPGRADE.outputMultPerLevel, level - 1);
}

/** The ingredient producers (plot + the four ingredient farms). They scale on a
 *  gentler, CAPPED curve so producer COUNT grows with the flock (fill the board),
 *  rather than one towering tile feeding everything. Coops + mill are NOT here. */
export const INGREDIENT_PRODUCERS = new Set<StationType>([
  'plot',
  'peaPatch',
  'mealwormFarm',
  'yeastVat',
  'oysterSource',
  // Phase 6d: the two Winterstead ingredient lines scale on the same capped curve.
  'seedStore',
  'fodderRack',
]);

/** Phase 6d: pure winter infrastructure — no cycles, no upgrades (v1). Housing,
 *  warmth, and water support scale by COUNT, like defenses. */
export const NO_UPGRADE_STATIONS = new Set<StationType>(['winterCoop', 'heater', 'heatedWaterer']);

/** Output multiplier for an ingredient producer: gentler slope, capped at levelCap. */
export function PRODUCER_OUTPUT(level: number): number {
  const { outputMultPerLevel, levelCap } = BALANCE.UPGRADE.PRODUCER;
  return Math.pow(outputMultPerLevel, Math.min(level, levelCap) - 1);
}

/** Output multiplier for a station: the capped producer curve for ingredient farms,
 *  the standard uncapped upgrade curve for everything else (coops, mill). */
export function stationOutputMult(type: StationType, level: number): number {
  return INGREDIENT_PRODUCERS.has(type) ? PRODUCER_OUTPUT(level) : UPGRADE_OUTPUT(level);
}

/** A producer at its output cap — further upgrades would cost eggs for no gain, so
 *  they're blocked (build another producer instead). Non-producers never cap. */
export function producerMaxed(station: Station): boolean {
  return INGREDIENT_PRODUCERS.has(station.type) && station.level >= BALANCE.UPGRADE.PRODUCER.levelCap;
}

/** Egg cost to upgrade a station from its current level to the next. Producers
 *  climb their own STEEPER curve (wide-then-tall; see UPGRADE.PRODUCER) —
 *  mills/coops keep the standard one (they're the uncapped scale ladder). */
export function upgradeCost(station: Station): number {
  const base = BALANCE.UPGRADE.baseCost[station.type];
  const growth = INGREDIENT_PRODUCERS.has(station.type)
    ? BALANCE.UPGRADE.PRODUCER.costGrowth
    : BALANCE.UPGRADE.costGrowth;
  return Math.round(base * Math.pow(growth, station.level - 1));
}

/**
 * Whether a station can currently run a cycle, i.e. central storage holds its
 * inputs. Stations buffer their own output separately; downstream stations only
 * see an input once it's been hauled to central (manual Collect or auto-haul).
 * This is what surfaces "Coop idle — needs pellets" in the UI.
 */
export function stationStatus(
  state: GameState,
  station: Station,
): { producing: boolean; missing?: { res: Resource; need: number; have: number } } {
  const def = STATION_DEFS[station.type];
  const mult = UPGRADE_OUTPUT(station.level);
  for (const key of Object.keys(def.inputs) as Resource[]) {
    const need = (def.inputs[key] ?? 0) * mult;
    if (state.resources[key] < need) {
      return { producing: false, missing: { res: key, need, have: state.resources[key] } };
    }
  }
  return { producing: true };
}

/** Effective per-cycle output(s) of a station — base × level × rack yield × legacy
 *  boost, i.e. the amount that lands in its buffer each cycle (what you collect).
 *  Mirrors tick.ts's stationOutput so the UI reads the true yield, not the raw
 *  base. Coops are special-cased in the sim (eggs come from nutrition), so their
 *  raw `outputs.eggs` is NOT a meaningful lay rate — the UI shows duck capacity
 *  for coops instead. */
export function outputPerCycle(
  state: GameState,
  station: Station,
  // The level-independent throughput scalar (rack yield × legacy output). Accept it
  // precomputed so a caller looping over many stations builds it once, not per call.
  throughputMult = yieldMult(state) * outputBoostMult(state),
): { resource: Resource; amount: number }[] {
  const def = STATION_DEFS[station.type];
  const m = stationOutputMult(station.type, station.level) * throughputMult;
  return (Object.keys(def.outputs) as Resource[])
    .map((resource) => ({ resource, amount: (def.outputs[resource] ?? 0) * m }))
    .filter((o) => o.amount > 0);
}

/** Per-second economy flow for one resource: what's PRODUCED (in) vs what the feed
 *  blend + duckling grow-out ration CONSUME (out). Powers the currency-flow
 *  breakdown. Rates, not stock — the net is `in − out`, so `out > in` (consumption
 *  outpacing production) means the stock is draining.
 *
 *  Income: raw producers run input-free so their rate is steady (output/cycle ÷
 *  effective cycle time); eggs come from the flock at the live nutrition egg rate.
 *  Outgo: only the five blendable ingredients are consumed — by the layers (mill-
 *  capacity throttled) and by growing ducklings (same storage pool). */
export function resourceFlow(state: GameState, resource: Resource): { in: number; out: number } {
  let inflow = 0;
  if (resource === 'eggs') {
    // Home lay + (6d) the premium winter lay — one shared egg pool.
    inflow = (state.nutrition?.eggRate ?? 0) + (state.winter?.eggRate ?? 0);
  } else {
    // Hoist the loop-invariant throughput multipliers (each O(rack)) — they were
    // recomputed per station (and again inside outputPerCycle).
    const cm = cycleMult(state);
    const sbm = speedBoostMult(state);
    const tput = yieldMult(state) * outputBoostMult(state);
    for (const s of state.stations) {
      const def = STATION_DEFS[s.type];
      if (!(resource in def.outputs)) continue;
      const eff = (def.cycleSeconds * cm) / sbm;
      if (eff <= 0) continue;
      const out = outputPerCycle(state, s, tput).find((o) => o.resource === resource);
      if (out) inflow += out.amount / eff;
    }
  }

  let outflow = 0;
  if (resource === 'eggs') {
    // The clutch drain (4a dual-purpose law): each VALID pair (both parents
    // present, adult, unwounded — mirrors runBreeding) spends CLUTCH_SIZE ×
    // FERTILIZED_EGG_COST per interval, scaled by the drake-ration breed rate.
    const B = BALANCE.BREEDING;
    const byId = new Map(state.ducks.map((d) => [d.id, d]));
    let pairs = 0;
    for (const p of state.breedingPairs) {
      const dr = byId.get(p.drakeId);
      const he = byId.get(p.henId);
      if (!dr || dr.sex !== 'drake' || dr.stage !== 'adult' || dr.wounded) continue;
      if (!he || he.sex !== 'hen' || he.stage !== 'adult' || he.wounded) continue;
      pairs++;
    }
    if (pairs > 0) {
      const breedRate = state.drakeNutrition?.breedRate ?? 1;
      outflow += (pairs * clutchCost(state) * breedRate) / B.CLUTCH_INTERVAL_S;
    }
  }
  if ((INGREDIENTS as readonly string[]).includes(resource)) {
    const ing = resource as Ingredient;
    const coopCycle = BALANCE.COOP.cycleSeconds;
    const layers = adultLayers(state).length;
    const feedScale = state.nutrition?.feedScale ?? 0; // mill-capacity throttle
    outflow += (((state.ration[ing] ?? 0) * layers) / coopCycle) * feedScale;
    const immature = state.ducks.filter((d) => d.stage !== 'adult').length;
    outflow += ((state.ducklingRation[ing] ?? 0) * immature) / coopCycle;
    // Drakes draw their maintenance ration too, once breeding's established.
    if (breedingEstablished(state)) {
      const drakes = adultDrakes(state).length;
      outflow += ((state.drakeRation[ing] ?? 0) * drakes) / coopCycle;
    }
    // Phase 6d: wintering hens draw the winter ration from the same stores.
    const wintering = state.winter?.henCount ?? 0;
    if (wintering > 0) outflow += ((state.winterRation[ing] ?? 0) * wintering) / coopCycle;
  }

  return { in: inflow, out: outflow };
}

/** Feed-mill load: how the flock's blend DEMAND compares to mill CAPACITY — the
 *  partnership between ingredient feed and mills. ratio ≥ 1 means the mills can't
 *  keep up (the ration is throttled, feedScale < 1) so another mill / an upgrade
 *  is due; well under 1 means headroom. Null when there's no flock to feed. */
export function millLoad(
  state: GameState,
): { capacity: number; demand: number; ratio: number; feedScale: number; hasMill: boolean } | null {
  const n = state.nutrition;
  if (!n) return null;
  const ratio = n.millCapacity > 0 ? n.feedDemand / n.millCapacity : n.feedDemand > 0 ? Infinity : 0;
  return {
    capacity: n.millCapacity,
    demand: n.feedDemand,
    ratio,
    feedScale: n.feedScale,
    hasMill: n.hasMill,
  };
}

export type ActionResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const fail = (reason: string): ActionResult<never> => ({ ok: false, reason });
const done = <T>(value: T): ActionResult<T> => ({ ok: true, value });

// ── Placement ─────────────────────────────────────────────────────────
export function placeStation(
  state: GameState,
  type: StationType,
  x: number,
  y: number,
  zoneId = 'yard',
): ActionResult<Station> {
  const zone = zoneDef(zoneId);
  if (!zone) return fail('No such zone');
  if (!zoneUnlocked(state, zoneId)) return fail('Zone locked');
  if (zone.pondLayout || zone.waterworks) return fail('That’s a water canvas, not build space');
  // Phase 6d: zone-station compatibility, both directions — a zone with an
  // allowedStations list accepts ONLY those; every other zone rejects any
  // zone-exclusive type (winter gear can't heat the yard).
  if (zone.allowedStations) {
    if (!zone.allowedStations.includes(type)) return fail(`Can’t build that at ${zone.name}`);
  } else if (EXCLUSIVE_STATIONS.has(type)) {
    return fail(`That only works at ${ZONE_DEFS.find((z) => z.allowedStations?.includes(type))?.name ?? 'its own site'}`);
  }
  if (x < 0 || y < 0 || x >= zone.grid.width || y >= zone.grid.height) {
    return fail('Out of bounds');
  }
  if (isBlockedTile(zoneId, x, y)) return fail('That’s the pond');
  if (stationAt(state, x, y, zoneId)) return fail('Tile occupied');
  const cost = BALANCE.COSTS[type];
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);

  state.resources.eggs -= cost;
  const station: Station = {
    id: `s${state.nextStationId++}`,
    type,
    zoneId,
    x,
    y,
    level: 1,
    cycleProgress: 0,
    buffer: {},
    // A fresh build starts on a full tend cooldown — nothing to tend yet.
    // (Also closes the place→tend→remove loop: a 50% refund plus an instant
    // tend bought unbounded XP + loot rolls at click speed for ~5 eggs/cycle.)
    tendCooldownRemaining: BALANCE.TEND_COOLDOWN_S,
  };
  state.stations.push(station);
  // First coop seeds the starting flock (housing now exists for it).
  if (type === 'coop' && state.ducks.length === 0) seedFlock(state);
  return done(station);
}

/**
 * Pre-place the free starter engine — plot + mill + coop — on a fresh state.
 * The floor under BOTH a brand-new game (save.ts newGame) and a post-prestige
 * run (prestige.ts prestigeReset): eggs flow from t=0, the coop seeds the
 * flock, and nothing can softlock. Preserves the caller's egg stipend (the
 * stations are free); the starters arrive tend-ready — the pre-place isn't the
 * player's build, so the anti-exploit placement cooldown doesn't apply.
 */
export function placeStarterEngine(state: GameState): void {
  const stipend = state.resources.eggs;
  state.resources.eggs = Number.MAX_SAFE_INTEGER;
  placeStation(state, 'plot', 2, 3);
  placeStation(state, 'mill', 3, 3);
  placeStation(state, 'coop', 4, 3);
  state.resources.eggs = stipend;
  for (const s of state.stations) s.tendCooldownRemaining = 0;
}

// ── Remove (demolish, partial egg refund) ─────────────────────────────
export function removeStation(
  state: GameState,
  stationId: string,
): ActionResult<{ refund: number }> {
  const idx = state.stations.findIndex((s) => s.id === stationId);
  if (idx < 0) return fail('No such station');
  const station = state.stations[idx];
  const refund = Math.floor(BALANCE.COSTS[station.type] * BALANCE.REFUND_FRACTION);
  state.resources.eggs += refund;
  // (Modules live in the homestead rack now, not on stations — nothing to return.)
  state.stations.splice(idx, 1);
  // Phase 6d: demolishing a winter coop can strand assigned ducks past capacity —
  // the excess walk home on their own (auto-recall; never a loss).
  if (station.type === 'winterCoop') {
    const cap = winterCapacity(state);
    const assigned = state.ducks.filter((d) => d.site === 'winter');
    for (let i = assigned.length - 1; i >= cap && i >= 0; i--) assigned[i].site = 'home';
  }
  return done({ refund });
}

// ── Move (relocate, free) ─────────────────────────────────────────────
export function moveStation(
  state: GameState,
  stationId: string,
  x: number,
  y: number,
): ActionResult<Station> {
  const station = state.stations.find((s) => s.id === stationId);
  if (!station) return fail('No such station');
  const zone = zoneDef(station.zoneId);
  if (!zone) return fail('No such zone');
  // Moves stay within the station's own zone (no inter-zone transport).
  if (x < 0 || y < 0 || x >= zone.grid.width || y >= zone.grid.height) {
    return fail('Out of bounds');
  }
  if (isBlockedTile(station.zoneId, x, y)) return fail('That’s the pond');
  const occupant = stationAt(state, x, y, station.zoneId);
  if (occupant && occupant.id !== stationId) return fail('Tile occupied');
  station.x = x;
  station.y = y;
  return done(station);
}

// ── Unlock a zone (Phase 4b: double-gated — rank AND egg cost) ─────────
export function unlockZone(state: GameState, zoneId: string): ActionResult<{ name: string }> {
  const zone = zoneDef(zoneId);
  if (!zone) return fail('No such zone');
  if (zoneUnlocked(state, zoneId)) return fail('Already unlocked');
  if (!zone.unlock) return fail('Zone has no unlock');
  // Phase 6d: some zones carry a legacy-tier floor (Winterstead: tier 3) —
  // checked FIRST so the tease reads as a legacy gate, not a rank/egg problem.
  if (zone.unlock.minLegacyTier != null && state.legacyTier < zone.unlock.minLegacyTier) {
    return fail(`Requires Legacy Tier ${zone.unlock.minLegacyTier}`);
  }
  if (state.rank < zone.unlock.rankRequired) return fail(`Reach Rank ${zone.unlock.rankRequired}`);
  if (state.resources.eggs < zone.unlock.eggCost) return fail(`Need ${zone.unlock.eggCost} eggs`);
  state.resources.eggs -= zone.unlock.eggCost;
  (state.zones[zoneId] ??= { unlocked: false }).unlocked = true;
  return done({ name: zone.name });
}

// ── Upgrade ───────────────────────────────────────────────────────────
export function upgradeStation(state: GameState, stationId: string): ActionResult<Station> {
  const station = state.stations.find((s) => s.id === stationId);
  if (!station) return fail('No such station');
  if (NO_UPGRADE_STATIONS.has(station.type)) return fail('Doesn’t upgrade — build another');
  if (producerMaxed(station)) return fail('At max level — build another producer');
  const cost = upgradeCost(station);
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  station.level += 1;
  return done(station);
}

// ── Collect (manual haul) ─────────────────────────────────────────────
/** Move a single station's buffer into central storage. */
export function collectStation(state: GameState, stationId: string): ActionResult<Partial<Record<Resource, number>>> {
  const station = state.stations.find((s) => s.id === stationId);
  if (!station) return fail('No such station');
  const moved = { ...station.buffer };
  for (const key of Object.keys(station.buffer) as Resource[]) {
    state.resources[key] += station.buffer[key] ?? 0;
  }
  station.buffer = {};
  return done(moved);
}

/** Collect every station with a non-empty buffer. */
export function collectAll(state: GameState): Partial<Record<Resource, number>> {
  const total: Partial<Record<Resource, number>> = {};
  for (const station of state.stations) {
    for (const key of Object.keys(station.buffer) as Resource[]) {
      const amt = station.buffer[key] ?? 0;
      if (amt <= 0) continue;
      state.resources[key] += amt;
      total[key] = (total[key] ?? 0) + amt;
    }
    station.buffer = {};
  }
  return total;
}

// ── XP / Rank ─────────────────────────────────────────────────────────
export interface XpResult {
  xpGained: number;
  levelsGained: number;
  newRank: number;
  /** Milestones crossed by this XP gain (e.g. Auto-Haul unlock at rank 5). */
  milestones: Milestone[];
  /** Loot modules granted by rank milestones crossed (LOOT.MILESTONE_GRANTS). */
  grantedModules: Module[];
}

/**
 * Grant rank XP, resolving as many level-ups as the amount covers. This is the
 * ONLY path that raises rank — it is called exclusively from tend()/dose(),
 * which are online-only. Offline never reaches here, so milestone module grants
 * (like XP) never happen offline.
 */
export function gainXP(state: GameState, amount: number): XpResult {
  const startRank = state.rank;
  const milestones: Milestone[] = [];
  const grantedModules: Module[] = [];
  state.xp += amount;

  // Resolve cascading level-ups.
  while (state.xp >= xpForLevel(state.rank)) {
    state.xp -= xpForLevel(state.rank);
    state.rank += 1;
    const m = milestoneAtRank(state.rank);
    if (m) {
      milestones.push(m);
      if (state.rank >= BALANCE.MILESTONE_AUTOHAUL_RANK) state.autoHaulUnlocked = true;
      if (state.rank >= BALANCE.MILESTONE_TENDALL_RANK) state.tendAllUnlocked = true;
    }
    const grantRarity = BALANCE.LOOT.MILESTONE_GRANTS[state.rank];
    if (grantRarity) grantedModules.push(grantModule(state, grantRarity as Rarity));
  }

  return {
    xpGained: amount,
    levelsGained: state.rank - startRank,
    newRank: state.rank,
    milestones,
    grantedModules,
  };
}

// ── Modules: install / uninstall / auto-fill / salvage / reroll ───────
/** Install a spare module into a free rack socket (applies homestead-wide). */
export function installModule(state: GameState, moduleId: string): ActionResult<Module> {
  const idx = state.inventory.findIndex((m) => m.id === moduleId);
  if (idx < 0) return fail('Module not in inventory');
  if (state.rack.length >= rackSockets(state)) return fail('No free socket — uninstall one or Auto-fill');
  const [module] = state.inventory.splice(idx, 1);
  state.rack.push(module);
  return done(module);
}

/** Pull an installed module out of the rack back into spares. */
export function uninstallModule(state: GameState, moduleId: string): ActionResult<Module> {
  const idx = state.rack.findIndex((m) => m.id === moduleId);
  if (idx < 0) return fail('Module not installed');
  const [module] = state.rack.splice(idx, 1);
  state.inventory.push(module);
  return done(module);
}

/**
 * One-click "make this count": install a spare into a free socket, or — when the
 * rack is full — swap it in for the installed module it most improves on (only if
 * it strictly improves the loadout). The anti-babysitting button on a full rack.
 */
export function swapInModule(state: GameState, moduleId: string): ActionResult<Module> {
  const idx = state.inventory.findIndex((m) => m.id === moduleId);
  if (idx < 0) return fail('Module not in inventory');
  const spare = state.inventory[idx];
  const outlook = spareOutlook(state, spare);
  if (outlook.kind === 'install') return installModule(state, moduleId);
  if (outlook.kind === 'upgrade') {
    const ri = state.rack.findIndex((m) => m.id === outlook.replace.id);
    if (ri < 0) return fail('Nothing to swap');
    state.inventory.splice(idx, 1);
    const removed = state.rack[ri];
    state.rack[ri] = spare;
    state.inventory.push(removed);
    return done(spare);
  }
  return fail('Not an upgrade for the current loadout');
}

/**
 * Fill every empty socket with the spares that add the most effect, then make any
 * strictly-improving swaps — the greedy loadout optimizer behind the Auto-fill
 * button. Uses the value-weighted rackScore (a pure assist heuristic). Returns
 * how many modules it installed and how many it swapped.
 */
export function autoFillRack(state: GameState): ActionResult<{ installed: number; swapped: number }> {
  const cap = rackSockets(state);
  const w = activeStatWeights(state); // the player's playstyle priorities
  let installed = 0;
  let swapped = 0;

  // 1) Fill empty sockets, each time taking the spare that most raises the score.
  while (state.rack.length < cap && state.inventory.length > 0) {
    let bestIdx = -1;
    let bestScore = rackScore(state.rack, w);
    for (let i = 0; i < state.inventory.length; i++) {
      const sc = rackScore([...state.rack, state.inventory[i]], w);
      if (sc > bestScore + 1e-12) {
        bestScore = sc;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break; // nothing left would help
    state.rack.push(state.inventory.splice(bestIdx, 1)[0]);
    installed++;
  }

  // 2) Strictly-improving swaps until the loadout can't get better.
  let improved = true;
  while (improved) {
    improved = false;
    const base = rackScore(state.rack, w);
    let best = { gain: 1e-9, si: -1, ri: -1 };
    for (let si = 0; si < state.inventory.length; si++) {
      for (let ri = 0; ri < state.rack.length; ri++) {
        const cand = state.rack.slice();
        cand[ri] = state.inventory[si];
        const gain = rackScore(cand, w) - base;
        if (gain > best.gain) best = { gain, si, ri };
      }
    }
    if (best.si >= 0) {
      const spare = state.inventory[best.si];
      const removed = state.rack[best.ri];
      state.rack[best.ri] = spare;
      state.inventory.splice(best.si, 1, removed);
      swapped++;
      improved = true;
    }
  }

  return done({ installed, swapped });
}

/** Destroy an inventory module for dust (rarity-scaled). */
export function salvageModule(state: GameState, moduleId: string): ActionResult<{ dust: number }> {
  const idx = state.inventory.findIndex((m) => m.id === moduleId);
  if (idx < 0) return fail('Module not in inventory');
  const [module] = state.inventory.splice(idx, 1);
  const dust = salvageDust(module.rarity);
  state.dust += dust;
  return done({ dust });
}

/** Bulk-salvage every SPARE of one rarity tier in a single sweep (the clutter
 *  broom). Only touches the inventory — installed modules are never affected. */
export function bulkSalvageByTier(
  state: GameState,
  rarity: Rarity,
): ActionResult<{ count: number; dust: number }> {
  const kept: Module[] = [];
  let count = 0;
  let dust = 0;
  for (const m of state.inventory) {
    if (m.rarity === rarity) {
      count++;
      dust += salvageDust(m.rarity);
    } else {
      kept.push(m);
    }
  }
  if (count === 0) return fail('No spares of that tier');
  state.inventory = kept;
  state.dust += dust;
  return done({ count, dust });
}

/** Spend dust to re-roll an inventory module's magnitude (same stat + rarity). */
export function rerollModule(
  state: GameState,
  moduleId: string,
  rng: () => number = Math.random,
): ActionResult<Module> {
  const module = state.inventory.find((m) => m.id === moduleId);
  if (!module) return fail('Module not in inventory');
  const cost = BALANCE.LOOT.REROLL_DUST_COST;
  if (state.dust < cost) return fail(`Need ${cost} dust`);
  state.dust -= cost;
  module.magnitude = rollMagnitude(module.rarity, rng);
  return done(module);
}

// ── Breeding pairs + culling (the selection pressure) ─────────────────
/**
 * Release a duck from the flock — the selection lever. Removing weak-genome birds
 * frees housing AND raises the live mean genome quality, which is what the player
 * steers toward the Standard. Also drops any pair the duck belonged to.
 */
export function cullDuck(state: GameState, duckId: string): ActionResult<unknown> {
  const idx = state.ducks.findIndex((d) => d.id === duckId);
  if (idx < 0) return fail('No such duck');
  state.ducks.splice(idx, 1);
  state.breedingPairs = state.breedingPairs.filter((p) => p.drakeId !== duckId && p.henId !== duckId);
  return done(true);
}

/**
 * Bulk release the given ducks in one sweep — the selection lever at scale. NEVER
 * releases a secured (prize) or paired (in-use) bird: those are protected keepers,
 * use the per-duck release for them. Returns how many were actually released.
 */
export function cullDucks(state: GameState, duckIds: string[]): ActionResult<{ released: number }> {
  const ids = new Set(duckIds);
  const paired = new Set(state.breedingPairs.flatMap((p) => [p.drakeId, p.henId]));
  const before = state.ducks.length;
  state.ducks = state.ducks.filter((d) => !(ids.has(d.id) && !d.secured && !paired.has(d.id)));
  return done({ released: before - state.ducks.length });
}

// ── Breeding pairs (active selection) ─────────────────────────────────
export function createPair(state: GameState, drakeId: string, henId: string): ActionResult<unknown> {
  const drake = state.ducks.find((d) => d.id === drakeId);
  const hen = state.ducks.find((d) => d.id === henId);
  if (!drake || drake.sex !== 'drake' || drake.stage !== 'adult') return fail('Need an adult drake');
  if (!hen || hen.sex !== 'hen' || hen.stage !== 'adult') return fail('Need an adult hen');
  // Phase 6d: breeding happens at HOME — a wintering hen must be recalled first
  // (the mirror of assignToWinter rejecting paired hens).
  if (drake.site === 'winter' || hen.site === 'winter') return fail('Wintering birds can’t pair — recall first');
  const paired = (id: string) => state.breedingPairs.some((p) => p.drakeId === id || p.henId === id);
  if (paired(drakeId) || paired(henId)) return fail('A bird is already paired');
  state.breedingPairs.push({
    id: `p${state.nextPairId++}`,
    drakeId,
    henId,
    clutchProgress: 0,
    incubating: [],
  });
  return done(true);
}

export function removePair(state: GameState, pairId: string): ActionResult<unknown> {
  const idx = state.breedingPairs.findIndex((p) => p.id === pairId);
  if (idx < 0) return fail('No such pair');
  state.breedingPairs.splice(idx, 1);
  return done(true);
}

// ── Tracking target (the player's breeding-workbench goal) ────────────
/**
 * Set the TRACKING target the flock browser/pair-preview measures against — a
 * planning aid only. The champion gate, currency, and truebred DING read the
 * tier-authoritative targetForTier() (prestige.ts), never this. Validated to
 * GENOME.SLOTS good genes; rejected otherwise — a target slot is never D (an
 * untargetable filler, same convention as hatch specs) nor P (the wildcard).
 */
export function setGenomeTarget(state: GameState, target: Gene[]): ActionResult<unknown> {
  const genes: readonly string[] = ['L', 'V', 'H'];
  if (target.length !== BALANCE.GENOME.SLOTS || !target.every((g) => genes.includes(g))) {
    return fail('Invalid target profile');
  }
  state.genomeTarget = [...target];
  return done(true);
}

// ── Phase 6d: Winterstead assignment (adults-only, from the ONE flock) ─
/**
 * Assign an adult hen to Winterstead. She leaves every HOME pool (feed, lay,
 * predators, overcrowding, water, housing) and joins the WINTER pool — fed by
 * the winter ration, laying premium hardiness-scaled eggs. Capacity-gated by
 * winter coops. Wounded/recovering/paired ducks stay home (a pair breeds at
 * home; recall is always allowed).
 */
export function assignToWinter(state: GameState, duckId: string): ActionResult<unknown> {
  if (!zoneUnlocked(state, 'winterstead')) return fail('Winterstead is locked');
  const d = state.ducks.find((x) => x.id === duckId);
  if (!d) return fail('No such duck');
  if (d.site === 'winter') return fail('Already at Winterstead');
  if (d.stage !== 'adult') return fail('Adults only — winter is no place to grow up');
  if (d.sex !== 'hen') return fail('Only laying hens winter over');
  if (d.wounded || d.recovering) return fail('She needs to heal first');
  if (state.breedingPairs.some((p) => p.henId === duckId)) return fail('She’s in a breeding pair');
  const assigned = state.ducks.filter((x) => x.site === 'winter').length;
  if (assigned >= winterCapacity(state)) return fail('Winter coops are full — build another');
  d.site = 'winter';
  return done(true);
}

/** Bring a winter-assigned duck home. Always allowed. */
export function recallFromWinter(state: GameState, duckId: string): ActionResult<unknown> {
  const d = state.ducks.find((x) => x.id === duckId);
  if (!d) return fail('No such duck');
  if (d.site !== 'winter') return fail('Not at Winterstead');
  d.site = 'home';
  return done(true);
}

// ── Gene Reader (reveals genomes passively / in bulk) ─────────────────
/**
 * Build the gene-reader. One-time purchase: it immediately reads the WHOLE
 * current flock (in bulk) and, from then on, every newly hatched/acquired duck
 * auto-reads on arrival (see breeding.ts). NEVER a per-duck click — reading is
 * the passive gate to deliberate min/maxing; phone-it-in pairing (off visible
 * colour) works without it.
 */
export function buildGeneReader(state: GameState): ActionResult<{ revealed: number }> {
  if (state.geneReader) return fail('Gene reader already built');
  const cost = BALANCE.GENOME.READER_COST_EGGS;
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  state.geneReader = true;
  let revealed = 0;
  for (const d of state.ducks) {
    if (!d.genomeKnown) {
      d.genomeKnown = true;
      revealed += 1;
    }
  }
  return done({ revealed });
}

// ── Dose Brewer's Yeast (active-only intervention; clears a leg debuff) ──
export interface DoseResult {
  xp: XpResult;
}

/** Clear one leg-debuffed duck. Costed + on a global cooldown. Pass a duckId to
 *  target a specific duck (the FlockPanel row); omit it for the first debuffed
 *  duck (the flock-level HUD button). */
export function doseNiacin(state: GameState, duckId?: string): ActionResult<DoseResult> {
  const duck = duckId
    ? state.ducks.find((d) => d.id === duckId && d.debuffed)
    : state.ducks.find((d) => d.debuffed);
  if (!duck) return fail(duckId ? 'That duck doesn’t need dosing' : 'No duck needs dosing');
  if (state.doseCooldownRemaining > 0) {
    return fail(`Dosing in ${Math.ceil(state.doseCooldownRemaining)}s`);
  }
  const cost = BALANCE.NUTRITION.DOSE_COST_YEAST;
  if (state.resources.brewersYeast < cost) return fail(`Need ${cost} brewer's yeast`);

  state.resources.brewersYeast -= cost;
  duck.debuffed = false;
  state.doseCooldownRemaining = BALANCE.NUTRITION.DOSE_COOLDOWN_S;
  // Renown (legacy boost) scales active-action XP — online-only law holds.
  const xp = gainXP(state, Math.round(BALANCE.NUTRITION.DOSE_XP * renownBoostMult(state)));
  return done({ xp });
}

// ── Phase 4c: predator defenses, securing, and wound care ─────────────
/**
 * Build one deterrent (netting/guard post) — raises the homestead-wide
 * protection FLOOR (passive, always-on, works offline). Costs eggs. The floor
 * is capped (DEFENSE_FLOOR_CAP) so built defenses alone can't be 100%.
 */
export function buildDeterrent(state: GameState): ActionResult<{ deterrents: number }> {
  const cost = deterrentCost(state);
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  // A fresh, pristine net raises the average integrity of the (possibly worn) set.
  state.deterrentIntegrity =
    (state.deterrentIntegrity * state.deterrents + 1) / (state.deterrents + 1);
  state.deterrents += 1;
  return done({ deterrents: state.deterrents });
}

/**
 * Repair the deterrent floor back to pristine. Cost is prorated by how worn it is
 * (and how many nets), so topping off and full repairs cost the same per unit.
 * Active-only upkeep — you can't repair while away, so the floor decays offline.
 */
export function repairDeterrents(state: GameState): ActionResult<{ cost: number }> {
  const P = BALANCE.PREDATORS;
  if (state.deterrents <= 0) return fail('No deterrents to repair');
  if (state.deterrentIntegrity >= 1) return fail('Deterrents are already pristine');
  const cost = Math.max(
    1,
    Math.round(state.deterrents * P.DETERRENT_REPAIR_COST_PER_NET * (1 - state.deterrentIntegrity)),
  );
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  state.deterrentIntegrity = 1;
  return done({ cost });
}

/** Build one length of hardware cloth — the GROUND defense (vs the raccoon). Its own
 *  pool + integrity, parallel to nets. */
export function buildHardwareCloth(state: GameState): ActionResult<{ hardwareCloth: number }> {
  const cost = hardwareClothCost(state);
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  state.hardwareClothIntegrity =
    (state.hardwareClothIntegrity * state.hardwareCloth + 1) / (state.hardwareCloth + 1);
  state.hardwareCloth += 1;
  return done({ hardwareCloth: state.hardwareCloth });
}

/** Repair the hardware-cloth floor back to pristine (prorated by wear). Active-only. */
export function repairHardwareCloth(state: GameState): ActionResult<{ cost: number }> {
  const P = BALANCE.PREDATORS;
  if (state.hardwareCloth <= 0) return fail('No hardware cloth to repair');
  if (state.hardwareClothIntegrity >= 1) return fail('Hardware cloth is already pristine');
  const cost = Math.max(
    1,
    Math.round(state.hardwareCloth * P.DETERRENT_REPAIR_COST_PER_NET * (1 - state.hardwareClothIntegrity)),
  );
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  state.hardwareClothIntegrity = 1;
  return done({ cost });
}

/**
 * Build one Secure Coop — adds SECURE_SLOTS_PER_COOP secure slots. A duck marked
 * secured (up to the slot total) is excluded from predator targeting: the lever
 * for protecting irreplaceable breeders.
 */
export function buildSecureCoop(state: GameState): ActionResult<{ secureCoops: number }> {
  const cost = secureCoopCost(state);
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  state.secureCoops += 1;
  return done({ secureCoops: state.secureCoops });
}

/** Mark/unmark a duck as secured (excluded from targeting), bounded by slots. */
export function setSecured(state: GameState, duckId: string, secured: boolean): ActionResult<unknown> {
  const duck = state.ducks.find((d) => d.id === duckId);
  if (!duck) return fail('No such duck');
  if (secured) {
    if (duck.secured) return done(true);
    const used = state.ducks.filter((d) => d.secured).length;
    if (used >= secureCapacity(state)) return fail('No secure slots free — build a Secure Coop');
    duck.secured = true;
  } else {
    duck.secured = false;
  }
  return done(true);
}

/** Build one Infirmary — adds INFIRMARY.SLOTS_PER recovery slots. Costs eggs. */
export function buildInfirmary(state: GameState): ActionResult<{ infirmaries: number }> {
  const cost = infirmaryCost(state);
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  state.infirmaries += 1;
  return done({ infirmaries: state.infirmaries });
}

/**
 * Admit a wounded duck to an Infirmary recovery slot — the active save that stops a
 * wound escalating to a permanent loss. Free, but slots are LIMITED: a recovering
 * duck holds its slot until healed (over time, severity + water scaled), lays
 * nothing, and eats extra feed. If every slot is full it's triage — build another
 * infirmary, wait for one to free up, or cull. This is the checkpoint every death
 * passes through: a wound the player could have caught.
 */
export function admitToInfirmary(state: GameState, duckId: string): ActionResult<unknown> {
  const duck = state.ducks.find((d) => d.id === duckId);
  if (!duck) return fail('No such duck');
  if (!duck.wounded) return fail('Not wounded');
  if (duck.recovering) return done(true); // already admitted
  if (infirmaryOccupied(state) >= infirmaryCapacity(state)) {
    return fail('Infirmary full — build another, wait, or cull');
  }
  // Water attribution (Phase 5 juice): above-par water widens the escalation
  // window (waterWoundMult); the slack still on the clock at admission, minus
  // what a merely-par pond would have left, is what THIS pond specifically
  // bought. A transient pending event, drained by the engine for a toast —
  // never touches the wound/recovery math itself.
  const woundMult = waterWoundMult(state);
  if (woundMult > 1) {
    const threshold = BALANCE.PREDATORS.WOUND_ESCALATE_SEC * woundMult;
    const spareSec = Math.max(0, threshold - (duck.woundElapsed ?? 0));
    const boughtSec = (spareSec * (woundMult - 1)) / woundMult;
    if (boughtSec >= 1) (state.pendingWoundSaved ??= []).push({ spareSec, boughtSec });
  }
  duck.recovering = true;
  duck.recoveryElapsed = 0;
  return done(true);
}

// ── Tend (the active engine; ONLY source of XP) ───────────────────────
export interface TendResult {
  station: Station;
  /** Burst output deposited into the station buffer (before any haul). */
  burst: Partial<Record<Resource, number>>;
  xp: XpResult;
}

/**
 * Tend a station: instant production burst (TEND_BURST_MULT cycles' worth)
 * plus rank XP, gated by a per-station cooldown. Burst respects the input
 * chain — it produces as many of the burst cycles as inputs allow, but ALWAYS
 * grants full XP (the reward is for the active action, not the yield).
 */
export function tend(state: GameState, stationId: string): ActionResult<TendResult> {
  const station = state.stations.find((s) => s.id === stationId);
  if (!station) return fail('No such station');
  if (station.tendCooldownRemaining > 0) {
    return fail(`Cooling down (${Math.ceil(station.tendCooldownRemaining)}s)`);
  }

  const def = STATION_DEFS[station.type];
  const burst: Partial<Record<Resource, number>> = {};
  const tendPower = tendPowerMult(state); // rack-boosted burst size

  if (station.type === 'coop' || station.type === 'winterCoop') {
    // A coop's burst is TEND_BURST_MULT cycles' worth of the FLOCK'S LIVE LAY,
    // attributed to this coop — the full per-hen chain (genome layMult ×
    // nutrition throttle × debuff/wound × rack eggOutput × legacy eggValue),
    // never the raw station base. The old base-rate burst minted full eggs from
    // an empty or starving flock, feed-free (one tended L8 coop ≈ 3 truebred
    // hens). Winter coops mirror it from the winter pool, which already folds
    // in warmth × waterer support × hardiness × the premium. Empty flock/site
    // ⇒ 0 eggs; XP is still granted (the reward is for the action).
    const rate =
      station.type === 'coop' ? (state.nutrition?.eggRate ?? 0) : (state.winter?.eggRate ?? 0);
    const coops = state.stations.filter((s) => s.type === station.type).length;
    let out = (rate / Math.max(1, coops)) * BALANCE.COOP.cycleSeconds * BALANCE.TEND_BURST_MULT * tendPower;
    // The Grange (Phase 6b): tend() is always online, so an active delivery
    // contract diverts eggs here too (the coop's other lay point) — the
    // remainder is what actually lands in the buffer/burst feedback.
    if (out > 0) {
      out -= onEggsLaid(state, out);
      station.buffer.eggs = (station.buffer.eggs ?? 0) + out;
      burst.eggs = out;
    }
  } else {
    // Producers burst on the SAME output curve as their passive cycles — the
    // capped PRODUCER curve for ingredient farms, the uncapped one for the rest
    // (the old flat UPGRADE_OUTPUT over-delivered ~6.4× at the producer cap).
    const mult = stationOutputMult(station.type, station.level);
    for (let i = 0; i < BALANCE.TEND_BURST_MULT; i++) {
      // Affordable inputs?
      let affordable = true;
      for (const key of Object.keys(def.inputs) as Resource[]) {
        if (state.resources[key] < (def.inputs[key] ?? 0) * mult) {
          affordable = false;
          break;
        }
      }
      if (!affordable) break;
      for (const key of Object.keys(def.inputs) as Resource[]) {
        state.resources[key] -= (def.inputs[key] ?? 0) * mult;
      }
      for (const key of Object.keys(def.outputs) as Resource[]) {
        const out = (def.outputs[key] ?? 0) * mult * tendPower;
        station.buffer[key] = (station.buffer[key] ?? 0) + out;
        burst[key] = (burst[key] ?? 0) + out;
      }
    }
  }

  station.tendCooldownRemaining = BALANCE.TEND_COOLDOWN_S * tendCooldownMult(state);
  // Renown (legacy boost) scales active-action XP — online-only law holds.
  const xp = gainXP(state, Math.round(BALANCE.TEND_XP * renownBoostMult(state)));
  return done({ station, burst, xp });
}
