import { describe, it, expect } from 'vitest';
import { BALANCE, STATION_DEFS } from '../src/config/balance';
import { initialState, type Module } from '../src/game/state';
import {
  placeStation,
  moveStation,
  removeStation,
  tend,
  upgradeStation,
  upgradeCost,
  outputPerCycle,
  UPGRADE_OUTPUT,
  PRODUCER_OUTPUT,
  producerMaxed,
} from '../src/game/actions';
import { build, fullSetup, run, setHens, stockAll } from './helpers';

describe('placement', () => {
  it('charges eggs and places on an empty tile', () => {
    const s = initialState(0);
    expect(s.resources.eggs).toBe(BALANCE.STARTING_EGGS);
    const r = placeStation(s, 'plot', 0, 0);
    expect(r.ok).toBe(true);
    expect(s.resources.eggs).toBe(BALANCE.STARTING_EGGS - BALANCE.COSTS.plot);
    expect(s.stations).toHaveLength(1);
  });

  it('a fresh build starts on a full tend cooldown (closes place→tend→remove XP/loot farming)', () => {
    const s = initialState(0);
    placeStation(s, 'plot', 0, 0);
    expect(s.stations[0].tendCooldownRemaining).toBe(BALANCE.TEND_COOLDOWN_S);
    expect(tend(s, s.stations[0].id).ok).toBe(false); // no instant tend on placement
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

  it('allows dropping a station back on its OWN tile (drag-to-origin is not "occupied")', () => {
    const s = initialState(0);
    s.resources.eggs = 1000;
    placeStation(s, 'plot', 2, 2);
    const st = s.stations[0];
    expect(moveStation(s, st.id, 2, 2).ok).toBe(true); // own tile → allowed
    expect(st).toMatchObject({ x: 2, y: 2 });
  });

  it('preserves the station level, buffer, and cycle progress (only its position changes)', () => {
    const s = initialState(0);
    s.resources.eggs = 100000;
    placeStation(s, 'plot', 0, 0);
    const st = s.stations[0];
    st.level = 3;
    st.buffer = { corn: 12 };
    st.cycleProgress = 1.5;
    expect(moveStation(s, st.id, 5, 5).ok).toBe(true);
    expect(st).toMatchObject({ x: 5, y: 5, level: 3, cycleProgress: 1.5 });
    expect(st.buffer).toEqual({ corn: 12 });
  });

  it('rejects moving a station that does not exist', () => {
    const s = initialState(0);
    expect(moveStation(s, 'nope', 1, 1).ok).toBe(false);
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

describe('tend burst — derived from the live lay chain, never the raw base', () => {
  it('a coop with NO flock bursts ZERO eggs (XP still granted)', () => {
    // The old base-rate burst minted full eggs from an empty coop, feed-free.
    const s = stockAll(fullSetup());
    s.ducks = [];
    run(s, 2); // no layers → state.nutrition stays undefined
    const coop = s.stations.find((st) => st.type === 'coop')!;
    coop.tendCooldownRemaining = 0;
    const r = tend(s, coop.id);
    if (!r.ok) throw new Error('tend failed');
    expect(r.value.burst.eggs ?? 0).toBe(0);
    expect(r.value.xp.xpGained).toBeGreaterThan(0); // the reward is for the action
  });

  it("a coop burst is TEND_BURST_MULT cycles of the flock's LIVE egg rate", () => {
    const s = setHens(stockAll(fullSetup()), 3);
    run(s, 5); // warm the nutrition EMA / eggRate
    const rate = s.nutrition!.eggRate;
    const coop = s.stations.find((st) => st.type === 'coop')!;
    coop.tendCooldownRemaining = 0;
    const r = tend(s, coop.id);
    if (!r.ok) throw new Error('tend failed');
    expect(r.value.burst.eggs).toBeCloseTo(
      rate * BALANCE.COOP.cycleSeconds * BALANCE.TEND_BURST_MULT,
      4,
    );
  });

  it('a producer burst uses the CAPPED producer curve, same as its passive cycles', () => {
    const s = build({ plot: 1 });
    const plot = s.stations[0];
    plot.level = BALANCE.UPGRADE.PRODUCER.levelCap; // where the old flat curve overshot ~6.4×
    plot.tendCooldownRemaining = 0;
    const r = tend(s, plot.id);
    if (!r.ok) throw new Error('tend failed');
    expect(r.value.burst.corn).toBeCloseTo(
      BALANCE.PLOT.cornPerCycle * PRODUCER_OUTPUT(plot.level) * BALANCE.TEND_BURST_MULT,
      6,
    );
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

  it('a producer scales on the gentler CAPPED curve, not the standard upgrade curve', () => {
    const s = build({ plot: 1 });
    const plot = plotOf(s);
    const lvl1 = cornPerCycle(s, plot);
    plot.level = 3;
    expect(cornPerCycle(s, plot)).toBeCloseTo(lvl1 * (PRODUCER_OUTPUT(3) / PRODUCER_OUTPUT(1)), 10);
    // ...and it's gentler than the standard curve a coop/mill would use.
    expect(PRODUCER_OUTPUT(3)).toBeLessThan(UPGRADE_OUTPUT(3));
  });

  it('producer output CAPS at levelCap — past it upgrades are blocked (build another)', () => {
    const cap = BALANCE.UPGRADE.PRODUCER.levelCap;
    expect(PRODUCER_OUTPUT(cap + 5)).toBe(PRODUCER_OUTPUT(cap)); // no output past the cap
    const s = build({ plot: 1 });
    s.resources.eggs = 1e12;
    const plot = plotOf(s);
    plot.level = cap;
    expect(producerMaxed(plot)).toBe(true);
    expect(upgradeStation(s, plot.id).ok).toBe(false); // can't waste eggs upgrading a maxed producer
    expect(plot.level).toBe(cap); // unchanged
  });

  it('scales up with installed rack yield', () => {
    const s = build({ plot: 1 });
    const plot = plotOf(s);
    const base = cornPerCycle(s, plot);
    s.rack = [{ id: 'm1', stat: 'stationYield', rarity: 'epic', magnitude: 0.3 } as Module];
    expect(cornPerCycle(s, plot)).toBeGreaterThan(base);
  });
});

describe('producer repricing: wide-then-tall (price over power)', () => {
  it('producers climb their own steeper cost curve; mills/coops keep the standard one', () => {
    const s = build({ plot: 1, mill: 1 });
    const plot = s.stations.find((x) => x.type === 'plot')!;
    const mill = s.stations.find((x) => x.type === 'mill')!;
    plot.level = 6;
    mill.level = 6;
    const U = BALANCE.UPGRADE;
    expect(upgradeCost(plot)).toBe(Math.round(U.baseCost.plot * Math.pow(U.PRODUCER.costGrowth, 5)));
    expect(upgradeCost(mill)).toBe(Math.round(U.baseCost.mill * Math.pow(U.costGrowth, 5)));
    expect(upgradeCost(plot)).toBeGreaterThan(upgradeCost(mill)); // despite plot's LOWER base
    // Early levels barely move: L1->L2 is the base cost on BOTH curves.
    plot.level = 1;
    expect(upgradeCost(plot)).toBe(U.baseCost.plot);
  });
});
