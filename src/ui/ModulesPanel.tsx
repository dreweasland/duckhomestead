import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { salvageDust } from '../game/loot';
import type { GameState } from '../game/state';
import { playCollect, playUpgrade } from '../audio/sfx';
import { CloseIcon } from './icons';
import { ModuleChip, rarityRank } from './lootUi';

export function ModulesPanel({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
}) {
  const inventory = [...state.inventory].sort((a, b) => rarityRank[a.rarity] - rarityRank[b.rarity]);
  const rerollCost = BALANCE.LOOT.REROLL_DUST_COST;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Modules</h2>
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
          Modules drop from tending and rank milestones. Slot them on stations (select a station to
          see its slots). Salvage spares for dust; spend dust to reroll a module's magnitude.
        </p>

        {inventory.length === 0 ? (
          <div className="py-6 text-center text-sm text-[#9a8a6a]">
            No spare modules. Tend stations for a chance to drop one.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {inventory.map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <div className="flex-1">
                  <ModuleChip module={m} />
                </div>
                <button
                  onClick={() => {
                    if (engine.rerollModule(m.id).ok) playUpgrade();
                  }}
                  disabled={state.dust < rerollCost}
                  className={`rounded px-2 py-1 text-[10px] font-bold ${
                    state.dust >= rerollCost
                      ? 'bg-[#3a2e64] text-[#cdbcff] hover:bg-[#473a78]'
                      : 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
                  }`}
                  title={`Reroll magnitude · ${rerollCost} dust`}
                >
                  Reroll
                </button>
                <button
                  onClick={() => {
                    if (engine.salvageModule(m.id).ok) playCollect();
                  }}
                  className="rounded bg-[#3a2418] px-2 py-1 text-[10px] font-bold text-[#e8a35a] hover:bg-[#4a3020]"
                  title={`Salvage for ${salvageDust(m.rarity)} dust`}
                >
                  Salvage +{salvageDust(m.rarity)}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
