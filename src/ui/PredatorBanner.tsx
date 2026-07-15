import { currentThreats, type Threat } from '../game/predators';
import { defenseFloor, secureCapacity, type GameState } from '../game/state';
import { OwlIcon, RaccoonIcon, ShieldIcon, SiegeOwlIcon } from './icons';

/** Each predator wears its own face on the telegraph — an owl bar announcing
 *  a raccoon undersold the second defense line. */
const THREAT_ICON: Record<string, typeof OwlIcon> = {
  owl: OwlIcon,
  raccoon: RaccoonIcon,
  greatHorned: SiegeOwlIcon,
};

/**
 * The telegraph — a persistent, can't-miss bar pinned to the top of the screen
 * whenever a predator window is INCOMING or OPEN. Rendered purely from
 * GameState (currentThreats), so it always reflects the sim and never lets a
 * kill arrive unwarned. Windows can OVERLAP (owl + raccoon hunt on independent
 * clocks) — every live threat gets its own segment, each with its own icon,
 * phase, and clock, so a second hunter is never hidden behind the first.
 * Click to open the Watch panel and respond. Transient DING / loot pops float
 * above it; this bar persists for the whole window.
 */
export function PredatorBanner({ state, onOpen }: { state: GameState; onOpen: () => void }) {
  const threats = currentThreats(state);
  if (threats.length === 0) return null;

  // Per-threat dive check — activeStrike() returns only the first striker,
  // which hid a second predator's committed dive during an overlap.
  const strikeOn = (t: Threat) => state.predators[t.def.id]?.strike != null;
  const anyOpen = threats[0].phase === 'open'; // most urgent first
  const anyDiving = threats.some((t) => t.phase === 'open' && strikeOn(t));
  const solo = threats.length === 1;
  const secured = state.ducks.filter((d) => d.secured).length;
  const cap = secureCapacity(state);
  const floorPct = Math.round(defenseFloor(state) * 100);
  const exposed = state.ducks.filter((d) => !d.secured && !d.wounded).length;
  // ACTIVE play suppresses the passive floor — the scare is the only defense.
  const active = state.activeRemaining > 0;

  return (
    // Fixed to the viewport, so body's safe-area padding doesn't reach it —
    // pad the notch height directly (zero everywhere but notched phones).
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[45]"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <button
        type="button"
        onClick={onOpen}
        className={`pointer-events-auto flex w-full flex-wrap items-center justify-center gap-x-2.5 gap-y-0.5 px-4 py-1.5 text-xs font-bold shadow-lg ${
          anyDiving
            ? 'predator-pulse bg-[#6e1414] text-[#ffe2e2] ring-1 ring-[#ff8a8a]'
            : anyOpen
              ? 'predator-pulse bg-[#5a1f1f] text-[#ffd9d9] ring-1 ring-[#e26d6d]'
              : 'bg-[#5a4320] text-[#ffe9a8] ring-1 ring-[#e2b94f]'
        }`}
      >
        {threats.map((t, i) => {
          const Icon = THREAT_ICON[t.def.id] ?? OwlIcon;
          const diving = t.phase === 'open' && strikeOn(t);
          return (
            <span key={t.def.id} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="opacity-40">·</span>}
              <Icon size={18} />
              {diving ? (
                <span>
                  {t.def.name.toUpperCase()} DIVING — tap it on the board
                  {solo ? ' to scare it off!' : '!'}
                </span>
              ) : t.phase === 'open' ? (
                <span>
                  {t.def.name.toUpperCase()} HUNTING — {Math.ceil(t.seconds)}s
                  {solo ? ' left' : ''}
                </span>
              ) : (
                <span>
                  {t.def.name} in {Math.ceil(t.seconds)}s{solo ? ' — secure your breeders' : ''}
                </span>
              )}
            </span>
          );
        })}
        {anyOpen && <span>{exposed > 0 ? `${exposed} exposed` : 'all covered'}</span>}
        <span className="ml-1 inline-flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 text-[10px]">
          <ShieldIcon size={11} /> {secured}/{cap}
          <span className="opacity-60">·</span>
          {active ? <span className="text-[#ff9a9a]">defenses down — scare</span> : <>floor {floorPct}%</>}
        </span>
        {!anyDiving && (
          <span className="ml-1 text-[10px] uppercase tracking-wider opacity-70">tap to defend</span>
        )}
      </button>
    </div>
  );
}
