import { BALANCE } from '../config/balance';
import { grantModule } from './loot';
import {
  COLORS,
  phenotype,
  type Color,
  type Contract,
  type ContractReward,
  type ContractType,
  type DefenseContract,
  type DeliveryContract,
  type Duck,
  type Gene,
  type GameState,
  type HatchContract,
  type Module,
  type PredatorEvent,
  type Rarity,
} from './state';
import type { ActionResult } from './actions';

/**
 * contracts.ts — Phase 6b: THE GRANGE.
 *
 * A rotating offer board unlocked at legacy tier 1. Exactly ONE contract is
 * active at a time; the player picks which offer to run. Three shapes (a
 * discriminated union — a new type later is a new generator, not new
 * architecture): `delivery` (the egg sink), `hatch` (breeding to spec), and
 * `defense` (foil the watch). Rewards are dust / legacy shards / a module —
 * NEVER eggs, resources, or XP.
 *
 * Locked guardrail: contracts never touch the sim. They only OBSERVE existing
 * lay/hatch/predator events and divert already-produced eggs — never a rate,
 * requirement, ration, water, genome odds, or predator schedule.
 *
 * ALL contract clocks and progress are ONLINE-ONLY: `runContracts` is called
 * from tick.ts only when `opts.mode === 'online'`; `onEggsLaid`/`onHatch` are
 * only invoked from online lay/hatch paths by their callers.
 */

const fail = (reason: string): ActionResult<never> => ({ ok: false, reason });
const done = <T>(value: T): ActionResult<T> => ({ ok: true, value });

const C = BALANCE.CONTRACTS;

// ── Offer generation (Math.random-style, like loot rolls) ─────────────
function pickNotch(rng: () => number): number {
  const weights = C.NOTCH_WEIGHTS;
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function pickType(rng: () => number): ContractType {
  const weights = C.TYPE_WEIGHTS as Record<ContractType, number>;
  const entries = Object.entries(weights) as [ContractType, number][];
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r < 0) return k;
  }
  return entries[entries.length - 1][0];
}

function rollReward(notch: number, rng: () => number): ContractReward {
  const band = C.REWARD_BY_NOTCH[notch];
  const dust = Math.round(band.dust[0] + rng() * (band.dust[1] - band.dust[0]));
  const shards = Math.round(band.shards[0] + rng() * (band.shards[1] - band.shards[0]));
  return band.moduleRarity ? { dust, shards, moduleRarity: band.moduleRarity as Rarity } : { dust, shards };
}

function generateDelivery(state: GameState, notch: number, id: string, rng: () => number): DeliveryContract {
  const eggRate = state.nutrition?.eggRate ?? 0;
  const base = eggRate * 60 * C.DELIVERY.QUOTA_MINUTES * C.DELIVERY.QUOTA_MULT_BY_NOTCH[notch];
  const quota = Math.max(C.DELIVERY.MIN_QUOTA, Math.round(base));
  return {
    id,
    type: 'delivery',
    notch,
    reward: rollReward(notch, rng),
    completed: false,
    quota,
    delivered: 0,
    limitRemaining: 0, // the deadline only starts ticking once accepted
  };
}

/** {L,V,H} only — a hatch spec can never demand a D, so it's always breedable-toward. */
const HATCH_GENES: Gene[] = ['L', 'V', 'H'];

function generateHatch(notch: number, id: string, rng: () => number): HatchContract {
  const slots = Math.min(C.HATCH.SPEC_MAX_SLOTS, C.HATCH.SLOTS_BY_NOTCH[notch]);
  const SLOTS = BALANCE.GENOME.SLOTS;
  const positions = new Set<number>();
  while (positions.size < slots) positions.add(Math.floor(rng() * SLOTS));
  const genePattern: (Gene | null)[] = Array.from({ length: SLOTS }, () => null);
  for (const p of positions) genePattern[p] = HATCH_GENES[Math.floor(rng() * HATCH_GENES.length)];
  const color: Color | undefined =
    rng() < C.HATCH.COLOR_CHANCE ? COLORS[Math.floor(rng() * COLORS.length)] : undefined;
  return { id, type: 'hatch', notch, reward: rollReward(notch, rng), completed: false, color, genePattern };
}

function generateDefense(notch: number, id: string, rng: () => number): DefenseContract {
  return {
    id,
    type: 'defense',
    notch,
    reward: rollReward(notch, rng),
    completed: false,
    scareTarget: C.DEFENSE.SCARE_COUNT_BY_NOTCH[notch],
    scareProgress: 0,
  };
}

export function generateOffer(state: GameState, rng: () => number = Math.random): Contract {
  const id = `ct${state.contracts.nextContractId++}`;
  const notch = pickNotch(rng);
  const type = pickType(rng);
  if (type === 'delivery') return generateDelivery(state, notch, id, rng);
  if (type === 'hatch') return generateHatch(notch, id, rng);
  return generateDefense(notch, id, rng);
}

function refillOffers(state: GameState, rng: () => number = Math.random): void {
  while (state.contracts.offers.length < C.OFFER_SLOTS) {
    state.contracts.offers.push(generateOffer(state, rng));
  }
}

// ── Board lifecycle (ActionResult pattern, like actions.ts) ───────────
export function acceptContract(state: GameState, contractId: string): ActionResult<Contract> {
  if (state.legacyTier < C.UNLOCK_TIER) return fail('The Grange is locked');
  if (state.contracts.active) return fail('A contract is already active');
  const idx = state.contracts.offers.findIndex((o) => o.id === contractId);
  if (idx < 0) return fail('No such offer');
  const [contract] = state.contracts.offers.splice(idx, 1);
  if (contract.type === 'delivery') contract.limitRemaining = C.DELIVERY.LIMIT_MIN * 60;
  state.contracts.active = contract;
  refillOffers(state); // the emptied slot regenerates immediately
  return done(contract);
}

export function abandonContract(state: GameState): ActionResult<unknown> {
  if (!state.contracts.active) return fail('No active contract');
  state.contracts.active = null;
  return done(true);
}

export interface ClaimResult extends ContractReward {
  module?: Module;
}

export function claimContract(state: GameState, rng: () => number = Math.random): ActionResult<ClaimResult> {
  const c = state.contracts.active;
  if (!c) return fail('No active contract');
  if (!c.completed) return fail('Contract not complete yet');
  state.dust += c.reward.dust;
  state.legacyCurrency += c.reward.shards;
  const module = c.reward.moduleRarity ? grantModule(state, c.reward.moduleRarity, rng) : undefined;
  state.contracts.active = null;
  return done({ ...c.reward, module });
}

/** Reroll the whole board for REROLL_DUST — the manual "none of these" escape. */
export function rerollOffers(state: GameState, rng: () => number = Math.random): ActionResult<unknown> {
  if (state.legacyTier < C.UNLOCK_TIER) return fail('The Grange is locked');
  const cost = C.REROLL_DUST;
  if (state.dust < cost) return fail(`Need ${cost} dust`);
  state.dust -= cost;
  state.contracts.offers = [];
  refillOffers(state, rng);
  return done(true);
}

// ── Progress hooks (called from the sim's existing lay/hatch/predator paths) ──
/** Divert up to `n` laid eggs into an active delivery contract's quota. Returns
 *  how much was diverted (the caller deposits only the remainder to storage).
 *  Callers MUST gate this to online lay moments only (the online-only law). */
export function onEggsLaid(state: GameState, n: number): number {
  const c = state.contracts.active;
  if (!c || c.type !== 'delivery' || c.completed || n <= 0) return 0;
  const remaining = c.quota - c.delivered;
  if (remaining <= 0) return 0;
  const diverted = Math.min(n, remaining);
  c.delivered += diverted;
  if (c.delivered >= c.quota) c.completed = true;
  return diverted;
}

/** Check an online hatch against an active hatch-spec contract. Callers MUST
 *  only call this for hatches that occurred online (the online-only law). */
export function onHatch(state: GameState, duck: Duck): void {
  const c = state.contracts.active;
  if (!c || c.type !== 'hatch' || c.completed) return;
  if (c.color && phenotype(duck.genotype) !== c.color) return;
  for (let i = 0; i < c.genePattern.length; i++) {
    const want = c.genePattern[i];
    if (want != null && duck.genome[i] !== want) return;
  }
  c.completed = true;
}

/** Feed one predator event into an active defense contract: a foiled dive
 *  ('scared') advances it; a landed injury ('wound'/'snatched') resets it to
 *  0. NOT called from tick.ts/runContracts — 'scared' only ever originates from
 *  an out-of-band player scare click, never from inside a tick step. Instead
 *  GameEngine calls this from its predator-event drain, the actual online-only
 *  choke point every predator event passes through en route to the UI (offline
 *  catch-up never touches the engine, so the online-only law still holds). */
export function onPredatorEvent(state: GameState, e: PredatorEvent): void {
  const c = state.contracts.active;
  if (!c || c.type !== 'defense' || c.completed) return;
  if (e.kind === 'scared') {
    c.scareProgress += 1;
    if (c.scareProgress >= c.scareTarget) c.completed = true;
  } else if (e.kind === 'wound' || e.kind === 'snatched') {
    c.scareProgress = 0;
  }
}

// ── Per-tick board upkeep (online-only; called from tick.ts) ──────────
/**
 * Advance the board by `dt` seconds: fill any empty offer slots, roll a full
 * refresh on the timer, and tick the active delivery deadline (expiry frees
 * the slot with no penalty). The caller (tick.ts) must only invoke this in
 * online mode — nothing here may run during offline catch-up. (The defense
 * contract's scare-count hook is fed separately, from GameEngine's predator-
 * event drain — see onPredatorEvent's doc comment.)
 */
export function runContracts(state: GameState, dt: number): void {
  if (state.legacyTier < C.UNLOCK_TIER) return;
  const cs = state.contracts;

  if (cs.offers.length === 0) refillOffers(state);

  cs.refreshRemaining -= dt;
  if (cs.refreshRemaining <= 0) {
    cs.offers = [];
    refillOffers(state);
    cs.refreshRemaining = C.OFFER_REFRESH_S;
  }

  if (cs.active && cs.active.type === 'delivery' && !cs.active.completed) {
    cs.active.limitRemaining -= dt;
    if (cs.active.limitRemaining <= 0) cs.active = null; // expired — freed slot, no penalty
  }
}
