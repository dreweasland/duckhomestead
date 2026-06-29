import { BALANCE, type StationType } from '../config/balance';
import {
  autoFillRack,
  buildDeterrent,
  buildGeneReader,
  buildSecureCoop,
  repairDeterrents,
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
  rerollModule,
  removeStation,
  salvageModule,
  setSecured,
  swapInModule,
  tend,
  treatDuck,
  uninstallModule,
  unlockZone as unlockZoneAction,
  upgradeStation,
  type ActionResult,
  type XpResult,
} from './actions';
import { zoneDef } from '../config/balance';
import { tryTendDrop } from './loot';
import type { Milestone } from './rank';
import { clearStorage, loadGame, newGame, saveToStorage, type AwaySummary } from './save';
import { tick } from './tick';
import {
  placeFlowFeature,
  placePondFeature,
  removeFlowFeature,
  removePondFeature,
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
  type GameState,
  type Ingredient,
  type Module,
  type PredatorEvent,
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
}

/** Emitted when a module enters the inventory — the loot moment. */
export interface LootEvent {
  module: Module;
  source: 'drop' | 'milestone';
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
  private lootListeners = new Set<(e: LootEvent) => void>();
  private dexListeners = new Set<(e: DexEvent) => void>();
  private predatorListeners = new Set<(e: PredatorEvent) => void>();
  private autosalvageListeners = new Set<(dust: number) => void>();

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
  private notify() {
    for (const fn of this.listeners) fn();
  }
  private emitDing(e: DingEvent) {
    for (const fn of this.dingListeners) fn(e);
  }
  private emitTend(e: TendEvent) {
    for (const fn of this.tendListeners) fn(e);
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
  /** Fire DINGs for any first-of-color hatches accrued during ticks. */
  private drainDex() {
    const pending = this.state.pendingDex;
    if (!pending || pending.length === 0) return;
    for (const color of pending) this.emitDex({ color });
    this.state.pendingDex = [];
  }
  /** Surface predator events (telegraph / attack / loss) accrued during ticks.
   *  First contact (the 'introduced' beat) is promoted to a milestone DING so the
   *  player gets a clear, can't-miss "predators now hunt here" moment — always
   *  while present, never as a silent surprise. */
  private drainPredatorEvents() {
    const pending = this.state.pendingPredatorEvents;
    if (!pending || pending.length === 0) return;
    for (const e of pending) {
      if (e.kind === 'introduced') {
        this.emitDing({
          newRank: this.state.rank,
          levelsGained: 0,
          milestones: [
            {
              rank: this.state.rank,
              title: 'Predators',
              description:
                'An owl now hunts the homestead in telegraphed windows. Build deterrents, secure your prize breeders, and treat any wounds before they turn fatal — open The Watch.',
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
      this.drainPredatorEvents(); // telegraph / attack / loss feedback this frame
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
  saveNow() {
    if (this.saveTimer != null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    saveToStorage(this.state, Date.now());
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
    this.notify();
    return r;
  }

  collectEverything() {
    collectAll(this.state);
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
      this.emitTend({ stationId, xp: r.value.xp.xpGained });
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
      this.emitTend({ stationId: s.id, xp: r.value.xp.xpGained });
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
  /** Build the gene-reader: reveals the whole flock now + auto-reads new ducks. */
  buildGeneReader(): ActionResult<{ revealed: number }> {
    const r = buildGeneReader(this.state);
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
  /** Repair the deterrent floor back to pristine (active-only upkeep). */
  repairDeterrents(): ActionResult<{ cost: number }> {
    const r = repairDeterrents(this.state);
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
  /** Treat a wounded duck — the active save that stops a wound escalating. */
  treat(duckId: string): ActionResult<unknown> {
    const r = treatDuck(this.state, duckId);
    this.notify();
    return r;
  }

  /** Active-only intervention: clear one duck's niacin leg debuff. */
  dose(): ActionResult<unknown> {
    const r = doseNiacin(this.state);
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
    this.saveNow();
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
}
