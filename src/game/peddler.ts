import { BALANCE } from '../config/balance';
import type { ActionResult } from './actions';
import { currentSeason, seasonsActive } from './season';
import {
  coopCapacity,
  ingredientCap,
  type BarterOffer,
  type BloodlineOffer,
  type Duck,
  type GameState,
  type Gene,
  type Genome,
  type Genotype,
  type Ingredient,
  type PeddlerOffer,
} from './state';

/**
 * peddler.ts — Phase 9e: THE PEDDLER (rank 20).
 *
 * A wandering cart, deliberately NOT the Grange: goods for goods, blood for
 * eggs, never dust/shards/XP. See BALANCE.PEDDLER for the design notes; the
 * two guardrails that keep it a relief valve rather than an economy bypass:
 *   - Barter is priced AGAINST the player (BARTER_RATE on matrix worth) and
 *     quantity-capped — it softens a seasonal crunch, never replaces a
 *     producer line.
 *   - Bloodline ducks are honest stock (never Prime, seed-adjacent weights);
 *     their value is the CLEAN LINEAGE (kinship 0 vs everything you own),
 *     not power. A purchased color never fills the dex — the dex is BRED.
 */

const P = BALANCE.PEDDLER;

export function peddlerOpen(state: GameState): boolean {
  return state.rank >= P.INTRO_RANK;
}

/** An ingredient's total nutritional worth per unit (sum over the matrix) —
 *  the honest common denominator barter prices against. */
export function ingredientWorth(ing: Ingredient): number {
  const vals = BALANCE.NUTRITION.INGREDIENT[ing] as Record<string, number>;
  return Object.values(vals).reduce((a, b) => a + b, 0);
}

/** The ingredient lines the Peddler trades in: the five core lines always;
 *  the winter lines only once the player produces them (post-6d unlock). */
function tradableIngredients(state: GameState): Ingredient[] {
  const core: Ingredient[] = ['corn', 'peas', 'mealworms', 'brewersYeast', 'oysterShell'];
  const winter: Ingredient[] = ['sunflowerSeeds', 'fodderSprouts'];
  return [...core, ...winter.filter((ing) => (state.resources[ing] ?? 0) > 0)];
}

function rollBarter(state: GameState, id: string, rng: () => number): BarterOffer {
  const pool = tradableIngredients(state);
  // Seasonal bias: he tends to carry the season's SCARCE line — the relief
  // valve pointed at the crunch (9c), at the same premium as everything else.
  const scarce = seasonsActive(state) ? (currentSeason(state).scarce as Ingredient) : null;
  const seasonal = scarce != null && pool.includes(scarce) && rng() < P.BARTER_SEASONAL_CHANCE;
  const gives = seasonal ? scarce : pool[Math.floor(rng() * pool.length)];
  const wantsPool = pool.filter((i) => i !== gives);
  const wants = wantsPool[Math.floor(rng() * wantsPool.length)];
  const givesAmount = Math.max(
    P.BARTER_MIN_UNITS,
    Math.round(ingredientCap(state) * P.BARTER_CAP_FRACTION * (0.6 + 0.4 * rng())),
  );
  const wantsAmount = Math.max(
    1,
    Math.ceil((givesAmount * ingredientWorth(gives) * P.BARTER_RATE) / ingredientWorth(wants)),
  );
  return { id, kind: 'barter', gives, givesAmount, wants, wantsAmount, seasonal: seasonal || undefined };
}

/** One weighted draw from the cart's honest stock (never P — see weights). */
function rollStockGene(rng: () => number): Gene {
  const weights = P.DUCK_GENE_WEIGHTS;
  const genes = Object.keys(weights) as Gene[];
  const total = genes.reduce((a, g) => a + weights[g], 0);
  let r = rng() * total;
  for (const g of genes) {
    r -= weights[g];
    if (r < 0) return g;
  }
  return 'D';
}

function rollBloodline(state: GameState, id: string, rng: () => number): BloodlineOffer {
  const genome: Genome = [];
  for (let i = 0; i < BALANCE.GENOME.SLOTS; i++) genome.push(rollStockGene(rng));
  const allele = () => (rng() < 0.5 ? 'Bl' : 'bl');
  const genotype = [allele(), allele()] as Genotype;
  const peak = state.contracts.peakEggRate ?? 0;
  const priceEggs = Math.max(P.DUCK_PRICE_MIN, Math.round(peak * P.DUCK_PRICE_PEAK_SECONDS));
  return {
    id,
    kind: 'bloodline',
    sex: rng() < 0.5 ? 'drake' : 'hen',
    genotype,
    genome,
    priceEggs,
  };
}

export function generatePeddlerOffer(state: GameState, rng: () => number = Math.random): PeddlerOffer {
  const id = `pd${state.peddler.nextOfferId++}`;
  return rng() < P.DUCK_CHANCE ? rollBloodline(state, id, rng) : rollBarter(state, id, rng);
}

function restock(state: GameState, rng: () => number = Math.random): void {
  state.peddler.offers = [];
  for (let i = 0; i < P.OFFER_SLOTS; i++) state.peddler.offers.push(generatePeddlerOffer(state, rng));
  delete state.peddler.commissionUsed; // a fresh cart takes a fresh order
}

/** Board upkeep — online-only (tick.ts gates it), like the Grange: the cart
 *  restocks on its clock; an empty board (fresh unlock, load) fills at once. */
export function runPeddler(state: GameState, dt: number, rng: () => number = Math.random): void {
  if (!peddlerOpen(state)) return;
  if (state.peddler.offers.length === 0) restock(state, rng);
  state.peddler.refreshRemaining -= dt;
  if (state.peddler.refreshRemaining <= 0) {
    restock(state, rng);
    state.peddler.refreshRemaining = P.REFRESH_S;
  }
}

const fail = (reason: string): ActionResult<never> => ({ ok: false, reason });
const done = <T>(value: T): ActionResult<T> => ({ ok: true, value });

/** Take a barter: your `wants` for his `gives`. The offer leaves the board.
 *  Requires store ROOM for the full delivery — clamping away part of a paid
 *  trade would be a silent theft (the Feed Store law stays honest). */
export function acceptBarter(state: GameState, offerId: string): ActionResult<BarterOffer> {
  if (!peddlerOpen(state)) return fail('The Peddler hasn’t come yet');
  const idx = state.peddler.offers.findIndex((o) => o.id === offerId);
  const offer = state.peddler.offers[idx];
  if (!offer || offer.kind !== 'barter') return fail('No such trade');
  if ((state.resources[offer.wants] ?? 0) < offer.wantsAmount) {
    return fail(`Need ${offer.wantsAmount} ${offer.wants}`);
  }
  const cap = ingredientCap(state);
  if (state.resources[offer.gives] + offer.givesAmount > cap) {
    return fail('No room in the Feed Store — drain some stock first');
  }
  state.resources[offer.wants] -= offer.wantsAmount;
  state.resources[offer.gives] += offer.givesAmount;
  state.peddler.offers.splice(idx, 1);
  return done(offer);
}

/** Buy a bloodline duck. It arrives ADULT with no lineage (unrelated to the
 *  whole flock — 9b's outcross valve), auto-read if the reader is built,
 *  and its color does NOT fill the dex (the dex is bred, never bought). */
export function buyBloodline(state: GameState, offerId: string): ActionResult<Duck> {
  if (!peddlerOpen(state)) return fail('The Peddler hasn’t come yet');
  const idx = state.peddler.offers.findIndex((o) => o.id === offerId);
  const offer = state.peddler.offers[idx];
  if (!offer || offer.kind !== 'bloodline') return fail('No such bird');
  if (state.resources.eggs < offer.priceEggs) return fail(`Need ${offer.priceEggs} eggs`);
  const home = state.ducks.filter((d) => d.site !== 'winter').length;
  if (home >= coopCapacity(state)) return fail('No housing — build or upgrade a coop first');
  state.resources.eggs -= offer.priceEggs;
  const duck: Duck = {
    id: `d${state.nextDuckId++}`,
    genotype: [...offer.genotype] as Genotype,
    genome: [...offer.genome],
    genomeKnown: state.geneReader, // the reader reads every arrival — never a per-duck click
    sex: offer.sex,
    stage: 'adult',
    ageTicks: 0,
    // No ancestors, no gen: founder blood — kinship 0 by construction.
  };
  state.ducks.push(duck);
  state.peddler.offers.splice(idx, 1);
  return done(duck);
}

/** Spin the cart early for dust — the Grange reroll's sibling. New goods, a
 *  fresh commission slot; the natural restock clock is untouched. */
export function restockNow(state: GameState, rng: () => number = Math.random): ActionResult<unknown> {
  if (!peddlerOpen(state)) return fail('The Peddler hasn’t come yet');
  const cost = P.RESTOCK_DUST;
  if (state.dust < cost) return fail(`Need ${cost} dust`);
  state.dust -= cost;
  state.peddler.offers = [];
  restock(state, rng);
  return done(true);
}

/** A commission's slot locks: one entry per genome slot — a good gene to lock
 *  it to, or null to roll from his stock. */
export type CommissionLocks = readonly (Gene | null)[];

/** What a made-to-order bird costs: minutes of peak rate, scaling per locked
 *  slot, floored well above the walk-up bloodline. */
export function commissionPrice(state: GameState, lockCount: number): number {
  const peak = state.contracts.peakEggRate ?? 0;
  const seconds = P.COMMISSION_PEAK_SECONDS_BASE + P.COMMISSION_PEAK_SECONDS_PER_LOCK * lockCount;
  return Math.max(P.COMMISSION_PRICE_MIN, Math.round(peak * seconds));
}

/**
 * Commission a bloodline duck to spec: lock 1..MAX good slots (L/V/H only —
 * never Prime, and he won't take money to place a Dud), the rest rolls his
 * honest stock. Arrives adult with no lineage (kinship 0), auto-read only if
 * the reader is built, color never fills the dex — every bloodline law holds.
 * One order per cart visit; any restock (natural or dust-bought) reopens it.
 */
export function commissionBloodline(
  state: GameState,
  sex: 'drake' | 'hen',
  locks: CommissionLocks,
  rng: () => number = Math.random,
): ActionResult<Duck> {
  if (!peddlerOpen(state)) return fail('The Peddler hasn’t come yet');
  if (state.peddler.commissionUsed) return fail('His order book is full — after the next restock');
  if (locks.length !== BALANCE.GENOME.SLOTS) return fail('Bad commission');
  const lockCount = locks.filter((g) => g != null).length;
  if (lockCount < 1) return fail('Name at least one slot');
  if (lockCount > P.COMMISSION_MAX_LOCKS) return fail(`He'll take at most ${P.COMMISSION_MAX_LOCKS} slots to order`);
  if (locks.some((g) => g != null && g !== 'L' && g !== 'V' && g !== 'H')) return fail('He deals in good genes only');
  const price = commissionPrice(state, lockCount);
  if (state.resources.eggs < price) return fail(`Need ${price} eggs`);
  const home = state.ducks.filter((d) => d.site !== 'winter').length;
  if (home >= coopCapacity(state)) return fail('No housing — build or upgrade a coop first');
  state.resources.eggs -= price;
  const genome: Genome = locks.map((g) => g ?? rollStockGene(rng));
  const allele = () => (rng() < 0.5 ? 'Bl' : 'bl');
  const duck: Duck = {
    id: `d${state.nextDuckId++}`,
    genotype: [allele(), allele()] as Genotype,
    genome,
    genomeKnown: state.geneReader, // the reader reads every arrival — never a per-duck click
    sex,
    stage: 'adult',
    ageTicks: 0,
    // No ancestors, no gen: founder blood — kinship 0 by construction.
  };
  state.ducks.push(duck);
  state.peddler.commissionUsed = true;
  return done(duck);
}
