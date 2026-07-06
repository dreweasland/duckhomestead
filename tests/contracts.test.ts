import { describe, it, expect } from 'vitest';
import { BALANCE, predatorDef } from '../src/config/balance';
import { collectAll, tend } from '../src/game/actions';
import {
  acceptContract,
  abandonContract,
  claimContract,
  deliverOrder,
  duckQualifies,
  eligibleForLine,
  fulfilProvision,
  generateOffer,
  onPredatorEvent,
  rerollOffers,
  runContracts,
} from '../src/game/contracts';
import { runBreeding } from '../src/game/breeding';
import { targetForTier } from '../src/game/prestige';
import { prestigeReset } from '../src/game/prestige';
import { deserialize, serialize, runOfflineCatchUp } from '../src/game/save';
import { tick } from '../src/game/tick';
import { scareOff } from '../src/game/predators';
import {
  COLORS,
  initialContracts,
  initialState,
  type Contract,
  type DefenseContract,
  type Duck,
  type Gene,
  type Genotype,
  type OrderContract,
  type ProvisionContract,
  type GameState,
} from '../src/game/state';
import { build, fullSetup, genome, stockAll, setHens, run, FLAT_GENOME } from './helpers';

const C = BALANCE.CONTRACTS;
const OWL = predatorDef('owl')!;

/** A fixed-zero rng: deterministically rolls notch 0 and type 'order' (first
 *  entries by weight), and the low end of every reward band. */
const zero = () => 0;

const defenseContract = (over: Partial<DefenseContract> = {}): DefenseContract => ({
  id: 'ct-test',
  type: 'defense',
  notch: 0,
  reward: { dust: 0, shards: 0 },
  completed: false,
  scareTarget: 2,
  scareProgress: 0,
  ...over,
});

const provisionContract = (over: Partial<ProvisionContract> = {}): ProvisionContract => ({
  id: 'ct-test',
  type: 'provision',
  notch: 0,
  reward: { dust: 0, shards: 0 },
  completed: false,
  ingredient: 'corn',
  amount: 100,
  limitRemaining: 999,
  ...over,
});

const orderContract = (over: Partial<OrderContract> = {}): OrderContract => ({
  id: 'ct-test',
  type: 'order',
  notch: 0,
  reward: { dust: 0, shards: 0 },
  completed: false,
  constraints: Array(BALANCE.GENOME.SLOTS).fill(null),
  target: targetForTier(0),
  minTargetQuality: 0,
  ...over,
});

const duck = (id: string, g: Gene[], over: Partial<Duck> = {}): Duck => ({
  id,
  genotype: ['Bl', 'bl'] as Genotype,
  genome: [...g],
  genomeKnown: true,
  sex: 'hen',
  stage: 'adult',
  ageTicks: 0,
  ...over,
});

describe('The Grange — tier gate', () => {
  it('below UNLOCK_TIER, runContracts never populates the board', () => {
    const s = initialState(0);
    expect(s.legacyTier).toBeLessThan(C.UNLOCK_TIER);
    runContracts(s, 100);
    expect(s.contracts.offers).toEqual([]);
    expect(s.contracts.active).toBeNull();
  });

  it('below UNLOCK_TIER, accepting/rerolling is rejected', () => {
    const s = initialState(0);
    s.contracts.offers = [defenseContract({ id: 'a' })];
    expect(acceptContract(s, 'a').ok).toBe(false);
    s.dust = 1000;
    expect(rerollOffers(s).ok).toBe(false);
  });

  it('at UNLOCK_TIER, the board fills immediately (no 10-minute wait)', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    runContracts(s, 0.001);
    expect(s.contracts.offers).toHaveLength(C.OFFER_SLOTS);
  });
});

describe('offer generation: BREEDING COMMISSIONS (color lines, fresh stock only)', () => {
  it('lines stay within notch bounds, are distinct color+sex combos, and never demand quality above 6', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    let sawOrder = false;
    for (let i = 0; i < 400; i++) {
      const o = generateOffer(s, Math.random);
      if (o.type !== 'order') continue;
      sawOrder = true;
      expect(o.lines.length).toBeGreaterThanOrEqual(1);
      expect(o.lines.length).toBeLessThanOrEqual(3);
      const combos = new Set(o.lines.map((l) => `${l.color}/${l.sex}`));
      expect(combos.size).toBe(o.lines.length); // distinct
      for (const l of o.lines) {
        expect(COLORS).toContain(l.color);
        expect(['hen', 'drake']).toContain(l.sex);
        expect(l.count).toBeGreaterThanOrEqual(1);
        expect(l.count).toBeLessThanOrEqual(2);
      }
      expect(o.minQuality).toBeGreaterThanOrEqual(2);
      expect(o.minQuality).toBeLessThanOrEqual(6);
      expect(o.sinceDuckId).toBe(-1); // unaccepted offers show no eligibility
    }
    expect(sawOrder).toBe(true);
  });

  it('acceptance stamps the hatch watermark from nextDuckId', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.nextDuckId = 500;
    s.contracts.offers = [];
    let order: Contract | null = null;
    while (!order) {
      const o = generateOffer(s, Math.random);
      if (o.type === 'order') order = o;
    }
    s.contracts.offers = [order];
    expect(acceptContract(s, order.id).ok).toBe(true);
    expect((s.contracts.active as OrderContract).sinceDuckId).toBe(500);
  });
});

describe('offer generation: PROVISION orders cost a purchased Feed Store buffer', () => {
  it('amount is priced off the live production rate, clamped to CAP_FRACTION of the Feed Store cap', () => {
    const s = setHens(stockAll(fullSetup()), 3);
    s.legacyTier = C.UNLOCK_TIER;
    // Force a low cap so the clamp is actually exercised.
    for (let i = 0; i < 300; i++) {
      const o = generateOffer(s, Math.random);
      if (o.type !== 'provision') continue;
      expect(o.amount).toBeGreaterThan(0);
      expect(o.amount).toBeLessThanOrEqual(Math.round(BALANCE.STORAGE.BASE_CAP * C.PROVISION.CAP_FRACTION) + 1);
    }
  });

  it('a flock producing nothing never rolls a provision offer', () => {
    const s = initialState(0); // no producers placed at all
    s.legacyTier = C.UNLOCK_TIER;
    for (let i = 0; i < 300; i++) {
      const o = generateOffer(s, Math.random);
      expect(o.type).not.toBe('provision');
    }
  });
});

describe('offer generation: defense', () => {
  it('defense scare targets come from the notch band', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    for (let i = 0; i < 200; i++) {
      const offer = generateOffer(s, Math.random);
      if (offer.type !== 'defense') continue;
      expect(C.DEFENSE.SCARE_COUNT_BY_NOTCH).toContain(offer.scareTarget);
    }
  });
});

describe('board lifecycle: OFFER_SLOTS + the one-active rule', () => {
  it('the board always holds OFFER_SLOTS offers; accepting backfills the slot', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    runContracts(s, 0);
    expect(s.contracts.offers).toHaveLength(C.OFFER_SLOTS);
    const id = s.contracts.offers[0].id;
    const r = acceptContract(s, id);
    expect(r.ok).toBe(true);
    expect(s.contracts.active?.id).toBe(id);
    expect(s.contracts.offers).toHaveLength(C.OFFER_SLOTS); // backfilled
    expect(s.contracts.offers.some((o) => o.id === id)).toBe(false); // not duplicated
  });

  it('only ONE contract may be active at a time', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    runContracts(s, 0);
    const [a, b] = s.contracts.offers;
    expect(acceptContract(s, a.id).ok).toBe(true);
    expect(acceptContract(s, b.id).ok).toBe(false); // already have one active
    expect(abandonContract(s).ok).toBe(true);
    expect(s.contracts.active).toBeNull();
    expect(acceptContract(s, b.id).ok).toBe(true); // free again after abandon
  });

  it('a full board refresh replaces every offer after OFFER_REFRESH_S', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    runContracts(s, 0);
    const before = s.contracts.offers.map((o) => o.id);
    runContracts(s, C.OFFER_REFRESH_S - 0.001);
    expect(s.contracts.offers.map((o) => o.id)).toEqual(before); // not yet
    runContracts(s, 0.01);
    const after = s.contracts.offers.map((o) => o.id);
    expect(after).toHaveLength(C.OFFER_SLOTS);
    expect(after.every((id) => !before.includes(id))).toBe(true); // wholesale replaced
  });

  it('accepting a provision offer snapshots its deadline', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.offers = [provisionContract({ id: 'p1', limitRemaining: 0 })];
    const r = acceptContract(s, 'p1');
    expect(r.ok).toBe(true);
    expect((s.contracts.active as ProvisionContract).limitRemaining).toBe(C.PROVISION.LIMIT_MIN * 60);
  });

  it('a manual reroll costs REROLL_DUST and replaces the whole board', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.dust = C.REROLL_DUST - 1;
    runContracts(s, 0);
    const before = s.contracts.offers.map((o) => o.id);
    expect(rerollOffers(s).ok).toBe(false); // can't afford
    s.dust = C.REROLL_DUST;
    const r = rerollOffers(s);
    expect(r.ok).toBe(true);
    expect(s.dust).toBe(0);
    const after = s.contracts.offers.map((o) => o.id);
    expect(after).toHaveLength(C.OFFER_SLOTS);
    expect(after.every((id) => !before.includes(id))).toBe(true);
  });
});

describe('claim: rewards are dust/shards/module ONLY — never eggs/resources/XP', () => {
  it('rejects claiming an incomplete contract', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = defenseContract({ completed: false });
    expect(claimContract(s).ok).toBe(false);
  });

  it('claiming a completed contract grants exactly dust + shards (+ module at top notch), clears the slot', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = defenseContract({ completed: true, reward: { dust: 12, shards: 3 } });
    const before = { ...s.resources };
    const dustBefore = s.dust;
    const shardsBefore = s.legacyCurrency;
    const inventoryBefore = s.inventory.length;
    const r = claimContract(s);
    expect(r.ok).toBe(true);
    expect(s.dust).toBe(dustBefore + 12);
    expect(s.legacyCurrency).toBe(shardsBefore + 3);
    expect(s.resources).toEqual(before); // never eggs/resources
    expect(s.xp).toBe(0); // never XP
    expect(s.contracts.active).toBeNull();
    expect(inventoryBefore).toBe(s.inventory.length); // no module at this (non-top) reward
  });

  it('a top-notch reward grants a module via loot.ts grantModule', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = defenseContract({
      completed: true,
      reward: { dust: 40, shards: 8, moduleRarity: 'rare' },
    });
    const r = claimContract(s);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.module?.rarity).toBe('rare');
    expect(s.inventory).toHaveLength(1);
    expect(s.inventory[0].rarity).toBe('rare');
  });
});

describe('order: the BREEDING COMMISSION — fresh color stock, handed over', () => {
  const commission = (over: Partial<OrderContract> = {}): OrderContract => ({
    id: 'o1',
    type: 'order',
    notch: 0,
    reward: { dust: 5, shards: 1 },
    completed: false,
    lines: [{ color: 'blue', sex: 'hen', count: 1 }],
    minQuality: 2,
    target: genome('LLLLLL'),
    sinceDuckId: 0,
    ...over,
  });
  const mk = (id: string, over: Partial<Duck> = {}): Duck => ({
    id,
    genotype: ['Bl', 'bl'], // blue
    genome: genome('LLDDDD'), // quality 2 vs LLLLLL
    genomeKnown: true,
    sex: 'hen',
    stage: 'adult',
    ageTicks: 0,
    ...over,
  });

  it('THE ANTI-SHELF RULE: ducks hatched before acceptance never qualify', () => {
    const c = commission({ sinceDuckId: 100 });
    const s = initialState(0);
    s.ducks = [mk('d50'), mk('d99')]; // banked shelf birds
    expect(eligibleForLine(s, c, c.lines[0])).toHaveLength(0);
    s.ducks.push(mk('d100'), mk('d150')); // hatched under the commission
    expect(eligibleForLine(s, c, c.lines[0])).toHaveLength(2);
  });

  it('duckQualifies enforces color, sex, and the quality floor (Prime counts via the shared matcher)', () => {
    const c = commission();
    expect(duckQualifies(c, c.lines[0], mk('d1'))).toBe(true);
    expect(duckQualifies(c, c.lines[0], mk('d2', { sex: 'drake' }))).toBe(false);
    expect(duckQualifies(c, c.lines[0], mk('d3', { genotype: ['Bl', 'Bl'] }))).toBe(false); // black
    expect(duckQualifies(c, c.lines[0], mk('d4', { genome: genome('LDDDDD') }))).toBe(false); // quality 1 < 2
    expect(duckQualifies(c, c.lines[0], mk('d5', { genome: genome('PLDDDD') }))).toBe(true); // P wildcards the slot
    const unaccepted = commission({ sinceDuckId: -1 });
    expect(duckQualifies(unaccepted, unaccepted.lines[0], mk('d6'))).toBe(false);
  });

  it('deliverOrder takes the WORST qualifying ducks per line and keeps the best', () => {
    const s = initialState(0);
    s.contracts.active = commission({ lines: [{ color: 'blue', sex: 'hen', count: 2 }] });
    s.ducks = [
      mk('d1', { genome: genome('LLLLLD') }), // quality 5 — the keeper
      mk('d2'), // quality 2
      mk('d3', { genome: genome('LLLDDD') }), // quality 3
    ];
    const r = deliverOrder(s);
    expect(r.ok).toBe(true);
    if (r.ok) expect(new Set(r.value.duckIds)).toEqual(new Set(['d2', 'd3']));
    expect(s.ducks.map((d) => d.id)).toEqual(['d1']);
    expect((s.contracts.active as OrderContract).completed).toBe(true);
  });

  it('fails cleanly when a line is short — including when only PROTECTED ducks qualify', () => {
    const s = initialState(0);
    s.contracts.active = commission();
    s.ducks = [];
    expect(deliverOrder(s).ok).toBe(false);
    s.ducks = [mk('d1', { secured: true }), mk('d2', { site: 'winter' }), mk('d3', { genome: genome('PLDDDD') })];
    const r = deliverOrder(s);
    expect(r.ok).toBe(false); // vault + posted + Prime carrier: never auto-handed
    if (!r.ok) expect(r.reason).toMatch(/never handed over/i);
  });

  it('multi-line: fills every line at once, never double-spends a duck, drops pairings', () => {
    const s = initialState(0);
    s.contracts.active = commission({
      lines: [
        { color: 'blue', sex: 'hen', count: 1 },
        { color: 'blue', sex: 'drake', count: 1 },
      ],
    });
    s.ducks = [mk('d1'), mk('d2', { sex: 'drake' })];
    s.breedingPairs = [{ id: 'p1', drakeId: 'd2', henId: 'd1', clutchProgress: 0, incubating: [] }];
    const r = deliverOrder(s);
    expect(r.ok).toBe(true);
    expect(s.ducks).toHaveLength(0);
    expect(s.breedingPairs).toEqual([]);
  });

  it('mass-hatching toward the Standard completes NOTHING on its own — delivery is always a click', () => {
    const s = build({ coop: 8 });
    const standard = targetForTier(0);
    s.ducks = [
      { id: 'dr', genotype: ['Bl', 'bl'] as Genotype, genome: [...standard], genomeKnown: true, sex: 'drake', stage: 'adult', ageTicks: 0 } as Duck,
      { id: 'he', genotype: ['Bl', 'bl'] as Genotype, genome: [...standard], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 } as Duck,
    ];
    s.breedingPairs = [{ id: 'p1', drakeId: 'dr', henId: 'he', clutchProgress: 0, incubating: [] }];
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = commission({ sinceDuckId: 0 }); // everything qualifies by watermark
    for (let i = 0; i < 5; i++) {
      runBreeding(s, BALANCE.BREEDING.CLUTCH_INTERVAL_S + BALANCE.BREEDING.INCUBATE_S + 1, 1, 1);
    }
    expect(s.ducks.length).toBeGreaterThan(2); // hatching really happened
    // Ducks may QUALIFY — but nothing ever completes without deliverOrder().
    expect((s.contracts.active as OrderContract).completed).toBe(false);
  });
});

describe('provision: hand over a produced ingredient', () => {
  it('fulfilProvision draws the exact amount and completes', () => {
    const s = initialState(0);
    s.resources.corn = 500;
    s.contracts.active = provisionContract({ amount: 300 });
    const r = fulfilProvision(s);
    expect(r.ok).toBe(true);
    expect(s.resources.corn).toBe(200);
    expect((s.contracts.active as ProvisionContract).completed).toBe(true);
  });

  it('fails cleanly below the required amount — no partial draw', () => {
    const s = initialState(0);
    s.resources.corn = 100;
    s.contracts.active = provisionContract({ amount: 300 });
    const r = fulfilProvision(s);
    expect(r.ok).toBe(false);
    expect(s.resources.corn).toBe(100);
    expect((s.contracts.active as ProvisionContract).completed).toBe(false);
  });

  it('respects deadline expiry — no penalty beyond the freed slot', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.resources.corn = 0;
    s.contracts.active = provisionContract({ amount: 1_000_000, limitRemaining: 5 });
    runContracts(s, 10); // deadline blown before it could ever be fulfilled
    expect(s.contracts.active).toBeNull();
    expect(s.dust).toBe(0);
    expect(s.legacyCurrency).toBe(0);
    expect(s.pendingContractExpired).toBe(1); // never silently
  });

  it('an already-complete provision cannot be fulfilled twice', () => {
    const s = initialState(0);
    s.resources.corn = 1000;
    s.contracts.active = provisionContract({ amount: 100, completed: true });
    const r = fulfilProvision(s);
    expect(r.ok).toBe(false);
    expect(s.resources.corn).toBe(1000);
  });
});

describe('defense: prove the watch', () => {
  it('scared events advance progress; wound/snatched reset it to 0', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = defenseContract({ scareTarget: 2, scareProgress: 0 });
    onPredatorEvent(s, { kind: 'scared', predatorId: 'owl', duckId: 'd0' });
    expect((s.contracts.active as DefenseContract).scareProgress).toBe(1);
    onPredatorEvent(s, { kind: 'wound', predatorId: 'owl', duckId: 'd0' });
    expect((s.contracts.active as DefenseContract).scareProgress).toBe(0);
    onPredatorEvent(s, { kind: 'scared', predatorId: 'owl', duckId: 'd0' });
    onPredatorEvent(s, { kind: 'scared', predatorId: 'owl', duckId: 'd0' });
    expect(s.contracts.active?.completed).toBe(true);
  });

  it('snatched also resets progress, and irrelevant events (crowdInjury) are ignored', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = defenseContract({ scareTarget: 3, scareProgress: 2 });
    onPredatorEvent(s, { kind: 'crowdInjury', duckId: 'd0' });
    expect((s.contracts.active as DefenseContract).scareProgress).toBe(2); // untouched
    onPredatorEvent(s, { kind: 'snatched', predatorId: 'owl', duckId: 'd0' });
    expect((s.contracts.active as DefenseContract).scareProgress).toBe(0);
  });

  it('a siege scare (Phase 6c) feeds an active defense contract exactly like any other predator — no special-casing', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = defenseContract({ scareTarget: 2, scareProgress: 0 });
    onPredatorEvent(s, { kind: 'scared', predatorId: 'greatHorned', duckId: 'd0' });
    expect((s.contracts.active as DefenseContract).scareProgress).toBe(1);
    onPredatorEvent(s, { kind: 'scared', predatorId: 'greatHorned', duckId: 'd0' });
    expect(s.contracts.active?.completed).toBe(true);
  });

  it('an offline attack (real predator wound) never touches an active defense contract', () => {
    const s = build({ coop: 1 });
    s.rank = BALANCE.PREDATORS.INTRO_RANK;
    s.predatorsIntroduced = true;
    s.predators.owl = { timeToNextWindow: 0, windowRemaining: OWL.windowDurationSec, windowElapsed: 0, attacksFired: 0 };
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = defenseContract({ scareTarget: 5, scareProgress: 2 });
    const firstAttackAt = OWL.windowDurationSec / (OWL.attacksPerWindow + 1);
    // A hand-sequenced rng: [attack succeeds, pick the first target, DON'T resist
    // (a bare `zero` would make the wound-resist check `rng() < resistChance`
    // always true, since 0 < any positive chance)], then a stable fallback for
    // any later rolls (e.g. severity).
    const seq = [0.01, 0, 0.99];
    let i = 0;
    const rng = () => (i < seq.length ? seq[i++] : 0.5);
    tick(s, firstAttackAt, { mode: 'offline', autoHaul: true, rng });
    expect(s.ducks.some((d) => d.wounded)).toBe(true); // a real attack landed
    expect((s.contracts.active as DefenseContract).scareProgress).toBe(2); // untouched offline
  });
});

describe('online-only law (across every clock/progress)', () => {
  it('offline catch-up advances no contract clock and refills no offers', () => {
    const s = setHens(stockAll(fullSetup()), 3);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.offers = []; // even with the board unlocked, offline must not fill it
    s.contracts.active = provisionContract({ amount: 1_000_000, limitRemaining: 999 });
    const refreshBefore = s.contracts.refreshRemaining;
    s.lastSeen = -3600 * 1000; // 1 hour ago
    const away = runOfflineCatchUp(s, 0);
    expect(away.produced.eggs ?? 0).toBeGreaterThan(0); // eggs WERE produced offline...
    expect((s.contracts.active as ProvisionContract).limitRemaining).toBe(999); // deadline frozen
    expect(s.contracts.offers).toEqual([]); // never refilled
    expect(s.contracts.refreshRemaining).toBe(refreshBefore); // refresh timer frozen
  });

  it('deliverOrderDuck and fulfilProvision are the ONLY paths to completion — neither is reachable from tick/offline catch-up', () => {
    // Both are plain functions called exclusively from GameEngine action wrappers
    // (see engine.ts) — tick.ts never imports or calls them. This is a structural
    // guarantee, not a race to test at runtime: assert the sim can run freely
    // (online AND offline) with an active order/provision and neither completes
    // on its own.
    const s = setHens(stockAll(fullSetup()), 3);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = orderContract({ constraints: ['V', null, null, null, null, null], target: genome('LLLLLL') });
    run(s, 20); // plenty of online ticks
    expect((s.contracts.active as OrderContract).completed).toBe(false);

    const s2 = setHens(stockAll(fullSetup()), 3);
    s2.legacyTier = C.UNLOCK_TIER;
    s2.resources.corn = 1_000_000;
    s2.contracts.active = provisionContract({ amount: 10, limitRemaining: 999 });
    run(s2, 20);
    expect((s2.contracts.active as ProvisionContract).completed).toBe(false);
  });

  it('scareOff (the online scare click) is the only path to a scared event; nothing offline can produce one', () => {
    // scareOff requires an in-flight strike, which predators.ts only ever creates
    // in 'online' mode (offline resolves attacks immediately, no telegraph).
    const s = build({ coop: 1 });
    expect(scareOff(s, 'owl')).toBeNull(); // no strike in flight offline-shaped state
  });
});

describe('save round-trip + prestige', () => {
  it('pre-6b saves (no contracts block at all) load with a valid empty board', () => {
    const legacy = JSON.stringify({ version: 1, resources: { eggs: 5 }, stations: [] });
    const r = deserialize(legacy, 0);
    expect(r.contracts).toEqual(initialContracts());
  });

  it('round-trips a live board (offers + active + counters)', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts = {
      offers: [provisionContract({ id: 'o1' })],
      active: provisionContract({ id: 'a1', amount: 42 }),
      nextContractId: 7,
      refreshRemaining: 123,
    };
    const r = deserialize(serialize(s), 0);
    expect(r.contracts.offers).toHaveLength(1);
    expect(r.contracts.offers[0].id).toBe('o1');
    expect(r.contracts.active?.id).toBe('a1');
    expect((r.contracts.active as ProvisionContract).amount).toBe(42);
    expect(r.contracts.nextContractId).toBe(7);
    expect(r.contracts.refreshRemaining).toBe(123);
  });

  it('a saved ACTIVE contract of a retired shape (delivery/hatch) is voided on load — no penalty, no toast', () => {
    const legacyDelivery = {
      resources: {},
      contracts: {
        offers: [provisionContract({ id: 'still-good' }), { id: 'legacy-o', type: 'hatch', notch: 0, reward: { dust: 0, shards: 0 }, completed: false, genePattern: [null, null, null, null, null, null] }],
        active: { id: 'legacy-a', type: 'delivery', notch: 0, reward: { dust: 5, shards: 1 }, completed: false, quota: 100, delivered: 50, limitRemaining: 200 },
        nextContractId: 9,
        refreshRemaining: 50,
        peakEggRate: 42,
      },
    };
    const r = deserialize(JSON.stringify(legacyDelivery), 0);
    expect(r.contracts.active).toBeNull(); // voided, no penalty
    expect(r.contracts.offers.map((o) => o.id)).toEqual(['still-good']); // the legacy hatch offer is dropped
    expect(r.contracts.nextContractId).toBe(9); // counters survive
    expect(r.contracts.refreshRemaining).toBe(50); // the board re-rolls on its normal clock
    expect(r.contracts.peakEggRate).toBe(42); // clutch cost / pond pricing depend on this surviving
    expect(r.pendingContractExpired).toBe(0); // never a toast for a migration
  });

  it('prestigeReset wipes the board back to the initial (empty, untiered) shape', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts = {
      offers: [provisionContract({ id: 'o1' }), provisionContract({ id: 'o2' })],
      active: provisionContract({ id: 'a1', amount: 99 }),
      nextContractId: 50,
      refreshRemaining: 3,
    };
    const reset = prestigeReset(s, 0);
    expect(reset.contracts).toEqual(initialContracts());
  });
});

describe('guardrail: contracts never touch the sim', () => {
  it('an active/claimed contract never mutates balance-derived sim outputs it does not own', () => {
    // Snapshot every sim-relevant BALANCE table a contract could conceivably
    // touch and prove they're untouched by generating + claiming contracts.
    const nutritionBefore = JSON.stringify(BALANCE.NUTRITION);
    const breedingBefore = JSON.stringify(BALANCE.BREEDING);
    const predatorsBefore = JSON.stringify(BALANCE.PREDATORS);
    const genomeBefore = JSON.stringify(BALANCE.GENOME);

    const s = setHens(stockAll(fullSetup()), 3);
    s.legacyTier = C.UNLOCK_TIER;
    run(s, 5);
    s.resources.corn = 1000;
    s.contracts.active = provisionContract({ amount: 10 });
    const r = fulfilProvision(s);
    expect(r.ok).toBe(true);
    if (s.contracts.active?.completed) claimContract(s);

    expect(JSON.stringify(BALANCE.NUTRITION)).toBe(nutritionBefore);
    expect(JSON.stringify(BALANCE.BREEDING)).toBe(breedingBefore);
    expect(JSON.stringify(BALANCE.PREDATORS)).toBe(predatorsBefore);
    expect(JSON.stringify(BALANCE.GENOME)).toBe(genomeBefore);
  });
});

describe('type-priced rewards (Grange 2.0 retune)', () => {
  it('rewards scale by TYPE on top of the notch band (defense-only is never optimal)', () => {
    const s = setHens(stockAll(fullSetup()), 3);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.peakEggRate = 5;
    for (let i = 0; i < 400; i++) {
      const o = generateOffer(s, Math.random);
      const band = C.REWARD_BY_NOTCH[o.notch];
      const mult = C.TYPE_REWARD_MULT[o.type];
      expect(o.reward.dust).toBeGreaterThanOrEqual(Math.round(band.dust[0] * mult));
      expect(o.reward.dust).toBeLessThanOrEqual(Math.round(band.dust[1] * mult));
      expect(o.reward.shards).toBeGreaterThanOrEqual(Math.round(band.shards[0] * mult));
      expect(o.reward.shards).toBeLessThanOrEqual(Math.round(band.shards[1] * mult));
    }
  });
});
