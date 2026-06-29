import { BALANCE, ZONE_DEFS, type ZoneDef } from '../config/balance';
import { MILESTONES } from '../game/rank';
import type { GameState } from '../game/state';
import {
  CartIcon,
  CheckIcon,
  CloseIcon,
  LockIcon,
  ModuleIcon,
  OwlIcon,
  TendIcon,
  WaterIcon,
} from './icons';

type Kind = 'predator' | 'autohaul' | 'tend' | 'zone' | 'module';
interface Unlock {
  rank: number;
  title: string;
  desc: string;
  kind: Kind;
}

const KIND_ICON: Record<Kind, typeof OwlIcon> = {
  predator: OwlIcon,
  autohaul: CartIcon,
  tend: TendIcon,
  zone: WaterIcon,
  module: ModuleIcon,
};

const zoneBlurb = (z: ZoneDef): string =>
  z.pondLayout
    ? 'A water layout canvas — arrange springs, pools, plant beds and a deep zone to give the flock more water (deeper condition + more time to treat wounds).'
    : z.waterworks
      ? 'Circulation for the pond — route intake → fountains → outflow to keep it fresh as a bigger flock fouls it faster.'
      : 'A new zone opens up.';

/** Build the rank-unlock list from the live config so the numbers never drift. */
function buildUnlocks(): Unlock[] {
  const out: Unlock[] = [];
  out.push({
    rank: BALANCE.PREDATORS.INTRO_RANK,
    title: 'Predators begin',
    desc: 'The owl starts hunting in telegraphed windows. Build deterrents, secure prize breeders, and treat wounds before they escalate.',
    kind: 'predator',
  });
  for (const m of MILESTONES) {
    out.push({ rank: m.rank, title: m.title, desc: m.description, kind: m.kind === 'tend' ? 'tend' : 'autohaul' });
  }
  for (const z of ZONE_DEFS) {
    if (z.unlock) out.push({ rank: z.unlock.rankRequired, title: z.name, desc: zoneBlurb(z), kind: 'zone' });
  }
  for (const [rank, rarity] of Object.entries(BALANCE.LOOT.MILESTONE_GRANTS)) {
    out.push({
      rank: Number(rank),
      title: `Guaranteed ${rarity} module`,
      desc: `A ${rarity} module is granted outright — a reliable power spike for your rack.`,
      kind: 'module',
    });
  }
  return out.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
}

const UNLOCKS = buildUnlocks();
const RANKS = [...new Set(UNLOCKS.map((u) => u.rank))].sort((a, b) => a - b);

/** "What unlocks by rank" — opened from the HUD rank bar. */
export function RankPanel({ state, onClose }: { state: GameState; onClose: () => void }) {
  const R = BALANCE.LOOT.RACK;
  const nextRank = RANKS.find((r) => r > state.rank);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Progression — unlocks by rank</h2>
          <button onClick={onClose} className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]" aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </div>
        <p className="mb-4 text-[11px] text-[#9a8a6a]">
          You're <b className="text-[#ffe9a8]">Rank {state.rank}</b>. XP comes only from tending —
          idle never ranks you up.
        </p>

        <div className="flex flex-col">
          {RANKS.map((rank, i) => {
            const reached = state.rank >= rank;
            const isNext = rank === nextRank;
            const items = UNLOCKS.filter((u) => u.rank === rank);
            return (
              <div key={rank} className="flex gap-3">
                {/* timeline rail */}
                <div className="flex flex-col items-center">
                  <div
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-black ring-1 ${
                      reached
                        ? 'bg-[#243a22] text-[#8fe388] ring-[#4a7a3a]'
                        : isNext
                          ? 'bg-[#3a2e22] text-[#ffe9a8] ring-[#5a4a32]'
                          : 'bg-[#1f1812] text-[#7a6a4a] ring-[#2e251a]'
                    }`}
                  >
                    {reached ? <CheckIcon size={14} /> : rank}
                  </div>
                  {i < RANKS.length - 1 && <div className="w-px flex-1 bg-[#3a2e22]" />}
                </div>

                {/* unlocks at this rank */}
                <div className="flex-1 pb-4">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
                    Rank {rank}
                    {reached ? ' · reached' : isNext ? ' · next up' : ''}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {items.map((u) => {
                      const Icon = KIND_ICON[u.kind];
                      return (
                        <div
                          key={u.title}
                          className={`flex items-start gap-2 rounded-md px-2.5 py-1.5 ${
                            reached ? 'bg-[#1f1812]' : 'bg-[#211910] opacity-70'
                          }`}
                        >
                          <span className="mt-0.5 shrink-0 text-[#c9b88f]">
                            {reached ? <Icon size={14} /> : <LockIcon size={12} />}
                          </span>
                          <span className="text-[11px]">
                            <b className={reached ? 'text-[#f5ecd8]' : 'text-[#b8a578]'}>{u.title}</b>
                            <span className="block text-[10px] leading-snug text-[#9a8a6a]">{u.desc}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-1 rounded-md bg-[#1f1812] px-3 py-2 text-[10px] leading-relaxed text-[#7a6a4a]">
          Your module rack also gains a socket every {R.ranksPerSocket} ranks (up to {R.maxSockets}).
          Prestige isn't rank-gated — it opens once your flock meets the champion goal (see Legacy).
        </div>
      </div>
    </div>
  );
}
