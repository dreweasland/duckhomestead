import { useEffect, useRef } from 'react';
import type { DingEvent } from '../game/engine';
import { CartIcon } from './icons';

/** Tiny WebAudio "DING" — a two-note chime. Best-effort; silent on failure. */
export function playDing(milestone: boolean) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notes = milestone ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 987.77];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t = now + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.34);
    });
    window.setTimeout(() => ctx.close(), 1500);
  } catch {
    /* audio not available — fine */
  }
}

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
