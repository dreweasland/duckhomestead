import { useState, type ReactNode } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import {
  BOOST_IDS,
  boostCost,
  boostLevel,
  boostMult,
  canPrestige,
  championGoal,
  currencyAtSize,
  prestigeCurrency,
  targetForTier,
  type BoostId,
} from '../game/prestige';
import { COLORS, type Color, type GameState, type Genome } from '../game/state';
import { playDing, playUpgrade } from '../audio/sfx';
import { ColorSwatch, COLOR_META, GENE_META } from './FlockPanel';
import { useEscapeKey } from './useEscapeKey';
import { CheckIcon, CloseIcon, DuckIcon, SnowflakeIcon, GrangeIcon, LegacyIcon, LockIcon, PrimeIcon, SiegeOwlIcon } from './icons';

/** One champion requirement: icon, label, value, a progress bar, and met state. */
function GoalRow({
  icon,
  label,
  value,
  progress,
  met,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  progress: number;
  met: boolean;
  hint?: ReactNode;
}) {
  const color = met ? '#8fe388' : progress >= 0.66 ? '#e8c45a' : '#e8835a';
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="flex w-4 justify-center" style={{ color }}>
          {met ? <CheckIcon size={11} /> : icon}
        </span>
        <span className="text-[#c9b88f]">{label}</span>
        <span className="ml-auto tabular-nums font-bold" style={{ color }}>
          {value}
        </span>
      </div>
      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-[#0f0b07]">
        <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.round(progress * 100)}%`, background: color }} />
      </div>
      {hint && <div className="mt-0.5 pl-5 text-[9px]">{hint}</div>}
    </div>
  );
}

const BOOST_META: Record<BoostId, { label: string; blurb: string }> = {
  output: { label: 'Output', blurb: 'all station production' },
  stationSpeed: { label: 'Station Speed', blurb: 'faster producer cycles' },
  eggValue: { label: 'Egg Value', blurb: 'more eggs laid' },
  waterProvision: { label: 'Water Capacity', blurb: 'water a bigger flock (past the pond cap)' },
  renown: { label: 'Renown', blurb: 'more XP per tend/dose — re-climb the ranks faster' },
  husbandry: { label: 'Husbandry', blurb: 'faster clutches + maturation — regrow the flock faster' },
};

/** A gate-target profile as read-only gene pips (the tier's breeding puzzle). */
function TargetPips({ target, size = 13 }: { target: Genome; size?: number }) {
  return (
    <span className="inline-flex gap-0.5 align-middle">
      {target.map((g, i) => (
        <span
          key={i}
          className="inline-flex items-center justify-center rounded-[2px] font-bold leading-none"
          style={{ width: size, height: size, fontSize: size - 5, background: GENE_META[g].color, color: '#171009' }}
          title={`Slot ${i + 1}: ${GENE_META[g].label}`}
        >
          {g}
        </span>
      ))}
    </span>
  );
}

const fmtDate = (ms: number) => {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
};

/** Side-panel button styling: pull attention when the champion goal is reached. */
export function legacyReady(state: GameState): boolean {
  return canPrestige(state);
}

export function LegacyPanel({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<{ tier: number; granted: number } | null>(null);

  const goal = championGoal(state);
  const ready = canPrestige(state);
  const grant = prestigeCurrency(state);
  const gateTarget = targetForTier(state.legacyTier);
  const nextTarget = targetForTier(state.legacyTier + 1);
  // The push-vs-reset projection: what a +50% flock would bank instead.
  const pushSize = Math.round(state.ducks.length * 1.5);
  const pushGrant = currencyAtSize(state, pushSize);

  const doPrestige = () => {
    if (!ready) return;
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    const r = engine.prestige();
    setArmed(false);
    if (r.ok) {
      setResult({ tier: r.tier, granted: r.granted });
      playDing(true);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-black text-[#ffe9a8]">
            <LegacyIcon size={20} /> Legacy
          </h2>
          <div className="flex items-center gap-3">
            <span className="rounded bg-[#3a2e22] px-2 py-1 text-xs font-bold text-[#ffe9a8]">
              Tier {state.legacyTier}
            </span>
            <span className="rounded bg-[#1f1812] px-2 py-1 text-xs font-bold text-[#e2b94f]">
              {state.legacyCurrency} legacy
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

        {result && (
          <div className="mb-3 rounded-md bg-[#3a2e16] px-3 py-2 text-center text-xs font-bold text-[#ffe9a8] ring-1 ring-[#e2b94f]">
            Legacy raised to Tier {result.tier} · +{result.granted} legacy. A fresh run begins —
            your boosts carry forward.
          </div>
        )}

        {/* Champion goal — three concrete requirements (meet all three to prestige). */}
        <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
              Champion flock — meet all three
            </span>
            <span className="text-xs font-bold tabular-nums" style={{ color: ready ? '#8fe388' : '#e8c45a' }}>
              {ready ? 'ready!' : `${Math.round(goal.readiness * 100)}%`}
            </span>
          </div>

          {/* 1 — all colours bred */}
          <GoalRow
            icon={<span className="flex items-center gap-0.5">{COLORS.map((c) => (
              <ColorSwatch key={c} color={c} size={10} />
            ))}</span>}
            label="All colours bred"
            value={`${goal.colors.bred}/${goal.colors.total}`}
            progress={goal.colors.progress}
            met={goal.colors.met}
            hint={
              goal.colors.met ? undefined : (
                <span className="text-[#7a6a4a]">
                  still need{' '}
                  {(COLORS as Color[])
                    .filter((c) => !state.dexSeen.includes(c))
                    .map((c) => COLOR_META[c].label)
                    .join(', ')}
                </span>
              )
            }
          />
          {/* 2 — average genome quality (mean slots matching THIS TIER's target) */}
          <GoalRow
            icon={<span className="text-[#ffe9a8]">⌬</span>}
            label="Genome quality"
            value={`${goal.quality.value.toFixed(2)} / ${goal.quality.gate.toFixed(2)}`}
            progress={goal.quality.progress}
            met={goal.quality.met}
            hint={
              <span className="inline-flex items-center gap-1.5 text-[#7a6a4a]">
                <span>tier target</span>
                <TargetPips target={gateTarget} size={12} />
                {!goal.quality.met && <span>— crossbreed toward it + cull the weak</span>}
              </span>
            }
          />
          {/* 3 — flock size (scales each tier) */}
          <GoalRow
            icon={<DuckIcon size={12} />}
            label="Flock size"
            value={`${goal.size.value} / ${goal.size.target}`}
            progress={goal.size.progress}
            met={goal.size.met}
            hint={goal.size.met ? undefined : <span className="text-[#7a6a4a]">more coops + breeding</span>}
          />
        </div>

        {/* Prestige action */}
        <button
          onClick={doPrestige}
          disabled={!ready}
          className={`mb-1 w-full rounded-md px-3 py-2.5 text-sm font-bold transition ${
            !ready
              ? 'cursor-not-allowed bg-[#1f1812] text-[#6a5a3a]'
              : armed
                ? 'bg-[#d95f5f] text-[#fff4d6] hover:bg-[#e57070]'
                : 'bg-[#6b4f9e] text-[#fff4d6] hover:bg-[#7a5cae]'
          }`}
        >
          {!ready
            ? `Meet the champion goal first (${Math.round(goal.readiness * 100)}%)`
            : armed
              ? 'Wipe the run? — flock, zones, everything. Confirm'
              : `Raise your Legacy · +${grant} legacy`}
        </button>
        {ready && (
          <div className="mb-1 text-center text-[10px] text-[#8fae6a]">
            Push or reset? Now <span className="font-bold tabular-nums">+{grant}</span> · at{' '}
            <span className="tabular-nums">{pushSize}</span> ducks ≈{' '}
            <span className="font-bold tabular-nums">+{pushGrant}</span>. Overshooting the size
            target and quality gate pays superlinearly — a deeper run banks more.
          </div>
        )}
        {/* The next tier's puzzle — the reason to prestige beyond the numbers. */}
        <div className="mb-1 flex items-center justify-center gap-1.5 text-center text-[10px] text-[#9a8a6a]">
          <span>Next legacy demands</span>
          <TargetPips target={nextTarget} size={12} />
          <span>— a new breeding puzzle</span>
        </div>
        <div className="mb-3 text-center text-[10px] text-[#7a6a4a]">
          Prestige wipes the entire run (flock, eggs, stations, zones re-lock) for permanent boosts.
          Only your legacy + boosts persist. The size target, quality gate, and target profile all
          change each tier.
        </div>

        {/* Tier-gated content tease — the same aspirational-silhouette trick as a
            locked zone: one row, shown only until it unlocks. */}
        {state.legacyTier < BALANCE.CONTRACTS.UNLOCK_TIER && (
          <div className="mb-3 flex items-center justify-between rounded-md bg-[#1f1812] px-3 py-2 text-[11px]">
            <span className="flex items-center gap-1.5 font-bold text-[#7a6a4a]">
              <LockIcon size={11} />
              <GrangeIcon size={14} className="opacity-40" /> The Grange
            </span>
            <span className="text-[#7a6a4a]">opens at Tier {BALANCE.CONTRACTS.UNLOCK_TIER}</span>
          </div>
        )}
        {state.legacyTier < BALANCE.PREDATORS.SIEGE.MIN_LEGACY_TIER && (
          <div className="mb-3 flex items-center justify-between rounded-md bg-[#1f1812] px-3 py-2 text-[11px]">
            <span className="flex items-center gap-1.5 font-bold text-[#7a6a4a]">
              <LockIcon size={11} />
              <SiegeOwlIcon size={14} className="opacity-40" /> The Siege — a named hunter
            </span>
            <span className="text-[#7a6a4a]">opens at Tier {BALANCE.PREDATORS.SIEGE.MIN_LEGACY_TIER}</span>
          </div>
        )}
        {state.legacyTier < BALANCE.GENOME.PRIME_MIN_TIER && (
          <div className="mb-3 flex items-center justify-between rounded-md bg-[#1f1812] px-3 py-2 text-[11px]">
            <span className="flex items-center gap-1.5 font-bold text-[#7a6a4a]">
              <LockIcon size={11} />
              <PrimeIcon size={14} className="opacity-40" /> The Prime gene — a wildcard chase
            </span>
            <span className="text-[#7a6a4a]">opens at Tier {BALANCE.GENOME.PRIME_MIN_TIER}</span>
          </div>
        )}
        {state.legacyTier < (BALANCE.WINTER.UNLOCK.minLegacyTier ?? 0) && (
          <div className="mb-3 flex items-center justify-between rounded-md bg-[#1f1812] px-3 py-2 text-[11px]">
            <span className="flex items-center gap-1.5 font-bold text-[#7a6a4a]">
              <LockIcon size={11} />
              <SnowflakeIcon size={14} className="opacity-40" /> Winterstead — the second homestead
            </span>
            <span className="text-[#7a6a4a]">opens at Tier {BALANCE.WINTER.UNLOCK.minLegacyTier}</span>
          </div>
        )}

        {/* Legacy shop */}
        <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
            Legacy boosts (permanent · global)
          </div>
          <div className="flex flex-col gap-2">
            {BOOST_IDS.map((id) => {
              const lvl = boostLevel(state, id);
              const cost = boostCost(state, id);
              const effect = Math.round((boostMult(state, id) - 1) * 100);
              const affordable = state.legacyCurrency >= cost;
              return (
                <div key={id} className="flex items-center gap-2 rounded bg-[#171009] px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-bold text-[#f5ecd8]">
                      {BOOST_META[id].label}{' '}
                      <span className="text-[#8fe388]">+{effect}%</span>{' '}
                      <span className="text-[9px] font-normal text-[#7a6a4a]">Lv {lvl}</span>
                    </div>
                    <div className="text-[9px] text-[#7a6a4a]">{BOOST_META[id].blurb}</div>
                  </div>
                  <button
                    onClick={() => {
                      if (engine.buyBoost(id) != null) playUpgrade();
                    }}
                    disabled={!affordable}
                    className={`rounded px-2 py-1 text-[10px] font-bold ${
                      affordable
                        ? 'bg-[#3a2e22] text-[#ffe9a8] hover:bg-[#4a3a2a]'
                        : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                    }`}
                    title={`Buy level ${lvl + 1}`}
                  >
                    {cost} legacy
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Legacy Hall */}
        {state.legacyHall.length > 0 && (
          <div className="rounded-md bg-[#1f1812] px-3 py-2.5">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
              Legacy Hall
            </div>
            <div className="flex flex-col gap-1.5">
              {[...state.legacyHall].reverse().map((c) => (
                <div key={c.tier} className="flex items-center gap-2 rounded bg-[#171009] px-2.5 py-1.5 text-[11px]">
                  <span className="flex items-center gap-1 font-bold text-[#ffe9a8]">
                    <LegacyIcon size={12} /> T{c.tier}
                  </span>
                  <span className="flex items-center gap-0.5">
                    {(c.colors ?? []).map((col) => (
                      <ColorSwatch key={col} color={col} size={9} />
                    ))}
                  </span>
                  <span className="tabular-nums text-[#c9b88f]">{(c.meanQuality ?? 0).toFixed(2)} avg</span>
                  <span className="ml-auto inline-flex items-center gap-1 tabular-nums text-[#7a6a4a]">
                    <DuckIcon size={10} /> {c.flockSize ?? 0}
                  </span>
                  <span className="text-[9px] text-[#5a4d3a]">{fmtDate(c.timestamp)}</span>
                </div>
              ))}
            </div>
            <div className="mt-1.5 text-[9px] text-[#5a4d3a]">
              A memorial of champions past — no mechanical effect.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
