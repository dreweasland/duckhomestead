import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { pondFeatureMaxed, pondFeatureUpgradeCost, pondView } from '../game/pond';
import { flockRequirement, waterAccess, waterProvision, waterStatus } from '../game/water';
import {
  cellKey,
  phenotype,
  type Color,
  type FlowFeature,
  type FlowFeatureType,
  type GameState,
  type PondFeature,
  type PondFeatureType,
} from '../game/state';
import { playPlace, playUpgrade } from '../audio/sfx';
import { currentSeasonId, seasonsActive } from '../game/season';
import { loadDuckTintImages } from '../render/assets';
import { CloseIcon, EggIcon, WaterIcon } from './icons';

const W = BALANCE.WATER;
// 68px tiles: 7 columns ≈ the yard board's width (8×56+pad), so the water
// canvas fills the same column instead of floating in it (playtest ask).
const TILE = 68;
const GW = W.CANVAS.width * TILE;
const GH = W.CANVAS.height * TILE;

type Mode = 'layout' | 'circulation';

/** Per-browser "I've seen the help for this tab" flag (UI onboarding only — kept
 *  out of the game save so it never touches prestige/migration). */
const HELP_SEEN_KEY = (mode: Mode) => `duck-homestead-waterhelp-${mode}`;

// Hand-drawn pixel sprites (baked via .asset-src/water.cjs, like the farm's) —
// the pond speaks the same visual language as the yard now. `hint` is the
// build-card one-liner, matching the yard BuildBar's grammar.
const FEAT_META: Record<PondFeatureType, { label: string; color: string; hint: string }> = {
  spring: { label: 'Spring', color: '#52b6dc', hint: 'lifts pools beside it' },
  bathingPool: { label: 'Bathing Pool', color: '#3f8fd0', hint: '+water · loves springs' },
  plantBed: { label: 'Plant Bed', color: '#6fb04f', hint: '+water · lifts neighbours' },
  deepZone: { label: 'Deep Zone', color: '#2f5f8c', hint: 'most water · fouls fastest' },
};
const FLOW_META: Record<FlowFeatureType, { label: string; color: string; hint: string }> = {
  intake: { label: 'Pump', color: '#5ad0a0', hint: 'top rail · water in' },
  fountain: { label: 'Fountain', color: '#7fd8e8', hint: 'keeps features fresh' },
  outflow: { label: 'Drain', color: '#9a8a6a', hint: 'bottom rail · water out' },
  pipe: { label: 'Pipe', color: '#c9b884', hint: 'carries flow · cheap' },
};
const waterSprite = (t: string) => `/assets/water/${t}.png`;

const FEAT_TYPES = Object.keys(FEAT_META) as PondFeatureType[];
const FLOW_TYPES = Object.keys(FLOW_META) as FlowFeatureType[];

// ── Ambient pond swimmers (Phase 5 juice, water assessment fix ②) ──────
// Pure render: nothing here reads or writes GameState. Cache the recolored
// duck frames at module scope so flipping between the Pond/Waterworks tabs
// doesn't re-decode/re-recolor the source art every mount.
let duckTintCache: Promise<Record<Color, string[]>> | null = null;
function getDuckTintImages(): Promise<Record<Color, string[]>> {
  if (!duckTintCache) duckTintCache = loadDuckTintImages();
  return duckTintCache;
}

const SWIMMER_SIZE = 28;
const SWIMMER_CAP = 8;

interface Swimmer {
  id: string;
  color: Color;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number;
  delay: number;
  bobDuration: number;
  bobDelay: number;
}

/** How many swimmers the pond shows: 0 at a thirsty/empty pond, up to the cap
 *  once access reaches ~2 (the "busy" point) — the system's one number (water
 *  access) finally made visible as something alive. */
function swimmerCount(access: number, requirement: number): number {
  if (requirement <= 0) return 0; // no yard-relevant flock ⇒ nothing to swim
  return Math.max(0, Math.min(SWIMMER_CAP, Math.round((access / 2) * SWIMMER_CAP)));
}

function statusColor(s: ReturnType<typeof waterStatus>): string {
  return s === 'good' ? '#8fe388' : s === 'ok' ? '#e8c45a' : '#e8835a';
}
function freshColor(f: number): string {
  return f >= 0.85 ? '#8fe388' : f >= 0.6 ? '#e8c45a' : '#e8835a';
}

// ── Help: plain-language effects + a worked "ideal" example ───────────
const FEAT_EFFECT: Record<PondFeatureType, string> = {
  spring: `No water by itself — it lifts each bathing pool placed right next to it (+${W.FEATURES.bathingPool.springBonus}). Surround it with pools.`,
  bathingPool: `+${W.FEATURES.bathingPool.baseProvision} water, and +${W.FEATURES.bathingPool.springBonus} more next to a spring.`,
  plantBed: `+${W.FEATURES.plantBed.baseProvision} water, and raises each neighbouring feature by +${Math.round(W.FEATURES.plantBed.adjacentQualityBonus * 100)}%.`,
  deepZone: `+${W.FEATURES.deepZone.baseProvision} water — the richest tile, but fouls fastest, so keep it in a fountain's range.`,
};
const FLOW_EFFECT: Record<FlowFeatureType, string> = {
  intake: `The pump — mounts on the rail ABOVE the pond. Each pump+drain PAIR pressurises up to ${W.CIRCULATION.FOUNTAINS_PER_PUMP_PAIR} fountains on its line.`,
  fountain: `Keeps every tile within ${W.CIRCULATION.fountainCoverageRadius} (a ${2 * W.CIRCULATION.fountainCoverageRadius + 1}×${2 * W.CIRCULATION.fountainCoverageRadius + 1} area) fresh — but only when its line runs pump → … → drain, and only within pump pressure (${W.CIRCULATION.FOUNTAINS_PER_PUMP_PAIR} per pump+drain pair; the far end of an over-stretched line goes stagnant first).`,
  outflow: 'The drain — mounts on the rail BELOW the pond. Spent water leaves here; every line needs one.',
  pipe: 'Carries flow, projects nothing — the cheap connector that lets one pump pair reach fountains anywhere on the board.',
};

/** A compact, centred 3×3 cluster: a spring feeds the pools, plant beds lift them. */
const EXAMPLE_FEATURES: PondFeature[] = [
  { x: 2, y: 1, type: 'bathingPool' },
  { x: 3, y: 1, type: 'plantBed' },
  { x: 4, y: 1, type: 'bathingPool' },
  { x: 2, y: 2, type: 'spring' },
  { x: 3, y: 2, type: 'bathingPool' },
  { x: 4, y: 2, type: 'spring' },
  { x: 2, y: 3, type: 'bathingPool' },
  { x: 3, y: 3, type: 'plantBed' },
  { x: 4, y: 3, type: 'bathingPool' },
];
/** One live line across the middle — a single fountain covers the whole cluster. */
const EXAMPLE_FLOW: FlowFeature[] = [
  { x: 1, y: -1, type: 'intake' }, // pump, on the TOP rail
  { x: 1, y: 0, type: 'pipe' },
  { x: 1, y: 1, type: 'pipe' },
  { x: 2, y: 1, type: 'fountain' },
  { x: 3, y: 1, type: 'pipe' },
  { x: 4, y: 1, type: 'fountain' },
  { x: 4, y: 2, type: 'pipe' },
  { x: 4, y: 3, type: 'pipe' },
  { x: 4, y: 4, type: 'pipe' },
  { x: 4, y: 5, type: 'outflow' }, // drain, on the BOTTOM rail (y = height)
];

/** A small static diagram of the canvas (used only in the help sheet). */
function MiniGrid({ features, flow }: { features: PondFeature[]; flow?: FlowFeature[] }) {
  const T = 26;
  const rails = !!flow; // the circulation diagram shows the pump/drain rails
  const w = W.CANVAS.width * T;
  const h = (W.CANVAS.height + (rails ? 2 : 0)) * T;
  const featAt = (x: number, y: number) => features.find((f) => f.x === x && f.y === y);
  const flowAt = (x: number, y: number) => flow?.find((f) => f.x === x && f.y === y);
  return (
    <svg width={w} height={h} shapeRendering="crispEdges" style={{ imageRendering: 'pixelated' }}>
      <rect x={0} y={rails ? T : 0} width={w} height={W.CANVAS.height * T} rx={6} fill="#163243" />
      {rails && (
        <>
          <rect x={0} y={0} width={w} height={T - 3} rx={4} fill="#232b31" />
          <rect x={0} y={h - T + 3} width={w} height={T - 3} rx={4} fill="#232b31" />
        </>
      )}
      {(rails
        ? Array.from({ length: W.CANVAS.height + 2 }, (_, i) => i - 1)
        : Array.from({ length: W.CANVAS.height }, (_, i) => i)
      ).map((y) =>
        Array.from({ length: W.CANVAS.width }).map((_, x) => {
          const isRail = y === -1 || y === W.CANVAS.height;
          const px = x * T;
          const py = (y + (rails ? 1 : 0)) * T;
          const feat = isRail ? undefined : featAt(x, y);
          const fl = flowAt(x, y);
          return (
            <g key={`${x},${y}`}>
              {!isRail && (
                <rect x={px + 1} y={py + 1} width={T - 2} height={T - 2} rx={3} fill={(x + y) % 2 ? '#1a3a4c' : '#173443'} />
              )}
              {feat && (
                <rect x={px + 4} y={py + 4} width={T - 8} height={T - 8} rx={3} fill={FEAT_META[feat.type].color} opacity={flow ? 0.45 : 1} />
              )}
              {fl && (
                <circle cx={px + T / 2} cy={py + T / 2} r={7} fill={FLOW_META[fl.type].color} stroke="#fff4d6" strokeWidth={1.5} />
              )}
            </g>
          );
        }),
      )}
    </svg>
  );
}

/** The help sheet: what each piece does + a worked ideal layout. */
function WaterHelp({
  onClose,
  starter,
}: {
  onClose: () => void;
  starter: { isFlow: boolean; cost: number; canAfford: boolean; alreadyBuilt: boolean; onPlace: () => void };
}) {
  const isFlow = starter.isFlow;
  const Swatch = ({ color }: { color: string }) => (
    <span className="mt-0.5 inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: color }} />
  );
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-xl pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-h-[88vh] sm:rounded-xl bg-[#15242e] p-5 ring-2 ring-[#27485a]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-1.5 text-lg font-black text-[#a8d0e8]">
            <WaterIcon size={16} /> Water — how it works
          </h2>
          <button onClick={onClose} className="rounded p-1.5 text-[#7a9aa8] hover:bg-[#0f1b23] hover:text-[#dff]" aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </div>

        <p className="mb-3 text-[11px] leading-relaxed text-[#c4dae6]">
          Your flock needs water. The bar reads <b>Provision / need</b>, where <b>need = your flock
          size</b>. Aim for provision about <b>double your flock</b> for the full bonus (faster
          condition recovery + more time to treat wounds). Low water only slows recovery — it's never
          lethal.
        </p>

        {!isFlow ? (
          // ── The Pond tab: layout only (circulation comes later) ──
          <>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#6f93a3]">
              The Pond — pieces
            </div>
            <div className="mb-3 space-y-1.5">
              {FEAT_TYPES.map((t) => (
                <div key={t} className="flex items-start gap-2 text-[11px] text-[#c4dae6]">
                  <Swatch color={FEAT_META[t].color} />
                  <span>
                    <b style={{ color: FEAT_META[t].color }}>{FEAT_META[t].label}</b>{' '}
                    <span className="text-[#7a9aa8]">({W.FEATURES[t].costEggs} eggs)</span> — {FEAT_EFFECT[t]}
                  </span>
                </div>
              ))}
            </div>

            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#6f93a3]">
              An ideal starter
            </div>
            <div className="flex flex-col items-center gap-1">
              <MiniGrid features={EXAMPLE_FEATURES} />
              <div className="text-center text-[11px] leading-snug text-[#7a9aa8]">
                A spring with bathing pools around it, plant beds tucked between to lift them.
              </div>
            </div>
            <p className="mt-3 rounded-md bg-[#13202a] px-3 py-2 text-[10px] leading-relaxed text-[#7a9aa8]">
              Later, at a higher rank, <b className="text-[#a8d0e8]">Waterworks</b> unlocks a
              circulation layer here — as your flock grows it fouls the pond, and circulation keeps it
              fresh. Nothing to do about it yet; just build a good pond.
            </p>
          </>
        ) : (
          // ── The Waterworks tab: circulation only ──
          <>
            <p className="mb-3 rounded-md bg-[#13202a] px-3 py-2 text-[10px] leading-relaxed text-[#7a9aa8]">
              Your flock now fouls the pond faster than it stays fresh. Build the pond's water on{' '}
              <b className="text-[#a8d0e8]">The Pond</b> tab; here you keep it circulating.
            </p>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#6f93a3]">
              Waterworks — pieces
            </div>
            <div className="mb-3 space-y-1.5">
              {FLOW_TYPES.map((t) => (
                <div key={t} className="flex items-start gap-2 text-[11px] text-[#c4dae6]">
                  <Swatch color={FLOW_META[t].color} />
                  <span>
                    <b style={{ color: FLOW_META[t].color }}>{FLOW_META[t].label}</b>{' '}
                    <span className="text-[#7a9aa8]">({W.FLOW[t].costEggs} eggs)</span> — {FLOW_EFFECT[t]}
                  </span>
                </div>
              ))}
            </div>

            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#6f93a3]">
              An ideal layout
            </div>
            <div className="flex flex-col items-center gap-1">
              <MiniGrid features={EXAMPLE_FEATURES} flow={EXAMPLE_FLOW} />
              <div className="text-center text-[11px] leading-snug text-[#7a9aa8]">
                Intake → fountain → outflow across the middle (they sit on the pond features). One
                fountain keeps the whole pond fresh.
              </div>
            </div>
          </>
        )}

        {/* One-tap: drop the example for the tab you're on (charges eggs). */}
        {!starter.alreadyBuilt && (
          <button
            onClick={starter.onPlace}
            disabled={!starter.canAfford}
            className={`mt-3 w-full rounded-md px-3 py-2 text-xs font-bold transition ${
              starter.canAfford
                ? 'bg-[#27485a] text-[#dff] hover:bg-[#2f5870]'
                : 'cursor-not-allowed bg-[#13202a] text-[#5a7a8a]'
            }`}
          >
            {starter.canAfford
              ? `Place the ${starter.isFlow ? 'Waterworks' : 'Pond'} starter · ${starter.cost.toLocaleString()} eggs`
              : `Need ${starter.cost.toLocaleString()} eggs for the ${starter.isFlow ? 'Waterworks' : 'Pond'} starter`}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The water canvas. One shared grid surfaced two ways:
 *   - layout mode (the Pond tab): place provision features; arrangement scores.
 *   - circulation mode (the Waterworks tab): route intake → fountains → outflow
 *     so live fountains keep the pond features fresh. Both tabs read the same
 *     coordinates, so the Waterworks tab shows your pond features as context.
 */
export function WaterBoard({
  engine,
  state,
  mode,
  pick,
}: {
  engine: GameEngine;
  state: GameState;
  mode: Mode;
  /** The armed water build tool — lifted to App (like the yard's buildType)
   *  so the palette can live in the BUILD card below the board. */
  pick: PondFeatureType | FlowFeatureType | null;
}) {
  const isFlow = mode === 'circulation';
  const [help, setHelp] = useState(false);
  // Selected provision feature (layout mode) — opens the upgrade/remove panel.
  const [selKey, setSelKey] = useState<string | null>(null);
  // Ambient pond swimmers: the recolored duck art loads once (async, decoded
  // off the raw PNGs) and is reused for the life of the component.
  const [duckImgs, setDuckImgs] = useState<Record<Color, string[]> | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDuckTintImages().then((imgs) => {
      if (!cancelled) setDuckImgs(imgs);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Auto-open the help sheet the first time each tab is viewed (once per browser).
  useEffect(() => {
    try {
      const k = HELP_SEEN_KEY(mode);
      if (!localStorage.getItem(k)) {
        localStorage.setItem(k, '1');
        setHelp(true);
      }
    } catch {
      /* storage unavailable — just don't auto-open */
    }
  }, [mode]);
  const view = pondView(state);
  // Index features/flow by cell once per render (O(F+L)) so the W×H grid's per-cell
  // lookups below are O(1) — was O(cells × features) via `.find`, re-running ~15Hz
  // while the board is open and growing with pond size.
  const featByKey = new Map(view.features.map((f) => [cellKey(f.x, f.y), f]));
  const flowByKey = new Map(view.flow.map((f) => [cellKey(f.x, f.y), f]));
  const terrainByKey = new Set(view.terrain.map((t) => cellKey(t.x, t.y)));
  const featAt = (x: number, y: number) => featByKey.get(cellKey(x, y));
  const flowAt = (x: number, y: number) => flowByKey.get(cellKey(x, y));
  const terrainAt = (x: number, y: number) => terrainByKey.has(cellKey(x, y));

  const provision = waterProvision(state);
  const requirement = flockRequirement(state);
  const access = waterAccess(state);
  const status = waterStatus(access);
  const healthPct = Math.round(view.circulationHealth * 100);
  const outgrowing = state.ducks.length > 0 && provision < requirement * 0.999;
  const stagnating = view.features.filter((f) => !f.covered && f.freshness < 0.85).length;

  // 9c board dressing: the water wears the season too — fresher blue under
  // spring rain, murkier in autumn (with drifting leaves), ICED pale in
  // winter (and nobody swims a frozen pond). Summer is the baseline.
  const seasonId = seasonsActive(state) ? currentSeasonId(state) : 'summer';
  const frozen = seasonId === 'winter';
  const waterFill =
    seasonId === 'spring' ? '#1a4055' : seasonId === 'autumn' ? '#1d3a3d' : frozen ? '#9fc0d4' : '#163243';
  // Deterministic decoration positions (no per-render randomness — CSS drives
  // all motion): ice flecks in winter, floating leaves in autumn.
  const flecks = useMemo(
    () =>
      Array.from({ length: 46 }, (_, i) => ({
        x: ((i * 97) % (GW - 12)) + 6,
        y: ((i * 61) % (GH - 12)) + 6,
        w: 2 + ((i * 7) % 4),
      })),
    [],
  );
  const leaves = useMemo(
    () =>
      Array.from({ length: 9 }, (_, i) => ({
        x: ((i * 151) % (GW - 20)) + 10,
        y: ((i * 83) % (GH - 20)) + 10,
      })),
    [],
  );
  // Rain streaks: fixed pattern repeating every GH so the CSS translate loops
  // seamlessly (see .water-rain in index.css; killed under reduced motion).
  const rain = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        x: ((i * 113) % (GW - 8)) + 4,
        y: ((i * 71) % GH) - GH,
      })),
    [],
  );

  // Ambient swimmers: recomputed only when the swimmer count or the pond's
  // feature LAYOUT changes — never on freshness/covered churn, which updates
  // every tick and would otherwise restart every drift animation constantly.
  const swimCount = frozen ? 0 : swimmerCount(access, requirement);
  const featureLayoutKey = view.features.map((f) => `${f.x},${f.y}`).join('|');
  const swimmers = useMemo<Swimmer[]>(() => {
    if (swimCount <= 0) return [];
    // Waypoint pool: feature tiles first (covered + fresher ranked ahead — the
    // "prefer fresh/covered tiles" bias), padded with random water tiles.
    const featTiles = [...view.features]
      .sort((a, b) => (b.covered ? 1 : 0) - (a.covered ? 1 : 0) || b.freshness - a.freshness)
      .map((f) => ({ x: f.x * TILE + TILE / 2, y: f.y * TILE + TILE / 2 }));
    const pool = [...featTiles];
    while (pool.length < swimCount * 2 + 4) pool.push({ x: Math.random() * GW, y: Math.random() * GH });
    const flockColors = state.ducks.filter((d) => d.site !== 'winter').map((d) => phenotype(d.genotype));
    const pickColor = (): Color =>
      flockColors.length > 0 ? flockColors[Math.floor(Math.random() * flockColors.length)] : 'black';
    return Array.from({ length: swimCount }, (_, i) => {
      const a = pool[i % pool.length];
      const b = pool[(i + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length];
      const duration = 8 + Math.random() * 8;
      const bobDuration = 1.2 + Math.random() * 0.8;
      return {
        id: `sw${i}`,
        color: pickColor(),
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        duration,
        delay: -Math.random() * duration, // negative delay: starts mid-cycle, so swimmers don't sync up
        bobDuration,
        bobDelay: -Math.random() * bobDuration,
      };
    });
    // eslint: swimCount/featureLayoutKey are the intended deps — colors/waypoints
    // resampling on every duck/freshness tick would restart the animations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swimCount, featureLayoutKey]);

  // One-tap starter: drop the worked example for whichever tab you're on.
  const starterSet = isFlow ? EXAMPLE_FLOW : EXAMPLE_FEATURES;
  const starterCost = isFlow
    ? EXAMPLE_FLOW.reduce((a, f) => a + W.FLOW[f.type].costEggs, 0)
    : EXAMPLE_FEATURES.reduce((a, f) => a + W.FEATURES[f.type].costEggs, 0);
  const starterBuilt = isFlow ? view.flow.length > 0 : view.features.length > 0;
  const placeStarter = () => {
    let placed = false;
    for (const f of starterSet) {
      const r = isFlow
        ? engine.placeFlowFeature(f.type as FlowFeatureType, f.x, f.y)
        : engine.placePondFeature(f.type as PondFeatureType, f.x, f.y);
      placed = placed || r.ok;
    }
    if (placed) playPlace();
    setHelp(false);
  };

  // Coverage tiles (live fountains within radius) — a faint wash in circ mode.
  const covered = new Set<string>();
  if (isFlow) {
    const r = W.CIRCULATION.fountainCoverageRadius;
    for (const f of view.flow) {
      if (!view.liveKeys.has(cellKey(f.x, f.y))) continue;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const x = f.x + dx;
          const y = f.y + dy;
          if (x >= 0 && y >= 0 && x < W.CANVAS.width && y < W.CANVAS.height) covered.add(cellKey(x, y));
        }
    }
  }

  const onCell = (x: number, y: number) => {
    if (isFlow) {
      if (flowAt(x, y)) {
        if (engine.removeFlowFeature(x, y).ok) playPlace();
      } else if (pick && engine.placeFlowFeature(pick as FlowFeatureType, x, y).ok) playPlace();
      return;
    }
    const here = featAt(x, y);
    if (here) {
      // The YARD grammar: with the matching tool armed, clicking a placed
      // feature upgrades it in place. Otherwise clicking selects it (the
      // panel has upgrade/remove).
      if (pick === here.type) {
        if (engine.upgradePondFeature(x, y).ok) playUpgrade();
        else setSelKey(cellKey(x, y)); // maxed/broke → show the panel instead
      } else {
        setSelKey(cellKey(x, y));
      }
    } else if (pick && engine.placePondFeature(pick as PondFeatureType, x, y).ok) {
      playPlace();
      setSelKey(null);
    }
  };

  // The selected feature (layout mode only); cleared if it no longer exists.
  const selected = !isFlow && selKey ? featByKey.get(selKey) ?? null : null;
  const upgradeCost = selected ? pondFeatureUpgradeCost(state, selected.x, selected.y) : 0;

  return (
    // maxWidth lets the whole water column shrink on narrow screens; the SVG
    // below scales with it (viewBox preserves the coordinate space, so cell
    // taps keep resolving to the right tiles at any size).
    <div className="flex w-full flex-col items-center gap-2" style={{ maxWidth: GW }}>
      {help && (
        <WaterHelp
          onClose={() => setHelp(false)}
          starter={{
            isFlow,
            cost: starterCost,
            canAfford: state.resources.eggs >= starterCost,
            alreadyBuilt: starterBuilt,
            onPlace: placeStarter,
          }}
        />
      )}
      <div className="flex w-full items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#a8d0e8]">
          <WaterIcon size={13} /> {isFlow ? 'Waterworks — circulation' : 'The Pond — layout'}
        </span>
        <button
          onClick={() => setHelp(true)}
          className="inline-flex items-center gap-1 rounded-full bg-[#13202a] px-2.5 py-1 text-[10px] font-bold text-[#7fd8e8] ring-1 ring-[#27485a] hover:bg-[#1a2c38]"
          aria-label="How water works"
        >
          <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-[#27485a] text-[9px] text-[#dff]">?</span>
          How it works
        </button>
      </div>
      <svg
        className="block h-auto w-full"
        viewBox={`0 0 ${GW} ${isFlow ? GH + 2 * TILE : GH}`}
        shapeRendering="crispEdges"
        style={{ imageRendering: 'pixelated' }}
      >
        {/* pond water base (offset below the pump rail in circulation mode) —
            seasonally dressed (9c): iced pale in winter, murky in autumn. */}
        <rect x={0} y={isFlow ? TILE : 0} width={GW} height={GH} rx={10} fill={waterFill} />
        {frozen && (
          <g pointerEvents="none" transform={isFlow ? `translate(0, ${TILE})` : undefined}>
            {flecks.map((f, i) => (
              <rect key={i} x={f.x} y={f.y} width={f.w} height={2} fill="#f5faff" opacity={0.45} />
            ))}
          </g>
        )}
        {seasonId === 'autumn' && (
          <g pointerEvents="none" transform={isFlow ? `translate(0, ${TILE})` : undefined}>
            {leaves.map((l, i) => (
              <rect key={i} x={l.x} y={l.y} width={5} height={3} rx={1} fill={i % 2 ? '#c8853f' : '#a86a32'} opacity={0.8} />
            ))}
          </g>
        )}
        {isFlow && (
          <>
            {/* THE RAILS: pumps mount above the pond, drains below — water
                enters the top, flows through your plumbing, leaves the bottom. */}
            <rect x={0} y={0} width={GW} height={TILE - 4} rx={6} fill="#232b31" />
            <rect x={0} y={GH + TILE + 4} width={GW} height={TILE - 4} rx={6} fill="#232b31" />
          </>
        )}
        {(isFlow
          ? Array.from({ length: W.CANVAS.height + 2 }, (_, i) => i - 1)
          : Array.from({ length: W.CANVAS.height }, (_, i) => i)
        ).map((y) =>
          Array.from({ length: W.CANVAS.width }).map((_, x) => {
            const isRail = y === -1 || y === W.CANVAS.height;
            const px = x * TILE;
            const py = (y + (isFlow ? 1 : 0)) * TILE;
            const key = cellKey(x, y);
            const feat = featAt(x, y);
            const flow = flowAt(x, y);
            const live =
              flow && (flow.type === 'fountain' ? view.liveKeys.has(key) : view.poweredKeys.has(key));
            const meta = feat ? FEAT_META[feat.type] : null;
            const fmeta = flow ? FLOW_META[flow.type] : null;
            const blocked = terrainAt(x, y);
            if (isRail) {
              const railWants = y === -1 ? 'intake' : 'outflow';
              const armed = pick === railWants;
              const ry = y === -1 ? 2 : py + 5;
              return (
                <g key={key} onClick={() => onCell(x, y)} style={{ cursor: 'pointer' }}>
                  <rect
                    x={px + 4}
                    y={ry}
                    width={TILE - 8}
                    height={TILE - 12}
                    rx={4}
                    fill={flow ? '#2e3a42' : '#1c2429'}
                    stroke={armed && !flow ? '#7fd8e8' : '#324049'}
                    strokeWidth={armed && !flow ? 1.5 : 1}
                    strokeDasharray={flow ? undefined : '4 3'}
                  />
                  {flow && (
                    <image
                      href={waterSprite(flow.type)}
                      x={px + 10}
                      y={ry + 2}
                      width={TILE - 20}
                      height={TILE - 20}
                      opacity={live ? 1 : 0.55}
                      style={{ imageRendering: 'pixelated' }}
                    />
                  )}
                  {!flow && armed && (
                    <text x={px + TILE / 2} y={ry + (TILE - 12) / 2 + 4} textAnchor="middle" fontSize={13} fontWeight="bold" fill="#7fd8e8">
                      +
                    </text>
                  )}
                  {/* stub down into (or up out of) the pond when connected */}
                  {y === -1 && flow && flowAt(x, 0) && (
                    <rect x={px + TILE / 2 - 3} y={ry + TILE - 14} width={6} height={16} rx={2} fill={live ? '#7fd8e8' : '#3a5a68'} />
                  )}
                  {y === W.CANVAS.height && flow && flowAt(x, y - 1) && (
                    <rect x={px + TILE / 2 - 3} y={ry - 8} width={6} height={10} rx={2} fill={live ? '#7fd8e8' : '#3a5a68'} />
                  )}
                </g>
              );
            }
            return (
              <g
                key={key}
                onClick={blocked ? undefined : () => onCell(x, y)}
                style={{ cursor: blocked ? 'default' : 'pointer' }}
              >
                <rect
                  x={px + 1}
                  y={py + 1}
                  width={TILE - 2}
                  height={TILE - 2}
                  rx={4}
                  // 9c: the tiles wear the season (winter ices pale; the
                  // covered-vs-stagnant read survives every palette).
                  fill={
                    frozen
                      ? covered.has(key)
                        ? '#b7d6e6'
                        : (x + y) % 2
                          ? '#a4c6d9'
                          : '#98bcd1'
                      : covered.has(key)
                        ? '#1d4a55'
                        : seasonId === 'autumn'
                          ? (x + y) % 2
                            ? '#1c3d42'
                            : '#193740'
                          : (x + y) % 2
                            ? '#1a3a4c'
                            : '#173443'
                  }
                />
                {/* Terrain (Phase 5 juice, water assessment fix ③): a blocked
                    tile — rock or reeds, alternating for variety — never
                    placeable, drawn as scenery over the base tile. */}
                {blocked &&
                  ((x + y) % 2 === 0 ? (
                    <g>
                      <ellipse cx={px + TILE / 2} cy={py + TILE / 2 + 4} rx={16} ry={9} fill="#3a4248" />
                      <ellipse cx={px + TILE / 2 - 5} cy={py + TILE / 2 - 2} rx={11} ry={8} fill="#5a6268" />
                      <ellipse cx={px + TILE / 2 + 7} cy={py + TILE / 2 + 1} rx={7} ry={5} fill="#4a5258" />
                      <ellipse cx={px + TILE / 2 - 8} cy={py + TILE / 2 - 5} rx={3} ry={2} fill="#7a828a" opacity={0.7} />
                    </g>
                  ) : (
                    <g stroke="#4a7a5a" strokeWidth={2.5} strokeLinecap="round" fill="none">
                      <path d={`M ${px + TILE / 2 - 8} ${py + TILE - 10} Q ${px + TILE / 2 - 12} ${py + 12} ${px + TILE / 2 - 6} ${py + 8}`} />
                      <path d={`M ${px + TILE / 2} ${py + TILE - 8} Q ${px + TILE / 2 - 2} ${py + 8} ${px + TILE / 2 + 4} ${py + 6}`} />
                      <path d={`M ${px + TILE / 2 + 9} ${py + TILE - 10} Q ${px + TILE / 2 + 14} ${py + 14} ${px + TILE / 2 + 8} ${py + 10}`} />
                    </g>
                  ))}
                {/* provision feature (faded in circulation mode — context only) */}
                {feat && meta && (
                  <g opacity={isFlow ? 0.45 : 1}>
                    <image
                      href={waterSprite(feat.type)}
                      x={px + 5}
                      y={py + 3}
                      width={TILE - 10}
                      height={TILE - 10}
                      style={{ imageRendering: 'pixelated' }}
                    />
                    {/* freshness pip (circulation era) / provision value (layout) */}
                    <text x={px + TILE / 2} y={py + TILE - 9} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#0e2230" fontFamily="monospace">
                      {view.worksUnlocked && isFlow ? `${Math.round(feat.freshness * 100)}%` : feat.provision.toFixed(1)}
                    </text>
                    {view.worksUnlocked && feat.freshness < 0.999 && (
                      <rect x={px + 6} y={py + 6} width={TILE - 12} height={TILE - 12} rx={5} fill="none" stroke={freshColor(feat.freshness)} strokeWidth={2} />
                    )}
                    {/* upgrade level badge (top-right) once leveled */}
                    {(feat.level ?? 1) > 1 && (
                      <text x={px + TILE - 7} y={py + 13} textAnchor="end" fontSize={8} fontWeight="bold" fill="#fff4d6" fontFamily="monospace">
                        L{feat.level}
                      </text>
                    )}
                    {/* Build-mode upgrade hint (the YARD grammar, playtest ask
                        2026-07-11): with this feature's tool armed, clicking it
                        upgrades in place — so show the cost right on the tile,
                        green = affordable, red = not, MAX at the level cap. */}
                    {!isFlow && pick === feat.type && (() => {
                      const maxed = pondFeatureMaxed(feat);
                      const cost = pondFeatureUpgradeCost(state, x, y);
                      const ok = state.resources.eggs >= cost;
                      const col = maxed ? '#9a8a6a' : ok ? '#8fe388' : '#d95f5f';
                      const cx = px + TILE / 2;
                      const cy = py + TILE / 2;
                      const label = maxed ? 'MAX' : String(cost);
                      const w = Math.max(44, label.length * 7 + (maxed ? 14 : 22));
                      return (
                        <g pointerEvents="none">
                          <rect x={cx - w / 2} y={cy - 9} width={w} height={18} rx={4} fill="#16110b" opacity={0.82} />
                          {!maxed && (
                            <polygon
                              points={`${cx - w / 2 + 5},${cy + 4} ${cx - w / 2 + 9},${cy - 3} ${cx - w / 2 + 13},${cy + 4}`}
                              fill={col}
                            />
                          )}
                          <text
                            x={maxed ? cx : cx - w / 2 + 17}
                            y={cy + 4}
                            textAnchor={maxed ? 'middle' : 'start'}
                            fontSize={11}
                            fontWeight="bold"
                            fill={col}
                            fontFamily="monospace"
                          >
                            {label}
                          </text>
                        </g>
                      );
                    })()}
                  </g>
                )}
                {/* selection ring (layout mode) */}
                {!isFlow && selKey === key && (
                  <rect x={px + 3} y={py + 3} width={TILE - 6} height={TILE - 6} rx={6} fill="none" stroke="#fff4d6" strokeWidth={2} />
                )}
                {/* circulation feature */}
                {flow && fmeta && flow.type === 'pipe' && (
                  // AUTO-SHAPED PIPES (playtest): a pipe draws a timber channel
                  // ARM toward each connected neighbour (pumps above and drains
                  // below count), so corners, tees, crosses, and verticals all
                  // emerge from the layout — no fixed sprite orientation.
                  <g>
                    {(
                      [
                        [0, -1, 'N'],
                        [1, 0, 'E'],
                        [0, 1, 'S'],
                        [-1, 0, 'W'],
                      ] as const
                    ).map(([dx, dy, dir]) => {
                      if (!flowAt(x + dx, y + dy)) return null;
                      const cx = px + TILE / 2;
                      const cy = py + TILE / 2;
                      const wood = '#684628';
                      const water = live ? '#7fd8e8' : '#2e4e5e';
                      const L = TILE / 2;
                      return dy !== 0 ? (
                        <g key={dir}>
                          <rect x={cx - 7} y={dy < 0 ? py : cy} width={14} height={L} fill={wood} />
                          <rect x={cx - 4} y={dy < 0 ? py : cy} width={8} height={L} fill={water} />
                        </g>
                      ) : (
                        <g key={dir}>
                          <rect x={dx < 0 ? px : cx} y={cy - 7} width={L} height={14} fill={wood} />
                          <rect x={dx < 0 ? px : cx} y={cy - 4} width={L} height={8} fill={water} />
                        </g>
                      );
                    })}
                    {/* brass knuckle at the joint */}
                    <rect x={px + TILE / 2 - 8} y={py + TILE / 2 - 8} width={16} height={16} rx={3} fill="#c8a050" stroke="#96742f" strokeWidth={1.5} />
                    <rect x={px + TILE / 2 - 3} y={py + TILE / 2 - 3} width={6} height={6} rx={1} fill={live ? '#bef0f8' : '#3a5a68'} />
                  </g>
                )}
                {flow && fmeta && flow.type !== 'pipe' && (
                  <>
                    {/* Connection stubs toward adjacent flow pieces (+x/+y only,
                        so each junction draws once; pipe-to-pipe junctions are
                        handled by the pipes' own arms). */}
                    {flowAt(x + 1, y) && (
                      <rect x={px + TILE - 10} y={py + TILE / 2 - 3} width={20} height={6} rx={2} fill={live ? '#7fd8e8' : '#3a5a68'} opacity={0.9} />
                    )}
                    {flowAt(x, y + 1) && (
                      <rect x={px + TILE / 2 - 3} y={py + TILE - 10} width={6} height={20} rx={2} fill={live ? '#7fd8e8' : '#3a5a68'} opacity={0.9} />
                    )}
                    <image
                      href={waterSprite(flow.type)}
                      x={px + 8}
                      y={py + 8}
                      width={TILE - 16}
                      height={TILE - 16}
                      opacity={live ? 1 : 0.55}
                      style={{ imageRendering: 'pixelated' }}
                    />
                    <circle cx={px + TILE / 2} cy={py + TILE / 2} r={15} fill="none" stroke={live ? '#fff4d6' : '#5a6a70'} strokeWidth={live ? 2 : 1.5} strokeDasharray={live ? undefined : '3 3'} opacity={live ? 0.9 : 0.7} />
                  </>
                )}
              </g>
            );
          }),
        )}
        {/* Ambient pond swimmers (Phase 5 juice) — pure decoration, drawn on
            top of the tile grid; pointer-events off so they never intercept
            tile clicks. */}
        {duckImgs && (
          <g pointerEvents="none" transform={isFlow ? `translate(0, ${TILE})` : undefined}>
            {swimmers.map((sw) => {
              const frame = duckImgs[sw.color]?.[0] ?? duckImgs[sw.color]?.[1];
              if (!frame) return null;
              return (
                <g
                  key={sw.id}
                  className="waterduck-drift"
                  style={
                    {
                      '--wd-x1': `${sw.x1}px`,
                      '--wd-y1': `${sw.y1}px`,
                      '--wd-x2': `${sw.x2}px`,
                      '--wd-y2': `${sw.y2}px`,
                      animationDuration: `${sw.duration}s`,
                      animationDelay: `${sw.delay}s`,
                    } as CSSProperties
                  }
                >
                  <g
                    className="waterduck-bob"
                    style={{ animationDuration: `${sw.bobDuration}s`, animationDelay: `${sw.bobDelay}s` }}
                  >
                    <image
                      href={frame}
                      x={-SWIMMER_SIZE / 2}
                      y={-SWIMMER_SIZE / 2}
                      width={SWIMMER_SIZE}
                      height={SWIMMER_SIZE}
                      opacity={0.92}
                      style={{ imageRendering: 'pixelated' }}
                    />
                  </g>
                </g>
              );
            })}
          </g>
        )}
        {/* Spring rain (9c): a fixed streak pattern the CSS loops downward by
            one pond-height — seamless, and killed under reduced motion. */}
        {seasonId === 'spring' && (
          <g pointerEvents="none" transform={isFlow ? `translate(0, ${TILE})` : undefined}>
            <g className="water-rain">
              {rain.map((r, i) => (
                <g key={i}>
                  <line x1={r.x} y1={r.y} x2={r.x - 3} y2={r.y - 10} stroke="#9fd0ec" strokeWidth={1} opacity={0.38} />
                  <line x1={r.x} y1={r.y + GH} x2={r.x - 3} y2={r.y + GH - 10} stroke="#9fd0ec" strokeWidth={1} opacity={0.38} />
                  <line x1={r.x} y1={r.y + GH * 2} x2={r.x - 3} y2={r.y + GH * 2 - 10} stroke="#9fd0ec" strokeWidth={1} opacity={0.38} />
                </g>
              ))}
            </g>
          </g>
        )}
      </svg>

      {/* selected feature: upgrade (water scaler + egg sink) / remove */}
      {selected && (
        <div className="w-full rounded-md bg-[#13202a] px-3 py-2 ring-1 ring-[#27485a]">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold" style={{ color: FEAT_META[selected.type].color }}>
              <img src={waterSprite(selected.type)} alt="" className="h-4 w-4" style={{ imageRendering: 'pixelated' }} />
              {FEAT_META[selected.type].label} · Lv {selected.level ?? 1}
              {pondFeatureMaxed(selected) && <span className="text-[9px] font-normal text-[#7a9aa8]">(max)</span>}
            </span>
            <span className="text-[10px] tabular-nums text-[#7a9aa8]">
              +{selected.provision.toFixed(1)} water
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {W.FEATURES[selected.type].baseProvision > 0 ? (
              pondFeatureMaxed(selected) ? (
                <span className="flex-1 rounded bg-[#13202a] px-2 py-1.5 text-center text-[10px] text-[#5a7a8a]">
                  Max level — add another feature to grow provision
                </span>
              ) : (
                <button
                  onClick={() => {
                    if (engine.upgradePondFeature(selected.x, selected.y).ok) playUpgrade();
                  }}
                  disabled={state.resources.eggs < upgradeCost}
                  className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-[11px] font-bold transition ${
                    state.resources.eggs >= upgradeCost
                      ? 'bg-[#1f4a2a] text-[#bfe8a8] hover:bg-[#27583a]'
                      : 'cursor-not-allowed bg-[#13202a] text-[#5a7a8a]'
                  }`}
                  title={`Upgrade to Lv ${(selected.level ?? 1) + 1} of ${W.UPGRADE.levelCap} — ×${W.UPGRADE.provisionMult} water`}
                >
                  Upgrade → Lv {(selected.level ?? 1) + 1}
                  <span className="inline-flex items-center gap-0.5">
                    <EggIcon size={10} /> {upgradeCost}
                  </span>
                </button>
              )
            ) : (
              <span className="flex-1 rounded bg-[#13202a] px-2 py-1.5 text-center text-[10px] text-[#5a7a8a]">
                Feeds adjacent pools — not upgradeable
              </span>
            )}
            <button
              onClick={() => {
                if (engine.removePondFeature(selected.x, selected.y).ok) {
                  playPlace();
                  setSelKey(null);
                }
              }}
              className="rounded bg-[#3a1f1f] px-2.5 py-1.5 text-[11px] font-bold text-[#e88a8a] hover:bg-[#4a2a2a]"
              title="Remove (partial refund)"
            >
              Remove
            </button>
            <button
              onClick={() => setSelKey(null)}
              className="rounded px-2 py-1.5 text-[12px] leading-none text-[#7a9aa8] hover:text-[#dff]"
              aria-label="Deselect"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* provision vs requirement */}
      <div className="w-full rounded-md bg-[#13202a] px-3 py-2 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1 font-bold text-[#a8d0e8]">
            <WaterIcon size={12} /> Provision{' '}
            <span className="tabular-nums" style={{ color: statusColor(status) }}>
              {provision.toFixed(1)}
            </span>
            <span className="text-[9px] font-normal text-[#5a7a8a]">
              {' '}
              / need {requirement.toFixed(0)} ({state.ducks.length} ducks)
            </span>
          </span>
          {isFlow && (
            <span className="text-[10px] font-bold tabular-nums" style={{ color: freshColor(view.circulationHealth) }}>
              circulation {healthPct}%
            </span>
          )}
        </div>
      </div>

      {/* Dynamic, invited-upgrade prompt — the flock outgrowing its water should
          read as a celebratory nudge, never a silent amber bar. */}
      {isFlow ? (
        stagnating > 0 ? (
          <div className="w-full rounded-md bg-[#3a2a14] px-3 py-1.5 text-[10px] font-bold text-[#e8c45a]">
            {stagnating} feature{stagnating > 1 ? 's' : ''} going stagnant — pipe a line from an
            intake to an outflow so a pressurised fountain reaches {stagnating > 1 ? 'them' : 'it'}
            (each pump pair supplies {W.CIRCULATION.FOUNTAINS_PER_PUMP_PAIR} fountains), or provision
            coasts to the floor.
          </div>
        ) : (
          <div className="w-full rounded-md bg-[#13202a] px-3 py-1.5 text-[10px] text-[#7a9aa8]">
            {view.features.length === 0
              ? 'Build the Pond layout first — then circulate it here. A fountain only works on a line that connects an intake to an outflow.'
              : 'Pond fully circulated — every feature is held at peak. Pipes carry flow; each intake+outflow pair pressurises up to three fountains on its line.'}
          </div>
        )
      ) : outgrowing ? (
        <div className="w-full rounded-md bg-[#3a2a14] px-3 py-1.5 text-[10px] font-bold text-[#e8c45a]">
          Your flock is outgrowing the pond — add features (cluster for bonuses: pools beside a
          spring, plant beds beside your richest features) to give it more water.
        </div>
      ) : null}
    </div>
  );
}

/** The water build palette — rendered by App in the BUILD card below the
 *  board (the yard's layout), not inside the board column. Same card grammar
 *  as the yard's BuildBar; `pick` state lives in App. */
export function WaterBuildBar({
  state,
  mode,
  pick,
  onPick,
}: {
  state: GameState;
  mode: Mode;
  pick: PondFeatureType | FlowFeatureType | null;
  onPick: (t: PondFeatureType | FlowFeatureType | null) => void;
}) {
  const isFlow = mode === 'circulation';
  const setPick = onPick;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-bold uppercase tracking-wider text-[#9a8a6a]">
        Build — {isFlow ? 'circulation' : 'the pond'}
      </div>
      {/* Build palette — the yard BuildBar's grammar: cards with sprite, label,
          one-line hint, egg cost; select a tool, click water to place, click a
          MATCHING placed feature to upgrade in place, click the card to cancel. */}
      <div className="grid w-full grid-cols-12 gap-1.5">
        {(isFlow ? FLOW_TYPES : FEAT_TYPES).map((t) => {
          const meta = isFlow ? FLOW_META[t as FlowFeatureType] : FEAT_META[t as PondFeatureType];
          const cost = isFlow ? W.FLOW[t as FlowFeatureType].costEggs : W.FEATURES[t as PondFeatureType].costEggs;
          const active = pick === t;
          const affordable = state.resources.eggs >= cost;
          return (
            <button
              key={t}
              onClick={() => setPick(active ? null : t)}
              className={`col-span-3 flex flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition ${
                active ? 'border-[#fff4d6] bg-[#1a2c38]' : 'border-transparent bg-[#13202a] hover:bg-[#182835]'
              } ${affordable ? '' : 'opacity-50'}`}
            >
              <span className="flex w-full items-center gap-1.5">
                <img
                  src={waterSprite(t)}
                  alt=""
                  className="h-5 w-5 object-contain"
                  style={{ imageRendering: 'pixelated' }}
                />
                <span className="text-[11px] font-bold" style={{ color: meta.color }}>
                  {meta.label}
                </span>
              </span>
              <span className="text-[9px] text-[#7a9aa8]">{meta.hint}</span>
              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#ffe9a8]">
                <EggIcon size={10} /> {cost}
              </span>
            </button>
          );
        })}
      </div>
      <div className="text-[10px] text-[#7a6a4a]">
        {pick
          ? `Tap empty water to place a ${(isFlow ? FLOW_META[pick as FlowFeatureType] : FEAT_META[pick as PondFeatureType])?.label ?? ''} — or tap a matching placed feature to upgrade it in place. Click the card again to cancel.`
          : 'Pick a card, then tap water to place — or tap any placed feature to inspect, upgrade, or remove it. Cluster for bonuses: pools beside a spring, plant beds beside your richest features.'}
      </div>
    </div>
  );
}
