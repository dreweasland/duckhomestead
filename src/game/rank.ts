import { BALANCE } from '../config/balance';

/** XP required to advance FROM level n TO level n+1. */
export function xpForLevel(n: number): number {
  return Math.round(BALANCE.RANK_BASE_XP * Math.pow(BALANCE.RANK_GROWTH, n - 1));
}

/** Fraction [0,1] of the way to the next rank. */
export function rankProgress(rank: number, xp: number): number {
  const need = xpForLevel(rank);
  return need <= 0 ? 0 : Math.min(1, xp / need);
}

export interface Milestone {
  rank: number;
  title: string;
  description: string;
  /** Picks the banner icon. Defaults to the Auto-Haul cart. */
  kind?: 'autohaul' | 'zone';
}

/** Milestones earned at given ranks. Phase 1 has one: the Auto-Haul Cart. */
export const MILESTONES: Milestone[] = [
  {
    rank: BALANCE.MILESTONE_AUTOHAUL_RANK,
    title: 'Auto-Haul Cart',
    description:
      'A cart now hauls every station’s output straight to central storage. No more manual collecting!',
  },
];

export function milestoneAtRank(rank: number): Milestone | undefined {
  return MILESTONES.find((m) => m.rank === rank);
}
