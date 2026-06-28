import { useEffect, useRef } from 'react';
import type { LootEvent } from '../game/engine';
import { RARITIES } from '../game/state';
import { fmtMagnitude, RARITY_COLOR, STAT_META } from './lootUi';
import { NotifyRail } from './NotifyRail';

interface Props {
  loot: LootEvent | null;
  onDone: () => void;
}

/** The loot moment: a rarity-flaired drop notification (a bigger beat for Epics+). */
export function LootBanner({ loot, onDone }: Props) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!loot) return;
    const tier = RARITIES.indexOf(loot.module.rarity);
    const ms = 2200 + tier * 600; // legendary lingers
    const t = window.setTimeout(() => doneRef.current(), ms);
    return () => clearTimeout(t);
  }, [loot]);

  if (!loot) return null;
  const { module, source } = loot;
  const color = RARITY_COLOR[module.rarity];
  const meta = STAT_META[module.stat];
  const tier = RARITIES.indexOf(module.rarity);
  const big = tier >= 3; // epic / legendary

  return (
    <NotifyRail top="bottom-6">
        <button
          type="button"
          onClick={onDone}
          className="ding-pop pointer-events-auto cursor-pointer rounded-xl px-5 py-3 text-center shadow-2xl"
          style={{
            background: `linear-gradient(160deg, ${color}, #1f1812 80%)`,
            boxShadow: `0 0 ${big ? 28 : 12}px ${color}${big ? 'cc' : '77'}`,
            border: `2px solid ${color}`,
          }}
        >
          <div className="text-[10px] font-bold uppercase tracking-widest text-white/80">
            {source === 'milestone' ? 'Milestone reward' : 'Loot drop'}
          </div>
          <div
            className="text-lg font-black uppercase tracking-wide drop-shadow"
            style={{ color: big ? '#fff' : color }}
          >
            {module.rarity}
          </div>
          <div className="text-sm font-bold text-white">
            {meta.label} {fmtMagnitude(module)}
          </div>
          <div className="text-[10px] text-white/70">{meta.blurb}</div>
        </button>
    </NotifyRail>
  );
}
