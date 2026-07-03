import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import {
  initialState,
  INGREDIENTS,
  type Duck,
  type GameState,
  type Gene,
  type Genome,
  type Station,
} from '../src/game/state';
import { admitToInfirmary, repairDeterrents, repairHardwareCloth } from '../src/game/actions';
import { tick } from '../src/game/tick';
import {
  axisTier,
  breedGenome,
  isTruebred,
  layMult,
  hardinessMult,
  slotOdds,
  targetMatch,
  PHENO_AXES,
} from '../src/game/genetics';
import { waterAccess } from '../src/game/water';

/**
 * balance-sim — the headless BALANCE HARNESS (the Fable review's leave-behind).
 *
 * Run the full report with:
 *   npm run sim:balance          (SIM=1 vitest run tests/balance-sim.test.ts --disableConsoleIntercept)
 * Knobs: SIM_HOURS (per-cell online hours, default 12), SIM_DAYS (nightly-cycle
 * days, default 4), SIM_SEEDS (RNG seeds per cell, default 2), SIM_SEED (base).
 *
 * It answers, with numbers straight from the live sim core (tick + BALANCE):
 *   A. NET-OUTPUT BY GENOME STRATEGY across threat regimes — does the optimizer
 *      just breed LLLLLL, or does any predator/water severity make a mixed or
 *      H-heavy flock win on long-run output? (The genome-collapse question.)
 *   B. WINTERSTEAD — where H is *supposed* to pay: premium lay per genome mix.
 *   C. BREEDING PROGRESSION — generations (and est. wall-clock) from a seed
 *      flock to the quality gate and to a truebred, under a min/max policy vs
 *      a phenotype-band-only casual policy, swept over DOMINANCE × MUTATION.
 *
 * Everything reads BALANCE at call time, so it tracks tuning changes. The
 * sweep TEMPORARILY mutates BALANCE.GENOME (restored in finally) — vitest runs
 * this file in its own process, so nothing leaks.
 *
 * A few fast invariant tests run on every `npm test` (no SIM env needed) so the
 * genome design thesis stays guarded in CI; the heavy report is SIM-gated.
 *
 * NOTE: the harness builds lab states by pushing stations/ducks directly into
 * GameState (bypassing placement costs/rules) — it measures the ECONOMY, not
 * the build UX. Player behavior is modeled as explicit policies (attentive
 * admit/repair cadences), because H's value is precisely "what happens when a
 * hit lands", which depends on care.
 */

// ── tiny seeded RNG (mulberry32) so every cell is reproducible ────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const g = (s: string): Genome => s.split('') as Gene[];
const f = (n: number, w = 8, d = 0) => n.toFixed(d).padStart(w);
const pct = (n: number, w = 7) => `${(n * 100).toFixed(1).padStart(w - 1)}%`;

// ── lab-state builders (bypass placement rules on purpose) ────────────
let nextId = 1;
function mkStation(type: Station['type'], x: number, y: number, zoneId = 'yard', level = 1): Station {
  return { id: `s${nextId++}`, type, zoneId, x, y, level, cycleProgress: 0, buffer: {}, tendCooldownRemaining: 0 };
}
function mkHen(genome: Genome, i: number, site?: 'home' | 'winter'): Duck {
  return {
    id: `h${i}`,
    genotype: ['Bl', 'bl'],
    genome: [...genome],
    genomeKnown: true,
    sex: 'hen',
    stage: 'adult',
    ageTicks: 0,
    ...(site ? { site } : {}),
  };
}
function stockAll(s: GameState, v = 1e8): void {
  for (const k of INGREDIENTS) s.resources[k] = v;
}

interface HomeOpts {
  hens: number;
  genome: Genome;
  /** Water severity: access ratio ≈ 0.2 (yard puddle) / ~1.2 / ~2.4. */
  water: 'low' | 'ok' | 'flush';
  /** Built defense floor: none, or 3 nets + 3 cloth (floor 0.54·integrity each). */
  defenses: 'none' | 'built';
  /** Rank 15 → owl + raccoon live; rank 3 → predators dormant ("safe"). */
  predators: boolean;
  infirmaries?: number;
}

function buildHome(o: HomeOpts): GameState {
  const s = initialState(0);
  s.rank = o.predators ? 15 : 3;
  s.autoHaulUnlocked = true;
  s.ration = { ...BALANCE.NUTRITION.DEFAULT_RATION };
  stockAll(s);
  // One high-level mill covers blend capacity for any flock here; one coop is
  // the lay-collection point. No producers — storage is pre-stocked (we isolate
  // the genome/threat economy from the nutrition-layout puzzle, which is
  // genome-independent and identical across strategies).
  s.stations.push(mkStation('mill', 0, 0, 'yard', 10), mkStation('coop', 1, 0));
  s.ducks = Array.from({ length: o.hens }, (_, i) => mkHen(o.genome, i));
  // Water: push pond features directly (provision math reads features, not the
  // zone gate). Works stays locked → circulationHealth pegs at 1 (kept clean).
  const deepLevel = o.water === 'flush' ? 3 : 1;
  if (o.water !== 'low') {
    for (let i = 0; i < 5; i++) s.pond.features.push({ x: i, y: 0, type: 'deepZone', level: deepLevel });
  }
  if (o.predators) {
    s.predatorsIntroduced = true;
    s.predatorsSeen = ['owl', 'raccoon'];
    if (o.defenses === 'built') {
      s.deterrents = 3; // floor 0.54 (× integrity)
      s.hardwareCloth = 3;
    }
    s.infirmaries = o.infirmaries ?? 3; // 6 recovery slots
  }
  s.resources.eggs = 100_000; // repair/treatment float; netted out by the caller
  return s;
}

function drainEvents(s: GameState, c: { wounds: number; deaths: number }): void {
  for (const e of s.pendingPredatorEvents ?? []) {
    if (e.kind === 'wound' || e.kind === 'crowdInjury') c.wounds++;
    if (e.kind === 'escalated' || e.kind === 'snatched') c.deaths++;
  }
  s.pendingPredatorEvents = [];
}

/** Online play with an explicit care policy. attentive: admit wounded every 30s,
 *  repair defenses every 600s when integrity < 0.9. negligent: never intervene. */
function runOnline(
  s: GameState,
  hours: number,
  policy: 'attentive' | 'negligent',
  rng: () => number,
  c: { wounds: number; deaths: number },
): void {
  const dt = 0.5;
  const steps = Math.round((hours * 3600) / dt);
  for (let i = 0; i < steps; i++) {
    tick(s, dt, { mode: 'online', autoHaul: true, rng });
    drainEvents(s, c);
    const t = i * dt;
    if (policy === 'attentive') {
      if (t % 30 < dt) {
        for (const d of s.ducks) if (d.wounded && !d.recovering) admitToInfirmary(s, d.id);
      }
      if (t % 600 < dt) {
        if (s.deterrents > 0 && s.deterrentIntegrity < 0.9) repairDeterrents(s);
        if (s.hardwareCloth > 0 && s.hardwareClothIntegrity < 0.9) repairHardwareCloth(s);
      }
    }
  }
}

/** Offline catch-up night, faithful to save.ts (1s steps, mercy budget, auto-admit). */
function runOffline(s: GameState, hours: number, rng: () => number, c: { wounds: number; deaths: number }): void {
  const unsecured = s.ducks.filter((d) => !d.secured).length;
  const predatorLossBudget = {
    remaining: Math.floor(unsecured * BALANCE.PREDATORS.MAX_OFFLINE_LOSS_FRACTION),
  };
  for (let i = 0; i < hours * 3600; i++) {
    tick(s, 1, { mode: 'offline', autoHaul: true, rng, predatorLossBudget });
    drainEvents(s, c);
  }
}

const totalEggs = (s: GameState): number =>
  s.resources.eggs + s.stations.reduce((a, st) => a + (st.buffer.eggs ?? 0), 0);

interface CellResult {
  eggs: number;
  wounds: number;
  deaths: number;
  hensLeft: number;
}

/** One strategy × regime cell, averaged over seeds. */
function runCell(
  genome: Genome,
  regime: string,
  seeds: number,
  hours: number,
  days: number,
  baseSeed: number,
): CellResult {
  const acc: CellResult = { eggs: 0, wounds: 0, deaths: 0, hensLeft: 0 };
  for (let seed = 0; seed < seeds; seed++) {
    const rng = mulberry32(baseSeed + seed * 7919);
    const c = { wounds: 0, deaths: 0 };
    let s: GameState;
    if (regime === 'safe') {
      s = buildHome({ hens: 30, genome, water: 'ok', defenses: 'none', predators: false });
      const start = totalEggs(s);
      runOnline(s, hours, 'attentive', rng, c);
      acc.eggs += totalEggs(s) - start;
    } else if (regime === 'guarded') {
      s = buildHome({ hens: 30, genome, water: 'ok', defenses: 'built', predators: true });
      const start = totalEggs(s);
      runOnline(s, hours, 'attentive', rng, c);
      acc.eggs += totalEggs(s) - start;
    } else if (regime === 'exposed') {
      s = buildHome({ hens: 30, genome, water: 'low', defenses: 'none', predators: true });
      const start = totalEggs(s);
      runOnline(s, hours, 'attentive', rng, c);
      acc.eggs += totalEggs(s) - start;
    } else if (regime === 'negligent') {
      s = buildHome({ hens: 30, genome, water: 'low', defenses: 'built', predators: true, infirmaries: 0 });
      const start = totalEggs(s);
      runOnline(s, hours, 'negligent', rng, c);
      acc.eggs += totalEggs(s) - start;
    } else if (regime === 'nightly') {
      // days × (4h attentive online + 8h offline). The realistic worst case:
      // windows keep running on wall-clock while away.
      s = buildHome({ hens: 30, genome, water: 'ok', defenses: 'built', predators: true });
      const start = totalEggs(s);
      for (let d = 0; d < days; d++) {
        runOnline(s, 4, 'attentive', rng, c);
        runOffline(s, 8, rng, c);
      }
      acc.eggs += totalEggs(s) - start;
    } else {
      // 'lapsed': the failure mode — no defenses, NO infirmaries (every wound is
      // terminal), bad water, nightly absences, wounds ignored while online.
      // The one regime where Hardy should preserve capital across nights.
      s = buildHome({ hens: 30, genome, water: 'low', defenses: 'none', predators: true, infirmaries: 0 });
      const start = totalEggs(s);
      for (let d = 0; d < days; d++) {
        runOnline(s, 4, 'negligent', rng, c);
        runOffline(s, 8, rng, c);
      }
      acc.eggs += totalEggs(s) - start;
    }
    acc.wounds += c.wounds;
    acc.deaths += c.deaths;
    acc.hensLeft += s.ducks.filter((d) => d.stage === 'adult').length;
  }
  return {
    eggs: acc.eggs / seeds,
    wounds: acc.wounds / seeds,
    deaths: acc.deaths / seeds,
    hensLeft: acc.hensLeft / seeds,
  };
}

// ── B. Winterstead lab ────────────────────────────────────────────────
function buildWinter(genome: Genome, hens = 8): GameState {
  const s = initialState(0);
  s.rank = 25;
  s.legacyTier = 3;
  s.autoHaulUnlocked = true;
  s.zones['winterstead'] = { unlocked: true };
  stockAll(s);
  s.winterRation = { ...BALANCE.WINTER.DEFAULT_RATION };
  s.stations.push(
    mkStation('winterCoop', 0, 0, 'winterstead'),
    mkStation('winterCoop', 2, 0, 'winterstead'),
    mkStation('heater', 1, 0, 'winterstead'), // covers both coops (Chebyshev 1)
    mkStation('heatedWaterer', 0, 2, 'winterstead'),
    mkStation('heatedWaterer', 1, 2, 'winterstead'),
  );
  s.ducks = Array.from({ length: hens }, (_, i) => mkHen(genome, i, 'winter'));
  return s;
}

/** Deterministic winter lay over 600s (no predators at Winterstead, no RNG). */
function winterEggs(genome: Genome): number {
  const s = buildWinter(genome);
  const start = totalEggs(s);
  for (let i = 0; i < 1200; i++) tick(s, 0.5, { mode: 'online', autoHaul: true });
  return totalEggs(s) - start;
}

/** Same hens laying at HOME instead (stocked, safe) over 600s — the opportunity cost. */
function homeEggs(genome: Genome, hens = 8): number {
  const s = buildHome({ hens, genome, water: 'ok', defenses: 'none', predators: false });
  const start = totalEggs(s);
  for (let i = 0; i < 1200; i++) tick(s, 0.5, { mode: 'online', autoHaul: true });
  return totalEggs(s) - start;
}

// ── C. Breeding progression (pure genetics — no tick) ────────────────
interface BreedRun {
  gensToGate: number; // mean program quality ≥ QUALITY_GATE_BASE (-1 = never)
  gensToGod: number; // first truebred (-1 = never)
  finalMean: number;
}

function rollSeedGenomeWith(rng: () => number): Genome {
  const w = BALANCE.GENOME.SEED_GENE_WEIGHTS;
  const pool: Gene[] = ['L', 'V', 'H', 'D'];
  const total = pool.reduce((a, x) => a + (w[x] ?? 0), 0);
  const out: Genome = [];
  for (let i = 0; i < BALANCE.GENOME.SLOTS; i++) {
    let r = rng() * total;
    let pick: Gene = 'D';
    for (const x of pool) {
      r -= w[x] ?? 0;
      if (r < 0) {
        pick = x;
        break;
      }
    }
    out.push(pick);
  }
  return out;
}

/** Expected per-cross match toward `target` — what the in-game calculator shows. */
function expectedMatch(a: Genome, b: Genome, target: Genome): number {
  const odds = slotOdds(a, b);
  let e = 0;
  for (let i = 0; i < target.length; i++) e += odds[i][target[i]] ?? 0;
  return e;
}

/**
 * One breeding-program run. POP genomes; each generation the policy picks
 * parents, breeds POP offspring, then culls the merged pool back to POP.
 *  - 'sweat': gene-reader built — rank by exact targetMatch, breed the 3 best
 *    complementary pairs (by slotOdds expected match — the in-game calculator).
 *  - 'casual': phenotype bands only — rank by band score toward the target's
 *    axis profile; pair top ducks blindly.
 */
function breedingRun(
  policy: 'sweat' | 'casual',
  target: Genome,
  rng: () => number,
  maxGens = 120,
  POP = 24,
): BreedRun {
  let pop: Genome[] = Array.from({ length: POP }, () => rollSeedGenomeWith(rng));
  const gate = BALANCE.PRESTIGE.QUALITY_GATE_BASE;
  const bandScore = (gm: Genome): number => {
    // A casual player reads the free bands: weight each visible axis by how
    // many slots of the target want its gene (L→lay, V→vigor, H→hardy).
    const want: Record<string, number> = { L: 0, V: 0, H: 0 };
    for (const t of target) want[t] = (want[t] ?? 0) + 1;
    const axisOf: Record<string, (typeof PHENO_AXES)[number]> = { L: 'lay', V: 'vigor', H: 'hardy' };
    let sc = 0;
    for (const gene of ['L', 'V', 'H'] as const) {
      if (want[gene] > 0) sc += want[gene] * axisTier(gm, axisOf[gene]);
    }
    return sc + rng() * 0.01; // random tiebreak
  };
  let gensToGate = -1;
  let gensToGod = -1;
  for (let gen = 1; gen <= maxGens; gen++) {
    const ranked = [...pop].sort((a, b) =>
      policy === 'sweat' ? targetMatch(b, target) - targetMatch(a, target) : bandScore(b) - bandScore(a),
    );
    const top = ranked.slice(0, 8);
    // Pick the 3 best pairs among the top 8 — 'sweat' scores pairs with the
    // in-game odds preview; 'casual' just pairs 1-2, 3-4, 5-6.
    let pairs: [Genome, Genome][];
    if (policy === 'sweat') {
      const all: { pair: [Genome, Genome]; e: number }[] = [];
      for (let i = 0; i < top.length; i++)
        for (let j = i + 1; j < top.length; j++)
          all.push({ pair: [top[i], top[j]], e: expectedMatch(top[i], top[j], target) });
      all.sort((a, b) => b.e - a.e);
      pairs = all.slice(0, 3).map((p) => p.pair);
    } else {
      pairs = [
        [top[0], top[1]],
        [top[2], top[3]],
        [top[4], top[5]],
      ];
    }
    const offspring: Genome[] = [];
    for (let k = 0; k < POP; k++) {
      const [a, b] = pairs[k % pairs.length];
      offspring.push(breedGenome(a, b, rng));
    }
    // Cull the merged pool back to POP — truncation selection, the game's lever.
    pop = [...pop, ...offspring]
      .sort((a, b) => targetMatch(b, target) - targetMatch(a, target))
      .slice(0, POP);
    const mean = pop.reduce((a, gm) => a + targetMatch(gm, target), 0) / POP;
    if (gensToGate < 0 && mean >= gate) gensToGate = gen;
    if (gensToGod < 0 && pop.some((gm) => isTruebred(gm, target))) gensToGod = gen;
    if (gensToGate >= 0 && gensToGod >= 0) return { gensToGate, gensToGod, finalMean: mean };
  }
  const mean = pop.reduce((a, gm) => a + targetMatch(gm, target), 0) / POP;
  return { gensToGate, gensToGod, finalMean: mean };
}

/** Wall-clock estimate per generation (s): clutch + incubate + both maturations. */
function generationSeconds(vGenes = 0): number {
  const B = BALANCE.BREEDING;
  const matureMult = 1 + BALANCE.GENOME.STAT_PER_GENE.V.maturationSpeed! * vGenes;
  return B.CLUTCH_INTERVAL_S + B.INCUBATE_S + (B.MATURE_DUCKLING_S + B.MATURE_JUVENILE_S) / matureMult;
}

// ── Always-on invariants (fast; guard the genome design thesis in CI) ─
describe('genome economy invariants', () => {
  it('home economy: L strictly out-lays every other gene (the collapse risk is real at home)', () => {
    expect(layMult(g('LLLLLL'))).toBeGreaterThan(layMult(g('LLVVHH')));
    expect(layMult(g('LLVVHH'))).toBeGreaterThan(layMult(g('HHHHHH')));
  });

  it('Winterstead: a mixed L/H genome out-earns the all-L truebred THERE (the 6d thesis)', () => {
    const allL = winterEggs(g('LLLLLL'));
    const mixed = winterEggs(g('LLLHHH'));
    const lh24 = winterEggs(g('LLHHHH'));
    expect(mixed).toBeGreaterThan(allL);
    expect(lh24).toBeGreaterThan(allL);
    // And at home the same mixed genome loses — "best duck is contextual".
    expect(homeEggs(g('LLLLLL'))).toBeGreaterThan(homeEggs(g('LLLHHH')));
  });

  it('harness smoke: a guarded predator regime runs without throwing', () => {
    const rng = mulberry32(1);
    const c = { wounds: 0, deaths: 0 };
    const s = buildHome({ hens: 12, genome: g('LLVVHH'), water: 'ok', defenses: 'built', predators: true });
    runOnline(s, 0.25, 'attentive', rng, c);
    expect(s.ducks.length).toBeGreaterThan(0);
  });
});

// ── The SIM-gated full report ─────────────────────────────────────────
const SIM = !!process.env.SIM;
const HOURS = Number(process.env.SIM_HOURS ?? 12);
const DAYS = Number(process.env.SIM_DAYS ?? 4);
const SEEDS = Number(process.env.SIM_SEEDS ?? 2);
const BASE_SEED = Number(process.env.SIM_SEED ?? 1234);

const STRATEGIES: [string, Genome][] = [
  ['LLLLLL', g('LLLLLL')],
  ['LLLVVV', g('LLLVVV')],
  ['LLVVHH', g('LLVVHH')],
  ['LLLHHH', g('LLLHHH')],
  ['LLHHHH', g('LLHHHH')],
  ['HHHHHH', g('HHHHHH')],
  ['VVVVVV', g('VVVVVV')],
  ['DDDDDD', g('DDDDDD')],
];

describe.runIf(SIM)('balance-sim report', () => {
  it('A. strategy × regime net output (the genome-collapse table)', () => {
    const regimes = ['safe', 'guarded', 'exposed', 'negligent', 'nightly', 'lapsed'];
    console.log(`\n═══ A. NET OUTPUT BY STRATEGY (30 hens, ${HOURS}h online regimes, nightly=${DAYS}d of 4h on + 8h off, ${SEEDS} seed(s)) ═══`);
    console.log(
      'regime      strategy      eggs   vs LLLLLL   wounds  deaths  hens-left',
    );
    for (const regime of regimes) {
      let ref = 0;
      for (const [name, genome] of STRATEGIES) {
        const r = runCell(genome, regime, SEEDS, HOURS, DAYS, BASE_SEED);
        if (name === 'LLLLLL') ref = r.eggs;
        console.log(
          `${regime.padEnd(11)} ${name.padEnd(9)} ${f(r.eggs, 9)}  ${pct(ref > 0 ? r.eggs / ref : 0, 8)}  ${f(r.wounds, 6, 1)} ${f(r.deaths, 7, 1)} ${f(r.hensLeft, 8, 1)}`,
        );
      }
      console.log('');
    }
    expect(true).toBe(true);
  }, 1_800_000);

  it('B. Winterstead premium lay per genome mix (+ home opportunity cost)', () => {
    console.log('\n═══ B. WINTERSTEAD (8 hens, 600s, heated+watered+fed) ═══');
    console.log('strategy    winter-eggs  home-eggs   winter/home   winter vs winter-LLLLLL');
    const refW = winterEggs(g('LLLLLL'));
    for (const [name, genome] of STRATEGIES) {
      const w = winterEggs(genome);
      const h = homeEggs(genome);
      console.log(
        `${name.padEnd(11)} ${f(w, 9, 0)} ${f(h, 10, 0)}   ${f(w / h, 9, 2)}   ${pct(w / refW, 10)}`,
      );
    }
    // Sweep: which L/H split maximizes winter lay under current HARDINESS_PER_H?
    console.log('\nL/H split sweep (analytic layMult × hardinessMult):');
    for (let h = 0; h <= 6; h++) {
      const gm = g('L'.repeat(6 - h) + 'H'.repeat(h));
      console.log(`  L${6 - h}H${h}: ${(layMult(gm) * hardinessMult(gm)).toFixed(3)}`);
    }
    expect(true).toBe(true);
  }, 600_000);

  it('C. breeding progression: DOMINANCE × MUTATION sweep (sweat vs casual)', () => {
    const G = BALANCE.GENOME as unknown as {
      MUTATION_CHANCE: number;
      DOMINANCE: Record<string, number>;
    };
    const origMut = G.MUTATION_CHANCE;
    const origDom = { ...G.DOMINANCE };
    const targetT0 = g('LLLLLL');
    const targetT4 = g('LHLHLH');
    const runs = 6; // averaged runs per cell
    try {
      console.log('\n═══ C. BREEDING PROGRESSION (pop 24, avg of 6 runs; gens to mean-quality gate 4.5 / to first truebred) ═══');
      console.log('dom  mut    policy  target    gens→gate  gens→god   est-hours→god  final-mean');
      for (const dom of [2, 3, 4]) {
        for (const mut of [0.01, 0.02, 0.04, 0.08]) {
          G.MUTATION_CHANCE = mut;
          G.DOMINANCE.L = dom;
          G.DOMINANCE.V = dom;
          G.DOMINANCE.H = dom;
          for (const policy of ['sweat', 'casual'] as const) {
            for (const [tname, target] of [['LLLLLL', targetT0], ['LHLHLH', targetT4]] as const) {
              let gate = 0;
              let god = 0;
              let mean = 0;
              let godFails = 0;
              let gateFails = 0;
              for (let r = 0; r < runs; r++) {
                const res = breedingRun(policy, [...target], mulberry32(BASE_SEED + r * 104729));
                gate += res.gensToGate < 0 ? 0 : res.gensToGate;
                god += res.gensToGod < 0 ? 0 : res.gensToGod;
                if (res.gensToGate < 0) gateFails++;
                if (res.gensToGod < 0) godFails++;
                mean += res.finalMean;
              }
              const gateOk = runs - gateFails;
              const godOk = runs - godFails;
              const gGate = gateOk > 0 ? gate / gateOk : -1;
              const gGod = godOk > 0 ? god / godOk : -1;
              const hours = gGod > 0 ? (gGod * generationSeconds()) / 3600 : -1;
              console.log(
                `${f(dom, 3)}  ${mut.toFixed(2)}  ${policy.padEnd(7)} ${tname}  ${f(gGate, 8, 1)}${gateFails ? `(${gateFails}✗)` : '   '} ${f(gGod, 8, 1)}${godFails ? `(${godFails}✗)` : '   '} ${f(hours, 10, 1)} ${f(mean / runs, 10, 2)}`,
              );
            }
          }
        }
      }
    } finally {
      G.MUTATION_CHANCE = origMut;
      Object.assign(G.DOMINANCE, origDom);
    }
    expect(true).toBe(true);
  }, 600_000);

  it('D. marginal per-gene value (analytic, current BALANCE)', () => {
    const base = BALANCE.COOP.eggPerCycle / BALANCE.COOP.cycleSeconds; // eggs/s/hen at layMult 1
    const perL = BALANCE.GENOME.STAT_PER_GENE.L.eggOutput! * base * 3600;
    const perV = BALANCE.GENOME.STAT_PER_GENE.V.eggOutput! * base * 3600;
    console.log('\n═══ D. MARGINAL VALUE PER GENE (per hen per hour, home, full nutrition) ═══');
    console.log(`  L: +${perL.toFixed(1)} eggs/h (direct)`);
    console.log(`  V: +${perV.toFixed(1)} eggs/h (direct) + maturation ${(BALANCE.GENOME.STAT_PER_GENE.V.maturationSpeed! * 100).toFixed(0)}%/gene (transient — only while growing the flock)`);
    console.log(`  H: 0 eggs/h direct. Value = ${(BALANCE.GENOME.STAT_PER_GENE.H.woundResist! * 100).toFixed(0)}%/gene wound-shrug × (per-hen wound rate × cost per wound) + winter hardiness ${(BALANCE.WINTER.HARDINESS_PER_H * 100).toFixed(0)}%/gene`);
    console.log(`  Break-even: swapping one L→H needs the avoided-loss stream to beat ${perL.toFixed(1)} eggs/h/hen.`);
    console.log(`  Per-flock predator pressure is O(1) (fixed attacks/window), so per-hen H value ∝ 1/flock-size — see table A for the measured crossover (if any).`);
    const s = buildHome({ hens: 30, genome: g('LLLLLL'), water: 'ok', defenses: 'none', predators: false });
    console.log(`  (check: water access ratio in the 'ok' regime = ${waterAccess(s).toFixed(2)})`);
    expect(true).toBe(true);
  });
});
