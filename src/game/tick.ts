import { BALANCE, STATION_DEFS } from '../config/balance';
import type { Resource } from './state';
import type { GameState, Station } from './state';
import { UPGRADE_OUTPUT, stationOutputMult } from './actions';
import { cycleMult, yieldMult } from './loot';
import { husbandryBoostMult, outputBoostMult, speedBoostMult } from './prestige';
import { runNutrition, runDucklingNutrition, runDrakeNutrition } from './nutrition';
import { runBreeding, runOvercrowding } from './breeding';
import { runPredators } from './predators';
import { runCirculation } from './pond';
import { runContracts } from './contracts';

export type SimMode = 'online' | 'offline';

export interface TickOptions {
  mode: SimMode;
  /**
   * When true, station buffers are auto-hauled into central storage every
   * step so the chain flows hands-free. Online this requires the Auto-Haul
   * unlock; offline catch-up always hauls (idle is the floor — resources only).
   */
  autoHaul: boolean;
  /** Phase 4c: injectable RNG for the predator layer (defaults to Math.random). */
  rng?: () => number;
  /** Phase 4c: offline mercy rail — a mutable permanent-loss budget for the
   *  predator layer (set by offline catch-up; absent/uncapped online). */
  predatorLossBudget?: { remaining: number };
}

/** Effective output of a station per cycle for a given resource (level × the
 *  homestead-wide throughput scalar). `throughput` = rack yield × legacy output
 *  boost, precomputed once per tick by the caller (it's constant within a step, so
 *  recomputing the O(rack) yieldMult per cycle/output was pure waste). */
function stationOutput(station: Station, resource: Resource, throughput: number): number {
  const base = STATION_DEFS[station.type].outputs[resource] ?? 0;
  return base * stationOutputMult(station.type, station.level) * throughput;
}


/** Move everything in a station's buffer into central storage. */
function haul(state: GameState, station: Station): void {
  for (const key of Object.keys(station.buffer) as Resource[]) {
    const amt = station.buffer[key] ?? 0;
    if (amt > 0) state.resources[key] += amt;
  }
  station.buffer = {};
}

/**
 * Attempt to run one production cycle for a station: if central storage holds
 * the required inputs, consume them and deposit outputs into the buffer.
 * Returns true if a cycle ran. Inputs are scaled by level the same as outputs
 * so throughput stays balanced across the chain.
 */
function runCycle(state: GameState, station: Station, throughput: number): boolean {
  const def = STATION_DEFS[station.type];
  const mult = UPGRADE_OUTPUT(station.level);

  // Check inputs are affordable from central storage.
  for (const key of Object.keys(def.inputs) as Resource[]) {
    const need = (def.inputs[key] ?? 0) * mult;
    if (state.resources[key] < need) return false;
  }
  // Consume inputs.
  for (const key of Object.keys(def.inputs) as Resource[]) {
    state.resources[key] -= (def.inputs[key] ?? 0) * mult;
  }
  // Deposit outputs into the station buffer.
  for (const key of Object.keys(def.outputs) as Resource[]) {
    station.buffer[key] = (station.buffer[key] ?? 0) + stationOutput(station, key, throughput);
  }
  return true;
}

/**
 * Advance the simulation by `dt` seconds. Pure with respect to GameState
 * (mutates it in place). Production is decoupled from render: callers feed
 * fixed timesteps. Offline applies OFFLINE_RATE_MULT and never grants XP
 * (XP only ever comes from tending, which is online — see actions.tend).
 */
export function tick(state: GameState, dt: number, opts: TickOptions): void {
  const rateMult = opts.mode === 'offline' ? BALANCE.OFFLINE_RATE_MULT : 1;
  const willHaul = opts.autoHaul || opts.mode === 'offline';

  // Only raw producers run in this loop — mills (formulation) and coops
  // (nutrition-throttled laying) are handled by runNutrition below. Producers have
  // no inputs and no cross-dependencies, so they need no ordering; iterate the live
  // array directly (no per-tick copy/sort).
  // Rack speed modules + the legacy stationSpeed boost are homestead-wide — hoist
  // them out of the loop (cycleMult is O(rack)) instead of recomputing per station.
  const cycleScale = cycleMult(state) / speedBoostMult(state);
  // Homestead-wide output scalar (rack yield × legacy output boost) — constant this
  // step, so compute the O(rack) part once instead of per cycle/output in runCycle.
  const throughput = yieldMult(state) * outputBoostMult(state);
  for (const station of state.stations) {
    // Tend cooldown ticks down in real seconds regardless of rate.
    if (station.tendCooldownRemaining > 0) {
      station.tendCooldownRemaining = Math.max(0, station.tendCooldownRemaining - dt);
    }

    // Mills (formulation) and coops (nutrition-throttled laying) are handled by
    // runNutrition below, not the generic producer path.
    if (station.type === 'mill' || station.type === 'coop') continue;

    // The boost divides cycle time — a global top-level rate scalar.
    const cycleSeconds = STATION_DEFS[station.type].cycleSeconds * cycleScale;
    station.cycleProgress += dt * rateMult;

    // Run as many cycles as progress allows. If inputs are missing, cap
    // progress at one cycle so the station fires the instant inputs arrive.
    let guard = 100000; // runaway guard for very long offline steps
    while (station.cycleProgress >= cycleSeconds && guard-- > 0) {
      if (runCycle(state, station, throughput)) {
        station.cycleProgress -= cycleSeconds;
        if (willHaul) haul(state, station);
      } else {
        station.cycleProgress = cycleSeconds; // ready, waiting on inputs
        break;
      }
    }
  }

  // Global Dose cooldown ticks down in real seconds (offline too, so it's ready
  // on return — the dose itself can only be triggered by an active player).
  if (state.doseCooldownRemaining > 0) {
    state.doseCooldownRemaining = Math.max(0, state.doseCooldownRemaining - dt);
  }

  // The nutrition grid: feed the flock from storage per the active ration and
  // lay eggs throttled by per-axis satisfaction (buffered by flock condition).
  // `online` gates the Grange's egg-diversion hook (Phase 6b) — the online-only
  // law: offline catch-up never diverts a laid egg to a contract.
  const online = opts.mode === 'online';
  runNutrition(state, dt, rateMult, willHaul, online);

  // Duckling grow-out ration consumes the leftover ingredients (layers eat first)
  // and gates maturation speed.
  const matureRate = runDucklingNutrition(state, dt, rateMult);
  // Drake maintenance ration (once breeding's established) — another ingredient
  // drain; gates clutch (breeding) speed.
  const breedRate = runDrakeNutrition(state, dt, rateMult);

  // Breeding: clutches, incubation, hatching, and maturation (online & offline).
  // Husbandry (legacy boost) is a pure SPEED scalar on both rates — it never
  // touches the rations that produced them, clutch size, or genome odds.
  // `online` also gates the Grange's hatch-spec hook — offline hatches never
  // count toward a contract.
  const husbandry = husbandryBoostMult(state);
  runBreeding(state, dt * rateMult, matureRate * husbandry, breedRate * husbandry, online);
  // Flock ratio health: an over-drake flock injures its own (online & offline).
  runOvercrowding(state, dt * rateMult);

  // THE WATER SYSTEM's upkeep loop: foul the pond at a rate set by flock size and
  // hold well-circulated features fresh (online & offline). Wellness-only — it
  // never grants XP/eggs and never touches a nutrition axis. The ONE upkeep loop.
  runCirculation(state, dt, rateMult);

  // Predators (Phase 4c): window scheduling, attack rolls, wound escalation.
  // Wall-clock danger — advanced by the RAW dt, never the offline rate-scaled
  // step (an owl doesn't hunt slower because you're away). Offline passes the
  // mercy budget so a defended/secured overnight is soft losses, not a wipe.
  // Active window lapses in real seconds; offline drains it too (you're away →
  // guard). ACTIVE only applies online: the player is here, so dives drop the
  // passive floor and demand a scare.
  if (state.activeRemaining > 0) state.activeRemaining = Math.max(0, state.activeRemaining - dt);
  const activeDefense = opts.mode === 'online' && state.activeRemaining > 0;

  runPredators(state, dt, {
    mode: opts.mode,
    rng: opts.rng,
    lossBudget: opts.predatorLossBudget,
    activeDefense,
  });

  // The Grange (Phase 6b): offer board upkeep (refill/refresh) + the active
  // delivery contract's deadline. Online-only, top to bottom — offline catch-up
  // never advances a contract clock. NOTE: the defense contract's scare-count
  // hook (onPredatorEvent) is NOT wired here — 'scared' only ever originates
  // from an out-of-band player scare (GameEngine.scare()), never from inside a
  // tick(), so it's fed from GameEngine.drainPredatorEvents() instead (the
  // actual online-only choke point every predator event passes through en
  // route to the UI; offline catch-up never calls it). See game/contracts.ts.
  if (online) runContracts(state, dt);
}
