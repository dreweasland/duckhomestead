import { BALANCE } from '../config/balance';
import type { GameState } from '../game/state';
import { CartIcon, LockIcon, TendIcon } from './icons';

/**
 * Compact, color-coded milestone pills shown just above the board — closer to
 * where they matter than the HUD. Each pill is active (lit + colored) or locked
 * (dim + lock); hover the pill (title) for the full description / unlock rank.
 */
export function StatusPills({ state }: { state: GameState }) {
  const pills = [
    {
      key: 'autohaul',
      active: state.autoHaulUnlocked,
      Icon: CartIcon,
      label: 'Auto-Haul',
      on: 'bg-[#2e2746] text-[#cdbcff] ring-[#4a3e6e]',
      title: state.autoHaulUnlocked
        ? 'Auto-Haul Cart active — every station’s output flows to storage automatically.'
        : `Auto-Haul Cart — unlocks at Rank ${BALANCE.MILESTONE_AUTOHAUL_RANK}. Hauls every station’s output for you (no manual collecting).`,
    },
    {
      key: 'tendall',
      active: state.tendAllUnlocked,
      Icon: TendIcon,
      label: 'Tend All',
      on: 'bg-[#1f3326] text-[#bfe8a8] ring-[#3a5a3a]',
      title: state.tendAllUnlocked
        ? 'Tending Whistle active — tend every ready station at once, and the sweep buys a real breather.'
        : `Tending Whistle — unlocks at Rank ${BALANCE.MILESTONE_TENDALL_RANK}. One click tends every ready station instead of round-robin clicking.`,
    },
  ];

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {pills.map((p) => (
        <span
          key={p.key}
          title={p.title}
          className={`inline-flex cursor-help items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold ring-1 transition ${
            p.active ? p.on : 'bg-[#241c14] text-[#7a6a4a] ring-[#2e251a]'
          }`}
        >
          {p.active ? <p.Icon size={11} /> : <LockIcon size={10} />}
          {p.label}
        </span>
      ))}
    </div>
  );
}
