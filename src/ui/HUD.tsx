import { useState } from 'react';
import { isMuted, setMuted } from '../audio/sfx';
import { BALANCE } from '../config/balance';
import type { GameState, Resource } from '../game/state';
import { rankProgress, xpForLevel } from '../game/rank';
import { fmt } from './format';
import { CartIcon, DuckIcon, LockIcon, MuteIcon, RESOURCE_ICON, SpeakerIcon } from './icons';

// Eggs (currency) + the five nutrition ingredients. `pellets` is a retired
// Phase 1 field and is intentionally not shown.
const RES: { key: Resource; label: string }[] = [
  { key: 'eggs', label: 'Eggs' },
  { key: 'corn', label: 'Corn' },
  { key: 'peas', label: 'Peas' },
  { key: 'mealworms', label: 'Mealworms' },
  { key: 'brewersYeast', label: "Brewer's Yeast" },
  { key: 'oysterShell', label: 'Oyster Shell' },
];

export function HUD({ state }: { state: GameState }) {
  const prog = rankProgress(state.rank, state.xp);
  const need = xpForLevel(state.rank);
  const [muted, setMutedState] = useState(isMuted());
  // Forage (foraged energy feed) only appears once a forage zone is in play.
  const res =
    state.resources.forage > 0 ? [...RES, { key: 'forage' as Resource, label: 'Forage' }] : RES;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <DuckIcon size={28} title="Duck Homestead" />
        <h1 className="text-lg font-bold tracking-wide">Duck Homestead</h1>
        <button
          onClick={() => {
            const v = !muted;
            setMuted(v);
            setMutedState(v);
          }}
          className="ml-auto rounded p-1 text-[#9a8a6a] hover:bg-[#2a2018] hover:text-[#f5ecd8]"
          title={muted ? 'Unmute' : 'Mute'}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <MuteIcon size={18} /> : <SpeakerIcon size={18} />}
        </button>
      </div>

      {/* Resources: eggs (currency) + the five nutrition ingredients. */}
      <div className="grid grid-cols-3 gap-1.5">
        {res.map((r) => {
          const Icon = RESOURCE_ICON[r.key];
          return (
            <div
              key={r.key}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 ${
                r.key === 'eggs' ? 'bg-[#3a2e22] ring-1 ring-[#5a4a32]' : 'bg-[#2a2018]'
              }`}
              title={r.label}
            >
              <Icon size={15} title={r.label} />
              <span className="text-sm font-bold tabular-nums">{fmt(state.resources[r.key])}</span>
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
