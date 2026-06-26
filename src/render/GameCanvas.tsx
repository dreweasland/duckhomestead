import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { BALANCE, STATION_DEFS } from '../config/balance';
import type { GameEngine } from '../game/engine';
import type { Resource, Station } from '../game/state';

const TILE = 56;
const PAD = 16;
const W = BALANCE.GRID.width * TILE + PAD * 2;
const H = BALANCE.GRID.height * TILE + PAD * 2;

interface Props {
  engine: GameEngine;
  selectedId: string | null;
  onTileClick: (x: number, y: number) => void;
}

/** Resource fill colors for drawn (non-emoji) buffer chips. */
const RES_COLOR: Record<Resource, number> = {
  corn: 0xe2b94f,
  pellets: 0xb87333,
  eggs: 0xf5ecd8,
};

/**
 * PixiJS view of the bounded grid + stations. Renders FROM GameState every
 * frame (no game state lives here). Emits tile clicks back to React.
 */
export function GameCanvas({ engine, selectedId, onTileClick }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep latest selection available to the ticker without re-init.
  const selRef = useRef(selectedId);
  selRef.current = selectedId;

  useEffect(() => {
    let disposed = false;
    const app = new Application();
    const cleanups: Array<() => void> = [];

    app
      .init({ width: W, height: H, background: 0x2a2018, antialias: false })
      .then(() => {
        if (disposed) {
          app.destroy(true);
          return;
        }
        const host = hostRef.current;
        if (host) host.appendChild(app.canvas);

        const gridLayer = new Graphics();
        const stationLayer = new Container();
        const overlay = new Graphics();
        app.stage.addChild(gridLayer, stationLayer, overlay);

        // Static grid background.
        const drawGrid = () => {
          gridLayer.clear();
          for (let gy = 0; gy < BALANCE.GRID.height; gy++) {
            for (let gx = 0; gx < BALANCE.GRID.width; gx++) {
              const px = PAD + gx * TILE;
              const py = PAD + gy * TILE;
              const dark = (gx + gy) % 2 === 0;
              gridLayer
                .rect(px + 1, py + 1, TILE - 2, TILE - 2)
                .fill(dark ? 0x3a2e22 : 0x352a1f);
            }
          }
        };
        drawGrid();

        // Click -> tile.
        app.stage.eventMode = 'static';
        app.stage.hitArea = { contains: () => true } as never;
        const onPointer = (e: { global: { x: number; y: number } }) => {
          const gx = Math.floor((e.global.x - PAD) / TILE);
          const gy = Math.floor((e.global.y - PAD) / TILE);
          if (gx >= 0 && gy >= 0 && gx < BALANCE.GRID.width && gy < BALANCE.GRID.height) {
            onTileClick(gx, gy);
          }
        };
        app.stage.on('pointertap', onPointer);

        // Reusable per-station display objects keyed by id.
        const labelStyle = new TextStyle({ fontSize: 11, fill: 0xfff4d6, fontFamily: 'monospace' });
        const smallStyle = new TextStyle({ fontSize: 10, fill: 0xffe9a8, fontFamily: 'monospace' });

        const sprites = new Map<
          string,
          { c: Container; body: Graphics; ring: Graphics; lvl: Text; buf: Text }
        >();

        const makeSprite = (s: Station) => {
          const c = new Container();
          const body = new Graphics();
          const ring = new Graphics();
          const lvl = new Text({ text: '', style: smallStyle });
          const buf = new Text({ text: '', style: labelStyle });
          c.addChild(body, ring, lvl, buf);
          stationLayer.addChild(c);
          const entry = { c, body, ring, lvl, buf };
          sprites.set(s.id, entry);
          return entry;
        };

        let cartT = 0;

        const render = () => {
          const state = engine.state;
          const present = new Set<string>();

          for (const s of state.stations) {
            present.add(s.id);
            const def = STATION_DEFS[s.type];
            const entry = sprites.get(s.id) ?? makeSprite(s);
            const px = PAD + s.x * TILE;
            const py = PAD + s.y * TILE;
            entry.c.position.set(px, py);

            // Body.
            entry.body.clear();
            entry.body.roundRect(6, 6, TILE - 12, TILE - 12, 6).fill(def.color);
            // Cycle progress bar at the bottom of the tile.
            const cyc = def.cycleSeconds;
            const prog = Math.min(1, s.cycleProgress / cyc);
            entry.body
              .rect(6, TILE - 12, (TILE - 12) * prog, 4)
              .fill(0xfff4d6);

            // Selection / tend-cooldown ring.
            entry.ring.clear();
            if (selRef.current === s.id) {
              entry.ring.roundRect(2, 2, TILE - 4, TILE - 4, 8).stroke({ width: 2, color: 0xfff4d6 });
            }
            if (s.tendCooldownRemaining > 0) {
              const frac = 1 - s.tendCooldownRemaining / BALANCE.TEND_COOLDOWN_S;
              entry.ring.rect(6, 4, (TILE - 12) * frac, 2).fill(0x8fe388);
            } else {
              // Ready-to-tend pip.
              entry.ring.circle(TILE - 10, 10, 3).fill(0x8fe388);
            }

            entry.lvl.text = `L${s.level}`;
            entry.lvl.position.set(8, TILE - 24);

            // Buffer indicator: a small colored chip + count (no emoji). Each
            // station only ever buffers its own single output resource.
            let buffered = 0;
            let bufRes: Resource | null = null;
            for (const k of Object.keys(s.buffer) as Resource[]) {
              const amt = s.buffer[k] ?? 0;
              if (amt > 0) {
                buffered += amt;
                bufRes = k;
              }
            }
            if (bufRes) {
              entry.body.rect(9, 9, 6, 6).fill(RES_COLOR[bufRes]).stroke({ width: 1, color: 0x1a1410 });
              entry.buf.text = `${Math.floor(buffered)}`;
              entry.buf.position.set(18, 7);
            } else {
              entry.buf.text = '';
            }
          }

          // Remove sprites for deleted stations.
          for (const [id, entry] of sprites) {
            if (!present.has(id)) {
              entry.c.destroy({ children: true });
              sprites.delete(id);
            }
          }

          // Auto-Haul cart: a little cart that loops the placed stations once
          // unlocked — the visible sign the milestone changed how hauling works.
          overlay.clear();
          if (state.autoHaulUnlocked && state.stations.length > 0) {
            cartT += app.ticker.deltaMS / 1000;
            const stops = state.stations;
            const period = 1.1; // seconds per hop
            const idx = Math.floor(cartT / period) % stops.length;
            const next = (idx + 1) % stops.length;
            const f = (cartT % period) / period;
            const a = stops[idx];
            const b = stops[next];
            const ax = PAD + a.x * TILE + TILE / 2;
            const ay = PAD + a.y * TILE + TILE / 2;
            const bx = PAD + b.x * TILE + TILE / 2;
            const by = PAD + b.y * TILE + TILE / 2;
            const cx = ax + (bx - ax) * f;
            const cy = ay + (by - ay) * f;
            overlay.roundRect(cx - 7, cy - 5, 14, 10, 2).fill(0x6b4f9e);
            overlay.circle(cx - 4, cy + 5, 2.5).fill(0x2a2018);
            overlay.circle(cx + 4, cy + 5, 2.5).fill(0x2a2018);
          }
        };

        app.ticker.add(render);
        cleanups.push(() => app.ticker.remove(render));
      });

    return () => {
      disposed = true;
      for (const fn of cleanups) fn();
      app.destroy(true, { children: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  return <div ref={hostRef} className="inline-block leading-none" style={{ width: W, height: H }} />;
}

export const CANVAS_SIZE = { W, H, TILE, PAD };
