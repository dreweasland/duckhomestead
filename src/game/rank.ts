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
  kind?: 'autohaul' | 'zone' | 'tend' | 'predator' | 'breeding' | 'title' | 'module';
}

/** Milestones earned at given ranks. */
export const MILESTONES: Milestone[] = [
  {
    // Rank 20's marquee beat (it shadows the Warden title promotion — the
    // title still lives on the rank bar; an institution outranks a name).
    rank: BALANCE.PEDDLER.INTRO_RANK,
    title: 'The Peddler',
    description:
      'A wandering cart now calls at the homestead: goods for goods at his prices — he tends to carry whatever the season makes scarce — and, now and then, a bird of clean outside blood. Unrelated to every duck you own: the outcross your lines have been waiting for.',
    kind: 'zone',
  },
  {
    rank: BALANCE.PREDATORS.PAIRED_HUNT.INTRO_RANK,
    title: 'The Paired Hunt',
    description:
      'The owl and the raccoon have started hunting TOGETHER — rare coordinated windows where their dives come back-to-back. Foil every dive of a hunt and the Grange pays a guaranteed bounty.',
    kind: 'predator',
  },
  {
    rank: BALANCE.LOOT.RACK.bonusSocketRank,
    title: 'A Ninth Socket',
    description:
      'The homestead rack gains one more socket — room for one more module. Sockets are the scarcest thing in the rig; spend it well.',
    kind: 'module',
  },
  {
    rank: BALANCE.TEND_CRIT.RANK,
    title: 'Master Tend',
    description:
      'Your hands know the work now: every tend has a chance to CRIT, doubling its burst. The pop goes gold when it happens.',
    kind: 'tend',
  },
  ...BALANCE.RANK_TITLES.filter((t) => t.rank > 1).map((t) => ({
    rank: t.rank,
    title: `A promotion: ${t.title.toUpperCase()}`,
    description: `The county now knows you as a ${t.title}. It changes nothing and it means everything.`,
    kind: 'title' as const,
  })),
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

/** The highest rank title earned at `rank` (there is always one — rank 1 is
 *  'Homesteader'). */
export function rankTitle(rank: number): string {
  let best = BALANCE.RANK_TITLES[0].title;
  for (const t of BALANCE.RANK_TITLES) if (rank >= t.rank) best = t.title;
  return best;
}
