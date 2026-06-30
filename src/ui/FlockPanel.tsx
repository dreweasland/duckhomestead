import { useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { axisTier, colorOdds, goodGeneCount, PHENO_AXES, slotOdds, targetMatch, type PhenoAxis } from '../game/genetics';
import { COLORS, coopCapacity, flockRatio, phenotype, secureCapacity, type Color, type Duck, type Gene, type GameState } from '../game/state';
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

// ── Phenotype band: the free, always-visible coarse read (no reader needed) ──
const AXIS_META: Record<PhenoAxis, { label: string; abbr: string; color: string }> = {
  lay: { label: 'Lay', abbr: 'Lay', color: '#8fe388' },
  vigor: { label: 'Vigor', abbr: 'Vig', color: '#e8c45a' },
  hardy: { label: 'Hardy', abbr: 'Hdy', color: '#7fb8e8' },
};
const TIER_WORDS = ['poor', 'weak', 'fair', 'strong', 'elite'];
function tierWord(tier: number): string {
  return BALANCE.PHENOTYPE.TIERS === 5 ? (TIER_WORDS[tier] ?? `${tier}`) : `${tier + 1}/${BALANCE.PHENOTYPE.TIERS}`;
}

/**
 * Three stacked micro-bars (Lay / Vigor / Hardy) showing each axis's COARSE
 * intrinsic tier. Free and visible for every duck, read or not — the phone-it-in
 * floor. Never shows exact genes (that's GenomeTiles, reader-gated).
 */
function PhenoBands({ genome, width = 22 }: { genome: Gene[]; width?: number }) {
  const tiers = BALANCE.PHENOTYPE.TIERS;
  const title = PHENO_AXES.map((a) => `${AXIS_META[a].label}: ${tierWord(axisTier(genome, a))}`).join(' · ');
  return (
    <span className="inline-flex flex-col justify-center gap-[1.5px]" title={title}>
      {PHENO_AXES.map((a) => {
        const t = axisTier(genome, a);
        const frac = tiers > 1 ? t / (tiers - 1) : 0;
        return (
          <span key={a} className="block rounded-[1px]" style={{ width, height: 3, background: '#2a2018' }}>
            <span className="block h-full rounded-[1px]" style={{ width: `${frac * 100}%`, background: AXIS_META[a].color }} />
          </span>
        );
      })}
    </span>
  );
}


const GENE_ORDER: Gene[] = ['L', 'V', 'H', 'D'];

/** Flock-browser sort keys. `match`/`good` read the EXACT genome (reader-gated);
 *  the band sorts (`lay`/`vigor`/`hardy`) read the free coarse tier, so they work
 *  on unread ducks too — the pre-reader selection tool. `new` reads the id. */
type SortKey = 'match' | 'good' | 'lay' | 'vigor' | 'hardy' | 'new';
const SORT_LABEL: Record<SortKey, string> = {
  lay: 'Lay band',
  vigor: 'Vigor band',
  hardy: 'Hardy band',
  match: 'Target match',
  good: 'Good genes',
  new: 'Newest',
};
/** Numeric tail of a duck id (e.g. "d12" → 12) for the "Newest" sort. */
const idNum = (d: Duck): number => parseInt(d.id.replace(/^\D+/, ''), 10) || 0;

/**
 * The in-game crossbreed calculator: a 4×N grid of per-slot offspring gene odds
 * for a selected pair. Rows are genes (L/V/H/D), columns are genome slots; each
 * cell is the probability that slot lands that gene, shaded by likelihood. A
 * slot's target gene is ringed so you can read progress-to-target at a glance.
 */
function OddsPreview({ a, b, target }: { a: Duck; b: Duck; target: Gene[] }) {
  if (!a.genomeKnown || !b.genomeKnown) {
    return (
      <div className="mt-1 text-[10px] text-[#7a6a4a]">
        Build a Gene Reader to preview this cross’s gene odds.
      </div>
    );
  }
  const odds = slotOdds(a.genome, b.genome);
  return (
    <div className="mt-1.5">
      <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-[#7a6a4a]">
        Offspring odds (per slot)
      </div>
      <div className="flex flex-col gap-0.5">
        {GENE_ORDER.map((gene) => (
          <div key={gene} className="flex items-center gap-0.5">
            <span className="w-7 text-[9px] font-bold" style={{ color: GENE_META[gene].color }}>
              {gene}
            </span>
            {odds.map((dist, i) => {
              const p = dist[gene];
              const isTarget = target[i] === gene;
              return (
                <span
                  key={i}
                  className="flex h-4 flex-1 items-center justify-center rounded-[2px] text-[8px] tabular-nums"
                  title={`Slot ${i + 1}: ${Math.round(p * 100)}% ${GENE_META[gene].label}`}
                  style={{
                    background: `color-mix(in srgb, ${GENE_META[gene].color} ${Math.round(p * 100)}%, #171009)`,
                    color: p > 0.5 ? '#171009' : '#9a8a6a',
                    boxShadow: isTarget ? 'inset 0 0 0 1px #ffe9a8' : undefined,
                  }}
                >
                  {p >= 0.005 ? Math.round(p * 100) : ''}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
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

/** Flock Health: the drake:hen ratio and its consequences. An over-drake flock
 *  harasses itself into injury past a size gate; the fix is culling surplus drakes
 *  (one tap here). Always visible so the ratio stays front-of-mind. */
function FlockHealth({ engine, state }: { engine: GameEngine; state: GameState }) {
  const r = flockRatio(state);
  if (r.hens === 0 && r.drakes === 0) return null; // no adults yet — nothing to balance
  const minFlock = BALANCE.BREEDING.OVERCROWD_MIN_FLOCK;
  const color = r.injuring ? '#e8835a' : r.gated ? '#8fe388' : '#9a8a6a';
  const status = r.injuring
    ? `Over-drake — ${r.excess} excess`
    : r.gated
      ? 'Healthy ratio'
      : `OK · ratio matters at ${minFlock}+`;
  // Bar: current drakes vs the healthy max (ideal = full bar; over = red overflow).
  const fill = Math.min(1, r.drakes / Math.max(1, r.maxHealthyDrakes));
  return (
    <div className={`mb-3 rounded-md px-3 py-2 ${r.injuring ? 'bg-[#2a1818] ring-1 ring-[#5a2a2a]' : 'bg-[#1f1812]'}`}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">Flock health</span>
        <span className="text-[11px] font-bold" style={{ color }}>
          {status}
        </span>
      </div>
      <div className="mb-1 flex items-center gap-2 text-[11px] text-[#c9b88f]">
        <span className="tabular-nums">{r.hens} hens · {r.drakes} drakes</span>
        <span className="text-[#7a6a4a]">ideal ≤ {r.maxHealthyDrakes} drake{r.maxHealthyDrakes > 1 ? 's' : ''}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[#0f0b07]">
        <div className="h-full rounded-full" style={{ width: `${fill * 100}%`, background: color }} />
      </div>
      {r.injuring && (
        <>
          <p className="mt-1.5 text-[10px] leading-relaxed text-[#e8a35a]">
            Too many drakes — they fight and over-mate the hens, injuring the flock (wounds escalate if
            untended). Cull surplus drakes to fix the ratio.
          </p>
          <button
            onClick={() => {
              if (engine.cullExcessDrakes().ok) playTend();
            }}
            className="mt-1.5 w-full rounded-md bg-[#5a3a2a] px-3 py-1.5 text-xs font-bold text-[#ffd9a8] transition hover:bg-[#6a4632]"
            title="Release the worst-genome surplus drakes (keeps secured + paired studs)"
          >
            Cull {r.excess} excess drake{r.excess > 1 ? 's' : ''}
          </button>
        </>
      )}
    </div>
  );
}

/** The breeding controls: god-clone target, existing pairs, and a new-pair builder over
 *  the flock list below (selection lives in FlockPanel and is passed in here). */
function Breeding({
  engine,
  state,
  mateDrakeId,
  mateHenId,
  setMateDrakeId,
  setMateHenId,
}: {
  engine: GameEngine;
  state: GameState;
  mateDrakeId: string;
  mateHenId: string;
  setMateDrakeId: (id: string) => void;
  setMateHenId: (id: string) => void;
}) {
  const B = BALANCE.BREEDING;
  const target = state.genomeTarget;
  const paired = (id: string) => state.breedingPairs.some((p) => p.drakeId === id || p.henId === id);
  const byId = (id: string) => state.ducks.find((d) => d.id === id);

  // Pair cards collapse by default (just identity + clutch timer) so multiple pairs
  // stay compact; tap one to reveal its colour odds + crossbreed preview.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const readerCost = BALANCE.GENOME.READER_COST_EGGS;
  return (
    <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">Breeding</span>
        {state.geneReader ? (
          <span className="rounded bg-[#1a2a1a] px-1.5 py-0.5 text-[9px] font-bold text-[#8fe388]" title="Genomes are read automatically for the whole flock and every new duck.">
            Gene Reader active
          </span>
        ) : (
          <button
            onClick={() => {
              if (engine.buildGeneReader().ok) playPlace();
            }}
            disabled={state.resources.eggs < readerCost}
            title={`Reveal every duck's hidden genome — now and on every future hatch (${readerCost} eggs)`}
            className={`rounded px-1.5 py-0.5 text-[9px] font-bold transition ${
              state.resources.eggs >= readerCost
                ? 'bg-[#3a2e22] text-[#ffe9a8] hover:bg-[#4a3a2a]'
                : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
            }`}
          >
            Build Gene Reader · {readerCost}
          </button>
        )}
      </div>

      {/* God-clone target: the profile the flock is steered toward. Click a slot
          to cycle its gene; readout shows best-match + how many god clones exist. */}
      {(() => {
        const SLOTS = target.length;
        const best = state.ducks.reduce((m, d) => Math.max(m, targetMatch(d.genome, target)), 0);
        const clones = state.ducks.filter((d) => targetMatch(d.genome, target) === SLOTS).length;
        const cycle = (i: number) => {
          const next = [...target];
          next[i] = GENE_ORDER[(GENE_ORDER.indexOf(target[i]) + 1) % GENE_ORDER.length];
          engine.setGenomeTarget(next);
        };
        return (
          <div className="mb-1.5 flex items-center gap-1.5 rounded bg-[#171009] px-2 py-1.5">
            <span className="text-[9px] font-bold uppercase tracking-wider text-[#7a6a4a]">Target</span>
            <span className="inline-flex gap-0.5">
              {target.map((g, i) => (
                <button
                  key={i}
                  onClick={() => cycle(i)}
                  title={`Slot ${i + 1}: ${GENE_META[g].label} — click to cycle`}
                  className="inline-flex items-center justify-center rounded-[2px] font-bold leading-none hover:ring-1 hover:ring-[#ffe9a8]"
                  style={{ width: 16, height: 16, fontSize: 10, background: GENE_META[g].color, color: '#171009' }}
                >
                  {g}
                </button>
              ))}
            </span>
            <span className="ml-auto text-[10px] text-[#9a8a6a]" title="Best match in the flock toward the target">
              best <span className="tabular-nums text-[#ffe9a8]">{best}/{SLOTS}</span>
              {clones > 0 && (
                <span className="ml-1 text-[#8fe388]">· {clones} god clone{clones > 1 ? 's' : ''}</span>
              )}
            </span>
          </div>
        );
      })()}

      {state.breedingPairs.map((p) => {
        const dr = byId(p.drakeId);
        const he = byId(p.henId);
        if (!dr || !he) return null;
        const next = Math.max(0, B.CLUTCH_INTERVAL_S - p.clutchProgress);
        const soonest = p.incubating.length ? Math.max(0, B.INCUBATE_S - Math.max(...p.incubating)) : 0;
        const odds = colorOdds(dr.genotype, he.genotype);
        const isOpen = expanded.has(p.id);
        return (
          <div key={p.id} className="mb-1.5 rounded bg-[#171009] px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              <button
                onClick={() => toggle(p.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:opacity-90"
                title={isOpen ? 'Collapse this pair' : 'Show colour odds + crossbreed preview'}
              >
                <span className="w-2 shrink-0 text-[#7a6a4a]">{isOpen ? '▾' : '▸'}</span>
                <ColorSwatch color={phenotype(dr.genotype)} size={11} />
                <PhenoBands genome={dr.genome} width={16} />
                <GenomeTiles duck={dr} target={target} size={12} />
                <span className="text-[#5a4d3a]">·</span>
                <ColorSwatch color={phenotype(he.genotype)} size={11} />
                <PhenoBands genome={he.genome} width={16} />
                <GenomeTiles duck={he} target={target} size={12} />
              </button>
              <button
                onClick={() => engine.unpair(p.id)}
                className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-[#b06a6a] hover:bg-[#33271c]"
              >
                unpair
              </button>
            </div>
            <div className="mt-0.5 text-[10px] text-[#9a8a6a]">
              clutch {Math.ceil(next)}s
              {p.incubating.length > 0 && ` · ${p.incubating.length} incubating (hatch ${Math.ceil(soonest)}s)`}
            </div>
            {isOpen && (
              <>
                <div className="mt-1 flex items-center gap-1.5 text-[10px] text-[#7a6a4a]">
                  {COLORS.filter((c) => odds[c] > 0).map((c) => (
                    <span key={c} className="flex items-center gap-0.5" title={`${COLOR_META[c].label} offspring`}>
                      <ColorSwatch color={c} size={9} />
                      <span className="tabular-nums text-[#9a8a6a]">{Math.round(odds[c] * 100)}%</span>
                    </span>
                  ))}
                </div>
                <OddsPreview a={dr} b={he} target={target} />
              </>
            )}
          </div>
        );
      })}
      {/* New-pair builder: drake + hen are chosen by tapping rows in the flock
          list below. A slot shows the picked duck (with a clear ×) or a prompt. */}
      {(() => {
        const dr = byId(mateDrakeId);
        const he = byId(mateHenId);
        const slot = (label: string, duck: Duck | undefined, clear: () => void) => (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded bg-[#2a2018] px-2 py-1.5">
            {duck ? (
              <>
                <ColorSwatch color={phenotype(duck.genotype)} size={11} />
                <PhenoBands genome={duck.genome} width={16} />
                <GenomeTiles duck={duck} target={target} size={11} />
                <button
                  onClick={clear}
                  className="ml-auto rounded px-1 text-[12px] leading-none text-[#9a8a6a] hover:bg-[#33271c] hover:text-[#e0c98a]"
                  title="Clear this pick"
                >
                  ×
                </button>
              </>
            ) : (
              <span className="text-[10px] text-[#7a6a4a]">tap a {label} below</span>
            )}
          </div>
        );
        // Pure validity check (must mirror createPair's guards — never call
        // engine.pair to test, it would actually create the pair).
        const eligible = (d: Duck | undefined, sex: Duck['sex']) =>
          !!d && d.sex === sex && d.stage === 'adult' && !paired(d.id);
        const canPair = eligible(dr, 'drake') && eligible(he, 'hen');
        return (
          <div className="mt-1.5">
            <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-[#7a6a4a]">
              New pair
            </div>
            <div className="flex items-center gap-1.5">
              {slot('drake', dr, () => setMateDrakeId(''))}
              {slot('hen', he, () => setMateHenId(''))}
              <button
                onClick={() => {
                  if (engine.pair(mateDrakeId, mateHenId).ok) {
                    playPlace();
                    setMateDrakeId('');
                    setMateHenId('');
                  }
                }}
                disabled={!canPair}
                title={canPair ? 'Start this breeding pair' : 'Pick an unpaired adult drake and hen from the list'}
                className={`rounded px-3 py-2 text-[11px] font-bold ${
                  canPair
                    ? 'bg-[#6b4f9e] text-[#fff4d6] hover:bg-[#7a5cae]'
                    : 'cursor-not-allowed bg-[#2a2018] text-[#6a5a3a]'
                }`}
              >
                Pair
              </button>
            </div>
            {/* Crossbreed-odds preview for the candidate pair (the in-game calculator). */}
            {dr && he && (
              <div className="mt-1.5 rounded bg-[#171009] px-2 py-1.5">
                <OddsPreview a={dr} b={he} target={target} />
              </div>
            )}
          </div>
        );
      })()}
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
  // New-pair selection: drake + hen are picked by tapping rows in the list below.
  const [mateDrakeId, setMateDrakeId] = useState('');
  const [mateHenId, setMateHenId] = useState('');
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

  // Tab the flock by color. Counts per color drive the tab badges; open on All so
  // the whole flock is in view up front (matching the sex/stage filters, which
  // also default to All). The sorted `ducks` filtered to a color is already in
  // stage → sex → vigor order.
  const colorCounts: Record<Color, number> = { black: 0, blue: 0, splash: 0 };
  for (const d of state.ducks) colorCounts[phenotype(d.genotype)]++;
  const [colorTab, setColorTab] = useState<'all' | Color>('all');
  const inTab = (d: Duck) => colorTab === 'all' || phenotype(d.genotype) === colorTab;
  // Cross-cutting filters (compose with the color tab): sex and life stage.
  const [sexFilter, setSexFilter] = useState<'all' | Duck['sex']>('all');
  const [stageFilter, setStageFilter] = useState<'all' | Duck['stage']>('all');
  // Genome browser (the scale tooling): sort by a genome stat, and query for a
  // gene-in-slot. Both read the genome, so they act on READ ducks; an unread
  // duck sinks to the bottom of a genome sort and never matches a gene query.
  const [sortKey, setSortKey] = useState<SortKey>('match');
  const [querySlot, setQuerySlot] = useState<number>(-1); // -1 = any slot
  const [queryGene, setQueryGene] = useState<Gene | 'any'>('any');
  // Bulk-release cutoff: release READ ducks whose match-to-target is below this
  // (an unread duck is never bulk-culled — you can't judge a "?"). Defaults to
  // half the slots. Two-click confirm via armedBulk.
  const SLOTS = target.length;
  const [cullQuality, setCullQuality] = useState<number>(Math.ceil(SLOTS / 2));
  const [armedBulk, setArmedBulk] = useState(false);

  const geneQueryActive = queryGene !== 'any';
  const matchesGeneQuery = (d: Duck): boolean => {
    if (!geneQueryActive) return true;
    if (!d.genomeKnown) return false;
    return querySlot >= 0 ? d.genome[querySlot] === queryGene : d.genome.includes(queryGene);
  };
  const sortStat: Record<SortKey, (d: Duck) => number> = {
    match: (d) => targetMatch(d.genome, target),
    good: (d) => goodGeneCount(d.genome),
    lay: (d) => axisTier(d.genome, 'lay'),
    vigor: (d) => axisTier(d.genome, 'vigor'),
    hardy: (d) => axisTier(d.genome, 'hardy'),
    new: (d) => idNum(d),
  };
  // Only the EXACT-genome sorts (match/good) sink unread ducks — the band sorts
  // read free public info, so they rank read and unread ducks alike.
  const exactSort = sortKey === 'match' || sortKey === 'good';
  const shown = ducks
    .filter(
      (d) =>
        inTab(d) &&
        (sexFilter === 'all' || d.sex === sexFilter) &&
        (stageFilter === 'all' || d.stage === stageFilter) &&
        matchesGeneQuery(d),
    )
    .sort((a, b) => {
      if (exactSort) {
        const ka = a.genomeKnown ? 0 : 1;
        const kb = b.genomeKnown ? 0 : 1;
        if (ka !== kb) return ka - kb;
      }
      return sortStat[sortKey](b) - sortStat[sortKey](a);
    });
  // Faceted counts: each filter row's badges reflect the OTHER active filter (and
  // the color tab), so the badge on the selected option always equals the number
  // of rows shown.
  const inColor = ducks.filter(inTab);
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

        {state.ducks.length > 0 && <FlockHealth engine={engine} state={state} />}

        {state.ducks.length > 0 && (
          <Breeding
            engine={engine}
            state={state}
            mateDrakeId={mateDrakeId}
            mateHenId={mateHenId}
            setMateDrakeId={setMateDrakeId}
            setMateHenId={setMateHenId}
          />
        )}

        {state.ducks.length === 0 ? (
          <div className="py-6 text-center text-sm text-[#9a8a6a]">
            No ducks yet — build a Coop to house your starting flock.
          </div>
        ) : (
          <>
            {/* Color tabs — also the dex: undiscovered colors read dimmed. "All"
                spans the whole flock so the genome sort/query can browse it. */}
            <div className="mb-2 flex gap-1">
              <button
                onClick={() => setColorTab('all')}
                title={`All colours — ${state.ducks.length} in flock`}
                className={`flex items-center justify-center rounded-md px-2 py-1.5 text-xs font-bold transition ${
                  colorTab === 'all' ? 'bg-[#3a2e22] text-[#f5ecd8] ring-1 ring-[#5a4a32]' : 'bg-[#1f1812] text-[#9a8a6a] hover:bg-[#33271c]'
                }`}
              >
                All
              </button>
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

            {/* Genome browser: sort by a genome stat + query for a gene-in-slot —
                the scale tooling for min/maxing hundreds of ducks (no spreadsheet). */}
            <div className="mb-2 flex items-center gap-1.5 rounded-md bg-[#1f1812] px-2.5 py-1.5">
              <span className="text-[10px] text-[#9a8a6a]">Sort</span>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="rounded bg-[#2a2018] px-1.5 py-1 text-[11px] text-[#f5ecd8]"
              >
                {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABEL[k]}
                  </option>
                ))}
              </select>
              <span className="ml-auto text-[10px] text-[#9a8a6a]">Gene</span>
              <select
                value={queryGene}
                onChange={(e) => setQueryGene(e.target.value as Gene | 'any')}
                className="rounded bg-[#2a2018] px-1.5 py-1 text-[11px] text-[#f5ecd8]"
              >
                <option value="any">any</option>
                {GENE_ORDER.map((g) => (
                  <option key={g} value={g}>
                    {g} · {GENE_META[g].label}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-[#9a8a6a]">in</span>
              <select
                value={querySlot}
                onChange={(e) => setQuerySlot(Number(e.target.value))}
                disabled={!geneQueryActive}
                className="rounded bg-[#2a2018] px-1.5 py-1 text-[11px] text-[#f5ecd8] disabled:opacity-40"
              >
                <option value={-1}>any slot</option>
                {Array.from({ length: SLOTS }, (_, i) => (
                  <option key={i} value={i}>
                    slot {i + 1}
                  </option>
                ))}
              </select>
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
                {inColor.length === 0 && colorTab !== 'all'
                  ? `No ${COLOR_META[colorTab].label.toLowerCase()} ducks yet.`
                  : 'No ducks match these filters.'}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {shown.map((d) => {
                  const canSecure = d.secured || slotsUsed < slotsTotal;
                  const isPaired = state.breedingPairs.some((p) => p.drakeId === d.id || p.henId === d.id);
                  const picked = d.id === mateDrakeId || d.id === mateHenId;
                  const canPick = d.stage === 'adult' && !d.wounded && !isPaired;
                  return (
                    <div
                      key={d.id}
                      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] ${
                        picked
                          ? 'bg-[#241d33] ring-1 ring-[#6b4f9e]'
                          : d.wounded
                            ? 'bg-[#2a1818] ring-1 ring-[#5a2a2a]'
                            : 'bg-[#1f1812]'
                      }`}
                    >
                      <ColorSwatch color={phenotype(d.genotype)} size={10} />
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
                        <PhenoBands genome={d.genome} />
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
                      {isPaired ? (
                        <span className="rounded px-1 py-0.5 text-[10px] font-bold text-[#9a86c0]" title="Already in a breeding pair">
                          paired
                        </span>
                      ) : canPick ? (
                        <button
                          onClick={() => {
                            if (d.sex === 'drake') setMateDrakeId(picked ? '' : d.id);
                            else setMateHenId(picked ? '' : d.id);
                          }}
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition ${
                            picked
                              ? 'bg-[#6b4f9e] text-[#fff4d6]'
                              : 'text-[#9a86c0] hover:bg-[#33271c] hover:text-[#b9a6e0]'
                          }`}
                          title={picked ? 'Picked for a new pair — tap to unpick' : `Pick this ${d.sex} for a new breeding pair`}
                        >
                          {picked ? 'picked' : 'breed'}
                        </button>
                      ) : null}
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
