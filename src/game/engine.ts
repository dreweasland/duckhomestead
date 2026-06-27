import { BALANCE, type StationType } from '../config/balance';
import {
  assignModule,
  collectAll,
  collectStation,
  doseNiacin,
  gainXP,
  moveStation,
  placeStation,
  rerollModule,
  removeStation,
  salvageModule,
  tend,
  unassignModule,
  upgradeStation,
  type ActionResult,
  type XpResult,
} from './actions';
import { tryTendDrop } from './loot';
import type { Milestone } from './rank';
import { clearStorage, loadGame, saveToStorage, type AwaySummary } from './save';
import { tick } from './tick';
import { initialState, type GameState, type Ingredient, type Module, type Resource } from './state';

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

type Listener = () => void;

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
  place(type: StationType, x: number, y: number): ActionResult<unknown> {
    const r = placeStation(this.state, type, x, y);
    this.notify();
    return r;
  }

  upgrade(stationId: string): ActionResult<unknown> {
    const r = upgradeStation(this.state, stationId);
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
      // and offline production never call this.
      const dropped = tryTendDrop(this.state);
      if (dropped) this.emitLoot({ module: dropped, source: 'drop' });
    }
    this.notify();
    return r;
  }

  // ── Modules ────────────────────────────────────────────────────────
  assignModule(stationId: string, moduleId: string): ActionResult<unknown> {
    const r = assignModule(this.state, stationId, moduleId);
    this.notify();
    return r;
  }
  unassignModule(moduleId: string): ActionResult<unknown> {
    const r = unassignModule(this.state, moduleId);
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

  /** Set how many units of an ingredient the flock is fed per coop per cycle. */
  setRation(ingredient: Ingredient, value: number) {
    this.state.ration[ingredient] = Math.max(0, value);
    this.notify();
  }

  /** Active-only intervention: clear one duck's niacin leg debuff. */
  dose(): ActionResult<unknown> {
    const r = doseNiacin(this.state);
    if (r.ok) this.fireXp(r.value.xp);
    this.notify();
    return r;
  }

  /** Dismiss the "While you were away" summary. */
  clearAway() {
    this.away = null;
    this.notify();
  }

  /** Wipe the save and start a fresh homestead. */
  reset() {
    clearStorage();
    this.state = initialState(Date.now());
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
