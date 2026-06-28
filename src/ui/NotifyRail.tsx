import type { ReactNode } from 'react';

/**
 * Positions transient banners over the side-panel column, clear of the board on
 * the left. Mirrors the main two-column layout: a board-width spacer, then the
 * banner centered in the side-panel slot. On mobile it just centers. `top` is a
 * Tailwind vertical-anchor class — the DING sits up top (it IS the rank moment),
 * while loot/dex anchor to the BOTTOM so they never cover the rank/XP bar.
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
