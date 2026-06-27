import { useState } from 'react';
import { STATION_DEFS } from '../config/balance';
import { stationStatus, UPGRADE_OUTPUT, upgradeCost } from '../game/actions';
import type { GameEngine } from '../game/engine';
import type { GameState, Resource, Station } from '../game/state';
import { fmt } from './format';
import { CollectIcon, EggIcon, HandIcon, RESOURCE_ICON, UpgradeIcon } from './icons';

interface Props {
  engine: GameEngine;
  state: GameState;
  station: Station | null;
}

/** Inline "<icon> amount" chip for a resource. */
function ResAmount({ res, amount }: { res: Resource; amount: number }) {
  const Icon = RESOURCE_ICON[res];
  return (
    <span className="inline-flex items-center gap-1">
      <Icon size={13} /> {fmt(amount)}
    </span>
  );
}

export function StationPanel({ engine, state, station }: Props) {
  const [msg, setMsg] = useState<string | null>(null);

  if (!station) {
    return (
      <div className="rounded-md bg-[#2a2018] px-3 py-4 text-center text-xs text-[#7a6a4a]">
        Select a station to tend or upgrade it.
      </div>
    );
  }

  const def = STATION_DEFS[station.type];
  const cost = upgradeCost(station);
  const canUpgrade = state.resources.eggs >= cost;
  const onCooldown = station.tendCooldownRemaining > 0;
  const bufferEntries = (Object.keys(station.buffer) as Resource[])
    .map((k) => [k, station.buffer[k] ?? 0] as const)
    .filter(([, v]) => v > 0);
  const hasBuffer = bufferEntries.length > 0;
  const outEntries = (Object.keys(def.outputs) as Resource[]).map(
    (k) => [k, (def.outputs[k] ?? 0) * UPGRADE_OUTPUT(station.level)] as const,
  );
  const status = stationStatus(state, station);

  const flash = (m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 1400);
  };

  return (
    <div className="flex flex-col gap-2 rounded-md bg-[#2a2018] px-3 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img
            src={`/assets/farm/${station.type}.png`}
            alt=""
            className="h-7 w-7 object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
          <span className="font-bold">{def.label}</span>
          <span className="rounded bg-[#1a1410] px-1.5 py-0.5 text-[10px] text-[#ffe9a8]">
            Level {station.level}
          </span>
        </div>
        <span className="text-[10px] text-[#9a8a6a]">
          ({station.x},{station.y})
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-[11px] text-[#c9b88f]">
        <span>Produces</span>
        {outEntries.map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1">
            <ResAmount res={k} amount={v} />/cycle
          </span>
        ))}
      </div>

      {/* Production status — explains a starved station (e.g. Coop needs pellets). */}
      {status.producing ? (
        <div className="flex items-center gap-1.5 text-[11px] text-[#8fe388]">
          <span className="inline-block h-2 w-2 rounded-full bg-[#8fe388]" />
          Producing
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-[#e8a35a]">
          <span className="inline-block h-2 w-2 rounded-full bg-[#e8a35a]" />
          <span>Idle — needs</span>
          {status.missing && <ResAmount res={status.missing.res} amount={status.missing.need} />}
          <span>in storage. Collect the station that makes {status.missing?.res}.</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-[#c9b88f]">
        <span>Buffer:</span>
        {hasBuffer ? (
          bufferEntries.map(([k, v]) => <ResAmount key={k} res={k} amount={v} />)
        ) : (
          <span className="text-[#7a6a4a]">empty</span>
        )}
        {state.autoHaulUnlocked && <span className="text-[#cdbcff]">(auto-hauled)</span>}
      </div>

      {/* Tend — the active engine + only XP source */}
      <button
        onClick={() => {
          const r = engine.tend(station.id);
          flash(r.ok ? '+XP! Tended.' : r.reason);
        }}
        disabled={onCooldown}
        className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-bold transition ${
          onCooldown
            ? 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
            : 'bg-[#8fe388] text-[#143010] hover:bg-[#a4f09c]'
        }`}
      >
        <HandIcon size={15} />
        {onCooldown ? `Tending in ${Math.ceil(station.tendCooldownRemaining)}s` : 'Tend (burst + XP)'}
      </button>
      <div className="-mt-1 text-center text-[10px] text-[#7a6a4a]">
        or double-click the station on the board
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => {
            const r = engine.upgrade(station.id);
            flash(r.ok ? 'Upgraded!' : r.reason);
          }}
          disabled={!canUpgrade}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold transition ${
            canUpgrade
              ? 'bg-[#e2b94f] text-[#2a2018] hover:bg-[#efc864]'
              : 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
          }`}
        >
          <UpgradeIcon size={13} /> Upgrade
          <span className="inline-flex items-center gap-0.5">
            · <EggIcon size={12} /> {cost}
          </span>
        </button>
        {!state.autoHaulUnlocked && (
          <button
            onClick={() => {
              engine.collect(station.id);
              flash('Collected.');
            }}
            disabled={!hasBuffer}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold transition ${
              hasBuffer
                ? 'bg-[#b87333] text-[#fff4d6] hover:bg-[#c9823c]'
                : 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
            }`}
          >
            <CollectIcon size={13} /> Collect
          </button>
        )}
      </div>

      {msg && <div className="text-center text-[11px] text-[#ffe9a8]">{msg}</div>}
    </div>
  );
}
