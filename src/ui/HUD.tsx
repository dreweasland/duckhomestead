import { BALANCE } from '../config/balance';
import type { GameState, Resource } from '../game/state';
import { rankProgress, xpForLevel } from '../game/rank';
import { fmt } from './format';
import { CartIcon, DuckIcon, LockIcon, RESOURCE_ICON } from './icons';

const RES: { key: Resource; label: string }[] = [
  { key: 'corn', label: 'Corn' },
  { key: 'pellets', label: 'Pellets' },
  { key: 'eggs', label: 'Eggs' },
];

export function HUD({ state }: { state: GameState }) {
  const prog = rankProgress(state.rank, state.xp);
  const need = xpForLevel(state.rank);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <DuckIcon size={28} title="Duck Homestead" />
        <h1 className="text-lg font-bold tracking-wide">Duck Homestead</h1>
      </div>

      {/* Resources */}
      <div className="flex gap-2">
        {RES.map((r) => {
          const Icon = RESOURCE_ICON[r.key];
          return (
            <div
              key={r.key}
              className="flex flex-1 items-center gap-1.5 rounded-md bg-[#2a2018] px-2.5 py-1.5"
              title={r.label}
            >
              <Icon size={16} title={r.label} />
              <span className="font-bold tabular-nums">{fmt(state.resources[r.key])}</span>
            </div>
          );
        })}
      </div>

      {/* Rank bar */}
      <div className="rounded-md bg-[#2a2018] px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="font-bold text-[#ffe9a8]">Homestead Rank {state.rank}</span>
          <span className="tabular-nums text-[#c9b88f]">
            {Math.floor(state.xp)} / {need} XP
          </span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-[#1a1410]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#e2b94f] to-[#8fe388] transition-[width] duration-150"
            style={{ width: `${prog * 100}%` }}
          />
        </div>
        <div className="mt-1 text-[10px] text-[#9a8a6a]">
          XP comes only from tending — idle never ranks you up.
        </div>
      </div>

      {/* Auto-haul status */}
      <div
        className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs ${
          state.autoHaulUnlocked ? 'bg-[#2e2746] text-[#cdbcff]' : 'bg-[#241c14] text-[#7a6a4a]'
        }`}
      >
        {state.autoHaulUnlocked ? (
          <>
            <CartIcon size={16} title="Auto-Haul Cart" />
            <span>Auto-Haul Cart active — output flows automatically.</span>
          </>
        ) : (
          <>
            <LockIcon size={13} />
            <span>Auto-Haul Cart unlocks at Rank {BALANCE.MILESTONE_AUTOHAUL_RANK}.</span>
          </>
        )}
      </div>
    </div>
  );
}
