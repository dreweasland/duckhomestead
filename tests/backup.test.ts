import { describe, it, expect } from 'vitest';
import { deserialize, looksLikeSave, serialize } from '../src/game/save';
import { assignToWinter, placeStation } from '../src/game/actions';
import { type ProvisionContract } from '../src/game/state';
import { fullSetup, setHens, stockAll, FLAT_GENOME } from './helpers';

describe('looksLikeSave — the import shape-sniff (Phase 5 juice)', () => {
  it('accepts a real serialized save', () => {
    const s = fullSetup();
    expect(looksLikeSave(JSON.parse(serialize(s)))).toBe(true);
  });

  it('rejects non-object, null, arrays, and unrelated JSON shapes', () => {
    expect(looksLikeSave(null)).toBe(false);
    expect(looksLikeSave(undefined)).toBe(false);
    expect(looksLikeSave('just a string')).toBe(false);
    expect(looksLikeSave(42)).toBe(false);
    expect(looksLikeSave([1, 2, 3])).toBe(false);
    expect(looksLikeSave({ hello: 'world' })).toBe(false);
    expect(looksLikeSave({ rank: 5 })).toBe(false); // missing ducks/resources
    expect(looksLikeSave({ rank: 5, ducks: [] })).toBe(false); // missing resources
    expect(looksLikeSave({ rank: '5', ducks: [], resources: {} })).toBe(false); // rank not a number
    expect(looksLikeSave({ rank: 5, ducks: 'not an array', resources: {} })).toBe(false);
  });
});

describe('save export/import round-trip — a Winterstead + contract-rich state', () => {
  it('a full-game state with a winter assignment + an active contract round-trips identically', () => {
    const s = setHens(stockAll(fullSetup()), 4, FLAT_GENOME);
    s.zones.winterstead = { unlocked: true };
    s.legacyTier = 3;
    s.rank = 20;
    expect(placeStation(s, 'winterCoop', 0, 0, 'winterstead').ok).toBe(true);
    expect(placeStation(s, 'heater', 1, 0, 'winterstead').ok).toBe(true);
    expect(assignToWinter(s, s.ducks[0].id).ok).toBe(true);

    s.contracts.active = {
      id: 'ct-roundtrip',
      type: 'provision',
      notch: 1,
      reward: { dust: 10, shards: 2 },
      completed: false,
      ingredient: 'corn',
      amount: 500,
      limitRemaining: 999,
    } as ProvisionContract;

    // Exercise the ACTUAL import path: JSON.parse -> looksLikeSave -> deserialize.
    const json = serialize(s);
    const parsed: unknown = JSON.parse(json);
    expect(looksLikeSave(parsed)).toBe(true);
    const r = deserialize(json, Date.now());

    expect(r.zones.winterstead?.unlocked).toBe(true);
    expect(r.ducks.find((d) => d.id === s.ducks[0].id)?.site).toBe('winter');
    expect(r.stations.find((st) => st.type === 'winterCoop' && st.zoneId === 'winterstead')).toBeDefined();
    expect(r.stations.find((st) => st.type === 'heater' && st.zoneId === 'winterstead')).toBeDefined();
    expect(r.legacyTier).toBe(3);
    expect(r.rank).toBe(20);
    expect(r.contracts.active).toEqual(s.contracts.active);
    // Full identity check on the pieces that matter most to a returning player.
    expect(r.ducks).toEqual(s.ducks);
    expect(r.resources).toEqual(s.resources);
  });
});

describe('garbage input is rejected without touching the live state', () => {
  it('malformed JSON fails at JSON.parse, before looksLikeSave or deserialize ever run', () => {
    expect(() => JSON.parse('{not valid json')).toThrow();
  });

  it('well-formed but unrelated JSON is caught by looksLikeSave, never reaching deserialize', () => {
    const garbage = { some: 'random', totally: ['unrelated', 'json'] };
    expect(looksLikeSave(garbage)).toBe(false);
    // BackupControls.onFile checks looksLikeSave BEFORE calling deserialize or
    // engine.importState — a real import UI never lets this reach the live state.
  });

  it('unparseable JSON text falls back to newGame() (a seeded starter flock)', () => {
    expect(() => deserialize('{not valid json at all', 0)).not.toThrow();
    const r = deserialize('{not valid json at all', 0);
    expect(r.ducks.length).toBeGreaterThan(0);
  });

  it('well-formed but unrelated JSON quietly merges into an EMPTY homestead — deserialize alone would make garbage LOOK like a successful import, which is exactly why looksLikeSave gates it first', () => {
    expect(() => deserialize('{"some":"random json"}', 0)).not.toThrow();
    const r = deserialize('{"some":"random json"}', 0);
    expect(r.ducks.length).toBe(0);
    expect(r.stations.length).toBe(0);
    expect(looksLikeSave({ some: 'random json' })).toBe(false); // caught before this ever runs
  });
});
