import { BALANCE } from '../config/balance';
import { onHatch } from './contracts';
import { breedGenome, breedGenotype, isPrimeDuck, isTruebred, maturationMult, recordColor } from './genetics';
import { targetForTier } from './prestige';
import { rollWoundSeverity } from './predators';
import { breedingEstablished, coopCapacity, drainCondition, flockRatio, phenotype, type Duck, type GameState } from './state';

const B = BALANCE.BREEDING;

/**
 * What one clutch draws from storage — priced in seconds of the RUN'S PEAK egg
 * rate (the delivery-quota base, tracked all-tiers in contracts.ts), so a
 * clutch costs the same FRACTION of your economy at any scale; MIN floors the
 * cold start. The single source of truth for the sim, the flow panel, and the
 * pair card.
 */
export function clutchCost(state: GameState): number {
  const peak = state.contracts.peakEggRate ?? 0;
  return Math.max(B.CLUTCH_COST_MIN, Math.round(peak * B.CLUTCH_COST_PEAK_SECONDS));
}

/**
 * Flock RATIO health: an over-drake flock harasses itself into injury. Past the
 * flock-size gate, overcrowding stress accrues (faster the more excess drakes);
 * each onset interval injures a random non-secured, non-wounded adult — reusing
 * the predator WOUND (treatable, escalates to a loss if ignored). The fix is the
 * ratio: cull surplus drakes. Runs online & offline; never grants XP.
 */
export function runOvercrowding(state: GameState, step: number, rng: () => number = Math.random): void {
  // Cheap O(1) gates first — the overwhelming majority of ticks (small flock or
  // breeding not yet established) can't injure, so skip the O(ducks) flockRatio scan.
  if (state.ducks.length < B.OVERCROWD_MIN_FLOCK || !breedingEstablished(state)) {
    state.overcrowdStress = 0;
    return;
  }
  const r = flockRatio(state);
  if (!r.injuring) {
    state.overcrowdStress = 0; // healthy ratio — stress relaxes
    return;
  }
  // Worse the more over-drake, but the speed-up is capped so a hugely over-drake
  // flock injures at a steady ~1/min rather than flooding faster than you can react.
  state.overcrowdStress = (state.overcrowdStress ?? 0) + step * Math.min(r.excess, B.OVERCROWD_RATE_CAP);
  const onset = B.OVERCROWD_INJURY_ONSET_S;
  while (state.overcrowdStress >= onset) {
    state.overcrowdStress -= onset;
    // Victim: any non-secured, non-wounded adult (drakes fight, hens get over-mated).
    const pool = state.ducks.filter(
      (d) => d.stage === 'adult' && !d.secured && !d.wounded && d.site !== 'winter',
    );
    if (pool.length === 0) {
      state.overcrowdStress = 0;
      break;
    }
    const victim = pool[Math.floor(rng() * pool.length)];
    victim.wounded = true;
    victim.woundSource = 'overcrowd';
    victim.woundElapsed = 0;
    victim.severity = rollWoundSeverity(false, victim.genome, rng); // harassment, not a strike
    drainCondition(state, BALANCE.NUTRITION.STRESS.DRAIN.crowdInjury); // self-inflicted stress
    (state.pendingPredatorEvents ??= []).push({ kind: 'crowdInjury', duckId: victim.id, duckName: victim.name });
  }
}

/**
 * Advance the breeding loop and maturation by `dt` seconds. Pairs lay fertilized
 * clutches that incubate into ducklings (genotype + vigor rolled from the pair's
 * parents); ducklings mature duckling -> juvenile -> adult. Runs online & offline
 * (offline at the reduced step). `matureRate` lets Step 5's duckling ration slow
 * maturation; it's 1 until then. New colors are pushed to state.pendingDex.
 * Never grants XP. Hatching is gated by housing capacity. `online` gates the
 * Grange's hatch-spec hook (Phase 6b) — defaults true so existing direct
 * callers (tests, offline-agnostic call sites) keep counting as before;
 * tick.ts passes the real mode so offline hatches never count toward a contract.
 */
export function runBreeding(
  state: GameState,
  step: number,
  matureRate = 1,
  breedRate = 1,
  online = true,
): void {
  const capacity = coopCapacity(state);
  // Home housing houses the HOME flock: winter-assigned ducks (6d) occupy
  // winter-coop slots at their own site (gated at assignment), so they must not
  // block a hatch here. Track the count live as ducklings push mid-loop.
  let homeCount = 0;
  for (const d of state.ducks) if (d.site !== 'winter') homeCount++;
  // The truebred DING is judged against the TIER's champion target (the same one
  // the prestige gate reads), not the player's tracking target.
  const standardTarget = targetForTier(state.legacyTier);
  // Index ducks by id once so pair-parent lookups are O(1) — this ran two
  // `state.ducks.find` per pair every tick (O(pairs × ducks)). Ducklings pushed
  // mid-loop are never pair parents, so the up-front map stays valid.
  const byId = new Map(state.ducks.map((d) => [d.id, d]));

  // ── Pairs: clutch + incubation + hatch ──
  for (const pair of state.breedingPairs) {
    const drake = byId.get(pair.drakeId);
    const hen = byId.get(pair.henId);
    // Pair invalid until both are present adults of the right sex.
    if (!drake || drake.sex !== 'drake' || drake.stage !== 'adult') continue;
    if (!hen || hen.sex !== 'hen' || hen.stage !== 'adult') continue;
    if (drake.wounded || hen.wounded) continue; // Phase 4c: a wounded bird can't breed

    // Lay a fertilized clutch on the interval (bounded queue so it can't pile up).
    // breedRate (drake-ration throttle) scales how fast clutches accrue.
    pair.clutchProgress += step * breedRate;
    // Cap check leaves room for the WHOLE clutch — `< CLUTCH_SIZE * 2` allowed a
    // full clutch to push at one-slot-free, overshooting the bound to 11 of 8.
    // The clutch IS eggs (the 4a dual-purpose law): laying one draws real eggs
    // from storage; unaffordable → it WAITS at the threshold and fires the
    // instant it's funded (throttle, like an input-starved station). Hens also
    // don't nest when the coops are PACKED: with no housing headroom a clutch
    // would just sink its egg cost into a parked hatch-ready queue (a hidden
    // drain at peak-priced costs) and insta-fill slots the moment one frees —
    // so a full flock pins the clutch clock too, and freeing space triggers
    // lay → real incubation → hatch, in that order. (Eggs already incubating
    // when housing fills still park at hatch-ready — they're paid for.)
    const cost = clutchCost(state);
    while (
      pair.clutchProgress >= B.CLUTCH_INTERVAL_S &&
      pair.incubating.length + B.CLUTCH_SIZE <= B.CLUTCH_SIZE * 2 &&
      homeCount < capacity
    ) {
      if (state.resources.eggs < cost) break; // waits — progress clamps below
      state.resources.eggs -= cost;
      pair.clutchProgress -= B.CLUTCH_INTERVAL_S;
      for (let i = 0; i < B.CLUTCH_SIZE; i++) pair.incubating.push(0);
    }
    if (pair.clutchProgress > B.CLUTCH_INTERVAL_S) pair.clutchProgress = B.CLUTCH_INTERVAL_S; // cap if queue full

    // Incubate; hatch into ducklings when housing allows.
    for (let i = pair.incubating.length - 1; i >= 0; i--) {
      pair.incubating[i] += step;
      if (pair.incubating[i] < B.INCUBATE_S) continue;
      if (homeCount >= capacity) {
        pair.incubating[i] = B.INCUBATE_S; // egg waits for a housing slot
        continue;
      }
      const genotype = breedGenotype(drake.genotype, hen.genotype);
      const primeEligible = state.legacyTier >= BALANCE.GENOME.PRIME_MIN_TIER;
      const genome = breedGenome(drake.genome, hen.genome, Math.random, primeEligible);
      // Truebred DING fires when a hatch first achieves the target and the flock
      // had none — so it re-fires if you lose every truebred and rebreed one.
      const hadTruebred = state.ducks.some((d) => isTruebred(d.genome, standardTarget));
      const duckling: Duck = {
        id: `d${state.nextDuckId++}`,
        genotype,
        genome,
        // A built gene-reader auto-reads every new duck (passive/in bulk) — never
        // a per-duck click. Without it the genome stays hidden ("?").
        genomeKnown: state.geneReader,
        sex: Math.random() < 0.5 ? 'drake' : 'hen',
        stage: 'duckling',
        ageTicks: 0,
      };
      state.ducks.push(duckling);
      homeCount++; // hatches live at home
      pair.incubating.splice(i, 1);
      if (recordColor(state, phenotype(genotype))) {
        (state.pendingDex ??= []).push(phenotype(genotype));
      }
      const pCount = genome.filter((g) => g === 'P').length;
      if (isPrimeDuck(genome) && !state.ducks.some((d) => d !== duckling && isPrimeDuck(d.genome))) {
        // THE PRIME DUCK — the rarest hatch there is. Supersedes the ordinary
        // truebred DING for this hatch (a full-Prime IS a truebred via the
        // wildcard; two banners for one duckling would bury the bigger one).
        // Same guard shape as truebred: re-fires only if every Prime Duck is lost.
        state.pendingPrimeDuck = (state.pendingPrimeDuck ?? 0) + 1;
      } else if (
        pCount > 0 &&
        isTruebred(genome, standardTarget) &&
        !state.ducks.some(
          (d) =>
            d !== duckling &&
            isTruebred(d.genome, standardTarget) &&
            d.genome.filter((g) => g === 'P').length >= pCount,
        )
      ) {
        // The celebration LADDER of the Prime chase: a truebred carrying a NEW
        // BEST wildcard count for the flock (first 1-P truebred, first 2-P, …)
        // gets its own beat — the had-a-truebred guard was swallowing these
        // (playtest: 'hit a 6/6 prime, but no fanfare'). Full PPPPPP stays the
        // summit above.
        state.pendingPrimeTruebred = Math.max(state.pendingPrimeTruebred ?? 0, pCount);
      } else if (!hadTruebred && isTruebred(genome, standardTarget)) {
        state.pendingTruebred = (state.pendingTruebred ?? 0) + 1;
      }
      // The Grange (Phase 6b): only an ONLINE hatch may complete a hatch-spec
      // contract — offline catch-up hatches never count (the online-only law).
      if (online) onHatch(state, duckling);
    }
  }

  // ── Maturation: duckling -> juvenile -> adult (matureRate gates the speed,
  //    the duck's own V genes — maturationMult — speed it up). ──
  for (const d of state.ducks) {
    if (d.stage === 'adult') continue;
    d.ageTicks += step * matureRate * maturationMult(d.genome);
    if (d.stage === 'duckling' && d.ageTicks >= B.MATURE_DUCKLING_S) {
      d.stage = 'juvenile';
      d.ageTicks = 0;
    } else if (d.stage === 'juvenile' && d.ageTicks >= B.MATURE_JUVENILE_S) {
      d.stage = 'adult';
      d.ageTicks = 0;
    }
  }
}
