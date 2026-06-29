import { useState } from 'react';
import { BALANCE } from '../config/balance';
import type { GameEngine } from '../game/engine';
import { irrigationView, type PlotBand } from '../game/irrigation';
import { cellKey, type GameState } from '../game/state';
import { playPlace, playTend } from '../audio/sfx';
import { EggIcon, TendIcon, WaterIcon } from './icons';

const P = BALANCE.PASTURE;
const GRID = BALANCE.ZONES.BACK_PASTURE.tileRegionSize;
const TILE = 48;
const W = GRID.width * TILE;
const H = GRID.height * TILE;

const BAND_COLOR: Record<PlotBand, string> = {
  dry: '#d98a3a', // under-watered — wants more
  ideal: '#6fbf73', // sweet-spot
  over: '#6b6fd5', // waterlogged
};
const BAND_LABEL: Record<PlotBand, string> = { dry: 'dry', ideal: 'ideal', over: 'waterlogged' };

const isSource = (x: number, y: number) => x === P.SOURCE.x && y === P.SOURCE.y;

/**
 * The Back Pasture irrigation board. Renders the flow puzzle from GameState: lay
 * channels (tap dirt), tune valves (tap a branch), watch each plot's water vs its
 * sweet-spot band, and tend to clear drift. Replaces the build grid for this zone.
 */
export function IrrigationBoard({ engine, state }: { engine: GameEngine; state: GameState }) {
  const [selected, setSelected] = useState<string | null>(null);
  const view = irrigationView(state);
  const channels = state.irrigation.channels;
  const plotAt = (x: number, y: number) => view.plots.find((pl) => pl.x === x && pl.y === y);
  const flowAt = (x: number, y: number) => view.cellFlow[cellKey(x, y)] ?? 0;
  const isCh = (x: number, y: number) => cellKey(x, y) in channels || isSource(x, y);

  const onCell = (x: number, y: number) => {
    const key = cellKey(x, y);
    if (isSource(x, y) || plotAt(x, y) || key in channels) {
      setSelected(key); // select source / plot / channel to show its info + controls
      return;
    }
    if (engine.toggleChannel(x, y)) playPlace(); // lay a fresh channel on dirt
  };

  // A short connector toward each adjacent channel/source/plot so the network
  // reads as connected pipes.
  const connectors = (x: number, y: number) => {
    const cx = x * TILE + TILE / 2;
    const cy = y * TILE + TILE / 2;
    const dirs: [number, number][] = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    return dirs
      .filter(([dx, dy]) => isCh(x + dx, y + dy) || plotAt(x + dx, y + dy))
      .map(([dx, dy], i) => (
        <rect
          key={i}
          x={cx + dx * (TILE / 2) - 4 - (dx < 0 ? TILE / 2 - 4 : 0)}
          y={cy + dy * (TILE / 2) - 4 - (dy < 0 ? TILE / 2 - 4 : 0)}
          width={dx !== 0 ? TILE / 2 + 4 : 8}
          height={dy !== 0 ? TILE / 2 + 4 : 8}
          rx={2}
          fill="#3f7fb5"
        />
      ));
  };

  const incomePerMin = view.incomeRate * 60;
  const peakPerMin = view.peakRate * 60;
  const healthPct = Math.round(view.health * 100);
  const ofPeak = view.peakRate > 0 ? Math.round((view.incomeRate / view.peakRate) * 100) : 100;
  const healthColor = view.health >= 0.66 ? '#8fe388' : view.health >= 0.33 ? '#e8c45a' : '#e8835a';

  const sel = selected;
  const selCoords = sel ? (sel.split(',').map(Number) as [number, number]) : null;
  const selPlot = sel ? view.plots.find((pl) => cellKey(pl.x, pl.y) === sel) : undefined;
  const selIsSource = selCoords ? isSource(selCoords[0], selCoords[1]) : false;
  const selIsChannel = sel != null && sel in channels;
  const selIsValve = sel != null && view.valves.has(sel);

  return (
    <div className="flex flex-col items-center gap-2" style={{ width: W }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        shapeRendering="crispEdges"
        style={{ imageRendering: 'pixelated' }}
      >
        {/* board background */}
        <rect x={0} y={0} width={W} height={H} fill="#2e241a" />
        {Array.from({ length: GRID.height }).map((_, y) =>
          Array.from({ length: GRID.width }).map((_, x) => {
            const key = cellKey(x, y);
            const px = x * TILE;
            const py = y * TILE;
            const src = isSource(x, y);
            const plot = plotAt(x, y);
            const ch = key in channels;
            const valve = view.valves.has(key);
            const flow = flowAt(x, y);
            const intensity = Math.min(1, flow / P.SOURCE_FLOW);
            const isSel = sel === key;
            return (
              <g key={key} onClick={() => onCell(x, y)} style={{ cursor: 'pointer' }}>
                {/* dirt base */}
                <rect x={px + 1} y={py + 1} width={TILE - 2} height={TILE - 2} rx={3} fill={(x + y) % 2 ? '#41331f' : '#392d1b'} />
                {/* pipe connectors (behind the cell glyph) */}
                {(src || ch) && <g>{connectors(x, y)}</g>}
                {src && (
                  <>
                    <rect x={px + 6} y={py + 6} width={TILE - 12} height={TILE - 12} rx={4} fill="#2e6b8a" />
                    <circle cx={px + TILE / 2} cy={py + TILE / 2} r={6} fill="#a9d3f0" />
                  </>
                )}
                {ch && (
                  <rect
                    x={px + 8}
                    y={py + 8}
                    width={TILE - 16}
                    height={TILE - 16}
                    rx={4}
                    fill={`rgba(91,155,213,${0.35 + 0.6 * intensity})`}
                    stroke={valve ? '#ffe9a8' : 'none'}
                    strokeWidth={valve ? 2 : 0}
                  />
                )}
                {valve && (
                  <text x={px + TILE / 2} y={py + TILE / 2 + 3} textAnchor="middle" fontSize={9} fontWeight="bold" fill="#2a2018" fontFamily="monospace">
                    ⊟
                  </text>
                )}
                {plot && (
                  <>
                    <rect x={px + 4} y={py + 4} width={TILE - 8} height={TILE - 8} rx={4} fill="#23303a" stroke={BAND_COLOR[plot.band]} strokeWidth={2.5} />
                    {/* crop fill from the bottom */}
                    <rect
                      x={px + 7}
                      y={py + TILE - 7 - (TILE - 14) * Math.min(1, plot.crop)}
                      width={TILE - 14}
                      height={(TILE - 14) * Math.min(1, plot.crop)}
                      rx={2}
                      fill="#e2b94f"
                      opacity={0.85}
                    />
                    <text x={px + TILE / 2} y={py + TILE / 2 + 3} textAnchor="middle" fontSize={10} fontWeight="bold" fill={BAND_COLOR[plot.band]} fontFamily="monospace">
                      {plot.flow.toFixed(1)}
                    </text>
                  </>
                )}
                {isSel && <rect x={px + 1} y={py + 1} width={TILE - 2} height={TILE - 2} rx={3} fill="none" stroke="#fff4d6" strokeWidth={2} />}
              </g>
            );
          }),
        )}
      </svg>

      {/* Status: income + upkeep health + tend */}
      <div className="w-full rounded-md bg-[#1f1812] px-3 py-2 text-[11px]">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="inline-flex items-center gap-1 font-bold text-[#ffe9a8]">
            <EggIcon size={12} /> +{incomePerMin.toFixed(0)}/min
            <span className="text-[9px] font-normal text-[#7a6a4a]">
              ({ofPeak}% of peak {peakPerMin.toFixed(0)})
            </span>
          </span>
          <button
            onClick={() => {
              if (engine.tendPasture()) playTend();
            }}
            disabled={view.health >= 0.999}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-bold transition ${
              view.health < 0.999
                ? 'bg-[#2e6b3a] text-[#dfffd6] hover:bg-[#367a44]'
                : 'cursor-not-allowed bg-[#241c14] text-[#6a5a3a]'
            }`}
          >
            <TendIcon size={12} /> {view.health < 0.999 ? 'Tend (clear silt)' : 'Pristine'}
          </button>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#3a2e22]">
          <div className="h-full rounded-full transition-[width]" style={{ width: `${healthPct}%`, background: healthColor }} />
        </div>
      </div>

      {/* Selected-cell controls */}
      <div className="min-h-[34px] w-full rounded-md bg-[#1f1812] px-3 py-1.5 text-[11px] text-[#c9b88f]">
        {selPlot ? (
          <span>
            Plot · water <span className="font-bold tabular-nums" style={{ color: BAND_COLOR[selPlot.band] }}>{selPlot.flow.toFixed(1)}</span>{' '}
            <span style={{ color: BAND_COLOR[selPlot.band] }}>({BAND_LABEL[selPlot.band]})</span> · sweet-spot {P.PLOT_IDEAL_BAND[0]}–{P.PLOT_IDEAL_BAND[1]}
          </span>
        ) : selIsSource ? (
          <span>
            <span className="inline-flex items-center gap-1">
              <WaterIcon size={11} /> Source
            </span>{' '}
            · {P.SOURCE_FLOW} water to distribute through the channels
          </span>
        ) : selIsChannel ? (
          <div className="flex items-center gap-2">
            <span className="tabular-nums">Channel · flow {(view.cellFlow[sel!] ?? 0).toFixed(1)}</span>
            {selIsValve && (
              <label className="flex flex-1 items-center gap-1.5">
                <span className="text-[9px] text-[#7a6a4a]">split</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round((channels[sel!] ?? 0.5) * 100)}
                  onChange={(e) => {
                    const [vx, vy] = sel!.split(',').map(Number);
                    engine.setValveKnob(vx, vy, Number(e.target.value) / 100);
                  }}
                  className="flex-1 accent-[#6fbf73]"
                />
                <span className="w-8 text-right tabular-nums text-[#ffe9a8]">{Math.round((channels[sel!] ?? 0.5) * 100)}%</span>
              </label>
            )}
            <button
              onClick={() => {
                const [cx, cy] = sel!.split(',').map(Number);
                if (engine.toggleChannel(cx, cy)) {
                  playPlace();
                  setSelected(null);
                }
              }}
              className="rounded bg-[#3a2418] px-2 py-0.5 text-[10px] font-bold text-[#e8a35a] hover:bg-[#4a3020]"
            >
              Erase
            </button>
          </div>
        ) : (
          <span className="text-[#7a6a4a]">
            Tap dirt to lay a channel from the source · tap a plot/channel for details · tune valves
            to land each plot in its sweet-spot.
          </span>
        )}
      </div>
    </div>
  );
}
