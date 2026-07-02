import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { serialize, deserialize } from '../src/game/save';
import { type Duck, type Module } from '../src/game/state';
import { fullSetup } from './helpers';

const N = BALANCE.NUTRITION;

describe('save round-trip', () => {
  it('preserves all Phase 1 + Phase 2 state', () => {
    const s = fullSetup();
    s.ration = { corn: 3, peas: 2, mealworms: 0.5, brewersYeast: 1, oysterShell: 1.5, sunflowerSeeds: 0, fodderSprouts: 0 };
    s.condition = 42.5;
    s.niacinShortfall = 123;
    s.doseCooldownRemaining = 17;
    s.rank = 4;
    s.xp = 88;
    s.resources.mealworms = 88;
    s.stations.find((x) => x.type === 'coop')!.debuffed = true;
    s.stations[0].level = 3;

    const r = deserialize(serialize(s), 999);
    expect(r.ration).toEqual(s.ration);
    expect(r.condition).toBe(42.5);
    expect(r.niacinShortfall).toBe(123);
    expect(r.doseCooldownRemaining).toBe(17);
    expect(r.rank).toBe(4);
    expect(r.resources.mealworms).toBe(88);
    expect(r.stations.find((x) => x.type === 'coop')!.debuffed).toBe(true);
    expect(r.stations[0].level).toBe(3);
  });

  it('preserves the full Phase 4 deep-game state (breeding / loot / predators / prestige / zones)', () => {
    const s = fullSetup();
    // breeding
    s.ducks = [
      { id: 'd1', genotype: ['Bl', 'bl'], genome: ['L', 'L', 'V', 'H', 'D', 'L'], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 3, secured: true },
      { id: 'd2', genotype: ['bl', 'bl'], genome: ['D', 'D', 'D', 'D', 'D', 'D'], genomeKnown: false, sex: 'drake', stage: 'juvenile', ageTicks: 1, wounded: true, woundElapsed: 7, woundSource: 'predator', severity: 'serious', recovering: true, recoveryElapsed: 4 },
    ] as Duck[];
    s.nextDuckId = 3;
    s.breedingPairs = [{ id: 'p1', drakeId: 'd2', henId: 'd1', clutchProgress: 4, incubating: [1, 2] }];
    s.nextPairId = 2;
    s.genomeTarget = ['L', 'L', 'V', 'H', 'D', 'L'];
    s.geneReader = true;
    s.dexSeen = ['black', 'blue'];
    // loot
    s.rack = [{ id: 'm1', stat: 'stationYield', rarity: 'epic', magnitude: 0.3 }] as Module[];
    s.inventory = [{ id: 'm2', stat: 'tendPower', rarity: 'rare', magnitude: 0.2 }] as Module[];
    s.nextModuleId = 3;
    s.dust = 55;
    s.statWeights = { ...s.statWeights, stationYield: 3 };
    s.statWeightPreset = 'idle';
    // predators
    s.deterrents = 2;
    s.deterrentIntegrity = 0.6;
    s.hardwareCloth = 2;
    s.hardwareClothIntegrity = 0.5;
    s.secureCoops = 1;
    s.infirmaries = 3;
    s.predatorsIntroduced = true;
    s.predatorsSeen = ['owl', 'raccoon'];
    // prestige
    s.legacyTier = 3;
    s.legacyCurrency = 40;
    s.purchasedBoosts = { output: 2, eggValue: 1 };
    s.legacyHall = [{ tier: 1, meanQuality: 4.2, bestQuality: 6, flockSize: 80, colors: ['black'], timestamp: 123 }];
    // zones
    s.zones.pond.unlocked = true;

    const r = deserialize(serialize(s), 999);
    expect(r.ducks).toEqual(s.ducks);
    expect(r.nextDuckId).toBe(3);
    expect(r.breedingPairs).toEqual(s.breedingPairs);
    expect(r.nextPairId).toBe(2);
    expect(r.genomeTarget).toEqual(s.genomeTarget);
    expect(r.geneReader).toBe(true);
    expect(r.dexSeen).toEqual(['black', 'blue']);
    expect(r.rack).toEqual(s.rack);
    expect(r.inventory).toEqual(s.inventory);
    expect(r.nextModuleId).toBe(3);
    expect(r.dust).toBe(55);
    expect(r.statWeights.stationYield).toBe(3);
    expect(r.statWeightPreset).toBe('idle');
    expect(r.deterrents).toBe(2);
    expect(r.deterrentIntegrity).toBe(0.6);
    expect(r.hardwareCloth).toBe(2);
    expect(r.hardwareClothIntegrity).toBe(0.5);
    expect(r.predatorsSeen).toEqual(['owl', 'raccoon']);
    expect(r.secureCoops).toBe(1);
    expect(r.infirmaries).toBe(3);
    expect(r.ducks[1]).toMatchObject({ severity: 'serious', recovering: true, recoveryElapsed: 4 });
    expect(r.predatorsIntroduced).toBe(true);
    expect(r.legacyTier).toBe(3);
    expect(r.legacyCurrency).toBe(40);
    expect(r.purchasedBoosts).toEqual({ output: 2, eggValue: 1 });
    expect(r.legacyHall).toEqual(s.legacyHall);
    expect(r.zones.pond.unlocked).toBe(true);
  });

  it('Phase 6c: a Prime-carrying duck genome round-trips intact (validGenome must accept P)', () => {
    const s = fullSetup();
    s.ducks = [
      { id: 'd1', genotype: ['Bl', 'bl'], genome: ['P', 'P', 'L', 'V', 'H', 'D'], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 },
    ] as Duck[];
    s.nextDuckId = 2;
    const r = deserialize(serialize(s), 999);
    // The footgun: an unaccepted 'P' would have failed validGenome and silently
    // re-rolled/reset this genome instead of round-tripping it.
    expect(r.ducks).toEqual(s.ducks);
    expect(r.ducks[0].genome).toEqual(['P', 'P', 'L', 'V', 'H', 'D']);
  });
});

describe('back-compat + robustness', () => {
  it('loads a legacy Phase 1 save with defaults; keeps pellets as a dead field', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { corn: 2, pellets: 9, eggs: 200 },
      stations: [{ id: 'c1', type: 'coop', x: 0, y: 0, level: 1 }],
      rank: 3,
      xp: 5,
      autoHaulUnlocked: true,
      lastSeen: 0,
    });
    const r = deserialize(legacy, 1000);
    expect(r.ration.corn).toBe(0); // rations now start EMPTY (player sets them)
    expect(r.condition).toBe(N.CONDITION_MAX);
    expect(r.niacinShortfall).toBe(0);
    expect(r.doseCooldownRemaining).toBe(0);
    expect((r.resources as Record<string, number>).pellets).toBe(9);
    expect(r.resources.mealworms).toBe(0);
  });

  it('falls back to a REAL fresh game (starter engine + seed flock) on corrupt JSON', () => {
    const r = deserialize('}{ not json', 0);
    expect(r.stations.map((s) => s.type).sort()).toEqual(['coop', 'mill', 'plot']);
    expect(r.ducks.length).toBeGreaterThan(0); // the coop seeded the flock
    expect(r.resources.eggs).toBe(BALANCE.STARTING_EGGS);
  });

  it('drops stations of an unknown type instead of boot-looping every load', () => {
    // A save written by a newer build (or a type ever removed) must not crash
    // the catch-up tick's STATION_DEFS[type] dereference on every load.
    const raw = JSON.stringify({
      stations: [
        { id: 's1', type: 'plot', zoneId: 'yard', x: 0, y: 0, level: 1, cycleProgress: 0, buffer: {}, tendCooldownRemaining: 0 },
        { id: 's2', type: 'cheeseForge', zoneId: 'yard', x: 1, y: 0, level: 1, cycleProgress: 0, buffer: {}, tendCooldownRemaining: 0 },
      ],
    });
    const r = deserialize(raw, 0);
    expect(r.stations.map((s) => s.type)).toEqual(['plot']);
  });

  it('sanitizes NaN/negative numerics so they can never propagate through storage', () => {
    const raw = JSON.stringify({
      resources: { corn: Number.NaN, eggs: -50, peas: 12 },
      dust: Number.NaN,
      legacyCurrency: -3,
      condition: Number.NaN,
    });
    const r = deserialize(raw, 0);
    expect(r.resources.corn).toBe(0);
    expect(r.resources.eggs).toBe(BALANCE.STARTING_EGGS); // reset to the base value
    expect(r.resources.peas).toBe(12); // sane values untouched
    expect(r.dust).toBe(0);
    expect(r.legacyCurrency).toBe(0);
    expect(Number.isFinite(r.condition)).toBe(true);
  });

  it('recalls winter-assigned ducks when the save has Winterstead locked (no limbo)', () => {
    const raw = JSON.stringify({
      ducks: [
        { id: 'd1', genome: ['L', 'L', 'L', 'L', 'L', 'L'], sex: 'hen', stage: 'adult', ageTicks: 0, site: 'winter' },
      ],
      // zones absent → defaults: winterstead locked.
    });
    const r = deserialize(raw, 0);
    expect(r.ducks[0].site).toBe('home');
  });

  it('never replays a stale contract-expired toast from the previous session', () => {
    const raw = JSON.stringify({ pendingContractExpired: 3 });
    const r = deserialize(raw, 0);
    expect(r.pendingContractExpired).toBe(0);
  });

  it('advances id counters past existing ids so no duplicate id is ever minted', () => {
    // A legacy/hand-edited save whose counters trail its live ids: naively defaulting
    // nextDuckId to 1 would re-mint d3 on the next hatch and collide.
    const raw = JSON.stringify({
      ducks: [
        { id: 'd3', genome: ['L', 'L', 'L', 'L', 'L', 'L'], sex: 'hen', stage: 'adult', ageTicks: 0 },
        { id: 'd7', genome: ['D', 'D', 'D', 'D', 'D', 'D'], sex: 'drake', stage: 'adult', ageTicks: 0 },
      ],
      inventory: [{ id: 'm5', stat: 'stationYield', rarity: 'common', magnitude: 0.1 }],
      breedingPairs: [{ id: 'p2', drakeId: 'd7', henId: 'd3', clutchProgress: 0, incubating: [] }],
      // nextDuckId / nextModuleId / nextPairId all absent → default 1 before the guard.
    });
    const r = deserialize(raw, 0);
    expect(r.nextDuckId).toBe(8); // past d7
    expect(r.nextModuleId).toBe(6); // past m5
    expect(r.nextPairId).toBe(3); // past p2
  });

  it('back-derives BOTH rank-gated milestones from rank on load', () => {
    // A pre-milestone save at rank 12 (past both gates) with the flags absent must
    // load with Auto-Haul AND Tend-All already unlocked — not stuck until a rank-up.
    const r = deserialize(JSON.stringify({ rank: 12 }), 0);
    expect(r.autoHaulUnlocked).toBe(true); // rank ≥ 5
    expect(r.tendAllUnlocked).toBe(true); // rank ≥ 10
    // Below the gate stays locked.
    const low = deserialize(JSON.stringify({ rank: BALANCE.MILESTONE_AUTOHAUL_RANK - 1 }), 0);
    expect(low.autoHaulUnlocked).toBe(false);
  });

  it('merges a partial saved ration with defaults', () => {
    const r = deserialize(JSON.stringify({ ration: { corn: 9 } }), 0);
    expect(r.ration.corn).toBe(9);
    expect(r.ration.oysterShell).toBe(0); // unset keys fill from the empty base

  });

  it('defaults loot fields for a pre-Phase-3 save', () => {
    const r = deserialize(JSON.stringify({ ration: { corn: 2 }, condition: 50 }), 0);
    expect(r.inventory).toEqual([]);
    expect(r.dust).toBe(0);
    expect(r.nextModuleId).toBe(1);
    expect(r.stations).toEqual([]);
  });
});

describe('loot save round-trip', () => {
  it('preserves spares, the installed rack, dust, and the id counter', () => {
    const s = fullSetup();
    s.dust = 42;
    s.nextModuleId = 7;
    s.inventory = [{ id: 'm1', stat: 'stationYield', rarity: 'epic', magnitude: 0.3 }];
    s.rack = [{ id: 'm2', stat: 'stationSpeed', rarity: 'rare', magnitude: 0.2 }];
    const r = deserialize(serialize(s), 0);
    expect(r.dust).toBe(42);
    expect(r.nextModuleId).toBe(7);
    expect(r.inventory).toEqual(s.inventory);
    expect(r.rack).toEqual(s.rack);
  });

  it('migrates a pre-rack save: per-station modules move into the rack', () => {
    const s = fullSetup();
    s.rank = 1; // 3 sockets
    // Legacy shape: modules slotted on stations, no rack field.
    s.stations[0].modules = [{ id: 'a', stat: 'stationSpeed', rarity: 'rare', magnitude: 0.2 }];
    s.stations[1].modules = [{ id: 'b', stat: 'stationYield', rarity: 'epic', magnitude: 0.3 }];
    const raw = JSON.parse(serialize(s));
    delete raw.rack; // simulate a save written before the rack existed
    const r = deserialize(JSON.stringify(raw), 0);
    expect(r.rack.map((m) => m.id).sort()).toEqual(['a', 'b']);
    expect(r.stations.every((st) => (st.modules ?? []).length === 0)).toBe(true);
  });
});
