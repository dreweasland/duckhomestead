import { useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import {
  AXES,
  breedingEstablished,
  INGREDIENTS,
  ingredientCap,
  rationUnset,
  zoneUnlocked,
  type Axis,
  type GameState,
  type Ingredient,
} from '../game/state';

import {
  flockRequirement,
  waterAccess,
  waterConditionMult,
  waterProvision,
  waterStatus,
  waterWoundMult,
} from '../game/water';
import { fmt } from './format';
import { useEscapeKey } from './useEscapeKey';
import { CloseIcon, RESOURCE_ICON, WaterIcon } from './icons';

const N = BALANCE.NUTRITION;
const B = BALANCE.BREEDING;
const AXIS_LABEL: Record<Axis, string> = { energy: 'Energy', protein: 'Protein', niacin: 'Niacin', calcium: 'Calcium' };
const ING_LABEL: Record<Ingredient, string> = {
  corn: 'Corn',
  peas: 'Peas',
  mealworms: 'Mealworms',
  brewersYeast: "Brewer's Yeast",
  oysterShell: 'Oyster Shell',
  sunflowerSeeds: 'Sunflower Seeds',
  fodderSprouts: 'Fodder Sprouts',
};
const RATION_MAX = 6;
const DUCKLING_AXES: Axis[] = ['energy', 'protein', 'niacin'];
const DRAKE_AXES: Axis[] = ['energy', 'protein', 'niacin']; // no calcium — drakes don't lay

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
  const cap = ingredientCap(state);
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
                <span
                  className={starved ? 'text-[#e8835a]' : stock >= cap ? 'text-[#e8c45a]' : 'text-[#9a8a6a]'}
                  title={stock >= cap ? 'Feed Store FULL — producers of this line are idling. Upgrade the Feed Store or let the flock eat it down.' : undefined}
                >
                  {fmt(stock)}/{fmt(cap)}
                </span>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={RATION_MAX}
              step={0.25}
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

/** A ration section: title + a one-tap "Suggested" fill (the balanced default),
 *  a can't-miss "not set" banner when it's all zero, then the sliders. Rations now
 *  start EMPTY, so this both flags an unset ration and offers the quick fix. */
function RationEditor({
  state,
  title,
  ration,
  suggested,
  onSet,
}: {
  state: GameState;
  title: string;
  ration: Record<Ingredient, number>;
  suggested: Record<Ingredient, number>;
  onSet: (ing: Ingredient, v: number) => void;
}) {
  const unset = rationUnset(ration);
  return (
    <>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">{title}</span>
        <button
          onClick={() => INGREDIENTS.forEach((i) => onSet(i, suggested[i] ?? 0))}
          className="rounded bg-[#3a2e64] px-2 py-0.5 text-[10px] font-bold text-[#cdbcff] transition hover:bg-[#473a78]"
          title="Fill with a balanced starting ration"
        >
          Suggested
        </button>
      </div>
      {unset && (
        <div className="mb-2 rounded-md bg-[#3a2418] px-3 py-1.5 text-[11px] text-[#e8a35a] ring-1 ring-[#5a3a22]">
          Ration not set — nothing’s being fed here. Drag the sliders or tap{' '}
          <span className="font-bold">Suggested</span>.
        </div>
      )}
      <RationSliders state={state} ration={ration} onSet={onSet} />
    </>
  );
}

/** Water readout: the water system's PROVISION vs the flock's requirement, its
 *  wellness effects, and where to go to scale it — so the player SEES the flock
 *  outgrowing its water and is invited to the Pond / Waterworks tabs. */
function WaterCard({ state }: { state: GameState }) {
  const provision = waterProvision(state);
  const requirement = flockRequirement(state);
  const flock = state.ducks.length;
  const access = waterAccess(state);
  const status = waterStatus(access);
  const condMult = waterConditionMult(state);
  const woundMult = waterWoundMult(state);
  const pondUnlocked = zoneUnlocked(state, 'pond');
  const worksUnlocked = zoneUnlocked(state, 'backPasture');
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
  // Invite the player to the right tab when the water is getting tight.
  const nudge = !pondUnlocked
    ? 'Unlock The Pond to build a real water layout for the flock.'
    : worksUnlocked
      ? 'Outgrowing it? Expand the Pond layout, or improve circulation in Waterworks.'
      : 'Outgrowing it? Add features in the Pond — and Waterworks (circulation) unlocks soon.';

  return (
    <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
          <WaterIcon size={13} /> Water
        </div>
        <span className="text-xs font-bold tabular-nums" style={{ color }}>
          {provision.toFixed(1)} / {requirement.toFixed(0)} need · {label}
        </span>
      </div>
      <div className="relative mb-1.5 h-2 overflow-hidden rounded-full bg-[#0f0b07]">
        <div className="h-full rounded-full" style={{ width: `${fillPct}%`, background: color }} />
        {/* neutral (ratio 1.0) tick */}
        <div className="absolute inset-y-0 left-1/2 w-px bg-[#5a4d3a]" />
      </div>
      <div className="text-[10px] text-[#9a8a6a]">
        {flock} {flock === 1 ? 'duck' : 'ducks'} · condition regen{' '}
        <span className="font-bold tabular-nums" style={{ color: multColor(condMult) }}>
          ×{condMult.toFixed(2)}
        </span>{' '}
        · wound recovery{' '}
        <span className="font-bold tabular-nums" style={{ color: multColor(woundMult) }}>
          ×{woundMult.toFixed(2)}
        </span>
      </div>
      {status !== 'good' && <div className="mt-1.5 text-[10px] text-[#7a6a4a]">{nudge}</div>}
    </div>
  );
}

export type NutritionTab = 'layers' | 'ducklings' | 'drakes' | 'winter';

export function NutritionPanel({
  engine,
  state,
  onClose,
  initialTab,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
  /** The Almanac's Nutrition CTAs land on a specific sub-tab (e.g. Ducklings). */
  initialTab?: NutritionTab;
}) {
  useEscapeKey(onClose);
  const [tab, setTab] = useState<NutritionTab>(initialTab ?? 'layers');
  const n = state.nutrition;
  const coops = state.stations.filter((s) => s.type === 'coop');
  const debuffed = state.ducks.filter((d) => d.debuffed).length;
  const condPct = Math.round((state.condition / N.CONDITION_MAX) * 100);
  const eggPct = Math.round((n?.eggMult ?? 1) * 100);
  const dn = state.ducklingNutrition;
  const drn = state.drakeNutrition;
  const wn = state.winter;
  const winterOpen = zoneUnlocked(state, 'winterstead');
  const adults = state.ducks.filter((d) => d.stage === 'adult').length;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-h-[90vh] sm:rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Feed Formulation</h2>
          <button onClick={onClose} className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]" aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="mb-3 flex gap-1 border-b border-[#3a2e22]">
          {(winterOpen ? (['layers', 'ducklings', 'drakes', 'winter'] as const) : (['layers', 'ducklings', 'drakes'] as const)).map((id) => (
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
                  {n && n.stressMult < 0.995 ? (
                    <div className="mt-0.5 text-[10px] font-bold text-[#e8a35a]" title="Harm events (attacks, injuries, losses) rattle the flock — a rattled flock lays slower until its condition recovers. Good rations, water, and condition-regen modules speed the recovery.">
                      rattled — laying ×{n.stressMult.toFixed(2)} until recovered
                    </div>
                  ) : (
                    <div className="mt-0.5 text-[10px] text-[#9a8a6a]">{condPct}% reserve</div>
                  )}
                </div>
              </div>

              <WaterCard state={state} />

              {/* THE FEED STORE: the per-ingredient storage cap — your offline
                  runway + shock buffer. Capacity is BUILT (silos on the board),
                  so storage competes with producers for tiles. */}
              <div className="mb-4 rounded-md bg-[#1f1812] px-3 py-2 text-xs">
                <div className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
                  Feed Store
                </div>
                <div className="text-[10px] text-[#9a8a6a]">
                  holds {fmt(ingredientCap(state))} of each ingredient
                  {state.stations.some((s) => s.type === 'silo')
                    ? ` (base + ${state.stations.filter((s) => s.type === 'silo').length} silo${state.stations.filter((s) => s.type === 'silo').length > 1 ? 's' : ''})`
                    : ''}{' '}
                  — full lines idle their producers. Build or upgrade Silos on the board for more.
                </div>
              </div>

              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
                Nutrient balance ({adults} adult{adults > 1 ? 's' : ''})
              </div>
              <AxisBars satisfaction={n?.satisfaction ?? ({} as Record<Axis, number>)} axes={AXES} />

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

              <RationEditor
                state={state}
                title="Layer ration — units per adult duck per cycle"
                ration={state.ration}
                suggested={N.DEFAULT_RATION}
                onSet={(i, v) => engine.setRation(i, v)}
              />
              <p className="mt-3 text-[10px] text-[#7a6a4a]">
                Requirement scales with your adult flock. Keep every line producing faster than the
                ducks eat and the bars stay green; condition buffers brief dips.
              </p>
            </>
          )
        ) : tab === 'ducklings' ? (
          !dn ? (
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

              <RationEditor
                state={state}
                title="Duckling ration — units per duckling per cycle"
                ration={state.ducklingRation}
                suggested={B.DEFAULT_DUCKLING_RATION}
                onSet={(i, v) => engine.setDucklingRation(i, v)}
              />
              <p className="mt-3 text-[10px] text-[#7a6a4a]">
                Ducklings eat from the same storage as your layers (layers eat first), so growing the
                flock competes with feeding it. A poor grow-out ration slows maturation toward{' '}
                {Math.round(B.DUCKLING_RATION_MATURE_PENALTY_FLOOR * 100)}% speed — a throttle, never a stop.
              </p>
            </>
          )
        ) : tab !== 'drakes' ? null : !drn ? ( // 'winter' (6d) has its own block below — drakes is no longer the fallback
          <div className="py-6 text-center text-sm text-[#9a8a6a]">
            {breedingEstablished(state)
              ? 'No adult drakes to feed yet.'
              : 'Drakes don’t eat until breeding is established — build the Gene Reader or pair a drake and hen.'}
          </div>
        ) : (
          <>
            <div className="mb-4 rounded-md bg-[#1f1812] px-3 py-2 text-xs">
              <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">
                Breeding &amp; post speed
              </div>
              <div className="text-lg font-bold" style={{ color: barColor(drn.breedRate) }}>
                {Math.round(drn.breedRate * 100)}%
              </div>
              <div className="text-[10px] text-[#9a8a6a]">
                {drn.drakeCount} in the pool (drakes + posted workers)
              </div>
            </div>

            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
              Maintenance balance (no calcium needed)
            </div>
            <AxisBars satisfaction={drn.satisfaction} axes={DRAKE_AXES} />

            <RationEditor
              state={state}
              title="Maintenance ration — units per drake/worker per cycle"
              ration={state.drakeRation}
              suggested={B.DEFAULT_DRAKE_RATION}
              onSet={(i, v) => engine.setDrakeRation(i, v)}
            />
            <p className="mt-3 text-[10px] text-[#7a6a4a]">
              Drakes and posted workers (9a) draw from the same storage as the flock (a real end-game
              drain) but need no calcium — so it spares oyster shell. An underfed pool breeds AND works
              slower, down to {Math.round(B.DRAKE_BREED_PENALTY_FLOOR * 100)}% — a throttle, never a
              stop.
            </p>
          </>
        )}

        {/* ── Winterstead (Phase 6d): the 4th pool — eats LAST, lays at a premium ── */}
        {tab === 'winter' &&
          (!wn ? (
            <div className="py-6 text-center text-sm text-[#9a8a6a]">
              No hens are wintering over yet — assign adult hens from the Flock panel (winter coops
              set the capacity). Hardy (H-gene) hens earn the most out there.
            </div>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-md bg-[#1f1812] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">Winter lay</div>
                  <div className="text-lg font-bold" style={{ color: barColor(wn.eggMult) }}>
                    {Math.round(wn.eggMult * 100)}%
                  </div>
                  <div className="text-[10px] text-[#9a8a6a]">
                    {wn.henCount} hen{wn.henCount > 1 ? 's' : ''} · ×{BALANCE.WINTER.PREMIUM_EGG_MULT} premium
                  </div>
                </div>
                <div className="rounded-md bg-[#1f1812] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">Warmth</div>
                  <div className="text-lg font-bold" style={{ color: barColor(wn.warmth) }}>
                    {Math.round(wn.warmth * 100)}%
                  </div>
                  <div className="text-[10px] text-[#9a8a6a]">heaters warm nearby coops</div>
                </div>
                <div className="rounded-md bg-[#1f1812] px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-[#7a6a4a]">Water</div>
                  <div className="text-lg font-bold" style={{ color: barColor(wn.support) }}>
                    {Math.round(wn.support * 100)}%
                  </div>
                  <div className="text-[10px] text-[#9a8a6a]">heated waterers</div>
                </div>
              </div>

              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#9a8a6a]">
                Cold-weather balance (energy-hungry)
              </div>
              <AxisBars satisfaction={wn.satisfaction} axes={AXES} />

              <RationEditor
                state={state}
                title="Winter ration — units per winter hen per cycle"
                ration={state.winterRation}
                suggested={BALANCE.WINTER.DEFAULT_RATION}
                onSet={(i, v) => engine.setWinterRation(i, v)}
              />
              <p className="mt-3 text-[10px] text-[#7a6a4a]">
                Winter hens draw from the SAME stores as everyone else and eat LAST — a shortage
                throttles the winter site before your home flock, down to{' '}
                {Math.round(BALANCE.WINTER.PENALTY_FLOOR * 100)}%. Cold burns calories: lean on
                sunflower seeds and fodder sprouts from the winter lines. Hardy hens (H genes) lay up
                to +{Math.round(6 * BALANCE.WINTER.HARDINESS_PER_H * 100)}% out here.
              </p>
            </>
          ))}
      </div>
    </div>
  );
}
