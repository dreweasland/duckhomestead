import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { cellKey, initialState, type GameState } from '../src/game/state';
import {
  solveFlow,
  plotYield,
  plotBand,
  driftMult,
  runIrrigation,
  toggleChannel,
  setValveKnob,
  tendPasture,
  PASTURE_ZONE,
} from '../src/game/irrigation';

const P = BALANCE.PASTURE;
/** A state with the pasture unlocked and no eggs banked. */
function pasture(): GameState {
  const s = initialState(0);
  s.zones.backPasture.unlocked = true;
  s.resources.eggs = 0;
  return s;
}
/** Index of the fixed plot at (x,y). */
const plotIdx = (x: number, y: number) => P.PLOTS.findIndex((p) => p.x === x && p.y === y);

describe('flow solve', () => {
  it('delivers the full source flow along a single channel to a plot', () => {
    const s = pasture();
    // source (3,0) -> (3,1) -> (3,2) -> plot (3,3)
    s.irrigation.channels = { [cellKey(3, 1)]: 0.5, [cellKey(3, 2)]: 0.5 };
    const { plotFlow } = solveFlow(s);
    expect(plotFlow[plotIdx(3, 3)]).toBeCloseTo(P.SOURCE_FLOW, 6);
    // every other plot is dry
    plotFlow.forEach((f, i) => {
      if (i !== plotIdx(3, 3)) expect(f).toBe(0);
    });
  });

  it('a valve splits flow by its knob at a 2-way branch', () => {
    const s = pasture();
    // source -> (3,1); branch east (4,1) + west (2,1)
    s.irrigation.channels = { [cellKey(3, 1)]: 0.5, [cellKey(4, 1)]: 0.5, [cellKey(2, 1)]: 0.5 };
    const sol0 = solveFlow(s);
    expect(sol0.valves.has(cellKey(3, 1))).toBe(true); // it's a branch
    // knob biases output[0] = the EAST child (4,1) (DIR order N,E,S,W)
    setValveKnob(s, 3, 1, 0.75);
    const { cellFlow } = solveFlow(s);
    expect(cellFlow[cellKey(4, 1)]).toBeCloseTo(P.SOURCE_FLOW * 0.75, 6);
    expect(cellFlow[cellKey(2, 1)]).toBeCloseTo(P.SOURCE_FLOW * 0.25, 6);
  });

  it('a disconnected channel carries no flow', () => {
    const s = pasture();
    s.irrigation.channels = { [cellKey(0, 5)]: 0.5 }; // island, not reachable from source
    const { cellFlow } = solveFlow(s);
    expect(cellFlow[cellKey(0, 5)] ?? 0).toBe(0);
  });
});

describe('plot sweet-spot band', () => {
  it('ramps up below the band, is full inside it, and falls off when waterlogged', () => {
    const [lo, hi] = P.PLOT_IDEAL_BAND;
    expect(plotYield(0)).toBe(0);
    expect(plotYield(lo / 2)).toBeCloseTo(0.5, 6); // half-watered -> half yield
    expect(plotYield(lo)).toBeCloseTo(1, 6);
    expect(plotYield((lo + hi) / 2)).toBe(1); // ideal
    expect(plotYield(hi)).toBe(1);
    expect(plotYield(hi * 2)).toBeCloseTo(P.PLOT_OVERWATER_FALLOFF, 6); // fully waterlogged
    expect(plotYield(hi * 4)).toBeCloseTo(P.PLOT_OVERWATER_FALLOFF, 6); // clamped at the floor
  });

  it('classifies the band', () => {
    const [lo, hi] = P.PLOT_IDEAL_BAND;
    expect(plotBand(lo - 0.1)).toBe('dry');
    expect(plotBand((lo + hi) / 2)).toBe('ideal');
    expect(plotBand(hi + 0.1)).toBe('over');
  });
});

describe('crop -> eggs (currency only, unlocked only)', () => {
  it('a watered plot grows crop that auto-sells for eggs', () => {
    const s = pasture();
    s.irrigation.channels = { [cellKey(3, 1)]: 0.5, [cellKey(3, 2)]: 0.5 }; // feed plot (3,3)
    const earned = runIrrigation(s, P.CROP_GROW_SEC * 3, 1); // long enough to harvest ≥1 unit
    expect(earned).toBeGreaterThan(0);
    expect(s.resources.eggs).toBe(earned);
  });

  it('earns nothing while the pasture is locked', () => {
    const s = pasture();
    s.zones.backPasture.unlocked = false;
    s.irrigation.channels = { [cellKey(3, 1)]: 0.5, [cellKey(3, 2)]: 0.5 };
    expect(runIrrigation(s, 100, 1)).toBe(0);
    expect(s.resources.eggs).toBe(0);
  });

  it('NEVER touches a nutrition axis or any non-egg resource', () => {
    const s = pasture();
    s.resources = { corn: 10, peas: 10, mealworms: 10, brewersYeast: 10, oysterShell: 10, forage: 0, pellets: 0, eggs: 0 };
    s.irrigation.channels = { [cellKey(3, 1)]: 0.5, [cellKey(3, 2)]: 0.5 };
    runIrrigation(s, 60, 1);
    expect(s.resources.corn).toBe(10);
    expect(s.resources.peas).toBe(10);
    expect(s.resources.mealworms).toBe(10);
    expect(s.resources.brewersYeast).toBe(10);
    expect(s.resources.oysterShell).toBe(10);
    expect(s.resources.forage).toBe(0);
    expect(s.resources.eggs).toBeGreaterThan(0); // only eggs moved
    expect(s.nutrition).toBeUndefined(); // irrigation never computes nutrition
  });
});

describe('upkeep drift (floor/peak, never zero, never a timer that punishes)', () => {
  it('health coasts to the floor when neglected, but output never zeroes', () => {
    const s = pasture();
    s.irrigation.channels = { [cellKey(3, 1)]: 0.5, [cellKey(3, 2)]: 0.5 };
    s.irrigation.health = 1;
    // Neglect for the full drift window.
    runIrrigation(s, P.DRIFT_TO_FLOOR_SEC, 1);
    expect(s.irrigation.health).toBeCloseTo(0, 5);
    expect(driftMult(s)).toBeCloseTo(P.UPKEEP_FLOOR, 5);
    // Still earning at the floor — a neglected pasture coasts, never breaks.
    const before = s.resources.eggs;
    runIrrigation(s, P.CROP_GROW_SEC * 6, 1);
    expect(s.resources.eggs).toBeGreaterThan(before);
  });

  it('a tend pass restores output to peak', () => {
    const s = pasture();
    s.irrigation.health = 0;
    expect(driftMult(s)).toBeCloseTo(P.UPKEEP_FLOOR, 5);
    expect(tendPasture(s)).toBe(true);
    expect(s.irrigation.health).toBe(P.TEND_RESTORE);
    expect(driftMult(s)).toBeCloseTo(1, 6);
  });

  it('tended output beats neglected output for the same layout', () => {
    const lay = (s: GameState) => (s.irrigation.channels = { [cellKey(3, 1)]: 0.5, [cellKey(3, 2)]: 0.5 });
    const tended = pasture(); lay(tended); tended.irrigation.health = 1;
    const neglected = pasture(); lay(neglected); neglected.irrigation.health = 0;
    runIrrigation(tended, P.CROP_GROW_SEC * 4, 1);
    runIrrigation(neglected, P.CROP_GROW_SEC * 4, 1);
    expect(tended.resources.eggs).toBeGreaterThan(neglected.resources.eggs);
  });
});

describe('channel laying keeps the network a tree (connected)', () => {
  it('lays only cells touching the network; erases on re-toggle; refuses islands/plots/source', () => {
    const s = pasture();
    expect(toggleChannel(s, 3, 1)).toBe(true); // adjacent to source
    expect(cellKey(3, 1) in s.irrigation.channels).toBe(true);
    expect(toggleChannel(s, 0, 6)).toBe(false); // island, not adjacent to anything
    expect(toggleChannel(s, P.SOURCE.x, P.SOURCE.y)).toBe(false); // the source tile
    expect(toggleChannel(s, P.PLOTS[0].x, P.PLOTS[0].y)).toBe(false); // a plot tile
    expect(toggleChannel(s, 3, 1)).toBe(true); // re-toggle erases
    expect(cellKey(3, 1) in s.irrigation.channels).toBe(false);
  });
});

describe('the pasture-zone constant is the back pasture', () => {
  it('matches the ZONE_DEFS id', () => {
    expect(PASTURE_ZONE).toBe('backPasture');
  });
});
