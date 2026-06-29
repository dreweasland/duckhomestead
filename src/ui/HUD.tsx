import { useState } from 'react';
import { isMuted, setMuted } from '../audio/sfx';
import type { GameState, Resource } from '../game/state';
import { rankProgress, xpForLevel } from '../game/rank';
import { fmt } from './format';
import { DuckIcon, MuteIcon, RESOURCE_ICON, SpeakerIcon } from './icons';
import { RankPanel } from './RankPanel';

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
  const [ranksOpen, setRanksOpen] = useState(false);
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

      {/* Rank bar — click to see what unlocks by rank */}
      {ranksOpen && <RankPanel state={state} onClose={() => setRanksOpen(false)} />}
      <button
        type="button"
        onClick={() => setRanksOpen(true)}
        className="w-full rounded-md bg-[#2a2018] px-3 py-2 text-left ring-1 ring-transparent transition hover:bg-[#332615] hover:ring-[#5a4a32]"
        aria-label="See what unlocks by rank"
      >
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="inline-flex items-center gap-1.5 font-bold text-[#ffe9a8]">
            Homestead Rank {state.rank}
            <span className="grid h-4 w-4 place-items-center rounded-full bg-[#5a4a32] text-[10px] font-black text-[#ffe9a8]">
              ?
            </span>
          </span>
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
        <div className="mt-1 flex items-center justify-between text-[10px]">
          <span className="text-[#9a8a6a]">XP comes only from tending.</span>
          <span className="font-bold text-[#b59a5a]">See unlocks →</span>
        </div>
      </button>
      {/* Auto-Haul / Tending-Whistle status now live as pills above the board
          (see ui/StatusPills) — closer to where they matter, less HUD clutter. */}
    </div>
  );
}
