import { useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import {
  BOOST_IDS,
  boostCost,
  boostLevel,
  boostMult,
  canPrestige,
  currentThreshold,
  legacyScore,
  prestigeCurrency,
  thresholdProgress,
  type BoostId,
} from '../game/prestige';
import { COLORS, type GameState } from '../game/state';
import { playDing, playUpgrade } from '../audio/sfx';
import { ColorSwatch } from './FlockPanel';
import { CloseIcon, EggIcon, LegacyIcon } from './icons';

const P = BALANCE.PRESTIGE;

const BOOST_META: Record<BoostId, { label: string; blurb: string }> = {
  output: { label: 'Output', blurb: 'all station production' },
  stationSpeed: { label: 'Station Speed', blurb: 'faster producer cycles' },
  eggValue: { label: 'Egg Value', blurb: 'more eggs laid' },
};

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
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<{ tier: number; granted: number } | null>(null);

  const score = legacyScore(state);
  const threshold = currentThreshold(state);
  const progress = thresholdProgress(state);
  const ready = canPrestige(state);
  const grant = prestigeCurrency(state);
  const pct = Math.round(progress * 100);

  // Score breakdown (so the goal is legible).
  const W = P.SCORE_WEIGHTS;
  const vigorSum = state.ducks.reduce((a, d) => a + d.vigor, 0);
  const dexFrac = state.dexSeen.length / COLORS.length;
  const parts = [
    { label: 'vigor', value: Math.round(W.vigor * vigorSum) },
    { label: 'dex', value: Math.round(W.dexCompletion * dexFrac) },
    { label: 'flock', value: Math.round(W.flockSize * state.ducks.length) },
  ];

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

        {/* Champion goal */}
        <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2.5">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
              Champion flock
            </span>
            <span
              className="text-sm font-bold tabular-nums"
              style={{ color: ready ? '#8fe388' : '#e8c45a' }}
            >
              {pct}%
            </span>
          </div>
          <div className="mb-1 h-2.5 overflow-hidden rounded-full bg-[#0f0b07]">
            <div
              className="h-full rounded-full transition-[width]"
              style={{
                width: `${pct}%`,
                background: ready ? '#8fe388' : 'linear-gradient(to right,#e2b94f,#e8c45a)',
              }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-[#9a8a6a]">
            <span className="tabular-nums">
              score {Math.round(score)} / {Math.round(threshold)}
            </span>
            <span className="tabular-nums text-[#7a6a4a]">
              {parts.map((p, i) => (
                <span key={p.label}>
                  {i > 0 && ' + '}
                  {p.value} {p.label}
                </span>
              ))}
            </span>
          </div>
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
            ? `Reach the champion goal first (${pct}%)`
            : armed
              ? 'Wipe the run? — flock, zones, everything. Confirm'
              : `Raise your Legacy · +${grant} legacy`}
        </button>
        <div className="mb-3 text-center text-[10px] text-[#7a6a4a]">
          Prestige wipes the entire run (flock, eggs, stations, zones re-lock) for permanent boosts.
          Only your legacy + boosts persist.
        </div>

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
                    {c.colors.map((col) => (
                      <ColorSwatch key={col} color={col} size={9} />
                    ))}
                  </span>
                  <span className="tabular-nums text-[#c9b88f]">×{c.bestVigor.toFixed(2)} best</span>
                  <span className="tabular-nums text-[#7a6a4a]">{c.flockSize} ducks</span>
                  <span className="ml-auto inline-flex items-center gap-1 tabular-nums text-[#e2b94f]">
                    <EggIcon size={10} /> {c.score}
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
