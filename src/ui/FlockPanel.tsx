import { useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { colorOdds, expectedVigor, populationMeanVigor } from '../game/genetics';
import { COLORS, coopCapacity, phenotype, type Color, type Duck, type GameState } from '../game/state';
import { playPlace } from '../audio/sfx';
import { CloseIcon } from './icons';

export const COLOR_META: Record<Color, { label: string; swatch: string }> = {
  black: { label: 'Black', swatch: '#33333c' },
  blue: { label: 'Blue', swatch: '#5b7a9d' },
  splash: { label: 'Splash', swatch: '#aebed2' },
};

const STAGE_LABEL: Record<Duck['stage'], string> = {
  duckling: 'duckling',
  juvenile: 'juvenile',
  adult: 'adult',
};

const stageRank: Record<Duck['stage'], number> = { adult: 0, juvenile: 1, duckling: 2 };

export function ColorSwatch({ color, size = 14 }: { color: Color; size?: number }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: COLOR_META[color].swatch, border: '1px solid #1a1410' }}
      title={COLOR_META[color].label}
    />
  );
}

/** Pick-a-pair + active-pair status. */
function Breeding({ engine, state }: { engine: GameEngine; state: GameState }) {
  const [drakeId, setDrakeId] = useState('');
  const [henId, setHenId] = useState('');
  const B = BALANCE.BREEDING;
  const paired = (id: string) => state.breedingPairs.some((p) => p.drakeId === id || p.henId === id);
  const avail = (sex: Duck['sex']) =>
    state.ducks
      .filter((d) => d.sex === sex && d.stage === 'adult' && !paired(d.id))
      .sort(
        (a, b) =>
          COLORS.indexOf(phenotype(a.genotype)) - COLORS.indexOf(phenotype(b.genotype)) ||
          b.vigor - a.vigor,
      );
  const drakes = avail('drake');
  const hens = avail('hen');
  const byId = (id: string) => state.ducks.find((d) => d.id === id);

  return (
    <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2">
      <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">
        Breeding
      </div>
      {state.breedingPairs.map((p) => {
        const dr = byId(p.drakeId);
        const he = byId(p.henId);
        if (!dr || !he) return null;
        const next = Math.max(0, B.CLUTCH_INTERVAL_S - p.clutchProgress);
        const soonest = p.incubating.length ? Math.max(0, B.INCUBATE_S - Math.max(...p.incubating)) : 0;
        // Expected offspring vigor (regression toward the live flock mean) so the
        // player can see whether this cross lifts or drags the line.
        const popMean = populationMeanVigor(state);
        const exp = expectedVigor(dr.vigor, he.vigor, popMean);
        const lifts = exp >= popMean;
        const odds = colorOdds(dr.genotype, he.genotype);
        return (
          <div key={p.id} className="mb-1.5 rounded bg-[#171009] px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              <ColorSwatch color={phenotype(dr.genotype)} size={11} />
              <span className="text-[#9a8a6a]">{dr.sex}</span>
              <span className="tabular-nums text-[#ffe9a8]">×{dr.vigor.toFixed(2)}</span>
              <span className="text-[#5a4d3a]">·</span>
              <ColorSwatch color={phenotype(he.genotype)} size={11} />
              <span className="text-[#9a8a6a]">{he.sex}</span>
              <span className="tabular-nums text-[#ffe9a8]">×{he.vigor.toFixed(2)}</span>
              <span className="ml-1 text-[#7a6a4a]" title={`Expected offspring vigor, regressing toward the flock mean of ×${popMean.toFixed(2)}`}>
                → <span className="tabular-nums font-bold" style={{ color: lifts ? '#8fe388' : '#e8a35a' }}>~×{exp.toFixed(2)}</span>
              </span>
              <button
                onClick={() => engine.unpair(p.id)}
                className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-[#b06a6a] hover:bg-[#33271c]"
              >
                unpair
              </button>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[#7a6a4a]">
              {COLORS.filter((c) => odds[c] > 0).map((c) => (
                <span key={c} className="flex items-center gap-0.5" title={`${COLOR_META[c].label} offspring`}>
                  <ColorSwatch color={c} size={9} />
                  <span className="tabular-nums text-[#9a8a6a]">{Math.round(odds[c] * 100)}%</span>
                </span>
              ))}
            </div>
            <div className="mt-0.5 text-[10px] text-[#9a8a6a]">
              clutch {Math.ceil(next)}s
              {p.incubating.length > 0 && ` · ${p.incubating.length} incubating (hatch ${Math.ceil(soonest)}s)`}
            </div>
          </div>
        );
      })}
      {drakes.length > 0 && hens.length > 0 ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <select
            value={drakeId}
            onChange={(e) => setDrakeId(e.target.value)}
            className="flex-1 rounded bg-[#2a2018] px-1.5 py-1 text-[11px]"
          >
            <option value="">drake…</option>
            {drakes.map((d) => (
              <option key={d.id} value={d.id}>
                {phenotype(d.genotype)} ×{d.vigor.toFixed(2)}
              </option>
            ))}
          </select>
          <select
            value={henId}
            onChange={(e) => setHenId(e.target.value)}
            className="flex-1 rounded bg-[#2a2018] px-1.5 py-1 text-[11px]"
          >
            <option value="">hen…</option>
            {hens.map((d) => (
              <option key={d.id} value={d.id}>
                {phenotype(d.genotype)} ×{d.vigor.toFixed(2)}
              </option>
            ))}
          </select>
          <button
            onClick={() => {
              if (engine.pair(drakeId, henId).ok) {
                playPlace();
                setDrakeId('');
                setHenId('');
              }
            }}
            disabled={!drakeId || !henId}
            className={`rounded px-2 py-1 text-[11px] font-bold ${
              drakeId && henId
                ? 'bg-[#6b4f9e] text-[#fff4d6] hover:bg-[#7a5cae]'
                : 'cursor-not-allowed bg-[#2a2018] text-[#6a5a3a]'
            }`}
          >
            Pair
          </button>
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-[#7a6a4a]">
          Need an unpaired adult drake and hen to start a pair.
        </div>
      )}
    </div>
  );
}

export function FlockPanel({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
}) {
  const [armedCull, setArmedCull] = useState<string | null>(null);
  // Sort: color (dex order) → stage (adults, then juveniles, then ducklings) →
  // sex (drakes, then hens) → vigor (best first within each group).
  const colorRank = (d: Duck) => COLORS.indexOf(phenotype(d.genotype));
  const sexRank: Record<Duck['sex'], number> = { drake: 0, hen: 1 };
  const ducks = [...state.ducks].sort(
    (a, b) =>
      colorRank(a) - colorRank(b) ||
      stageRank[a.stage] - stageRank[b.stage] ||
      sexRank[a.sex] - sexRank[b.sex] ||
      b.vigor - a.vigor,
  );
  const cap = coopCapacity(state);

  // Tab the flock by color. Counts per color drive the tab badges; open on the
  // color you have the most of. The sorted `ducks` filtered to a color is already
  // in stage → sex → vigor order.
  const colorCounts: Record<Color, number> = { black: 0, blue: 0, splash: 0 };
  for (const d of state.ducks) colorCounts[phenotype(d.genotype)]++;
  const [colorTab, setColorTab] = useState<Color>(
    () => [...COLORS].sort((a, b) => colorCounts[b] - colorCounts[a])[0] ?? 'blue',
  );
  const shown = ducks.filter((d) => phenotype(d.genotype) === colorTab);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Flock</h2>
          <div className="flex items-center gap-3">
            <span className="rounded bg-[#1f1812] px-2 py-1 text-xs font-bold text-[#c9b88f]">
              {state.ducks.length}/{cap} housed
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

        {/* Dex — colors collected so far */}
        <div className="mb-3 flex items-center gap-2 rounded-md bg-[#1f1812] px-3 py-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">Dex</span>
          {COLORS.map((c) => {
            const have = state.dexSeen.includes(c);
            return (
              <span
                key={c}
                className={`flex items-center gap-1 text-[11px] ${have ? 'text-[#f5ecd8]' : 'text-[#5a4d3a] opacity-50'}`}
              >
                <ColorSwatch color={c} size={12} />
                {COLOR_META[c].label}
              </span>
            );
          })}
        </div>

        {state.ducks.length > 0 && <Breeding engine={engine} state={state} />}

        {state.ducks.length === 0 ? (
          <div className="py-6 text-center text-sm text-[#9a8a6a]">
            No ducks yet — build a Coop to house your starting flock.
          </div>
        ) : (
          <>
            {/* Color tabs — black / blue / splash */}
            <div className="mb-2 flex gap-1">
              {COLORS.map((c) => {
                const active = c === colorTab;
                return (
                  <button
                    key={c}
                    onClick={() => setColorTab(c)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold transition ${
                      active ? 'bg-[#3a2e22] ring-1 ring-[#5a4a32]' : 'bg-[#1f1812] hover:bg-[#33271c]'
                    }`}
                  >
                    <ColorSwatch color={c} size={11} />
                    <span className={active ? 'text-[#f5ecd8]' : 'text-[#9a8a6a]'}>{COLOR_META[c].label}</span>
                    <span className="tabular-nums text-[#7a6a4a]">{colorCounts[c]}</span>
                  </button>
                );
              })}
            </div>

            {shown.length === 0 ? (
              <div className="py-6 text-center text-sm text-[#9a8a6a]">
                No {COLOR_META[colorTab].label.toLowerCase()} ducks yet.
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {shown.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 rounded-md bg-[#1f1812] px-2.5 py-1.5 text-[11px]">
                      <span className="w-10 text-[#c9b88f]">{d.sex}</span>
                  <span className="w-20 text-[#9a8a6a]">
                    {STAGE_LABEL[d.stage]}
                    {d.stage !== 'adult' && (
                      <span className="text-[#5a4d3a]">
                        {' '}
                        {Math.round(
                          (d.ageTicks /
                            (d.stage === 'duckling'
                              ? BALANCE.BREEDING.MATURE_DUCKLING_S
                              : BALANCE.BREEDING.MATURE_JUVENILE_S)) *
                            100,
                        )}
                        %
                      </span>
                    )}
                  </span>
                  <span className="ml-auto tabular-nums text-[#ffe9a8]">×{d.vigor.toFixed(2)}</span>
                  <span className="text-[9px] text-[#5a4d3a]">vigor</span>
                  <button
                    onClick={() => {
                      if (armedCull !== d.id) {
                        setArmedCull(d.id);
                        window.setTimeout(() => setArmedCull((a) => (a === d.id ? null : a)), 2500);
                        return;
                      }
                      engine.cull(d.id);
                      setArmedCull(null);
                    }}
                    className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      armedCull === d.id
                        ? 'bg-[#d95f5f] text-[#fff4d6]'
                        : 'text-[#7a5a5a] hover:bg-[#33271c] hover:text-[#b06a6a]'
                    }`}
                    title="Release this duck (frees housing, raises the flock's vigor mean)"
                  >
                    {armedCull === d.id ? 'sure?' : 'release'}
                  </button>
                    </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
