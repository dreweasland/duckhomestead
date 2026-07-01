import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { initialState, type GameState, type PondFeature } from '../src/game/state';
import {
  circulationHealth,
  featureProvisions,
  placePondFeature,
  pondLayoutBase,
  pondView,
  removePondFeature,
} from '../src/game/pond';
import { waterProvision } from '../src/game/water';

const W = BALANCE.WATER;
const F = W.FEATURES;

/** A pond-unlocked, egg-rich state (Waterworks still locked → no fouling). */
function pondState(): GameState {
  const s = initialState(0);
  s.zones.pond.unlocked = true;
  s.resources.eggs = 1e6;
  return s;
}

function withFeatures(feats: PondFeature[]): GameState {
  const s = pondState();
  s.pond.features = feats;
  return s;
}

describe('Stage 1: layout-adjacency scoring (the Pond)', () => {
  it('layoutBase is the always-on baseline when the pond is empty', () => {
    expect(pondLayoutBase(initialState(0))).toBe(W.YARD_BASELINE_PROVISION);
  });

  it('a bathing pool earns its spring bonus only when adjacent to a spring', () => {
    const fed = withFeatures([
      { x: 1, y: 1, type: 'spring' },
      { x: 1, y: 0, type: 'bathingPool' }, // orthogonally adjacent to the spring
    ]);
    const lone = withFeatures([{ x: 5, y: 3, type: 'bathingPool' }]); // no spring nearby
    expect(featureProvisions(fed).get('1,0')).toBeCloseTo(F.bathingPool.baseProvision + F.bathingPool.springBonus, 6);
    expect(featureProvisions(lone).get('5,3')).toBeCloseTo(F.bathingPool.baseProvision, 6);
  });

  it('a plant bed raises the quality of each adjacent feature', () => {
    const s = withFeatures([
      { x: 0, y: 0, type: 'deepZone' },
      { x: 1, y: 0, type: 'plantBed' }, // adjacent to the deep zone
    ]);
    const boosted = featureProvisions(s).get('0,0')!;
    expect(boosted).toBeCloseTo(F.deepZone.baseProvision * (1 + F.plantBed.adjacentQualityBonus), 6);
  });

  it('a thoughtful (clustered) layout provably beats the same features scattered apart', () => {
    // Spring feeds an adjacent pool (+springBonus), a plant bed lifts that pool.
    const thoughtful = withFeatures([
      { x: 1, y: 1, type: 'spring' },
      { x: 1, y: 0, type: 'bathingPool' }, // adj spring
      { x: 0, y: 0, type: 'plantBed' }, // adj the pool
    ]);
    // Identical multiset, spread to the corners so NOTHING is adjacent.
    const scattered = withFeatures([
      { x: 0, y: 4, type: 'spring' },
      { x: 6, y: 0, type: 'bathingPool' },
      { x: 6, y: 4, type: 'plantBed' },
    ]);
    expect(pondLayoutBase(thoughtful)).toBeGreaterThan(pondLayoutBase(scattered));
  });

  it('circulation is passive (×1) while Waterworks is locked — a Pond-only flock is never fouled', () => {
    const s = withFeatures([{ x: 0, y: 0, type: 'deepZone' }]);
    s.pond.freshness['0,0'] = 0.45; // even if a stale value lingers
    expect(circulationHealth(s)).toBe(1);
    expect(waterProvision(s)).toBe(pondLayoutBase(s)); // provision = layoutBase × 1
  });
});

describe('Stage 1: placement actions', () => {
  it('placement is gated behind the Pond unlock', () => {
    const locked = initialState(0);
    locked.resources.eggs = 1e6;
    expect(placePondFeature(locked, 'bathingPool', 0, 0).ok).toBe(false);
  });

  it('placing charges eggs, seeds fresh, and rejects occupied / out-of-bounds tiles', () => {
    const s = pondState();
    const before = s.resources.eggs;
    expect(placePondFeature(s, 'bathingPool', 2, 2).ok).toBe(true);
    expect(s.resources.eggs).toBe(before - F.bathingPool.costEggs);
    expect(s.pond.features).toHaveLength(1);
    expect(s.pond.freshness['2,2']).toBe(1); // a new feature starts fresh
    expect(placePondFeature(s, 'spring', 2, 2).ok).toBe(false); // occupied
    expect(placePondFeature(s, 'spring', W.CANVAS.width, 0).ok).toBe(false); // out of bounds
  });

  it('removing a feature refunds part of its cost and clears its freshness', () => {
    const s = pondState();
    placePondFeature(s, 'deepZone', 1, 1);
    const afterPlace = s.resources.eggs;
    expect(removePondFeature(s, 1, 1).ok).toBe(true);
    expect(s.pond.features).toHaveLength(0);
    expect(s.pond.freshness['1,1']).toBeUndefined();
    expect(s.resources.eggs).toBe(afterPlace + Math.floor(F.deepZone.costEggs * BALANCE.REFUND_FRACTION));
  });
});

describe('pondView — the WaterBoard reader (aggregates features + flow + circulation)', () => {
  it('layoutBase and circulationHealth match the standalone computations (the reuse is faithful)', () => {
    const s = withFeatures([
      { x: 1, y: 1, type: 'spring' },
      { x: 1, y: 0, type: 'bathingPool' }, // spring-adjacent → earns the bonus
      { x: 3, y: 3, type: 'deepZone' },
    ]);
    const v = pondView(s);
    // #33 passed the prebuilt provisions map into both; the results must be identical
    // to calling them standalone (which rebuild the map themselves).
    expect(v.layoutBase).toBeCloseTo(pondLayoutBase(s), 10);
    expect(v.circulationHealth).toBeCloseTo(circulationHealth(s), 10);
    expect(v.layoutBase).toBeGreaterThan(W.YARD_BASELINE_PROVISION); // features lifted it
  });

  it("surfaces each feature's provision and freshness for the grid", () => {
    const s = withFeatures([
      { x: 1, y: 1, type: 'spring' },
      { x: 1, y: 0, type: 'bathingPool' },
    ]);
    s.pond.freshness['1,0'] = 0.7;
    const v = pondView(s);
    const pool = v.features.find((f) => f.x === 1 && f.y === 0)!;
    expect(pool.provision).toBeCloseTo(featureProvisions(s).get('1,0')!, 10);
    expect(pool.freshness).toBe(0.7);
    // A feature with no freshness entry reads as fully fresh (1).
    expect(v.features.find((f) => f.x === 1 && f.y === 1)!.freshness).toBe(1);
  });

  it('reports live fountains + the Waterworks unlock state, and passes flow through', () => {
    const s = withFeatures([{ x: 2, y: 2, type: 'bathingPool' }]);
    const v = pondView(s);
    expect(v.worksUnlocked).toBe(false); // Waterworks zone still locked
    expect(v.liveKeys.size).toBe(0); // no flow network → nothing live
    expect(v.features.every((f) => f.covered === false)).toBe(true); // coverage needs Waterworks
    expect(v.flow).toBe(s.pond.flow); // flow passed straight through
  });
});
