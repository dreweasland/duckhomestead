import { describe, it, expect } from 'vitest';
import { BALANCE, STATION_DEFS } from '../src/config/balance';
import { initialState, type Module } from '../src/game/state';
import {
  placeStation,
  moveStation,
  removeStation,
  upgradeStation,
  upgradeCost,
  outputPerCycle,
  UPGRADE_OUTPUT,
} from '../src/game/actions';
import { build, run } from './helpers';

describe('placement', () => {
  it('charges eggs and places on an empty tile', () => {
    const s = initialState(0);
    expect(s.resources.eggs).toBe(BALANCE.STARTING_EGGS);
    const r = placeStation(s, 'plot', 0, 0);
    expect(r.ok).toBe(true);
    expect(s.resources.eggs).toBe(BALANCE.STARTING_EGGS - BALANCE.COSTS.plot);
    expect(s.stations).toHaveLength(1);
  });

  it('rejects occupied tiles, out of bounds, the pond, and unaffordable builds', () => {
    const s = initialState(0);
    s.resources.eggs = 1000;
    placeStation(s, 'plot', 0, 0);
    expect(placeStation(s, 'plot', 0, 0).ok).toBe(false); // occupied
    expect(placeStation(s, 'plot', -1, 0).ok).toBe(false); // bounds
    expect(placeStation(s, 'plot', BALANCE.POND.x, BALANCE.POND.y).ok).toBe(false); // pond
    s.resources.eggs = 0;
    expect(placeStation(s, 'coop', 5, 5).ok).toBe(false); // can't afford
  });
});

describe('move', () => {
  it('relocates to a free tile and rejects occupied/pond/out-of-bounds', () => {
    const s = initialState(0);
    s.resources.eggs = 1000;
    placeStation(s, 'plot', 0, 0);
    placeStation(s, 'mill', 1, 0);
    const id = s.stations[0].id;
    expect(moveStation(s, id, 1, 0).ok).toBe(false); // occupied
    expect(moveStation(s, id, BALANCE.POND.x, BALANCE.POND.y).ok).toBe(false); // pond
    expect(moveStation(s, id, 9, 9).ok).toBe(false); // bounds
    expect(moveStation(s, id, 4, 4).ok).toBe(true);
    expect(s.stations[0]).toMatchObject({ x: 4, y: 4 });
  });
});

describe('remove', () => {
  it('refunds the configured fraction and drops the station', () => {
    const s = initialState(0);
    s.resources.eggs = 1000;
    placeStation(s, 'coop', 0, 0);
    const before = s.resources.eggs;
    const r = removeStation(s, s.stations[0].id);
    expect(r.ok).toBe(true);
    const refund = Math.floor(BALANCE.COSTS.coop * BALANCE.REFUND_FRACTION);
    expect(r.ok && r.value.refund).toBe(refund);
    expect(s.resources.eggs).toBe(before + refund);
    expect(s.stations).toHaveLength(0);
  });
});

describe('upgrade', () => {
  it('raises level and costs more each time', () => {
    const s = initialState(0);
    s.resources.eggs = 100000;
    placeStation(s, 'plot', 0, 0);
    const st = s.stations[0];
    const c1 = upgradeCost(st);
    expect(upgradeStation(s, st.id).ok).toBe(true);
    expect(st.level).toBe(2);
    expect(upgradeCost(st)).toBeGreaterThan(c1);
  });
});

describe('outputPerCycle — the UI yield mirrors the sim', () => {
  const plotOf = (s: ReturnType<typeof build>) => s.stations.find((st) => st.type === 'plot')!;
  const cornPerCycle = (s: ReturnType<typeof build>, st: (typeof s.stations)[number]) =>
    outputPerCycle(s, st).find((o) => o.resource === 'corn')!.amount;

  it("equals what the sim actually deposits per cycle — including the rack's throughput scalar", () => {
    const s = build({ plot: 1 });
    // A yield module lifts the shared throughput multiplier. outputPerCycle recomputes
    // it; the sim (tick) hoists it once. The UI number must still match the deposit.
    s.rack = [{ id: 'm1', stat: 'stationYield', rarity: 'legendary', magnitude: 0.4 } as Module];
    const plot = plotOf(s);
    const perCycle = cornPerCycle(s, plot);
    const cycleSeconds = STATION_DEFS.plot.cycleSeconds; // no speed modules → effective == base
    const before = s.resources.corn;
    run(s, cycleSeconds * 10 + 0.5); // exactly 10 cycles, auto-hauled into storage
    expect(s.resources.corn - before).toBeCloseTo(perCycle * 10, 6);
  });

  it('scales with station level by the upgrade curve', () => {
    const s = build({ plot: 1 });
    const plot = plotOf(s);
    const lvl1 = cornPerCycle(s, plot);
    plot.level = 3;
    expect(cornPerCycle(s, plot)).toBeCloseTo(lvl1 * (UPGRADE_OUTPUT(3) / UPGRADE_OUTPUT(1)), 10);
  });

  it('scales up with installed rack yield', () => {
    const s = build({ plot: 1 });
    const plot = plotOf(s);
    const base = cornPerCycle(s, plot);
    s.rack = [{ id: 'm1', stat: 'stationYield', rarity: 'epic', magnitude: 0.3 } as Module];
    expect(cornPerCycle(s, plot)).toBeGreaterThan(base);
  });
});
