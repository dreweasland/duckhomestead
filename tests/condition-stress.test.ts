import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { assignToWinter, placeStation } from '../src/game/actions';
import { runBreeding, runOvercrowding } from '../src/game/breeding';
import { runPredators } from '../src/game/predators';
import { drainCondition, initialState, type Duck, type GameState } from '../src/game/state';
import { waterWoundMult } from '../src/game/water';
import { FLAT_GENOME, fullSetup, run, setHens, stockAll } from './helpers';

/**
 * CONDITION REWORK (stress battery): harm events drain the flock-condition
 * battery in attributable chunks, and a rattled flock lays at a direct, gentle,
 * floored penalty — but ONLY while nutrition is green (the fed blend), so the
 * existing mask keeps sole ownership of feed shortfalls.
 */

const N = BALANCE.NUTRITION;
const S = N.STRESS;
const MAX = N.CONDITION_MAX;
const zero = () => 0; // rng: every roll "hits" (attacks land, no shrug, no snatch)

/** A green, steady homestead: stocked, default ration, condition settled at max. */
function greenSteady(hens = 2): GameState {
  const s = setHens(stockAll(fullSetup()), hens);
  s.ration = { ...N.DEFAULT_RATION };
  run(s, 60);
  expect(s.condition).toBeGreaterThan(MAX * 0.99);
  expect(s.nutrition!.eggMultRaw).toBeGreaterThanOrEqual(0.99);
  return s;
}

describe('harm events drain the battery (attributable chunks)', () => {
  it('a landed predator hit drains DRAIN.wound', () => {
    const s = greenSteady();
    s.rank = BALANCE.PREDATORS.INTRO_RANK;
    s.predatorsIntroduced = true;
    s.predatorsSeen = ['owl'];
    s.predators.owl = { timeToNextWindow: 0, windowRemaining: 60, windowElapsed: 0, attacksFired: 0 };
    // Offline resolves attacks at their stagger times (2 attacks → 20s, 40s over
    // a 60s window) — dt 25 crosses exactly the first.
    runPredators(s, 25, { mode: 'offline', rng: zero, lossBudget: { remaining: 10 } });
    expect(s.ducks.filter((d) => d.wounded)).toHaveLength(1);
    expect(s.condition).toBeCloseTo(MAX - S.DRAIN.wound, 5);
  });

  it('an escalated loss drains DRAIN.loss (on top of the earlier wound)', () => {
    const s = greenSteady();
    s.rank = 1; // below every intro rank — no windows, only the wound clock
    const d = s.ducks[0];
    d.wounded = true;
    d.woundSource = 'predator';
    d.severity = 'minor';
    d.woundElapsed = BALANCE.PREDATORS.WOUND_ESCALATE_SEC * waterWoundMult(s) - 0.5;
    runPredators(s, 1, { mode: 'online', rng: zero });
    expect(s.ducks).not.toContain(d); // escalated — the loss
    expect(s.condition).toBeCloseTo(MAX - S.DRAIN.loss, 5);
  });

  it('an overcrowd injury drains DRAIN.crowdInjury', () => {
    const s = greenSteady();
    s.geneReader = true; // breeding established
    const drake = (id: string): Duck => ({
      id,
      genotype: ['Bl', 'bl'],
      genome: [...FLAT_GENOME],
      genomeKnown: true,
      sex: 'drake',
      stage: 'adult',
      ageTicks: 0,
    });
    // 2 hens (greenSteady) + 8 drakes = flock 10 (the gate), wildly over-ratio.
    for (let i = 0; i < 8; i++) s.ducks.push(drake(`dr${i}`));
    // Excess is rate-capped at 4× — ONSET/4 seconds of stress = exactly one injury.
    runOvercrowding(s, BALANCE.BREEDING.OVERCROWD_INJURY_ONSET_S / BALANCE.BREEDING.OVERCROWD_RATE_CAP, () => 0.5);
    expect(s.ducks.filter((d) => d.wounded && d.woundSource === 'overcrowd')).toHaveLength(1);
    expect(s.condition).toBeCloseTo(MAX - S.DRAIN.crowdInjury, 5);
  });

  it('a shrugged-off hit (Hardy resist) drains NOTHING — no harm, no stress', () => {
    const s = greenSteady();
    s.ducks.forEach((d) => (d.genome = ['H', 'H', 'H', 'H', 'H', 'H']));
    s.rank = BALANCE.PREDATORS.INTRO_RANK;
    s.predatorsIntroduced = true;
    s.predatorsSeen = ['owl'];
    s.predators.owl = { timeToNextWindow: 0, windowRemaining: 60, windowElapsed: 0, attacksFired: 0 };
    // rng 0.5: attack lands (0.5 >= 0.45 is false... base 0.45 → misses at 0.5).
    // Use a sequenced rng: attack roll low (hits), resist roll low (< resist → shrug).
    let calls = 0;
    const seq = () => [0.1, 0.1, 0.1, 0.1, 0.1][Math.min(calls++, 4)] ?? 0.1;
    runPredators(s, 45, { mode: 'offline', rng: seq, lossBudget: { remaining: 10 } });
    expect(s.ducks.some((d) => d.wounded)).toBe(false); // resisted (0.1 < 0.6 cap resist)
    expect(s.condition).toBeCloseTo(MAX, 5);
  });
});

describe('the stress throttle: direct, gentle, floored — and green-gated', () => {
  it('a rattled flock lays slower ON A GREEN RATION (the mask’s dead zone)', () => {
    const s = greenSteady();
    drainCondition(s, MAX * 0.8); // battery to 20%
    run(s, 0.1);
    const n = s.nutrition!;
    const expected = S.THROTTLE_FLOOR + (1 - S.THROTTLE_FLOOR) * (0.2 / S.THROTTLE_BELOW);
    expect(n.stressMult).toBeCloseTo(expected, 2);
    expect(n.eggMult).toBeLessThan(0.9); // visibly shaved despite green bars
  });

  it('floors at THROTTLE_FLOOR — a throttle, never a wall', () => {
    const s = greenSteady();
    drainCondition(s, MAX * 2);
    expect(s.condition).toBe(0); // drain clamps at zero
    run(s, 0.1);
    expect(s.nutrition!.stressMult).toBeCloseTo(S.THROTTLE_FLOOR, 2);
    expect(s.nutrition!.eggMult).toBeGreaterThanOrEqual(S.THROTTLE_FLOOR * 0.99);
  });

  it('NEVER stacks onto a feed shortfall — a starved flock is the mask’s problem', () => {
    const s = setHens(fullSetup(), 2); // no stock at all
    s.ration = { ...N.DEFAULT_RATION };
    s.stations = s.stations.filter((x) => x.type === 'mill' || x.type === 'coop'); // no producers
    run(s, 30); // satisfaction collapses → eggMultRaw at the MIN floor (≤ FED_BLEND[0])
    expect(s.nutrition!.eggMultRaw).toBeLessThanOrEqual(S.FED_BLEND[0]);
    drainCondition(s, MAX * 2); // battery empty on top of starvation
    run(s, 0.1);
    expect(s.nutrition!.stressMult).toBe(1); // stress fully faded out — no double punish
  });

  it('recovers: the regen engine nurses a rattled flock back to full output', () => {
    const s = greenSteady();
    drainCondition(s, MAX);
    run(s, 300); // green ration + baseline water regen
    expect(s.condition).toBeGreaterThan(MAX * 0.99);
    expect(s.nutrition!.stressMult).toBeGreaterThan(0.99);
    expect(s.nutrition!.eggMult).toBeGreaterThan(0.99);
  });

  it('winter hens are insulated — home stress never touches the winter pool', () => {
    const s = greenSteady();
    s.zones.winterstead = { unlocked: true };
    s.resources.eggs = 1_000_000;
    placeStation(s, 'winterCoop', 0, 0, 'winterstead');
    placeStation(s, 'heater', 0, 1, 'winterstead');
    placeStation(s, 'heatedWaterer', 3, 1, 'winterstead');
    s.winterRation = { ...BALANCE.WINTER.DEFAULT_RATION };
    expect(assignToWinter(s, s.ducks[0].id).ok).toBe(true);
    run(s, 60);
    const before = s.winter!.eggRate;
    drainCondition(s, MAX); // home flock fully rattled
    run(s, 1);
    expect(s.nutrition!.stressMult).toBeLessThan(0.8); // home is throttled…
    expect(s.winter!.eggRate).toBeCloseTo(before, 3); // …winter doesn’t notice
  });
});

describe('regression: the battery still does its original jobs', () => {
  it('the mask is unchanged where it lives (condition buffers a feed dip)', () => {
    // Full condition masking a shortfall: eggMult ≈ masked (stress faded out at low raw).
    const s = setHens(fullSetup(), 2);
    s.ration = { ...N.DEFAULT_RATION };
    s.stations = s.stations.filter((x) => x.type === 'mill' || x.type === 'coop');
    s.condition = MAX; // walked into the dip with a full battery
    run(s, 0.1);
    const n = s.nutrition!;
    // masked = raw + (1-raw)·cond with cond ≈ 1 → ≈ 1; stressMult 1 (raw low).
    expect(n.stressMult).toBe(1);
    expect(n.eggMult).toBeGreaterThan(0.9);
  });

  it('breeding/maturation are untouched by stress (throughput only shaves lay)', () => {
    const calm = greenSteady();
    const rattled = greenSteady();
    drainCondition(rattled, MAX);
    for (const s of [calm, rattled]) {
      s.ducks.push({
        id: 'kid',
        genotype: ['Bl', 'bl'],
        genome: [...FLAT_GENOME],
        genomeKnown: true,
        sex: 'hen',
        stage: 'duckling',
        ageTicks: 0,
      });
      s.ducklingRation = { ...BALANCE.BREEDING.DEFAULT_DUCKLING_RATION };
      run(s, 30);
    }
    const age = (s: GameState) => s.ducks.find((d) => d.id === 'kid')!.ageTicks;
    expect(age(rattled)).toBeCloseTo(age(calm), 1);
  });

  it('a fresh game is unaffected (bootstrap protection via the fed blend)', () => {
    const s = initialState(0);
    // Pre-placed-engine-free initial state: no mill → raw 0, weight 0, stress inert.
    run(s, 5);
    expect(s.nutrition === undefined || s.nutrition.stressMult === 1).toBe(true);
  });
});
