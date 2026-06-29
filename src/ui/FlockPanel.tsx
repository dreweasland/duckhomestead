import { useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { colorOdds, targetMatch } from '../game/genetics';
import { COLORS, coopCapacity, phenotype, secureCapacity, type Color, type Duck, type Gene, type GameState } from '../game/state';
import { waterWoundMult } from '../game/water';
import { playPlace, playTend } from '../audio/sfx';
import { CloseIcon, HealIcon, ShieldIcon, WoundIcon } from './icons';

export const COLOR_META: Record<Color, { label: string; swatch: string }> = {
  black: { label: 'Black', swatch: '#33333c' },
  blue: { label: 'Blue', swatch: '#5b7a9d' },
  splash: { label: 'Splash', swatch: '#aebed2' },
};

/** Per-gene display: Lay / Vigor / Hardy / Dud. */
export const GENE_META: Record<Gene, { label: string; color: string }> = {
  L: { label: 'Lay', color: '#8fe388' },
  V: { label: 'Vigor', color: '#e8c45a' },
  H: { label: 'Hardy', color: '#7fb8e8' },
  D: { label: 'Dud', color: '#6a5a4a' },
};

/**
 * The 6-slot genome as a strip of gene tiles. Hidden ("?") until the duck's
 * genome has been read; a slot matching the god-clone target gets a ring.
 */
export function GenomeTiles({
  duck,
  target,
  size = 14,
}: {
  duck: Duck;
  target?: Gene[];
  size?: number;
}) {
  const known = !!duck.genomeKnown;
  return (
    <span className="inline-flex gap-0.5">
      {duck.genome.map((g, i) => {
        const hit = known && target && target[i] === g;
        return (
          <span
            key={i}
            className="inline-flex items-center justify-center rounded-[2px] font-bold leading-none"
            style={{
              width: size,
              height: size,
              fontSize: size - 5,
              background: known ? GENE_META[g].color : '#2a2018',
              color: known ? '#171009' : '#6a5a3a',
              boxShadow: hit ? '0 0 0 1.5px #ffe9a8' : undefined,
            }}
            title={known ? GENE_META[g].label : 'Unread — build a Gene Reader'}
          >
            {known ? g : '?'}
          </span>
        );
      })}
    </span>
  );
}

/** Compact quality read for a duck: matches-to-target when known, else "?". */
function qualityLabel(d: Duck, target: Gene[]): string {
  return d.genomeKnown ? `${targetMatch(d.genome, target)}/${target.length}` : '?';
}

const STAGE_LABEL: Record<Duck['stage'], string> = {
  duckling: 'duckling',
  juvenile: 'juvenile',
  adult: 'adult',
};

const stageRank: Record<Duck['stage'], number> = { adult: 0, juvenile: 1, duckling: 2 };

/** A compact segmented filter: one row of pill options sharing a value. */
function FilterRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] font-bold transition ${
              active
                ? 'bg-[#3a2e22] text-[#f5ecd8] ring-1 ring-[#5a4a32]'
                : 'bg-[#1f1812] text-[#9a8a6a] hover:bg-[#33271c]'
            }`}
          >
            {o.label}
            {o.count != null && <span className="tabular-nums text-[#7a6a4a]">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

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
  const target = state.genomeTarget;
  const paired = (id: string) => state.breedingPairs.some((p) => p.drakeId === id || p.henId === id);
  const avail = (sex: Duck['sex']) =>
    state.ducks
      .filter((d) => d.sex === sex && d.stage === 'adult' && !paired(d.id) && !d.wounded)
      .sort(
        (a, b) =>
          COLORS.indexOf(phenotype(a.genotype)) - COLORS.indexOf(phenotype(b.genotype)) ||
          targetMatch(b.genome, target) - targetMatch(a.genome, target),
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
        const odds = colorOdds(dr.genotype, he.genotype);
        return (
          <div key={p.id} className="mb-1.5 rounded bg-[#171009] px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              <ColorSwatch color={phenotype(dr.genotype)} size={11} />
              <GenomeTiles duck={dr} target={target} size={12} />
              <span className="text-[#5a4d3a]">·</span>
              <ColorSwatch color={phenotype(he.genotype)} size={11} />
              <GenomeTiles duck={he} target={target} size={12} />
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
                {phenotype(d.genotype)} · {qualityLabel(d, target)}
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
                {phenotype(d.genotype)} · {qualityLabel(d, target)}
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
  const target = state.genomeTarget;
  // Sort: color (dex order) → stage (adults, then juveniles, then ducklings) →
  // sex (drakes, then hens) → genome quality (best match-to-target first).
  const colorRank = (d: Duck) => COLORS.indexOf(phenotype(d.genotype));
  const sexRank: Record<Duck['sex'], number> = { drake: 0, hen: 1 };
  const ducks = [...state.ducks].sort(
    (a, b) =>
      colorRank(a) - colorRank(b) ||
      stageRank[a.stage] - stageRank[b.stage] ||
      sexRank[a.sex] - sexRank[b.sex] ||
      targetMatch(b.genome, target) - targetMatch(a.genome, target),
  );
  const cap = coopCapacity(state);
  const slotsTotal = secureCapacity(state);
  const slotsUsed = state.ducks.filter((d) => d.secured).length;
  const treatCost = BALANCE.PREDATORS.TREAT_COST_EGGS;

  // Tab the flock by color. Counts per color drive the tab badges; open on the
  // color you have the most of. The sorted `ducks` filtered to a color is already
  // in stage → sex → vigor order.
  const colorCounts: Record<Color, number> = { black: 0, blue: 0, splash: 0 };
  for (const d of state.ducks) colorCounts[phenotype(d.genotype)]++;
  const [colorTab, setColorTab] = useState<Color>(
    () => [...COLORS].sort((a, b) => colorCounts[b] - colorCounts[a])[0] ?? 'blue',
  );
  // Cross-cutting filters (compose with the color tab): sex and life stage.
  const [sexFilter, setSexFilter] = useState<'all' | Duck['sex']>('all');
  const [stageFilter, setStageFilter] = useState<'all' | Duck['stage']>('all');
  // Bulk-release cutoff: release READ ducks whose match-to-target is below this
  // (an unread duck is never bulk-culled — you can't judge a "?"). Defaults to
  // half the slots. Two-click confirm via armedBulk.
  const SLOTS = target.length;
  const [cullQuality, setCullQuality] = useState<number>(Math.ceil(SLOTS / 2));
  const [armedBulk, setArmedBulk] = useState(false);
  const shown = ducks.filter(
    (d) =>
      phenotype(d.genotype) === colorTab &&
      (sexFilter === 'all' || d.sex === sexFilter) &&
      (stageFilter === 'all' || d.stage === stageFilter),
  );
  // Faceted counts: each filter row's badges reflect the OTHER active filter (and
  // the color tab), so the badge on the selected option always equals the number
  // of rows shown.
  const inColor = ducks.filter((d) => phenotype(d.genotype) === colorTab);
  const matchesSex = (d: Duck) => sexFilter === 'all' || d.sex === sexFilter;
  const matchesStage = (d: Duck) => stageFilter === 'all' || d.stage === stageFilter;
  const sexPool = inColor.filter(matchesStage); // counts for the sex row
  const stagePool = inColor.filter(matchesSex); // counts for the stage row
  const sexCount = (s: Duck['sex']) => sexPool.filter((d) => d.sex === s).length;
  const stageCount = (s: Duck['stage']) => stagePool.filter((d) => d.stage === s).length;

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

        {state.ducks.length > 0 && <Breeding engine={engine} state={state} />}

        {state.ducks.length === 0 ? (
          <div className="py-6 text-center text-sm text-[#9a8a6a]">
            No ducks yet — build a Coop to house your starting flock.
          </div>
        ) : (
          <>
            {/* Color tabs — also the dex: undiscovered colors read dimmed. */}
            <div className="mb-2 flex gap-1">
              {COLORS.map((c) => {
                const active = c === colorTab;
                const seen = state.dexSeen.includes(c);
                return (
                  <button
                    key={c}
                    onClick={() => setColorTab(c)}
                    title={seen ? `${COLOR_META[c].label} — ${colorCounts[c]} in flock` : `${COLOR_META[c].label} — not yet bred`}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold transition ${
                      active ? 'bg-[#3a2e22] ring-1 ring-[#5a4a32]' : 'bg-[#1f1812] hover:bg-[#33271c]'
                    } ${seen ? '' : 'opacity-45'}`}
                  >
                    <ColorSwatch color={c} size={11} />
                    <span className={active ? 'text-[#f5ecd8]' : 'text-[#9a8a6a]'}>{COLOR_META[c].label}</span>
                    <span className="tabular-nums text-[#7a6a4a]">{colorCounts[c]}</span>
                  </button>
                );
              })}
            </div>

            {/* Cross-cutting filters: sex and life stage (compose with the color tab). */}
            <div className="mb-2 flex flex-col gap-1">
              <FilterRow
                value={sexFilter}
                onChange={setSexFilter}
                options={[
                  { value: 'all', label: 'All', count: sexPool.length },
                  { value: 'drake', label: 'Drakes', count: sexCount('drake') },
                  { value: 'hen', label: 'Hens', count: sexCount('hen') },
                ]}
              />
              <FilterRow
                value={stageFilter}
                onChange={setStageFilter}
                options={[
                  { value: 'all', label: 'All', count: stagePool.length },
                  { value: 'adult', label: 'Adult', count: stageCount('adult') },
                  { value: 'juvenile', label: 'Juv', count: stageCount('juvenile') },
                  { value: 'duckling', label: 'Duckling', count: stageCount('duckling') },
                ]}
              />
            </div>

            {/* Bulk release: cull the SHOWN set (current filters) whose match-to-
                target is below the cutoff, in one sweep. Only READ ducks are
                eligible (an unread "?" can't be judged). Protects secured (prize)
                + paired (in-use) birds — use the per-row release for those. */}
            {shown.length > 0 && (() => {
              const isPaired = (id: string) =>
                state.breedingPairs.some((p) => p.drakeId === id || p.henId === id);
              const eligible = shown.filter(
                (d) =>
                  !d.secured &&
                  !isPaired(d.id) &&
                  d.genomeKnown &&
                  targetMatch(d.genome, target) < cullQuality,
              );
              const n = eligible.length;
              const step = (delta: number) =>
                setCullQuality((v) => Math.max(0, Math.min(SLOTS, v + delta)));
              return (
                <div className="mb-2 rounded-md bg-[#1f1812] px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-[#9a8a6a]">Release read under</span>
                    <button
                      onClick={() => step(-1)}
                      className="rounded bg-[#2a2018] px-1.5 py-0.5 text-sm font-bold leading-none text-[#c9b88f] hover:bg-[#33271c]"
                      aria-label="Lower cutoff"
                    >
                      −
                    </button>
                    <span className="w-11 text-center tabular-nums text-xs font-bold text-[#ffe9a8]">
                      {cullQuality}/{SLOTS}
                    </span>
                    <button
                      onClick={() => step(1)}
                      className="rounded bg-[#2a2018] px-1.5 py-0.5 text-sm font-bold leading-none text-[#c9b88f] hover:bg-[#33271c]"
                      aria-label="Raise cutoff"
                    >
                      +
                    </button>
                    <button
                      onClick={() => {
                        if (n === 0) return;
                        if (!armedBulk) {
                          setArmedBulk(true);
                          window.setTimeout(() => setArmedBulk(false), 2500);
                          return;
                        }
                        engine.cullMany(eligible.map((d) => d.id));
                        setArmedBulk(false);
                      }}
                      disabled={n === 0}
                      className={`ml-auto rounded px-2 py-1 text-[10px] font-bold transition ${
                        n === 0
                          ? 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
                          : armedBulk
                            ? 'bg-[#d95f5f] text-[#fff4d6]'
                            : 'bg-[#3a2418] text-[#e8a35a] hover:bg-[#4a3020]'
                      }`}
                    >
                      {n === 0 ? 'none below' : armedBulk ? `Release ${n}? · sure` : `Release ${n}`}
                    </button>
                  </div>
                  <div className="mt-1 text-[9px] text-[#7a6a4a]">
                    matches the {target.map((g) => g).join('')} target · keeps secured + paired birds
                  </div>
                </div>
              );
            })()}

            {shown.length === 0 ? (
              <div className="py-6 text-center text-sm text-[#9a8a6a]">
                {inColor.length === 0
                  ? `No ${COLOR_META[colorTab].label.toLowerCase()} ducks yet.`
                  : 'No ducks match these filters.'}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {shown.map((d) => {
                  const canSecure = d.secured || slotsUsed < slotsTotal;
                  return (
                    <div
                      key={d.id}
                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] ${
                        d.wounded ? 'bg-[#2a1818] ring-1 ring-[#5a2a2a]' : 'bg-[#1f1812]'
                      }`}
                    >
                      <span className="w-9 text-[#c9b88f]">{d.sex}</span>
                      <span className="w-16 text-[#9a8a6a]">
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
                      {d.wounded && (
                        <span
                          className="inline-flex items-center"
                          title={`Wounded — ${Math.ceil(
                            Math.max(
                              0,
                              BALANCE.PREDATORS.WOUND_ESCALATE_SEC * waterWoundMult(state) -
                                (d.woundElapsed ?? 0),
                            ),
                          )}s to escalate. Treat to save.`}
                        >
                          <WoundIcon size={11} />
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-1.5">
                        <GenomeTiles duck={d} target={target} size={13} />
                        <span
                          className="tabular-nums text-[#ffe9a8]"
                          title={d.genomeKnown ? `${targetMatch(d.genome, target)} of ${target.length} slots match the target` : 'Unread genome'}
                        >
                          {qualityLabel(d, target)}
                        </span>
                      </span>
                      {d.wounded && (
                        <button
                          onClick={() => {
                            if (engine.treat(d.id).ok) playTend();
                          }}
                          disabled={state.resources.eggs < treatCost}
                          className={`inline-flex items-center rounded px-1 py-0.5 ${
                            state.resources.eggs >= treatCost
                              ? 'text-[#8fe388] hover:bg-[#33271c]'
                              : 'cursor-not-allowed text-[#5a4d3a]'
                          }`}
                          title={`Treat (${treatCost} eggs) — heal this wound before it’s permanent`}
                        >
                          <HealIcon size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => engine.setSecured(d.id, !d.secured)}
                        disabled={!canSecure}
                        className={`inline-flex items-center rounded px-1 py-0.5 ${
                          d.secured
                            ? 'text-[#8fc8e8]'
                            : canSecure
                              ? 'text-[#5a6a7a] hover:bg-[#33271c] hover:text-[#8fc8e8]'
                              : 'cursor-not-allowed text-[#3a4048]'
                        }`}
                        title={
                          d.secured
                            ? 'Secured — excluded from predator attacks. Click to release the slot.'
                            : canSecure
                              ? 'Secure this duck (a Secure Coop slot) — excludes it from attacks'
                              : 'No secure slots free — build a Secure Coop in The Watch'
                        }
                      >
                        <ShieldIcon size={12} />
                      </button>
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
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          armedCull === d.id
                            ? 'bg-[#d95f5f] text-[#fff4d6]'
                            : 'text-[#7a5a5a] hover:bg-[#33271c] hover:text-[#b06a6a]'
                        }`}
                        title="Release this duck (frees housing, raises the flock's mean genome quality)"
                      >
                        {armedCull === d.id ? 'sure?' : 'release'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
