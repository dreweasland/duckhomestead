import type { ReactNode } from 'react';

/**
 * Positions transient banners (DING / loot / dex) over the side-panel column
 * (the rank-bar area), clear of the board on the left. Mirrors the main
 * two-column layout: a board-width spacer, then the banner centered in the
 * side-panel slot. On mobile it just centers.
 */
export function NotifyRail({ top, children }: { top: string; children: ReactNode }) {
  return (
    <div className={`pointer-events-none fixed inset-x-0 ${top} z-50`}>
      <div className="mx-auto flex max-w-4xl px-4">
        {/* board + column-gap spacer (two-column layout only) */}
        <div className="hidden shrink-0 md:block" style={{ width: 512 }} />
        <div className="flex flex-1 justify-center">{children}</div>
      </div>
    </div>
  );
}
