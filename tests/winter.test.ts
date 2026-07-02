import { describe, it, expect } from 'vitest';
import { BALANCE, EXCLUSIVE_STATIONS, ZONE_DEFS } from '../src/config/balance';
import { placeStation, unlockZone, upgradeStation } from '../src/game/actions';
import { prestigeReset } from '../src/game/prestige';
import { deserialize, serialize } from '../src/game/save';
import { initialState, zoneUnlocked, type GameState } from '../src/game/state';
import { build, fullSetup, run } from './helpers';

const W = BALANCE.WINTER;

/** A state with Winterstead unlocked (bypassing the gates — they're tested separately). */
function withWinter(s: GameState = build({})): GameState {
  s.zones.winterstead = { unlocked: true };
  s.resources.eggs = 1_000_000;
  return s;
}

describe('Winterstead — the triple-gated unlock (Phase 6d Step 1)', () => {
  it('is gated on legacy tier FIRST, then rank, then eggs', () => {
    const s = initialState(0);
    s.resources.eggs = W.UNLOCK.eggCost + 1;
    s.rank = W.UNLOCK.rankRequired;

    s.legacyTier = W.UNLOCK.minLegacyTier - 1;
    const tierFail = unlockZone(s, 'winterstead');
    expect(tierFail.ok).toBe(false);
    if (!tierFail.ok) expect(tierFail.reason).toContain('Legacy Tier');

    s.legacyTier = W.UNLOCK.minLegacyTier;
    s.rank = W.UNLOCK.rankRequired - 1;
    const rankFail = unlockZone(s, 'winterstead');
    expect(rankFail.ok).toBe(false);
    if (!rankFail.ok) expect(rankFail.reason).toContain('Rank');

    s.rank = W.UNLOCK.rankRequired;
    s.resources.eggs = W.UNLOCK.eggCost - 1;
    expect(unlockZone(s, 'winterstead').ok).toBe(false);

    s.resources.eggs = W.UNLOCK.eggCost;
    expect(unlockZone(s, 'winterstead').ok).toBe(true);
    expect(zoneUnlocked(s, 'winterstead')).toBe(true);
    expect(s.resources.eggs).toBe(0); // the sink sank
  });

  it('prestige re-locks Winterstead like every zone', () => {
    const s = withWinter();
    s.dexSeen = ['black', 'blue', 'splash'];
    const reset = prestigeReset(s, 0);
    expect(zoneUnlocked(reset, 'winterstead')).toBe(false);
  });
});

describe('zone-station compatibility (both directions)', () => {
  it('winter stations are zone-exclusive: the yard rejects them', () => {
    const s = withWinter();
    const r = placeStation(s, 'seedStore', 0, 0, 'yard');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Winterstead');
  });

  it('Winterstead rejects yard stations', () => {
    const s = withWinter();
    expect(placeStation(s, 'plot', 0, 0, 'winterstead').ok).toBe(false);
    expect(placeStation(s, 'coop', 1, 0, 'winterstead').ok).toBe(false);
  });

  it('Winterstead accepts exactly its allowed set', () => {
    const s = withWinter();
    const allowed = ZONE_DEFS.find((z) => z.id === 'winterstead')!.allowedStations!;
    allowed.forEach((t, i) => {
      expect(placeStation(s, t, i, 0, 'winterstead').ok).toBe(true);
    });
  });

  it('EXCLUSIVE_STATIONS derives from ZONE_DEFS (not hand-kept)', () => {
    for (const t of ['seedStore', 'fodderRack', 'winterCoop', 'heater', 'heatedWaterer'] as const) {
      expect(EXCLUSIVE_STATIONS.has(t)).toBe(true);
    }
    expect(EXCLUSIVE_STATIONS.has('plot')).toBe(false);
  });
});

describe('winter producers + infrastructure safety', () => {
  it('seed store + fodder rack produce the winter lines into SHARED storage', () => {
    const s = withWinter();
    placeStation(s, 'seedStore', 0, 0, 'winterstead');
    placeStation(s, 'fodderRack', 1, 0, 'winterstead');
    run(s, 30); // auto-haul on
    expect(s.resources.sunflowerSeeds).toBeGreaterThan(0);
    expect(s.resources.fodderSprouts).toBeGreaterThan(0);
  });

  it('zero-cycle infrastructure (heater/waterer) never cycles, never hangs the loop', () => {
    const s = withWinter();
    placeStation(s, 'heater', 0, 0, 'winterstead');
    placeStation(s, 'heatedWaterer', 1, 0, 'winterstead');
    run(s, 10);
    for (const st of s.stations.filter((x) => x.zoneId === 'winterstead')) {
      expect(Object.keys(st.buffer)).toHaveLength(0);
    }
  });

  it('a winter coop lays NOTHING via the generic producer path (the winter pool owns lay)', () => {
    const s = withWinter();
    placeStation(s, 'winterCoop', 0, 0, 'winterstead');
    const eggs0 = s.resources.eggs;
    run(s, 60);
    expect(s.resources.eggs).toBe(eggs0);
  });

  it('infrastructure does not upgrade; winter producers upgrade on the capped curve', () => {
    const s = withWinter();
    placeStation(s, 'winterCoop', 0, 0, 'winterstead');
    placeStation(s, 'seedStore', 1, 0, 'winterstead');
    const coop = s.stations.find((x) => x.type === 'winterCoop')!;
    const store = s.stations.find((x) => x.type === 'seedStore')!;
    expect(upgradeStation(s, coop.id).ok).toBe(false);
    expect(upgradeStation(s, store.id).ok).toBe(true);
    expect(store.level).toBe(2);
  });
});

describe('save round-trip + back-compat (the union-growth sweep)', () => {
  it('a pre-6d save (no winter resources/keys) loads with the new lines at 0', () => {
    const legacy = JSON.stringify({
      version: 1,
      resources: { corn: 5, eggs: 100 },
      ration: { corn: 2 },
      stations: [],
    });
    const r = deserialize(legacy, 0);
    expect(r.resources.sunflowerSeeds).toBe(0);
    expect(r.resources.fodderSprouts).toBe(0);
    expect(r.ration.sunflowerSeeds).toBe(0);
    expect(r.ration.fodderSprouts).toBe(0);
    expect(r.resources.corn).toBe(5); // old values intact
  });

  it('round-trips a live Winterstead (zone + stations + winter stock)', () => {
    const s = withWinter(fullSetup());
    placeStation(s, 'seedStore', 0, 0, 'winterstead');
    run(s, 10);
    const r = deserialize(serialize(s), 0);
    expect(zoneUnlocked(r, 'winterstead')).toBe(true);
    expect(r.stations.some((x) => x.type === 'seedStore' && x.zoneId === 'winterstead')).toBe(true);
    expect(r.resources.sunflowerSeeds).toBeCloseTo(s.resources.sunflowerSeeds, 6);
  });
});
