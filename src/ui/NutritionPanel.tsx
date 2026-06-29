import { useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { AXES, INGREDIENTS, type Axis, type GameState, type Ingredient } from '../game/state';
import {
  canBuildWaterFeatures,
  waterAccess,
  waterCapacity,
  waterConditionMult,
  waterStatus,
  waterWoundMult,
} from '../game/water';
import { playPlace } from '../audio/sfx';
import { fmt } from './format';
import { CloseIcon, ForageIcon, RESOURCE_ICON, WaterIcon } from './icons';

const N = BALANCE.NUTRITION;
const B = BALANCE.BREEDING;
const AXIS_LABEL: Record<Axis, string> = { energy: 'Energy', protein: 'Protein', niacin: 'Niacin', calcium: 'Calcium' };
const ING_LABEL: Record<Ingredient, string> = {
  corn: 'Corn',
  peas: 'Peas',
  mealworms: 'Mealworms',
  brewersYeast: "Brewer's Yeast",
  oysterShell: 'Oyster Shell',
};
const RATION_MAX = 6;
const DUCKLING_AXES: Axis[] = ['energy', 'protein', 'niacin'];

function barColor(sat: number): string {
  const pct = Math.round(sat * 100);
  if (pct >= 100) return '#8fe388';
  if (pct >= N.NIACIN_DEBUFF_THRESHOLD * 100) return '#e8c45a';
  return '#e8835a';
}

/** Whether layer nutrition needs the player's attention (HUD button tint). */
export function nutritionNeedsAttention(state: GameState): boolean {
  const debuffed = state.ducks.some((d) => d.debuffed);
  const ducklingsUnderfed = !!state.ducklingNutrition && state.ducklingNutrition.matureRate < 0.9;
  const n = state.nutrition;
  const layerLow = !!n && (AXES.some((a) => n.satisfaction[a] < 1) || n.feedScale < 1 || state.condition < N.CONDITION_MAX * 0.5);
  return debuffed || ducklingsUnderfed || layerLow;
}

function AxisBars({ satisfaction, axes }: { satisfaction: Record<Axis, number>; axes: Axis[] }) {
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      {axes.map((axis) => {
        const sat = satisfaction[axis] ?? 0;
        const col = barColor(sat);
        return (
          <div key={axis} className="flex items-center gap-2 text-[11px]">
            <span className="w-14 text-[#c9b88f]">{AXIS_LABEL[axis]}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[#1f1812]">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, sat * 100)}%`, background: col }} />
            </div>
            <span className="w-10 text-right font-bold tabular-nums" style={{ color: col }}>
              {Math.round(sat * 100)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RationSliders({
  state,
  ration,
  onSet,
}: {
  state: GameState;
  ration: Record<Ingredient, number>;
  onSet: (ing: Ingredient, v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {INGREDIENTS.map((ing) => {
        const Icon = RESOURCE_ICON[ing];
        const val = ration[ing] ?? 0;
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
                <span className={starved ? 'text-[#e8835a]' : 'text-[#9a8a6a]'}>{fmt(stock)}</span>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={RATION_MAX}
              step={0.5}
              value={val}
              onChange={(e) => onSet(ing, parseFloat(e.target.value))}
              className="flex-1 accent-[#e2b94f]"
            />
            <span className="w-7 text-right text-[11px] font-bold tabular-nums text-[#ffe9a8]">{val}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Water-access readout: structural capacity vs flock, its effects, and the
 *  build-feature lever — so the player SEES the flock outgrowing its water. */
function WaterCard({ engine, state }: { engine: GameEngine; state: GameState }) {
  const cap = waterCapacity(state);
  const flock = state.ducks.length;
  const access = waterAccess(state);
  const status = waterStatus(access);
  const condMult = waterConditionMult(state);
  const woundMult = waterWoundMult(state);
  const canBuild = canBuildWaterFeatures(state);
  const cost = BALANCE.WATER.FEATURE_COST_EGGS;
  const featCap = BALANCE.WATER.FEATURE_CAPACITY;
  const color = status === 'good' ? '#8fe388' : status === 'ok' ? '#e8c45a' : '#e8835a';
  const label =
    !Number.isFinite(access) || access >= 2
      ? 'abundant'
      : status === 'good'
        ? 'comfortable'
        : status === 'ok'
          ? 'getting tight'
          : 'thirsty — outgrowing the water';
  // Bar on a 0..2 access scale (50% = "enough"); a tick marks the neutral point.
  const fillPct = Number.isFinite(access) ? Math.min(100, access * 50) : 100;
  const multColor = (m: number) => (m >= 1 ? '#8fe388' : m >= 0.85 ? '#e8c45a' : '#e8835a');

  return (
    <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
          <WaterIcon size={13} /> Water access
        </div>
        <span className="text-xs font-bold tabular-nums" style={{ color }}>
          {cap} cap / {flock} {flock === 1 ? 'duck' : 'ducks'} · {label}
        </span>
      </div>
      <div className="relative mb-1.5 h-2 overflow-hidden rounded-full bg-[#0f0b07]">
        <div className="h-full rounded-full" style={{ width: `${fillPct}%`, background: color }} />
        {/* neutral (ratio 1.0) tick */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-[#5a4d3a]" />
      </div>
      <div className="text-[10px] text-[#9a8a6a]">
        Condition regen{' '}
        <span className="font-bold tabular-nums" style={{ color: multColor(condMult) }}>
          ×{condMult.toFixed(2)}
        </span>{' '}
        · wound recovery{' '}
        <span className="font-bold tabular-nums" style={{ color: multColor(woundMult) }}>
          ×{woundMult.toFixed(2)}
        </span>
      </div>
      {canBuild ? (
        <button
          onClick={() => {
            if (engine.buildWaterFeature().ok) playPlace();
          }}
          disabled={state.resources.eggs < cost}
          className={`mt-2 w-full rounded-md px-3 py-1.5 text-xs font-bold transition ${
            state.resources.eggs >= cost
              ? 'bg-[#26323a] text-[#a8d0e8] hover:bg-[#2e3c46]'
              : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
          }`}
        >
          Build water feature · {cost} eggs (+{featCap} cap)
        </button>
      ) : (
        status !== 'good' && (
          <div className="mt-1.5 text-[10px] text-[#7a6a4a]">
            Unlock The Pond for a big jump in water capacity.
          </div>
        )
      )}
    </div>
  );
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
  const [tab, setTab] = useState<'layers' | 'ducklings'>('layers');
  const n = state.nutrition;
  const coops = state.stations.filter((s) => s.type === 'coop');
  const debuffed = state.ducks.filter((d) => d.debuffed).length;
  const condPct = Math.round((state.condition / N.CONDITION_MAX) * 100);
  const eggPct = Math.round((n?.eggMult ?? 1) * 100);
  const dn = state.ducklingNutrition;
  const adults = state.ducks.filter((d) => d.stage === 'adult').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Feed Formulation</h2>
          <button onClick={onClose} className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]" aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="mb-3 flex gap-1 border-b border-[#3a2e22]">
          {(['layers', 'ducklings'] as const).map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-t-md px-3 py-1.5 text-xs font-bold capitalize ${
                tab === id ? 'bg-[#1f1812] text-[#ffe9a8]' : 'text-[#7a6a4a] hover:text-[#c9b88f]'
              }`}
            >
              {id}
            </button>
          ))}
        </div>

        {tab === 'layers' ? (
          coops.length === 0 || adults === 0 ? (
            <div className="py-6 text-center text-sm text-[#9a8a6a]">
              No adult layers yet — build a Coop to start a flock, then balance its ration here.
            </div>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-[#1f1812] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">Egg output</div>
                  <div className="text-lg font-bold" style={{ color: barColor(n?.eggMult ?? 1) }}>{eggPct}%</div>
                </div>
                <div className="rounded-md bg-[#1f1812] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">Flock condition</div>
                  <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-[#0f0b07]">
                    <div className="h-full rounded-full bg-gradient-to-r from-[#e8835a] via-[#e8c45a] to-[#8fe388]" style={{ width: `${condPct}%` }} />
                  </div>
                  <div className="mt-0.5 text-[10px] text-[#9a8a6a]">{condPct}% reserve</div>
                </div>
              </div>

              <WaterCard engine={engine} state={state} />

              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
                Nutrient balance ({adults} adult{adults > 1 ? 's' : ''})
              </div>
              <AxisBars satisfaction={n?.satisfaction ?? ({} as Record<Axis, number>)} axes={AXES} />

              {n && (n.forageEnergy ?? 0) > 0 && (
                <div className="mb-3 flex items-center gap-2 rounded-md bg-[#26331f] px-3 py-1.5 text-[11px] text-[#bfe8a8]">
                  <ForageIcon size={14} />
                  <span>
                    Free-range forage is auto-feeding{' '}
                    <span className="font-bold">
                      {Math.round((100 * (n.forageEnergy ?? 0)) / (n.requirement.energy || 1))}%
                    </span>{' '}
                    of energy — dial corn down to lean on it. ({fmt(state.resources.forage)} banked)
                  </span>
                </div>
              )}

              {n && n.feedScale < 1 && (
                <div className="mb-3 rounded-md bg-[#3a2418] px-3 py-1.5 text-[11px] text-[#e8a35a]">
                  Under-milled — the mills blend only {Math.round(n.feedScale * 100)}% of demand. Build another Feed Mill.
                </div>
              )}
              {debuffed > 0 && (
                <div className="mb-3 rounded-md bg-[#3a1f2a] px-3 py-1.5 text-[11px] text-[#e87a9a]">
                  {debuffed} duck{debuffed > 1 ? 's' : ''} limping from niacin shortfall. Select a coop and Dose Brewer's Yeast.
                </div>
              )}

              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
                Layer ration — units per adult duck per cycle
              </div>
              <RationSliders state={state} ration={state.ration} onSet={(i, v) => engine.setRation(i, v)} />
              <p className="mt-3 text-[10px] text-[#7a6a4a]">
                Requirement scales with your adult flock. Keep every line producing faster than the
                ducks eat and the bars stay green; condition buffers brief dips.
              </p>
            </>
          )
        ) : !dn ? (
          <div className="py-6 text-center text-sm text-[#9a8a6a]">
            No ducklings growing — pair a drake and hen in the Flock panel to breed.
          </div>
        ) : (
          <>
            <div className="mb-4 rounded-md bg-[#1f1812] px-3 py-2 text-xs">
              <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">Maturation speed</div>
              <div className="text-lg font-bold" style={{ color: barColor(dn.matureRate) }}>
                {Math.round(dn.matureRate * 100)}%
              </div>
              <div className="text-[10px] text-[#9a8a6a]">{dn.immatureCount} growing</div>
            </div>

            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
              Grow-out balance (high protein + niacin)
            </div>
            <AxisBars satisfaction={dn.satisfaction} axes={DUCKLING_AXES} />

            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
              Duckling ration — units per duckling per cycle
            </div>
            <RationSliders state={state} ration={state.ducklingRation} onSet={(i, v) => engine.setDucklingRation(i, v)} />
            <p className="mt-3 text-[10px] text-[#7a6a4a]">
              Ducklings eat from the same storage as your layers (layers eat first), so growing the
              flock competes with feeding it. A poor grow-out ration slows maturation toward{' '}
              {Math.round(B.DUCKLING_RATION_MATURE_PENALTY_FLOOR * 100)}% speed — a throttle, never a stop.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
