import { BALANCE, type StationType } from '../config/balance';
import {
  admitToInfirmary,
  autoFillRack,
  buildDeterrent,
  buildGeneReader,
  buildHardwareCloth,
  buildInfirmary,
  buildSecureCoop,
  bulkSalvageByTier,
  repairDeterrents,
  repairHardwareCloth,
  collectAll,
  collectStation,
  createPair,
  cullDuck,
  cullDucks,
  doseNiacin,
  gainXP,
  installModule,
  removePair,
  moveStation,
  placeStation,
  setDoubleClutch,
  setDuckName,
  setGenomeTarget,
  rerollModule,
  removeStation,
  salvageModule,
  setSecured,
  swapInModule,
  tend,
  uninstallModule,
  unlockZone as unlockZoneAction,
  upgradeStation,
  type ActionResult,
  type XpResult,
} from './actions';
import { playstylePreset, zoneDef } from '../config/balance';
import { assignToPost, assignToWinter, recallFromPost, recallFromWinter } from './actions';
import {
  acceptContract,
  abandonContract,
  claimContract,
  deliverOrder,
  fulfilProvision,
  onPredatorEvent as onContractPredatorEvent,
  presentExhibition,
  rerollOffers,
  type ClaimResult,
} from './contracts';
import { goodGeneCount } from './genetics';
import { flockRatio, type Duck } from './state';
import { acceptBarter, buyBloodline, commissionBloodline, restockNow, type CommissionLocks } from './peddler';
import { rewindWoundsToBrink, scareOff, type ScareResult } from './predators';
import { tryTendDrop } from './loot';
import { conditionTarget } from './nutrition';
import { waterConditionMult } from './water';
import type { Milestone } from './rank';
import {
  clearStorage,
  deserialize,
  loadGame,
  meaningfulAway,
  newGame,
  runOfflineCatchUp,
  saveToStorage,
  type AwaySummary,
} from './save';
import { tick } from './tick';
import {
  placeFlowFeature,
  placePondFeature,
  removeFlowFeature,
  removePondFeature,
  upgradePondFeature,
  type PondResult,
} from './pond';
import type { FlowFeatureType, PondFeatureType } from './state';
import {
  buyBoost as buyBoostAction,
  canPrestige,
  prestigeCurrency,
  prestigeReset,
  type BoostId,
} from './prestige';
import {
  type Color,
  type Gene,
  type GameState,
  type Ingredient,
  type Module,
  type ModuleStat,
  type PostId,
  type PredatorEvent,
  type Rarity,
  type Resource,
} from './state';

export interface DingEvent {
  newRank: number;
  levelsGained: number;
  milestones: Milestone[];
}

/** Emitted on a successful tend so the canvas can show feedback at the tile. */
export interface TendEvent {
  stationId: string;
  xp: number;
  /** The station's tend burst, for a resource-amount pop alongside the XP one. */
  burst?: Partial<Record<Resource, number>>;
  /** MASTER TEND: this tend critted (burst doubled) — the pop goes gold. */
  crit?: boolean;
}

/** Emitted when a station's buffer is collected/hauled into storage — the
 *  canvas pops a "+N" at the tile. `stationId` is omitted for a Collect-All
 *  sweep (the amounts are already aggregated across every station). */
export interface CollectEvent {
  stationId?: string;
  resources: Partial<Record<Resource, number>>;
}

/** Emitted when an infirmary admission beat the escalation clock while the
 *  pond ran above par — the water attribution beat (Phase 5 juice). */
export interface WoundSavedEvent {
  spareSec: number;
  boughtSec: number;
}

/** Emitted when flock condition recovers to target after a dip while the pond
 *  ran well above par — the other water attribution beat. */
export interface ConditionReboundEvent {
  mult: number;
}

/** Emitted when a module enters the inventory — the loot moment. */
export interface LootEvent {
  module: Module;
  source: 'drop' | 'milestone' | 'siege';
}

/** Emitted when a never-before-bred color first hatches — the collection DING. */
export interface DexEvent {
  color: Color;
}

type Listener = () => void;
/** Re-exported so the UI can type predator-event handlers without reaching into state. */
export type { PredatorEvent } from './state';

/**
 * Owns the single GameState and the fixed-timestep simulation loop. The sim is
 * decoupled from rendering: an accumulator advances the sim in fixed steps
 * while requestAnimationFrame paces the loop. React subscribes for re-renders;
 * Pixi reads `state` directly each of its own frames.
 */
export class GameEngine {
  state: GameState;
  away: AwaySummary | null;

  private listeners = new Set<Listener>();
  private dingListeners = new Set<(e: DingEvent) => void>();
  private tendListeners = new Set<(e: TendEvent) => void>();
  private collectListeners = new Set<(e: CollectEvent) => void>();
  private lootListeners = new Set<(e: LootEvent) => void>();
  private dexListeners = new Set<(e: DexEvent) => void>();
  private predatorListeners = new Set<(e: PredatorEvent) => void>();
  private autosalvageListeners = new Set<(dust: number) => void>();
  /** Fires when a Grange contract is claimed — a quiet rhythm beat (reward
   *  amounts), not a celebratory DING like a milestone. */
  private contractClaimListeners = new Set<(e: ClaimResult) => void>();
  /** Fires when an active delivery contract hits its deadline — a contract must
   *  never vanish with zero feedback. */
  private contractExpireListeners = new Set<() => void>();
  private woundSavedListeners = new Set<(e: WoundSavedEvent) => void>();
  private conditionReboundListeners = new Set<(e: ConditionReboundEvent) => void>();
  /** Phase 9c: a season turned — the quiet announcement toast. */
  private seasonListeners = new Set<(seasonId: string) => void>();

  // Water attribution (Phase 5 juice): the condition-rebound edge-detection
  // lives here, engine-side, never in tick — these are pure UI bookkeeping,
  // not sim state, so they live on the instance rather than on GameState.
  private conditionWasLow = false;
  private lastConditionReboundAt = 0;
  private static readonly CONDITION_REBOUND_COOLDOWN_MS = 10 * 60 * 1000;

  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private readonly stepMs = 1000 / BALANCE.TICKS_PER_SECOND;

  /** Throttle React re-renders from the loop to ~15Hz (Pixi reads state directly). */
  private lastNotify = 0;
  private readonly notifyIntervalMs = 66;

  private saveTimer: number | null = null;

  constructor(now: number) {
    const { state, away } = loadGame(now);
    this.state = state;
    this.away = away;
  }

  // ── Subscriptions ─────────────────────────────────────────────────
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onDing(fn: (e: DingEvent) => void): () => void {
    this.dingListeners.add(fn);
    return () => this.dingListeners.delete(fn);
  }
  onTend(fn: (e: TendEvent) => void): () => void {
    this.tendListeners.add(fn);
    return () => this.tendListeners.delete(fn);
  }
  onCollect(fn: (e: CollectEvent) => void): () => void {
    this.collectListeners.add(fn);
    return () => this.collectListeners.delete(fn);
  }
  onLoot(fn: (e: LootEvent) => void): () => void {
    this.lootListeners.add(fn);
    return () => this.lootListeners.delete(fn);
  }
  onDex(fn: (e: DexEvent) => void): () => void {
    this.dexListeners.add(fn);
    return () => this.dexListeners.delete(fn);
  }
  onPredator(fn: (e: PredatorEvent) => void): () => void {
    this.predatorListeners.add(fn);
    return () => this.predatorListeners.delete(fn);
  }
  /** Fires when a tend drop was auto-salvaged (couldn't improve the rack) — the
   *  quiet "+dust" beat, distinct from the celebratory loot banner. */
  onAutosalvage(fn: (dust: number) => void): () => void {
    this.autosalvageListeners.add(fn);
    return () => this.autosalvageListeners.delete(fn);
  }
  /** Fires when a Grange contract is claimed. */
  onContractClaim(fn: (e: ClaimResult) => void): () => void {
    this.contractClaimListeners.add(fn);
    return () => this.contractClaimListeners.delete(fn);
  }
  /** Fires when an active delivery contract expires at its deadline. */
  onContractExpire(fn: () => void): () => void {
    this.contractExpireListeners.add(fn);
    return () => this.contractExpireListeners.delete(fn);
  }
  /** Fires when an infirmary admission beats the clock thanks to above-par water. */
  onWoundSaved(fn: (e: WoundSavedEvent) => void): () => void {
    this.woundSavedListeners.add(fn);
    return () => this.woundSavedListeners.delete(fn);
  }
  /** Fires when condition recovers to target after a dip, well-watered. */
  onConditionRebound(fn: (e: ConditionReboundEvent) => void): () => void {
    this.conditionReboundListeners.add(fn);
    return () => this.conditionReboundListeners.delete(fn);
  }
  /** Fires when a season turns (9c) — the toast that says re-check the ration. */
  onSeason(fn: (seasonId: string) => void): () => void {
    this.seasonListeners.add(fn);
    return () => this.seasonListeners.delete(fn);
  }
  private notify() {
    for (const fn of this.listeners) fn();
  }
  private emitDing(e: DingEvent) {
    for (const fn of this.dingListeners) fn(e);
  }
  private emitTend(e: TendEvent) {
    for (const fn of this.tendListeners) fn(e);
  }
  private emitCollect(e: CollectEvent) {
    for (const fn of this.collectListeners) fn(e);
  }
  private emitLoot(e: LootEvent) {
    for (const fn of this.lootListeners) fn(e);
  }
  private emitDex(e: DexEvent) {
    for (const fn of this.dexListeners) fn(e);
  }
  private emitPredator(e: PredatorEvent) {
    for (const fn of this.predatorListeners) fn(e);
  }
  private emitAutosalvage(dust: number) {
    for (const fn of this.autosalvageListeners) fn(dust);
  }
  private emitContractClaim(e: ClaimResult) {
    for (const fn of this.contractClaimListeners) fn(e);
  }
  private emitWoundSaved(e: WoundSavedEvent) {
    for (const fn of this.woundSavedListeners) fn(e);
  }
  private emitConditionRebound(e: ConditionReboundEvent) {
    for (const fn of this.conditionReboundListeners) fn(e);
  }
  /** Phase 9c: surface a season turn (quiet toast — set only while ACTIVE, so
   *  it can never fire behind an unwatched tab or replay from a save). */
  private drainSeasonChange() {
    const s = this.state.pendingSeasonChange;
    if (!s) return;
    this.state.pendingSeasonChange = undefined;
    for (const fn of this.seasonListeners) fn(s);
  }

  /** Surface any delivery-deadline expiry accrued during ticks (quiet toast). */
  private drainContractExpiry() {
    const n = this.state.pendingContractExpired ?? 0;
    if (n <= 0) return;
    this.state.pendingContractExpired = 0;
    for (let i = 0; i < n; i++) for (const fn of this.contractExpireListeners) fn();
  }
  /** Surface any infirmary admissions that beat the clock on above-par water
   *  (set by actions.ts's admitToInfirmary — a live-action-only event). */
  private drainWoundSaved() {
    const pending = this.state.pendingWoundSaved;
    if (!pending || pending.length === 0) return;
    for (const e of pending) this.emitWoundSaved(e);
    this.state.pendingWoundSaved = [];
  }
  /** Water attribution beat ②: detect the exact frame condition recovers to
   *  target after a dip, while the pond ran well above par. The edge-detection
   *  lives here (engine drain), never in tick — `conditionWasLow` is instance
   *  state, not persisted GameState, so a reset/reload starts it fresh. Rate-
   *  limited so it can never nag. */
  private drainConditionRebound() {
    const target = conditionTarget(this.state);
    if (target <= 0) {
      this.conditionWasLow = false;
      return;
    }
    const isLow = this.state.condition < target - 0.01;
    if (isLow) {
      this.conditionWasLow = true;
      return;
    }
    if (!this.conditionWasLow) return;
    this.conditionWasLow = false;
    const mult = waterConditionMult(this.state);
    if (mult <= 1.15) return;
    const now = Date.now();
    if (now - this.lastConditionReboundAt < GameEngine.CONDITION_REBOUND_COOLDOWN_MS) return;
    this.lastConditionReboundAt = now;
    this.emitConditionRebound({ mult });
  }
  /** Fire DINGs for any first-of-color hatches accrued during ticks. */
  private drainDex() {
    const pending = this.state.pendingDex;
    if (!pending || pending.length === 0) return;
    for (const color of pending) this.emitDex({ color });
    this.state.pendingDex = [];
  }
  /** THE PRIME DUCK — the rarest hatch in the game gets its own thunder. */
  private drainPrimeDuck() {
    const n = this.state.pendingPrimeDuck ?? 0;
    if (n <= 0) return;
    this.state.pendingPrimeDuck = 0;
    this.emitDing({
      newRank: this.state.rank,
      levelsGained: 0,
      milestones: [
        {
          rank: this.state.rank,
          title: 'THE PRIME DUCK',
          description:
            'Six Prime genes. Every slot a wildcard, every Standard a match — the rarest duck it is possible to breed, and the finest breeding stock that will ever stand in your yard. Name it. Secure it. Build the line from it. The Legacy Hall will remember this run.',
          kind: 'breeding',
        },
      ],
    });
  }
  /** A rung on the Prime chase's ladder: a truebred carrying a new best
   *  wildcard count for the flock. */
  private drainPrimeTruebred() {
    const n = this.state.pendingPrimeTruebred ?? 0;
    if (n <= 0) return;
    this.state.pendingPrimeTruebred = 0;
    this.emitDing({
      newRank: this.state.rank,
      levelsGained: 0,
      milestones: [
        {
          rank: this.state.rank,
          title: n === 1 ? 'PRIME BLOOD IN THE LINE' : `A ${n}-PRIME TRUEBRED`,
          description: `A truebred carrying ${n === 1 ? 'a Prime wildcard' : `${n} Prime wildcards`} — those slots match ANY Standard, and it passes them at full dominance. Breed from it: THE PRIME DUCK is ${6 - n} slot${6 - n === 1 ? '' : 's'} away.`,
          kind: 'breeding',
        },
      ],
    });
  }
  /** Promote any truebred hatch (a duck perfectly matching the target) to a
   *  can't-miss milestone DING — the payoff of the whole min/max grind. */
  private drainTruebred() {
    const n = this.state.pendingTruebred ?? 0;
    if (n <= 0) return;
    this.state.pendingTruebred = 0;
    this.emitDing({
      newRank: this.state.rank,
      levelsGained: 0,
      milestones: [
        {
          rank: this.state.rank,
          title: 'A Truebred!',
          description:
            'A duckling hatched with a genome that PERFECTLY matches your Standard. The crown of the breeding grind — protect it (secure it) and breed from it.',
          kind: 'breeding',
        },
      ],
    });
  }
  /** Surface predator events (telegraph / attack / loss) accrued during ticks.
   *  First contact (the 'introduced' beat) is promoted to a milestone DING so the
   *  player gets a clear, can't-miss "predators now hunt here" moment — always
   *  while present, never as a silent surprise. This is also the online-only
   *  choke point the Grange's defense contract listens through: 'scared' only
   *  ever originates from an out-of-band scare() click (never from inside a
   *  tick step), and this drain runs only from the engine's live loop / scare()
   *  — never during offline catch-up — so feeding it here keeps the online-only
   *  law intact without threading events through tick.ts. */
  private drainPredatorEvents() {
    const pending = this.state.pendingPredatorEvents;
    if (!pending || pending.length === 0) return;
    for (const e of pending) {
      onContractPredatorEvent(this.state, e);
      if (e.kind === 'siegeFoiled') {
        // Sim-side grant already ran (grantModule pushed into state.inventory);
        // this is purely the surfacing beat — a flawless siege IS a banner moment.
        const module = this.state.inventory.find((m) => m.id === e.moduleId);
        if (module) this.emitLoot({ module, source: 'siege' });
      }
      if (e.kind === 'introduced') {
        const raccoon = e.predatorId === 'raccoon';
        const siege = e.predatorId === 'greatHorned';
        this.emitDing({
          newRank: this.state.rank,
          levelsGained: 0,
          milestones: [
            {
              rank: this.state.rank,
              title: raccoon ? 'The Raccoon' : siege ? 'The Great Horned' : 'Predators',
              description: raccoon
                ? 'A raccoon now raids from the ground in its own telegraphed windows. Nets won’t stop it — build HARDWARE CLOTH in The Watch. Its threat is separate from the owl’s.'
                : siege
                  ? 'A Great Horned has begun sieging the homestead — a rare, long-telegraphed assault, tougher and faster than the regular owl. Scare off every committed dive without a single landed hit and the flawless defense pays a guaranteed jackpot; string flawless sieges together for a shot at Legendary loot.'
                  : 'An owl now hunts the homestead in telegraphed windows. Build deterrents, secure your prize breeders, and admit any wounded ducks to an infirmary before they turn fatal — open The Watch.',
              kind: 'predator',
            },
          ],
        });
      }
      this.emitPredator(e);
    }
    this.state.pendingPredatorEvents = [];
  }

  // ── Loop ──────────────────────────────────────────────────────────
  start(now: number) {
    // Loading the page IS being present — arm active mode so a fresh session starts
    // "active" (the guard countdown then runs), not falsely "guarded". Offline catch-up
    // already ran in the constructor with the saved activeRemaining (0), so this only
    // affects live play from here on.
    this.markActive();
    this.lastTime = now;
    this.accumulator = 0;
    const frame = (t: number) => {
      let elapsed = t - this.lastTime;
      this.lastTime = t;
      // Guard against huge gaps (tab throttling) — cap so we don't spiral.
      if (elapsed > 1000) elapsed = 1000;
      this.accumulator += elapsed;

      const autoHaul = this.state.autoHaulUnlocked;
      while (this.accumulator >= this.stepMs) {
        tick(this.state, this.stepMs / 1000, { mode: 'online', autoHaul });
        this.accumulator -= this.stepMs;
      }
      this.drainDex(); // fire DINGs for any first-of-color hatches this frame
      this.drainPrimeDuck(); // THE PRIME DUCK outranks every other beat this frame
      this.drainPrimeTruebred(); // a new best wildcard count among truebreds — the chase's ladder
      this.drainTruebred(); // fire the truebred DING for a perfect-target hatch
      this.drainPredatorEvents(); // telegraph / attack / loss feedback this frame
      this.drainContractExpiry(); // a deadline lapse gets a toast, never silence
      this.drainSeasonChange(); // a season turn gets its announcement (9c)
      this.drainWoundSaved(); // water attribution ①: an admission that beat the clock
      this.drainConditionRebound(); // water attribution ②: a dip recovered, well-watered
      if (t - this.lastNotify >= this.notifyIntervalMs) {
        this.lastNotify = t;
        this.notify();
      }
      this.scheduleSave();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  // ── Autosave (debounced) ──────────────────────────────────────────
  private scheduleSave() {
    if (this.saveTimer != null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      saveToStorage(this.state, Date.now());
    }, BALANCE.AUTOSAVE_DEBOUNCE_MS);
  }
  saveNow(now = Date.now()) {
    if (this.saveTimer != null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    saveToStorage(this.state, now);
  }

  // ── Player actions (wrap pure actions, fire events, re-render) ─────
  place(type: StationType, x: number, y: number, zoneId = 'yard'): ActionResult<unknown> {
    const r = placeStation(this.state, type, x, y, zoneId);
    this.notify();
    return r;
  }

  upgrade(stationId: string): ActionResult<unknown> {
    const r = upgradeStation(this.state, stationId);
    this.notify();
    return r;
  }

  /** Unlock a zone (double-gated rank + egg cost). Fires a milestone DING. */
  unlockZone(zoneId: string): ActionResult<{ name: string }> {
    const r = unlockZoneAction(this.state, zoneId);
    if (r.ok) {
      const def = zoneDef(zoneId);
      const description = def?.pondLayout
        ? 'The Pond! Arrange springs, bathing pools, plant beds and a deep zone — a thoughtful layout gives your flock far more water (deeper condition + more time to treat wounds).'
        : def?.waterworks
          ? 'Waterworks! Your growing flock fouls the pond faster now — route intake → fountains → outflow to keep it circulating, or provision coasts toward a floor.'
          : 'New buildable space for more coops and stations.';
      this.emitDing({
        newRank: this.state.rank,
        levelsGained: 0,
        milestones: [{ rank: this.state.rank, title: r.value.name, description, kind: 'zone' }],
      });
    }
    this.notify();
    return r;
  }

  /** Relocate a station to an empty tile (free). */
  move(stationId: string, x: number, y: number): ActionResult<unknown> {
    const r = moveStation(this.state, stationId, x, y);
    this.notify();
    return r;
  }

  /** Demolish a station, refunding part of its placement cost. */
  remove(stationId: string): ActionResult<{ refund: number }> {
    const r = removeStation(this.state, stationId);
    this.notify();
    return r;
  }

  collect(stationId: string): ActionResult<unknown> {
    const r = collectStation(this.state, stationId);
    if (r.ok) {
      const resources = r.value as Partial<Record<Resource, number>>;
      if (Object.values(resources).some((v) => (v ?? 0) > 0)) this.emitCollect({ stationId, resources });
    }
    this.notify();
    return r;
  }

  collectEverything() {
    // Snapshot per-station buffers before collectAll clears them, so the
    // canvas can pop a single aggregate total for the sweep (never one pop
    // per station — see GameCanvas's per-frame pop batching).
    const totals: Partial<Record<Resource, number>> = {};
    for (const s of this.state.stations) {
      for (const key of Object.keys(s.buffer) as Resource[]) {
        const amt = s.buffer[key] ?? 0;
        if (amt > 0) totals[key] = (totals[key] ?? 0) + amt;
      }
    }
    collectAll(this.state);
    if (Object.keys(totals).length > 0) this.emitCollect({ resources: totals });
    this.notify();
  }

  private fireXp(xp: XpResult) {
    if (xp.levelsGained > 0) {
      this.emitDing({
        newRank: xp.newRank,
        levelsGained: xp.levelsGained,
        milestones: xp.milestones,
      });
    }
    for (const module of xp.grantedModules) this.emitLoot({ module, source: 'milestone' });
  }

  tend(stationId: string): ActionResult<unknown> {
    const r = tend(this.state, stationId);
    if (r.ok) {
      this.emitTend({ stationId, xp: r.value.xp.xpGained, burst: r.value.burst, crit: r.value.crit });
      this.fireXp(r.value.xp);
      // Active-only loot drop — the chance gate + roll live in loot.ts. Passive
      // and offline production never call this. A keeper fires the loot banner; a
      // non-upgrade was auto-salvaged to dust (quiet beat).
      const drop = tryTendDrop(this.state);
      if (drop?.outcome === 'keep') this.emitLoot({ module: drop.module, source: 'drop' });
      else if (drop?.outcome === 'salvaged') this.emitAutosalvage(drop.dust);
      // 'potential' lands quietly in spares — a reroll project, not a banner moment.
    }
    this.notify();
    return r;
  }

  /**
   * Tending Whistle: tend every ready station in one sweep (same per-station XP,
   * burst, and loot rolls as manual tending — just batched). Because each tended
   * station goes on a fresh cooldown, a full sweep re-syncs them into a real
   * breather. Returns how many stations were tended.
   */
  tendAll(): { tended: number; xpGained: number } {
    let tended = 0;
    let xpGained = 0;
    let salvaged = 0; // batch auto-salvaged dust across the sweep into one beat
    for (const s of [...this.state.stations]) {
      if (s.tendCooldownRemaining > 0) continue;
      const r = tend(this.state, s.id);
      if (!r.ok) continue;
      tended++;
      xpGained += r.value.xp.xpGained;
      this.emitTend({ stationId: s.id, xp: r.value.xp.xpGained, burst: r.value.burst, crit: r.value.crit });
      this.fireXp(r.value.xp);
      const drop = tryTendDrop(this.state);
      if (drop?.outcome === 'keep') this.emitLoot({ module: drop.module, source: 'drop' });
      else if (drop?.outcome === 'salvaged') salvaged += drop.dust;
    }
    if (salvaged > 0) this.emitAutosalvage(salvaged);
    this.notify();
    return { tended, xpGained };
  }

  // ── Modules (homestead rack) ───────────────────────────────────────
  installModule(moduleId: string): ActionResult<unknown> {
    const r = installModule(this.state, moduleId);
    this.notify();
    return r;
  }
  uninstallModule(moduleId: string): ActionResult<unknown> {
    const r = uninstallModule(this.state, moduleId);
    this.notify();
    return r;
  }
  /** Install into a free socket, or swap in for the weakest if that improves the loadout. */
  swapInModule(moduleId: string): ActionResult<unknown> {
    const r = swapInModule(this.state, moduleId);
    this.notify();
    return r;
  }
  /** Greedy loadout optimizer: fill empty sockets + strictly-improving swaps. */
  autoFillRack(): ActionResult<{ installed: number; swapped: number }> {
    const r = autoFillRack(this.state);
    this.notify();
    return r;
  }
  salvageModule(moduleId: string): ActionResult<{ dust: number }> {
    const r = salvageModule(this.state, moduleId);
    this.notify();
    return r;
  }
  /** Bulk-salvage every spare of one rarity tier in one sweep. */
  bulkSalvageByTier(rarity: Rarity): ActionResult<{ count: number; dust: number }> {
    const r = bulkSalvageByTier(this.state, rarity);
    this.notify();
    return r;
  }
  /** Apply a playstyle preset's priority weights to the Auto-fill optimizer. */
  setPlaystyle(presetId: string): ActionResult<unknown> {
    const preset = playstylePreset(presetId);
    if (!preset) return { ok: false, reason: 'Unknown preset' };
    this.state.statWeights = { ...preset.weights } as Record<ModuleStat, number>;
    this.state.statWeightPreset = preset.id;
    this.notify();
    return { ok: true, value: undefined };
  }
  /** Hand-tune one stat's Auto-fill weight (switches the active preset to custom). */
  setStatWeight(stat: ModuleStat, value: number): void {
    this.state.statWeights = { ...this.state.statWeights, [stat]: Math.max(0, value) };
    this.state.statWeightPreset = 'custom';
    this.notify();
  }
  rerollModule(moduleId: string): ActionResult<unknown> {
    const r = rerollModule(this.state, moduleId);
    this.notify();
    return r;
  }

  // ── Breeding ───────────────────────────────────────────────────────
  pair(drakeId: string, henId: string): ActionResult<unknown> {
    const r = createPair(this.state, drakeId, henId);
    this.notify();
    return r;
  }
  unpair(pairId: string): ActionResult<unknown> {
    const r = removePair(this.state, pairId);
    this.notify();
    return r;
  }
  /** Toggle a pair's double clutch — 2× ducklings at 3× cost (the premium). */
  setDoubleClutch(pairId: string, on: boolean): ActionResult<unknown> {
    const r = setDoubleClutch(this.state, pairId, on);
    this.notify();
    return r;
  }
  /** Build the gene-reader: reveals the whole flock now + auto-reads new ducks. */
  buildGeneReader(): ActionResult<{ revealed: number }> {
    const r = buildGeneReader(this.state);
    this.notify();
    return r;
  }
  /** Set the Standard profile (drives quality readouts + the DING). */
  setGenomeTarget(target: Gene[]): ActionResult<unknown> {
    const r = setGenomeTarget(this.state, target);
    this.notify();
    return r;
  }
  /** Name (or clear the name of) a duck — the opt-in emotional layer. */
  nameDuck(duckId: string, name: string): ActionResult<unknown> {
    const r = setDuckName(this.state, duckId, name);
    this.notify();
    return r;
  }
  /** Cull (release) a duck — the selection lever that raises the live pop mean. */
  cull(duckId: string): ActionResult<unknown> {
    const r = cullDuck(this.state, duckId);
    this.notify();
    return r;
  }
  /** Bulk release ducks in one sweep (skips secured + paired keepers). */
  cullMany(duckIds: string[]): ActionResult<{ released: number }> {
    const r = cullDucks(this.state, duckIds);
    this.notify();
    return r;
  }
  /** Release the surplus drakes that make the flock over-crowded — the worst-genome,
   *  non-secured, non-paired drakes first (keeps your best studs). The one-tap fix
   *  for an injuring drake:hen ratio. */
  cullExcessDrakes(): ActionResult<{ released: number }> {
    const { excess } = flockRatio(this.state);
    if (excess <= 0) return { ok: false, reason: 'No excess drakes' };
    const paired = new Set(this.state.breedingPairs.flatMap((p) => [p.drakeId, p.henId]));
    // Worst genome first — with Prime carriers weighted to the very BACK of
    // the line: a lone P in a junk genome reads as a bad drake but is precious
    // stock for the Prime chase (same protection as the bulk-release tool).
    const cullRank = (d: Duck) =>
      d.genome.filter((g) => g === 'P').length * 10 + goodGeneCount(d.genome);
    const ids = this.state.ducks
      .filter(
        (d) => d.stage === 'adult' && d.sex === 'drake' && !d.secured && !d.post && !paired.has(d.id),
      )
      .sort((a, b) => cullRank(a) - cullRank(b))
      .slice(0, excess)
      .map((d) => d.id);
    const r = cullDucks(this.state, ids);
    this.notify();
    return r;
  }

  /** Set how many units of an ingredient the flock is fed per coop per cycle. */
  setRation(ingredient: Ingredient, value: number) {
    this.state.ration[ingredient] = Math.max(0, value);
    this.notify();
  }
  /** Set the grow-out ration fed to immature ducks (gates maturation). */
  setDucklingRation(ingredient: Ingredient, value: number) {
    this.state.ducklingRation[ingredient] = Math.max(0, value);
    this.notify();
  }
  /** Set the maintenance ration fed to adult drakes (gates breeding speed). */
  setDrakeRation(ingredient: Ingredient, value: number) {
    this.state.drakeRation[ingredient] = Math.max(0, value);
    this.notify();
  }
  /** Phase 6d: set the Winterstead ration (the 4th pool — winter eats last). */
  setWinterRation(ingredient: Ingredient, value: number) {
    this.state.winterRation[ingredient] = Math.max(0, value);
    this.notify();
  }
  /** Phase 6d: assign an adult hen to Winterstead (the premium winter pool). */
  assignToWinter(duckId: string): ActionResult<unknown> {
    const r = assignToWinter(this.state, duckId);
    this.notify();
    return r;
  }
  /** Phase 9a: post an adult duck to a working post (sentry/forager/broody). */
  assignToPost(duckId: string, post: PostId): ActionResult<unknown> {
    const r = assignToPost(this.state, duckId, post);
    this.notify();
    return r;
  }
  /** Phase 9a: bring a posted duck back to the laying/breeding flock. */
  recallFromPost(duckId: string): ActionResult<unknown> {
    const r = recallFromPost(this.state, duckId);
    this.notify();
    return r;
  }
  /** Phase 6d: bring a winter-assigned duck home. */
  recallFromWinter(duckId: string): ActionResult<unknown> {
    const r = recallFromWinter(this.state, duckId);
    this.notify();
    return r;
  }

  // ── Phase 4c: predator defenses + wound care ───────────────────────
  /** Build a deterrent (raises the homestead-wide protection floor). */
  buildDeterrent(): ActionResult<{ deterrents: number }> {
    const r = buildDeterrent(this.state);
    this.notify();
    return r;
  }
  /** Build a Secure Coop (adds secure slots for protecting prize breeders). */
  buildSecureCoop(): ActionResult<{ secureCoops: number }> {
    const r = buildSecureCoop(this.state);
    this.notify();
    return r;
  }
  /** Build one Infirmary — adds recovery slots for wounded ducks. */
  buildInfirmary(): ActionResult<{ infirmaries: number }> {
    const r = buildInfirmary(this.state);
    this.notify();
    return r;
  }
  /** Repair the deterrent floor back to pristine (active-only upkeep). */
  repairDeterrents(): ActionResult<{ cost: number }> {
    const r = repairDeterrents(this.state);
    this.notify();
    return r;
  }
  /** Build one length of hardware cloth — the ground defense vs the raccoon. */
  buildHardwareCloth(): ActionResult<{ hardwareCloth: number }> {
    const r = buildHardwareCloth(this.state);
    this.notify();
    return r;
  }
  /** Repair the hardware-cloth floor back to pristine. */
  repairHardwareCloth(): ActionResult<{ cost: number }> {
    const r = repairHardwareCloth(this.state);
    this.notify();
    return r;
  }
  // ── THE WATER SYSTEM: Pond layout + Waterworks circulation ─────────
  /** Place a provision feature on the pond canvas (Stage 1: layout). */
  placePondFeature(type: PondFeatureType, x: number, y: number): PondResult {
    const r = placePondFeature(this.state, type, x, y);
    if (r.ok) this.notify();
    return r;
  }
  /** Remove a provision feature (refunds part of its cost). */
  removePondFeature(x: number, y: number): PondResult {
    const r = removePondFeature(this.state, x, y);
    if (r.ok) this.notify();
    return r;
  }
  /** Upgrade a provision feature (+1 level → more water; escalating egg cost). */
  upgradePondFeature(x: number, y: number): PondResult {
    const r = upgradePondFeature(this.state, x, y);
    if (r.ok) this.notify();
    return r;
  }
  /** Place a circulation feature on the pond canvas (Stage 2: circulation). */
  placeFlowFeature(type: FlowFeatureType, x: number, y: number): PondResult {
    const r = placeFlowFeature(this.state, type, x, y);
    if (r.ok) this.notify();
    return r;
  }
  /** Remove a circulation feature (refunds part of its cost). */
  removeFlowFeature(x: number, y: number): PondResult {
    const r = removeFlowFeature(this.state, x, y);
    if (r.ok) this.notify();
    return r;
  }
  /** Mark/unmark a duck as secured (excluded from predator targeting). */
  setSecured(duckId: string, secured: boolean): ActionResult<unknown> {
    const r = setSecured(this.state, duckId, secured);
    this.notify();
    return r;
  }
  /** Admit a wounded duck to an infirmary recovery slot — the save that stops a
   *  wound escalating (if a slot is free). */
  admit(duckId: string): ActionResult<unknown> {
    const r = admitToInfirmary(this.state, duckId);
    this.notify();
    return r;
  }

  /** Mark the player as actively engaged (any meaningful interaction). Refreshes
   *  the active window — while it's live, predator dives drop the passive floor and
   *  demand a scare. Cheap; safe to call on every UI interaction. On the
   *  guard→active edge, wounds the guard brink-hold parked at the escalation
   *  threshold are rewound to a real triage window (the same return grace the
   *  offline path gets) — otherwise they'd all escalate on the first active
   *  frame, before any admit is possible. */
  markActive() {
    if (this.state.activeRemaining <= 0) rewindWoundsToBrink(this.state);
    this.state.activeRemaining = BALANCE.PREDATORS.ACTIVE_WINDOW_S;
  }

  /** A scare click on an in-flight owl dive — the active "be present" save. The
   *  final required click foils the strike (duck spared); an earlier one is a
   *  feint (the owl jukes away — click again). Returns the ScareResult, and drains
   *  the emitted event so banners/SFX fire. */
  scare(predatorId = 'owl'): ScareResult {
    const result = scareOff(this.state, predatorId);
    if (result) this.drainPredatorEvents();
    this.notify();
    return result;
  }

  /** Active-only intervention: clear one duck's niacin leg debuff. Pass a
   *  duckId to target a specific duck; omit for the first debuffed one. */
  dose(duckId?: string): ActionResult<unknown> {
    const r = doseNiacin(this.state, duckId);
    if (r.ok) this.fireXp(r.value.xp);
    this.notify();
    return r;
  }

  // ── Prestige (the meta loop) ───────────────────────────────────────
  /**
   * Raise your Legacy: wipe the run for permanent boosts. Gated by the champion
   * goal; the UI confirms first. Replaces state with a fresh game carrying the
   * meta forward, then saves so the legacy persists. Returns what was granted.
   */
  prestige(): { ok: boolean; granted: number; tier: number } {
    if (!canPrestige(this.state)) return { ok: false, granted: 0, tier: this.state.legacyTier };
    const granted = prestigeCurrency(this.state);
    const tier = this.state.legacyTier + 1;
    this.state = prestigeReset(this.state, Date.now());
    this.away = null;
    this.saveNow();
    this.notify();
    return { ok: true, granted, tier };
  }

  /** Spend legacy currency on the next level of a global-scalar boost. */
  buyBoost(id: BoostId): number | null {
    const lvl = buyBoostAction(this.state, id);
    this.notify();
    return lvl;
  }

  // ── The Grange (Phase 6b/8: contracts board) ────────────────────────
  /** Accept an offer as the one active contract (fails if one is already running). */
  acceptContract(contractId: string): ActionResult<unknown> {
    const r = acceptContract(this.state, contractId);
    this.notify();
    return r;
  }
  /** Abandon the active contract — the slot just frees up, no penalty. */
  abandonContract(): ActionResult<unknown> {
    const r = abandonContract(this.state);
    this.notify();
    return r;
  }
  /** Reroll the whole offer board for dust. */
  rerollContractOffers(): ActionResult<unknown> {
    const r = rerollOffers(this.state);
    this.notify();
    return r;
  }
  /** Claim the completed active contract's reward (dust/shards/module). */
  claimContract(): ActionResult<unknown> {
    const r = claimContract(this.state);
    if (r.ok) this.emitContractClaim(r.value);
    this.notify();
    return r;
  }
  /** Deliver against the active BREEDING COMMISSION — every line at once;
   *  auto-picks the worst qualifying fresh ducks per line (never Prime/
   *  secured/wintering). */
  deliverOrder(): ActionResult<unknown> {
    const r = deliverOrder(this.state);
    this.notify();
    return r;
  }
  /** Fulfil the active PROVISION ORDER — draws the full amount from central storage. */
  fulfilProvision(): ActionResult<unknown> {
    const r = fulfilProvision(this.state);
    this.notify();
    return r;
  }
  /** Present the active EXHIBITION (9d) — the show bench is judged in place. */
  presentExhibition(): ActionResult<unknown> {
    const r = presentExhibition(this.state);
    this.notify();
    return r;
  }

  // ── The Peddler (9e: goods for goods, blood for eggs) ───────────────
  /** Take a barter — your stock for his, at his prices. */
  acceptBarter(offerId: string): ActionResult<unknown> {
    const r = acceptBarter(this.state, offerId);
    this.notify();
    return r;
  }
  /** Buy a bloodline duck — clean outside blood, unrelated to the flock. */
  buyBloodline(offerId: string): ActionResult<unknown> {
    const r = buyBloodline(this.state, offerId);
    this.notify();
    return r;
  }
  /** Spin the cart early for dust — new goods, a fresh commission slot. */
  restockPeddler(): ActionResult<unknown> {
    const r = restockNow(this.state);
    this.notify();
    return r;
  }
  /** Commission a bloodline to spec — locked slots to order, the rest his stock. */
  commissionBloodline(sex: 'drake' | 'hen', locks: CommissionLocks): ActionResult<unknown> {
    const r = commissionBloodline(this.state, sex, locks);
    this.notify();
    return r;
  }

  /**
   * The tab became visible again after the browser paused the rAF loop
   * (hidden tab, minimized/occluded window, display sleep). The frame clamp
   * simulates at most 1s of such a gap, and the next autosave would erase its
   * offline credit — so before this hook, hidden time was simply destroyed:
   * strictly worse than closing the browser. Run the SAME offline catch-up a
   * page load gets (0.4× rate, mercy rail, 8h cap, Away summary): hidden time
   * IS offline time. `lastSeen` is trustworthy here — the visibility handler
   * saves on hide, and the autosave debounce keeps it within ~1.5s anyway.
   */
  resumeFromHidden(now: number) {
    const gapSeconds = (now - this.state.lastSeen) / 1000;
    if (gapSeconds <= BALANCE.VISIBILITY_CATCHUP_MIN_S) return;
    const away = runOfflineCatchUp(this.state, now);
    if (meaningfulAway(away)) this.away = away;
    // Returning to the tab IS being present — same as the page-load path
    // (start() marks active); this also grants brink-held wounds their triage
    // window via markActive's guard→active rewind.
    this.markActive();
    this.saveNow(now); // one clock for the whole operation
    this.notify();
  }

  /** Dismiss the "While you were away" summary. */
  clearAway() {
    this.away = null;
    this.notify();
  }

  /** Wipe the save and start a fresh homestead. */
  reset() {
    clearStorage();
    this.state = newGame(Date.now());
    this.away = null;
    this.conditionWasLow = false; // fresh detector state for the new run
    this.lastConditionReboundAt = 0;
    this.saveNow();
    this.notify();
  }

  /** Swap in an imported save (already validated + deserialized by the
   *  caller via save.ts's deserialize — see BackupControls) and persist it.
   *  Mirrors reset()'s bookkeeping so a restored save starts clean. */
  importState(state: GameState) {
    this.state = state;
    this.away = null;
    this.conditionWasLow = false;
    this.lastConditionReboundAt = 0;
    this.saveNow();
    this.notify();
  }

  /**
   * Adopt a newer CLOUD save (sync pull). Unlike a file restore, the gap
   * since the save's lastSeen is credited through the SAME offline catch-up a
   * page load gets — adopting a save parked hours ago on another device
   * arrives with its idle production, mercy-railed toll, and Away summary,
   * not frozen in the past. This is what makes newest-wins cheap: staleness
   * costs only the other device's *active* progress.
   */
  adoptCloudSave(raw: string, now: number) {
    const state = deserialize(raw, now);
    const away = runOfflineCatchUp(state, now);
    this.state = state;
    this.away = meaningfulAway(away) ? away : null;
    this.conditionWasLow = false;
    this.lastConditionReboundAt = 0;
    this.markActive(); // adopting IS being present — same as the load path
    this.saveNow(now);
    this.notify();
  }

  // ── Dev/testing helpers (used only by the dev-mode panel) ──────────
  devAddResource(res: Resource, n: number) {
    this.state.resources[res] += n;
    this.notify();
  }
  /** Grant XP and fire DINGs, just like tending would (for testing payoff). */
  devGainXP(n: number) {
    this.fireXp(gainXP(this.state, n));
    this.notify();
  }
  devClearCooldowns() {
    for (const s of this.state.stations) s.tendCooldownRemaining = 0;
    this.notify();
  }
  /** Force the owl's window open right now (skips the schedule) so the interactive
   *  dive can be seen without waiting. Marks predators introduced + active. */
  devOpenPredatorWindow() {
    this.state.predatorsIntroduced = true;
    const owl = BALANCE.PREDATORS.OWL;
    const firstAttackAt = owl.windowDurationSec / (owl.attacksPerWindow + 1);
    const ps = this.state.predators.owl;
    if (ps) {
      ps.timeToNextWindow = 0;
      ps.windowRemaining = owl.windowDurationSec;
      // Park just shy of the first staggered attack so a dive commits within a
      // second (no 20s wait to see the feature).
      ps.windowElapsed = Math.max(0, firstAttackAt - 0.5);
      ps.attacksFired = 0;
      ps.strike = undefined;
    }
    this.notify();
  }
}
