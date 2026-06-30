import { useState } from 'react';
import { BALANCE, PLAYSTYLE_PRESETS } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { installMarginal, moduleContribution, salvageDust, spareOutlook } from '../game/loot';
import {
  MODULE_STATS,
  RARITIES,
  rackSockets,
  type GameState,
  type Module,
  type ModuleStat,
  type Rarity,
} from '../game/state';
import { playCollect, playPlace, playUpgrade } from '../audio/sfx';
import { CloseIcon, HelpIcon, ModuleIcon } from './icons';
import { ModuleChip, RARITY_COLOR, STAT_HELP, STAT_META, rarityRank } from './lootUi';

/** Signed applied-% string for a stat (− for reductions like Speed/Cooldown). */
function effPct(stat: Module['stat'], applied: number): string {
  return `${STAT_META[stat].dir < 0 ? '−' : '+'}${Math.round(applied * 100)}%`;
}

export function ModulesPanel({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
}) {
  const sockets = rackSockets(state);
  const used = state.rack.length;
  const rerollCost = BALANCE.LOOT.REROLL_DUST_COST;
  const [tuneOpen, setTuneOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [tierFilter, setTierFilter] = useState<Rarity | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<ModuleStat | 'all'>('all');

  // Rack: group by stat for a stable read. Spares: tier → type → % (best tier,
  // grouped by stat, strongest roll first) so the list reads top-down by value.
  const rack = [...state.rack].sort(
    (a, b) =>
      MODULE_STATS.indexOf(a.stat) - MODULE_STATS.indexOf(b.stat) ||
      rarityRank[a.rarity] - rarityRank[b.rarity] ||
      b.magnitude - a.magnitude,
  );
  const spares = [...state.inventory].sort(
    (a, b) =>
      rarityRank[a.rarity] - rarityRank[b.rarity] ||
      MODULE_STATS.indexOf(a.stat) - MODULE_STATS.indexOf(b.stat) ||
      b.magnitude - a.magnitude,
  );
  const emptySockets = Math.max(0, sockets - used);

  // Spare counts per tier (drive the bulk-salvage chips). Best tier first.
  const spareTiers = [...RARITIES]
    .reverse()
    .map((r) => ({
      rarity: r,
      count: state.inventory.filter((m) => m.rarity === r).length,
      dust: state.inventory.filter((m) => m.rarity === r).reduce((a, m) => a + salvageDust(m.rarity), 0),
    }))
    .filter((t) => t.count > 0);

  const activePreset = state.statWeightPreset;

  // Spare filters: by tier (rarity) and by type (stat). Each row's per-option
  // counts are faceted by the OTHER active filter; only options actually present
  // among the spares are shown. The list then applies both.
  const matchTier = (m: Module) => tierFilter === 'all' || m.rarity === tierFilter;
  const matchType = (m: Module) => typeFilter === 'all' || m.stat === typeFilter;
  const visibleSpares = spares.filter((m) => matchTier(m) && matchType(m));

  const presentTiers = [...RARITIES].reverse().filter((r) => spares.some((m) => m.rarity === r));
  const presentTypes = MODULE_STATS.filter((s) => spares.some((m) => m.stat === s));
  const tierOptions = [
    { value: 'all' as const, label: 'All', count: spares.filter(matchType).length },
    ...presentTiers.map((r) => ({
      value: r,
      label: r[0].toUpperCase() + r.slice(1),
      count: spares.filter((m) => m.rarity === r && matchType(m)).length,
    })),
  ];
  const typeOptions = [
    { value: 'all' as const, label: 'All', count: spares.filter(matchTier).length },
    ...presentTypes.map((s) => ({
      value: s,
      label: STAT_META[s].label,
      count: spares.filter((m) => m.stat === s && matchTier(m)).length,
    })),
  ];

  if (helpOpen) {
    return <ModuleHelp onClose={() => setHelpOpen(false)} />;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-black text-[#ffe9a8]">
            <ModuleIcon size={18} /> Module Rack
            <button
              onClick={() => setHelpOpen(true)}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-[#1f1812] text-[#9a8a6a] ring-1 ring-[#3a2e22] hover:text-[#cdbcff]"
              aria-label="What do modules do?"
              title="What do modules do?"
            >
              <HelpIcon size={11} />
            </button>
          </h2>
          <div className="flex items-center gap-3">
            <span className="rounded bg-[#1f1812] px-2 py-1 text-xs font-bold text-[#cdbcff]">
              {state.dust} dust
            </span>
            <button
              onClick={onClose}
              className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]"
              aria-label="Close"
            >
              <CloseIcon size={14} />
            </button>
          </div>
        </div>

        <p className="mb-3 text-[10px] text-[#7a6a4a]">
          Installed modules apply across the whole homestead — no per-tile fiddling. Sockets are
          scarce ({used}/{sockets} used; more unlock with rank), so run your best. Auto-fill installs
          and upgrades for you; tend drops that can’t improve your rack auto-salvage to dust, so
          spares stay clutter-free.
        </p>

        {/* ── The rack ── */}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
            Installed — {used}/{sockets} sockets
          </span>
          <button
            onClick={() => {
              const r = engine.autoFillRack();
              if (r.ok && (r.value.installed > 0 || r.value.swapped > 0)) playUpgrade();
            }}
            disabled={state.inventory.length === 0}
            className={`rounded px-2 py-1 text-[10px] font-bold transition ${
              state.inventory.length > 0
                ? 'bg-[#3a2e64] text-[#cdbcff] hover:bg-[#473a78]'
                : 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
            }`}
            title="Fill empty sockets with your best spares, then make any upgrading swaps"
          >
            Auto-fill
          </button>
        </div>

        {/* ── Auto-fill priorities: pick a playstyle preset or hand-tune weights ── */}
        <div className="mb-3 rounded-md bg-[#1f1812] p-2">
          <button
            onClick={() => setTuneOpen((v) => !v)}
            className="flex w-full items-center justify-between text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a] hover:text-[#cdbcff]"
          >
            <span>Auto-fill priorities</span>
            <span className="flex items-center gap-1 normal-case tracking-normal text-[#cdbcff]">
              {PLAYSTYLE_PRESETS.find((p) => p.id === activePreset)?.label ?? 'Custom'}
              <span className="text-[#6a5a3a]">{tuneOpen ? '▾' : '▸'}</span>
            </span>
          </button>

          {tuneOpen && (
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex flex-wrap gap-1">
                {PLAYSTYLE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => engine.setPlaystyle(p.id)}
                    title={p.desc}
                    className={`rounded px-2 py-1 text-[10px] font-bold transition ${
                      activePreset === p.id
                        ? 'bg-[#3a2e64] text-[#cdbcff] ring-1 ring-[#cdbcff]'
                        : 'bg-[#241c14] text-[#9a8a6a] hover:bg-[#2e2440]'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <span
                  className={`rounded px-2 py-1 text-[10px] font-bold ${
                    activePreset === 'custom'
                      ? 'bg-[#3a2e64] text-[#cdbcff] ring-1 ring-[#cdbcff]'
                      : 'bg-[#241c14] text-[#5a4d3a]'
                  }`}
                >
                  Custom
                </span>
              </div>
              <p className="text-[9px] leading-relaxed text-[#7a6a4a]">
                {PLAYSTYLE_PRESETS.find((p) => p.id === activePreset)?.desc ??
                  'Hand-tuned weights. Higher = Auto-fill prefers this stat when sockets are scarce.'}
              </p>
              <div className="flex flex-col gap-1">
                {MODULE_STATS.map((stat) => {
                  const w = state.statWeights[stat] ?? 0;
                  return (
                    <div key={stat} className="flex items-center gap-2">
                      <span className="flex-1 text-[10px] text-[#c9b88f]">{STAT_META[stat].label}</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => engine.setStatWeight(stat, Math.max(0, +(w - 0.1).toFixed(1)))}
                          className="h-5 w-5 rounded bg-[#241c14] text-[11px] font-bold text-[#cdbcff] hover:bg-[#2e2440]"
                          aria-label={`Lower ${STAT_META[stat].label} priority`}
                        >
                          −
                        </button>
                        <span className="w-7 text-center text-[11px] font-bold tabular-nums text-[#f5ecd8]">
                          {w.toFixed(1)}
                        </span>
                        <button
                          onClick={() => engine.setStatWeight(stat, +(w + 0.1).toFixed(1))}
                          className="h-5 w-5 rounded bg-[#241c14] text-[11px] font-bold text-[#cdbcff] hover:bg-[#2e2440]"
                          aria-label={`Raise ${STAT_META[stat].label} priority`}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="mb-4 flex flex-col gap-1.5">
          {rack.map((m) => (
            <div key={m.id} className="flex flex-col gap-0.5">
              <ModuleChip module={m} onRemove={() => engine.uninstallModule(m.id)} compact />
              <div className="pl-1 text-[9px] text-[#7a6a4a]">
                affects {STAT_META[m.stat].scope} · adding{' '}
                <span className="text-[#9fd0a0]">{effPct(m.stat, moduleContribution(state, m))}</span>{' '}
                now
              </div>
            </div>
          ))}
          {Array.from({ length: emptySockets }).map((_, i) => (
            <div
              key={`empty-${i}`}
              className="rounded-md border border-dashed border-[#4a3a2a] px-2 py-1.5 text-center text-[10px] text-[#6a5a3a]"
            >
              empty socket
            </div>
          ))}
          {sockets === 0 && (
            <div className="text-[10px] text-[#7a6a4a]">No sockets yet — rank up to earn them.</div>
          )}
        </div>

        {/* ── Spares ── */}
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
            Spares ({visibleSpares.length === spares.length ? spares.length : `${visibleSpares.length}/${spares.length}`})
          </span>
        </div>

        {/* Filter spares by tier + type (counts faceted by the other filter). Each
            row only appears when there's more than one option to choose from. */}
        {(presentTiers.length > 1 || presentTypes.length > 1) && (
          <div className="mb-2 flex flex-col gap-1">
            {presentTiers.length > 1 && (
              <FilterPills options={tierOptions} value={tierFilter} onChange={setTierFilter} />
            )}
            {presentTypes.length > 1 && (
              <FilterPills options={typeOptions} value={typeFilter} onChange={setTypeFilter} />
            )}
          </div>
        )}

        {/* Bulk salvage by tier — one tap clears every spare of that rarity. */}
        {spareTiers.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <span className="mr-0.5 text-[9px] uppercase tracking-wider text-[#7a6a4a]">
              Bulk salvage
            </span>
            {spareTiers.map(({ rarity, count, dust }) => (
              <button
                key={rarity}
                onClick={() => {
                  if (engine.bulkSalvageByTier(rarity).ok) playCollect();
                }}
                title={`Salvage all ${count} ${rarity} spare${count > 1 ? 's' : ''} for ${dust} dust`}
                className="rounded px-1.5 py-0.5 text-[10px] font-bold capitalize transition hover:brightness-110"
                style={{ background: `${RARITY_COLOR[rarity]}22`, color: RARITY_COLOR[rarity], border: `1px solid ${RARITY_COLOR[rarity]}66` }}
              >
                {rarity} ×{count} <span className="opacity-70">+{dust}</span>
              </button>
            ))}
          </div>
        )}
        {spares.length === 0 ? (
          <div className="py-4 text-center text-sm text-[#9a8a6a]">
            No spare modules. Tend stations for a chance to drop one.
          </div>
        ) : visibleSpares.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center text-xs text-[#9a8a6a]">
            No spares match this filter.
            <button
              onClick={() => {
                setTierFilter('all');
                setTypeFilter('all');
              }}
              className="rounded bg-[#3a2e22] px-2 py-1 text-[10px] font-bold text-[#f5ecd8] hover:bg-[#4a3a2a]"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleSpares.map((m) => {
              const outlook = spareOutlook(state, m);
              const installable = outlook.kind === 'install';
              const upgrade = outlook.kind === 'upgrade';
              const potential = outlook.kind === 'potential';
              return (
                <div key={m.id} className="flex flex-col gap-1 rounded-md bg-[#1f1812] p-2">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <ModuleChip module={m} compact />
                    </div>
                    <button
                      onClick={() => {
                        const r = installable ? engine.installModule(m.id) : engine.swapInModule(m.id);
                        if (r.ok) playPlace();
                      }}
                      disabled={!installable && !upgrade}
                      className={`rounded px-2 py-1 text-[10px] font-bold transition ${
                        installable
                          ? 'bg-[#2e6b3a] text-[#dfffd6] hover:bg-[#367a44]'
                          : upgrade
                            ? 'bg-[#5a4320] text-[#ffe9a8] hover:bg-[#6a4f28]'
                            : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                      }`}
                      title={
                        installable
                          ? 'Install into a free socket'
                          : upgrade
                            ? `Swap in for ${STAT_META[outlook.replace.stat].label} ${effPct(
                                outlook.replace.stat,
                                moduleContribution(state, outlook.replace),
                              )}`
                            : 'Rack full — not an upgrade'
                      }
                    >
                      {installable ? 'Install' : upgrade ? 'Swap ↑' : 'Full'}
                    </button>
                  </div>
                  <div className="flex items-center justify-between pl-1">
                    <span className="text-[9px] text-[#7a6a4a]">
                      {installable ? (
                        <>
                          → <span className="text-[#9fd0a0]">{effPct(m.stat, installMarginal(state, m))}</span>{' '}
                          to {STAT_META[m.stat].scope}
                        </>
                      ) : upgrade ? (
                        <span className="text-[#e8c45a]">↑ upgrade for {STAT_META[m.stat].scope}</span>
                      ) : potential ? (
                        <span className="text-[#b9a3e8]">↻ reroll could make it an upgrade</span>
                      ) : (
                        <span className="text-[#5a4d3a]">dominated · safe to salvage</span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <button
                        onClick={() => {
                          if (engine.rerollModule(m.id).ok) playUpgrade();
                        }}
                        disabled={state.dust < rerollCost}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          state.dust >= rerollCost
                            ? 'bg-[#3a2e64] text-[#cdbcff] hover:bg-[#473a78]'
                            : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                        }`}
                        title={`Reroll magnitude · ${rerollCost} dust`}
                      >
                        Reroll
                      </button>
                      <button
                        onClick={() => {
                          if (engine.salvageModule(m.id).ok) playCollect();
                        }}
                        className="rounded bg-[#3a2418] px-1.5 py-0.5 text-[10px] font-bold text-[#e8a35a] hover:bg-[#4a3020]"
                        title={`Salvage for ${salvageDust(m.rarity)} dust`}
                      >
                        Salvage +{salvageDust(m.rarity)}
                      </button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** A wrapping row of segmented filter pills with faceted counts (content-sized so
 *  the longer module-type labels wrap cleanly instead of cramming one row). */
function FilterPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold transition ${
              active
                ? 'bg-[#3a2e22] text-[#f5ecd8] ring-1 ring-[#5a4a32]'
                : 'bg-[#1f1812] text-[#9a8a6a] hover:bg-[#33271c]'
            }`}
          >
            {o.label}
            <span className="tabular-nums text-[#7a6a4a]">{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The "what modules do" help overlay — a plain-words breakdown of each stat,
 *  reachable from the (?) by the panel title. */
function ModuleHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-black text-[#ffe9a8]">
            <HelpIcon size={16} /> What modules do
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]"
            aria-label="Close"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <p className="mb-3 text-[11px] leading-relaxed text-[#c9b88f]">
          Modules install into one homestead-wide <span className="text-[#cdbcff]">rack</span> — each
          applies to its whole category (all producers, the flock, or tending), no per-tile fiddling.
          Stacking the same stat has <span className="text-[#ffe9a8]">diminishing returns</span> (a
          soft cap), which is why Auto-fill spreads across stats instead of piling onto one.
        </p>

        <div className="flex flex-col gap-2">
          {MODULE_STATS.map((stat) => {
            const meta = STAT_META[stat];
            return (
              <div key={stat} className="rounded-md bg-[#1f1812] p-2.5">
                <div className="mb-0.5 flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-bold text-[#f5ecd8]">{meta.label}</span>
                  <span className="text-[9px] uppercase tracking-wider text-[#7a6a4a]">
                    {meta.dir < 0 ? 'lower is the bonus' : 'higher is the bonus'} · {meta.scope}
                  </span>
                </div>
                <p className="text-[10px] leading-relaxed text-[#c9b88f]">{STAT_HELP[stat]}</p>
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-[10px] leading-relaxed text-[#7a6a4a]">
          Tend stats (Tend Power / Tend Cooldown) only pay off while you’re actively tending — the
          <span className="text-[#cdbcff]"> Idle / AFK</span> playstyle preset zeroes them for that
          reason. Set your playstyle under “Auto-fill priorities”.
        </p>
      </div>
    </div>
  );
}
