import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { AXES, INGREDIENTS, type Axis, type GameState, type Ingredient } from '../game/state';
import { fmt } from './format';
import { CloseIcon, RESOURCE_ICON } from './icons';

const N = BALANCE.NUTRITION;
const AXIS_LABEL: Record<Axis, string> = {
  energy: 'Energy',
  protein: 'Protein',
  niacin: 'Niacin',
  calcium: 'Calcium',
};
const ING_LABEL: Record<Ingredient, string> = {
  corn: 'Corn',
  peas: 'Peas',
  mealworms: 'Mealworms',
  brewersYeast: "Brewer's Yeast",
  oysterShell: 'Oyster Shell',
};
const RATION_MAX = 6;

function barColor(sat: number): string {
  if (sat >= 1) return '#8fe388';
  if (sat >= N.NIACIN_DEBUFF_THRESHOLD) return '#e8c45a';
  return '#e8835a';
}

/** Whether nutrition needs the player's attention (drives the HUD button tint). */
export function nutritionNeedsAttention(state: GameState): boolean {
  const n = state.nutrition;
  if (!n) return false;
  const low = AXES.some((a) => n.satisfaction[a] < 1);
  const debuffed = state.stations.some((s) => s.debuffed);
  return low || debuffed || state.condition < N.CONDITION_MAX * 0.5 || n.feedScale < 1;
}

export function NutritionPanel({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
}) {
  const n = state.nutrition;
  const coops = state.stations.filter((s) => s.type === 'coop');
  const debuffed = coops.filter((s) => s.debuffed).length;
  const condPct = Math.round((state.condition / N.CONDITION_MAX) * 100);
  const eggPct = Math.round((n?.eggMult ?? 1) * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Feed Formulation</h2>
          <button
            onClick={onClose}
            className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]"
            aria-label="Close"
          >
            <CloseIcon size={14} />
          </button>
        </div>

        {coops.length === 0 ? (
          <div className="py-6 text-center text-sm text-[#9a8a6a]">
            Build a Coop to start a flock — then balance its ration here.
          </div>
        ) : (
          <>
            {/* Output + condition summary */}
            <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md bg-[#1f1812] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">Egg output</div>
                <div className="text-lg font-bold" style={{ color: barColor(n?.eggMult ?? 1) }}>
                  {eggPct}%
                </div>
              </div>
              <div className="rounded-md bg-[#1f1812] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">Flock condition</div>
                <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-[#0f0b07]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#e8835a] via-[#e8c45a] to-[#8fe388]"
                    style={{ width: `${condPct}%` }}
                  />
                </div>
                <div className="mt-0.5 text-[10px] text-[#9a8a6a]">{condPct}% reserve</div>
              </div>
            </div>

            {/* Per-axis satisfaction */}
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
              Nutrient balance ({coops.length} coop{coops.length > 1 ? 's' : ''})
            </div>
            <div className="mb-4 flex flex-col gap-1.5">
              {AXES.map((axis) => {
                const sat = n?.satisfaction[axis] ?? 0;
                const pct = Math.round(sat * 100);
                const col = barColor(sat);
                return (
                  <div key={axis} className="flex items-center gap-2 text-[11px]">
                    <span className="w-14 text-[#c9b88f]">{AXIS_LABEL[axis]}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[#1f1812]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.min(100, sat * 100)}%`, background: col }}
                      />
                    </div>
                    <span className="w-10 text-right font-bold tabular-nums" style={{ color: col }}>
                      {pct}%
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Warnings */}
            {n && n.feedScale < 1 && (
              <div className="mb-3 rounded-md bg-[#3a2418] px-3 py-1.5 text-[11px] text-[#e8a35a]">
                Under-milled — the mills can only blend {Math.round(n.feedScale * 100)}% of demand.
                Build another Feed Mill.
              </div>
            )}
            {debuffed > 0 && (
              <div className="mb-3 rounded-md bg-[#3a1f2a] px-3 py-1.5 text-[11px] text-[#e87a9a]">
                {debuffed} duck{debuffed > 1 ? 's' : ''} limping from niacin shortfall. Select the
                coop and Dose Brewer's Yeast.
              </div>
            )}

            {/* Ration sliders */}
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
              Ration — units per coop per cycle
            </div>
            <div className="flex flex-col gap-2.5">
              {INGREDIENTS.map((ing) => {
                const Icon = RESOURCE_ICON[ing];
                const val = state.ration[ing] ?? 0;
                const stock = state.resources[ing];
                const m = N.INGREDIENT[ing] as Record<Axis, number>;
                const contrib = AXES.filter((a) => (m[a] ?? 0) > 0)
                  .map((a) => `${AXIS_LABEL[a][0]}${m[a]}`)
                  .join(' ');
                const starved = val > 0 && stock < 1;
                return (
                  <div key={ing} className="flex items-center gap-2">
                    <Icon size={16} />
                    <div className="w-28">
                      <div className="text-[11px] font-bold">{ING_LABEL[ing]}</div>
                      <div className="text-[9px] text-[#7a6a4a]">
                        {contrib} · stock{' '}
                        <span className={starved ? 'text-[#e8835a]' : 'text-[#9a8a6a]'}>
                          {fmt(stock)}
                        </span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={RATION_MAX}
                      step={0.5}
                      value={val}
                      onChange={(e) => engine.setRation(ing, parseFloat(e.target.value))}
                      className="flex-1 accent-[#e2b94f]"
                    />
                    <span className="w-7 text-right text-[11px] font-bold tabular-nums text-[#ffe9a8]">
                      {val}
                    </span>
                  </div>
                );
              })}
            </div>

            <p className="mt-3 text-[10px] text-[#7a6a4a]">
              Satisfaction = stock available ÷ flock need. Keep every line producing faster than the
              flock eats and all bars stay green. Condition buffers brief shortfalls; sustained gaps
              throttle eggs (and starve niacin → limps).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
