import { describe, it, expect } from 'vitest';
import { BALANCE, predatorDef } from '../src/config/balance';
import { collectAll, tend } from '../src/game/actions';
import {
  acceptContract,
  abandonContract,
  claimContract,
  generateOffer,
  onHatch,
  onPredatorEvent,
  rerollOffers,
  runContracts,
} from '../src/game/contracts';
import { runBreeding } from '../src/game/breeding';
import { prestigeReset } from '../src/game/prestige';
import { deserialize, serialize, runOfflineCatchUp } from '../src/game/save';
import { tick } from '../src/game/tick';
import { scareOff } from '../src/game/predators';
import {
  initialContracts,
  initialState,
  type Contract,
  type DeliveryContract,
  type Duck,
  type Genotype,
  type GameState,
} from '../src/game/state';
import { build, fullSetup, stockAll, setHens, run, FLAT_GENOME } from './helpers';

const C = BALANCE.CONTRACTS;
const OWL = predatorDef('owl')!;

/** A fixed-zero rng: deterministically rolls notch 0 and type 'delivery'
 *  (first entries by weight), and the low end of every reward band. */
const zero = () => 0;

const deliveryContract = (over: Partial<DeliveryContract> = {}): DeliveryContract => ({
  id: 'ct-test',
  type: 'delivery',
  notch: 0,
  reward: { dust: 0, shards: 0 },
  completed: false,
  quota: 100,
  delivered: 0,
  limitRemaining: 999,
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
    s.contracts.offers = [deliveryContract({ id: 'a' })];
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

describe('offer generation', () => {
  it('a delivery quota scales with the SNAPSHOTTED live eggRate (self-balancing)', () => {
    const s = setHens(stockAll(fullSetup()), 4);
    s.legacyTier = C.UNLOCK_TIER;
    run(s, 10); // warm up nutrition so state.nutrition.eggRate is real
    const eggRate = s.nutrition!.eggRate;
    expect(eggRate).toBeGreaterThan(0);
    const offer = generateOffer(s, zero); // zero rng -> notch 0, type 'delivery'
    expect(offer.type).toBe('delivery');
    const d = offer as DeliveryContract;
    const expectedQuota = Math.max(
      C.DELIVERY.MIN_QUOTA,
      Math.round(eggRate * 60 * C.DELIVERY.QUOTA_MINUTES * C.DELIVERY.QUOTA_MULT_BY_NOTCH[0]),
    );
    expect(d.quota).toBe(expectedQuota);
    expect(d.delivered).toBe(0);
  });

  it('a delivery quota floors at MIN_QUOTA when there is no flock yet', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    const d = generateOffer(s, zero) as DeliveryContract;
    expect(d.quota).toBe(C.DELIVERY.MIN_QUOTA);
  });

  it('hatch specs are always achievable: genes only from {L,V,H}, never D, and ≤ SPEC_MAX_SLOTS', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    // Sample many offers across many notches/types to exercise the generator.
    for (let i = 0; i < 500; i++) {
      const offer = generateOffer(s, Math.random);
      if (offer.type !== 'hatch') continue;
      const specified = offer.genePattern.filter((g) => g != null);
      expect(specified.length).toBeGreaterThanOrEqual(2);
      expect(specified.length).toBeLessThanOrEqual(C.HATCH.SPEC_MAX_SLOTS);
      for (const g of specified) expect(['L', 'V', 'H']).toContain(g);
      expect(offer.genePattern).toHaveLength(BALANCE.GENOME.SLOTS);
    }
  });

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
    s.contracts.active = deliveryContract({ completed: false });
    expect(claimContract(s).ok).toBe(false);
  });

  it('claiming a completed contract grants exactly dust + shards (+ module at top notch), clears the slot', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = deliveryContract({ completed: true, reward: { dust: 12, shards: 3 } });
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
    s.contracts.active = deliveryContract({
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

describe('delivery: the egg sink', () => {
  it('diverts eggs at the nutrition lay point — never double-counted via haul', () => {
    const plain = setHens(stockAll(fullSetup()), 3);
    plain.legacyTier = C.UNLOCK_TIER;
    run(plain, 20);
    const totalNoContract = plain.resources.eggs;
    expect(totalNoContract).toBeGreaterThan(0);

    const withContract = setHens(stockAll(fullSetup()), 3);
    withContract.legacyTier = C.UNLOCK_TIER;
    withContract.contracts.active = deliveryContract({ quota: 1_000_000 }); // never completes
    run(withContract, 20);
    const c = withContract.contracts.active as DeliveryContract;
    expect(c.delivered).toBeGreaterThan(0);
    // Conservation: every egg landed either in storage or the contract, never both.
    expect(withContract.resources.eggs + c.delivered).toBeCloseTo(totalNoContract, 4);
  });

  it('completes exactly at quota and stops diverting further eggs', () => {
    const s = setHens(stockAll(fullSetup()), 3);
    s.legacyTier = C.UNLOCK_TIER;
    run(s, 5); // warm up
    const rate = s.nutrition!.eggRate;
    s.contracts.active = deliveryContract({ quota: Math.max(1, Math.round(rate * 2)) });
    run(s, 30); // plenty of time to blow past a 2-second quota
    const c = s.contracts.active as DeliveryContract;
    expect(c.completed).toBe(true);
    expect(c.delivered).toBe(c.quota); // never overshoots
  });

  it("tend()'s coop burst also diverts at the lay point (the other lay path) — no double count", () => {
    const s = build({ coop: 1 });
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = deliveryContract({ quota: 3 });
    const r = tend(s, s.stations[0].id);
    if (!r.ok) throw new Error('tend failed');
    const c = s.contracts.active as DeliveryContract;
    expect(c.delivered).toBe(3);
    expect(c.completed).toBe(true);
    const totalBurst = BALANCE.TEND_BURST_MULT * BALANCE.COOP.eggPerCycle;
    expect((r.value.burst.eggs ?? 0) + c.delivered).toBe(totalBurst); // conserved
  });

  it('collectAll never resurrects diverted eggs into the delivered count', () => {
    const s = setHens(stockAll(fullSetup()), 3);
    s.legacyTier = C.UNLOCK_TIER;
    run(s, 5); // warm up eggRate
    const rate = s.nutrition!.eggRate;
    s.contracts.active = deliveryContract({ quota: Math.max(1, Math.round(rate * 2)) }); // completes fast
    run(s, 30, false); // no auto-haul: buffers accumulate for a manual check
    const c = s.contracts.active as DeliveryContract;
    expect(c.completed).toBe(true);
    const deliveredAtCompletion = c.delivered;
    const bufferedEggs = s.stations.reduce((a, st) => a + (st.buffer.eggs ?? 0), 0);
    expect(bufferedEggs).toBeGreaterThan(0); // post-quota eggs still accumulate normally
    const eggsBefore = s.resources.eggs;
    collectAll(s);
    expect((s.contracts.active as DeliveryContract).delivered).toBe(deliveredAtCompletion); // unchanged
    expect(s.resources.eggs - eggsBefore).toBeCloseTo(bufferedEggs, 4);
  });

  it('fails cleanly at the deadline — no penalty beyond the freed slot', () => {
    const s = setHens(stockAll(fullSetup()), 1);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = deliveryContract({ quota: 1_000_000, limitRemaining: 5 });
    run(s, 10); // deadline (5s) blown well before the quota could ever be met
    expect(s.contracts.active).toBeNull(); // freed — no other side effect
    expect(s.dust).toBe(0);
    expect(s.legacyCurrency).toBe(0);
    // …but never SILENTLY: the expiry is flagged for the engine's toast drain.
    expect(s.pendingContractExpired).toBe(1);
  });
});

describe('hatch: breeding stock to spec', () => {
  /** A pair ready to hatch a full clutch on the next runBreeding call. */
  function pairReady(): GameState {
    const s = build({ coop: 4 });
    s.ducks = [
      { id: 'dr', genotype: ['Bl', 'bl'] as Genotype, genome: [...FLAT_GENOME], genomeKnown: true, sex: 'drake', stage: 'adult', ageTicks: 0 } as Duck,
      { id: 'he', genotype: ['Bl', 'bl'] as Genotype, genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 } as Duck,
    ];
    s.breedingPairs = [{ id: 'p1', drakeId: 'dr', henId: 'he', clutchProgress: 0, incubating: [] }];
    s.legacyTier = C.UNLOCK_TIER;
    return s;
  }
  const anySpec = (): Contract => ({
    id: 'h1',
    type: 'hatch',
    notch: 0,
    reward: { dust: 0, shards: 0 },
    completed: false,
    genePattern: Array(BALANCE.GENOME.SLOTS).fill(null), // "don't care" — matches any hatch
  });

  it('an online hatch matching the spec completes the contract', () => {
    const s = pairReady();
    s.contracts.active = anySpec();
    runBreeding(s, BALANCE.BREEDING.CLUTCH_INTERVAL_S + BALANCE.BREEDING.INCUBATE_S + 1, 1, 1, true);
    expect(s.ducks.length).toBeGreaterThan(2); // something actually hatched
    expect(s.contracts.active?.completed).toBe(true);
  });

  it('a spec with a specified slot rejects a non-matching hatch and accepts a matching one', () => {
    const s = pairReady();
    const pattern: (import('../src/game/state').Gene | null)[] = Array(BALANCE.GENOME.SLOTS).fill(null);
    pattern[0] = 'V'; // FLAT_GENOME is all-D, so a straight D-parent hatch never has a V here...
    s.contracts.active = { ...anySpec(), genePattern: pattern };
    const duckD: Duck = { id: 'x', genotype: ['Bl', 'bl'], genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 };
    onHatch(s, duckD);
    expect(s.contracts.active?.completed).toBe(false);
    const duckV: Duck = { id: 'y', genotype: ['Bl', 'bl'], genome: ['V', 'D', 'D', 'D', 'D', 'D'], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 };
    onHatch(s, duckV);
    expect(s.contracts.active?.completed).toBe(true);
  });

  it('a Prime gene (Phase 6c) satisfies a specified slot exactly like the real wanted gene — the shared matcher', () => {
    const s = pairReady();
    const pattern: (import('../src/game/state').Gene | null)[] = Array(BALANCE.GENOME.SLOTS).fill(null);
    pattern[0] = 'V';
    s.contracts.active = { ...anySpec(), genePattern: pattern };
    const duckPrime: Duck = { id: 'z', genotype: ['Bl', 'bl'], genome: ['P', 'D', 'D', 'D', 'D', 'D'], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 };
    onHatch(s, duckPrime);
    expect(s.contracts.active?.completed).toBe(true);
  });

  it('a color-gated spec only completes on a matching phenotype', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = { ...anySpec(), color: 'splash' };
    const black: Duck = { id: 'b', genotype: ['bl', 'bl'], genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 };
    onHatch(s, black);
    expect(s.contracts.active?.completed).toBe(false);
    const splash: Duck = { id: 's', genotype: ['Bl', 'Bl'], genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 };
    onHatch(s, splash);
    expect(s.contracts.active?.completed).toBe(true);
  });
});

describe('defense: prove the watch', () => {
  it('scared events advance progress; wound/snatched reset it to 0', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = { id: 'd1', type: 'defense', notch: 0, reward: { dust: 0, shards: 0 }, completed: false, scareTarget: 2, scareProgress: 0 };
    onPredatorEvent(s, { kind: 'scared', predatorId: 'owl', duckId: 'd0' });
    expect((s.contracts.active as { scareProgress: number }).scareProgress).toBe(1);
    onPredatorEvent(s, { kind: 'wound', predatorId: 'owl', duckId: 'd0' });
    expect((s.contracts.active as { scareProgress: number }).scareProgress).toBe(0);
    onPredatorEvent(s, { kind: 'scared', predatorId: 'owl', duckId: 'd0' });
    onPredatorEvent(s, { kind: 'scared', predatorId: 'owl', duckId: 'd0' });
    expect(s.contracts.active?.completed).toBe(true);
  });

  it('snatched also resets progress, and irrelevant events (crowdInjury) are ignored', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = { id: 'd1', type: 'defense', notch: 0, reward: { dust: 0, shards: 0 }, completed: false, scareTarget: 3, scareProgress: 2 };
    onPredatorEvent(s, { kind: 'crowdInjury', duckId: 'd0' });
    expect((s.contracts.active as { scareProgress: number }).scareProgress).toBe(2); // untouched
    onPredatorEvent(s, { kind: 'snatched', predatorId: 'owl', duckId: 'd0' });
    expect((s.contracts.active as { scareProgress: number }).scareProgress).toBe(0);
  });

  it('a siege scare (Phase 6c) feeds an active defense contract exactly like any other predator — no special-casing', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = { id: 'd1', type: 'defense', notch: 0, reward: { dust: 0, shards: 0 }, completed: false, scareTarget: 2, scareProgress: 0 };
    onPredatorEvent(s, { kind: 'scared', predatorId: 'greatHorned', duckId: 'd0' });
    expect((s.contracts.active as { scareProgress: number }).scareProgress).toBe(1);
    onPredatorEvent(s, { kind: 'scared', predatorId: 'greatHorned', duckId: 'd0' });
    expect(s.contracts.active?.completed).toBe(true);
  });

  it('an offline attack (real predator wound) never touches an active defense contract', () => {
    const s = build({ coop: 1 });
    s.rank = BALANCE.PREDATORS.INTRO_RANK;
    s.predatorsIntroduced = true;
    s.predators.owl = { timeToNextWindow: 0, windowRemaining: OWL.windowDurationSec, windowElapsed: 0, attacksFired: 0 };
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = { id: 'd1', type: 'defense', notch: 0, reward: { dust: 0, shards: 0 }, completed: false, scareTarget: 5, scareProgress: 2 };
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
    expect((s.contracts.active as { scareProgress: number }).scareProgress).toBe(2); // untouched offline
  });
});

describe('online-only law (across every clock/progress)', () => {
  it('offline catch-up advances no contract clock, diverts no eggs, refills no offers', () => {
    const s = setHens(stockAll(fullSetup()), 3);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.offers = []; // even with the board unlocked, offline must not fill it
    s.contracts.active = deliveryContract({ quota: 1_000_000, limitRemaining: 999 });
    const refreshBefore = s.contracts.refreshRemaining;
    s.lastSeen = -3600 * 1000; // 1 hour ago
    const away = runOfflineCatchUp(s, 0);
    expect(away.produced.eggs ?? 0).toBeGreaterThan(0); // eggs WERE produced offline...
    expect(s.contracts.active?.delivered).toBe(0); // ...but none diverted
    expect(s.contracts.active?.limitRemaining).toBe(999); // deadline frozen
    expect(s.contracts.offers).toEqual([]); // never refilled
    expect(s.contracts.refreshRemaining).toBe(refreshBefore); // refresh timer frozen
  });

  it('an offline hatch matching an active spec never completes the contract', () => {
    const s = build({ coop: 4 });
    s.ducks = [
      { id: 'dr', genotype: ['Bl', 'bl'] as Genotype, genome: [...FLAT_GENOME], genomeKnown: true, sex: 'drake', stage: 'adult', ageTicks: 0 } as Duck,
      { id: 'he', genotype: ['Bl', 'bl'] as Genotype, genome: [...FLAT_GENOME], genomeKnown: true, sex: 'hen', stage: 'adult', ageTicks: 0 } as Duck,
    ];
    s.breedingPairs = [{ id: 'p1', drakeId: 'dr', henId: 'he', clutchProgress: 0, incubating: [] }];
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts.active = {
      id: 'h1',
      type: 'hatch',
      notch: 0,
      reward: { dust: 0, shards: 0 },
      completed: false,
      genePattern: Array(BALANCE.GENOME.SLOTS).fill(null), // matches anything
    };
    runBreeding(s, BALANCE.BREEDING.CLUTCH_INTERVAL_S + BALANCE.BREEDING.INCUBATE_S + 1, 1, 1, false); // offline
    expect(s.ducks.length).toBeGreaterThan(2); // the hatch really happened
    expect(s.contracts.active?.completed).toBe(false); // but doesn't count
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
      offers: [deliveryContract({ id: 'o1' })],
      active: deliveryContract({ id: 'a1', delivered: 42 }),
      nextContractId: 7,
      refreshRemaining: 123,
    };
    const r = deserialize(serialize(s), 0);
    expect(r.contracts.offers).toHaveLength(1);
    expect(r.contracts.offers[0].id).toBe('o1');
    expect(r.contracts.active?.id).toBe('a1');
    expect((r.contracts.active as DeliveryContract).delivered).toBe(42);
    expect(r.contracts.nextContractId).toBe(7);
    expect(r.contracts.refreshRemaining).toBe(123);
  });

  it('prestigeReset wipes the board back to the initial (empty, untiered) shape', () => {
    const s = initialState(0);
    s.legacyTier = C.UNLOCK_TIER;
    s.contracts = {
      offers: [deliveryContract({ id: 'o1' }), deliveryContract({ id: 'o2' })],
      active: deliveryContract({ id: 'a1', delivered: 99 }),
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
    s.contracts.active = deliveryContract({ quota: 5, completed: false });
    run(s, 30);
    if (s.contracts.active?.completed) claimContract(s);

    expect(JSON.stringify(BALANCE.NUTRITION)).toBe(nutritionBefore);
    expect(JSON.stringify(BALANCE.BREEDING)).toBe(breedingBefore);
    expect(JSON.stringify(BALANCE.PREDATORS)).toBe(predatorsBefore);
    expect(JSON.stringify(BALANCE.GENOME)).toBe(genomeBefore);
  });
});
