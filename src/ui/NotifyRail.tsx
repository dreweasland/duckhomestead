import type { ReactNode } from 'react';

/**
 * Positions transient banners over the side-panel column, clear of the board on
 * the left. Mirrors the main two-column layout: a board-width spacer, then the
 * banner centered in the side-panel slot. On mobile it just centers. `top` is a
 * Tailwind vertical-anchor class — banners sit at the very top of the column so
 * they only ever briefly cover the title + currency chips, never the rank/XP bar
 * (which lives lower in the HUD).
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
