import { BALANCE, STATION_DEFS, type StationType } from '../config/balance';
import { grantModule, tendCooldownMult, tendPowerMult } from './loot';
import { milestoneAtRank, xpForLevel, type Milestone } from './rank';
import type { GameState, Module, Rarity, Resource, Station } from './state';
import { isPondTile, stationAt } from './state';

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
): ActionResult<Station> {
  if (x < 0 || y < 0 || x >= BALANCE.GRID.width || y >= BALANCE.GRID.height) {
    return fail('Out of bounds');
  }
  if (isPondTile(x, y)) return fail('That’s the pond');
  if (stationAt(state, x, y)) return fail('Tile occupied');
  const cost = BALANCE.COSTS[type];
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);

  state.resources.eggs -= cost;
  const station: Station = {
    id: `s${state.nextStationId++}`,
    type,
    x,
    y,
    level: 1,
    cycleProgress: 0,
    buffer: {},
    tendCooldownRemaining: 0,
  };
  state.stations.push(station);
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
  if (x < 0 || y < 0 || x >= BALANCE.GRID.width || y >= BALANCE.GRID.height) {
    return fail('Out of bounds');
  }
  if (isPondTile(x, y)) return fail('That’s the pond');
  const occupant = stationAt(state, x, y);
  if (occupant && occupant.id !== stationId) return fail('Tile occupied');
  station.x = x;
  station.y = y;
  return done(station);
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

// ── Dose Brewer's Yeast (active-only intervention; clears a leg debuff) ──
export interface DoseResult {
  station: Station;
  xp: XpResult;
}

export function doseNiacin(state: GameState, stationId: string): ActionResult<DoseResult> {
  const station = state.stations.find((s) => s.id === stationId);
  if (!station) return fail('No such station');
  if (!station.debuffed) return fail('No duck to dose here');
  if (state.doseCooldownRemaining > 0) {
    return fail(`Dosing in ${Math.ceil(state.doseCooldownRemaining)}s`);
  }
  const cost = BALANCE.NUTRITION.DOSE_COST_YEAST;
  if (state.resources.brewersYeast < cost) return fail(`Need ${cost} brewer's yeast`);

  state.resources.brewersYeast -= cost;
  station.debuffed = false;
  state.doseCooldownRemaining = BALANCE.NUTRITION.DOSE_COOLDOWN_S;
  const xp = gainXP(state, BALANCE.NUTRITION.DOSE_XP);
  return done({ station, xp });
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
  // A coop's burst is throttled by current nutrition + any leg debuff, same as
  // its passive lay.
  const nutritionMult =
    station.type === 'coop'
      ? (state.nutrition?.eggMult ?? 1) * (station.debuffed ? BALANCE.NUTRITION.DEBUFF_COOP_OUTPUT_MULT : 1)
      : 1;
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
