import { describe, it, expect } from 'vitest';
import { BALANCE, type StationType } from '../src/config/balance';
import { AXES, INGREDIENTS, type Axis, type Ingredient } from '../src/game/state';
import { build, setHens, run } from './helpers';

/**
 * nutrition-metrics — a headless balance sim for the early/mid nutrition economy.
 *
 * Run the readable report with:
 *   NUTRI=1 npx vitest run tests/nutrition-metrics.test.ts
 *
 * It answers: at a given ration, how many of each producer (and mill) does a
 * flock of H laying hens need to keep every axis fed, what's the bottleneck, and
 * does the live sim agree? Everything reads from BALANCE, so it tracks tuning.
 */

const N = BALANCE.NUTRITION;
const COOP_CYCLE = BALANCE.COOP.cycleSeconds; // 4s
const STEP = 0.5; // the ration slider's increment (NutritionPanel)

/** Which station produces each ingredient. */
const PRODUCER: Record<Ingredient, StationType> = {
  corn: 'plot',
  peas: 'peaPatch',
  mealworms: 'mealwormFarm',
  brewersYeast: 'yeastVat',
  oysterShell: 'oysterSource',
};
/** Units/sec one station of each producer makes. */
const PROD_RATE: Record<StationType, number> = {
  plot: BALANCE.PLOT.cornPerCycle / BALANCE.PLOT.cycleSeconds,
  peaPatch: BALANCE.INGREDIENT_PROD.peaPatch.perCycle / BALANCE.INGREDIENT_PROD.peaPatch.cycleSeconds,
  mealwormFarm: BALANCE.INGREDIENT_PROD.mealwormFarm.perCycle / BALANCE.INGREDIENT_PROD.mealwormFarm.cycleSeconds,
  yeastVat: BALANCE.INGREDIENT_PROD.yeastVat.perCycle / BALANCE.INGREDIENT_PROD.yeastVat.cycleSeconds,
  oysterSource: BALANCE.INGREDIENT_PROD.oysterSource.perCycle / BALANCE.INGREDIENT_PROD.oysterSource.cycleSeconds,
  mill: 0,
  coop: 0,
};

type Ration = Record<Ingredient, number>;

/** Producers of each ingredient needed to keep H hens stocked at this ration. */
function producersNeeded(ration: Ration, hens: number): Record<Ingredient, number> {
  const out = {} as Record<Ingredient, number>;
  for (const ing of INGREDIENTS) {
    const demandPerSec = (ration[ing] * hens) / COOP_CYCLE;
    out[ing] = demandPerSec / PROD_RATE[PRODUCER[ing]];
  }
  return out;
}

/** Mills needed (total feed throughput / MILL_CAPACITY). */
function millsNeeded(ration: Ration, hens: number): number {
  const feedPerSec = (sum(ration) * hens) / COOP_CYCLE;
  return feedPerSec / N.MILL_CAPACITY;
}

/** Fully-stocked satisfaction per axis = Σ ration·matrix / requirement. */
function stockedSatisfaction(ration: Ration): Record<Axis, number> {
  const sat = {} as Record<Axis, number>;
  for (const axis of AXES) {
    let supply = 0;
    for (const ing of INGREDIENTS) supply += ration[ing] * (N.INGREDIENT[ing] as Record<Axis, number>)[axis];
    sat[axis] = supply / N.REQUIREMENT[axis];
  }
  return sat;
}

const sum = (r: Ration) => INGREDIENTS.reduce((a, i) => a + r[i], 0);
const onGrid = (v: number) => Math.abs(v / STEP - Math.round(v / STEP)) < 1e-9;
const f = (n: number, w = 5) => n.toFixed(2).padStart(w);

/** Live-sim cross-check: build the homestead, run to steady state, read satisfaction. */
function simCheck(ration: Ration, hens: number, producers: Partial<Record<StationType, number>>) {
  const s = build({ coop: 1, mill: producers.mill ?? 1, ...producers });
  setHens(s, hens);
  s.ration = { ...ration };
  run(s, 300); // long enough to fill storage from empty and settle the EMA
  return {
    satisfaction: s.nutrition!.satisfaction,
    eggMult: s.nutrition!.eggMult,
    feedScale: s.nutrition!.feedScale,
  };
}

function report() {
  const ration = N.DEFAULT_RATION as Ration;
  const lines: string[] = [];
  lines.push('\n================  NUTRITION BALANCE METRICS  ================');
  lines.push(`coop cycle ${COOP_CYCLE}s · slider step ${STEP} · mill cap ${N.MILL_CAPACITY}/s`);

  lines.push('\n-- DEFAULT RATION (units per hen per cycle) --');
  lines.push('  ingredient     ration  on-grid?  prod/s  producers/hen');
  let worst = { ing: '' as Ingredient, perHen: 0 };
  for (const ing of INGREDIENTS) {
    const perHen = producersNeeded(ration, 1)[ing];
    if (perHen > worst.perHen) worst = { ing, perHen };
    lines.push(
      `  ${ing.padEnd(13)} ${f(ration[ing])}    ${onGrid(ration[ing]) ? 'yes' : 'NO '}      ${f(PROD_RATE[PRODUCER[ing]])}   ${f(perHen)}`,
    );
  }
  lines.push(`  mills/hen: ${f(millsNeeded(ration, 1))}   (feed ${f((sum(ration)) / COOP_CYCLE)}/s per hen)`);
  lines.push(`  >> bottleneck producer: ${worst.ing} (${worst.perHen.toFixed(2)} per hen)`);

  lines.push('\n-- fully-stocked satisfaction (≥1 = axis met) --');
  const sat = stockedSatisfaction(ration);
  lines.push('  ' + AXES.map((a) => `${a} ${f(sat[a])}`).join('   '));

  lines.push('\n-- PRODUCERS NEEDED by flock size (ceil), default ration --');
  lines.push('  hens |  plot peaPatch mealworm  yeast  shell | mills | total');
  for (const hens of [2, 4, 6, 8, 12, 16]) {
    const need = producersNeeded(ration, hens);
    const c = (i: Ingredient) => Math.ceil(need[i] - 1e-9);
    const total = INGREDIENTS.reduce((a, i) => a + c(i), 0) + Math.ceil(millsNeeded(ration, hens) - 1e-9);
    lines.push(
      `  ${String(hens).padStart(4)} | ${String(c('corn')).padStart(5)} ${String(c('peas')).padStart(7)} ${String(c('mealworms')).padStart(8)} ${String(c('brewersYeast')).padStart(6)} ${String(c('oysterShell')).padStart(6)} | ${String(Math.ceil(millsNeeded(ration, hens) - 1e-9)).padStart(5)} | ${String(total).padStart(5)}`,
    );
  }

  // Live-sim cross-check at 8 hens with the analytic producer counts.
  const hens = 8;
  const need = producersNeeded(ration, hens);
  const counts: Partial<Record<StationType, number>> = {
    plot: Math.ceil(need.corn),
    peaPatch: Math.ceil(need.peas),
    mealwormFarm: Math.ceil(need.mealworms),
    yeastVat: Math.ceil(need.brewersYeast),
    oysterSource: Math.ceil(need.oysterShell),
    mill: Math.ceil(millsNeeded(ration, hens)),
  };
  const sim = simCheck(ration, hens, counts);
  lines.push(`\n-- LIVE SIM cross-check (${hens} hens, analytic producer counts) --`);
  lines.push('  counts: ' + JSON.stringify(counts));
  lines.push('  sim satisfaction: ' + AXES.map((a) => `${a} ${f(sim.satisfaction[a])}`).join('  '));
  lines.push(`  egg output: ${(sim.eggMult * 100).toFixed(0)}%   feed throughput: ${(sim.feedScale * 100).toFixed(0)}%`);

  // Candidate on-grid rations to compare (same axes met, slider-settable).
  lines.push('\n-- CANDIDATE on-grid rations (bottleneck = max producers/hen) --');
  const candidates: Record<string, Ration> = {
    'current default': ration,
    'rounded on-grid': { corn: 2.5, peas: 1.5, mealworms: 1, brewersYeast: 1.5, oysterShell: 1.5 },
    'lean-protein/peas': { corn: 2, peas: 2.5, mealworms: 0.5, brewersYeast: 1.5, oysterShell: 1.5 },
  };
  for (const [name, r] of Object.entries(candidates)) {
    const ph = producersNeeded(r, 1);
    const bottleneck = INGREDIENTS.reduce((m, i) => Math.max(m, ph[i]), 0);
    const s = stockedSatisfaction(r);
    const allGrid = INGREDIENTS.every((i) => onGrid(r[i]));
    lines.push(
      `  ${name.padEnd(18)} grid:${allGrid ? 'yes' : 'NO '} bottleneck/hen:${f(bottleneck)}  ` +
        AXES.map((a) => `${a[0]}${f(s[a], 4)}`).join(' '),
    );
  }
  lines.push('============================================================\n');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

describe('nutrition balance metrics', () => {
  it('prints the report when NUTRI=1', () => {
    if (process.env.NUTRI) report();
    // Always-on invariant: the default ration meets every axis when fully stocked.
    const sat = stockedSatisfaction(N.DEFAULT_RATION as Ration);
    for (const axis of AXES) expect(sat[axis]).toBeGreaterThanOrEqual(1);
  });

  it('the live sim agrees with the analytic producer counts (8 hens fed)', () => {
    const ration = N.DEFAULT_RATION as Ration;
    const hens = 8;
    const need = producersNeeded(ration, hens);
    const sim = simCheck(ration, hens, {
      plot: Math.ceil(need.corn),
      peaPatch: Math.ceil(need.peas),
      mealwormFarm: Math.ceil(need.mealworms),
      yeastVat: Math.ceil(need.brewersYeast),
      oysterSource: Math.ceil(need.oysterShell),
      mill: Math.ceil(millsNeeded(ration, hens)),
    });
    // With the analytic counts, every egg axis should be effectively fed.
    for (const axis of ['energy', 'protein', 'calcium'] as Axis[]) {
      expect(sim.satisfaction[axis]).toBeGreaterThan(0.9);
    }
  });
});
