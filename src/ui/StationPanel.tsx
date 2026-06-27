import { useState } from 'react';
import { playCollect, playPlace, playRemove, playUpgrade } from '../audio/sfx';
import { BALANCE, STATION_DEFS } from '../config/balance';
import { stationStatus, UPGRADE_OUTPUT, upgradeCost } from '../game/actions';
import type { GameEngine } from '../game/engine';
import { moduleFits, slotCount } from '../game/loot';
import { coopCapacity, type GameState, type Resource, type Station } from '../game/state';
import { fmt } from './format';
import { CollectIcon, EggIcon, HandIcon, RESOURCE_ICON, UpgradeIcon } from './icons';
import { ModuleChip, STAT_META, fmtMagnitude } from './lootUi';

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

/** Module slots for a station: shows slotted modules and assigns from inventory. */
function StationSlots({ engine, state, station }: { engine: GameEngine; state: GameState; station: Station }) {
  const [picking, setPicking] = useState<number | null>(null);
  const slots = slotCount(station);
  const mods = station.modules ?? [];
  const fitting = state.inventory.filter((m) => moduleFits(m.stat, station.type));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
        Modules ({mods.length}/{slots})
      </div>
      {Array.from({ length: slots }).map((_, i) => {
        const m = mods[i];
        if (m) {
          return (
            <ModuleChip
              key={m.id}
              module={m}
              onRemove={() => engine.unassignModule(m.id)}
            />
          );
        }
        return (
          <div key={`empty-${i}`} className="flex flex-col gap-1">
            <button
              onClick={() => setPicking(picking === i ? null : i)}
              className="rounded-md border border-dashed border-[#4a3a2a] px-2 py-1 text-left text-[10px] text-[#7a6a4a] hover:border-[#6a5a3a] hover:text-[#9a8a6a]"
            >
              + empty slot
            </button>
            {picking === i && (
              <div className="flex flex-col gap-1 rounded-md bg-[#1f1812] p-1.5">
                {fitting.length === 0 ? (
                  <div className="px-1 py-0.5 text-[10px] text-[#7a6a4a]">
                    No fitting modules — tend stations to find some.
                  </div>
                ) : (
                  fitting.map((fm) => (
                    <button
                      key={fm.id}
                      onClick={() => {
                        if (engine.assignModule(station.id, fm.id).ok) {
                          playPlace();
                          setPicking(null);
                        }
                      }}
                      className="rounded px-1.5 py-1 text-left text-[10px] text-[#c9b88f] hover:bg-[#2a2018]"
                    >
                      <span className="font-bold">
                        {STAT_META[fm.stat].label} {fmtMagnitude(fm)}
                      </span>{' '}
                      <span className="capitalize text-[#7a6a4a]">· {fm.rarity}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Coop-specific status: housed flock, current lay %, and the flock dose action. */
function CoopStatus({
  engine,
  state,
  flash,
}: {
  engine: GameEngine;
  state: GameState;
  flash: (m: string) => void;
}) {
  const layPct = Math.round((state.nutrition?.eggMult ?? 1) * 100);
  const doseCost = BALANCE.NUTRITION.DOSE_COST_YEAST;
  const doseReady = state.doseCooldownRemaining <= 0 && state.resources.brewersYeast >= doseCost;
  const layColor = layPct >= 90 ? '#8fe388' : layPct >= 50 ? '#e8c45a' : '#e8835a';
  const adults = state.ducks.filter((d) => d.stage === 'adult');
  const layers = adults.filter((d) => d.sex === 'hen').length;
  const debuffed = state.ducks.filter((d) => d.debuffed).length;
  const cap = coopCapacity(state);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] text-[#c9b88f]">
        Flock: {state.ducks.length}/{cap} housed · {layers} laying hen{layers === 1 ? '' : 's'}
      </div>
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: layColor }}>
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: layColor }} />
        Laying at {layPct}%{' '}
        {debuffed > 0 && <span className="text-[#d95f5f]">· {debuffed} limping</span>}
      </div>
      {debuffed > 0 && (
        <button
          onClick={() => {
            const r = engine.dose();
            if (r.ok) playUpgrade();
            flash(r.ok ? 'Dosed — duck recovering!' : r.reason);
          }}
          disabled={!doseReady}
          className={`rounded-md px-2 py-1.5 text-xs font-bold transition ${
            doseReady
              ? 'bg-[#6b4f9e] text-[#fff4d6] hover:bg-[#7a5cae]'
              : 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
          }`}
        >
          {state.doseCooldownRemaining > 0
            ? `Dosing in ${Math.ceil(state.doseCooldownRemaining)}s`
            : `Dose Brewer's Yeast · ${doseCost}`}
        </button>
      )}
    </div>
  );
}

export function StationPanel({ engine, state, station }: Props) {
  const [msg, setMsg] = useState<string | null>(null);
  // Two-click confirm: armed only for the station whose id this matches.
  const [armedId, setArmedId] = useState<string | null>(null);

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

      {/* Production status — station-specific. */}
      {station.type === 'coop' ? (
        <CoopStatus engine={engine} state={state} flash={flash} />
      ) : station.type === 'mill' ? (
        <div className="text-[11px] text-[#c9b88f]">
          Blends the active ration. Open the Nutrition panel to formulate feed.
        </div>
      ) : status.producing ? (
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
            if (r.ok) playUpgrade();
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
              playCollect();
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

      <StationSlots engine={engine} state={state} station={station} />

      {/* Remove (demolish) — two-click confirm; refunds part of the cost. */}
      <button
        onClick={() => {
          if (armedId !== station.id) {
            setArmedId(station.id);
            window.setTimeout(() => setArmedId((a) => (a === station.id ? null : a)), 3000);
            return;
          }
          const r = engine.remove(station.id);
          setArmedId(null);
          if (r.ok) {
            playRemove();
            flash(`Removed (+${r.value.refund} eggs)`);
          }
        }}
        className={`rounded-md px-2 py-1.5 text-xs font-bold transition ${
          armedId === station.id
            ? 'bg-[#d95f5f] text-[#fff4d6] hover:bg-[#e57070]'
            : 'bg-[#2a2018] text-[#b06a6a] hover:bg-[#33271c]'
        }`}
      >
        {armedId === station.id
          ? 'Confirm remove?'
          : `Remove · refund ${Math.floor(BALANCE.COSTS[station.type] * BALANCE.REFUND_FRACTION)} eggs`}
      </button>

      {msg && <div className="text-center text-[11px] text-[#ffe9a8]">{msg}</div>}
    </div>
  );
}
