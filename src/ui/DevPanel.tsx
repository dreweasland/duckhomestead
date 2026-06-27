import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { xpForLevel } from '../game/rank';
import type { GameState } from '../game/state';

/**
 * Dev-only tuning aid. Rendered only when import.meta.env.DEV is true, so it is
 * tree-shaken out of production builds. Lets you feel the loop without grinding:
 * jump rank to see the DING / Auto-Haul payoff, add eggs to build freely, and
 * reset tend cooldowns.
 */
export function DevPanel({ engine, state }: { engine: GameEngine; state: GameState }) {
  /** XP needed to advance exactly one rank from where we are now. */
  const oneRank = () => engine.devGainXP(xpForLevel(state.rank) - state.xp + 1);
  const toRank5 = () => {
    let xp = 0;
    for (let r = state.rank; r < BALANCE.MILESTONE_AUTOHAUL_RANK; r++) xp += xpForLevel(r);
    engine.devGainXP(xp - state.xp + 1);
  };

  const Btn = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      className="rounded bg-[#3a2e22] px-2 py-1 text-[11px] font-bold text-[#ffe9a8] hover:bg-[#4a3a2a]"
    >
      {children}
    </button>
  );

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-[#4a3a2a] bg-[#1f1812] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
        Dev tools (dev build only)
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Btn onClick={() => engine.devAddResource('eggs', 100)}>+100 eggs</Btn>
        <Btn onClick={() => engine.devAddResource('eggs', 1000)}>+1000 eggs</Btn>
        <Btn onClick={oneRank}>+1 rank (DING)</Btn>
        <Btn onClick={toRank5}>Jump to Rank {BALANCE.MILESTONE_AUTOHAUL_RANK}</Btn>
        <Btn onClick={() => engine.devClearCooldowns()}>Tend ready</Btn>
      </div>
    </div>
  );
}
