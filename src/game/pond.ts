import { BALANCE } from '../config/balance';
import {
  cellKey,
  zoneUnlocked,
  type FlowFeature,
  type FlowFeatureType,
  type GameState,
  type PondFeature,
  type PondFeatureType,
} from './state';

/**
 * pond.ts — the two puzzle layers of THE WATER SYSTEM (wellness-only).
 *
 *   1. LAYOUT (the Pond, Stage 1): place provision features on the shared canvas;
 *      adjacency bonuses make a thoughtful arrangement beat a scattered dump.
 *      → `pondLayoutBase`.
 *   2. CIRCULATION (Waterworks, Stage 2): route intake → fountains → outflow so
 *      live fountains keep the pond FRESH. A growing flock fouls it faster; only
 *      well-circulated features stay at peak, the rest coast to a floor.
 *      → `circulationHealth` (the ONE upkeep loop in the game).
 *
 * provision = pondLayoutBase × circulationHealth (see game/water.ts). This module
 * NEVER produces eggs/currency and never touches a nutrition axis.
 */

const W = BALANCE.WATER;
const F = W.FEATURES;
const C = W.CIRCULATION;
const GRID = W.CANVAS;

/** Zone ids the two tabs map onto (Waterworks reuses the old back-pasture slot). */
export const POND_ZONE = 'pond';
export const WORKS_ZONE = 'backPasture';

const ORTHO: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < GRID.width && y < GRID.height;
const cheb = (ax: number, ay: number, bx: number, by: number) =>
  Math.max(Math.abs(ax - bx), Math.abs(ay - by));

// ── Terrain (Phase 5 juice, water assessment fix ③) ───────────────────

/** This RUN's blocked tiles (rocks/reeds) — a fresh copy (callers may hold it).
 *  Reads `pondTerrainTier`, NOT `legacyTier` directly: the tier only advances
 *  at prestige (which also wipes state.pond.features), so a save from before
 *  this field existed defaults to 0 (the open canvas) and never has an
 *  already-placed feature retroactively sit on a newly-blocked tile. */
export function terrainForTier(tier: number): { x: number; y: number }[] {
  const terrain = W.TERRAIN_BY_TIER;
  return terrain[tier % terrain.length].map((t) => ({ ...t }));
}

export function isTerrainBlocked(state: GameState, x: number, y: number): boolean {
  const terrain = W.TERRAIN_BY_TIER;
  const tiles = terrain[state.pondTerrainTier % terrain.length];
  return tiles.some((t) => t.x === x && t.y === y);
}

export type PondResult = { ok: true } | { ok: false; reason: string };
const ok = (): PondResult => ({ ok: true });
const fail = (reason: string): PondResult => ({ ok: false, reason });

// ── Stage 1: layout scoring ──────────────────────────────────────────

/**
 * Provision each placed feature contributes, INCLUDING arrangement bonuses:
 *   - a bathingPool adjacent to a spring earns its springBonus,
 *   - each adjacent plantBed raises a feature's quality by adjacentQualityBonus.
 * Keyed "x,y". A clustered layout (spring beside pools, plant beds beside the
 * deep zone) strictly out-scores the same features scattered apart.
 */
export function featureProvisions(state: GameState): Map<string, number> {
  const feats = state.pond.features;
  // Index by cell once (O(features)) so adjacency lookups are O(1) — the whole
  // function used to be O(features²) via a per-neighbor `feats.find`, and it runs
  // every tick (waterCondition/waterWound multipliers).
  const typeByCell = new Map<string, PondFeatureType>(feats.map((f) => [cellKey(f.x, f.y), f.type]));
  const typeAt = (x: number, y: number): PondFeatureType | undefined => typeByCell.get(cellKey(x, y));
  const adjSpring = (x: number, y: number) => ORTHO.some(([dx, dy]) => typeAt(x + dx, y + dy) === 'spring');
  const adjPlantBeds = (x: number, y: number) =>
    ORTHO.filter(([dx, dy]) => typeAt(x + dx, y + dy) === 'plantBed').length;

  const out = new Map<string, number>();
  for (const f of feats) {
    let p = F[f.type].baseProvision;
    if (f.type === 'bathingPool' && adjSpring(f.x, f.y)) p += F.bathingPool.springBonus;
    p *= Math.pow(W.UPGRADE.provisionMult, (f.level ?? 1) - 1); // upgrades scale the feature's water
    const quality = 1 + F.plantBed.adjacentQualityBonus * adjPlantBeds(f.x, f.y);
    out.set(cellKey(f.x, f.y), p * quality);
  }
  return out;
}

/** layoutBase = always-on baseline + Σ feature provision (arrangement-scored).
 *  Accepts a precomputed provisions map so a caller that also needs
 *  circulationHealth (i.e. waterProvision) builds it once, not twice. */
export function pondLayoutBase(state: GameState, provs = featureProvisions(state)): number {
  let base = W.YARD_BASELINE_PROVISION;
  for (const p of provs.values()) base += p;
  return base;
}

// ── Stage 2: circulation coverage ────────────────────────────────────

/**
 * The live fountains: a fountain projects coverage only if its orthogonally
 * connected flow network contains BOTH an intake and an outflow (water enters,
 * circulates, and leaves). Disconnected or dead-end fountains are inert.
 */
export function liveFountains(state: GameState): FlowFeature[] {
  const flow = state.pond.flow;
  // Index by cell once so BFS neighbor lookups are O(1) — this was O(flow²) via a
  // per-neighbor `flow.find`, and it runs every tick (runCirculation) + per render.
  const byCell = new Map<string, FlowFeature>(flow.map((f) => [cellKey(f.x, f.y), f]));
  const at = (x: number, y: number) => byCell.get(cellKey(x, y));
  const k = (f: FlowFeature) => cellKey(f.x, f.y);
  const seen = new Set<string>();
  const live: FlowFeature[] = [];
  for (const start of flow) {
    if (seen.has(k(start))) continue;
    const comp: FlowFeature[] = [];
    const q: FlowFeature[] = [start];
    seen.add(k(start));
    while (q.length) {
      const c = q.shift()!;
      comp.push(c);
      for (const [dx, dy] of ORTHO) {
        const nb = at(c.x + dx, c.y + dy);
        if (nb && !seen.has(k(nb))) {
          seen.add(k(nb));
          q.push(nb);
        }
      }
    }
    if (comp.some((f) => f.type === 'intake') && comp.some((f) => f.type === 'outflow')) {
      live.push(...comp.filter((f) => f.type === 'fountain'));
    }
  }
  return live;
}

/** Whether a tile is kept fresh by a live fountain within the coverage radius. */
export function isCovered(live: FlowFeature[], x: number, y: number): boolean {
  return live.some((f) => cheb(f.x, f.y, x, y) <= C.fountainCoverageRadius);
}

/**
 * How fresh the pond is kept, as a single 0.45..1 factor. Defined so that
 * `pondLayoutBase × circulationHealth` exactly equals
 *   baseline + Σ (featureProvision × featureFreshness)
 * — i.e. the always-on baseline is never fouled (it's the safety floor), and each
 * feature contributes in proportion to how well it's circulated. Returns 1 while
 * Waterworks is locked (the pond stays passively clean) or the pond is empty.
 */
export function circulationHealth(state: GameState, provs = featureProvisions(state)): number {
  if (!zoneUnlocked(state, WORKS_ZONE)) return 1;
  let weighted = W.YARD_BASELINE_PROVISION; // baseline: always fresh
  let total = W.YARD_BASELINE_PROVISION;
  for (const [key, p] of provs) {
    const fresh = state.pond.freshness[key] ?? 1;
    weighted += p * fresh;
    total += p;
  }
  return total > 0 ? weighted / total : 1;
}

/**
 * Advance feature freshness by `dt` (rate-scaled): covered features recover toward
 * peak, uncovered features coast toward the floor at a rate that scales with flock
 * size (deep zones foul fastest). The ONE upkeep loop — never zero, never a timer
 * that punishes absence. No-op until Waterworks is unlocked (staging) or the pond
 * has no features. Runs online & offline (offline at the reduced rate).
 */
export function runCirculation(state: GameState, dt: number, rateMult: number): void {
  if (!zoneUnlocked(state, WORKS_ZONE)) return;
  const feats = state.pond.features;
  if (feats.length === 0) return;
  const step = dt * rateMult;
  // Winter-assigned ducks (6d) aren't in the pond — they don't foul it.
  let flock = 0;
  for (const d of state.ducks) if (d.site !== 'winter') flock++;
  const live = liveFountains(state);
  const fresh = state.pond.freshness;
  const span = 1 - C.circulationFloor;
  const recoverPerSec = span / C.foulToFloorSec; // a covered feature restores this fast

  const keep = new Set<string>();
  for (const f of feats) {
    const key = cellKey(f.x, f.y);
    keep.add(key);
    let v = fresh[key] ?? 1;
    if (isCovered(live, f.x, f.y)) {
      v = Math.min(1, v + recoverPerSec * step);
    } else {
      // Fouling scales with flock; the deep zone (wantsCirculation) fouls fastest.
      const foulMult = f.type === 'deepZone' ? C.wantsCirculationFoulMult : 1;
      const driftPerSec = recoverPerSec * C.foulPerDuckPerSec * flock * foulMult;
      v = Math.max(C.circulationFloor, v - driftPerSec * step);
    }
    fresh[key] = v;
  }
  // Drop freshness entries for tiles that no longer hold a feature.
  for (const key of Object.keys(fresh)) if (!keep.has(key)) delete fresh[key];
}

// ── Player actions ───────────────────────────────────────────────────

const featAt = (state: GameState, x: number, y: number) =>
  state.pond.features.find((f) => f.x === x && f.y === y);
const flowAt = (state: GameState, x: number, y: number) =>
  state.pond.flow.find((f) => f.x === x && f.y === y);

/** Place a provision feature (Stage 1). Provision + freshness layers can overlap. */
export function placePondFeature(
  state: GameState,
  type: PondFeatureType,
  x: number,
  y: number,
): PondResult {
  if (!zoneUnlocked(state, POND_ZONE)) return fail('Unlock the Pond first');
  if (!inBounds(x, y)) return fail('Out of bounds');
  if (isTerrainBlocked(state, x, y)) return fail('Blocked by terrain');
  if (featAt(state, x, y)) return fail('Tile occupied');
  const cost = F[type].costEggs;
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  state.pond.features.push({ x, y, type });
  state.pond.freshness[cellKey(x, y)] = 1; // a new feature starts fresh
  return ok();
}

/** Egg cost to upgrade the provision feature at (x,y) to its next level. */
export function pondFeatureUpgradeCost(state: GameState, x: number, y: number): number {
  const f = featAt(state, x, y);
  if (!f) return 0;
  return Math.round(F[f.type].costEggs * Math.pow(W.UPGRADE.costGrowth, f.level ?? 1));
}

/** Upgrade a provision feature (+1 level → more water). The pre-prestige water
 *  scaler and a deep, escalating egg sink. */
export function upgradePondFeature(state: GameState, x: number, y: number): PondResult {
  const f = featAt(state, x, y);
  if (!f) return fail('Nothing there');
  // A spring (baseProvision 0) is positional — its level never scales anything, so
  // upgrading it would just burn eggs. Its bonus to pools rides the POOL's level.
  if (F[f.type].baseProvision <= 0) return fail('Springs feed pools — they can’t be upgraded');
  const cost = pondFeatureUpgradeCost(state, x, y);
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  f.level = (f.level ?? 1) + 1;
  return ok();
}

/** Remove a provision feature, refunding part of its cost. */
export function removePondFeature(state: GameState, x: number, y: number): PondResult {
  const f = featAt(state, x, y);
  if (!f) return fail('Nothing there');
  state.pond.features = state.pond.features.filter((g) => g !== f);
  delete state.pond.freshness[cellKey(x, y)];
  state.resources.eggs += Math.floor(F[f.type].costEggs * BALANCE.REFUND_FRACTION);
  return ok();
}

/** Place a circulation feature (Stage 2). */
export function placeFlowFeature(
  state: GameState,
  type: FlowFeatureType,
  x: number,
  y: number,
): PondResult {
  if (!zoneUnlocked(state, WORKS_ZONE)) return fail('Unlock Waterworks first');
  if (!inBounds(x, y)) return fail('Out of bounds');
  if (isTerrainBlocked(state, x, y)) return fail('Blocked by terrain');
  if (flowAt(state, x, y)) return fail('Tile occupied');
  const cost = W.FLOW[type].costEggs;
  if (state.resources.eggs < cost) return fail(`Need ${cost} eggs`);
  state.resources.eggs -= cost;
  state.pond.flow.push({ x, y, type });
  return ok();
}

/** Remove a circulation feature, refunding part of its cost. */
export function removeFlowFeature(state: GameState, x: number, y: number): PondResult {
  const f = flowAt(state, x, y);
  if (!f) return fail('Nothing there');
  state.pond.flow = state.pond.flow.filter((g) => g !== f);
  state.resources.eggs += Math.floor(W.FLOW[f.type].costEggs * BALANCE.REFUND_FRACTION);
  return ok();
}

// ── UI view (renders both layers from GameState) ─────────────────────

export interface FeatureView extends PondFeature {
  provision: number;
  freshness: number;
  covered: boolean;
}
export interface PondView {
  layoutBase: number;
  circulationHealth: number;
  features: FeatureView[];
  flow: FlowFeature[];
  /** Keys "x,y" of the LIVE fountains (connected intake↔outflow). */
  liveKeys: Set<string>;
  worksUnlocked: boolean;
  /** This run's blocked terrain tiles (Phase 5 juice) — render as scenery. */
  terrain: { x: number; y: number }[];
}

export function pondView(state: GameState): PondView {
  const provs = featureProvisions(state);
  const live = liveFountains(state);
  const liveKeys = new Set(live.map((f) => cellKey(f.x, f.y)));
  const worksUnlocked = zoneUnlocked(state, WORKS_ZONE);
  const features: FeatureView[] = state.pond.features.map((f) => ({
    ...f,
    provision: provs.get(cellKey(f.x, f.y)) ?? 0,
    freshness: state.pond.freshness[cellKey(f.x, f.y)] ?? 1,
    covered: worksUnlocked && isCovered(live, f.x, f.y),
  }));
  return {
    // Reuse the provisions map already built above — pondLayoutBase/circulationHealth
    // otherwise each recompute featureProvisions via their default param, so this ran
    // O(features) three times per pondView (called every render while the board's open).
    layoutBase: pondLayoutBase(state, provs),
    circulationHealth: circulationHealth(state, provs),
    features,
    flow: state.pond.flow,
    liveKeys,
    worksUnlocked,
    terrain: terrainForTier(state.pondTerrainTier),
  };
}
