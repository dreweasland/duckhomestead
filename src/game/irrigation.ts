import { BALANCE } from '../config/balance';
import { cellKey, zoneUnlocked, type GameState } from './state';

/**
 * irrigation.ts — the Back Pasture's signature (Phase 4b rework).
 *
 * A self-contained side puzzle: route a FIXED water supply from the source,
 * through a player-laid channel network (a TREE — each new channel connects to
 * the existing network, so no loops), to fixed crop plots. Valves at branch
 * points split the flow. Each plot yields most when its received flow sits in a
 * SWEET-SPOT band (under- and over-watered both reduce yield). Well-watered
 * plots grow a cash crop auto-sold for EGGS.
 *
 * Hard guardrail: this produces EGGS only — it NEVER produces or touches a
 * nutrition axis (energy/protein/niacin/calcium) or the satisfaction/throttle
 * math. The layout is solved once and holds; a separate `health` drift coasts
 * output peak→floor over time and a self-paced tend restores it (never zero,
 * never a timer that punishes absence).
 */

const P = BALANCE.PASTURE;
export const PASTURE_ZONE = 'backPasture';
/** N, E, S, W — fixed order so a valve's knob biases a stable "first" output. */
const DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const isSource = (x: number, y: number) => x === P.SOURCE.x && y === P.SOURCE.y;
const plotIndexAt = (x: number, y: number) => P.PLOTS.findIndex((p) => p.x === x && p.y === y);

/** A cell carries water iff it's a laid channel or the source. */
function isChannel(state: GameState, x: number, y: number): boolean {
  return isSource(x, y) || cellKey(x, y) in state.irrigation.channels;
}

/** Split `1` across `n` outputs; with exactly 2, the knob biases output[0]. */
function shares(n: number, knob: number): number[] {
  if (n <= 1) return [1];
  if (n === 2) return [knob, 1 - knob];
  return Array.from({ length: n }, () => 1 / n);
}

export interface FlowSolution {
  /** Flow reaching each plot (parallel to BALANCE.PASTURE.PLOTS). */
  plotFlow: number[];
  /** Flow through each channel/source cell, keyed "x,y". */
  cellFlow: Record<string, number>;
  /** Branch cells (≥2 outputs) — these are the valves whose knob matters. */
  valves: Set<string>;
}

/**
 * Solve the network: BFS a spanning tree from the source over channel cells, then
 * push SOURCE_FLOW down it, splitting at each cell among its channel-children +
 * adjacent plots (knob biases two-way splits). Disconnected channels get no flow.
 */
export function solveFlow(state: GameState): FlowSolution {
  const channels = state.irrigation.channels;
  const sk = cellKey(P.SOURCE.x, P.SOURCE.y);

  // BFS spanning tree (parent = first cell to reach it → no cycles).
  const parent: Record<string, string | null> = { [sk]: null };
  const order: { x: number; y: number }[] = [];
  const visited = new Set([sk]);
  const queue: { x: number; y: number }[] = [{ ...P.SOURCE }];
  while (queue.length) {
    const c = queue.shift()!;
    order.push(c);
    for (const [dx, dy] of DIRS) {
      const nx = c.x + dx;
      const ny = c.y + dy;
      const nk = cellKey(nx, ny);
      if (visited.has(nk)) continue;
      if (isChannel(state, nx, ny)) {
        visited.add(nk);
        parent[nk] = cellKey(c.x, c.y);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  const cellFlow: Record<string, number> = { [sk]: P.SOURCE_FLOW };
  const plotFlow = P.PLOTS.map(() => 0);
  const valves = new Set<string>();

  for (const c of order) {
    const ck = cellKey(c.x, c.y);
    const inflow = cellFlow[ck] ?? 0;
    // Outputs in DIR order: channel-children (whose parent is this cell) + plots.
    const outs: { cell?: string; plot?: number }[] = [];
    for (const [dx, dy] of DIRS) {
      const nx = c.x + dx;
      const ny = c.y + dy;
      const nk = cellKey(nx, ny);
      if (parent[nk] === ck) outs.push({ cell: nk });
      const pi = plotIndexAt(nx, ny);
      if (pi >= 0) outs.push({ plot: pi });
    }
    if (outs.length >= 2) valves.add(ck);
    if (outs.length === 0) continue;
    const split = shares(outs.length, channels[ck] ?? 0.5);
    outs.forEach((o, i) => {
      const f = inflow * split[i];
      if (o.cell !== undefined) cellFlow[o.cell] = (cellFlow[o.cell] ?? 0) + f;
      else if (o.plot !== undefined) plotFlow[o.plot] += f;
    });
  }
  return { plotFlow, cellFlow, valves };
}

export type PlotBand = 'dry' | 'ideal' | 'over';
export function plotBand(flow: number): PlotBand {
  const [lo, hi] = P.PLOT_IDEAL_BAND;
  return flow < lo ? 'dry' : flow > hi ? 'over' : 'ideal';
}

/**
 * Yield fraction (0..1) from a plot's received flow: linear ramp up to the band,
 * 1 across the ideal band, then a decline toward the over-water falloff floor.
 */
export function plotYield(flow: number): number {
  const [lo, hi] = P.PLOT_IDEAL_BAND;
  if (flow <= 0) return 0;
  if (flow < lo) return flow / lo;
  if (flow <= hi) return 1;
  const t = Math.min(1, (flow - hi) / hi); // waterlogged over another `hi` of flow
  return 1 - (1 - P.PLOT_OVERWATER_FALLOFF) * t;
}

/** Upkeep multiplier from drift health: floor (neglected) .. 1 (freshly tended). */
export function driftMult(state: GameState): number {
  return P.UPKEEP_FLOOR + (1 - P.UPKEEP_FLOOR) * clamp01(state.irrigation.health);
}

/**
 * Advance the pasture by `dt` (rate-scaled): drift the health toward the floor,
 * grow crop on each plot at band-yield × drift, auto-harvest whole units to eggs.
 * Only runs once the pasture is unlocked. Returns eggs earned this step. Currency
 * only — never an XP/module/nutrition source.
 */
export function runIrrigation(state: GameState, dt: number, rateMult: number): number {
  if (!zoneUnlocked(state, PASTURE_ZONE)) return 0;
  const ir = state.irrigation;
  const step = dt * rateMult;
  // Health coasts toward the floor over DRIFT_TO_FLOOR_SEC (tend restores it).
  ir.health = Math.max(0, ir.health - step / P.DRIFT_TO_FLOOR_SEC);
  const mult = driftMult(state);

  const { plotFlow } = solveFlow(state);
  let earned = 0;
  for (let i = 0; i < P.PLOTS.length; i++) {
    const grow = plotYield(plotFlow[i]) * mult; // band yield × upkeep drift
    ir.crop[i] += (grow / P.CROP_GROW_SEC) * step;
    const harvest = Math.floor(ir.crop[i]); // auto-harvest whole units
    if (harvest > 0) {
      ir.crop[i] -= harvest;
      earned += harvest * P.CROP_SELL_EGGS;
    }
  }
  if (earned > 0) state.resources.eggs += earned;
  return earned;
}

// ── Player actions ───────────────────────────────────────────────────
const GRID = BALANCE.ZONES.BACK_PASTURE.tileRegionSize; // the irrigation board grid
const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < GRID.width && y < GRID.height;

/** A new channel must touch the source or an existing channel (keeps it a tree). */
function connected(state: GameState, x: number, y: number): boolean {
  return DIRS.some(([dx, dy]) => isChannel(state, x + dx, y + dy));
}

/** Toggle a channel cell: erase if present, else lay it (if it connects). Plots and
 *  the source tile can't be channels. Returns true if the network changed. */
export function toggleChannel(state: GameState, x: number, y: number): boolean {
  if (!inBounds(x, y) || isSource(x, y) || plotIndexAt(x, y) >= 0) return false;
  const key = cellKey(x, y);
  const ch = state.irrigation.channels;
  if (key in ch) {
    delete ch[key];
    return true;
  }
  if (!connected(state, x, y)) return false; // would be an island
  ch[key] = 0.5; // default even split if it ever branches
  return true;
}

/** Set a valve cell's split knob (0..1; bias toward its first output direction). */
export function setValveKnob(state: GameState, x: number, y: number, knob: number): boolean {
  const key = cellKey(x, y);
  if (!(key in state.irrigation.channels)) return false;
  state.irrigation.channels[key] = clamp01(knob);
  return true;
}

/** A self-paced tending pass: clear silt/weeds, restoring output to peak. */
export function tendPasture(state: GameState): boolean {
  if (!zoneUnlocked(state, PASTURE_ZONE)) return false;
  state.irrigation.health = P.TEND_RESTORE;
  return true;
}

// ── UI summary (renders the puzzle from GameState) ───────────────────
export interface PlotView {
  x: number;
  y: number;
  flow: number;
  band: PlotBand;
  yield: number;
  crop: number; // progress toward the next harvest (0..1)
}
export interface IrrigationView {
  plots: PlotView[];
  cellFlow: Record<string, number>;
  valves: Set<string>;
  health: number;
  driftMult: number;
  /** Current eggs/sec at this layout + drift (peak rate ignores drift). */
  incomeRate: number;
  peakRate: number;
}

export function irrigationView(state: GameState): IrrigationView {
  const { plotFlow, cellFlow, valves } = solveFlow(state);
  const mult = driftMult(state);
  let income = 0;
  let peak = 0;
  const plots: PlotView[] = P.PLOTS.map((p, i) => {
    const y = plotYield(plotFlow[i]);
    income += (y * mult * P.CROP_SELL_EGGS) / P.CROP_GROW_SEC;
    peak += (y * P.CROP_SELL_EGGS) / P.CROP_GROW_SEC;
    return { x: p.x, y: p.y, flow: plotFlow[i], band: plotBand(plotFlow[i]), yield: y, crop: state.irrigation.crop[i] };
  });
  return {
    plots,
    cellFlow,
    valves,
    health: state.irrigation.health,
    driftMult: mult,
    incomeRate: income,
    peakRate: peak,
  };
}
