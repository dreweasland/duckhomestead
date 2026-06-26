import { BALANCE, STATION_DEFS, STATION_ORDER, type StationType } from '../config/balance';
import type { GameState } from '../game/state';
import { CornIcon, EggIcon, PelletIcon } from './icons';

interface Props {
  state: GameState;
  buildType: StationType | null;
  onPick: (t: StationType | null) => void;
}

const CHAIN_HINT: Record<StationType, React.ReactNode> = {
  plot: (
    <span className="inline-flex items-center gap-1">
      makes <CornIcon size={12} /> corn
    </span>
  ),
  mill: (
    <span className="inline-flex items-center gap-1">
      <CornIcon size={12} /> → <PelletIcon size={12} /> pellets
    </span>
  ),
  coop: (
    <span className="inline-flex items-center gap-1">
      <PelletIcon size={12} /> → <EggIcon size={12} /> eggs
    </span>
  ),
};

export function BuildBar({ state, buildType, onPick }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-bold uppercase tracking-wider text-[#9a8a6a]">Build</div>
      <div className="flex gap-2">
        {STATION_ORDER.map((t) => {
          const cost = BALANCE.COSTS[t];
          const affordable = state.resources.eggs >= cost;
          const selected = buildType === t;
          return (
            <button
              key={t}
              onClick={() => onPick(selected ? null : t)}
              className={`flex flex-1 flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left transition ${
                selected
                  ? 'border-[#fff4d6] bg-[#3a2e22]'
                  : 'border-transparent bg-[#2a2018] hover:bg-[#33271c]'
              } ${affordable ? '' : 'opacity-50'}`}
            >
              <div className="flex w-full items-center gap-1.5">
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ background: `#${STATION_DEFS[t].color.toString(16).padStart(6, '0')}` }}
                />
                <span className="text-sm font-bold">{STATION_DEFS[t].label}</span>
              </div>
              <span className="text-[10px] text-[#c9b88f]">{CHAIN_HINT[t]}</span>
              <span className="inline-flex items-center gap-1 text-xs font-bold text-[#ffe9a8]">
                <EggIcon size={12} /> {cost}
              </span>
            </button>
          );
        })}
      </div>
      <div className="text-[10px] text-[#7a6a4a]">
        {buildType
          ? `Click an empty tile to place a ${STATION_DEFS[buildType].label}. Click again to cancel.`
          : 'Pick a station, then click a tile. Click a placed station to tend & upgrade it.'}
      </div>
    </div>
  );
}
