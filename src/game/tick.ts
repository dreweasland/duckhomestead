import { BALANCE, STATION_DEFS } from '../config/balance';
import type { Resource } from './state';
import type { GameState, Station } from './state';
import { UPGRADE_OUTPUT } from './actions';
import { cycleMult, yieldMult } from './loot';
import { runNutrition } from './nutrition';
import { runBreeding } from './breeding';

export type SimMode = 'online' | 'offline';

export interface TickOptions {
  mode: SimMode;
  /**
   * When true, station buffers are auto-hauled into central storage every
   * step so the chain flows hands-free. Online this requires the Auto-Haul
   * unlock; offline catch-up always hauls (idle is the floor — resources only).
   */
  autoHaul: boolean;
}

/** Effective output of a station per cycle for a given resource (level + yield modules). */
function stationOutput(station: Station, resource: Resource): number {
  const base = STATION_DEFS[station.type].outputs[resource] ?? 0;
  return base * UPGRADE_OUTPUT(station.level) * yieldMult(station);
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
    station.buffer[key] = (station.buffer[key] ?? 0) + stationOutput(station, key);
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

    // Speed modules shorten the effective cycle (throughput only).
    const cycleSeconds = STATION_DEFS[station.type].cycleSeconds * cycleMult(station);
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

  // Breeding: clutches, incubation, hatching, and maturation (online & offline).
  // matureRate is 1 until Step 5's duckling ration gates it.
  runBreeding(state, dt * rateMult);
}
