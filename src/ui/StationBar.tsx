import { useState } from 'react';
import { playCollect, playRemove, playUpgrade } from '../audio/sfx';
import { BALANCE, STATION_DEFS } from '../config/balance';
import { millLoad, outputPerCycle, producerMaxed, stationStatus, upgradeCost } from '../game/actions';
import type { GameEngine } from '../game/engine';
import { coopCapacity, type GameState, type Resource, type Station } from '../game/state';
import {
  CloseIcon,
  CollectIcon,
  CornIcon,
  DuckIcon,
  EggIcon,
  ForageIcon,
  HandIcon,
  MealwormIcon,
  PeaIcon,
  PelletIcon,
  ShellIcon,
  SproutIcon,
  SunflowerIcon,
  UpgradeIcon,
  YeastIcon,
} from './icons';

/** Pixel icon + short label per resource (for the yield chip + collect flash). */
const RES_ICON: Record<Resource, typeof CornIcon> = {
  corn: CornIcon,
  peas: PeaIcon,
  mealworms: MealwormIcon,
  brewersYeast: YeastIcon,
  oysterShell: ShellIcon,
  sunflowerSeeds: SunflowerIcon,
  fodderSprouts: SproutIcon,
  forage: ForageIcon,
  pellets: PelletIcon,
  eggs: EggIcon,
};
const RES_LABEL: Record<Resource, string> = {
  corn: 'corn',
  peas: 'peas',
  mealworms: 'mealworms',
  brewersYeast: 'yeast',
  oysterShell: 'shell',
  sunflowerSeeds: 'seeds',
  fodderSprouts: 'sprouts',
  forage: 'forage',
  pellets: 'pellets',
  eggs: 'eggs',
};

/** Trim a per-cycle amount: whole numbers above 10, one decimal below. */
const fmtAmt = (n: number): string => (n >= 10 ? `${Math.round(n)}` : `${Math.round(n * 10) / 10}`);

/**
 * The selected-station controls as a slim, fixed strip pinned to the bottom of
 * the board — the key actions (tend / upgrade / collect / dose / remove) plus a
 * one-line status. Always the same place, minimal height, never covers tiles.
 * Replaces the old click-anchored popover. Deeper readouts live in Nutrition /
 * Flock; this is the quick action bar.
 */
export function StationBar({
  engine,
  state,
  station,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  station: Station;
  onClose: () => void;
}) {
  const [armed, setArmed] = useState(false); // remove two-click confirm
  const [msg, setMsg] = useState<string | null>(null);
  const flash = (m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 1400);
  };

  const def = STATION_DEFS[station.type];
  const cost = upgradeCost(station);
  const maxed = producerMaxed(station); // producer at its output cap — build another instead
  const canUpgrade = !maxed && state.resources.eggs >= cost;
  const onCooldown = station.tendCooldownRemaining > 0;
  const hasBuffer = Object.values(station.buffer).some((v) => (v ?? 0) > 0);
  const status = stationStatus(state, station);

  // One-line status, station-specific.
  let statusText: string;
  let statusColor = '#8fe388';
  if (onCooldown) {
    statusText = `Tending in ${Math.ceil(station.tendCooldownRemaining)}s`;
    statusColor = '#9a8a6a';
  } else if (station.type === 'coop') {
    const layPct = Math.round((state.nutrition?.eggMult ?? 1) * 100);
    statusText = `Laying ${layPct}%`;
    statusColor = layPct >= 90 ? '#8fe388' : layPct >= 50 ? '#e8c45a' : '#e8835a';
  } else if (station.type === 'mill') {
    statusText = 'Blending ration';
    statusColor = '#c9b88f';
  } else if (status.producing) {
    statusText = 'Producing';
  } else {
    statusText = `Idle — needs ${status.missing?.res ?? 'input'}`;
    statusColor = '#e8a35a';
  }

  // Yield / capacity readout: coops show duck capacity (their "output" is eggs,
  // produced via nutrition, not a flat per-cycle number); every other producer
  // shows its true per-cycle yield.
  const isCoop = station.type === 'coop';
  const isMill = station.type === 'mill';
  const thisCoopCap = BALANCE.BREEDING.COOP_CAPACITY * station.level;
  const totalCap = coopCapacity(state);
  const flock = state.ducks.length;
  const yields = isCoop || isMill ? [] : outputPerCycle(state, station);
  // Mill load: the flock's blend demand vs total mill capacity (the "do I need
  // another mill?" read). Colour ramps amber → red as it nears/exceeds 100%.
  const load = isMill ? millLoad(state) : null;
  const millColor = !load
    ? '#c9b88f'
    : load.ratio >= 1
      ? '#e8835a'
      : load.ratio >= 0.8
        ? '#e8c45a'
        : '#8fe388';
  const millPctStr = load ? (Number.isFinite(load.ratio) ? `${Math.round(load.ratio * 100)}%` : '∞') : '';

  const debuffed = station.type === 'coop' && state.ducks.some((d) => d.debuffed);
  const doseCost = BALANCE.NUTRITION.DOSE_COST_YEAST;
  const doseReady = state.doseCooldownRemaining <= 0 && state.resources.brewersYeast >= doseCost;

  const btn = 'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-bold transition';
  const off = 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]';

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[#3a2e22] px-1 pt-2">
      {/* identity */}
      <div className="flex items-center gap-1.5">
        <img
          src={`/assets/farm/${station.type}.png`}
          alt=""
          className="h-5 w-5 object-contain"
          style={{ imageRendering: 'pixelated' }}
        />
        <span className="text-sm font-bold">{def.label}</span>
        <span className="rounded bg-[#1a1410] px-1.5 py-0.5 text-[10px] text-[#ffe9a8]">Lv {station.level}</span>
      </div>
      {/* status */}
      <span className="flex items-center gap-1 text-[11px]" style={{ color: statusColor }}>
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
        {statusText}
      </span>

      {/* yield (per cycle) / duck capacity (coops) / blend load (mills) */}
      {isCoop ? (
        <span className="flex items-center gap-1 text-[11px] text-[#c9b88f]" title="This coop's housing · whole-flock usage">
          <DuckIcon size={12} /> {thisCoopCap} cap
          <span className="text-[#7a6a4a]">· flock {flock}/{totalCap}</span>
        </span>
      ) : isMill && load ? (
        <span
          className="flex items-center gap-1 text-[11px]"
          style={{ color: millColor }}
          title="Flock blend demand vs total mill capacity — over 100% means feed is throttled; add or upgrade a mill"
        >
          {millPctStr} mill load
          {load.hasMill && (
            <span className="text-[#7a6a4a]">
              · {load.demand.toFixed(1)}/{load.capacity.toFixed(1)}/s
            </span>
          )}
        </span>
      ) : yields.length > 0 ? (
        <span className="flex items-center gap-1 text-[11px] text-[#c9b88f]" title="Produced each cycle (level + yield bonuses applied)">
          {yields.map(({ resource, amount }) => {
            const Icon = RES_ICON[resource];
            return (
              <span key={resource} className="flex items-center gap-0.5">
                +{fmtAmt(amount)} <Icon size={12} />
              </span>
            );
          })}
          <span className="text-[#7a6a4a]">/ cycle</span>
        </span>
      ) : null}

      {/* actions, pushed to the right */}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => {
            const r = engine.tend(station.id);
            flash(r.ok ? '+XP! Tended.' : r.reason);
          }}
          disabled={onCooldown}
          className={`${btn} ${onCooldown ? off : 'bg-[#8fe388] text-[#143010] hover:bg-[#a4f09c]'}`}
        >
          <HandIcon size={12} /> Tend
        </button>
        <button
          onClick={() => {
            const r = engine.upgrade(station.id);
            if (r.ok) playUpgrade();
            flash(r.ok ? 'Upgraded!' : r.reason);
          }}
          disabled={!canUpgrade}
          title={maxed ? 'Output capped — build another producer to grow' : undefined}
          className={`${btn} ${canUpgrade ? 'bg-[#e2b94f] text-[#2a2018] hover:bg-[#efc864]' : off}`}
        >
          <UpgradeIcon size={12} /> Upgrade
          {maxed ? (
            <span className="font-black tracking-wide">MAX</span>
          ) : (
            <span className="inline-flex items-center gap-0.5">
              <EggIcon size={10} />
              {cost}
            </span>
          )}
        </button>
        {!state.autoHaulUnlocked && (
          <button
            onClick={() => {
              const r = engine.collect(station.id);
              playCollect();
              const moved = (r.ok ? r.value : null) as Partial<Record<Resource, number>> | null;
              const parts = moved
                ? (Object.entries(moved) as [Resource, number][])
                    .filter(([, amt]) => amt > 0)
                    .map(([res, amt]) => `+${Math.round(amt)} ${RES_LABEL[res]}`)
                : [];
              flash(parts.length ? `Collected ${parts.join(', ')}` : 'Collected.');
            }}
            disabled={!hasBuffer}
            className={`${btn} ${hasBuffer ? 'bg-[#b87333] text-[#fff4d6] hover:bg-[#c9823c]' : off}`}
          >
            <CollectIcon size={12} /> Collect
          </button>
        )}
        {debuffed && (
          <button
            onClick={() => {
              const r = engine.dose();
              if (r.ok) playUpgrade();
              flash(r.ok ? 'Dosed — duck recovering!' : r.reason);
            }}
            disabled={!doseReady}
            className={`${btn} ${doseReady ? 'bg-[#6b4f9e] text-[#fff4d6] hover:bg-[#7a5cae]' : off}`}
          >
            {state.doseCooldownRemaining > 0 ? `Dose ${Math.ceil(state.doseCooldownRemaining)}s` : `Dose · ${doseCost}`}
          </button>
        )}
        <button
          onClick={() => {
            if (!armed) {
              setArmed(true);
              window.setTimeout(() => setArmed(false), 3000);
              return;
            }
            const r = engine.remove(station.id);
            setArmed(false);
            if (r.ok) {
              playRemove();
              onClose();
            }
          }}
          className={`${btn} ${armed ? 'bg-[#d95f5f] text-[#fff4d6] hover:bg-[#e57070]' : 'bg-[#2a2018] text-[#b06a6a] hover:bg-[#33271c]'}`}
        >
          {armed ? 'Confirm?' : 'Remove'}
        </button>
        <button
          onClick={onClose}
          aria-label="Deselect"
          className="rounded p-1 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]"
        >
          <CloseIcon size={13} />
        </button>
      </div>
      {msg && <div className="w-full text-[11px] text-[#ffe9a8]">{msg}</div>}
    </div>
  );
}
