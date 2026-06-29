import { BALANCE, STATION_DEFS } from '../config/balance';
import type { Resource } from './state';
import type { GameState, Station } from './state';
import { UPGRADE_OUTPUT } from './actions';
import { cycleMult, yieldMult } from './loot';
import { outputBoostMult, speedBoostMult } from './prestige';
import { runNutrition, runDucklingNutrition } from './nutrition';
import { runBreeding } from './breeding';
import { runPredators } from './predators';
import { runCirculation } from './pond';

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

/** Effective output of a station per cycle for a given resource (level + rack yield). */
function stationOutput(state: GameState, station: Station, resource: Resource): number {
  const base = STATION_DEFS[station.type].outputs[resource] ?? 0;
  // Phase 4e: the legacy `output` boost is a uniform top-level scalar on all
  // station output, alongside level + rack yield. Throughput only.
  return base * UPGRADE_OUTPUT(station.level) * yieldMult(state) * outputBoostMult(state);
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
function runCycle(state: GameState, station: Station): boolean {
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
    station.buffer[key] = (station.buffer[key] ?? 0) + stationOutput(state, station, key);
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

  // Process producers -> mill -> coop so resources made this step can be hauled
  // and consumed downstream within the same step when hauling is active.
  const order: Record<string, number> = {
    plot: 0,
    peaPatch: 0,
    mealwormFarm: 0,
    yeastVat: 0,
    oysterSource: 0,
    mill: 1,
    coop: 2,
  };
  const stations = [...state.stations].sort((a, b) => order[a.type] - order[b.type]);

  for (const station of stations) {
    // Tend cooldown ticks down in real seconds regardless of rate.
    if (station.tendCooldownRemaining > 0) {
      station.tendCooldownRemaining = Math.max(0, station.tendCooldownRemaining - dt);
    }

    // Mills (formulation) and coops (nutrition-throttled laying) are handled by
    // runNutrition below, not the generic producer path.
    if (station.type === 'mill' || station.type === 'coop') continue;

    // Rack speed modules + the legacy stationSpeed boost shorten every producer's
    // cycle (the boost divides cycle time — a global top-level rate scalar).
    const cycleSeconds =
      (STATION_DEFS[station.type].cycleSeconds * cycleMult(state)) / speedBoostMult(state);
    station.cycleProgress += dt * rateMult;

    // Run as many cycles as progress allows. If inputs are missing, cap
    // progress at one cycle so the station fires the instant inputs arrive.
    let guard = 100000; // runaway guard for very long offline steps
    while (station.cycleProgress >= cycleSeconds && guard-- > 0) {
      if (runCycle(state, station)) {
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
  runNutrition(state, dt, rateMult, willHaul);

  // Duckling grow-out ration consumes the leftover ingredients (layers eat first)
  // and gates maturation speed.
  const matureRate = runDucklingNutrition(state, dt, rateMult);

  // Breeding: clutches, incubation, hatching, and maturation (online & offline).
  runBreeding(state, dt * rateMult, matureRate);

  // THE WATER SYSTEM's upkeep loop: foul the pond at a rate set by flock size and
  // hold well-circulated features fresh (online & offline). Wellness-only — it
  // never grants XP/eggs and never touches a nutrition axis. The ONE upkeep loop.
  runCirculation(state, dt, rateMult);

  // Predators (Phase 4c): window scheduling, attack rolls, wound escalation.
  // Wall-clock danger — advanced by the RAW dt, never the offline rate-scaled
  // step (an owl doesn't hunt slower because you're away). Offline passes the
  // mercy budget so a defended/secured overnight is soft losses, not a wipe.
  runPredators(state, dt, {
    mode: opts.mode,
    rng: opts.rng,
    lossBudget: opts.predatorLossBudget,
  });
}
