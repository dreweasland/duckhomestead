import type { ReactNode } from 'react';

/**
 * The single transient-notification stack. Rendered ONCE (in App), it holds every
 * fleeting banner — DING, loot, dex, auto-salvage — so they queue vertically with
 * a gap instead of pinning themselves independently and overlapping.
 *
 * Centered: the app's content column is `mx-auto`, so screen-center === app-center.
 * A full-width fixed bar with center-aligned children therefore drops each toast
 * dead-center over the homestead (not crammed into the side-panel slot). Children
 * that render `null` (an inactive banner) simply contribute nothing — `gap` only
 * spaces the live ones. `pointer-events-none` on the bar lets board clicks through;
 * each banner re-enables pointer events on its own button.
 *
 * `lowered` drops the stack below the pinned predator telegraph (which owns the
 * very top of the screen during a window) so toasts clear it instead of landing
 * on top of it.
 */
export function NotifyRail({ children, lowered = false }: { children: ReactNode; lowered?: boolean }) {
  return (
    <div className={`pointer-events-none fixed inset-x-0 z-50 px-4 ${lowered ? 'top-14' : 'top-3'}`}>
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-2">{children}</div>
    </div>
  );
}
