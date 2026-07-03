/**
 * guides.ts — THE ALMANAC (Phase 7): the one data-driven guide book.
 *
 * Each GuideDef is a page: a pure predicate on GameState (`when`) says when it
 * should open, and `title`/`body`/`cta` are what the player sees. This REPLACES
 * the old per-browser ad-hoc seen-flags (welcome, defenses-down) — see the
 * migrated entries below, which keep their legacy storage keys so a returning
 * browser doesn't re-see something it already dismissed.
 *
 * `when` predicates are PURE READS of GameState — they run ~1/sec against live
 * state via the reader (src/ui/useAlmanac.ts) and must never mutate. If a page
 * needs state that doesn't already exist as a selector, that's a sim question,
 * not a copy one — stop and ask rather than growing GameState for onboarding.
 *
 * Copy voice: warm, plain, concrete — a county almanac note, not a wiki page.
 * 2–5 sentences: what's true / what just happened, why it matters, ONE next
 * action (the CTA does it). Never state a number the player can't see in the UI.
 */
import { BALANCE } from './balance';
import { currentThreat, predatorsActive } from '../game/predators';
import { canPrestige, championReadiness } from '../game/prestige';
import {
  adultDrakes,
  breedingEstablished,
  coopCapacity,
  flockRatio,
  rationUnset,
  zoneUnlocked,
  type GameState,
} from '../game/state';
import {
  BackupIcon,
  DuckIcon,
  EggIcon,
  GrangeIcon,
  HealIcon,
  LegacyIcon,
  ModuleIcon,
  NutritionIcon,
  OwlIcon,
  ReaderIcon,
  SnowflakeIcon,
  type PixProps,
} from '../ui/icons';
import type { NutritionTab } from '../ui/NutritionPanel';

/** Which panel (App.tsx's boolean open-state) a CTA opens, and — for Nutrition
 *  only — which internal tab to land on. 'backup' has no modal; the reader
 *  scrolls the always-visible backup controls into view instead. */
export type GuideOpenTarget = 'nutrition' | 'flock' | 'modules' | 'watch' | 'legacy' | 'grange' | 'backup';

export interface GuideDef {
  /** localStorage key suffix: duck-homestead-guide-<id>. Stable — renaming a
   *  live id would replay the page for everyone who'd already seen it. */
  id: string;
  /** Overrides the derived storage key — ONLY for entries migrated from the
   *  pre-Almanac ad-hoc flags, so an already-dismissed browser stays dismissed. */
  legacyStorageKey?: string;
  title: string;
  body: string;
  icon: (p: PixProps) => React.JSX.Element;
  /** Red/urgent styling (only 'defenses-down' uses this today). */
  tone?: 'default' | 'danger';
  /** Pure predicate on GameState — when this page should open. Cheap: runs
   *  ~1/sec against live state. Read via selectors, never mutate. */
  when: (state: GameState) => boolean;
  /** Optional call-to-action that opens the relevant panel and marks seen. */
  cta?: { label: string; open: GuideOpenTarget; tab?: NutritionTab };
  /** Overrides the default "Got it" dismiss-button label. */
  dismissLabel?: string;
}

/** True once the pre-placed starter Coop is up but the flock is still short on
 *  protein AND calcium producers — the exact welcome trigger (migrated from
 *  App.tsx's old inline check, byte-for-byte). */
function missingStarterProducers(state: GameState): { hasCoop: boolean; missing: string[] } {
  const types = new Set(state.stations.map((s) => s.type));
  const hasCoop = types.has('coop');
  const missing = [
    !types.has('mealwormFarm') && 'a Mealworm Farm (protein)',
    !types.has('oysterSource') && 'an Oyster Source (calcium)',
  ].filter(Boolean) as string[];
  return { hasCoop, missing };
}

export const GUIDE_DEFS: GuideDef[] = [
  // ── Stuck-detection (Drew's explicit asks first) ──
  {
    id: 'rations-unset',
    title: 'Nothing is being fed',
    icon: NutritionIcon,
    body: 'Your flock is hungry — the ration is entirely unset, so egg output is throttled hard. Open Nutrition and either drag the sliders yourself or tap the Suggested button for a balanced starting mix.',
    when: (state) => state.nutrition != null && rationUnset(state.ration) && state.nutrition.eggMult < 0.6,
    cta: { label: 'Open Nutrition', open: 'nutrition', tab: 'layers' },
  },
  {
    id: 'breeding-nudge',
    title: 'A flock, not yet a program',
    icon: DuckIcon,
    body: 'Your ducks could be raising the next generation. Pick a drake and a hen in the Flock panel and pair them — a breeding pair lays fertilized clutches that hatch into ducklings, and that’s how a bigger, better flock gets built.',
    when: (state) =>
      state.rank >= 6 &&
      state.breedingPairs.length === 0 &&
      !state.geneReader &&
      state.ducks.some((d) => d.stage === 'adult' && d.sex === 'drake') &&
      state.ducks.some((d) => d.stage === 'adult' && d.sex === 'hen'),
    cta: { label: 'Open Flock', open: 'flock' },
  },
  {
    id: 'housing-full',
    title: 'The coops are full',
    icon: DuckIcon,
    body: 'Every housing slot is taken — a bigger flock needs more room. Upgrade or build another Coop to raise capacity, or open Flock and release your weakest ducks; selection is the whole game, so a thoughtful cull can matter as much as a new coop.',
    when: (state) =>
      state.ducks.length > 0 && coopCapacity(state) > 0 && state.ducks.length >= coopCapacity(state),
    cta: { label: 'Open Flock', open: 'flock' },
  },

  // ── First-contact explainers ──
  {
    id: 'welcome',
    legacyStorageKey: 'duck-homestead-welcome-seen',
    title: 'Welcome to your homestead!',
    icon: DuckIcon,
    body: 'It’s already running — the Coop is laying. The flock is short on protein and calcium, so build the missing producers from the build palette below, then open Nutrition to balance the ration.',
    when: (state) => {
      const { hasCoop, missing } = missingStarterProducers(state);
      return hasCoop && missing.length > 0;
    },
    cta: { label: 'Open Nutrition', open: 'nutrition', tab: 'layers' },
  },
  {
    id: 'defenses-down',
    legacyStorageKey: 'duck-homestead-defenses-down-seen',
    title: 'Defenses down!',
    icon: OwlIcon,
    tone: 'danger',
    body: 'The owl knows you’re at the keyboard. While you’re actively playing it ignores your built deterrents — your only defense is to scare each dive (tap the swooping owl). Miss one and a duck takes an injury. Step away a couple minutes and your deterrents take guard again.',
    when: (state) =>
      predatorsActive(state) && state.activeRemaining > 0 && currentThreat(state) != null,
    dismissLabel: 'Got it — I’ll scare them off',
  },
  {
    id: 'duckling-ration',
    title: 'Ducklings eat their own menu',
    icon: NutritionIcon,
    body: 'Growing ducks don’t touch the layer ration — they have their own grow-out feed, heavy on protein and niacin, and right now nothing’s set for it. An unfed clutch matures painfully slowly. Open Nutrition’s Ducklings tab and tap Suggested to get them growing.',
    when: (state) => state.ducks.some((d) => d.stage !== 'adult') && rationUnset(state.ducklingRation),
    cta: { label: 'Open Nutrition', open: 'nutrition', tab: 'ducklings' },
  },
  {
    id: 'drake-ration',
    title: 'Your drakes are on the clock too',
    icon: NutritionIcon,
    body: 'Now that breeding’s underway, adult drakes draw from their own maintenance ration — no calcium needed, since they don’t lay — and it’s still unset. An underfed drake breeds slower, throttling how fast new clutches come. Open Nutrition’s Drakes tab and tap Suggested.',
    when: (state) => breedingEstablished(state) && adultDrakes(state).length > 0 && rationUnset(state.drakeRation),
    cta: { label: 'Open Nutrition', open: 'nutrition', tab: 'drakes' },
  },
  {
    id: 'gene-reader',
    title: 'Genomes are hidden — for now',
    icon: ReaderIcon,
    body: 'Every duck is carrying a genome of six hidden genes, and you’ve got the eggs to stop guessing. Build the gene-reader and it reveals your whole flock at once, then reads every new hatch automatically — never a per-duck click. From there you can breed toward the Standard on purpose instead of by eye.',
    when: (state) =>
      state.breedingPairs.length > 0 &&
      !state.geneReader &&
      state.resources.eggs >= BALANCE.GENOME.READER_COST_EGGS,
    cta: { label: 'Open Flock', open: 'flock' },
  },
  {
    id: 'clutch-economy',
    title: 'A clutch is eggs, not free',
    icon: EggIcon,
    body: 'That pair isn’t just decorative — a running pair draws real eggs from storage every time it lays a clutch, priced against your flock’s peak output. Every clutch is a spend-vs-grow choice: park the pair to bank a surplus, or keep it running to grow the flock faster.',
    when: (state) => state.breedingPairs.length > 0,
    cta: { label: 'Open Flock', open: 'flock' },
  },
  {
    id: 'modules',
    title: 'Your first module',
    icon: ModuleIcon,
    body: 'That’s a piece of gear — modules boost throughput (speed, yield, egg output, tending) and slot into the homestead rack, one per scarce socket. Open Modules to install it, or try Auto-fill to have the optimizer pick the strongest loadout for your current sockets. Dupes aren’t dead weight either — salvage them for dust, then reroll.',
    when: (state) => state.inventory.length > 0 || state.rack.length > 0,
    cta: { label: 'Open Modules', open: 'modules' },
  },
  {
    id: 'wound-care',
    title: 'A wounded duck needs the infirmary',
    icon: HealIcon,
    body: 'A wound is soft, but it won’t heal on its own — admit the duck to an infirmary slot and it recovers over time. Left untended too long, a wound turns into a permanent loss. While you’re at the keyboard, triage is on you; step away and, if you’ve built one, the infirmary auto-admits up to capacity. Good water speeds recovery too.',
    when: (state) => state.ducks.some((d) => d.wounded),
    cta: { label: 'Open The Watch', open: 'watch' },
  },
  {
    id: 'rattled',
    title: 'Your flock is rattled',
    icon: DuckIcon,
    body: 'A hit — a wound, a crowding injury, a loss — knocks the flock’s condition battery down, and once it dips low enough the whole flock lays a little slower, even on a green ration. It’s a bruise, not a wall: keep the ration solid, the water flowing, and any condition-regen modules running, and the flock nurses itself back.',
    when: (state) => state.nutrition != null && state.nutrition.stressMult < 0.995,
    cta: { label: 'Open Nutrition', open: 'nutrition', tab: 'layers' },
  },
  {
    id: 'overcrowding',
    title: 'Too many drakes, not enough hens',
    icon: DuckIcon,
    body: 'Past a certain flock size, an over-drake ratio starts hurting the flock — drakes crowd and injure each other and the hens. The fix is the ratio, not more housing: open Flock and release the excess drakes (it keeps your best studs automatically).',
    when: (state) => flockRatio(state).injuring,
    cta: { label: 'Open Flock', open: 'flock' },
  },
  {
    id: 'champion-goal',
    title: 'The Standard is in reach',
    icon: LegacyIcon,
    body: 'Three things earn a champion: every color bred, your flock’s average genome quality past this tier’s gate, and enough ducks to match the target size. Open Legacy to see exactly which of the three is still short — that’s your whole to-do list toward prestige.',
    when: (state) => state.rank >= 14 || championReadiness(state) >= 0.25,
    cta: { label: 'Open Legacy', open: 'legacy' },
  },
  {
    id: 'prestige-ready',
    title: 'Ready to prestige',
    icon: LegacyIcon,
    body: 'Your flock has met the champion goal — you could raise your Legacy right now. But pushing further before you reset earns MORE legacy currency (overshoot pays), so it’s a real choice: bank the win now, or grow the flock a while longer first. Open Legacy to compare.',
    when: (state) => canPrestige(state),
    cta: { label: 'Open Legacy', open: 'legacy' },
  },
  {
    id: 'grange',
    title: 'The Grange is open',
    icon: GrangeIcon,
    body: 'The Grange is a rotating offer board — deliver eggs, hatch ducks to spec, or defend a window, and get paid in dust and legacy shards (sometimes a module). Accept one contract at a time; it’s a reason to keep actively playing a homestead that’s already humming.',
    when: (state) => state.legacyTier >= BALANCE.CONTRACTS.UNLOCK_TIER,
    cta: { label: 'Open The Grange', open: 'grange' },
  },
  {
    id: 'winterstead',
    title: 'Winterstead needs hands',
    icon: SnowflakeIcon,
    body: 'The second homestead is unlocked, but it starts empty. Assign hardy hens from the Flock panel (look for the snowflake) — Hardy genes finally pay off out here, at a real premium. Set the winter ration in Nutrition, and keep heaters near the winter coops; a cold coop still lays, just at a throttle.',
    when: (state) => zoneUnlocked(state, 'winterstead'),
    cta: { label: 'Open Flock', open: 'flock' },
  },
  {
    id: 'backup',
    title: 'Back up your homestead',
    icon: BackupIcon,
    body: 'Your homestead only lives in this browser’s storage — clear it by accident and the flock’s gone. It takes one click: the link at the very bottom of the screen exports your save as a file you can restore from later, on this browser or a new one.',
    when: (state) => state.rank >= 10,
    cta: { label: 'Back it up now', open: 'backup' },
  },
];

/** The full storage key for a def — legacy entries keep their pre-Almanac key. */
export function guideStorageKey(def: GuideDef): string {
  return def.legacyStorageKey ?? `duck-homestead-guide-${def.id}`;
}

/** The "re-show all tips" affordance: clears every page's seen-flag (by its
 *  ACTUAL key, including migrated legacy keys) so the whole book re-arms for
 *  this browser — testing, or handing the same browser to a second family
 *  member. `reset()` already does this as part of wiping every duck-homestead-*
 *  key; this is the same effect without touching the save itself. */
export function resetAllGuides(): void {
  try {
    for (const def of GUIDE_DEFS) localStorage.removeItem(guideStorageKey(def));
  } catch {
    /* ignore */
  }
}
