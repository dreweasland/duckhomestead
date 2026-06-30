import { BALANCE } from '../config/balance';
import { breedGenome, breedGenotype, isGodClone, maturationMult, recordColor } from './genetics';
import { coopCapacity, flockRatio, phenotype, type Duck, type GameState } from './state';

const B = BALANCE.BREEDING;

/**
 * Flock RATIO health: an over-drake flock harasses itself into injury. Past the
 * flock-size gate, overcrowding stress accrues (faster the more excess drakes);
 * each onset interval injures a random non-secured, non-wounded adult — reusing
 * the predator WOUND (treatable, escalates to a loss if ignored). The fix is the
 * ratio: cull surplus drakes. Runs online & offline; never grants XP.
 */
export function runOvercrowding(state: GameState, step: number, rng: () => number = Math.random): void {
  const r = flockRatio(state);
  if (!r.injuring) {
    state.overcrowdStress = 0; // healthy ratio (or below the gate) — stress relaxes
    return;
  }
  state.overcrowdStress = (state.overcrowdStress ?? 0) + step * r.excess; // worse the more over-drake
  const onset = B.OVERCROWD_INJURY_ONSET_S;
  while (state.overcrowdStress >= onset) {
    state.overcrowdStress -= onset;
    // Victim: any non-secured, non-wounded adult (drakes fight, hens get over-mated).
    const pool = state.ducks.filter((d) => d.stage === 'adult' && !d.secured && !d.wounded);
    if (pool.length === 0) {
      state.overcrowdStress = 0;
      break;
    }
    const victim = pool[Math.floor(rng() * pool.length)];
    victim.wounded = true;
    victim.woundElapsed = 0;
    (state.pendingPredatorEvents ??= []).push({ kind: 'crowdInjury', duckId: victim.id });
  }
}

/**
 * Advance the breeding loop and maturation by `dt` seconds. Pairs lay fertilized
 * clutches that incubate into ducklings (genotype + vigor rolled from the pair's
 * parents); ducklings mature duckling -> juvenile -> adult. Runs online & offline
 * (offline at the reduced step). `matureRate` lets Step 5's duckling ration slow
 * maturation; it's 1 until then. New colors are pushed to state.pendingDex.
 * Never grants XP. Hatching is gated by housing capacity.
 */
export function runBreeding(state: GameState, step: number, matureRate = 1, breedRate = 1): void {
  const capacity = coopCapacity(state);

  // ── Pairs: clutch + incubation + hatch ──
  for (const pair of state.breedingPairs) {
    const drake = state.ducks.find((d) => d.id === pair.drakeId && d.sex === 'drake' && d.stage === 'adult');
    const hen = state.ducks.find((d) => d.id === pair.henId && d.sex === 'hen' && d.stage === 'adult');
    if (!drake || !hen) continue; // pair invalid until both are present adults
    if (drake.wounded || hen.wounded) continue; // Phase 4c: a wounded bird can't breed

    // Lay a fertilized clutch on the interval (bounded queue so it can't pile up).
    // breedRate (drake-ration throttle) scales how fast clutches accrue.
    pair.clutchProgress += step * breedRate;
    while (pair.clutchProgress >= B.CLUTCH_INTERVAL_S && pair.incubating.length < B.CLUTCH_SIZE * 2) {
      pair.clutchProgress -= B.CLUTCH_INTERVAL_S;
      for (let i = 0; i < B.CLUTCH_SIZE; i++) pair.incubating.push(0);
    }
    if (pair.clutchProgress > B.CLUTCH_INTERVAL_S) pair.clutchProgress = B.CLUTCH_INTERVAL_S; // cap if queue full

    // Incubate; hatch into ducklings when housing allows.
    for (let i = pair.incubating.length - 1; i >= 0; i--) {
      pair.incubating[i] += step;
      if (pair.incubating[i] < B.INCUBATE_S) continue;
      if (state.ducks.length >= capacity) {
        pair.incubating[i] = B.INCUBATE_S; // egg waits for a housing slot
        continue;
      }
      const genotype = breedGenotype(drake.genotype, hen.genotype);
      const genome = breedGenome(drake.genome, hen.genome);
      // God-clone DING fires when a hatch first achieves the target and the flock
      // had none — so it re-fires if you lose every god clone and rebreed one.
      const hadGodClone = state.ducks.some((d) => isGodClone(d.genome, state.genomeTarget));
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
      pair.incubating.splice(i, 1);
      if (recordColor(state, phenotype(genotype))) {
        (state.pendingDex ??= []).push(phenotype(genotype));
      }
      if (!hadGodClone && isGodClone(genome, state.genomeTarget)) {
        state.pendingGodClone = (state.pendingGodClone ?? 0) + 1;
      }
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
