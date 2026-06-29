import { activeStrike, currentThreat } from '../game/predators';
import { defenseFloor, secureCapacity, type GameState } from '../game/state';
import { OwlIcon, ShieldIcon } from './icons';

/**
 * The telegraph — a persistent, can't-miss bar pinned to the top of the screen
 * whenever a predator window is INCOMING or OPEN. Rendered purely from
 * GameState (currentThreat), so it always reflects the sim and never lets a kill
 * arrive unwarned. Click to open the Watch panel and respond. Transient DING /
 * loot pops float above it; this bar persists for the whole window.
 */
export function PredatorBanner({ state, onOpen }: { state: GameState; onOpen: () => void }) {
  const threat = currentThreat(state);
  if (!threat) return null;

  const open = threat.phase === 'open';
  const diving = open && activeStrike(state) !== null;
  const secured = state.ducks.filter((d) => d.secured).length;
  const cap = secureCapacity(state);
  const floorPct = Math.round(defenseFloor(state) * 100);
  const exposed = state.ducks.filter((d) => !d.secured && !d.wounded).length;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[45]">
      <button
        type="button"
        onClick={onOpen}
        className={`pointer-events-auto flex w-full items-center justify-center gap-2.5 px-4 py-1.5 text-xs font-bold shadow-lg ${
          diving
            ? 'predator-pulse bg-[#6e1414] text-[#ffe2e2] ring-1 ring-[#ff8a8a]'
            : open
              ? 'predator-pulse bg-[#5a1f1f] text-[#ffd9d9] ring-1 ring-[#e26d6d]'
              : 'bg-[#5a4320] text-[#ffe9a8] ring-1 ring-[#e2b94f]'
        }`}
      >
        <OwlIcon size={18} />
        {diving ? (
          <span>{threat.def.name.toUpperCase()} DIVING — tap the owl on the board to scare it off!</span>
        ) : open ? (
          <span>
            {threat.def.name.toUpperCase()} HUNTING — {Math.ceil(threat.seconds)}s left.{' '}
            {exposed > 0 ? `${exposed} exposed` : 'all covered'}
          </span>
        ) : (
          <span>
            {threat.def.name} incoming in {Math.ceil(threat.seconds)}s — secure your breeders
          </span>
        )}
        <span className="ml-1 inline-flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 text-[10px]">
          <ShieldIcon size={11} /> {secured}/{cap}
          <span className="opacity-60">·</span>floor {floorPct}%
        </span>
        {!diving && (
          <span className="ml-1 text-[10px] uppercase tracking-wider opacity-70">tap to defend</span>
        )}
      </button>
    </div>
  );
}
