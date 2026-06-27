import { BALANCE } from '../config/balance';
import { breedGenotype, breedVigor, populationMeanVigor, recordColor } from './genetics';
import { coopCapacity, phenotype, type Duck, type GameState } from './state';

const B = BALANCE.BREEDING;

/**
 * Advance the breeding loop and maturation by `dt` seconds. Pairs lay fertilized
 * clutches that incubate into ducklings (genotype + vigor rolled from the pair's
 * parents); ducklings mature duckling -> juvenile -> adult. Runs online & offline
 * (offline at the reduced step). `matureRate` lets Step 5's duckling ration slow
 * maturation; it's 1 until then. New colors are pushed to state.pendingDex.
 * Never grants XP. Hatching is gated by housing capacity.
 */
export function runBreeding(state: GameState, step: number, matureRate = 1): void {
  const capacity = coopCapacity(state);

  // ── Pairs: clutch + incubation + hatch ──
  for (const pair of state.breedingPairs) {
    const drake = state.ducks.find((d) => d.id === pair.drakeId && d.sex === 'drake' && d.stage === 'adult');
    const hen = state.ducks.find((d) => d.id === pair.henId && d.sex === 'hen' && d.stage === 'adult');
    if (!drake || !hen) continue; // pair invalid until both are present adults

    // Lay a fertilized clutch on the interval (bounded queue so it can't pile up).
    pair.clutchProgress += step;
    while (pair.clutchProgress >= B.CLUTCH_INTERVAL_S && pair.incubating.length < B.CLUTCH_SIZE * 2) {
      pair.clutchProgress -= B.CLUTCH_INTERVAL_S;
      for (let i = 0; i < B.CLUTCH_SIZE; i++) pair.incubating.push(0);
    }
    if (pair.clutchProgress > B.CLUTCH_INTERVAL_S) pair.clutchProgress = B.CLUTCH_INTERVAL_S; // cap if queue full

    // Incubate; hatch into ducklings when housing allows.
    const popMean = populationMeanVigor(state);
    for (let i = pair.incubating.length - 1; i >= 0; i--) {
      pair.incubating[i] += step;
      if (pair.incubating[i] < B.INCUBATE_S) continue;
      if (state.ducks.length >= capacity) {
        pair.incubating[i] = B.INCUBATE_S; // egg waits for a housing slot
        continue;
      }
      const genotype = breedGenotype(drake.genotype, hen.genotype);
      const duckling: Duck = {
        id: `d${state.nextDuckId++}`,
        genotype,
        vigor: breedVigor(drake.vigor, hen.vigor, popMean),
        sex: Math.random() < 0.5 ? 'drake' : 'hen',
        stage: 'duckling',
        ageTicks: 0,
      };
      state.ducks.push(duckling);
      pair.incubating.splice(i, 1);
      if (recordColor(state, phenotype(genotype))) {
        (state.pendingDex ??= []).push(phenotype(genotype));
      }
    }
  }

  // ── Maturation: duckling -> juvenile -> adult (matureRate gates the speed) ──
  for (const d of state.ducks) {
    if (d.stage === 'adult') continue;
    d.ageTicks += step * matureRate;
    if (d.stage === 'duckling' && d.ageTicks >= B.MATURE_DUCKLING_S) {
      d.stage = 'juvenile';
      d.ageTicks = 0;
    } else if (d.stage === 'juvenile' && d.ageTicks >= B.MATURE_JUVENILE_S) {
      d.stage = 'adult';
      d.ageTicks = 0;
    }
  }
}
