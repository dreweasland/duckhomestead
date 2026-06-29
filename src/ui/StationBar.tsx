import { useState } from 'react';
import { playCollect, playRemove, playUpgrade } from '../audio/sfx';
import { BALANCE, STATION_DEFS } from '../config/balance';
import { stationStatus, upgradeCost } from '../game/actions';
import type { GameEngine } from '../game/engine';
import type { GameState, Station } from '../game/state';
import { CloseIcon, CollectIcon, EggIcon, HandIcon, UpgradeIcon } from './icons';

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
  const canUpgrade = state.resources.eggs >= cost;
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
          className={`${btn} ${canUpgrade ? 'bg-[#e2b94f] text-[#2a2018] hover:bg-[#efc864]' : off}`}
        >
          <UpgradeIcon size={12} /> Upgrade
          <span className="inline-flex items-center gap-0.5">
            <EggIcon size={10} />
            {cost}
          </span>
        </button>
        {!state.autoHaulUnlocked && (
          <button
            onClick={() => {
              engine.collect(station.id);
              playCollect();
              flash('Collected.');
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
