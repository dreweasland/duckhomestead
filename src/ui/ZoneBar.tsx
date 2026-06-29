import { ZONE_DEFS, zoneDef } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { zoneUnlocked, type GameState } from '../game/state';
import { playUpgrade } from '../audio/sfx';
import { EggIcon, LockIcon } from './icons';

/** Tabs to switch the board between zones. Locked zones read as a dim tease. */
export function ZoneBar({
  state,
  activeZone,
  onPick,
}: {
  state: GameState;
  activeZone: string;
  onPick: (id: string) => void;
}) {
  if (ZONE_DEFS.length < 2) return null; // nothing to navigate yet
  return (
    <div className="flex flex-wrap gap-1.5">
      {ZONE_DEFS.map((z) => {
        const open = zoneUnlocked(state, z.id);
        const active = z.id === activeZone;
        return (
          <button
            key={z.id}
            onClick={() => onPick(z.id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition ${
              active
                ? 'bg-[#3a2e22] text-[#ffe9a8] ring-1 ring-[#5a4a32]'
                : 'bg-[#2a2018] text-[#9a8a6a] hover:bg-[#33271c]'
            }`}
          >
            {!open && <LockIcon size={11} />}
            {z.name}
          </button>
        );
      })}
    </div>
  );
}

/** Teaser + double-gated unlock for a locked zone (shown over its silhouette). */
export function ZoneUnlockCard({
  engine,
  state,
  zoneId,
}: {
  engine: GameEngine;
  state: GameState;
  zoneId: string;
}) {
  const zone = zoneDef(zoneId);
  if (!zone?.unlock) return null;
  const { rankRequired, eggCost } = zone.unlock;
  const rankMet = state.rank >= rankRequired;
  const canAfford = state.resources.eggs >= eggCost;
  const ready = rankMet && canAfford;

  return (
    <div className="w-full max-w-[460px] rounded-lg bg-[#2a2018] p-4 text-center ring-1 ring-[#3a2e22]">
      <div className="flex items-center justify-center gap-2 text-sm font-black text-[#ffe9a8]">
        <LockIcon size={14} /> {zone.name} — locked
      </div>
      <p className="mx-auto mt-1 max-w-xs text-[11px] text-[#9a8a6a]">
        New buildable space for more coops and stations.
        {zone.forage && ' Its free-range forage drips passive energy into your shared storage.'}
        {zone.water &&
          ' Its water access deepens flock condition and buys more time to treat wounds — and you can build water features to scale it.'}
      </p>

      <div className="mt-3 flex items-center justify-center gap-4 text-xs">
        <span className={rankMet ? 'text-[#8fe388]' : 'text-[#e8835a]'}>
          Rank {rankRequired}
          <span className="text-[#7a6a4a]"> (you’re {state.rank})</span>
        </span>
        <span className={`inline-flex items-center gap-1 ${canAfford ? 'text-[#8fe388]' : 'text-[#e8835a]'}`}>
          <EggIcon size={12} /> {eggCost.toLocaleString()}
        </span>
      </div>

      <button
        onClick={() => {
          if (engine.unlockZone(zoneId).ok) playUpgrade();
        }}
        disabled={!ready}
        className={`mt-3 rounded-md px-4 py-2 text-sm font-bold transition ${
          ready
            ? 'bg-[#6b4f9e] text-[#fff4d6] hover:bg-[#7a5cae]'
            : 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
        }`}
      >
        {ready
          ? `Unlock ${zone.name}`
          : !rankMet
            ? `Reach Rank ${rankRequired} first`
            : `Need ${eggCost.toLocaleString()} eggs`}
      </button>
    </div>
  );
}
