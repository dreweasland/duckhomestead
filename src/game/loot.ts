import { BALANCE, type StationType } from '../config/balance';
import {
  MODULE_STATS,
  RARITIES,
  type GameState,
  type Module,
  type ModuleStat,
  type Rarity,
  type Station,
} from './state';

const L = BALANCE.LOOT;
type Rng = () => number;

// ── Categories: which station types accept which stats ──────────────────
export type StationCategory = 'production' | 'coop';

export function stationCategory(type: StationType): StationCategory {
  return type === 'coop' ? 'coop' : 'production';
}

/** Station categories each stat fits. Throughput levers only. */
export const STAT_CATEGORIES: Record<ModuleStat, StationCategory[]> = {
  stationSpeed: ['production'],
  stationYield: ['production'], // on a mill this boosts blend capacity, not nutrition need
  eggOutput: ['coop'],
  conditionRegen: ['coop'], // slotted on a coop; raises global condition regen
  tendPower: ['production', 'coop'],
  tendCooldown: ['production', 'coop'],
};

export function moduleFits(stat: ModuleStat, type: StationType): boolean {
  return STAT_CATEGORIES[stat].includes(stationCategory(type));
}

export function slotCount(_station: Station): number {
  return L.SLOTS_PER_STATION;
}

// ── Stacking: additive raw sum -> diminishing-returns soft cap ───────────
/** applied = cap·(1 − e^(−rawSum/cap)). Early modules near full value; tapers. */
export function appliedBonus(rawSum: number, cap: number): number {
  if (cap <= 0 || rawSum <= 0) return 0;
  return cap * (1 - Math.exp(-rawSum / cap));
}

/** Applied bonus for one stat on one station (sum its matching modules). */
export function stationBonus(station: Station, stat: ModuleStat): number {
  const rawSum = (station.modules ?? []).reduce((a, m) => (m.stat === stat ? a + m.magnitude : a), 0);
  return appliedBonus(rawSum, L.SOFT_CAP[stat] ?? 0);
}

/** Applied bonus for a global stat (e.g. conditionRegen) summed across stations. */
export function globalBonus(state: GameState, stat: ModuleStat): number {
  let rawSum = 0;
  for (const s of state.stations) {
    for (const m of s.modules ?? []) if (m.stat === stat) rawSum += m.magnitude;
  }
  return appliedBonus(rawSum, L.SOFT_CAP[stat] ?? 0);
}

// ── Multipliers used by the production math (direction lives here) ───────
/** Cycle-time multiplier (<1 = faster) for a timed producer. */
export const cycleMult = (s: Station): number => 1 - stationBonus(s, 'stationSpeed');
/** Output-per-cycle multiplier (>1 = more) for a producer / mill capacity. */
export const yieldMult = (s: Station): number => 1 + stationBonus(s, 'stationYield');
/** Flat egg-output multiplier for a coop. Multiplies the nutrition eggMult; the
 *  nutrition f(axis) terms themselves are never touched. */
export const eggOutputMult = (s: Station): number => 1 + stationBonus(s, 'eggOutput');
/** Tend burst-size multiplier. */
export const tendPowerMult = (s: Station): number => 1 + stationBonus(s, 'tendPower');
/** Tend cooldown multiplier (<1 = shorter). */
export const tendCooldownMult = (s: Station): number => 1 - stationBonus(s, 'tendCooldown');
/** Global flock-condition regen multiplier. */
export const conditionRegenMult = (state: GameState): number => 1 + globalBonus(state, 'conditionRegen');

// ── Rolls (RNG injectable for deterministic tests) ──────────────────────
export function rollRarity(rng: Rng = Math.random): Rarity {
  const total = RARITIES.reduce((a, r) => a + (L.DROP_RARITY_WEIGHTS[r] ?? 0), 0);
  let roll = rng() * total;
  for (const r of RARITIES) {
    roll -= L.DROP_RARITY_WEIGHTS[r] ?? 0;
    if (roll < 0) return r;
  }
  return 'common';
}

export function rollMagnitude(rarity: Rarity, rng: Rng = Math.random): number {
  const [min, max] = L.RARITY_BAND[rarity];
  return min + rng() * (max - min);
}

export function rollStat(rng: Rng = Math.random): ModuleStat {
  return MODULE_STATS[Math.floor(rng() * MODULE_STATS.length)] ?? 'stationYield';
}

/** Mint a module (random stat + magnitude for the rarity) into the id space. */
export function makeModule(state: GameState, rarity: Rarity, rng: Rng = Math.random): Module {
  return { id: `m${state.nextModuleId++}`, stat: rollStat(rng), rarity, magnitude: rollMagnitude(rarity, rng) };
}

/** Active drop on a tend: chance gate, then a weighted rarity roll. Pushes to
 *  inventory and returns the module, or null. Online-only by construction —
 *  offline catch-up never tends, so it never calls this. */
export function tryTendDrop(state: GameState, rng: Rng = Math.random): Module | null {
  if (rng() >= L.TEND_DROP_CHANCE) return null;
  const m = makeModule(state, rollRarity(rng), rng);
  state.inventory.push(m);
  return m;
}

/** Guaranteed milestone grant of a fixed rarity (random stat/magnitude). */
export function grantModule(state: GameState, rarity: Rarity, rng: Rng = Math.random): Module {
  const m = makeModule(state, rarity, rng);
  state.inventory.push(m);
  return m;
}

export function salvageDust(rarity: Rarity): number {
  return L.SALVAGE_DUST[rarity] ?? 0;
}
