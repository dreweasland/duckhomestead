import { describe, it, expect } from 'vitest';
import { resourceFlow } from '../src/game/actions';
import { INGREDIENTS, type Resource } from '../src/game/state';
import { build, fullSetup, run, setHens, stockAll } from './helpers';

/** Total feed outflow across all blendable ingredients (units/sec). */
const totalOut = (s: ReturnType<typeof fullSetup>) =>
  INGREDIENTS.reduce((a, ing) => a + resourceFlow(s, ing as Resource).out, 0);

describe('resourceFlow — currency in/out breakdown', () => {
  it('eggs: income from the flock, no feed outflow', () => {
    const s = stockAll(setHens(fullSetup(), 2));
    run(s, 5); // let the nutrition snapshot (egg rate) settle
    const eggs = resourceFlow(s, 'eggs');
    expect(eggs.in).toBeGreaterThan(0); // hens are laying
    expect(eggs.out).toBe(0); // eggs are spent discretionarily, not by feed
  });

  it('corn: produced by the plot (income > 0)', () => {
    const s = stockAll(setHens(fullSetup(), 2));
    run(s, 5);
    expect(resourceFlow(s, 'corn').in).toBeGreaterThan(0);
  });

  it('a fed flock draws ingredients (some feed outflow > 0)', () => {
    const s = stockAll(setHens(fullSetup(), 2));
    run(s, 5);
    expect(totalOut(s)).toBeGreaterThan(0);
  });

  it('no mill ⇒ no feed blend ⇒ zero ingredient outflow', () => {
    // Producers + a coop + hens, but no mill: nothing gets blended (feedScale 0).
    const s = stockAll(
      setHens(build({ plot: 1, peaPatch: 1, mealwormFarm: 1, yeastVat: 1, oysterSource: 1, coop: 1 }), 2),
    );
    run(s, 5);
    expect(totalOut(s)).toBe(0);
  });
});
