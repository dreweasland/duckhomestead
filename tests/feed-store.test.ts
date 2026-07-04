import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { placeStation, upgradeStation } from '../src/game/actions';
import { deserialize, serialize } from '../src/game/save';
import { addResource, ingredientCap, initialState, type GameState } from '../src/game/state';
import { build, run } from './helpers';

const S = BALANCE.STORAGE;

describe('THE FEED STORE: the last unbounded buffer gets a cap', () => {
  it('adds clamp at the cap; eggs (currency) are never capped', () => {
    const s = initialState(0);
    const cap = ingredientCap(s);
    addResource(s, 'corn', cap * 5);
    expect(s.resources.corn).toBe(cap);
    addResource(s, 'eggs', cap * 5);
    expect(s.resources.eggs).toBeGreaterThan(cap); // currency passes through
  });

  it('grandfathers over-cap legacy stock: never confiscated, never added to', () => {
    const s = initialState(0);
    s.resources.corn = ingredientCap(s) * 10; // a pre-Feed-Store mountain
    addResource(s, 'corn', 100);
    expect(s.resources.corn).toBe(ingredientCap(s) * 10); // no add…
    const r = deserialize(serialize(s), 0);
    expect(r.resources.corn).toBe(ingredientCap(s) * 10); // …and no confiscation on load
  });

  it('producers IDLE at a full store and resume the moment space frees', () => {
    const s = build({ plot: 1 });
    s.resources.corn = ingredientCap(s); // store full
    run(s, 30);
    expect(s.resources.corn).toBe(ingredientCap(s)); // no mountain
    expect(s.stations[0].buffer.corn ?? 0).toBe(0); // and no hidden buffer hoard
    s.resources.corn -= 10; // the flock eats some down
    run(s, 30);
    expect(s.resources.corn).toBe(ingredientCap(s)); // refilled to the cap — line was ready
  });

  it('silos are BUILDABLES: each placed silo adds capacity, upgrades ladder it', () => {
    const s = build({});
    s.resources.eggs = 1e9;
    const cap0 = ingredientCap(s);
    expect(placeStation(s, 'silo', 0, 3).ok).toBe(true);
    expect(ingredientCap(s)).toBe(cap0 + S.CAP_PER_SILO);
    const silo = s.stations.find((x) => x.type === 'silo')!;
    expect(upgradeStation(s, silo.id).ok).toBe(true);
    expect(ingredientCap(s)).toBe(
      cap0 + Math.round(S.CAP_PER_SILO * BALANCE.UPGRADE.outputMultPerLevel),
    );
  });

  it('a demolished silo lowers the cap; stranded stock is grandfathered, not confiscated', async () => {
    const { removeStation } = await import('../src/game/actions');
    const s = build({});
    s.resources.eggs = 1e9;
    placeStation(s, 'silo', 0, 3);
    const silo = s.stations.find((x) => x.type === 'silo')!;
    s.resources.corn = ingredientCap(s); // filled to the silo'd cap
    removeStation(s, silo.id);
    expect(s.resources.corn).toBeGreaterThan(ingredientCap(s)); // still there…
    addResource(s, 'corn', 100);
    expect(s.resources.corn).toBeGreaterThan(ingredientCap(s)); // …but no adds until it drains
  });
});
