import { useEffect, useRef, useState } from 'react';
import { GUIDE_DEFS, guideStorageKey, type GuideDef } from '../config/guides';
import type { GameState } from '../game/state';

/** After any dismissal, wait this long before the next page may appear — never
 *  chain-fire guidance at an overwhelmed newcomer. */
const COOLDOWN_MS = 20_000;

function isSeen(def: GuideDef): boolean {
  try {
    return !!localStorage.getItem(guideStorageKey(def));
  } catch {
    return true; // storage unavailable → don't nag
  }
}

function markSeen(def: GuideDef): void {
  try {
    localStorage.setItem(guideStorageKey(def), '1');
  } catch {
    /* ignore */
  }
}

/**
 * The Almanac reader: on a ~1/sec heartbeat, picks the first unseen page whose
 * predicate is true and shows it — one at a time, with a cool-off after each
 * dismissal. `blocked` covers every higher-priority overlay (away modal, a
 * DING/loot/dex banner, an in-flight predator dive, any open panel); the
 * reader never opens a new page while any of those are up.
 */
export function useAlmanac(state: GameState, blocked: boolean): { active: GuideDef | null; dismiss: () => void } {
  const [active, setActive] = useState<GuideDef | null>(null);
  const [tick, setTick] = useState(0);
  const lastDismissRef = useRef(0);

  // A dedicated ~1/sec heartbeat, independent of the parent's faster render
  // cadence (the engine notifies at ~15Hz) — predicate evaluation stays cheap
  // and the cool-off is measured in real seconds, not renders.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (blocked || active) return;
    if (Date.now() - lastDismissRef.current < COOLDOWN_MS) return;
    for (const def of GUIDE_DEFS) {
      if (isSeen(def)) continue;
      let matches = false;
      try {
        matches = def.when(state);
      } catch {
        matches = false; // a predicate must never crash the reader
      }
      if (matches) {
        setActive(def);
        return;
      }
    }
    // Deliberately NOT depending on `state`: GameEngine mutates it in place
    // (same reference every tick), so a ref-based dep would never re-fire on
    // value changes. `tick` is the real clock; each run reads the CURRENT
    // `state`/`active`/`blocked` via this render's closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, blocked]);

  const dismiss = () => {
    if (!active) return;
    markSeen(active);
    lastDismissRef.current = Date.now();
    setActive(null);
  };

  return { active, dismiss };
}
