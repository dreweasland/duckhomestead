import { millLoad, resourceFlow } from '../game/actions';
import type { GameState, Resource } from '../game/state';
import { fmt } from './format';
import { CloseIcon, RESOURCE_ICON } from './icons';

/**
 * The currency-flow breakdown — opened by clicking any resource chip in the HUD.
 * Shows EVERY tracked currency at once: what's produced (in), what the feed blend
 * + duckling ration consume (out), and the net per minute. A green net means the
 * stock is growing; red means it's draining and you need more producers (or a
 * lighter ration). Rates read off the live sim via resourceFlow().
 */

const ROWS: { key: Resource; label: string }[] = [
  { key: 'eggs', label: 'Eggs' },
  { key: 'corn', label: 'Corn' },
  { key: 'peas', label: 'Peas' },
  { key: 'mealworms', label: 'Mealworms' },
  { key: 'brewersYeast', label: "Brewer's Yeast" },
  { key: 'oysterShell', label: 'Oyster Shell' },
];

/** A per-minute rate as a short string ('—' for ~zero). */
function rate(perSec: number): string {
  const v = perSec * 60;
  if (Math.abs(v) < 0.05) return '—';
  const sign = v > 0 ? '+' : '−';
  const mag = Math.abs(v);
  return `${sign}${mag >= 1000 ? fmt(mag) : Math.round(mag * 10) / 10}`;
}

/** Mill load → bar fill, colour, and a "what to do" line. */
function millStatus(load: NonNullable<ReturnType<typeof millLoad>>): {
  color: string;
  pct: string;
  fill: number;
  hint: string;
} {
  if (!load.hasMill) {
    return { color: '#e8835a', pct: '—', fill: 1, hint: 'No feed mill — build one to blend the ration.' };
  }
  const r = load.ratio;
  const pct = Number.isFinite(r) ? `${Math.round(r * 100)}%` : '∞';
  const fill = Math.min(1, Number.isFinite(r) ? r : 1);
  if (r >= 1) {
    return {
      color: '#e8835a',
      pct,
      fill,
      hint: `Over capacity — feed throttled to ${Math.round(load.feedScale * 100)}%. Add or upgrade a mill.`,
    };
  }
  if (r >= 0.8) {
    return { color: '#e8c45a', pct, fill, hint: 'Approaching capacity — another mill or upgrade soon.' };
  }
  return { color: '#8fe388', pct, fill, hint: 'Headroom — the mills keep up with the flock.' };
}

export function ResourceFlowPanel({ state, onClose }: { state: GameState; onClose: () => void }) {
  const rows = state.resources.forage > 0 ? [...ROWS, { key: 'forage' as Resource, label: 'Forage' }] : ROWS;
  const load = millLoad(state);
  const mill = load ? millStatus(load) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Resource flow</h2>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]"
            aria-label="Close"
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <p className="mb-3 text-[10px] text-[#7a6a4a]">
          Per minute — what’s produced (in) vs what the feed blend + duckling ration eat (out). A red
          net is draining: add producers, more mill capacity, or lighten the ration.
        </p>

        {/* header */}
        <div className="mb-1 flex items-center gap-2 px-1 text-[9px] font-bold uppercase tracking-wider text-[#7a6a4a]">
          <span className="flex-1">Currency</span>
          <span className="w-14 text-right text-[#8fbf6a]">In</span>
          <span className="w-14 text-right text-[#e8a35a]">Out</span>
          <span className="w-16 text-right">Net</span>
        </div>

        <div className="flex flex-col gap-1">
          {rows.map(({ key, label }) => {
            const Icon = RESOURCE_ICON[key];
            const { in: inflow, out: outflow } = resourceFlow(state, key);
            const net = inflow - outflow;
            const netColor = net > 1e-6 ? '#8fe388' : net < -1e-6 ? '#e8835a' : '#9a8a6a';
            return (
              <div key={key} className="flex items-center gap-2 rounded-md bg-[#1f1812] px-2 py-1.5">
                <span className="flex flex-1 items-center gap-1.5">
                  <Icon size={14} title={label} />
                  <span className="text-[11px] text-[#c9b88f]">{label}</span>
                </span>
                <span className="w-14 text-right text-[11px] tabular-nums text-[#8fbf6a]">
                  {rate(inflow)}
                </span>
                <span className="w-14 text-right text-[11px] tabular-nums text-[#e8a35a]">
                  {outflow > 1e-6 ? rate(-outflow) : '—'}
                </span>
                <span
                  className="w-16 text-right text-[11px] font-bold tabular-nums"
                  style={{ color: netColor }}
                >
                  {rate(net)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Feed mill capacity — the production ⇄ mill partnership. */}
        {load && mill && (
          <div className="mt-3 rounded-md bg-[#1f1812] p-2.5">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
                Feed mill capacity
              </span>
              <span className="text-xs font-bold tabular-nums" style={{ color: mill.color }}>
                {mill.pct} used
              </span>
            </div>
            <div className="mb-1 h-2 overflow-hidden rounded-full bg-[#3a2e22]">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${mill.fill * 100}%`, background: mill.color }}
              />
            </div>
            {load.hasMill && (
              <div className="mb-1 text-[10px] tabular-nums text-[#9a8a6a]">
                blending {load.demand.toFixed(1)} / {load.capacity.toFixed(1)} units/s
              </div>
            )}
            <div className="text-[10px] leading-relaxed" style={{ color: mill.color }}>
              {mill.hint}
            </div>
          </div>
        )}

        <p className="mt-3 text-[10px] leading-relaxed text-[#7a6a4a]">
          Eggs have no feed outflow — they’re your currency, spent on building &amp; upgrades as you
          choose. Rates are live and shift with ration, mill capacity, level, and modules.
        </p>
      </div>
    </div>
  );
}
