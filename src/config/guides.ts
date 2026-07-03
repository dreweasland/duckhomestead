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
import { currentThreat, predatorsActive } from '../game/predators';
import { rationUnset, type GameState } from '../game/state';
import { DuckIcon, NutritionIcon, OwlIcon, type PixProps } from '../ui/icons';
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
