import { BALANCE, type StationType } from '../config/balance';
import {
  MODULE_STATS,
  RARITIES,
  rackSockets,
  type GameState,
  type Module,
  type ModuleStat,
  type Rarity,
} from './state';

const L = BALANCE.LOOT;
type Rng = () => number;

// ── Categories: which part of the homestead a stat affects (metadata) ────
// With the rack, a module isn't gated to a station type — it installs into any
// socket and applies to its whole category. STAT_CATEGORIES is now purely
// informational (it drives the "all producers / flock / tending" scope label).
export type StationCategory = 'production' | 'coop';

export function stationCategory(type: StationType): StationCategory {
  return type === 'coop' ? 'coop' : 'production';
}

/** Which category each stat affects. Throughput levers only — never nutrition. */
export const STAT_CATEGORIES: Record<ModuleStat, StationCategory[]> = {
  stationSpeed: ['production'],
  stationYield: ['production'], // on the mill this is blend capacity, not nutrition need
  eggOutput: ['coop'],
  conditionRegen: ['coop'],
  tendPower: ['production', 'coop'],
  tendCooldown: ['production', 'coop'],
};

export function moduleFits(stat: ModuleStat, type: StationType): boolean {
  return STAT_CATEGORIES[stat].includes(stationCategory(type));
}

// ── Stacking: additive raw sum -> diminishing-returns soft cap ───────────
/** applied = cap·(1 − e^(−rawSum/cap)). Early modules near full value; tapers. */
export function appliedBonus(rawSum: number, cap: number): number {
  if (cap <= 0 || rawSum <= 0) return 0;
  return cap * (1 - Math.exp(-rawSum / cap));
}

/** Raw magnitude sum for a stat across a set of modules (optionally excluding one). */
function rawSumFor(modules: Module[], stat: ModuleStat, excludeId?: string): number {
  return modules.reduce(
    (a, m) => (m.stat === stat && m.id !== excludeId ? a + m.magnitude : a),
    0,
  );
}

/** Applied bonus for a stat from the installed RACK (homestead-wide). */
export function rackBonus(state: GameState, stat: ModuleStat): number {
  return appliedBonus(rawSumFor(state.rack, stat), L.SOFT_CAP[stat] ?? 0);
}

// ── Multipliers used by the production math (now read from the rack) ─────
/** Cycle-time multiplier (<1 = faster) applied to ALL timed producers. */
export const cycleMult = (state: GameState): number => 1 - rackBonus(state, 'stationSpeed');
/** Output-per-cycle multiplier (>1 = more) applied to ALL producers. */
export const yieldMult = (state: GameState): number => 1 + rackBonus(state, 'stationYield');
/** Flat egg-output multiplier for the flock. Multiplies the nutrition eggMult; the
 *  nutrition f(axis) terms themselves are never touched. */
export const eggOutputMult = (state: GameState): number => 1 + rackBonus(state, 'eggOutput');
/** Tend burst-size multiplier. */
export const tendPowerMult = (state: GameState): number => 1 + rackBonus(state, 'tendPower');
/** Tend cooldown multiplier (<1 = shorter). */
export const tendCooldownMult = (state: GameState): number => 1 - rackBonus(state, 'tendCooldown');
/** Global flock-condition regen multiplier. */
export const conditionRegenMult = (state: GameState): number => 1 + rackBonus(state, 'conditionRegen');
/** Mill blend-throughput multiplier (capacity) — both speed and yield help. Boosts
 *  capacity (a throughput cap), never the nutrition requirement/matrix/satisfaction. */
export const millThroughputMult = (state: GameState): number =>
  (1 + rackBonus(state, 'stationSpeed')) * (1 + rackBonus(state, 'stationYield'));

// ── Loadout scoring (drives the Auto-fill optimizer + spare "upgrade?" hints) ──
const statValue = (stat: ModuleStat): number => L.STAT_VALUE[stat] ?? 1;

/** Value-weighted total applied bonus of a set of installed modules — the scalar
 *  the optimizer maximizes. Pure heuristic; never affects the sim. */
export function rackScore(modules: Module[]): number {
  let score = 0;
  for (const stat of MODULE_STATS) {
    score += statValue(stat) * appliedBonus(rawSumFor(modules, stat), L.SOFT_CAP[stat] ?? 0);
  }
  return score;
}

/** Applied % a single installed module currently contributes (its stat, given the
 *  rest of the rack) — what you'd lose by uninstalling it. */
export function moduleContribution(state: GameState, m: Module): number {
  const cap = L.SOFT_CAP[m.stat] ?? 0;
  const withAll = rawSumFor(state.rack, m.stat);
  const without = rawSumFor(state.rack, m.stat, m.id);
  return appliedBonus(withAll, cap) - appliedBonus(without, cap);
}

/** Applied % a spare would add to its stat if installed into a free socket. */
export function installMarginal(state: GameState, m: Module): number {
  const cap = L.SOFT_CAP[m.stat] ?? 0;
  const raw = rawSumFor(state.rack, m.stat);
  return appliedBonus(raw + m.magnitude, cap) - appliedBonus(raw, cap);
}

export type SpareOutlook =
  | { kind: 'install'; gain: number } // a socket is free
  | { kind: 'upgrade'; gain: number; replace: Module } // rack full, but swapping in helps NOW
  | { kind: 'potential'; replace: Module } // not now, but a max reroll (same band) could
  | { kind: 'none' }; // rack full and even a perfect reroll couldn't help — true junk

/** Best strictly-improving swap for a (hypothetical) module against the full rack. */
function bestSwap(state: GameState, mod: Module): { gain: number; replace: Module } | null {
  const base = rackScore(state.rack);
  let best: { gain: number; replace: Module } | null = null;
  for (let i = 0; i < state.rack.length; i++) {
    const cand = state.rack.slice();
    cand[i] = mod;
    const gain = rackScore(cand) - base;
    if (gain > (best?.gain ?? 1e-9)) best = { gain, replace: state.rack[i] };
  }
  return best;
}

/**
 * What this spare can do for the rack: fill a free socket, swap in as an upgrade
 * NOW, become an upgrade if rerolled to its rarity-band ceiling ('potential'), or
 * nothing ('none' — even a perfect reroll can't beat the loadout, so it's safe to
 * salvage). Reroll is locked to the same rarity band, so band-max is the true
 * ceiling. Powers the "which is an upgrade" hints AND the auto-salvage gate.
 */
export function spareOutlook(state: GameState, spare: Module): SpareOutlook {
  if (state.rack.length < rackSockets(state)) {
    return { kind: 'install', gain: statValue(spare.stat) * installMarginal(state, spare) };
  }
  const now = bestSwap(state, spare);
  if (now) return { kind: 'upgrade', gain: now.gain, replace: now.replace };
  // Could a best-case reroll (this module maxed within its band) make it worth a socket?
  const maxed: Module = { ...spare, magnitude: L.RARITY_BAND[spare.rarity][1] };
  const potential = maxed.magnitude > spare.magnitude ? bestSwap(state, maxed) : null;
  if (potential) return { kind: 'potential', replace: potential.replace };
  return { kind: 'none' };
}

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

export interface TendDrop {
  module: Module;
  /** 'keep' ⇒ an install/upgrade kept as a spare (loot banner). 'potential' ⇒ not
   *  an upgrade now but a max reroll could promote it — kept quietly. 'salvaged' ⇒
   *  even a perfect reroll can't beat the loadout, so auto-salvaged to dust. */
  outcome: 'keep' | 'potential' | 'salvaged';
  /** Dust granted when auto-salvaged (0 otherwise). */
  dust: number;
}

/**
 * Active drop on a tend: chance gate, then a weighted rarity roll. A drop is only
 * AUTO-SALVAGED when even a perfect reroll (its rarity-band ceiling) couldn't make
 * it improve the rack — so reroll option-value is never thrown away. Upgrades land
 * as spares with a banner; reroll-candidates land quietly. Returns the drop, or
 * null on a miss. Online-only — offline never tends, so it never calls this.
 */
export function tryTendDrop(state: GameState, rng: Rng = Math.random): TendDrop | null {
  if (rng() >= L.TEND_DROP_CHANCE) return null;
  const module = makeModule(state, rollRarity(rng), rng);
  const outlook = spareOutlook(state, module);
  if (outlook.kind === 'none') {
    const dust = salvageDust(module.rarity);
    state.dust += dust;
    return { module, outcome: 'salvaged', dust };
  }
  state.inventory.push(module);
  return { module, outcome: outlook.kind === 'potential' ? 'potential' : 'keep', dust: 0 };
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
