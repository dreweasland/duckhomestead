import { describe, it, expect } from 'vitest';
import { BALANCE } from '../src/config/balance';
import { runOvercrowding } from '../src/game/breeding';
import { runOfflineCatchUp } from '../src/game/save';
import { flockRatio, initialState, type Duck, type GameState } from '../src/game/state';
import { FLAT_GENOME } from './helpers';

const HOUR = 3600 * 1000;

const B = BALANCE.BREEDING;

/** A flock of `hens` adult hens + `drakes` adult drakes, breeding established. */
function makeFlock(hens: number, drakes: number, established = true): GameState {
  const s = initialState(0);
  s.geneReader = established; // breedingEstablished gate
  const mk = (id: string, sex: Duck['sex']): Duck => ({
    id,
    genotype: ['Bl', 'bl'],
    genome: [...FLAT_GENOME],
    genomeKnown: true,
    sex,
    stage: 'adult',
    ageTicks: 0,
  });
  s.ducks = [
    ...Array.from({ length: hens }, (_, i) => mk(`h${i}`, 'hen')),
    ...Array.from({ length: drakes }, (_, i) => mk(`d${i}`, 'drake')),
  ];
  return s;
}

const always = () => 0; // deterministic victim pick (first eligible)

describe('flockRatio', () => {
  it('is dormant below the flock-size gate (even when over-drake)', () => {
    const r = flockRatio(makeFlock(1, 5)); // 6 ducks — under the gate
    expect(r.gated).toBe(false);
    expect(r.injuring).toBe(false);
  });

  it('is dormant until breeding is established', () => {
    const r = flockRatio(makeFlock(6, 6, false)); // 12 ducks but no reader/pairs
    expect(r.gated).toBe(false);
    expect(r.injuring).toBe(false);
  });

  it('flags excess drakes past the gate (ideal ~1 drake per N hens)', () => {
    const s = makeFlock(8, 5); // 13 ducks; ideal = floor(8/4) = 2 drakes
    const r = flockRatio(s);
    expect(r.gated).toBe(true);
    expect(r.maxHealthyDrakes).toBe(Math.floor(8 / B.IDEAL_HENS_PER_DRAKE));
    expect(r.excess).toBe(5 - Math.floor(8 / B.IDEAL_HENS_PER_DRAKE));
    expect(r.injuring).toBe(true);
  });

  it('always allows at least one stud (a lone drake is never excess)', () => {
    expect(flockRatio(makeFlock(11, 1)).excess).toBe(0);
    expect(flockRatio(makeFlock(11, 1)).injuring).toBe(false);
  });

  it('a balanced flock is healthy (no excess)', () => {
    expect(flockRatio(makeFlock(12, 3)).injuring).toBe(false); // ideal 3 drakes, has 3
  });

  it('secured drakes are separate housing — they do not count toward the over-ratio', () => {
    const s = makeFlock(8, 5); // 5 drakes vs 8 hens → excess 3, injuring
    expect(flockRatio(s).injuring).toBe(true);
    // Secure 3 drakes → 2 unsecured drakes vs 8 hens (ideal 2) → healthy.
    for (const d of s.ducks.filter((d) => d.sex === 'drake').slice(0, 3)) d.secured = true;
    expect(flockRatio(s).drakes).toBe(2);
    expect(flockRatio(s).injuring).toBe(false);
  });
});

describe('runOvercrowding', () => {
  it('injures the flock when over-drake past the gate', () => {
    const s = makeFlock(8, 5); // excess 3
    runOvercrowding(s, B.OVERCROWD_INJURY_ONSET_S, always);
    expect(s.ducks.some((d) => d.wounded)).toBe(true);
    expect((s.pendingPredatorEvents ?? []).some((e) => e.kind === 'crowdInjury')).toBe(true);
  });

  it('does nothing below the gate', () => {
    const s = makeFlock(1, 5); // under the gate
    runOvercrowding(s, 100_000, always);
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
    expect(s.overcrowdStress).toBe(0);
  });

  it('a healthy ratio never injures', () => {
    const s = makeFlock(12, 3); // 0 excess
    runOvercrowding(s, 100_000, always);
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
  });

  it('secured ducks are exempt (a fully-secured flock takes no injury)', () => {
    const s = makeFlock(8, 5);
    for (const d of s.ducks) d.secured = true;
    runOvercrowding(s, B.OVERCROWD_INJURY_ONSET_S * 10, always);
    expect(s.ducks.every((d) => !d.wounded)).toBe(true);
  });

  it('offline injuries are attributed to the flock (overcrowd), not the owl', () => {
    const s = makeFlock(8, 6); // over-drake, breeding established
    s.rank = 5;
    s.predatorsIntroduced = false; // first-contact grace → no predator toll offline
    s.lastSeen = -2 * HOUR;
    const away = runOfflineCatchUp(s, 0);
    expect(away.overcrowd).toBeDefined();
    expect((away.overcrowd?.injured ?? 0) + (away.overcrowd?.lost ?? 0)).toBeGreaterThan(0);
    expect(away.predator).toBeUndefined(); // not blamed on the owl
    // Any wound carried home is tagged as overcrowding, not predator.
    expect(s.ducks.filter((d) => d.wounded).every((d) => d.woundSource === 'overcrowd')).toBe(true);
  });
});
