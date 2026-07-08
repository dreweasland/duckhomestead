import { BALANCE } from '../config/balance';
import { resourceFlow } from './actions';
import { targetMatch } from './genetics';
import { targetForTier } from './prestige';
import { grantModule } from './loot';
import {
  COLORS,
  INGREDIENTS,
  ingredientCap,
  phenotype,
  type Color,
  type Contract,
  type ContractReward,
  type ContractType,
  type DefenseContract,
  type Duck,
  type GameState,
  type Ingredient,
  type Module,
  type OrderContract,
  type OrderLine,
  type PredatorEvent,
  type ProvisionContract,
  type Rarity,
} from './state';
import type { ActionResult } from './actions';

/**
 * contracts.ts — Phase 6b/8: THE GRANGE.
 *
 * A rotating offer board unlocked at legacy tier 1. Exactly ONE contract is
 * active at a time; the player picks which offer to run. Three shapes (a
 * discriminated union — a new type later is a new generator, not new
 * architecture): `order` (breed a duck off the Standard and hand it over),
 * `provision` (hand over a produced ingredient from storage), and `defense`
 * (foil the watch). Rewards are dust / legacy shards / a module — NEVER eggs,
 * resources, or XP.
 *
 * Phase 8 GRANGE 2.0 (playtest, 2026-07-06): the old `delivery`/`hatch` shapes
 * were receipts for default play — a hatch bounty paid for the exact genes
 * mass breeding produces anyway (self-completing at scale with zero marginal
 * effort), and egg delivery just banked eggs already being banked. Every job
 * on this board now costs a genuine DETOUR: an order can only be filled by a
 * dedicated off-Standard side pair (the spec always contradicts the tier
 * target), and a provision costs a real chunk of a PURCHASED Feed Store
 * buffer. Neither completes passively — both require an explicit player
 * action (deliverOrderDuck / fulfilProvision), so there is no sim hook left to
 * spam.
 *
 * Locked guardrail: contracts never touch the sim. They only OBSERVE existing
 * predator events and spend resources/ducks the player already owns — never a
 * rate, requirement, ration, water, genome odds, or predator schedule.
 *
 * ALL contract clocks are ONLINE-ONLY: `runContracts` is called from tick.ts
 * only when `opts.mode === 'online'`. Order/provision completion is always a
 * direct player click (never a passive sim hook), so it can't run offline by
 * construction.
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

/** Weighted pick among only the CURRENTLY AVAILABLE types — `provision` is
 *  excluded by the caller when the player produces no tradeable ingredient. */
function pickType(types: ContractType[], rng: () => number): ContractType {
  const weights = C.TYPE_WEIGHTS as Record<ContractType, number>;
  const total = types.reduce((a, t) => a + (weights[t] ?? 0), 0);
  let r = rng() * total;
  for (const t of types) {
    r -= weights[t] ?? 0;
    if (r < 0) return t;
  }
  return types[types.length - 1];
}

function rollReward(notch: number, type: ContractType, rng: () => number): ContractReward {
  const band = C.REWARD_BY_NOTCH[notch];
  // Priced by notch AND type: the bands are scaled by what the type really
  // costs the player (see TYPE_REWARD_MULT) so defense-only is never optimal.
  const mult = C.TYPE_REWARD_MULT[type] ?? 1;
  const dust = Math.round((band.dust[0] + rng() * (band.dust[1] - band.dust[0])) * mult);
  const shards = Math.round((band.shards[0] + rng() * (band.shards[1] - band.shards[0])) * mult);
  return band.moduleRarity ? { dust, shards, moduleRarity: band.moduleRarity as Rarity } : { dust, shards };
}

/** The flock's LIVE egg rate — home lay + the premium winter lay. Still read
 *  by runContracts to track the run's peak (clutch costs, pond upgrades, net
 *  pricing all read that peak) even though nothing diverts eggs anymore. */
function liveEggRate(state: GameState): number {
  return (state.nutrition?.eggRate ?? 0) + (state.winter?.eggRate ?? 0);
}

// ── ORDER (the BREEDING COMMISSION — breed fresh color stock, hand it over) ──
/**
 * COMMISSION v2 (playtest, 2026-07-06 — see BALANCE.CONTRACTS.ORDER): color+sex
 * line items at a target-quality floor, and only ducks hatched UNDER the
 * commission count. The v1 odd-blood gene spec was impossible at endgame
 * (dominance fixes every slot; a contradicting gene is a mutation lottery).
 * Colors are Mendelian and plannable — the job is re-pairing by color
 * genotype and running real clutch cycles, not fighting inheritance.
 */
function generateOrder(state: GameState, notch: number, id: string, rng: () => number): OrderContract {
  const target = targetForTier(state.legacyTier);
  const lineCount = C.ORDER.LINES_BY_NOTCH[notch];
  // Distinct color+sex combos (6 possible) — sample without replacement.
  const combos: { color: Color; sex: 'hen' | 'drake' }[] = [];
  for (const color of COLORS) for (const sex of ['hen', 'drake'] as const) combos.push({ color, sex });
  const lines: OrderLine[] = [];
  for (let i = 0; i < lineCount; i++) {
    const pick = Math.floor(rng() * combos.length);
    const [combo] = combos.splice(pick, 1);
    lines.push({ ...combo, count: 1 + Math.floor(rng() * C.ORDER.MAX_PER_LINE_BY_NOTCH[notch]) });
  }
  return {
    id,
    type: 'order',
    notch,
    reward: rollReward(notch, 'order', rng),
    completed: false,
    lines,
    minQuality: C.ORDER.QUALITY_FLOOR_BY_NOTCH[notch],
    target,
    sinceDuckId: -1, // set at acceptance — board offers show no false eligibility
  };
}

/** Numeric tail of a duck id ("d213" → 213) — hatch ORDER is id order. */
const duckIdNum = (d: Duck): number => parseInt(d.id.replace(/^\D+/, ''), 10) || 0;

/** Whether one duck qualifies for one commission line: right color + sex,
 *  hatched under the commission (id ≥ the acceptance snapshot), and good
 *  enough against the snapshotted Standard (slotMatches — Prime counts, as
 *  everywhere). */
export function duckQualifies(c: OrderContract, line: OrderLine, d: Duck): boolean {
  return (
    c.sinceDuckId >= 0 &&
    duckIdNum(d) >= c.sinceDuckId &&
    d.sex === line.sex &&
    phenotype(d.genotype) === line.color &&
    targetMatch(d.genome, c.target) >= c.minQuality
  );
}

/** Per-line eligible ducks for the Grange card's "ready x/y" rows. */
export function eligibleForLine(state: GameState, c: OrderContract, line: OrderLine): Duck[] {
  return state.ducks.filter((d) => duckQualifies(c, line, d));
}

/** A duck the delivery auto-picker will never hand over: a Prime carrier (kept
 *  stock), a secured (vaulted) duck, or a posted winterer. Same standing as the
 *  cull tools — the player must free it explicitly to spend it. */
export const isDeliveryProtected = (d: Duck): boolean =>
  d.genome.includes('P') || !!d.secured || d.site === 'winter';

/**
 * Why a commission line is (un)fillable — the funnel from "right colour+sex,
 * hatched under this commission" down to what a delivery can actually take.
 * Powers the Grange card's per-line diagnostic: a right-kind duck that isn't
 * `ready` is either below the quality floor or held back (Prime/secured/
 * wintering), and `unread` flags how many of those have hidden genomes (the
 * player can't even see the quality that's failing them without a gene-reader).
 */
export interface LineStatus {
  line: OrderLine;
  /** Right colour + sex, hatched under the commission — any quality, any protection. */
  rightKind: number;
  /** Right-kind but under the quality floor. */
  belowQuality: number;
  /** Right-kind, meets quality, but Prime/secured/wintering — never auto-handed. */
  protectedCount: number;
  /** Right-kind with a genome not yet read (quality hidden to the player). */
  unread: number;
  /** Right colour+sex but hatched BEFORE acceptance — the anti-shelf rule bars
   *  them; the commonest "but I have that duck right there!" confusion. */
  preAcceptance: number;
  /** Deliverable right now (== eligibleForLine minus the protected). */
  ready: number;
}

export function lineStatus(state: GameState, c: OrderContract, line: OrderLine): LineStatus {
  const s: LineStatus = {
    line, rightKind: 0, belowQuality: 0, protectedCount: 0, unread: 0, preAcceptance: 0, ready: 0,
  };
  if (c.sinceDuckId < 0) return s;
  for (const d of state.ducks) {
    if (d.sex !== line.sex || phenotype(d.genotype) !== line.color) continue;
    if (duckIdNum(d) < c.sinceDuckId) {
      s.preAcceptance++;
      continue;
    }
    s.rightKind++;
    if (!d.genomeKnown) s.unread++;
    if (targetMatch(d.genome, c.target) < c.minQuality) {
      s.belowQuality++;
    } else if (isDeliveryProtected(d)) {
      s.protectedCount++;
    } else {
      s.ready++;
    }
  }
  return s;
}

// ── PROVISION (hand over a produced ingredient — the Feed Store's first customer) ──
/** Ingredients the player currently produces at all (rate > 0) — a provision
 *  is only ever offered for one of these; the type drops from the roll
 *  entirely (see generateOffer) when the list is empty. */
function producedIngredients(state: GameState): Ingredient[] {
  return INGREDIENTS.filter((ing) => resourceFlow(state, ing).in > 0);
}

/**
 * A PROVISION ORDER: hand over `amount` of one produced ingredient in a
 * single click. Amount = PROVISION.SECONDS of the player's CURRENT production
 * rate for that ingredient, clamped to PROVISION.CAP_FRACTION of the live
 * Feed Store cap — always fulfillable with enough silo investment, never a
 * request for the whole store.
 */
function generateProvision(
  state: GameState,
  notch: number,
  id: string,
  candidates: Ingredient[],
  rng: () => number,
): ProvisionContract {
  const ingredient = candidates[Math.floor(rng() * candidates.length)];
  const rate = resourceFlow(state, ingredient).in;
  const cap = ingredientCap(state) * C.PROVISION.CAP_FRACTION;
  const amount = Math.max(1, Math.round(Math.min(rate * C.PROVISION.SECONDS, cap)));
  return {
    id,
    type: 'provision',
    notch,
    reward: rollReward(notch, 'provision', rng),
    completed: false,
    ingredient,
    amount,
    limitRemaining: 0, // the deadline only starts ticking once accepted
  };
}

function generateDefense(notch: number, id: string, rng: () => number): DefenseContract {
  return {
    id,
    type: 'defense',
    notch,
    reward: rollReward(notch, 'defense', rng),
    completed: false,
    scareTarget: C.DEFENSE.SCARE_COUNT_BY_NOTCH[notch],
    scareProgress: 0,
  };
}

export function generateOffer(state: GameState, rng: () => number = Math.random): Contract {
  const id = `ct${state.contracts.nextContractId++}`;
  const notch = pickNotch(rng);
  const provisionCandidates = producedIngredients(state);
  const availableTypes: ContractType[] =
    provisionCandidates.length > 0 ? ['order', 'provision', 'defense'] : ['order', 'defense'];
  const type = pickType(availableTypes, rng);
  if (type === 'order') return generateOrder(state, notch, id, rng);
  if (type === 'provision') return generateProvision(state, notch, id, provisionCandidates, rng);
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
  if (contract.type === 'provision') {
    contract.limitRemaining = C.PROVISION.LIMIT_MIN * 60;
  }
  if (contract.type === 'order') {
    // Only ducks hatched from THIS moment on count — a shelf of banked
    // off-color ducks fills nothing (the anti-shelf-clearing rule).
    contract.sinceDuckId = state.nextDuckId;
  }
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

// ── Player actions that complete a job (both are explicit clicks — the
// online-only law holds by construction: neither is ever called from tick) ──
/**
 * Deliver against the active BREEDING COMMISSION — every line at once. For
 * each line the auto-pick takes the LOWEST-target-quality qualifying ducks
 * (the player's best fresh stock is kept by default), never a Prime carrier,
 * a SECURED duck (the vault is the player's own declaration of "keep"), or a
 * WINTERING duck (posted workers) — the same protection standing as the cull
 * tools. If any line can't be filled from unprotected stock, the delivery
 * fails with the reason; freeing protected ducks (unsecure/recall) is the
 * explicit path to spending them. Delivered ducks are REMOVED (pairings
 * dropped) and the commission completes.
 */
export function deliverOrder(state: GameState): ActionResult<{ duckIds: string[] }> {
  const c = state.contracts.active;
  if (!c || c.type !== 'order') return fail('No active order');
  if (c.completed) return fail('Contract already complete');

  const chosen: Duck[] = [];
  const taken = new Set<string>();
  for (const line of c.lines) {
    const pool = eligibleForLine(state, c, line).filter(
      (d) => !taken.has(d.id) && !isDeliveryProtected(d),
    );
    if (pool.length < line.count) {
      return fail(`Not enough fresh ${line.color} ${line.sex}s (need ${line.count} — Prime/secured/wintering ducks are never handed over)`);
    }
    pool.sort((a, b) => targetMatch(a.genome, c.target) - targetMatch(b.genome, c.target));
    for (const d of pool.slice(0, line.count)) {
      chosen.push(d);
      taken.add(d.id);
    }
  }

  for (const d of chosen) {
    const idx = state.ducks.findIndex((x) => x.id === d.id);
    state.ducks.splice(idx, 1);
    state.breedingPairs = state.breedingPairs.filter((p) => p.drakeId !== d.id && p.henId !== d.id);
  }
  c.completed = true;
  return done({ duckIds: chosen.map((d) => d.id) });
}

/** Fulfil the active PROVISION ORDER — draws the full amount from central
 *  storage in one shot (fails cleanly, no partial draw, if stock is short). */
export function fulfilProvision(state: GameState): ActionResult<unknown> {
  const c = state.contracts.active;
  if (!c || c.type !== 'provision') return fail('No active provision order');
  if (c.completed) return fail('Contract already complete');
  if (state.resources[c.ingredient] < c.amount) return fail(`Need ${c.amount} ${c.ingredient}`);
  state.resources[c.ingredient] -= c.amount;
  c.completed = true;
  return done(true);
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
 * refresh on the timer, and tick an active provision's deadline (expiry frees
 * the slot with no penalty — orders and defense have no clock; both run until
 * the player either fills or abandons them). The caller (tick.ts) must only
 * invoke this in online mode — nothing here may run during offline catch-up.
 * The provision deadline additionally pauses at GUARD (`active` false): the
 * clocks-only-run-while-you're-there law, extended to the tab-open-idle
 * playstyle — an accepted order must never expire behind an unwatched tab.
 * (The defense contract's scare-count hook is fed separately, from
 * GameEngine's predator-event drain — see onPredatorEvent's doc comment.)
 */
export function runContracts(state: GameState, dt: number, active = true): void {
  // Track the run's peak egg rate ABOVE the tier gate: it's the honest base for
  // the clutch egg cost (breeding.ts clutchCost) and other net pricing (pond.ts
  // upgrades) — a parked/throttled flock can't talk its way down to the floors.
  // Online-only like every other contract clock; wiped with the run by prestige.
  const rate = liveEggRate(state);
  if (rate > (state.contracts.peakEggRate ?? 0)) state.contracts.peakEggRate = rate;

  if (state.legacyTier < C.UNLOCK_TIER) return;
  const cs = state.contracts;

  if (cs.offers.length === 0) refillOffers(state);

  cs.refreshRemaining -= dt;
  if (cs.refreshRemaining <= 0) {
    cs.offers = [];
    refillOffers(state);
    cs.refreshRemaining = C.OFFER_REFRESH_S;
  }

  if (active && cs.active && cs.active.type === 'provision' && !cs.active.completed) {
    cs.active.limitRemaining -= dt;
    if (cs.active.limitRemaining <= 0) {
      // Expired — freed slot, no penalty. Flag it so the engine surfaces a quiet
      // toast: a contract must never vanish with zero feedback (legibility law).
      cs.active = null;
      state.pendingContractExpired = (state.pendingContractExpired ?? 0) + 1;
    }
  }
}
