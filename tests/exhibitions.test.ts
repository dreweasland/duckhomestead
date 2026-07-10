import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { assignToPost } from '../src/game/actions';
import {
  claimContract,
  exhibitionBench,
  generateOffer,
  presentExhibition,
} from '../src/game/contracts';
import { deserialize, serialize } from '../src/game/save';
import { initialState, type Duck, type ExhibitionContract, type GameState, type Genome, type Genotype } from '../src/game/state';
import { genome, FLAT_GENOME } from './helpers';

const C = BALANCE.CONTRACTS;
const E = C.EXHIBITION;

/** A Grange-era flock: tier 1+, posts unlocked, n adult ducks of one color. */
function flock(n: number, g: Genome = FLAT_GENOME, genotype: Genotype = ['Bl', 'bl']): GameState {
  const s = initialState(0);
  s.rank = BALANCE.POSTS.INTRO_RANK;
  s.legacyTier = C.UNLOCK_TIER;
  s.dexSeen = ['blue'];
  s.ducks = Array.from({ length: n }, (_, i): Duck => ({
    id: `d${i}`,
    genotype: [...genotype] as Genotype,
    genome: [...g],
    genomeKnown: true,
    sex: i % 2 === 0 ? 'hen' : 'drake',
    stage: 'adult',
    ageTicks: 0,
  }));
  return s;
}

/** An active exhibition for `entries` blue ducks against the given target. */
function withExhibition(s: GameState, entries: number, target: Genome): ExhibitionContract {
  const c: ExhibitionContract = {
    id: 'ct1',
    type: 'exhibition',
    notch: entries - 1,
    reward: { dust: 100, shards: 10 },
    completed: false,
    color: 'blue',
    entries,
    target,
  };
  s.contracts.active = c;
  return c;
}

describe('the show post (9d): Grange-gated exhibition stock', () => {
  it('needs legacy tier 1 — the Grange runs the shows', () => {
    const s = flock(2);
    s.legacyTier = 0;
    expect(assignToPost(s, 'd0', 'show').ok).toBe(false);
    s.legacyTier = 1;
    expect(assignToPost(s, 'd0', 'show').ok).toBe(true);
  });
});

describe('exhibitions: present the bench, judged in place, ducks come home', () => {
  it('requires the full bench of the right color, healthy, on the post', () => {
    const s = flock(4);
    const c = withExhibition(s, 2, genome('LLLLLL'));
    expect(presentExhibition(s).ok).toBe(false); // nobody posted
    assignToPost(s, 'd0', 'show');
    expect(presentExhibition(s).ok).toBe(false); // 1 of 2
    assignToPost(s, 'd2', 'show');
    s.ducks[2].wounded = true;
    expect(presentExhibition(s).ok).toBe(false); // a wounded duck shows nothing
    s.ducks[2].wounded = false;
    expect(presentExhibition(s).ok).toBe(true);
    expect(c.completed).toBe(true);
    expect(s.ducks).toHaveLength(4); // nothing handed over
  });

  it('judging scales the reward: a flawless bench in fine condition pays SCALE_MAX', () => {
    const s = flock(4, genome('LLLLLL'));
    s.condition = BALANCE.NUTRITION.CONDITION_MAX;
    const c = withExhibition(s, 2, genome('LLLLLL'));
    assignToPost(s, 'd0', 'show');
    assignToPost(s, 'd2', 'show');
    const r = presentExhibition(s);
    expect(r.ok && r.value.score).toBeCloseTo(1, 6);
    expect(c.reward.dust).toBe(Math.round(100 * E.SCALE_MAX));
    // …and the claim pays the judged amount.
    const before = s.dust;
    expect(claimContract(s).ok).toBe(true);
    expect(s.dust).toBe(before + Math.round(100 * E.SCALE_MAX));
  });

  it('junk in the right feathers pays the floor, not nothing', () => {
    const s = flock(4, FLAT_GENOME); // all-Dud: quality 0
    s.condition = 0;
    const c = withExhibition(s, 1, genome('LLLLLL'));
    assignToPost(s, 'd0', 'show');
    const r = presentExhibition(s);
    expect(r.ok && r.value.scale).toBeCloseTo(E.SCALE_MIN, 6);
    expect(c.reward.dust).toBe(Math.round(100 * E.SCALE_MIN));
  });

  it('only the posts era offers exhibitions; they survive a save round-trip', () => {
    const early = initialState(0);
    early.legacyTier = 1;
    early.rank = BALANCE.POSTS.INTRO_RANK - 1;
    for (let i = 0; i < 40; i++) expect(generateOffer(early).type).not.toBe('exhibition');

    const s = flock(2);
    withExhibition(s, 1, genome('LLLLLL'));
    const back = deserialize(serialize(s), 0);
    expect(back.contracts.active?.type).toBe('exhibition');
  });
});

describe('seasonal provisions (9d): the board leans on the year', () => {
  it('marks + pays the premium when the scarce ingredient is picked', () => {
    // Deterministic: rng path in generateProvision → seasonal roll first.
    const s = flock(2);
    s.rank = Math.max(s.rank, BALANCE.SEASONS.INTRO_RANK);
    s.season.index = 3; // winter → scarce corn
    // Fake a corn production rate so provision candidates include corn:
    s.stations.push({ id: 's1', type: 'plot', x: 0, y: 0, zoneId: 'yard', level: 1, cycleProgress: 0, buffer: {}, tendCooldownRemaining: 0, modules: [] });
    // Scripted rng: notch roll 0.0 → notch 0; type roll 0.6 (×4 weight → 2.4)
    // walks order→defense→PROVISION; then the seasonal roll 0.0 hits.
    let calls = 0;
    const rig = () => (++calls === 2 ? 0.6 : 0.0);
    const o = generateOffer(s, rig);
    expect(o.type).toBe('provision');
    if (o.type !== 'provision') return;
    expect(o.ingredient).toBe('corn'); // winter's scarce line
    expect(o.seasonal).toBe(true);
    // The premium is baked into the rolled reward (dust band min × mult).
    const baseMin = C.REWARD_BY_NOTCH[0].dust[0] * C.TYPE_REWARD_MULT.provision;
    expect(o.reward.dust).toBe(Math.round(Math.round(baseMin) * C.PROVISION.SEASONAL_REWARD_MULT));
  });
});
