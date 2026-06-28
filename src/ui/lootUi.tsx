import type { Module, ModuleStat, Rarity } from '../game/state';
import { CloseIcon } from './icons';

export const RARITY_COLOR: Record<Rarity, string> = {
  common: '#9aa0a8',
  uncommon: '#6fbf73',
  rare: '#5b9bd5',
  epic: '#a06cd5',
  legendary: '#e8a33d',
};

interface StatMeta {
  label: string;
  /** +1 = a bonus (shows +X%), -1 = a reduction (shows −X%). */
  dir: 1 | -1;
  blurb: string;
  /** What an installed module of this stat affects, homestead-wide (rack model). */
  scope: string;
}
export const STAT_META: Record<ModuleStat, StatMeta> = {
  stationSpeed: { label: 'Speed', dir: -1, blurb: 'faster cycles', scope: 'all producers' },
  stationYield: { label: 'Yield', dir: 1, blurb: 'more per cycle', scope: 'all producers' },
  eggOutput: { label: 'Egg Output', dir: 1, blurb: 'more eggs laid', scope: 'the flock' },
  conditionRegen: { label: 'Condition Regen', dir: 1, blurb: 'faster flock recovery', scope: 'the flock' },
  tendPower: { label: 'Tend Power', dir: 1, blurb: 'bigger tend burst', scope: 'tending' },
  tendCooldown: { label: 'Tend Cooldown', dir: -1, blurb: 'shorter tend cooldown', scope: 'tending' },
};

/** "+18%" or "−18%" for the rolled magnitude. */
export function fmtMagnitude(m: Module): string {
  const pct = Math.round(m.magnitude * 100);
  return `${STAT_META[m.stat].dir < 0 ? '−' : '+'}${pct}%`;
}

export function ModuleChip({
  module,
  onRemove,
  compact,
}: {
  module: Module;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const color = RARITY_COLOR[module.rarity];
  const meta = STAT_META[module.stat];
  return (
    <div
      className="flex items-center gap-2 rounded-md bg-[#1f1812] px-2 py-1"
      style={{ border: `1px solid ${color}`, boxShadow: `inset 0 0 0 1px ${color}22` }}
      title={`${module.rarity} · ${meta.blurb}`}
    >
      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[11px] font-bold" style={{ color }}>
          {meta.label} {fmtMagnitude(module)}
        </div>
        {!compact && <div className="text-[9px] capitalize text-[#7a6a4a]">{module.rarity}</div>}
      </div>
      {onRemove && (
        <button
          onClick={onRemove}
          className="ml-auto rounded p-0.5 text-[#7a6a4a] hover:bg-[#2a2018] hover:text-[#f5ecd8]"
          aria-label="Unslot"
          title="Unslot"
        >
          <CloseIcon size={9} />
        </button>
      )}
    </div>
  );
}

export const rarityRank: Record<Rarity, number> = {
  legendary: 0,
  epic: 1,
  rare: 2,
  uncommon: 3,
  common: 4,
};
