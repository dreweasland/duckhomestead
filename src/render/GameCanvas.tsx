import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js';
import { playPlace } from '../audio/sfx';
import { BALANCE, STATION_DEFS } from '../config/balance';
import { stationStatus } from '../game/actions';
import type { GameEngine } from '../game/engine';
import { isPondTile, stationAt, type Resource, type Station } from '../game/state';
import { GROUND_URLS, groundVariant, loadTextures, type GameTextures } from './assets';

const TILE = 56;
const PAD = 16;
// Station sprites fit within their tile; a little headroom keeps spinning mill
// sails from clipping on the top row.
const TOP_EXTRA = 14;
const OX = PAD;
const OY = PAD + TOP_EXTRA;
const W = BALANCE.GRID.width * TILE + PAD * 2;
const H = BALANCE.GRID.height * TILE + PAD * 2 + TOP_EXTRA;

interface Props {
  engine: GameEngine;
  selectedId: string | null;
  onTileClick: (x: number, y: number) => void;
}

/** Resource fill colors for drawn (non-emoji) buffer chips. */
const RES_COLOR: Record<Resource, number> = {
  corn: 0xe2b94f,
  peas: 0x7fae54,
  mealworms: 0xd9a07a,
  brewersYeast: 0xe8d9a0,
  oysterShell: 0xc9cdd2,
  pellets: 0xb87333,
  eggs: 0xf5ecd8,
};

/**
 * PixiJS view of the bounded grid + stations. Renders FROM GameState every
 * frame (no game state lives here). Emits tile clicks back to React.
 */
export function GameCanvas({ engine, selectedId, onTileClick }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep latest selection + click handler available to the long-lived Pixi
  // objects without re-running the init effect (which would rebuild the app).
  // Without these refs the pointer handler would close over the FIRST render's
  // onTileClick (where buildType was null), so placement never fired.
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const clickRef = useRef(onTileClick);
  clickRef.current = onTileClick;

  useEffect(() => {
    let disposed = false;
    const app = new Application();
    const cleanups: Array<() => void> = [];

    // app.init() is async; under React StrictMode the effect can be torn down
    // before it resolves. We must NOT destroy a half-initialized Application
    // (its plugins aren't wired yet — destroy() would throw). So teardown is
    // always chained off `ready` and runs only after init has fully resolved.
    const ready = app
      .init({ width: W, height: H, background: 0x2a2018, antialias: false })
      .then(async () => {
        if (disposed) return; // unmounted mid-init; cleanup will destroy.
        let textures: GameTextures = { stations: {}, millSails: null, ducks: [], ground: [], water: [] };
        try {
          textures = await loadTextures();
        } catch {
          /* fall back to placeholders */
        }
        if (disposed) return;

        const host = hostRef.current;
        if (host) host.appendChild(app.canvas);
        cleanups.push(() => app.canvas?.remove());

        const SCALE = TILE / 16; // all art is 16px; scale uniformly, no smoothing
        const gridLayer = new Container();
        const stationLayer = new Container();
        stationLayer.sortableChildren = true;
        const duckLayer = new Container(); // ambient ducks roam above the ground
        const overlay = new Graphics();
        const floatLayer = new Container(); // rising +XP feedback, on top
        app.stage.addChild(gridLayer, stationLayer, duckLayer, overlay, floatLayer);

        // Bounds the ducks wander within (inside the grass area).
        const fieldX0 = OX + 6, fieldX1 = OX + BALANCE.GRID.width * TILE - 6;
        const fieldY0 = OY + 6, fieldY1 = OY + BALANCE.GRID.height * TILE - 6;

        // Ground: real grass tiles when available, else a flat checker. Pond
        // tiles get animated water; the shore is drawn once around the region.
        const haveGround = textures.ground.some(Boolean);
        const haveWater = textures.water.some(Boolean);
        const waterTiles: Sprite[] = [];
        for (let gy = 0; gy < BALANCE.GRID.height; gy++) {
          for (let gx = 0; gx < BALANCE.GRID.width; gx++) {
            const px = OX + gx * TILE;
            const py = OY + gy * TILE;
            if (isPondTile(gx, gy) && haveWater) {
              const tile = new Sprite(textures.water[0]);
              tile.position.set(px, py);
              tile.scale.set(SCALE);
              gridLayer.addChild(tile);
              waterTiles.push(tile);
            } else if (haveGround) {
              const v = groundVariant(gx, gy, GROUND_URLS.length);
              const tex = textures.ground[v] ?? textures.ground.find(Boolean)!;
              const tile = new Sprite(tex);
              tile.position.set(px, py);
              tile.scale.set(SCALE);
              gridLayer.addChild(tile);
            } else {
              const g = new Graphics();
              g.rect(px + 1, py + 1, TILE - 2, TILE - 2).fill((gx + gy) % 2 === 0 ? 0x3a2e22 : 0x352a1f);
              gridLayer.addChild(g);
            }
          }
        }

        // Pond shore: a single rounded rim around the whole pond region.
        const pond = BALANCE.POND;
        const pondPx = { x: OX + pond.x * TILE, y: OY + pond.y * TILE, w: pond.w * TILE, h: pond.h * TILE };
        if (haveWater) {
          const shore = new Graphics();
          shore
            .roundRect(pondPx.x + 1, pondPx.y + 1, pondPx.w - 2, pondPx.h - 2, 10)
            .stroke({ width: 3, color: 0x2a567a, alignment: 0.5 });
          shore
            .roundRect(pondPx.x + 4, pondPx.y + 4, pondPx.w - 8, pondPx.h - 8, 8)
            .stroke({ width: 1, color: 0x9fd0ec, alpha: 0.35 });
          gridLayer.addChild(shore);
        }

        // Input: tap = select/place, double-tap a station = tend, drag a
        // station = move it. All derived from pointer down/move/up so the
        // gestures don't conflict (a drag is movement, taps are not).
        app.stage.eventMode = 'static';
        app.stage.hitArea = { contains: () => true } as never;
        const toTile = (g: { x: number; y: number }) => ({
          gx: Math.floor((g.x - OX) / TILE),
          gy: Math.floor((g.y - OY) / TILE),
        });
        const inBounds = (gx: number, gy: number) =>
          gx >= 0 && gy >= 0 && gx < BALANCE.GRID.width && gy < BALANCE.GRID.height;

        let lastTapId: string | null = null;
        let lastTapAt = 0;
        const DRAG_THRESH = 6;
        // Pointer-down state for the whole grid (so empty-tile taps still work).
        // `id` is set only when pressing a station; `dragging` only a station
        // can become true. Read by the render loop to follow the cursor and
        // show the drop target.
        let down: {
          id: string | null;
          sx: number;
          sy: number;
          px: number;
          py: number;
          dragging: boolean;
          gx: number;
          gy: number;
          valid: boolean;
        } | null = null;

        app.stage.on('pointerdown', (e) => {
          const { gx, gy } = toTile(e.global);
          if (!inBounds(gx, gy)) {
            down = null;
            return;
          }
          const st = stationAt(engine.state, gx, gy);
          down = { id: st?.id ?? null, sx: e.global.x, sy: e.global.y, px: e.global.x, py: e.global.y, dragging: false, gx, gy, valid: true };
        });

        app.stage.on('pointermove', (e) => {
          if (!down) return;
          down.px = e.global.x;
          down.py = e.global.y;
          // Only a press that started on a station turns into a drag.
          if (!down.dragging && down.id && Math.hypot(e.global.x - down.sx, e.global.y - down.sy) > DRAG_THRESH) {
            down.dragging = true;
          }
          if (down.dragging) {
            const { gx, gy } = toTile(e.global);
            down.gx = gx;
            down.gy = gy;
            const occ = inBounds(gx, gy) ? stationAt(engine.state, gx, gy) : undefined;
            down.valid = inBounds(gx, gy) && !isPondTile(gx, gy) && (!occ || occ.id === down.id);
          }
        });

        const endPointer = (e: { global: { x: number; y: number } }) => {
          const d = down;
          down = null;
          if (!d) return;
          if (d.dragging && d.id) {
            // Drop: relocate if the target tile is valid, else snap back.
            if (d.valid) {
              const r = engine.move(d.id, d.gx, d.gy);
              if (r.ok) playPlace();
            }
            return;
          }
          // A tap (no real movement): select / place, or tend on a quick second
          // tap of the same station.
          const { gx, gy } = toTile(e.global);
          if (!inBounds(gx, gy)) return;
          const st = stationAt(engine.state, gx, gy);
          const now = performance.now();
          if (st && lastTapId === st.id && now - lastTapAt < 350) {
            engine.tend(st.id);
            lastTapId = null;
            return;
          }
          lastTapId = st ? st.id : null;
          lastTapAt = now;
          clickRef.current(gx, gy);
        };
        app.stage.on('pointerup', endPointer);
        app.stage.on('pointerupoutside', endPointer);

        // Reusable per-station display objects keyed by id.
        const labelStyle = new TextStyle({ fontSize: 11, fill: 0xfff4d6, fontFamily: 'monospace' });
        const smallStyle = new TextStyle({ fontSize: 10, fill: 0xffe9a8, fontFamily: 'monospace' });

        const sprites = new Map<
          string,
          { c: Container; art: Sprite | null; sails: Sprite | null; body: Graphics; ring: Graphics; lvl: Text; buf: Text }
        >();

        const makeSprite = (s: Station) => {
          const c = new Container();
          // Real station art, bottom-anchored within the tile. Falls back to a
          // drawn block if the texture is missing.
          const tex = textures.stations[s.type];
          let art: Sprite | null = null;
          if (tex) {
            art = new Sprite(tex);
            art.anchor.set(0.5, 1);
            art.scale.set(SCALE);
            art.position.set(TILE / 2, TILE);
            c.addChild(art);
          }
          // Mill gets spinning sails mounted over the tower's hub (~6px down).
          let sails: Sprite | null = null;
          if (s.type === 'mill' && textures.millSails) {
            sails = new Sprite(textures.millSails);
            sails.anchor.set(0.5);
            sails.scale.set(SCALE);
            sails.position.set(TILE / 2, 6 * SCALE);
            c.addChild(sails);
          }
          const body = new Graphics();
          const ring = new Graphics();
          const lvl = new Text({ text: '', style: smallStyle });
          const buf = new Text({ text: '', style: labelStyle });
          c.addChild(body, ring, lvl, buf);
          stationLayer.addChild(c);
          const entry = { c, art, sails, body, ring, lvl, buf };
          sprites.set(s.id, entry);
          return entry;
        };

        let cartT = 0;
        let waterT = 0;
        let waterFrame = 0;
        const inPond = (x: number, y: number) =>
          x >= pondPx.x && x <= pondPx.x + pondPx.w && y >= pondPx.y && y <= pondPx.y + pondPx.h;
        // Cart entrance: play a one-time "arrival" when Auto-Haul unlocks this
        // session (not on load for a player who already has it).
        let prevAutoHaul = engine.state.autoHaulUnlocked;
        let arrivalT = -1;
        const ARRIVAL_DUR = 1.7;
        const drawCart = (cx: number, cy: number, scale: number) => {
          const w = 8 * scale, h = 6 * scale, r = 1.6 * scale;
          overlay.roundRect(cx - w, cy - h, w * 2, h * 2, 2 * scale).fill(0x6b4f9e);
          overlay.roundRect(cx - w + 1, cy - h + 1, w * 2 - 2, h, 1).fill(0x8a6fc0);
          // eggs riding along
          overlay.circle(cx - 2 * scale, cy - 1, 1.6 * scale).fill(0xf5ecd8);
          overlay.circle(cx + 2 * scale, cy - 1, 1.6 * scale).fill(0xf5ecd8);
          // wheels
          overlay.circle(cx - 4 * scale, cy + h, r).fill(0x2a2018);
          overlay.circle(cx + 4 * scale, cy + h, r).fill(0x2a2018);
        };

        // Floating "+XP" feedback at a tended tile, so the reward reads on the
        // board (no need to look at the panel). Fired by engine tend events.
        const floatStyle = new TextStyle({
          fontSize: 13,
          fontWeight: 'bold',
          fill: 0x8fe388,
          stroke: { color: 0x143010, width: 3 },
          fontFamily: 'monospace',
        });
        interface Float { txt: Text; age: number }
        const floats: Float[] = [];
        const unsubTend = engine.onTend((e) => {
          const s = engine.state.stations.find((st) => st.id === e.stationId);
          if (!s) return;
          const txt = new Text({ text: `+${e.xp} XP`, style: floatStyle });
          txt.anchor.set(0.5, 1);
          txt.position.set(OX + s.x * TILE + TILE / 2, OY + s.y * TILE + 6);
          floatLayer.addChild(txt);
          floats.push({ txt, age: 0 });
        });
        cleanups.push(() => unsubTend());

        // Ambient ducks: cosmetic only (not game state). A small flock that
        // grows with the number of coops and free-roams the grass.
        interface Duck { sp: Sprite; x: number; y: number; tx: number; ty: number; facing: number; frame: number; frameT: number; pause: number }
        const ducks: Duck[] = [];
        const DUCK_SCALE = SCALE * 0.78; // ducks read a touch smaller than tiles
        const rand = (a: number, b: number) => a + Math.random() * (b - a);
        const haveDucks = textures.ducks.some(Boolean);
        const spawnDuck = (): Duck => {
          const sp = new Sprite(textures.ducks[0]);
          sp.anchor.set(0.5, 1);
          sp.scale.set(DUCK_SCALE);
          duckLayer.addChild(sp);
          const x = rand(fieldX0, fieldX1), y = rand(fieldY0, fieldY1);
          return { sp, x, y, tx: rand(fieldX0, fieldX1), ty: rand(fieldY0, fieldY1), facing: 1, frame: 0, frameT: 0, pause: 0 };
        };

        const render = () => {
          const state = engine.state;
          const present = new Set<string>();

          for (const s of state.stations) {
            present.add(s.id);
            const def = STATION_DEFS[s.type];
            const entry = sprites.get(s.id) ?? makeSprite(s);
            const beingDragged = down?.dragging && down.id === s.id;
            if (beingDragged) {
              // Follow the cursor (tile-centered) and float above everything.
              entry.c.position.set(down!.px - TILE / 2, down!.py - TILE / 2);
              entry.c.zIndex = 10000;
            } else {
              entry.c.position.set(OX + s.x * TILE, OY + s.y * TILE);
              entry.c.zIndex = s.y; // lower rows paint over the buildings above
            }

            // Starved stations (missing inputs in central storage) are dimmed
            // so it's obvious why they aren't producing.
            const starved = !stationStatus(state, s).producing;
            entry.c.alpha = beingDragged ? 0.85 : starved ? 0.55 : 1;
            // Mill sails spin (slowly when starved) for a touch of life.
            if (entry.sails) entry.sails.rotation += (app.ticker.deltaMS / 1000) * (starved ? 0.3 : 1.4);

            // All HUD-ish overlays are drawn on dark backings so they stay
            // legible on top of the textured sprites.
            const DARK = { color: 0x16110b, alpha: 0.72 };
            entry.body.clear();
            if (!entry.art) {
              entry.body.roundRect(6, 6, TILE - 12, TILE - 12, 6).fill(def.color);
            }

            // Production progress bar along the bottom.
            const prog = Math.min(1, s.cycleProgress / def.cycleSeconds);
            entry.body.rect(5, TILE - 5, TILE - 10, 3).fill(DARK);
            entry.body.rect(5, TILE - 5, (TILE - 10) * prog, 3).fill(0xfff4d6);

            // Tend status, top-right: green dot when ready, recharge ring while
            // cooling down. Outlined for contrast.
            if (s.tendCooldownRemaining > 0) {
              const frac = 1 - s.tendCooldownRemaining / BALANCE.TEND_COOLDOWN_S;
              entry.body.rect(5, 4, TILE - 10, 4).fill(DARK);
              entry.body.rect(5, 4, (TILE - 10) * frac, 4).fill(0x6fb86a);
            } else {
              entry.body.circle(TILE - 9, 10, 5.5).fill(DARK);
              entry.body.circle(TILE - 9, 10, 3.5).fill(0x8fe388);
            }

            // Starved indicator, bottom-right amber dot.
            if (starved) {
              entry.body.circle(TILE - 9, TILE - 12, 5.5).fill(DARK);
              entry.body.circle(TILE - 9, TILE - 12, 3.5).fill(0xe8a35a);
            }

            // Level badge, bottom-left.
            entry.body.roundRect(4, TILE - 25, 21, 14, 3).fill(DARK);
            entry.lvl.text = `L${s.level}`;
            entry.lvl.position.set(8, TILE - 23);

            // Selection outline.
            entry.ring.clear();
            if (selRef.current === s.id) {
              entry.ring.roundRect(2, 2, TILE - 4, TILE - 4, 8).stroke({ width: 2, color: 0xfff4d6 });
            }

            // Buffer indicator, top-left: a colored chip + count on a dark badge.
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
              entry.body.roundRect(4, 4, 24, 13, 3).fill(DARK);
              entry.body.rect(7, 7, 7, 7).fill(RES_COLOR[bufRes]).stroke({ width: 1, color: 0x1a1410 });
              entry.buf.text = `${Math.floor(buffered)}`;
              entry.buf.position.set(16, 5);
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

          // Ducks: keep the flock sized to the homestead, then waddle them.
          if (haveDucks) {
            const coops = state.stations.filter((s) => s.type === 'coop').length;
            const want = Math.min(8, 2 + coops);
            while (ducks.length < want) ducks.push(spawnDuck());
            while (ducks.length > want) duckLayer.removeChild(ducks.pop()!.sp);

            const dt = Math.min(0.05, app.ticker.deltaMS / 1000);
            const SPEED = 16;
            for (const d of ducks) {
              if (d.pause > 0) {
                d.pause -= dt;
              } else {
                const dx = d.tx - d.x, dy = d.ty - d.y;
                const dist = Math.hypot(dx, dy);
                if (dist < 3) {
                  // Reached target: idle a beat, then pick a new spot. A third
                  // of the time they head for the pond (then bob/swim there).
                  d.pause = rand(0.4, 2.2);
                  if (haveWater && Math.random() < 0.33) {
                    d.tx = rand(pondPx.x + 8, pondPx.x + pondPx.w - 8);
                    d.ty = rand(pondPx.y + 8, pondPx.y + pondPx.h - 8);
                  } else {
                    d.tx = rand(fieldX0, fieldX1);
                    d.ty = rand(fieldY0, fieldY1);
                  }
                } else {
                  d.x += (dx / dist) * SPEED * dt;
                  d.y += (dy / dist) * SPEED * dt;
                  if (Math.abs(dx) > 0.5) d.facing = dx < 0 ? -1 : 1;
                  d.frameT += dt;
                  if (d.frameT > 0.18) {
                    d.frameT = 0;
                    d.frame ^= 1;
                    d.sp.texture = textures.ducks[d.frame] ?? textures.ducks[0];
                  }
                }
              }
              // Ducks sit lower (legs under the waterline) and bob when in the pond.
              const swimming = inPond(d.x, d.y);
              const bob = swimming ? Math.sin((waterT + d.x) * 3) * 1.5 : 0;
              d.sp.position.set(d.x, d.y + (swimming ? 6 : 0) + bob);
              d.sp.scale.x = d.facing * DUCK_SCALE; // mirror to face travel direction
              d.sp.zIndex = d.y;
            }
            duckLayer.sortableChildren = true;
          }

          // Animate pond water (shimmer) by swapping the two water frames.
          if (haveWater && waterTiles.length) {
            waterT += app.ticker.deltaMS / 1000;
            const f = Math.floor(waterT / 0.55) % 2;
            if (f !== waterFrame) {
              waterFrame = f;
              for (const t of waterTiles) t.texture = textures.water[f] ?? textures.water[0];
            }
          }

          // Advance floating +XP labels: rise and fade, then remove.
          {
            const dt = app.ticker.deltaMS / 1000;
            const LIFE = 0.9;
            for (let i = floats.length - 1; i >= 0; i--) {
              const f = floats[i];
              f.age += dt;
              f.txt.y -= 24 * dt;
              f.txt.alpha = Math.max(0, 1 - f.age / LIFE);
              if (f.age >= LIFE) {
                f.txt.destroy();
                floats.splice(i, 1);
              }
            }
          }

          // Auto-Haul cart: a little cart that loops the placed stations once
          // unlocked — the visible sign the milestone changed how hauling works.
          overlay.clear();

          // Drop-target highlight while dragging a station (green ok / red no).
          if (down?.dragging && inBounds(down.gx, down.gy)) {
            const tx = OX + down.gx * TILE;
            const ty = OY + down.gy * TILE;
            const col = down.valid ? 0x8fe388 : 0xd95f5f;
            overlay.roundRect(tx + 2, ty + 2, TILE - 4, TILE - 4, 6).fill({ color: col, alpha: 0.22 });
            overlay.roundRect(tx + 2, ty + 2, TILE - 4, TILE - 4, 6).stroke({ width: 2, color: col });
          }

          if (state.autoHaulUnlocked && !prevAutoHaul) arrivalT = 0; // just unlocked
          prevAutoHaul = state.autoHaulUnlocked;

          if (state.autoHaulUnlocked && state.stations.length > 0) {
            const dt = app.ticker.deltaMS / 1000;
            const stops = state.stations;

            if (arrivalT >= 0 && arrivalT < ARRIVAL_DUR) {
              // Entrance: roll in from offscreen-left to the first station.
              arrivalT += dt;
              const f = Math.min(1, arrivalT / ARRIVAL_DUR);
              const e = 1 - (1 - f) * (1 - f); // ease-out
              const tx = OX + stops[0].x * TILE + TILE / 2;
              const ty = OY + stops[0].y * TILE + TILE / 2;
              const cx = OX - 40 + (tx - (OX - 40)) * e;
              const cy = ty - Math.abs(Math.sin(f * Math.PI * 3)) * 4; // little hops
              // dust puffs trailing behind
              for (let p = 1; p <= 3; p++) {
                overlay.circle(cx - 10 * p, cy + 6, (4 - p) * (1 - f)).fill({ color: 0xc9b88f, alpha: 0.5 * (1 - f) });
              }
              drawCart(cx, cy, 1.25);
            } else {
              // Normal loop between stations.
              cartT += dt;
              const period = 1.1; // seconds per hop
              const idx = Math.floor(cartT / period) % stops.length;
              const next = (idx + 1) % stops.length;
              const f = (cartT % period) / period;
              const a = stops[idx];
              const b = stops[next];
              const ax = OX + a.x * TILE + TILE / 2;
              const ay = OY + a.y * TILE + TILE / 2;
              const bx = OX + b.x * TILE + TILE / 2;
              const by = OY + b.y * TILE + TILE / 2;
              drawCart(ax + (bx - ax) * f, ay + (by - ay) * f, 1);
            }
          }
        };

        app.ticker.add(render);
        cleanups.push(() => app.ticker.remove(render));
      });

    return () => {
      disposed = true;
      // Wait for init to settle, then tear down exactly once on a fully
      // initialized Application — avoids the ResizePlugin destroy crash.
      ready
        .then(() => {
          for (const fn of cleanups) fn();
          app.destroy(true, { children: true });
        })
        .catch(() => {
          /* init failed; nothing to destroy */
        });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  return <div ref={hostRef} className="inline-block leading-none" style={{ width: W, height: H }} />;
}

export const CANVAS_SIZE = { W, H, TILE, PAD };
