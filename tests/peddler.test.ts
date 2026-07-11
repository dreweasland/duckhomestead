import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { kinship } from '../src/game/genetics';
import {
  acceptBarter,
  buyBloodline,
  generatePeddlerOffer,
  ingredientWorth,
  runPeddler,
} from '../src/game/peddler';
import { deserialize, serialize } from '../src/game/save';
import { initialState, type BarterOffer, type BloodlineOffer, type Duck, type GameState } from '../src/game/state';
import { tick } from '../src/game/tick';
import { build } from './helpers';

const P = BALANCE.PEDDLER;

function atRank(rank = P.INTRO_RANK): GameState {
  const s = initialState(0);
  s.rank = rank;
  return s;
}

/** Roll offers with a scripted first value (the kind roll), then defaults. */
function rollWith(s: GameState, kindRoll: number, rest = 0.5) {
  let first = true;
  return generatePeddlerOffer(s, () => {
    if (first) {
      first = false;
      return kindRoll;
    }
    return rest;
  });
}

describe('the cart: rank-gated, online-only restock, prestige-wiped', () => {
  it('does nothing below rank 20', () => {
    const s = atRank(P.INTRO_RANK - 1);
    runPeddler(s, 1000);
    expect(s.peddler.offers).toHaveLength(0);
  });

  it('fills immediately at rank and restocks on its clock — online only', () => {
    const s = build({ plot: 1 });
    s.rank = P.INTRO_RANK;
    tick(s, 1, { mode: 'online', autoHaul: true });
    expect(s.peddler.offers).toHaveLength(P.OFFER_SLOTS);
    const firstIds = s.peddler.offers.map((o) => o.id);
    // Offline never rotates the cart.
    tick(s, P.REFRESH_S * 3, { mode: 'offline', autoHaul: true });
    expect(s.peddler.offers.map((o) => o.id)).toEqual(firstIds);
    // Online, past the clock, it restocks.
    tick(s, P.REFRESH_S + 1, { mode: 'online', autoHaul: true });
    expect(s.peddler.offers.map((o) => o.id)).not.toEqual(firstIds);
  });

  it('survives a save round-trip; junk offers are dropped', () => {
    const s = atRank();
    runPeddler(s, 1);
    const back = deserialize(serialize(s), 0);
    expect(back.peddler.offers).toHaveLength(P.OFFER_SLOTS);
    const tampered = JSON.parse(serialize(s));
    tampered.peddler.offers.push({ kind: 'timeshare', id: 'x' });
    expect(deserialize(JSON.stringify(tampered), 0).peddler.offers).toHaveLength(P.OFFER_SLOTS);
  });
});

describe('barter: priced against you, capped, honest about room', () => {
  const barter = (s: GameState): BarterOffer => rollWith(s, 0.99) as BarterOffer; // kind roll ≥ DUCK_CHANCE → barter

  it('wants more worth than it gives (BARTER_RATE)', () => {
    const s = atRank();
    for (let i = 0; i < 20; i++) {
      const o = barter(s);
      const givesWorth = o.givesAmount * ingredientWorth(o.gives);
      const wantsWorth = o.wantsAmount * ingredientWorth(o.wants);
      expect(wantsWorth).toBeGreaterThanOrEqual(givesWorth * P.BARTER_RATE * 0.99);
      expect(o.gives).not.toBe(o.wants);
    }
  });

  it('leans seasonal: in winter the cart tends to carry corn, marked', () => {
    const s = atRank();
    s.season.index = 3; // winter → scarce corn
    // rest-roll 0.0 < SEASONAL_CHANCE → the seasonal branch always hits.
    const o = generatePeddlerOffer(s, (() => {
      let n = 0;
      return () => (n++ === 0 ? 0.99 : 0.0);
    })()) as BarterOffer;
    expect(o.gives).toBe('corn');
    expect(o.seasonal).toBe(true);
  });

  it('accept: deducts, delivers, removes the offer; refuses shortfall AND a full store', () => {
    const s = atRank();
    const o = barter(s);
    s.peddler.offers = [o];
    s.resources[o.wants] = o.wantsAmount - 1;
    expect(acceptBarter(s, o.id).ok).toBe(false); // short
    s.resources[o.wants] = o.wantsAmount;
    s.resources[o.gives] = 500; // BASE_CAP — no room for the delivery
    expect(acceptBarter(s, o.id).ok).toBe(false);
    s.resources[o.gives] = 0;
    expect(acceptBarter(s, o.id).ok).toBe(true);
    expect(s.resources[o.wants]).toBe(0);
    expect(s.resources[o.gives]).toBe(o.givesAmount);
    expect(s.peddler.offers).toHaveLength(0);
  });
});

describe('bloodline: the outcross valve, honestly priced, never a shortcut', () => {
  const bloodline = (s: GameState): BloodlineOffer => rollWith(s, 0.0) as BloodlineOffer; // kind roll < DUCK_CHANCE

  it('never rolls Prime, prices off the run peak with a floor', () => {
    const s = atRank();
    for (let i = 0; i < 30; i++) {
      const o = bloodline(s);
      expect(o.genome.includes('P')).toBe(false);
      expect(o.priceEggs).toBe(P.DUCK_PRICE_MIN); // peak 0 → the floor
    }
    s.contracts.peakEggRate = 100;
    expect(bloodline(s).priceEggs).toBe(100 * P.DUCK_PRICE_PEAK_SECONDS);
  });

  it('buy: gates on eggs + housing; the bird arrives adult and UNRELATED', () => {
    const s = build({ coop: 1 }); // seeds a flock with housing
    s.rank = P.INTRO_RANK;
    // Give the seed flock fake deep lineage — the bought bird must still read kin 0.
    for (const d of s.ducks) d.ancestors = ['x1', 'x2', 'g1', 'g2'];
    const o = bloodline(s);
    s.peddler.offers = [o];
    s.resources.eggs = o.priceEggs - 1;
    expect(buyBloodline(s, o.id).ok).toBe(false); // eggs short
    s.resources.eggs = o.priceEggs;
    const before = s.ducks.length;
    const r = buyBloodline(s, o.id);
    expect(r.ok).toBe(true);
    expect(s.ducks).toHaveLength(before + 1);
    expect(s.resources.eggs).toBe(0);
    const bought = s.ducks[s.ducks.length - 1];
    expect(bought.stage).toBe('adult');
    expect(bought.ancestors).toBeUndefined();
    for (const d of s.ducks) if (d !== bought) expect(kinship(bought, d)).toBe(0);
  });

  it('refuses without housing', () => {
    const s = build({ coop: 1 });
    s.rank = P.INTRO_RANK;
    const o = bloodline(s);
    s.peddler.offers = [o];
    s.resources.eggs = o.priceEggs;
    // Fill home housing to the coop cap.
    while (s.ducks.length < 4) {
      s.ducks.push({ ...(s.ducks[0] as Duck), id: `f${s.ducks.length}` });
    }
    expect(buyBloodline(s, o.id).ok).toBe(false);
  });

  it('a purchased color never fills the dex — the dex is bred', () => {
    const s = build({ coop: 1 });
    s.rank = P.INTRO_RANK;
    s.dexSeen = [];
    const o = bloodline(s);
    s.peddler.offers = [o];
    s.resources.eggs = o.priceEggs;
    expect(buyBloodline(s, o.id).ok).toBe(true);
    expect(s.dexSeen).toHaveLength(0);
  });
});
