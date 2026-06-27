import { describe, it, expect } from 'vitest';
import { build, fullSetup, run, setHens } from './helpers';

// Guards the tuned feel so a future balance tweak can't silently break the
// early-game shape. These assert *shape*, not exact numbers, to stay robust.
describe('nutrition balance shape', () => {
  it('one of each ingredient station feeds one adult layer fully green (Phase 2 equiv)', () => {
    const s = setHens(fullSetup(), 1); // 1 adult == Phase 2's single coop
    run(s, 600); // let stock + condition settle from real production
    for (const a of ['energy', 'protein', 'niacin', 'calcium'] as const) {
      expect(s.nutrition!.satisfaction[a]).toBeGreaterThanOrEqual(1);
    }
    expect(s.nutrition!.eggMult).toBeGreaterThan(0.95);
  });

  it('a bare starter is throttled but never fully softlocked', () => {
    const s = build({ plot: 1, mill: 1, coop: 1 });
    run(s, 600);
    const before = s.resources.eggs;
    run(s, 60);
    expect(s.resources.eggs - before).toBeGreaterThan(0); // still earning
    expect(s.nutrition!.eggMult).toBeLessThan(0.95); // but clearly throttled
  });

  it('mills scale with coops: two coops on one mill are throttled vs two mills', () => {
    const oneMill = build({ plot: 2, peaPatch: 2, mealwormFarm: 2, yeastVat: 2, oysterSource: 2, mill: 1, coop: 2 });
    const twoMills = build({ plot: 2, peaPatch: 2, mealwormFarm: 2, yeastVat: 2, oysterSource: 2, mill: 2, coop: 2 });
    run(oneMill, 600);
    run(twoMills, 600);
    expect(twoMills.nutrition!.eggMult).toBeGreaterThan(oneMill.nutrition!.eggMult + 0.2);
  });
});
