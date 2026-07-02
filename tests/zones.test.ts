import { describe, it, expect } from 'vitest';
import { ZONE_DEFS } from '../src/config/balance';
import { placeStation } from '../src/game/actions';
import { serialize, deserialize } from '../src/game/save';
import { zoneUnlocked } from '../src/game/state';
import { build } from './helpers';

describe('zone model', () => {
  it('Yard is zone 0 and always unlocked; gated zones start locked', () => {
    const s = build({});
    expect(zoneUnlocked(s, 'yard')).toBe(true);
    expect(zoneUnlocked(s, 'pond')).toBe(false);
    expect(zoneUnlocked(s, 'backPasture')).toBe(false); // Waterworks
    // The defs are data-driven: a zone is unlocked-at-start iff it has no gate.
    for (const z of ZONE_DEFS) {
      expect(zoneUnlocked(s, z.id)).toBe(!z.unlock);
    }
  });

  it('refuses to build in a locked zone', () => {
    const s = build({});
    expect(placeStation(s, 'coop', 0, 0, 'pond').ok).toBe(false); // locked
  });

  it('the water canvases are puzzle surfaces, not build space (reject placement even unlocked)', () => {
    const s = build({});
    s.zones.pond.unlocked = true; // The Pond (layout)
    s.zones.backPasture.unlocked = true; // Waterworks (circulation)
    expect(placeStation(s, 'coop', 0, 0, 'pond').ok).toBe(false);
    expect(placeStation(s, 'coop', 0, 0, 'backPasture').ok).toBe(false);
    // Generic build space is retired as a zone reward — the only build boards are
    // the Yard and (6d) Winterstead, whose space is PURPOSEFUL: station-gated via
    // allowedStations and carrying the warmth layout puzzle, not generic tiles.
    const buildZones = ZONE_DEFS.filter((z) => !z.pondLayout && !z.waterworks);
    expect(buildZones.map((z) => z.id)).toEqual(['yard', 'winterstead']);
    expect(buildZones.find((z) => z.id === 'winterstead')?.allowedStations?.length).toBeGreaterThan(0);
  });

  it('builds within the Yard (the one build zone) and bounds to its grid', () => {
    const s = build({});
    const g = ZONE_DEFS.find((z) => z.id === 'yard')!.grid;
    expect(placeStation(s, 'plot', g.width, 0, 'yard').ok).toBe(false); // out of bounds
    expect(placeStation(s, 'plot', 0, 0, 'yard').ok).toBe(true);
  });
});

describe('save back-compat', () => {
  it('round-trips zone unlock state + station zoneId', () => {
    const s = build({ plot: 1 });
    s.zones.pond.unlocked = true;
    const r = deserialize(serialize(s), 0);
    expect(r.zones.pond.unlocked).toBe(true);
    expect(r.stations.find((st) => st.type === 'plot')?.zoneId).toBe('yard');
  });

  it('defaults a pre-zones save to Yard-only, stations in the Yard', () => {
    // A save from before zones existed: stations with no zoneId, no zones map.
    const legacy = JSON.stringify({
      stations: [{ id: 's1', type: 'coop', x: 0, y: 0, level: 1, buffer: {} }],
      resources: { eggs: 5 },
    });
    const r = deserialize(legacy, 0);
    expect(r.zones.yard.unlocked).toBe(true);
    expect(r.zones.pond.unlocked).toBe(false);
    expect(r.zones.backPasture.unlocked).toBe(false);
    expect(r.stations[0].zoneId).toBe('yard');
    expect(r.pond).toEqual({ features: [], flow: [], freshness: {} }); // water system starts empty
  });
});
