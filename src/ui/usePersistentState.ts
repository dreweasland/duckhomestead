import { useCallback, useState } from 'react';

/**
 * useState that survives the component unmounting — for panel UI preferences
 * (tabs, filters, sorts) that should read the same way every time the panel
 * opens, and across reloads. Backed by localStorage under the game's key
 * prefix, so "New homestead (reset save)" wipes these too (a fresh start
 * resets the workbench), while the mute preference stays device-level.
 *
 * `validate` guards the read: storage can hold stale shapes (an old enum
 * value, a hand-edit) — anything it rejects falls back to `initial`. Pure UI
 * preference only — NEVER game state (that's the save's job).
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate: (v: unknown) => boolean,
): [T, (v: T | ((prev: T) => T)) => void] {
  const storageKey = `duck-homestead-ui-${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw) as unknown;
      return validate(parsed) ? (parsed as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (prev: T) => T)(prev) : v;
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* storage unavailable — the preference just won't stick */
        }
        return next;
      });
    },
    [storageKey],
  );
  return [value, set];
}
