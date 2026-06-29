import { BALANCE, STATION_DEFS, STATION_ORDER, type StationType } from '../config/balance';
import type { GameState } from '../game/state';
import { CornIcon, EggIcon } from './icons';

interface Props {
  state: GameState;
  buildType: StationType | null;
  onPick: (t: StationType | null) => void;
}

const swatch = (color: string, label: string) => (
  <span className="inline-flex items-center gap-1">
    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
    {label}
  </span>
);

// The core production chain shares the top row; the four ingredient producers
// sit in the second row. On a 12-col grid that's span-4 (×3) over span-3 (×4).
const CORE: StationType[] = ['plot', 'mill', 'coop'];

const CHAIN_HINT: Record<StationType, React.ReactNode> = {
  plot: (
    <span className="inline-flex items-center gap-1">
      makes <CornIcon size={12} /> corn
    </span>
  ),
  mill: <span className="inline-flex items-center gap-1">blends the feed ration</span>,
  coop: (
    <span className="inline-flex items-center gap-1">
      lays <EggIcon size={12} /> eggs (fed)
    </span>
  ),
  peaPatch: swatch('#7fae54', 'peas · energy+protein'),
  mealwormFarm: swatch('#d9a07a', 'mealworms · protein'),
  yeastVat: swatch('#e8d9a0', 'yeast · niacin'),
  oysterSource: swatch('#c9cdd2', 'shell · calcium'),
};

export function BuildBar({ state, buildType, onPick }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-bold uppercase tracking-wider text-[#9a8a6a]">Build</div>
      <div className="grid grid-cols-12 gap-2">
        {STATION_ORDER.map((t) => {
          const cost = BALANCE.COSTS[t];
          const affordable = state.resources.eggs >= cost;
          const selected = buildType === t;
          const span = CORE.includes(t) ? 'col-span-4' : 'col-span-3';
          return (
            <button
              key={t}
              onClick={() => onPick(selected ? null : t)}
              className={`${span} flex flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left transition ${
                selected
                  ? 'border-[#fff4d6] bg-[#3a2e22]'
                  : 'border-transparent bg-[#2a2018] hover:bg-[#33271c]'
              } ${affordable ? '' : 'opacity-50'}`}
            >
              <div className="flex w-full items-center gap-1.5">
                <img
                  src={`/assets/farm/${t}.png`}
                  alt=""
                  className="h-6 w-6 object-contain"
                  style={{ imageRendering: 'pixelated' }}
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
          ? `Click an empty tile to place a ${STATION_DEFS[buildType].label} — or click an existing ${STATION_DEFS[buildType].label} to upgrade it. Click the button again to cancel.`
          : 'Click a tile to build. Click a station to select, double-click to tend, drag to move.'}
      </div>
    </div>
  );
}
