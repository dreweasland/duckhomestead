import { useEffect, useRef } from 'react';
import type { DingEvent } from '../game/engine';
import { CartIcon } from './icons';

interface Props {
  ding: DingEvent | null;
  onDone: () => void;
}

export function DingBanner({ ding, onDone }: Props) {
  // Keep the latest onDone in a ref so the auto-dismiss timer is set ONCE per
  // ding. (App re-renders ~15Hz from the sim; depending on onDone directly
  // would reset the timer every frame and it would never fire.)
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!ding) return;
    const ms = ding.milestones.length > 0 ? 5200 : 2600;
    const t = window.setTimeout(() => doneRef.current(), ms);
    return () => clearTimeout(t);
  }, [ding]);

  if (!ding) return null;
  const milestone = ding.milestones[0];

  return (
    <div className="pointer-events-none fixed inset-x-0 top-10 z-50 flex justify-center">
      <button
        type="button"
        onClick={onDone}
        className={`ding-pop pointer-events-auto cursor-pointer rounded-xl px-6 py-4 text-center shadow-2xl ${
          milestone
            ? 'bg-gradient-to-br from-[#6b4f9e] to-[#3a2e64] ring-2 ring-[#cdbcff]'
            : 'bg-gradient-to-br from-[#e2b94f] to-[#b87333] ring-2 ring-[#fff4d6]'
        }`}
      >
        <div className="text-3xl font-black tracking-widest text-white drop-shadow">DING!</div>
        <div className="text-sm font-bold text-white/90">
          Homestead Rank {ding.newRank}
          {ding.levelsGained > 1 ? ` (+${ding.levelsGained})` : ''}
        </div>
        {milestone && (
          <div className="mt-2 border-t border-white/30 pt-2">
            <div className="flex items-center justify-center gap-2 text-base font-black text-white">
              <CartIcon size={20} /> {milestone.title} unlocked!
            </div>
            <div className="mt-0.5 max-w-xs text-xs text-white/90">{milestone.description}</div>
          </div>
        )}
        <div className="mt-2 text-[10px] uppercase tracking-wider text-white/60">tap to dismiss</div>
      </button>
    </div>
  );
}
