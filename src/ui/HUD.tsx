import { useEffect, useState } from 'react';
import { isMuted, setMuted } from '../audio/sfx';
import type { GameState, Resource } from '../game/state';
import { rankProgress, rankTitle, xpForLevel } from '../game/rank';
import { fmt } from './format';
import { DuckIcon, MuteIcon, RESOURCE_ICON, SpeakerIcon } from './icons';
import { RankPanel } from './RankPanel';
import { ResourceFlowPanel } from './ResourceFlowPanel';
import { useEasedCounter } from './useEasedCounter';

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
  const [flowOpen, setFlowOpen] = useState(false);
  const { display: eggDisplay, flashKey } = useEasedCounter(state.resources.eggs);
  const [eggFlash, setEggFlash] = useState(false);
  useEffect(() => {
    if (flashKey === 0) return;
    setEggFlash(true);
    const t = window.setTimeout(() => setEggFlash(false), 600);
    return () => clearTimeout(t);
  }, [flashKey]);
  // Forage (foraged energy feed) only appears once a forage zone is in play;
  // the winter lines (6d) likewise only once any stock exists — pre-Winterstead
  // the HUD stays five-ingredient clean.
  let res = state.resources.forage > 0 ? [...RES, { key: 'forage' as Resource, label: 'Forage' }] : RES;
  if (state.resources.sunflowerSeeds > 0 || state.resources.fodderSprouts > 0) {
    res = [
      ...res,
      { key: 'sunflowerSeeds' as Resource, label: 'Sunflower Seeds' },
      { key: 'fodderSprouts' as Resource, label: 'Fodder Sprouts' },
    ];
  }

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

      {/* Resources: eggs (currency) + the five nutrition ingredients. Click any to
          see the full in/out/net flow breakdown for every currency. */}
      {flowOpen && <ResourceFlowPanel state={state} onClose={() => setFlowOpen(false)} />}
      <div className="grid grid-cols-3 gap-1.5">
        {res.map((r) => {
          const Icon = RESOURCE_ICON[r.key];
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => setFlowOpen(true)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition hover:ring-1 hover:ring-[#7a6a4a] ${
                r.key === 'eggs' ? 'bg-[#3a2e22] ring-1 ring-[#5a4a32]' : 'bg-[#2a2018]'
              } ${r.key === 'eggs' && eggFlash ? 'egg-jump-flash' : ''}`}
              title={`${r.label} — see resource flow`}
            >
              <Icon size={15} title={r.label} />
              <span className="text-sm font-bold tabular-nums">
                {fmt(r.key === 'eggs' ? eggDisplay : state.resources[r.key])}
              </span>
            </button>
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
          {/* The TITLE gets the row's right side (the XP readout moved onto
              the bar itself — playtest: give the promotion its real estate). */}
          <span className="font-bold text-[#b59a5a]">{rankTitle(state.rank)}</span>
        </div>
        <div className="relative h-5 overflow-hidden rounded-full bg-[#1a1410]">
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#e2b94f] to-[#8fe388] transition-[width] duration-150"
            style={{ width: `${prog * 100}%` }}
          />
          {/* A dark chip under the text — readable over the bright fill AND
              the empty track, no shadow tricks. */}
          <span className="absolute inset-0 grid place-items-center">
            <span className="rounded-full bg-[#1a1410]/75 px-2 py-[2px] text-[11px] font-bold tabular-nums leading-none text-[#ffe9a8]">
              {Math.floor(state.xp)} / {need} XP
            </span>
          </span>
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
