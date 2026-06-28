import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { installMarginal, moduleContribution, salvageDust, spareOutlook } from '../game/loot';
import { MODULE_STATS, rackSockets, type GameState, type Module } from '../game/state';
import { playCollect, playPlace, playUpgrade } from '../audio/sfx';
import { CloseIcon, ModuleIcon } from './icons';
import { ModuleChip, STAT_META, rarityRank } from './lootUi';

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

  // Rack: group by stat for a stable read. Spares: best first.
  const rack = [...state.rack].sort(
    (a, b) =>
      MODULE_STATS.indexOf(a.stat) - MODULE_STATS.indexOf(b.stat) ||
      rarityRank[a.rarity] - rarityRank[b.rarity] ||
      b.magnitude - a.magnitude,
  );
  const spares = [...state.inventory].sort(
    (a, b) =>
      rarityRank[a.rarity] - rarityRank[b.rarity] ||
      b.magnitude - a.magnitude ||
      MODULE_STATS.indexOf(a.stat) - MODULE_STATS.indexOf(b.stat),
  );
  const emptySockets = Math.max(0, sockets - used);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-black text-[#ffe9a8]">
            <ModuleIcon size={18} /> Module Rack
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
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
          Spares ({spares.length})
        </div>
        {spares.length === 0 ? (
          <div className="py-4 text-center text-sm text-[#9a8a6a]">
            No spare modules. Tend stations for a chance to drop one.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {spares.map((m) => {
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
