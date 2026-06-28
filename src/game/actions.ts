import { BALANCE, STATION_DEFS, zoneDef, type StationType } from '../config/balance';
import {
  grantModule,
  moduleFits,
  rollMagnitude,
  salvageDust,
  slotCount,
  tendCooldownMult,
  tendPowerMult,
} from './loot';
import { milestoneAtRank, xpForLevel, type Milestone } from './rank';
import type { GameState, Module, Rarity, Resource, Station } from './state';
import { isBlockedTile, seedFlock, stationAt, zoneUnlocked } from './state';

/** Output/throughput multiplier for a station at a given level. */
export function UPGRADE_OUTPUT(level: number): number {
  return Math.pow(BALANCE.UPGRADE.outputMultPerLevel, level - 1);
}

/** Egg cost to upgrade a station from its current level to the next. */
export function upgradeCost(station: Station): number {
  const base = BALANCE.UPGRADE.baseCost[station.type];
  return Math.round(base * Math.pow(BALANCE.UPGRADE.costGrowth, station.level - 1));
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
    tendCooldownRemaining: 0,
  };
  state.stations.push(station);
  // First coop seeds the starting flock (housing now exists for it).
  if (type === 'coop' && state.ducks.length === 0) seedFlock(state);
  return done(station);
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
  // Return any slotted modules to inventory — don't destroy the player's loot.
  if (station.modules?.length) state.inventory.push(...station.modules);
  state.stations.splice(idx, 1);
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
  if (state.rank < zone.unlock.rankRequired) return fail(`Reach Rank ${zone.unlock.rankRequired}`);
  if (state.resources.eggs < zone.unlock.eggCost) return fail(`Need ${zone.unlock.eggCost} eggs`);
  state.resources.eggs -= zone.unlock.eggCost;
  (state.zones[zoneId] ??= { unlocked: false, forageProgress: 0 }).unlocked = true;
  return done({ name: zone.name });
}

// ── Upgrade ───────────────────────────────────────────────────────────
export function upgradeStation(state: GameState, stationId: string): ActionResult<Station> {
  const station = state.stations.find((s) => s.id === stationId);
  if (!station) return fail('No such station');
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

// ── Modules: assign / unassign / salvage / reroll ─────────────────────
/** Slot an inventory module into a station (must fit category + have a free slot). */
export function assignModule(
  state: GameState,
  stationId: string,
  moduleId: string,
): ActionResult<Station> {
  const station = state.stations.find((s) => s.id === stationId);
  if (!station) return fail('No such station');
  const idx = state.inventory.findIndex((m) => m.id === moduleId);
  if (idx < 0) return fail('Module not in inventory');
  const module = state.inventory[idx];
  if (!moduleFits(module.stat, station.type)) return fail("Module doesn't fit this station");
  station.modules ??= [];
  if (station.modules.length >= slotCount(station)) return fail('No free slot');
  state.inventory.splice(idx, 1);
  station.modules.push(module);
  return done(station);
}

/** Pull a module out of a station back into the inventory. */
export function unassignModule(state: GameState, moduleId: string): ActionResult<Station> {
  for (const station of state.stations) {
    const idx = station.modules?.findIndex((m) => m.id === moduleId) ?? -1;
    if (idx >= 0) {
      const [module] = station.modules!.splice(idx, 1);
      state.inventory.push(module);
      return done(station);
    }
  }
  return fail('Module not slotted');
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
 * Release a duck from the flock — the selection lever. Removing low-vigor birds
 * frees housing AND raises the live population mean, which lifts the breeding
 * target so the flock walks toward the vigor ceiling. Also drops any pair the
 * duck belonged to.
 */
export function cullDuck(state: GameState, duckId: string): ActionResult<unknown> {
  const idx = state.ducks.findIndex((d) => d.id === duckId);
  if (idx < 0) return fail('No such duck');
  state.ducks.splice(idx, 1);
  state.breedingPairs = state.breedingPairs.filter((p) => p.drakeId !== duckId && p.henId !== duckId);
  return done(true);
}

// ── Breeding pairs (active selection) ─────────────────────────────────
export function createPair(state: GameState, drakeId: string, henId: string): ActionResult<unknown> {
  const drake = state.ducks.find((d) => d.id === drakeId);
  const hen = state.ducks.find((d) => d.id === henId);
  if (!drake || drake.sex !== 'drake' || drake.stage !== 'adult') return fail('Need an adult drake');
  if (!hen || hen.sex !== 'hen' || hen.stage !== 'adult') return fail('Need an adult hen');
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

// ── Dose Brewer's Yeast (active-only intervention; clears a leg debuff) ──
export interface DoseResult {
  xp: XpResult;
}

/** Clear one leg-debuffed duck (flock-level). Costed + on a global cooldown. */
export function doseNiacin(state: GameState): ActionResult<DoseResult> {
  const duck = state.ducks.find((d) => d.debuffed);
  if (!duck) return fail('No duck needs dosing');
  if (state.doseCooldownRemaining > 0) {
    return fail(`Dosing in ${Math.ceil(state.doseCooldownRemaining)}s`);
  }
  const cost = BALANCE.NUTRITION.DOSE_COST_YEAST;
  if (state.resources.brewersYeast < cost) return fail(`Need ${cost} brewer's yeast`);

  state.resources.brewersYeast -= cost;
  duck.debuffed = false;
  state.doseCooldownRemaining = BALANCE.NUTRITION.DOSE_COOLDOWN_S;
  const xp = gainXP(state, BALANCE.NUTRITION.DOSE_XP);
  return done({ xp });
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
  const mult = UPGRADE_OUTPUT(station.level);
  const burst: Partial<Record<Resource, number>> = {};
  // A coop's tend burst (tending the flock) is throttled by current nutrition,
  // same as the flock's passive lay. (Leg debuffs are per-duck now.)
  const nutritionMult = station.type === 'coop' ? (state.nutrition?.eggMult ?? 1) : 1;
  const tendPower = tendPowerMult(station); // module-boosted burst size

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
      const out = (def.outputs[key] ?? 0) * mult * nutritionMult * tendPower;
      station.buffer[key] = (station.buffer[key] ?? 0) + out;
      burst[key] = (burst[key] ?? 0) + out;
    }
  }

  station.tendCooldownRemaining = BALANCE.TEND_COOLDOWN_S * tendCooldownMult(station);
  const xp = gainXP(state, BALANCE.TEND_XP);
  return done({ station, burst, xp });
}
