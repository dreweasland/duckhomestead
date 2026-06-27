import { useEffect, useRef } from 'react';
import type { DexEvent } from '../game/engine';
import { COLOR_META } from './FlockPanel';
import { NotifyRail } from './NotifyRail';

interface Props {
  dex: DexEvent | null;
  onDone: () => void;
}

/** The collection DING: a never-before-bred color first hatched. */
export function DexBanner({ dex, onDone }: Props) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (!dex) return;
    const t = window.setTimeout(() => doneRef.current(), 4200);
    return () => clearTimeout(t);
  }, [dex]);

  if (!dex) return null;
  const meta = COLOR_META[dex.color];

  return (
    <NotifyRail top="top-44">
      <button
        type="button"
        onClick={onDone}
        className="ding-pop pointer-events-auto cursor-pointer rounded-xl px-5 py-3 text-center shadow-2xl ring-2"
        style={{ background: `linear-gradient(160deg, ${meta.swatch}, #1f1812 85%)`, borderColor: meta.swatch }}
      >
        <div className="text-[10px] font-bold uppercase tracking-widest text-white/80">New breed bred!</div>
        <div className="text-2xl font-black uppercase tracking-wider text-white drop-shadow">
          {meta.label}
        </div>
        <div className="text-[10px] text-white/70">added to the dex</div>
      </button>
    </NotifyRail>
  );
}
