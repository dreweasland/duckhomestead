import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { pondFeatureUpgradeCost, pondView } from '../game/pond';
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
import { loadDuckTintImages } from '../render/assets';
import { CloseIcon, EggIcon, WaterIcon } from './icons';

const W = BALANCE.WATER;
const TILE = 52;
const GW = W.CANVAS.width * TILE;
const GH = W.CANVAS.height * TILE;

type Mode = 'layout' | 'circulation';

/** Per-browser "I've seen the help for this tab" flag (UI onboarding only — kept
 *  out of the game save so it never touches prestige/migration). */
const HELP_SEEN_KEY = (mode: Mode) => `duck-homestead-waterhelp-${mode}`;

const FEAT_META: Record<PondFeatureType, { label: string; color: string; tag: string }> = {
  spring: { label: 'Spring', color: '#52b6dc', tag: 'Sp' },
  bathingPool: { label: 'Bathing Pool', color: '#3f8fd0', tag: 'Ba' },
  plantBed: { label: 'Plant Bed', color: '#6fb04f', tag: 'Pl' },
  deepZone: { label: 'Deep Zone', color: '#2f5f8c', tag: 'Dp' },
};
const FLOW_META: Record<FlowFeatureType, { label: string; color: string; tag: string }> = {
  intake: { label: 'Intake', color: '#5ad0a0', tag: 'In' },
  fountain: { label: 'Fountain', color: '#7fd8e8', tag: 'Fn' },
  outflow: { label: 'Outflow', color: '#9a8a6a', tag: 'Out' },
};

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

const SWIMMER_SIZE = 22;
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
  intake: 'Where fresh water enters. A fountain needs one in its line.',
  fountain: `Keeps every tile within ${W.CIRCULATION.fountainCoverageRadius} (a ${2 * W.CIRCULATION.fountainCoverageRadius + 1}×${2 * W.CIRCULATION.fountainCoverageRadius + 1} area) fresh — but only when its line connects an intake to an outflow.`,
  outflow: 'Where stale water leaves — closes the circuit.',
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
  { x: 2, y: 2, type: 'intake' },
  { x: 3, y: 2, type: 'fountain' },
  { x: 4, y: 2, type: 'outflow' },
];

/** A small static diagram of the canvas (used only in the help sheet). */
function MiniGrid({ features, flow }: { features: PondFeature[]; flow?: FlowFeature[] }) {
  const T = 26;
  const w = W.CANVAS.width * T;
  const h = W.CANVAS.height * T;
  const featAt = (x: number, y: number) => features.find((f) => f.x === x && f.y === y);
  const flowAt = (x: number, y: number) => flow?.find((f) => f.x === x && f.y === y);
  return (
    <svg width={w} height={h} shapeRendering="crispEdges" style={{ imageRendering: 'pixelated' }}>
      <rect x={0} y={0} width={w} height={h} rx={6} fill="#163243" />
      {Array.from({ length: W.CANVAS.height }).map((_, y) =>
        Array.from({ length: W.CANVAS.width }).map((_, x) => {
          const px = x * T;
          const py = y * T;
          const feat = featAt(x, y);
          const fl = flowAt(x, y);
          return (
            <g key={`${x},${y}`}>
              <rect x={px + 1} y={py + 1} width={T - 2} height={T - 2} rx={3} fill={(x + y) % 2 ? '#1a3a4c' : '#173443'} />
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[88vh] w-full max-w-md overflow-y-auto rounded-xl bg-[#15242e] p-5 ring-2 ring-[#27485a]"
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
export function WaterBoard({ engine, state, mode }: { engine: GameEngine; state: GameState; mode: Mode }) {
  const isFlow = mode === 'circulation';
  const [pick, setPick] = useState<PondFeatureType | FlowFeatureType>(
    isFlow ? 'fountain' : 'bathingPool',
  );
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
  const featAt = (x: number, y: number) => featByKey.get(cellKey(x, y));
  const flowAt = (x: number, y: number) => flowByKey.get(cellKey(x, y));

  const provision = waterProvision(state);
  const requirement = flockRequirement(state);
  const access = waterAccess(state);
  const status = waterStatus(access);
  const healthPct = Math.round(view.circulationHealth * 100);
  const outgrowing = state.ducks.length > 0 && provision < requirement * 0.999;
  const stagnating = view.features.filter((f) => !f.covered && f.freshness < 0.85).length;

  // Ambient swimmers: recomputed only when the swimmer count or the pond's
  // feature LAYOUT changes — never on freshness/covered churn, which updates
  // every tick and would otherwise restart every drift animation constantly.
  const swimCount = swimmerCount(access, requirement);
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
      } else if (engine.placeFlowFeature(pick as FlowFeatureType, x, y).ok) playPlace();
    } else if (featAt(x, y)) {
      // Tap a placed feature to SELECT it (upgrade / remove live in the panel).
      setSelKey(cellKey(x, y));
    } else if (engine.placePondFeature(pick as PondFeatureType, x, y).ok) {
      playPlace();
      setSelKey(null);
    }
  };

  // The selected feature (layout mode only); cleared if it no longer exists.
  const selected = !isFlow && selKey ? featByKey.get(selKey) ?? null : null;
  const upgradeCost = selected ? pondFeatureUpgradeCost(state, selected.x, selected.y) : 0;

  return (
    <div className="flex flex-col items-center gap-2" style={{ width: GW }}>
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
        width={GW}
        height={GH}
        viewBox={`0 0 ${GW} ${GH}`}
        shapeRendering="crispEdges"
        style={{ imageRendering: 'pixelated' }}
      >
        {/* pond water base */}
        <rect x={0} y={0} width={GW} height={GH} rx={10} fill="#163243" />
        {Array.from({ length: W.CANVAS.height }).map((_, y) =>
          Array.from({ length: W.CANVAS.width }).map((_, x) => {
            const px = x * TILE;
            const py = y * TILE;
            const key = cellKey(x, y);
            const feat = featAt(x, y);
            const flow = flowAt(x, y);
            const live = flow && view.liveKeys.has(key);
            const meta = feat ? FEAT_META[feat.type] : null;
            const fmeta = flow ? FLOW_META[flow.type] : null;
            return (
              <g key={key} onClick={() => onCell(x, y)} style={{ cursor: 'pointer' }}>
                <rect
                  x={px + 1}
                  y={py + 1}
                  width={TILE - 2}
                  height={TILE - 2}
                  rx={4}
                  fill={covered.has(key) ? '#1d4a55' : (x + y) % 2 ? '#1a3a4c' : '#173443'}
                />
                {/* provision feature (faded in circulation mode — context only) */}
                {feat && meta && (
                  <g opacity={isFlow ? 0.45 : 1}>
                    <rect x={px + 6} y={py + 6} width={TILE - 12} height={TILE - 12} rx={5} fill={meta.color} />
                    <text x={px + TILE / 2} y={py + 20} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#0e2230" fontFamily="monospace">
                      {meta.tag}
                    </text>
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
                  </g>
                )}
                {/* selection ring (layout mode) */}
                {!isFlow && selKey === key && (
                  <rect x={px + 3} y={py + 3} width={TILE - 6} height={TILE - 6} rx={6} fill="none" stroke="#fff4d6" strokeWidth={2} />
                )}
                {/* circulation feature */}
                {flow && fmeta && (
                  <>
                    <circle cx={px + TILE / 2} cy={py + TILE / 2} r={12} fill={fmeta.color} opacity={live ? 1 : 0.5} stroke={live ? '#fff4d6' : '#5a6a70'} strokeWidth={live ? 2 : 1.5} strokeDasharray={live ? undefined : '3 3'} />
                    <text x={px + TILE / 2} y={py + TILE / 2 + 3} textAnchor="middle" fontSize={8} fontWeight="bold" fill="#0e2230" fontFamily="monospace">
                      {fmeta.tag}
                    </text>
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
          <g pointerEvents="none">
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
      </svg>

      {/* selected feature: upgrade (water scaler + egg sink) / remove */}
      {selected && (
        <div className="w-full rounded-md bg-[#13202a] px-3 py-2 ring-1 ring-[#27485a]">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold" style={{ color: FEAT_META[selected.type].color }}>
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: FEAT_META[selected.type].color }} />
              {FEAT_META[selected.type].label} · Lv {selected.level ?? 1}
            </span>
            <span className="text-[10px] tabular-nums text-[#7a9aa8]">
              +{selected.provision.toFixed(1)} water
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {W.FEATURES[selected.type].baseProvision > 0 ? (
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
                title={`Upgrade to Lv ${(selected.level ?? 1) + 1} — ×${W.UPGRADE.provisionMult} water`}
              >
                Upgrade → Lv {(selected.level ?? 1) + 1}
                <span className="inline-flex items-center gap-0.5">
                  <EggIcon size={10} /> {upgradeCost}
                </span>
              </button>
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

      {/* palette */}
      <div className="flex w-full flex-wrap gap-1">
        {(isFlow ? FLOW_TYPES : FEAT_TYPES).map((t) => {
          const meta = isFlow ? FLOW_META[t as FlowFeatureType] : FEAT_META[t as PondFeatureType];
          const cost = isFlow ? W.FLOW[t as FlowFeatureType].costEggs : W.FEATURES[t as PondFeatureType].costEggs;
          const active = pick === t;
          return (
            <button
              key={t}
              onClick={() => setPick(t)}
              className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-[10px] font-bold transition ${
                active ? 'ring-1 ring-[#fff4d6]' : 'opacity-80 hover:opacity-100'
              }`}
              style={{ background: '#13202a', color: meta.color }}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: meta.color }} />
              {meta.label}
              <span className="inline-flex items-center gap-0.5 text-[9px] text-[#7a9aa8]">
                <EggIcon size={9} />
                {cost}
              </span>
            </button>
          );
        })}
      </div>
      {/* Dynamic, invited-upgrade prompt — the flock outgrowing its water should
          read as a celebratory nudge, never a silent amber bar. */}
      {isFlow ? (
        stagnating > 0 ? (
          <div className="w-full rounded-md bg-[#3a2a14] px-3 py-1.5 text-[10px] font-bold text-[#e8c45a]">
            {stagnating} feature{stagnating > 1 ? 's' : ''} going stagnant — route intake → fountains
            → outflow so a live fountain reaches {stagnating > 1 ? 'them' : 'it'}, or provision coasts
            to the floor.
          </div>
        ) : (
          <div className="w-full rounded-md bg-[#13202a] px-3 py-1.5 text-[10px] text-[#7a9aa8]">
            {view.features.length === 0
              ? 'Build the Pond layout first — then circulate it here. A fountain only works on a line that connects an intake to an outflow.'
              : 'Pond fully circulated — every feature is held at peak. Tap to place; tap a flow piece to remove.'}
          </div>
        )
      ) : outgrowing ? (
        <div className="w-full rounded-md bg-[#3a2a14] px-3 py-1.5 text-[10px] font-bold text-[#e8c45a]">
          Your flock is outgrowing the pond — add features (cluster for bonuses: pools beside a
          spring, plant beds beside your richest features) to give it more water.
        </div>
      ) : (
        <div className="w-full rounded-md bg-[#13202a] px-3 py-1.5 text-[10px] text-[#7a9aa8]">
          Tap empty water to place; tap a feature to upgrade it (more water) or remove it. Cluster for
          bonuses: bathing pools beside a spring, plant beds beside your richest features.
        </div>
      )}
    </div>
  );
}
