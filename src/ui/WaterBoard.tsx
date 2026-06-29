import { useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { pondView } from '../game/pond';
import { flockRequirement, waterAccess, waterProvision, waterStatus } from '../game/water';
import { cellKey, type FlowFeatureType, type GameState, type PondFeatureType } from '../game/state';
import { playPlace } from '../audio/sfx';
import { EggIcon, WaterIcon } from './icons';

const W = BALANCE.WATER;
const TILE = 52;
const GW = W.CANVAS.width * TILE;
const GH = W.CANVAS.height * TILE;

type Mode = 'layout' | 'circulation';

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

function statusColor(s: ReturnType<typeof waterStatus>): string {
  return s === 'good' ? '#8fe388' : s === 'ok' ? '#e8c45a' : '#e8835a';
}
function freshColor(f: number): string {
  return f >= 0.85 ? '#8fe388' : f >= 0.6 ? '#e8c45a' : '#e8835a';
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
  const view = pondView(state);
  const featAt = (x: number, y: number) => view.features.find((f) => f.x === x && f.y === y);
  const flowAt = (x: number, y: number) => view.flow.find((f) => f.x === x && f.y === y);

  const provision = waterProvision(state);
  const requirement = flockRequirement(state);
  const access = waterAccess(state);
  const status = waterStatus(access);
  const healthPct = Math.round(view.circulationHealth * 100);
  const outgrowing = state.ducks.length > 0 && provision < requirement * 0.999;
  const stagnating = view.features.filter((f) => !f.covered && f.freshness < 0.85).length;

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
    } else {
      if (featAt(x, y)) {
        if (engine.removePondFeature(x, y).ok) playPlace();
      } else if (engine.placePondFeature(pick as PondFeatureType, x, y).ok) playPlace();
    }
  };

  return (
    <div className="flex flex-col items-center gap-2" style={{ width: GW }}>
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
                  </g>
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
      </svg>

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
          Tap to place; tap a feature to remove. Cluster for bonuses: bathing pools beside a spring,
          plant beds beside your richest features.
        </div>
      )}
    </div>
  );
}
