import { describe, it, expect } from 'vitest';
import { ZONE_DEFS } from '../src/config/balance';
import { placeStation } from '../src/game/actions';
import { serialize, deserialize } from '../src/game/save';
import { coopCapacity, zoneUnlocked } from '../src/game/state';
import { build, stockAll, run } from './helpers';

describe('zone model', () => {
  it('Yard is zone 0 and always unlocked; gated zones start locked', () => {
    const s = build({});
    expect(zoneUnlocked(s, 'yard')).toBe(true);
    expect(zoneUnlocked(s, 'backPasture')).toBe(false);
    // The defs are data-driven: a zone is unlocked-at-start iff it has no gate.
    for (const z of ZONE_DEFS) {
      expect(zoneUnlocked(s, z.id)).toBe(!z.unlock);
    }
  });

  it('refuses to build in a locked zone; allows it once unlocked', () => {
    const s = build({});
    expect(placeStation(s, 'coop', 0, 0, 'pond').ok).toBe(false); // locked
    s.zones.pond.unlocked = true;
    expect(placeStation(s, 'coop', 0, 0, 'pond').ok).toBe(true);
  });

  it('bounds placement to the zone’s own grid', () => {
    const s = build({});
    s.zones.pond.unlocked = true;
    const g = ZONE_DEFS.find((z) => z.id === 'pond')!.grid;
    expect(placeStation(s, 'plot', g.width, 0, 'pond').ok).toBe(false); // out of bounds
    expect(placeStation(s, 'plot', g.width - 1, g.height - 1, 'pond').ok).toBe(true);
  });

  it('build-zone coops add housing and lay into the ONE shared storage', () => {
    // Yard has the feed chain; the coop lives in the pond zone (housing relief).
    const s = build({ plot: 1, mill: 1 });
    s.zones.pond.unlocked = true;
    expect(placeStation(s, 'coop', 0, 0, 'pond').ok).toBe(true);
    expect(coopCapacity(s)).toBeGreaterThan(0); // counts coops across zones
    expect(s.ducks.length).toBeGreaterThan(0); // first coop seeded the flock
    stockAll(s);
    const before = s.resources.eggs;
    run(s, 60);
    expect(s.resources.eggs).toBeGreaterThan(before); // shared storage filled
  });

  it('the pasture is an irrigation farm, not build space (rejects placement)', () => {
    const s = build({});
    s.zones.backPasture.unlocked = true;
    expect(placeStation(s, 'coop', 0, 0, 'backPasture').ok).toBe(false);
  });
});

describe('save back-compat', () => {
  it('round-trips zones + station zoneId', () => {
    const s = build({ plot: 1 });
    s.zones.pond.unlocked = true;
    placeStation(s, 'coop', 0, 0, 'pond'); // (0,0) is shore, outside the water region
    const r = deserialize(serialize(s), 0);
    expect(r.zones.pond.unlocked).toBe(true);
    expect(r.stations.find((st) => st.type === 'coop')?.zoneId).toBe('pond');
  });

  it('defaults a pre-4b save to Yard-only, stations in the Yard', () => {
    // A save from before zones existed: stations with no zoneId, no zones map.
    const legacy = JSON.stringify({
      stations: [{ id: 's1', type: 'coop', x: 0, y: 0, level: 1, buffer: {} }],
      resources: { eggs: 5 },
    });
    const r = deserialize(legacy, 0);
    expect(r.zones.yard.unlocked).toBe(true);
    expect(r.zones.backPasture.unlocked).toBe(false);
    expect(r.stations[0].zoneId).toBe('yard');
    expect(r.resources.forage).toBe(0); // new resource defaulted
  });
});
