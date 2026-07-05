import { BALANCE } from '../config/balance';

/** XP required to advance FROM level n TO level n+1: geometric to the knee,
 *  then the gentler tail (see RANK_SOFT_KNEE in balance.ts). */
export function xpForLevel(n: number): number {
  const knee = BALANCE.RANK_SOFT_KNEE;
  if (n <= knee) return Math.round(BALANCE.RANK_BASE_XP * Math.pow(BALANCE.RANK_GROWTH, n - 1));
  return Math.round(
    BALANCE.RANK_BASE_XP *
      Math.pow(BALANCE.RANK_GROWTH, knee - 1) *
      Math.pow(BALANCE.RANK_TAIL_GROWTH, n - knee),
  );
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
  kind?: 'autohaul' | 'zone' | 'tend' | 'predator' | 'breeding';
}

/** Milestones earned at given ranks. */
export const MILESTONES: Milestone[] = [
  {
    rank: BALANCE.MILESTONE_AUTOHAUL_RANK,
    title: 'Auto-Haul Cart',
    description:
      'A cart now hauls every station’s output straight to central storage. No more manual collecting!',
  },
  {
    rank: BALANCE.MILESTONE_TENDALL_RANK,
    title: 'Tending Whistle',
    description:
      'One whistle tends every ready station at once — no more round-robin clicking, and a full sweep buys a real breather.',
    kind: 'tend',
  },
];

export function milestoneAtRank(rank: number): Milestone | undefined {
  return MILESTONES.find((m) => m.rank === rank);
}
