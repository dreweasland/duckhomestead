import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { assignToPost, cullDucks, createPair, recallFromPost, assignToWinter } from '../src/game/actions';
import {
  broodyMatureMult,
  forageRates,
  postCapacity,
  runForagers,
  sentryRepelChance,
  sentryWindupMult,
  validPost,
} from '../src/game/posts';
import { strikeWindupSec, runPredators } from '../src/game/predators';
import { deserialize, serialize } from '../src/game/save';
import { adultLayers, initialState, type Duck, type GameState, type Genome } from '../src/game/state';
import { runDrakeNutrition } from '../src/game/nutrition';
import { genome, FLAT_GENOME } from './helpers';

const P = BALANCE.POSTS;

/** A posts-ready flock: past the intro rank, n adults (alternating sex). */
function flock(n: number, g: Genome = FLAT_GENOME): GameState {
  const s = initialState(0);
  s.rank = P.INTRO_RANK;
  s.ducks = Array.from({ length: n }, (_, i): Duck => ({
    id: `d${i}`,
    genotype: ['Bl', 'bl'],
    genome: [...g],
    genomeKnown: true,
    sex: i % 2 === 0 ? 'hen' : 'drake',
    stage: 'adult',
    ageTicks: 0,
  }));
  return s;
}

describe('assignToPost gates (no silent unfairness)', () => {
  it('rank-gated, adults only, healthy only, unpaired only', () => {
    const s = flock(4);
    s.rank = P.INTRO_RANK - 1;
    expect(assignToPost(s, 'd0', 'forager').ok).toBe(false);
    s.rank = P.INTRO_RANK;
    s.ducks[0].stage = 'duckling';
    expect(assignToPost(s, 'd0', 'forager').ok).toBe(false);
    s.ducks[0].stage = 'adult';
    s.ducks[0].wounded = true;
    expect(assignToPost(s, 'd0', 'forager').ok).toBe(false);
    s.ducks[0].wounded = false;
    expect(createPair(s, 'd1', 'd0').ok).toBe(true);
    expect(assignToPost(s, 'd0', 'forager').ok).toBe(false); // paired
    expect(assignToPost(s, 'd2', 'forager').ok).toBe(true);
  });

  it('capacity binds per post; moving between posts is one action', () => {
    const s = flock(8);
    for (let i = 0; i < P.SLOTS.sentry; i++) {
      expect(assignToPost(s, `d${i}`, 'sentry').ok).toBe(true);
    }
    expect(assignToPost(s, `d${P.SLOTS.sentry}`, 'sentry').ok).toBe(false); // full
    // A slot-holder can move posts without a recall in between.
    expect(assignToPost(s, 'd0', 'forager').ok).toBe(true);
    expect(s.ducks[0].post).toBe('forager');
    expect(assignToPost(s, `d${P.SLOTS.sentry}`, 'sentry').ok).toBe(true); // freed
  });

  it('broody is hens-only; posts and Winterstead are mutually exclusive', () => {
    const s = flock(4);
    expect(assignToPost(s, 'd1', 'broody').ok).toBe(false); // drake
    expect(assignToPost(s, 'd0', 'broody').ok).toBe(true);
    // Posted hen can't winter; wintering hen can't post.
    s.zones['winterstead'] = { unlocked: true };
    s.stations.push({ id: 's1', type: 'winterCoop', x: 0, y: 0, zoneId: 'winterstead', level: 1, cycleProgress: 0, buffer: {}, tendCooldownRemaining: 0, modules: [] });
    expect(assignToWinter(s, 'd0').ok).toBe(false);
    expect(recallFromPost(s, 'd0').ok).toBe(true);
    expect(assignToWinter(s, 'd0').ok).toBe(true);
    expect(assignToPost(s, 'd0', 'broody').ok).toBe(false); // wintering
  });
});

describe('the post trade: no laying, eats the maintenance pool', () => {
  it('a posted hen leaves the laying population', () => {
    const s = flock(4);
    expect(adultLayers(s)).toHaveLength(2);
    assignToPost(s, 'd0', 'forager');
    expect(adultLayers(s)).toHaveLength(1);
  });

  it('posted workers join the drake pool head-count (fed even pre-breeding)', () => {
    const s = flock(4);
    s.drakeRation = { ...BALANCE.BREEDING.DEFAULT_DRAKE_RATION };
    s.resources.corn = 1000;
    //

    // No breeding established, nobody posted → the pool doesn't run at all.
    runDrakeNutrition(s, 1, 1);
    expect(s.drakeNutrition).toBeUndefined();
    assignToPost(s, 'd0', 'forager');
    runDrakeNutrition(s, 1, 1);
    expect(s.drakeNutrition?.drakeCount).toBe(1); // the worker eats her keep
  });
});

describe('SENTRY: the living watch', () => {
  const sentried = (g: Genome, n = 1): GameState => {
    const s = flock(8, g);
    for (let i = 0; i < n; i++) assignToPost(s, `d${i * 2}`, 'sentry');
    return s;
  };

  it('H-lines stretch dive wind-ups (capped); duds barely register', () => {
    const none = flock(4);
    const dud = sentried(FLAT_GENOME, 2);
    const hardy = sentried(genome('HHHHHH'), 2);
    expect(sentryWindupMult(none)).toBe(1);
    expect(sentryWindupMult(dud)).toBe(1); // H-score 0 → no effect
    expect(sentryWindupMult(hardy)).toBeCloseTo(1 + P.SENTRY.WINDUP_CAP, 6); // 2 × 0.25 → capped 0.5
    expect(strikeWindupSec(hardy)).toBeGreaterThan(strikeWindupSec(none));
  });

  it('repels a guard/offline attack that beat the floor (rig the rolls)', () => {
    const s = sentried(genome('HHHHHH'), 2);
    s.predatorsIntroduced = true;
    // One attack per window staggers to fire at 30s (duration/(n+1)) — park just shy.
    s.predators.owl = { timeToNextWindow: 0, windowRemaining: 60, windowElapsed: 29, attacksFired: 0, windowAttacks: 1 };
    const chance = sentryRepelChance(s);
    expect(chance).toBeCloseTo(Math.min(P.SENTRY.REPEL_CAP, 2 * P.SENTRY.REPEL_PER_SCORE), 6);
    // rng: success roll 0.1 (hits, floor 0), target pick 0.1, sentry roll 0.1 < chance → repelled.
    runPredators(s, 2, { mode: 'offline', rng: () => 0.1, lossBudget: { remaining: 5 } });
    expect(s.ducks.some((d) => d.wounded)).toBe(false);
    expect((s.pendingPredatorEvents ?? []).some((e) => e.kind === 'repelled')).toBe(true);
  });

  it('a wounded sentry stands down (contributes nothing until healed)', () => {
    const s = sentried(genome('HHHHHH'), 1);
    expect(sentryWindupMult(s)).toBeGreaterThan(1);
    s.ducks[0].wounded = true;
    expect(sentryWindupMult(s)).toBe(1);
  });
});

describe('FORAGER: a producer in duck form', () => {
  it('V-lines out-forage duds; output scales with the offline mult', () => {
    const dud = flock(4);
    assignToPost(dud, 'd0', 'forager');
    const vig = flock(4, genome('VVVVVV'));
    assignToPost(vig, 'd0', 'forager');
    const dudRate = forageRates(dud).peas;
    const vigRate = forageRates(vig).peas;
    expect(dudRate).toBeCloseTo(P.FORAGER.PEAS_PER_S * P.FORAGER.SCORE_FLOOR, 6);
    expect(vigRate).toBeCloseTo(P.FORAGER.PEAS_PER_S, 6);
    runForagers(vig, 100, 1);
    expect(vig.resources.peas).toBeCloseTo(vigRate * 100, 4);
    const off = flock(4, genome('VVVVVV'));
    assignToPost(off, 'd0', 'forager');
    runForagers(off, 100, BALANCE.OFFLINE_RATE_MULT);
    expect(off.resources.peas).toBeCloseTo(vigRate * 100 * BALANCE.OFFLINE_RATE_MULT, 4);
  });

  it('respects the Feed Store cap (a full line wastes the forage)', () => {
    const s = flock(4, genome('VVVVVV'));
    assignToPost(s, 'd0', 'forager');
    s.resources.peas = 500; // BASE_CAP
    runForagers(s, 1000, 1);
    expect(s.resources.peas).toBe(500);
  });
});

describe('BROODY: grow-out care', () => {
  it('scales with the V score, 1 with nobody posted', () => {
    const s = flock(4, genome('VVVVVV'));
    expect(broodyMatureMult(s)).toBe(1);
    assignToPost(s, 'd0', 'broody');
    expect(broodyMatureMult(s)).toBeCloseTo(1 + P.BROODY.MATURE_PER_SCORE, 6);
  });
});

describe('posted ducks are protected working assets', () => {
  it('bulk release never takes a posted duck', () => {
    const s = flock(4);
    assignToPost(s, 'd0', 'forager');
    const r = cullDucks(s, ['d0', 'd2']);
    expect(r.ok && r.value.released).toBe(1); // d2 only
    expect(s.ducks.find((d) => d.id === 'd0')).toBeDefined();
  });
});

describe('persistence', () => {
  it('posts survive a save round-trip; unknown post values load unposted', () => {
    const s = flock(4);
    assignToPost(s, 'd0', 'sentry');
    const back = deserialize(serialize(s), 0);
    expect(back.ducks[0].post).toBe('sentry');
    expect(validPost('mayor')).toBeUndefined();
    const tampered = JSON.parse(serialize(s));
    tampered.ducks[0].post = 'mayor';
    expect(deserialize(JSON.stringify(tampered), 0).ducks[0].post).toBeUndefined();
  });

  it('capacity constants stay sane', () => {
    expect(postCapacity('sentry')).toBeGreaterThan(0);
    expect(postCapacity('forager')).toBeGreaterThan(0);
    expect(postCapacity('broody')).toBeGreaterThan(0);
  });
});
