import { describe, it, expect } from 'vitest';
import { BALANCE, playstylePreset } from '../src/config/balance';
import { rackSockets, type Module, type ModuleStat } from '../src/game/state';
import {
  installModule,
  uninstallModule,
  swapInModule,
  autoFillRack,
  bulkSalvageByTier,
} from '../src/game/actions';
import {
  spareOutlook,
  rackBonus,
  installMarginal,
  moduleContribution,
  rackScore,
  activeStatWeights,
} from '../src/game/loot';
import { build } from './helpers';

let id = 0;
const mod = (stat: ModuleStat, rarity: Module['rarity'], magnitude: number): Module => ({
  id: `r${id++}`,
  stat,
  rarity,
  magnitude,
});

describe('rack sockets grow with rank (capped)', () => {
  it('starts at baseSockets and steps up, never past maxSockets', () => {
    const R = BALANCE.LOOT.RACK;
    const s = build({});
    s.rank = 1;
    expect(rackSockets(s)).toBe(R.baseSockets);
    s.rank = 1 + R.ranksPerSocket;
    expect(rackSockets(s)).toBe(R.baseSockets + 1);
    // The rank curve tops out at maxSockets…
    s.rank = R.bonusSocketRank - 1;
    expect(rackSockets(s)).toBe(R.maxSockets);
    // …and the rank-30 milestone grants ONE more (the ladder's power beat).
    s.rank = 1000;
    expect(rackSockets(s)).toBe(R.maxSockets + 1);
  });
});

describe('global effect: one installed module covers its whole category', () => {
  it('a single rack module sets the homestead-wide bonus for its stat', () => {
    const s = build({ plot: 1, peaPatch: 1 });
    s.inventory.push(mod('stationSpeed', 'epic', 0.3));
    installModule(s, s.inventory[0].id);
    expect(rackBonus(s, 'stationSpeed')).toBeGreaterThan(0);
    // It isn't tied to any one station — it's a homestead value.
    expect(rackBonus(s, 'stationYield')).toBe(0);
  });
});

describe('Auto-fill optimizer', () => {
  it('fills every socket with the highest-value spares, leaving the weakest out', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    const egg = mod('eggOutput', 'legendary', 0.5); // highest value×magnitude
    const yield_ = mod('stationYield', 'epic', 0.3);
    const speed = mod('stationSpeed', 'rare', 0.2);
    const weak = mod('tendCooldown', 'common', 0.08); // lowest value×magnitude
    s.inventory.push(weak, speed, yield_, egg);

    const r = autoFillRack(s);
    expect(r.ok).toBe(true);
    expect(s.rack).toHaveLength(3);
    expect(s.inventory.map((m) => m.id)).toEqual([weak.id]); // the dud stays a spare
    expect(s.rack.map((m) => m.stat).sort()).toEqual(['eggOutput', 'stationSpeed', 'stationYield']);
  });

  it('diversifies across stats rather than overstacking one (soft cap)', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    // Four speed modules + one egg module: a sane optimizer takes the egg over a
    // 3rd speed (diminishing returns on a single stat).
    for (let i = 0; i < 4; i++) s.inventory.push(mod('stationSpeed', 'rare', 0.2));
    s.inventory.push(mod('eggOutput', 'rare', 0.2));
    autoFillRack(s);
    expect(s.rack.some((m) => m.stat === 'eggOutput')).toBe(true);
  });

  it('makes strictly-improving swaps when the rack is already full', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    // Rack full of weak modules; a strong spare should swap in.
    for (let i = 0; i < 3; i++) s.rack.push(mod('tendCooldown', 'common', 0.06));
    const strong = mod('eggOutput', 'legendary', 0.5);
    s.inventory.push(strong);
    const r = autoFillRack(s);
    expect(r.ok && r.value.swapped).toBeGreaterThan(0);
    expect(s.rack.some((m) => m.id === strong.id)).toBe(true);
    expect(s.rack).toHaveLength(3);
    expect(s.inventory.some((m) => m.stat === 'tendCooldown')).toBe(true); // the dud got bumped
  });
});

describe('playstyle weights steer Auto-fill', () => {
  // 3 sockets, 5 spares: two strong tend legendaries + three modest production
  // modules. Which three make the cut depends entirely on the active weights.
  const loadout = (s: ReturnType<typeof build>) => {
    s.rank = 1; // 3 sockets
    s.inventory.push(
      mod('tendPower', 'legendary', 0.5),
      mod('tendCooldown', 'legendary', 0.5),
      mod('stationSpeed', 'rare', 0.2),
      mod('stationYield', 'rare', 0.2),
      mod('eggOutput', 'rare', 0.2),
    );
  };
  const hasTend = (s: ReturnType<typeof build>) =>
    s.rack.some((m) => m.stat === 'tendPower' || m.stat === 'tendCooldown');

  it('Idle/AFK (tend weights 0) keeps tend modules OUT, favoring production', () => {
    const s = build({});
    loadout(s);
    s.statWeights = { ...playstylePreset('idle')!.weights } as Record<ModuleStat, number>;
    autoFillRack(s);
    expect(s.rack).toHaveLength(3);
    expect(hasTend(s)).toBe(false);
  });

  it('Balanced values the strong tend legendaries enough to install them', () => {
    const s = build({});
    loadout(s);
    s.statWeights = { ...playstylePreset('balanced')!.weights } as Record<ModuleStat, number>;
    autoFillRack(s);
    expect(hasTend(s)).toBe(true);
  });
});

describe('bulk salvage by tier', () => {
  it('salvages every spare of one rarity for dust, leaving the rest', () => {
    const s = build({});
    s.dust = 0;
    s.inventory.push(
      mod('eggOutput', 'common', 0.08),
      mod('stationSpeed', 'common', 0.07),
      mod('stationYield', 'rare', 0.2),
    );
    const r = bulkSalvageByTier(s, 'common');
    expect(r.ok && r.value.count).toBe(2);
    expect(s.inventory).toHaveLength(1);
    expect(s.inventory[0].rarity).toBe('rare');
    expect(s.dust).toBeGreaterThan(0);
  });

  it('fails when there are no spares of that tier (and touches nothing)', () => {
    const s = build({});
    s.inventory.push(mod('eggOutput', 'rare', 0.2));
    expect(bulkSalvageByTier(s, 'legendary').ok).toBe(false);
    expect(s.inventory).toHaveLength(1);
  });
});

describe('install / swap / uninstall flow + outlook', () => {
  it('spareOutlook: install (free socket), upgrade/potential/none when full', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    const a = mod('eggOutput', 'rare', 0.2);
    s.inventory.push(a);
    expect(spareOutlook(s, a).kind).toBe('install');

    // Full rack of weak commons.
    s.rack = [
      mod('stationSpeed', 'common', 0.06),
      mod('stationYield', 'common', 0.06),
      mod('eggOutput', 'common', 0.06),
    ];
    const strong = mod('eggOutput', 'legendary', 0.5);
    expect(spareOutlook(s, strong).kind).toBe('upgrade'); // beats a weak installed now

    // A common that can't win now but whose band ceiling (0.10 > 0.06) could -> potential.
    const rerollable = mod('stationSpeed', 'common', 0.05);
    expect(spareOutlook(s, rerollable).kind).toBe('potential');

    // Against a maxed-legendary rack, a common is dominated for good -> none.
    s.rack = [
      mod('stationSpeed', 'legendary', 0.5),
      mod('stationYield', 'legendary', 0.5),
      mod('eggOutput', 'legendary', 0.5),
    ];
    expect(spareOutlook(s, rerollable).kind).toBe('none');
  });

  it('swapInModule installs into a free socket, then swaps in once full', () => {
    const s = build({});
    s.rank = 1; // 3 sockets
    const m1 = mod('stationSpeed', 'rare', 0.2);
    s.inventory.push(m1);
    expect(swapInModule(s, m1.id).ok).toBe(true);
    expect(s.rack).toHaveLength(1); // free socket -> plain install

    // Fill the rest with weak ones, then swap a strong module in.
    s.rack.push(mod('tendCooldown', 'common', 0.06), mod('tendCooldown', 'common', 0.06));
    const strong = mod('eggOutput', 'legendary', 0.5);
    s.inventory.push(strong);
    expect(swapInModule(s, strong.id).ok).toBe(true);
    expect(s.rack.some((m) => m.id === strong.id)).toBe(true);
    expect(s.rack).toHaveLength(3);
  });

  it('uninstall frees a socket and returns the module to spares', () => {
    const s = build({});
    const m = mod('eggOutput', 'rare', 0.2);
    s.inventory.push(m);
    installModule(s, m.id);
    expect(s.rack).toHaveLength(1);
    expect(uninstallModule(s, m.id).ok).toBe(true);
    expect(s.rack).toHaveLength(0);
    expect(s.inventory.some((x) => x.id === m.id)).toBe(true);
  });
});

// The marginal-value math behind the Auto-fill optimizer + the spare "upgrade?" hints.
describe('marginal scoring: installMarginal / moduleContribution / rackScore', () => {
  it('a lone installed module contributes its full applied bonus (== the rack bonus)', () => {
    const s = build({ plot: 1 });
    const m = mod('stationYield', 'rare', 0.2);
    s.rack = [m];
    // Only module of its stat, so removing it drops the whole bonus to 0.
    expect(moduleContribution(s, m)).toBeCloseTo(rackBonus(s, 'stationYield'), 10);
    expect(moduleContribution(s, m)).toBeGreaterThan(0);
  });

  it('KEY INVARIANT: a spare gains exactly what it will then contribute once installed', () => {
    const s = build({ plot: 1 });
    s.rack = [mod('stationYield', 'common', 0.1)];
    const spare = mod('stationYield', 'epic', 0.3);
    const predictedGain = installMarginal(s, spare);
    s.rack = [...s.rack, spare]; // install it
    // The delta the optimizer used to decide === the delta it now actually holds.
    expect(moduleContribution(s, spare)).toBeCloseTo(predictedGain, 10);
  });

  it('marginal value diminishes as the same stat stacks (soft cap)', () => {
    const s = build({ plot: 1 });
    const spare = mod('stationYield', 'rare', 0.2);
    s.rack = [];
    const first = installMarginal(s, spare); // into an empty rack
    s.rack = [mod('stationYield', 'rare', 0.2), mod('stationYield', 'rare', 0.2)];
    const later = installMarginal(s, spare); // onto an already-stacked stat
    expect(later).toBeLessThan(first);
    expect(later).toBeGreaterThan(0);
  });

  it('marginal value is independent of OTHER stats in the rack', () => {
    const s = build({ plot: 1 });
    const spare = mod('stationYield', 'rare', 0.2);
    s.rack = [];
    const alone = installMarginal(s, spare);
    s.rack = [mod('stationSpeed', 'legendary', 0.4), mod('tendPower', 'epic', 0.3)];
    const withOtherStats = installMarginal(s, spare);
    expect(withOtherStats).toBeCloseTo(alone, 10);
  });

  it('rackScore rewards a strictly-stronger loadout; an empty rack scores 0', () => {
    const s = build({ plot: 1 });
    const w = activeStatWeights(s);
    expect(rackScore([], w)).toBe(0);
    expect(rackScore([mod('stationYield', 'legendary', 0.4)], w)).toBeGreaterThan(
      rackScore([mod('stationYield', 'common', 0.1)], w),
    );
  });
});
