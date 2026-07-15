import { memo, useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { axisTier, colorOdds, goodGeneCount, kinship, PHENO_AXES, slotMatches, slotOdds, targetMatch, type PhenoAxis } from '../game/genetics';
import { clutchCost } from '../game/breeding';
import { targetForTier } from '../game/prestige';
import { COLORS, coopCapacity, flockRatio, watererSupport, infirmaryCapacity, infirmaryOccupied, phenotype, secureCapacity, winterCapacity, zoneUnlocked, type Color, type Duck, type Gene, type GameState, type PostId } from '../game/state';
import { broodyMatureMult, forageRates, POST_META, postCapacity, postedDucks, postsUnlocked, sentryRepelChance, sentryWindupMult } from '../game/posts';
import { waterWoundMult } from '../game/water';
import { playPlace, playTend } from '../audio/sfx';
import { CloseIcon, DuckIcon, HealIcon, PencilIcon, ShieldIcon, SnowflakeIcon, WoundIcon } from './icons';

const DuckRowIcon = () => <DuckIcon size={11} />;
import { useEscapeKey } from './useEscapeKey';
import { usePersistentState } from './usePersistentState';

// In-progress mate picks survive a close/reopen (check the board mid-pick
// without losing the drake you chose) but reset on reload — workflow state,
// not a preference, so it lives in module memory rather than storage.
let heldMateDrakeId = '';
let heldMateHenId = '';

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
  // Phase 6c: the Prime wildcard. Violet — the legacy/prestige color family
  // (Prime IS legacy-tier content), and unmistakably not an axis color. (The
  // original "distinct pixel-gold" read as Vigor's twin at tile size.)
  P: { label: 'Prime', color: '#c9a6ff' },
};

/**
 * The 6-slot genome as a strip of gene tiles. Hidden ("?") until the duck's
 * genome has been read; a slot matching the Standard gets a ring.
 */
export function GenomeTiles({
  duck,
  target,
  size = 14,
}: {
  /** Only the genome fields are read — a Peddler OFFER previews with the
   *  same tiles a flock row uses (9e). */
  duck: Pick<Duck, 'genome' | 'genomeKnown'>;
  target?: Gene[];
  size?: number;
}) {
  const known = !!duck.genomeKnown;
  return (
    <span className="inline-flex gap-0.5">
      {duck.genome.map((g, i) => {
        // The ONE match rule (slotMatches): Prime is a wildcard, so a P gene
        // lights the target ring like any landed slot — same as the gate counts it.
        const hit = known && target && slotMatches(g, target[i]);
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
export function PhenoBands({ genome, width = 22 }: { genome: Gene[]; width?: number }) {
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
 *  on unread ducks too — the pre-reader selection tool. `new` reads the id.
 *  `kin` (9b tooling) reads PUBLIC lineage: least related first (cleanest
 *  outcross on top), measured against the picked mate or, with none picked,
 *  your current breeding pairs. */
type SortKey = 'match' | 'good' | 'prime' | 'kin' | 'lay' | 'vigor' | 'hardy' | 'new';
const SORT_LABEL: Record<SortKey, string> = {
  lay: 'Lay band',
  vigor: 'Vigor band',
  hardy: 'Hardy band',
  match: 'Target match',
  good: 'Good genes',
  prime: 'Prime genes',
  kin: 'Outcross (kin)',
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
function OddsPreview({ a, b, target, primeEligible }: { a: Duck; b: Duck; target: Gene[]; primeEligible: boolean }) {
  // Phase 9b: kinship shows even when genomes are hidden — lineage is public
  // knowledge (you watched them hatch), only the genes need a reader.
  const kin = kinship(a, b);
  const kinWarn = kin >= BALANCE.GENOME.KINSHIP.WARN_AT && (
    <div
      className="mt-1 rounded bg-[#3a2218] px-2 py-1 text-[10px] font-bold text-[#e8a35a]"
      title="Inbreeding depression: a close-kin cross degrades offspring genes toward Dud. Pair from an unrelated line — your posted lines make good outcross stock."
    >
      CLOSE KIN — offspring slots degrade to Dud {Math.round(kin * BALANCE.GENOME.KINSHIP.DUD_CHANCE * 100)}% of
      the time
    </div>
  );
  if (!a.genomeKnown || !b.genomeKnown) {
    return (
      <div className="mt-1 text-[10px] text-[#7a6a4a]">
        Build a Gene Reader to preview this cross’s gene odds.
        {kinWarn}
      </div>
    );
  }
  const odds = slotOdds(a.genome, b.genome, primeEligible, kin);
  // Prime (Phase 6c) only ever shows a row once the cross is eligible to roll it
  // (tier-gated) — an ineligible cross has genuinely zero chance of it.
  const rows = primeEligible ? [...GENE_ORDER, 'P' as Gene] : GENE_ORDER;
  return (
    <div className="mt-1.5">
      <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-[#7a6a4a]">
        Offspring odds (per slot)
      </div>
      {kinWarn}
      <div className="flex flex-col gap-0.5">
        {rows.map((gene) => (
          <div key={gene} className="flex items-center gap-0.5">
            <span className="w-7 text-[9px] font-bold" style={{ color: GENE_META[gene].color }}>
              {gene}
            </span>
            {odds.map((dist, i) => {
              const p = dist[gene];
              // A Prime cell is ALWAYS a target-slot match (the wildcard) — ring it
              // like any other landed slot, mirroring targetMatch/slotMatches.
              const isTarget = slotMatches(gene, target[i]);
              return (
                <span
                  key={i}
                  className="flex h-4 flex-1 items-center justify-center rounded-[2px] text-[8px] tabular-nums"
                  title={`Slot ${i + 1}: ${p > 0 && p < 0.01 ? '<1' : Math.round(p * 100)}% ${GENE_META[gene].label}`}
                  style={{
                    // A possible-but-rare outcome keeps a faint visible tint —
                    // mutation odds (~0.5%/gene, Prime ~0.1%) must never read as
                    // literally impossible.
                    background: `color-mix(in srgb, ${GENE_META[gene].color} ${p > 0 ? Math.max(4, Math.round(p * 100)) : 0}%, #171009)`,
                    // Contrast flips with the fill: bright cells (heavy gene tint)
                    // take dark ink; dim cells take bright cream — never dim-on-dark.
                    color: p > 0.45 ? '#171009' : '#f5ecd8',
                    boxShadow: isTarget ? 'inset 0 0 0 1px #ffe9a8' : undefined,
                  }}
                >
                  {p === 0 ? '' : p < 0.01 ? '<1' : Math.round(p * 100)}
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
/**
 * Phase 9a: the POSTS roster — occupancy, live effect readouts, and recall.
 * Assignment happens on the duck rows (the "post" cycle button); this card is
 * where the portfolio reads as a whole: what the watch, the forage line, and
 * the hatchery are earning right now.
 */
function PostsCard({ engine, state }: { engine: GameEngine; state: GameState }) {
  const [help, setHelp] = useState(false);
  const rates = forageRates(state);
  // Which read each post cares about, in the same color as the phenotype pips
  // — the zero-click link between "post" and "band" (playtest, 2026-07-11).
  const axisChip = (id: PostId): { label: string; color: string } =>
    id === 'show'
      ? { label: 'Standard', color: '#ffe9a8' }
      : { label: AXIS_META[POST_META[id].axis].label, color: AXIS_META[POST_META[id].axis].color };
  const rows: { id: PostId; effect: string }[] = [
    {
      id: 'sentry',
      effect: `dives ${Math.round((sentryWindupMult(state) - 1) * 100)}% slower · repels ${Math.round(
        sentryRepelChance(state) * 100,
      )}% on watch`,
    },
    {
      id: 'forager',
      effect: `+${(rates.peas * 60).toFixed(1)} peas · +${(rates.mealworms * 60).toFixed(1)} mealworms /min`,
    },
    { id: 'broody', effect: `grow-out ×${broodyMatureMult(state).toFixed(2)}` },
    // 9d: the show bench only exists once the Grange runs exhibitions.
    ...(state.legacyTier >= BALANCE.CONTRACTS.UNLOCK_TIER
      ? [{ id: 'show' as PostId, effect: 'the exhibition bench — judged by Grange contracts' }]
      : []),
  ];
  return (
    <div className="mb-3 rounded-md bg-[#1f1812] px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a]">Posts</span>
        <button
          onClick={() => setHelp(true)}
          className="inline-flex items-center gap-1 rounded-full bg-[#241c14] px-2 py-0.5 text-[9px] font-bold text-[#c9b88f] ring-1 ring-[#3a2e22] hover:bg-[#2e2318]"
          aria-label="Which genes work which posts?"
        >
          <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-[#3a2e22] text-[9px] text-[#ffe9a8]">?</span>
          which genes?
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((r) => {
          const occupants = postedDucks(state, r.id);
          const healing = occupants.filter((d) => d.wounded || d.recovering).length;
          return (
            <div key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
              <span className="w-14 shrink-0 font-bold text-[#c9b88f]">{POST_META[r.id].label}</span>
              <span
                className="rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide"
                style={{ color: axisChip(r.id).color, background: '#171009' }}
                title={
                  r.id === 'show'
                    ? 'Judged against the tier Standard (Prime wildcards always match) + flock condition'
                    : `Reads the ${axisChip(r.id).label} band — the free pips every duck shows`
                }
              >
                {axisChip(r.id).label}
              </span>
              <span className="tabular-nums text-[#9a8a6a]">
                {occupants.length}/{postCapacity(r.id)}
              </span>
              <span className="text-[10px] text-[#8fb8a0]">
                {occupants.length > 0 ? r.effect : POST_META[r.id].blurb}
              </span>
              {healing > 0 && (
                <span className="text-[10px] text-[#e8c45a]">
                  ({healing} healing — not working)
                </span>
              )}
              {occupants.map((d) => (
                <button
                  key={d.id}
                  onClick={() => engine.recallFromPost(d.id)}
                  className="rounded bg-[#2a2018] px-1 py-0.5 text-[9px] text-[#9a8a6a] hover:text-[#e8835a]"
                  title={`Recall ${d.name ?? d.id} to the laying/breeding flock`}
                >
                  {d.name ?? d.id} ×
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {help && <PostsHelp state={state} onClose={() => setHelp(false)} />}
    </div>
  );
}

/** The posts reference sheet (the WaterHelp pattern): which genes work which
 *  post, with the real numbers — a reference, not a tutorial (the Almanac
 *  page teaches the concept once; this answers "who do I assign?"). */
function PostsHelp({ state, onClose }: { state: GameState; onClose: () => void }) {
  const P = BALANCE.POSTS;
  const gene = (g: Gene) => (
    <span className="font-bold" style={{ color: GENE_META[g].color }}>
      {GENE_META[g].label} ({g})
    </span>
  );
  const showOpen = state.legacyTier >= BALANCE.CONTRACTS.UNLOCK_TIER;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-h-[88vh] sm:rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Who works which post?</h2>
          <button onClick={onClose} className="rounded p-1.5 text-[#9a8a6a] hover:bg-[#1f1812] hover:text-[#f5ecd8]" aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </div>
        <p className="mb-3 text-xs text-[#9a8a6a]">
          Each post reads ONE band — the free Lay/Vigor/Hardy pips every duck shows, no gene reader
          needed. Scores add per gene, so a half-{GENE_META.H.label} duck does half the work.
        </p>
        <div className="flex flex-col gap-2.5 text-xs text-[#c9b88f]">
          <div className="rounded-md bg-[#1f1812] px-3 py-2">
            <div className="font-bold text-[#f5ecd8]">Sentry — wants {gene('H')}</div>
            Stretches every dive’s wind-up (up to +{Math.round(P.SENTRY.WINDUP_CAP * 100)}% with two
            full-Hardy sentries) and repels attacks outright at guard/away. Prime counts as half a
            Hardy here.
          </div>
          <div className="rounded-md bg-[#1f1812] px-3 py-2">
            <div className="font-bold text-[#f5ecd8]">Forager — wants {gene('V')}</div>
            Gathers peas + mealworms into storage. Output is {Math.round(P.FORAGER.SCORE_FLOOR * 100)}%
            floor + the rest by Vigor — a full-Vigor forager gathers{' '}
            {(1 / P.FORAGER.SCORE_FLOOR).toFixed(1)}× what a dud does.
          </div>
          <div className="rounded-md bg-[#1f1812] px-3 py-2">
            <div className="font-bold text-[#f5ecd8]">Broody — wants {gene('V')}</div>
            Speeds every duckling’s grow-out, up to ×{(1 + P.BROODY.MATURE_PER_SCORE).toFixed(1)} at a
            full-Vigor hen. Stacks with the duckling ration and Husbandry.
          </div>
          {showOpen && (
            <div className="rounded-md bg-[#1f1812] px-3 py-2">
              <div className="font-bold text-[#f5ecd8]">Show — wants the Standard</div>
              Exhibitions judge the bench against the tier’s Standard plus flock condition — the asked
              color, in fine feather. {gene('P')} wildcards always count as a match.
            </div>
          )}
        </div>
        <p className="mt-3 text-[10px] text-[#7a6a4a]">
          Posted ducks stop laying and eat the drake maintenance ration — an underfed pool works
          slower (never stops). Wounded workers stand down until healed. Recall is always free.
        </p>
      </div>
    </div>
  );
}

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
  // Ducks currently carrying an overcrowding wound (persist until treated) — the
  // flock-context surfacing of the injuries (treat them in The Watch).
  const injured = state.ducks.filter((d) => d.wounded && d.woundSource === 'overcrowd').length;
  // What "cull excess" can ACTUALLY release — unsecured, unposted, non-paired
  // drakes (the exact keeper set cullExcessDrakes skips) — capped at the excess.
  // Paired/secured/posted studs are kept, so this can be < excess.
  const pairedIds = new Set(state.breedingPairs.flatMap((p) => [p.drakeId, p.henId]));
  const cullable = Math.min(
    r.excess,
    state.ducks.filter(
      (d) => d.stage === 'adult' && d.sex === 'drake' && !d.secured && !d.post && !pairedIds.has(d.id),
    ).length,
  );
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
      {injured > 0 && (
        <div className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-[#e8a3a3]">
          <WoundIcon size={11} /> {injured} injured by overcrowding — treat in The Watch.
        </div>
      )}
      {r.injuring && (
        <>
          <p className="mt-1.5 text-[10px] leading-relaxed text-[#e8a35a]">
            Too many drakes — they fight and over-mate the hens, injuring the flock (wounds escalate if
            untended). Cull surplus drakes to fix the ratio.
          </p>
          {cullable > 0 ? (
            <button
              onClick={() => {
                if (engine.cullExcessDrakes().ok) playTend();
              }}
              className="mt-1.5 w-full rounded-md bg-[#5a3a2a] px-3 py-1.5 text-xs font-bold text-[#ffd9a8] transition hover:bg-[#6a4632]"
              title="Release the worst-genome surplus drakes (keeps secured + paired studs)"
            >
              Cull {cullable} excess drake{cullable > 1 ? 's' : ''}
            </button>
          ) : (
            <p className="mt-1.5 text-[10px] text-[#9a8a6a]">
              Your surplus drakes are all paired or secured — unpair some (or free a secure slot) to
              cull, then the ratio clears.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The breeding controls: Standard, existing pairs, and a new-pair builder over
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
  // Phase 6c: Prime only ever rolls in a mutation once the RUN is tier-gated —
  // the odds preview must mirror breedGenome's own eligibility check exactly.
  const primeEligible = state.legacyTier >= BALANCE.GENOME.PRIME_MIN_TIER;
  const paired = (id: string) => state.breedingPairs.some((p) => p.drakeId === id || p.henId === id);
  // Index by id once: the breeding-pairs list calls byId twice per pair, so a linear
  // `.find` made that O(pairs × ducks) per render (~15Hz while open, ducks up to 216).
  const duckById = new Map(state.ducks.map((d) => [d.id, d]));
  const byId = (id: string) => duckById.get(id);

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

      {/* TRACKING target: the workbench profile the browser/previews measure
          against — a planning aid. The legacy gate + truebred DING judge against
          the TIER's authoritative target (prestige.ts targetForTier); the ⌂ button
          snaps tracking back to it. Click a slot to cycle its gene. */}
      {(() => {
        const SLOTS = target.length;
        const legacyTarget = targetForTier(state.legacyTier);
        const onLegacy = target.every((g, i) => g === legacyTarget[i]);
        const best = state.ducks.reduce((m, d) => Math.max(m, targetMatch(d.genome, target)), 0);
        const clones = state.ducks.filter((d) => targetMatch(d.genome, target) === SLOTS).length;
        const cycle = (i: number) => {
          const next = [...target];
          next[i] = GENE_ORDER[(GENE_ORDER.indexOf(target[i]) + 1) % GENE_ORDER.length];
          engine.setGenomeTarget(next);
        };
        return (
          <div className="mb-1.5 flex items-center gap-1.5 rounded bg-[#171009] px-2 py-1.5">
            <span
              className="text-[9px] font-bold uppercase tracking-wider text-[#7a6a4a]"
              title="Your workbench target — sorting/previews measure against it. The Legacy gate judges against the tier's STANDARD."
            >
              Tracking
            </span>
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
            {!onLegacy && (
              <button
                onClick={() => engine.setGenomeTarget(legacyTarget)}
                title="Snap tracking back to this tier's Standard (the Legacy gate's target)"
                className="rounded bg-[#3a2e22] px-1.5 py-0.5 text-[9px] font-bold text-[#ffe9a8] hover:bg-[#4a3a2a]"
              >
                → Standard
              </button>
            )}
            <span className="ml-auto text-[10px] text-[#9a8a6a]" title="Best match in the flock toward the tracking target">
              best <span className="tabular-nums text-[#ffe9a8]">{best}/{SLOTS}</span>
              {clones > 0 && (
                <span className="ml-1 text-[#8fe388]">· {clones} truebred{clones > 1 ? 's' : ''}</span>
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
            {/* Line 1 — the marriage line: who this pair IS. Names get the whole
                line ("Petunia Marigold × Ferdinand"); unnamed parents read as a
                plain Drake/Hen. Genetics live on their own line below, so neither
                ever crowds the other out. */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <button
                onClick={() => toggle(p.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:opacity-90"
                title={isOpen ? 'Collapse this pair' : 'Show colour odds + crossbreed preview'}
              >
                <span className="w-2 shrink-0 text-[#7a6a4a]">{isOpen ? '▾' : '▸'}</span>
                <ColorSwatch color={phenotype(dr.genotype)} size={11} />
                <span className={`truncate ${dr.name ? 'font-bold text-[#f5ecd8]' : 'text-[#c9b88f]'}`}>
                  {dr.name ?? 'Drake'}
                </span>
                <span className="shrink-0 text-[#5a4d3a]">×</span>
                <ColorSwatch color={phenotype(he.genotype)} size={11} />
                <span className={`truncate ${he.name ? 'font-bold text-[#f5ecd8]' : 'text-[#c9b88f]'}`}>
                  {he.name ?? 'Hen'}
                </span>
              </button>
              <button
                onClick={() => engine.setDoubleClutch(p.id, !p.doubleClutch)}
                title={
                  p.doubleClutch
                    ? 'Double clutch ON — 2× the ducklings per clutch at 3× the egg cost. Tap to drop back to a plain clutch.'
                    : 'Double clutch: the pair lays 2× the ducklings per clutch at 3× the egg cost — pay the premium to push a breeding program faster.'
                }
                className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold transition ${
                  p.doubleClutch
                    ? 'bg-[#3a3218] text-[#e8c45a] ring-1 ring-[#e8c45a]'
                    : 'text-[#7a6a4a] hover:bg-[#33271c] hover:text-[#c9b88f]'
                }`}
              >
                2×
              </button>
              <button
                onClick={() => engine.unpair(p.id)}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[#b06a6a] hover:bg-[#33271c]"
              >
                unpair
              </button>
            </div>
            {/* Line 2 — the genetics, uncrowded. */}
            <div className="mt-0.5 flex items-center gap-1.5 pl-3.5">
              {!dr.genomeKnown && <PhenoBands genome={dr.genome} width={16} />}
              <GenomeTiles duck={dr} target={target} size={12} />
              <span className="text-[#5a4d3a]">·</span>
              {!he.genomeKnown && <PhenoBands genome={he.genome} width={16} />}
              <GenomeTiles duck={he} target={target} size={12} />
            </div>
            {dr.wounded || he.wounded ? (
              <div
                className="mt-0.5 text-[10px] font-bold text-[#e8a35a]"
                title="A wounded bird can't breed — the clutch clock is stopped until it's treated (admit it to the infirmary)."
              >
                paused — {dr.wounded ? 'drake' : 'hen'} wounded, treat to resume
                {p.incubating.length > 0 && ` · ${p.incubating.length} incubating (hatch ${Math.ceil(soonest)}s)`}
              </div>
            ) : next <= 0 && state.ducks.filter((d) => d.site !== 'winter').length >= coopCapacity(state) ? (
              <div
                className="mt-0.5 text-[10px] font-bold text-[#e8a35a]"
                title="Hens don’t nest when the coops are packed — the clutch (and its egg cost) waits for housing headroom, then lays and incubates normally. Free a slot: upgrade/build a coop, release a duck, or winter a hen."
              >
                waiting — coops full (clutch ready)
                {p.incubating.length > 0 && ` · ${p.incubating.length} incubating`}
              </div>
            ) : next <= 0 && state.resources.eggs < clutchCost(state, p.doubleClutch) ? (
              <div
                className="mt-0.5 text-[10px] font-bold text-[#e8a35a]"
                title="A clutch IS eggs — laying one draws them from storage (priced off your run's peak lay rate). It fires the moment you can afford it."
              >
                clutch ready — needs {clutchCost(state, p.doubleClutch)} eggs
                {p.incubating.length > 0 && ` · ${p.incubating.length} incubating (hatch ${Math.ceil(soonest)}s)`}
              </div>
            ) : (
              <div className="mt-0.5 text-[10px] text-[#9a8a6a]">
                clutch {Math.ceil(next)}s · {clutchCost(state, p.doubleClutch)} eggs
                {p.doubleClutch && <span className="font-bold text-[#e8c45a]"> · 2× brood</span>}
                {p.incubating.length > 0 && ` · ${p.incubating.length} incubating (hatch ${Math.ceil(soonest)}s)`}
              </div>
            )}
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
                <OddsPreview a={dr} b={he} target={target} primeEligible={primeEligible} />
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
                {!duck.genomeKnown && <PhenoBands genome={duck.genome} width={16} />}
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
                <OddsPreview a={dr} b={he} target={target} primeEligible={primeEligible} />
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

/** FlockPanel, render-gated: the engine notifies ~15Hz and mutates state in
 *  place (same reference), so prop-equality can't tell "something changed" —
 *  App passes a coarse `renderTick` instead and the comparator re-renders only
 *  when it moves. During a dive the tick FREEZES: a 1000-duck list repainting
 *  under an owl click was why attacks felt unclickable at scale. */
export const FlockPanel = memo(
  FlockPanelInner,
  (prev, next) => prev.renderTick === next.renderTick && prev.onClose === next.onClose,
);

/** Rows rendered per section before the "show all" expander — at 1000+ ducks
 *  a full render is ~15k DOM nodes; the cap keeps the panel light (playtest,
 *  2026-07-05: 1088 ducks). */
const SECTION_ROW_CAP = 100;

function FlockPanelInner({
  engine,
  state,
  onClose,
}: {
  engine: GameEngine;
  state: GameState;
  onClose: () => void;
  /** Coarse render clock from App — the memo comparator re-renders the panel
   *  only when this changes (~4Hz; FROZEN during a predator dive so the main
   *  thread belongs to the scare click). Internal setState still renders. */
  renderTick: number;
}) {
  useEscapeKey(onClose);
  // The panel is three tools sharing one flock list — tabs give each its own
  // altitude (playtest, 2026-07-10: 'flock ui is getting pretty cluttered').
  // BREEDING: target/pairs/builder, rows are pick-targets with kin dots.
  // ROSTER: filters/bulk/manage buttons (secure/winter/name/release).
  // POSTS: the 9a roster card, rows carry only the post cycle.
  // Tab + every filter/sort below PERSIST (playtest, 2026-07-10: reopening
  // reset the whole workbench) — see usePersistentState.
  const [tab, setTab] = usePersistentState<'breeding' | 'roster' | 'posts'>(
    'flock-tab',
    'breeding',
    (v) => v === 'breeding' || v === 'roster' || v === 'posts',
  );
  // Sections the user expanded past the row cap ("show all") — deliberately
  // NOT persisted: the cap is a render-perf guard, opt past it per visit.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [armedCull, setArmedCull] = useState<string | null>(null);
  // Role sections in the duck list: which are collapsed (The Flock at scale).
  const [collapsedSectionIds, setCollapsedSectionIds] = usePersistentState<string[]>(
    'flock-collapsed',
    [],
    (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  );
  const collapsedSections = new Set(collapsedSectionIds);
  const setCollapsedSections = (update: (prev: Set<string>) => Set<string>) =>
    setCollapsedSectionIds((prev) => [...update(new Set(prev))]);
  // Opt-in naming: which duck's name is being edited + the draft text.
  const [namingId, setNamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  // New-pair selection: drake + hen are picked by tapping rows in the list
  // below. Held in module memory so a close/reopen keeps an in-progress pick;
  // a vanished duck (culled/delivered) degrades to the empty slot naturally.
  const [mateDrakeId, setMateDrakeIdRaw] = useState(heldMateDrakeId);
  const [mateHenId, setMateHenIdRaw] = useState(heldMateHenId);
  const setMateDrakeId = (id: string) => {
    heldMateDrakeId = id;
    setMateDrakeIdRaw(id);
  };
  const setMateHenId = (id: string) => {
    heldMateHenId = id;
    setMateHenIdRaw(id);
  };
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
  const infFree = infirmaryCapacity(state) - infirmaryOccupied(state);
  // Phase 6d: Winterstead assignment (adult hens; capacity from winter coops).
  const winterOpen = zoneUnlocked(state, 'winterstead');
  const winterCap = winterCapacity(state);
  const winterUsed = state.ducks.filter((d) => d.site === 'winter').length;

  // Tab the flock by color. Counts per color drive the tab badges; open on All so
  // the whole flock is in view up front (matching the sex/stage filters, which
  // also default to All). The sorted `ducks` filtered to a color is already in
  // stage → sex → vigor order.
  const colorCounts: Record<Color, number> = { black: 0, blue: 0, splash: 0 };
  for (const d of state.ducks) colorCounts[phenotype(d.genotype)]++;
  const [colorTab, setColorTab] = usePersistentState<'all' | Color>(
    'flock-color',
    'all',
    (v) => v === 'all' || COLORS.includes(v as Color),
  );
  const inTab = (d: Duck) => colorTab === 'all' || phenotype(d.genotype) === colorTab;
  // Cross-cutting filters (compose with the color tab): sex and life stage.
  const [sexFilter, setSexFilter] = usePersistentState<'all' | Duck['sex']>(
    'flock-sex',
    'all',
    (v) => v === 'all' || v === 'drake' || v === 'hen',
  );
  const [stageFilter, setStageFilter] = usePersistentState<'all' | Duck['stage']>(
    'flock-stage',
    'all',
    (v) => v === 'all' || v === 'adult' || v === 'juvenile' || v === 'duckling',
  );
  // Genome browser (the scale tooling): sort by a genome stat, and query for a
  // gene-in-slot. Both read the genome, so they act on READ ducks; an unread
  // duck sinks to the bottom of a genome sort and never matches a gene query.
  const [sortKey, setSortKey] = usePersistentState<SortKey>(
    'flock-sort',
    'match',
    (v) => typeof v === 'string' && v in SORT_LABEL,
  );
  const [querySlot, setQuerySlot] = usePersistentState<number>(
    'flock-query-slot',
    -1, // -1 = any slot
    (v) => Number.isInteger(v) && (v as number) >= -1 && (v as number) < 6,
  );
  const [queryGene, setQueryGene] = usePersistentState<Gene | 'any'>(
    'flock-query-gene',
    'any',
    (v) => v === 'any' || GENE_ORDER.includes(v as Gene) || v === 'P',
  );
  // Bulk-release cutoff: release READ ducks whose match-to-target is below this
  // (an unread duck is never bulk-culled — you can't judge a "?"). Defaults to the
  // BEST match currently in the flock, so it pre-selects "keep only my top tier"
  // (with a perfect truebred present, that's SLOTS/SLOTS — cull everything that
  // isn't a perfect clone). Two-click confirm via armedBulk.
  const SLOTS = target.length;
  const [cullQuality, setCullQuality] = useState<number>(() =>
    state.ducks.reduce((m, d) => (d.genomeKnown ? Math.max(m, targetMatch(d.genome, target)) : m), 0),
  );
  const [armedBulk, setArmedBulk] = useState(false);
  // Bulk-release Prime protection — ON by default, but a TOGGLE with a visible
  // spared-count: deep in the Prime chase most sub-cutoff birds are carriers
  // (P passes at dominance 4), and a silent blanket rule made the tool look
  // dead ('no bulk release button lights up', playtest 2026-07-05).
  // Persisted; the CUTOFF itself is not — its smart default (the flock's best
  // match) recomputes each open, and a stale remembered cutoff would pre-arm
  // a bigger sweep than the player last meant.
  const [keepPrime, setKeepPrime] = usePersistentState<boolean>(
    'flock-keep-prime',
    true,
    (v) => typeof v === 'boolean',
  );
  // Bulk-release outcross protection (9b tooling, playtest 2026-07-12: 'want
  // to cull a bad-gened drake, but not if it's a clean bloodline'). Spares
  // ducks UNRELATED to the current breeding pairs; inert with no pairs (then
  // everything is unrelated and the toggle would deaden the tool).
  const [keepClean, setKeepClean] = usePersistentState<boolean>(
    'flock-keep-clean',
    true,
    (v) => typeof v === 'boolean',
  );

  // Index paired ducks once (O(pairs)) — the per-row checks, the bulk-release
  // filter, and the kinship reference below all read this.
  const pairedIds = new Set(state.breedingPairs.flatMap((p) => [p.drakeId, p.henId]));

  // ── Kinship reference (9b tooling): who "related" is measured AGAINST ──
  // With exactly one mate picked, it's that pick (the pair you're building);
  // otherwise it's your current breeding pairs (the program a cull or an
  // outcross matters to). O(flock × refs) with a per-render memo — refs are a
  // pick or a few dozen breeders, never the whole flock.
  const kinRefs: Duck[] = (() => {
    const picked = [mateDrakeId, mateHenId]
      .map((id) => state.ducks.find((d) => d.id === id))
      .filter((d): d is Duck => !!d);
    // Pick-relative only while BUILDING a pair; everywhere else (roster culls,
    // the posts tab) relatedness means "to the breeding program".
    if (tab === 'breeding' && picked.length === 1) return picked;
    return state.ducks.filter((d) => pairedIds.has(d.id));
  })();
  const kinMemo = new Map<string, number>();
  const kinOf = (d: Duck): number => {
    let v = kinMemo.get(d.id);
    if (v === undefined) {
      v = 0;
      for (const r of kinRefs) if (r.id !== d.id) v = Math.max(v, kinship(r, d));
      kinMemo.set(d.id, v);
    }
    return v;
  };

  const geneQueryActive = queryGene !== 'any';
  const matchesGeneQuery = (d: Duck): boolean => {
    if (!geneQueryActive) return true;
    if (!d.genomeKnown) return false;
    return querySlot >= 0 ? d.genome[querySlot] === queryGene : d.genome.includes(queryGene);
  };
  const sortStat: Record<SortKey, (d: Duck) => number> = {
    match: (d) => targetMatch(d.genome, target),
    good: (d) => goodGeneCount(d.genome),
    // The Prime chase: P-carriers first (by count), quality as the tiebreak.
    prime: (d) => d.genome.filter((g) => g === 'P').length * 10 + targetMatch(d.genome, target),
    // Outcross first: least related to the pick/breeders on top (negated —
    // the list sorts descending). Public lineage; no reader needed.
    kin: (d) => -kinOf(d),
    lay: (d) => axisTier(d.genome, 'lay'),
    vigor: (d) => axisTier(d.genome, 'vigor'),
    hardy: (d) => axisTier(d.genome, 'hardy'),
    new: (d) => idNum(d),
  };
  // Only the EXACT-genome sorts (match/good) sink unread ducks — the band sorts
  // read free public info, so they rank read and unread ducks alike.
  const exactSort = sortKey === 'match' || sortKey === 'good' || sortKey === 'prime';
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
  // (pairedIds + the kinship reference now live above sortStat — the kin sort
  // and the row dots both read them.)
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-h-[90vh] sm:rounded-xl bg-[#2a2018] p-5 ring-2 ring-[#3a2e22]">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-black text-[#ffe9a8]">Flock</h2>
          <div className="flex items-center gap-3">
            {(() => {
              const home = state.ducks.filter((d) => d.site !== 'winter').length;
              const wintering = state.ducks.length - home;
              const watered = watererSupport(state);
              const overHome = home > cap;
              return (
                <span
                  className="rounded bg-[#1f1812] px-2 py-1 text-xs font-bold text-[#c9b88f]"
                  title={
                    (overHome
                      ? 'Home is OVER housing (recall from Winterstead is always allowed) — hatching pauses until space frees. '
                      : 'Wintering ducks live in Winterstead housing — they don’t occupy home coops. ') +
                    (wintering > 0
                      ? `Winter shows assigned/HOUSING (coops × 4); heated waterers separately support ${watered} — unwatered winter hens lay throttled, they don’t block assignment.`
                      : '')
                  }
                >
                  <span className={overHome ? 'text-[#e8c45a]' : undefined}>
                    {home}/{cap} home
                  </span>
                  {wintering > 0 && (
                    <>
                      {' '}
                      · {wintering}/{winterCap} winter
                      {watered < wintering && <span className="text-[#e8c45a]"> ({watered} watered)</span>}
                    </>
                  )}
                </span>
              );
            })()}
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
          <div className="mb-3 flex gap-1">
            {(
              [
                { id: 'breeding' as const, label: 'Breeding', count: state.breedingPairs.length },
                { id: 'roster' as const, label: 'Roster', count: state.ducks.length },
                ...(postsUnlocked(state)
                  ? [{ id: 'posts' as const, label: 'Posts', count: postedDucks(state).length }]
                  : []),
              ]
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold transition ${
                  tab === t.id
                    ? 'bg-[#3a2e22] text-[#f5ecd8] ring-1 ring-[#5a4a32]'
                    : 'bg-[#1f1812] text-[#9a8a6a] hover:bg-[#33271c]'
                }`}
              >
                {t.label}
                <span className="tabular-nums text-[#7a6a4a]">{t.count}</span>
              </button>
            ))}
          </div>
        )}

        {tab === 'posts' && postsUnlocked(state) && state.ducks.length > 0 && (
          <PostsCard engine={engine} state={state} />
        )}

        {tab === 'breeding' && state.ducks.length > 0 && (
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
                {[...GENE_ORDER, 'P' as Gene].map((g) => (
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
                + paired (in-use) + posted (working) birds — the same keeper set
                cullDucks skips, so the count IS the sweep (a posted duck once
                inflated the button to a "Release 6" that released nothing).
                Use the per-row release for a keeper. Roster tab only — it's a
                management tool, not a breeding one. */}
            {tab === 'roster' && shown.length > 0 && (() => {
              const underCutoff = shown.filter(
                (d) =>
                  !d.secured &&
                  !d.post &&
                  !pairedIds.has(d.id) &&
                  d.genomeKnown &&
                  targetMatch(d.genome, target) < cullQuality,
              );
              // Prime carriers are spared while the toggle is on: a single P in
              // a junk genome scores low on target match but is precious stock
              // for the Prime chase. The spared count keeps the rule VISIBLE.
              // Clean-blood outcross stock gets the same protection (9b): junk
              // genes breed back in a generation; a lost clean line doesn't.
              const cleanGuardLive = keepClean && kinRefs.length > 0;
              const isSpared = (d: Duck) =>
                (keepPrime && d.genome.includes('P')) || (cleanGuardLive && kinOf(d) === 0);
              const spared = underCutoff.filter(isSpared).length;
              const eligible = underCutoff.filter((d) => !isSpared(d));
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
                  <div className="mt-1 flex items-center gap-1.5 text-[9px] text-[#7a6a4a]">
                    <span>matches the {target.map((g) => g).join('')} target · keeps secured + paired + posted</span>
                    <button
                      onClick={() => setKeepPrime((v) => !v)}
                      className={`rounded-full px-1.5 py-0.5 font-bold transition ${
                        keepPrime
                          ? 'bg-[#2a2440] text-[#cdbcff] ring-1 ring-[#4a3a6e]'
                          : 'bg-[#241c14] text-[#6a5a3a] ring-1 ring-[#3a2e22]'
                      }`}
                      title={
                        keepPrime
                          ? 'Prime carriers are spared from this sweep — click to include them.'
                          : 'Prime carriers are INCLUDED in this sweep — click to spare them.'
                      }
                    >
                      {keepPrime ? 'keep P carriers' : 'P carriers included'}
                    </button>
                    {kinRefs.length > 0 && (
                      <button
                        onClick={() => setKeepClean((v) => !v)}
                        className={`rounded-full px-1.5 py-0.5 font-bold transition ${
                          keepClean
                            ? 'bg-[#1a2a1f] text-[#8fc8a0] ring-1 ring-[#2e4a38]'
                            : 'bg-[#241c14] text-[#6a5a3a] ring-1 ring-[#3a2e22]'
                        }`}
                        title={
                          keepClean
                            ? 'Ducks UNRELATED to your breeding pairs are spared — junk genes breed back in a generation; a lost clean line doesn’t. Click to include them.'
                            : 'Clean-blood outcross stock is INCLUDED in this sweep — click to spare it.'
                        }
                      >
                        {keepClean ? 'keep clean blood' : 'clean blood included'}
                      </button>
                    )}
                    {spared > 0 && <span className="text-[#7a6a4a]">sparing {spared}</span>}
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
              <div className="flex flex-col gap-2.5">
                {(() => {
                  // The flock's structure at scale is ROLE, not color: the dozen
                  // you care about vs the masses. One duck, one section — most
                  // specific wins. Sections respect the active filters; empty
                  // sections vanish; the header hides when only The Flock exists.
                  const renderDuck = (d: Duck) => {
                  const canSecure = d.secured || slotsUsed < slotsTotal;
                  const isPaired = pairedIds.has(d.id);
                  const picked = d.id === mateDrakeId || d.id === mateHenId;
                  // Wintering hens can't join a pair — breeding is home-only (6d).
                  const canPick = d.stage === 'adult' && !d.wounded && !isPaired && d.site !== 'winter' && !d.post;
  // KIN READ (9b UI): relatedness to the kin reference (the pick while
                  // building a pair; your breeding pairs everywhere else) —
                  // line-tracking and cull safety as a glance, not homework.
                  // Lineage is public (no reader needed).
                  const kinVal = kinRefs.length > 0 && !picked && !pairedIds.has(d.id) ? kinOf(d) : 0;
                  const kinColor = kinVal >= 0.5 ? '#e26d6d' : kinVal >= 0.25 ? '#e8935a' : '#e8c45a';
                  const kinWarn = kinVal >= BALANCE.GENOME.KINSHIP.WARN_AT;
                  // The cull-safety read: a duck UNRELATED to the program is
                  // outcross stock — releasing it costs blood you can't breed
                  // back. Roster only (where releases happen), adults only.
                  const kinClean =
                    tab === 'roster' && kinRefs.length > 0 && kinVal === 0 && !pairedIds.has(d.id) && d.stage === 'adult';
                  return (
                    <div
                      key={d.id}
                      className={`flex flex-wrap items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] ${
                        picked
                          ? 'bg-[#241d33] ring-1 ring-[#6b4f9e]'
                          : d.wounded
                            ? 'bg-[#2a1818] ring-1 ring-[#5a2a2a]'
                            : 'bg-[#1f1812]'
                      }`}
                    >
                      <ColorSwatch color={phenotype(d.genotype)} size={10} />
                      {tab === 'roster' && namingId === d.id ? (
                        <input
                          autoFocus
                          value={nameDraft}
                          maxLength={16}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation(); // Escape must not close the panel
                            if (e.key === 'Enter') {
                              engine.nameDuck(d.id, nameDraft);
                              setNamingId(null);
                            } else if (e.key === 'Escape') setNamingId(null);
                          }}
                          onBlur={() => {
                            engine.nameDuck(d.id, nameDraft);
                            setNamingId(null);
                          }}
                          className="w-20 rounded bg-[#0f0b07] px-1 py-0.5 text-[11px] font-bold text-[#f5ecd8] outline-none ring-1 ring-[#5a4a32]"
                          placeholder="name her…"
                        />
                      ) : d.name ? (
                        // Rename is a roster affordance; elsewhere the name is
                        // just identity. Gen rides along as flavor ("· G7").
                        <button
                          onClick={() => {
                            if (tab !== 'roster') return;
                            setNamingId(d.id);
                            setNameDraft(d.name ?? '');
                          }}
                          className={`max-w-28 shrink-0 truncate font-bold text-[#f5ecd8] ${
                            tab === 'roster' ? 'hover:text-[#ffe9a8]' : 'cursor-default'
                          }`}
                          title={`${d.name}${d.gen ? ` — generation ${d.gen}` : ''}${tab === 'roster' ? ' — click to rename' : ''}`}
                        >
                          {d.name}
                          {d.gen != null && <span className="ml-1 font-normal text-[#7a6a4a]">G{d.gen}</span>}
                        </button>
                      ) : tab === 'roster' && d.stage === 'adult' ? (
                        <button
                          onClick={() => {
                            setNamingId(d.id);
                            setNameDraft('');
                          }}
                          className="inline-flex items-center rounded px-0.5 text-[#4a3f30] hover:bg-[#33271c] hover:text-[#9a8a6a]"
                          title="Name this duck — named ducks tell their own stories (toasts + the away summary)"
                        >
                          <PencilIcon size={10} />
                        </button>
                      ) : null}
                      <span className="w-9 text-[#c9b88f]">{d.sex}</span>
                      {d.stage !== 'adult' && (
                        <span className="w-16 shrink-0 text-[#9a8a6a]">
                          {STAGE_LABEL[d.stage]}
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
                        </span>
                      )}
                      {d.wounded && (
                        <span
                          className="inline-flex items-center"
                          style={{ color: d.recovering ? '#8fe388' : undefined }}
                          title={
                            d.recovering
                              ? 'Recovering in the infirmary'
                              : `Wounded — ${Math.ceil(
                                  Math.max(
                                    0,
                                    BALANCE.PREDATORS.WOUND_ESCALATE_SEC * waterWoundMult(state) -
                                      (d.woundElapsed ?? 0),
                                  ),
                                )}s to escalate. Admit to the infirmary to save.`
                          }
                        >
                          <WoundIcon size={11} />
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-1.5">
                        {!d.genomeKnown && <PhenoBands genome={d.genome} />}
                        <GenomeTiles duck={d} target={target} size={13} />
                        <span
                          className="tabular-nums text-[#ffe9a8]"
                          title={d.genomeKnown ? `${targetMatch(d.genome, target)} of ${target.length} slots match the target` : 'Unread genome'}
                        >
                          {qualityLabel(d, target)}
                        </span>
                      </span>
                      {d.wounded && !d.recovering && (
                        <button
                          onClick={() => {
                            if (engine.admit(d.id).ok) playTend();
                          }}
                          disabled={infFree <= 0}
                          className={`inline-flex items-center rounded px-1 py-0.5 ${
                            infFree > 0
                              ? 'text-[#8fe388] hover:bg-[#33271c]'
                              : 'cursor-not-allowed text-[#5a4d3a]'
                          }`}
                          title={
                            infFree > 0
                              ? 'Admit to a recovery slot — heals over time'
                              : 'Infirmary full — build another (in The Watch) or wait'
                          }
                        >
                          <HealIcon size={12} />
                        </button>
                      )}
                      {(tab === 'breeding' || tab === 'roster') && kinWarn && (
                        <span
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: kinColor }}
                          title={`Related (${kinVal}) to ${
                            tab === 'breeding' ? 'your pick' : 'your breeding pairs'
                          } — a cross degrades offspring slots to Dud ${Math.round(
                            kinVal * BALANCE.GENOME.KINSHIP.DUD_CHANCE * 100,
                          )}% of the time.`}
                        />
                      )}
                      {kinClean && (
                        <span
                          className="shrink-0 text-[9px] font-bold text-[#6a9a7a]"
                          title="Unrelated to your breeding pairs — outcross stock. Releasing this bird costs clean blood you can't breed back."
                        >
                          clean
                        </span>
                      )}
                      {tab === 'breeding' &&
                        (isPaired ? (
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
                        ) : null)}
                      {tab === 'roster' && (
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
                      )}
                      {tab === 'posts' && postsUnlocked(state) && d.stage === 'adult' && d.site !== 'winter' && (() => {
                        // Phase 9a: the post cycle button — none → sentry →
                        // forager → broody (skipping full posts and
                        // broody-for-drakes) → back to the flock. Same
                        // no-silent-refusal rule as the snowflake.
                        const blocked = pairedIds.has(d.id)
                          ? 'in a breeding pair — unpair first'
                          : d.wounded || d.recovering
                            ? 'needs to heal first'
                            : null;
                        const cyclePost = () => {
                          if (blocked) return;
                          const order: PostId[] = ['sentry', 'forager', 'broody', 'show'];
                          const start = d.post ? order.indexOf(d.post) + 1 : 0;
                          for (let k = start; k < order.length; k++) {
                            const cand = order[k];
                            if (cand === 'broody' && d.sex !== 'hen') continue;
                            if (cand === 'show' && state.legacyTier < BALANCE.CONTRACTS.UNLOCK_TIER) continue;
                            const occupied = state.ducks.filter((x) => x.id !== d.id && x.post === cand).length;
                            if (occupied >= postCapacity(cand)) continue;
                            if (engine.assignToPost(d.id, cand).ok) {
                              playTend();
                              return;
                            }
                          }
                          if (d.post) engine.recallFromPost(d.id); // past the end → home
                        };
                        return (
                          <button
                            onClick={cyclePost}
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              d.post
                                ? 'bg-[#2e3a26] text-[#8fb8a0]'
                                : blocked
                                  ? 'cursor-not-allowed text-[#3a4048] opacity-60'
                                  : 'text-[#5a6a5a] hover:bg-[#33271c] hover:text-[#8fb8a0]'
                            }`}
                            title={
                              blocked
                                ? `Can’t post: ${blocked}`
                                : d.post
                                  ? `${POST_META[d.post].label} — ${POST_META[d.post].blurb}. Click to cycle posts / send home.`
                                  : 'Assign to a working post (click cycles sentry / forager / broody)'
                            }
                          >
                            {d.post ? POST_META[d.post].label.toLowerCase() : 'post'}
                          </button>
                        );
                      })()}
                      {tab === 'roster' && winterOpen && d.stage === 'adult' && d.sex === 'hen' && (() => {
                        // Mirror assignToWinter's gates HERE so a refusal is
                        // never a silent no-op (playtest: clicking a paired
                        // hen's snowflake did nothing, with no reason shown).
                        const blocked =
                          d.site === 'winter'
                            ? null
                            : pairedIds.has(d.id)
                              ? 'she’s in a breeding pair — unpair her first'
                              : d.post
                                ? 'she’s working a post — recall her first'
                                : d.wounded || d.recovering
                                  ? 'she needs to heal first'
                                  : winterUsed >= winterCap
                                    ? 'winter coops are full — build another'
                                    : null;
                        return (
                          <button
                            onClick={() => {
                              if (blocked) return;
                              if (d.site === 'winter') engine.recallFromWinter(d.id);
                              else if (engine.assignToWinter(d.id).ok) playTend();
                            }}
                            className={`inline-flex items-center rounded px-1 py-0.5 ${
                              d.site === 'winter'
                                ? 'text-[#9fd4e8]'
                                : blocked
                                  ? 'cursor-not-allowed text-[#3a4650] opacity-60'
                                  : 'text-[#5a6a7a] hover:bg-[#33271c] hover:text-[#9fd4e8]'
                            }`}
                            title={
                              d.site === 'winter'
                                ? 'Wintering over — laying premium eggs at Winterstead. Click to bring her home.'
                                : blocked
                                  ? `Can’t winter her: ${blocked}`
                                  : `Assign to Winterstead (${winterUsed}/${winterCap} slots) — Hardy hens earn a premium out there`
                            }
                          >
                            <SnowflakeIcon size={12} />
                          </button>
                        );
                      })()}
                      {tab === 'roster' && (
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
                      )}
                    </div>
                  );
                  };

                  const sections = [
                    { id: 'secured', label: 'Secured', icon: <ShieldIcon size={11} />, ducks: shown.filter((d) => d.secured) },
                    { id: 'winter', label: 'Wintering', icon: <SnowflakeIcon size={11} />, ducks: shown.filter((d) => !d.secured && d.site === 'winter') },
                    { id: 'posted', label: 'On post', icon: <DuckRowIcon />, ducks: shown.filter((d) => !d.secured && d.site !== 'winter' && d.post) },
                    { id: 'named', label: 'Named', icon: <PencilIcon size={10} />, ducks: shown.filter((d) => !d.secured && d.site !== 'winter' && !d.post && d.name) },
                    { id: 'rest', label: 'The Flock', icon: <DuckRowIcon />, ducks: shown.filter((d) => !d.secured && d.site !== 'winter' && !d.post && !d.name) },
                  ].filter((sec) => sec.ducks.length > 0);
                  const soloFlock = sections.length === 1 && sections[0].id === 'rest';
                  return sections.map((sec) => (
                    <div key={sec.id}>
                      {!soloFlock && (
                        <button
                          onClick={() =>
                            setCollapsedSections((prev) => {
                              const n = new Set(prev);
                              if (n.has(sec.id)) n.delete(sec.id);
                              else n.add(sec.id);
                              return n;
                            })
                          }
                          className="mb-1 flex w-full items-center gap-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-[#7a6a4a] hover:text-[#9a8a6a]"
                          title={collapsedSections.has(sec.id) ? 'Expand' : 'Collapse'}
                        >
                          <span className="w-2">{collapsedSections.has(sec.id) ? '▸' : '▾'}</span>
                          {sec.icon} {sec.label}
                          <span className="font-normal text-[#5a4d3a]">{sec.ducks.length}</span>
                          <span className="ml-1 h-px flex-1 bg-[#3a2e22]" />
                        </button>
                      )}
                      {!collapsedSections.has(sec.id) && (
                        <div className="flex flex-col gap-1">
                          {(expandedRows.has(sec.id) ? sec.ducks : sec.ducks.slice(0, SECTION_ROW_CAP)).map(renderDuck)}
                          {!expandedRows.has(sec.id) && sec.ducks.length > SECTION_ROW_CAP && (
                            <button
                              onClick={() => setExpandedRows((prev) => new Set(prev).add(sec.id))}
                              className="rounded-md bg-[#241c14] px-2.5 py-1.5 text-[10px] font-bold text-[#b59a5a] hover:bg-[#2e2318]"
                            >
                              Show all {sec.ducks.length} ({sec.ducks.length - SECTION_ROW_CAP} more) — sorts and filters above narrow this list faster
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ));
                })()}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
