import { useEffect, useRef } from 'react';
import { Application, Container, Graphics, Sprite, Text, TextStyle, type Texture } from 'pixi.js';
import { playPlace } from '../audio/sfx';
import { STATION_DEFS, ZONE_DEFS, zoneDef, type StationType } from '../config/balance';
import { BALANCE } from '../config/balance';
import { producerMaxed, stationStatus, upgradeCost } from '../game/actions';
import type { GameEngine } from '../game/engine';
import { currentSeasonId, seasonsActive } from '../game/season';
import { isBlockedTile, phenotype, stationAt, type Color, type GameState, type Resource, type Station } from '../game/state';
import { GROUND_URLS, groundVariant, loadTextures, type GameTextures } from './assets';

const TILE = 56;
const PAD = 16;
// Station sprites fit within their tile; a little headroom keeps spinning mill
// sails from clipping on the top row.
const TOP_EXTRA = 14;
const OX = PAD;
const OY = PAD + TOP_EXTRA;

/** Pixel width of the widest zone's board. The board column is pinned to this so
 *  swapping to a narrower zone (pasture/pond are 6 wide vs the yard's 8) centers
 *  the canvas instead of shrinking the whole column. */
export const MAX_BOARD_WIDTH = Math.max(...ZONE_DEFS.map((z) => z.grid.width)) * TILE + PAD * 2;

interface Props {
  engine: GameEngine;
  selectedId: string | null;
  /** Which zone the board is currently showing/building in. */
  zoneId: string;
  /** Whether that zone is unlocked (locked ⇒ a dimmed, non-interactive tease). */
  unlocked: boolean;
  /** When a build type is selected, matching stations show their upgrade cost. */
  buildType: StationType | null;
  onTileClick: (x: number, y: number) => void;
}

/** Resource fill colors for drawn (non-emoji) buffer chips. */
const RES_COLOR: Record<Resource, number> = {
  corn: 0xe2b94f,
  peas: 0x7fae54,
  mealworms: 0xd9a07a,
  brewersYeast: 0xe8d9a0,
  oysterShell: 0xc9cdd2,
  sunflowerSeeds: 0xd9a441,
  fodderSprouts: 0x6fae7a,
  forage: 0x8fbf5a,
  pellets: 0xb87333,
  eggs: 0xf5ecd8,
};

/**
 * PixiJS view of one zone's grid + its stations. Renders FROM GameState every
 * frame (no game state lives here). Rebuilds when the active zone changes (the
 * grid dimensions / pond differ per zone). Emits tile clicks back to React.
 */
export function GameCanvas({ engine, selectedId, zoneId, unlocked, buildType, onTileClick }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const zone = zoneDef(zoneId) ?? ZONE_DEFS[0];
  const GRID = zone.grid;
  const W = GRID.width * TILE + PAD * 2;
  const H = GRID.height * TILE + PAD * 2 + TOP_EXTRA;

  // Keep latest selection + click handler available to the long-lived Pixi
  // objects without re-running the init effect (which would rebuild the app).
  // Without these refs the pointer handler would close over the FIRST render's
  // onTileClick (where buildType was null), so placement never fired.
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const clickRef = useRef(onTileClick);
  clickRef.current = onTileClick;
  const buildRef = useRef(buildType);
  buildRef.current = buildType;

  useEffect(() => {
    let disposed = false;
    const app = new Application();
    const cleanups: Array<() => void> = [];
    // A zone's `blocked` region is rendered as animated water with a shore (and
    // ducks swim in it) — fully generic over zones. The Yard's decorative pond
    // and the Pond zone's body of water (4d) both use this same path.
    const blocked = zone.blocked;
    const inBlocked = (gx: number, gy: number) =>
      !!blocked && gx >= blocked.x && gx < blocked.x + blocked.w && gy >= blocked.y && gy < blocked.y + blocked.h;

    // app.init() is async; under React StrictMode the effect can be torn down
    // before it resolves. We must NOT destroy a half-initialized Application
    // (its plugins aren't wired yet — destroy() would throw). So teardown is
    // always chained off `ready` and runs only after init has fully resolved.
    const ready = app
      // resolution: render at device density (capped — 2x is where the gain
      // flattens) so the small text (level badges, upgrade costs) stays crisp
      // on Retina and under CSS scaling. NOT autoDensity: that would inline
      // style the canvas to a fixed CSS size, fighting the .board-host rule
      // that lets the board shrink on narrow screens.
      .init({
        width: W,
        height: H,
        background: 0x2a2018,
        antialias: false,
        resolution: Math.min(2, window.devicePixelRatio || 1),
      })
      .then(async () => {
        if (disposed) return; // unmounted mid-init; cleanup will destroy.
        let textures: GameTextures = {
          stations: {},
          millSails: null,
          ducks: [],
          duckTints: { black: [], blue: [], splash: [] },
          ground: [],
          groundSnow: [],
          water: [],
        };
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
        // weatherLayer (9c): precipitation over the whole scene, under the
        // interaction overlay + floats so it never obscures feedback.
        const weatherLayer = new Graphics();
        app.stage.addChild(gridLayer, stationLayer, duckLayer, weatherLayer, overlay, floatLayer);
        // Locked zone: a dimmed silhouette tease (no stations, no input).
        gridLayer.alpha = unlocked ? 1 : 0.4;

        // Bounds the ducks wander within (inside the grass area).
        const fieldX0 = OX + 6, fieldX1 = OX + GRID.width * TILE - 6;
        const fieldY0 = OY + 6, fieldY1 = OY + GRID.height * TILE - 6;

        // Ground: real grass tiles when available, else a flat checker — SNOW
        // for winter zones (zoneDef.winter; Winterstead stood on grass until
        // playtest 2026-07-05). Blocked (pond) tiles get animated water.
        const groundSet = zoneDef(zoneId)?.winter ? textures.groundSnow : textures.ground;
        const haveGround = groundSet.some(Boolean);
        // 9c board dressing: the season re-textures/tints these live (see the
        // render loop's applySeason) — Winterstead stays permanent winter.
        const groundTiles: { sprite: Sprite; variant: number }[] = [];
        const haveWater = textures.water.some(Boolean);
        const waterTiles: Sprite[] = [];
        for (let gy = 0; gy < GRID.height; gy++) {
          for (let gx = 0; gx < GRID.width; gx++) {
            const px = OX + gx * TILE;
            const py = OY + gy * TILE;
            if (inBlocked(gx, gy) && haveWater) {
              const tile = new Sprite(textures.water[0]);
              tile.position.set(px, py);
              tile.scale.set(SCALE);
              gridLayer.addChild(tile);
              waterTiles.push(tile);
            } else if (haveGround) {
              const v = groundVariant(gx, gy, GROUND_URLS.length);
              const tex = groundSet[v] ?? groundSet.find(Boolean)!;
              const tile = new Sprite(tex);
              tile.position.set(px, py);
              tile.scale.set(SCALE);
              gridLayer.addChild(tile);
              groundTiles.push({ sprite: tile, variant: v }); // 9c visuals: seasons redress these
            } else {
              const g = new Graphics();
              g.rect(px + 1, py + 1, TILE - 2, TILE - 2).fill((gx + gy) % 2 === 0 ? 0x3a2e22 : 0x352a1f);
              gridLayer.addChild(g);
            }
          }
        }

        // Pond shore: a single rounded rim around the whole blocked region.
        const pondPx = blocked
          ? { x: OX + blocked.x * TILE, y: OY + blocked.y * TILE, w: blocked.w * TILE, h: blocked.h * TILE }
          : { x: 0, y: 0, w: 0, h: 0 };
        if (blocked && haveWater) {
          const shore = new Graphics();
          shore
            .roundRect(pondPx.x + 1, pondPx.y + 1, pondPx.w - 2, pondPx.h - 2, 10)
            .stroke({ width: 3, color: 0x2a567a, alignment: 0.5 });
          shore
            .roundRect(pondPx.x + 4, pondPx.y + 4, pondPx.w - 8, pondPx.h - 8, 8)
            .stroke({ width: 1, color: 0x9fd0ec, alpha: 0.35 });
          gridLayer.addChild(shore);
        }

        // Locked tease: a large padlock silhouette centered on the dim grid.
        if (!unlocked) {
          const lock = new Graphics();
          const cx = OX + (GRID.width * TILE) / 2;
          const cy = OY + (GRID.height * TILE) / 2;
          const s = TILE * 0.9;
          lock.roundRect(cx - s * 0.6, cy - s * 0.1, s * 1.2, s * 0.95, 8).fill({ color: 0x9a8a6a, alpha: 0.5 });
          lock
            .arc(cx, cy - s * 0.1, s * 0.42, Math.PI, 0)
            .stroke({ width: s * 0.18, color: 0x9a8a6a, alpha: 0.5 });
          lock.circle(cx, cy + s * 0.32, s * 0.12).fill({ color: 0x2a2018, alpha: 0.7 });
          app.stage.addChild(lock);
        }

        // Input: tap = select/place, double-tap a station = tend, drag a
        // station = move it. All derived from pointer down/move/up so the
        // gestures don't conflict (a drag is movement, taps are not). Disabled
        // entirely on a locked zone (it's a non-interactive tease).
        app.stage.eventMode = 'static';
        app.stage.hitArea = { contains: () => true } as never;
        const toTile = (g: { x: number; y: number }) => ({
          gx: Math.floor((g.x - OX) / TILE),
          gy: Math.floor((g.y - OY) / TILE),
        });
        const inBounds = (gx: number, gy: number) =>
          gx >= 0 && gy >= 0 && gx < GRID.width && gy < GRID.height;

        let lastTapId: string | null = null;
        let lastTapAt = 0;
        // Touch fingers wobble more than mice — a tap must not read as a
        // micro-drag (which would fire a same-tile "move" with its place SFX).
        const dragThresh = (pointerType: string) => (pointerType === 'touch' ? 14 : 6);
        // TOUCH MOVE MODE: drag-to-move loses to page scrolling on touch (the
        // browser claims the pan under touch-action: manipulation), so a touch
        // player LIFTS a station with a long-press instead — it hovers over its
        // tile until they tap the destination (or anywhere else to set it back
        // down). Desktop mouse drag is untouched.
        let armedMoveId: string | null = null;
        let longPress: ReturnType<typeof setTimeout> | null = null;
        const LONG_PRESS_MS = 450;
        const clearLongPress = () => {
          if (longPress != null) {
            clearTimeout(longPress);
            longPress = null;
          }
        };
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
          if (!unlocked) return;
          const { gx, gy } = toTile(e.global);
          if (!inBounds(gx, gy)) {
            down = null;
            return;
          }
          const st = stationAt(engine.state, gx, gy, zoneId);
          down = { id: st?.id ?? null, sx: e.global.x, sy: e.global.y, px: e.global.x, py: e.global.y, dragging: false, gx, gy, valid: true };
          // Touch: holding a station past the long-press window LIFTS it into
          // move mode; releasing or sliding first is a normal tap/scroll.
          if (e.pointerType === 'touch' && st && armedMoveId == null) {
            clearLongPress();
            longPress = setTimeout(() => {
              longPress = null;
              if (!down || down.id !== st.id || down.dragging) return;
              armedMoveId = st.id;
              down = null; // this press is consumed — its release must not select/tend
              (navigator as { vibrate?: (ms: number) => void }).vibrate?.(15);
            }, LONG_PRESS_MS);
          }
        });

        app.stage.on('pointermove', (e) => {
          if (!down) return;
          down.px = e.global.x;
          down.py = e.global.y;
          // Only a press that started on a station turns into a drag.
          if (
            !down.dragging &&
            down.id &&
            Math.hypot(e.global.x - down.sx, e.global.y - down.sy) > dragThresh(e.pointerType)
          ) {
            down.dragging = true;
            clearLongPress(); // real movement — this is a drag/scroll, not a hold
          }
          if (down.dragging) {
            const { gx, gy } = toTile(e.global);
            down.gx = gx;
            down.gy = gy;
            const occ = inBounds(gx, gy) ? stationAt(engine.state, gx, gy, zoneId) : undefined;
            down.valid = inBounds(gx, gy) && !isBlockedTile(zoneId, gx, gy) && (!occ || occ.id === down.id);
          }
        });

        const endPointer = (e: { global: { x: number; y: number } }) => {
          clearLongPress(); // released before the hold window — a normal tap
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
          // TOUCH MOVE MODE: a station is lifted — this tap is its destination.
          // A valid empty tile moves it; anywhere else just sets it back down.
          if (armedMoveId != null) {
            const armed = armedMoveId;
            armedMoveId = null;
            const { gx, gy } = toTile(e.global);
            if (!inBounds(gx, gy) || isBlockedTile(zoneId, gx, gy)) return;
            if (stationAt(engine.state, gx, gy, zoneId)) return;
            const r = engine.move(armed, gx, gy);
            if (r.ok) playPlace();
            return;
          }
          // A tap (no real movement): select / place, or tend on a quick second
          // tap of the same station.
          const { gx, gy } = toTile(e.global);
          if (!inBounds(gx, gy)) return;
          const st = stationAt(engine.state, gx, gy, zoneId);
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
        // Touch: when the browser claims the gesture for page scrolling
        // (touch-action: manipulation), the pointer stream ends in a CANCEL,
        // not an up. Drop the press cleanly or the drag ghost / drop target
        // sticks to the board until the next tap. (A LIFTED station stays
        // lifted — move mode is a mode, not a gesture; the next tap resolves it.)
        app.stage.on('pointercancel', () => {
          clearLongPress();
          down = null;
        });

        // Reusable per-station display objects keyed by id.
        const labelStyle = new TextStyle({ fontSize: 11, fill: 0xfff4d6, fontFamily: 'monospace' });
        const smallStyle = new TextStyle({ fontSize: 10, fill: 0xffe9a8, fontFamily: 'monospace' });

        // Template only — each station's `up` text gets its OWN clone, since its
        // fill is mutated per-station (affordable green / unaffordable red). Sharing
        // one instance made the last-rendered station's colour win for ALL of them
        // (green chevron, mismatched red cost).
        const upStyle = new TextStyle({ fontSize: 12, fontWeight: 'bold', fill: 0x8fe388, stroke: { color: 0x0f0b07, width: 3 }, fontFamily: 'monospace' });

        const sprites = new Map<
          string,
          { c: Container; art: Sprite | null; sails: Sprite | null; body: Graphics; ring: Graphics; lvl: Text; buf: Text; up: Text }
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
          const up = new Text({ text: '', style: upStyle.clone() });
          up.anchor.set(0.5);
          c.addChild(body, ring, lvl, buf, up);
          stationLayer.addChild(c);
          const entry = { c, art, sails, body, ring, lvl, buf, up };
          sprites.set(s.id, entry);
          return entry;
        };

        let cartT = 0;
        let waterT = 0;
        let waterFrame = 0;
        // Reused scratch buffers, refilled each frame — avoids allocating a fresh
        // array + Set on every 60fps tick (GC churn that grows with station count).
        const zoneStations: Station[] = [];
        const present = new Set<string>();
        const inPond = (x: number, y: number) =>
          pondPx.w > 0 && x >= pondPx.x && x <= pondPx.x + pondPx.w && y >= pondPx.y && y <= pondPx.y + pondPx.h;
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

        // Floating "+N" feedback at a tended/collected tile, so the reward reads
        // on the board (no need to look at the panel). A lone tend/collect pops
        // right at its station; several firing in the same frame (a Tend-All or
        // Collect-All sweep) collapse into ONE aggregate pop near the board
        // center instead of one overlapping pop per station.
        const XP_STYLE = new TextStyle({
          fontSize: 13,
          fontWeight: 'bold',
          fill: 0x8fe388,
          stroke: { color: 0x143010, width: 3 },
          fontFamily: 'monospace',
        });
        const XP_SUFFIX_STYLE = new TextStyle({
          fontSize: 11,
          fontWeight: 'bold',
          fill: 0x8fe388,
          stroke: { color: 0x143010, width: 2 },
          fontFamily: 'monospace',
        });
        // MASTER TEND crit pops — gold, unmissable.
        const CRIT_STYLE = new TextStyle({
          fontSize: 12,
          fontWeight: 'bold',
          fill: 0xffd23f,
          stroke: { color: 0x3a2000, width: 3 },
        });
        const RES_STYLE = new TextStyle({
          fontSize: 13,
          fontWeight: 'bold',
          fill: 0xffe9a8,
          stroke: { color: 0x2a2018, width: 3 },
          fontFamily: 'monospace',
        });

        // A drawn (not emoji) resource glyph: a small egg for eggs, a tinted
        // pip for anything else.
        const makeResIcon = (resource: Resource): Graphics => {
          const g = new Graphics();
          if (resource === 'eggs') {
            g.ellipse(0, 0, 3.2, 4.2).fill(0xf5ecd8);
            g.ellipse(-1, -1.3, 1, 1.3).fill({ color: 0xffffff, alpha: 0.5 });
          } else {
            g.roundRect(-3.5, -3.5, 7, 7, 1.5).fill(RES_COLOR[resource] ?? 0xffe9a8);
          }
          return g;
        };
        const fmtPop = (n: number): string => {
          const r = Math.round(n);
          return Math.abs(r) >= 1000 ? `${(r / 1000).toFixed(1)}k` : `${r}`;
        };
        // The single resource a pop leads with — eggs if any landed (the
        // player's core currency), else whichever amount is largest.
        const primaryResource = (
          map: Partial<Record<Resource, number>> | undefined,
        ): [Resource | undefined, number] => {
          if (!map) return [undefined, 0];
          if ((map.eggs ?? 0) > 0) return ['eggs', map.eggs ?? 0];
          let best: Resource | undefined;
          let bestAmt = 0;
          for (const key of Object.keys(map) as Resource[]) {
            const amt = map[key] ?? 0;
            if (amt > bestAmt) {
              best = key;
              bestAmt = amt;
            }
          }
          return [best, bestAmt];
        };

        interface Float { obj: Container; age: number; life: number }
        const floats: Float[] = [];
        const spawnPop = (
          x: number,
          y: number,
          resource: Resource | undefined,
          amount: number,
          xp: number | undefined,
          life = 0.9,
          crit = false,
        ) => {
          const showRes = resource !== undefined && Math.round(amount) > 0;
          const showXp = !!xp && xp > 0;
          if (!showRes && !showXp) return;
          const segs: { node: Container; w: number; icon: boolean }[] = [];
          if (crit) {
            const t = new Text({ text: 'CRIT ×2', style: CRIT_STYLE });
            segs.push({ node: t, w: t.width + 4, icon: false });
          }
          if (showRes) {
            segs.push({ node: makeResIcon(resource!), w: 9, icon: true });
            const t = new Text({ text: `+${fmtPop(amount)}`, style: RES_STYLE });
            t.anchor.set(0, 0.5);
            segs.push({ node: t, w: t.width + 6, icon: false });
          }
          if (showXp) {
            const t = new Text({ text: `+${Math.round(xp!)} XP`, style: showRes ? XP_SUFFIX_STYLE : XP_STYLE });
            t.anchor.set(0, 0.5);
            segs.push({ node: t, w: t.width, icon: false });
          }
          const total = segs.reduce((a, s) => a + s.w, 0);
          const c = new Container();
          let cx = -total / 2;
          for (const seg of segs) {
            seg.node.position.x = seg.icon ? cx + 4.5 : cx;
            c.addChild(seg.node);
            cx += seg.w;
          }
          c.position.set(x, y);
          floatLayer.addChild(c);
          floats.push({ obj: c, age: 0, life });
        };

        interface PendingPop {
          crit?: boolean;
          stationId?: string;
          xp?: number;
          resources?: Partial<Record<Resource, number>>;
        }
        let pending: PendingPop[] = [];
        const unsubTend = engine.onTend((e) => {
          const s = engine.state.stations.find((st) => st.id === e.stationId);
          if (!s || s.zoneId !== zoneId) return; // only pop on the visible zone
          pending.push({ stationId: e.stationId, xp: e.xp, resources: e.burst, crit: e.crit });
        });
        cleanups.push(() => unsubTend());
        const unsubCollect = engine.onCollect((e) => {
          if (e.stationId) {
            const s = engine.state.stations.find((st) => st.id === e.stationId);
            if (!s || s.zoneId !== zoneId) return; // only pop on the visible zone
          } // no stationId ⇒ a Collect-All sweep; show regardless of zone
          pending.push({ stationId: e.stationId, resources: e.resources });
        });
        cleanups.push(() => unsubCollect());

        // Ambient ducks: cosmetic only (not game state). A small flock that
        // grows with the number of coops in THIS zone and free-roams the grass.
        interface Duck { sp: Sprite; x: number; y: number; tx: number; ty: number; facing: number; frame: number; frameT: number; pause: number; color: Color | null }
        const ducks: Duck[] = [];
        const DUCK_SCALE = SCALE * 0.78; // ducks read a touch smaller than tiles
        const rand = (a: number, b: number) => a + Math.random() * (b - a);
        const haveDucks = textures.ducks.some(Boolean);
        // Each ambient duck takes a colour sampled from the real flock, so the
        // wanderers read as the player's blue/black/splash Swedish ducks (or the
        // yellow base when there's no flock).
        const pickFlockColor = (): Color | null => {
          const flock = engine.state.ducks;
          if (flock.length === 0) return null;
          return phenotype(flock[Math.floor(Math.random() * flock.length)].genotype);
        };
        const frameTex = (color: Color | null, frame: number): Texture => {
          const tinted = color ? textures.duckTints[color]?.[frame] : undefined;
          return tinted ?? textures.ducks[frame] ?? textures.ducks[0];
        };
        const spawnDuck = (): Duck => {
          const color = pickFlockColor();
          const sp = new Sprite(frameTex(color, 0));
          sp.anchor.set(0.5, 1);
          sp.scale.set(DUCK_SCALE);
          duckLayer.addChild(sp);
          const x = rand(fieldX0, fieldX1), y = rand(fieldY0, fieldY1);
          return { sp, x, y, tx: rand(fieldX0, fieldX1), ty: rand(fieldY0, fieldY1), facing: 1, frame: 0, frameT: 0, pause: 0, color };
        };

        // ── 9c board dressing: the yard wears the season ─────────────────
        // Winter re-textures the grass with the baked snow set; autumn tints
        // it toward brown; spring gets the faintest fresh cast (the rain is
        // its real signal); summer is the baseline. Winterstead zones are
        // permanent winter and never re-dress. Cheap: a string compare per
        // frame, real work only on the transition frame.
        const isWinterZone = !!zoneDef(zoneId)?.winter;
        let dressedSeason = '';
        const SEASON_TINT: Record<string, number> = {
          spring: 0xf2ffe8,
          summer: 0xffffff,
          autumn: 0xdda76a,
          winter: 0xffffff, // snow textures carry it
        };
        const applySeason = (state: GameState) => {
          if (isWinterZone || !haveGround || groundTiles.length === 0) return 'summer';
          const id = seasonsActive(state) ? currentSeasonId(state) : 'summer';
          if (id !== dressedSeason) {
            dressedSeason = id;
            const snow = id === 'winter' && textures.groundSnow.some(Boolean);
            const set = snow ? textures.groundSnow : textures.ground;
            for (const { sprite, variant } of groundTiles) {
              sprite.texture = set[variant] ?? set.find(Boolean)!;
              sprite.tint = SEASON_TINT[id] ?? 0xffffff;
            }
            // The decorative pond ices over in winter (pale, desaturated),
            // warms back up the rest of the year.
            for (const w of waterTiles) w.tint = id === 'winter' ? 0xcfe8f5 : 0xffffff;
          }
          return id;
        };

        // Precipitation particles (spring drizzle / winter snowfall). Honors
        // the OS reduce-motion setting — the ground dressing alone carries the
        // season there. Pooled plain objects, one Graphics redraw per frame.
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        const fieldW = GRID.width * TILE;
        const fieldH = GRID.height * TILE;
        const flakes = Array.from({ length: 42 }, () => ({
          x: Math.random() * fieldW,
          y: Math.random() * fieldH,
          spd: 0.7 + Math.random() * 0.6,
          phase: Math.random() * Math.PI * 2,
        }));
        let weatherT = 0;
        const drawWeather = (seasonId: string, dt: number) => {
          weatherLayer.clear();
          if (reduceMotion || isWinterZone || !unlocked) return;
          if (seasonId !== 'spring' && seasonId !== 'winter') return;
          weatherT += dt;
          if (seasonId === 'spring') {
            // A gentle slanted drizzle — April on the yard.
            for (const f of flakes) {
              f.y += 240 * f.spd * dt;
              f.x += 55 * f.spd * dt;
              if (f.y > fieldH) {
                f.y -= fieldH;
                f.x = Math.random() * fieldW;
              }
              const x = OX + (f.x % fieldW);
              const y = OY + f.y;
              weatherLayer
                .moveTo(x, y)
                .lineTo(x - 2, y - 8)
                .stroke({ width: 1, color: 0x9fd0ec, alpha: 0.4 });
            }
          } else {
            // Winter: slow drifting flakes.
            for (const f of flakes) {
              f.y += 26 * f.spd * dt;
              if (f.y > fieldH) {
                f.y -= fieldH;
                f.x = Math.random() * fieldW;
              }
              const x = OX + ((f.x + Math.sin(weatherT * 1.4 + f.phase) * 7 + fieldW) % fieldW);
              weatherLayer.rect(x, OY + f.y, 2, 2).fill({ color: 0xf5faff, alpha: 0.85 });
            }
          }
        };

        const render = () => {
          const state = engine.state;
          overlay.clear();
          // Locked tease: nothing to simulate on the board.
          if (!unlocked) return;
          drawWeather(applySeason(state), app.ticker.deltaMS / 1000);

          // Refill the scratch buffers for this zone in a single pass (also counts
          // coops for the duck flock-size below — no extra filter alloc).
          zoneStations.length = 0;
          present.clear();
          let coops = 0;
          for (const s of state.stations) {
            if (s.zoneId !== zoneId) continue;
            zoneStations.push(s);
            if (s.type === 'coop') coops++;
          }

          for (const s of zoneStations) {
            present.add(s.id);
            const def = STATION_DEFS[s.type];
            const entry = sprites.get(s.id) ?? makeSprite(s);
            const beingDragged = down?.dragging && down.id === s.id;
            const lifted = armedMoveId === s.id; // touch long-press move mode
            if (beingDragged) {
              // Follow the cursor (tile-centered) and float above everything.
              entry.c.position.set(down!.px - TILE / 2, down!.py - TILE / 2);
              entry.c.zIndex = 10000;
            } else if (lifted) {
              // Hover-bob over its own tile until the player taps a destination.
              const bob = Math.sin(performance.now() / 160) * 2.5;
              entry.c.position.set(OX + s.x * TILE, OY + s.y * TILE - 7 + bob);
              entry.c.zIndex = 10000;
            } else {
              entry.c.position.set(OX + s.x * TILE, OY + s.y * TILE);
              entry.c.zIndex = s.y; // lower rows paint over the buildings above
            }

            // Starved stations (missing inputs in central storage) are dimmed
            // so it's obvious why they aren't producing.
            const starved = !stationStatus(state, s).producing;
            entry.c.alpha = beingDragged || lifted ? 0.85 : starved ? 0.55 : 1;
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

            // Level badge, bottom-left — a capped producer reads MAX, not its level.
            const maxed = producerMaxed(s);
            entry.body.roundRect(4, TILE - 25, 21, 14, 3).fill(DARK);
            entry.lvl.text = maxed ? 'MAX' : `L${s.level}`;
            entry.lvl.position.set(maxed ? 6 : 8, TILE - 23);

            // Niacin leg-debuff marker (red medical badge), top-center.
            if (s.debuffed) {
              const bx = TILE / 2;
              entry.body.circle(bx, 9, 6).fill(DARK);
              entry.body.circle(bx, 9, 4.5).fill(0xd95f5f);
              entry.body.rect(bx - 2.5, 8.3, 5, 1.4).fill(0xffffff);
              entry.body.rect(bx - 0.7, 6.5, 1.4, 5).fill(0xffffff);
            }

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

            // Build-mode upgrade hint: when this station's type is selected in the
            // Build bar, show its own upgrade cost (green = affordable, red = not),
            // since clicking it will upgrade in place.
            if (buildRef.current === s.type) {
              const cx = TILE / 2;
              const cy = TILE / 2 + 2;
              entry.body.roundRect(cx - 20, cy - 9, 40, 18, 4).fill({ color: 0x16110b, alpha: 0.82 });
              if (maxed) {
                // Capped — no upgrade to offer, so show MAX (no cost, no chevron).
                entry.up.text = 'MAX';
                entry.up.style.fill = 0x9a8a6a;
                entry.up.position.set(cx - 11, cy);
              } else {
                const cost = upgradeCost(s);
                const ok = state.resources.eggs >= cost;
                // up-chevron
                const col = ok ? 0x8fe388 : 0xd95f5f;
                entry.body.poly([cx - 12, cy + 3, cx - 8, cy - 4, cx - 4, cy + 3]).fill(col);
                entry.up.text = `${cost}`;
                entry.up.style.fill = col;
                entry.up.position.set(cx + 5, cy);
              }
            } else {
              entry.up.text = '';
            }
          }

          // Remove sprites for deleted/relocated-away stations.
          for (const [id, entry] of sprites) {
            if (!present.has(id)) {
              entry.c.destroy({ children: true });
              sprites.delete(id);
            }
          }

          // Ducks: keep the flock sized to this zone's coops, then waddle them.
          if (haveDucks) {
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
                  if (haveWater && pondPx.w > 0 && Math.random() < 0.33) {
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
                    d.sp.texture = frameTex(d.color, d.frame);
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

          // Drain this frame's queued tend/collect pops: a lone event pops at
          // its station tile; several arriving in one frame (a Tend-All /
          // Collect-All sweep) collapse into ONE aggregate pop at the board
          // center instead of one per station.
          if (pending.length === 1 && pending[0].stationId) {
            const p = pending[0];
            const s = zoneStations.find((st) => st.id === p.stationId);
            if (s) {
              const [resource, amount] = primaryResource(p.resources);
              spawnPop(OX + s.x * TILE + TILE / 2, OY + s.y * TILE + 6, resource, amount, p.xp, p.crit ? 1.2 : 0.9, p.crit);
            }
          } else if (pending.length > 0) {
            let xp = 0;
            const totals: Partial<Record<Resource, number>> = {};
            let anyCrit = false;
            for (const p of pending) {
              anyCrit = anyCrit || !!p.crit;
              xp += p.xp ?? 0;
              for (const key of Object.keys(p.resources ?? {}) as Resource[]) {
                totals[key] = (totals[key] ?? 0) + (p.resources?.[key] ?? 0);
              }
            }
            const [resource, amount] = primaryResource(totals);
            spawnPop(OX + (GRID.width * TILE) / 2, OY + (GRID.height * TILE) / 2, resource, amount, xp, anyCrit ? 1.3 : 1.1, anyCrit);
          }
          pending = [];

          // Advance floating pops: rise and fade, then remove.
          {
            const dt = app.ticker.deltaMS / 1000;
            for (let i = floats.length - 1; i >= 0; i--) {
              const f = floats[i];
              f.age += dt;
              f.obj.y -= 24 * dt;
              f.obj.alpha = Math.max(0, 1 - f.age / f.life);
              if (f.age >= f.life) {
                f.obj.destroy({ children: true });
                floats.splice(i, 1);
              }
            }
          }

          // Drop-target highlight while dragging a station (green ok / red no).
          if (down?.dragging && inBounds(down.gx, down.gy)) {
            const tx = OX + down.gx * TILE;
            const ty = OY + down.gy * TILE;
            const col = down.valid ? 0x8fe388 : 0xd95f5f;
            overlay.roundRect(tx + 2, ty + 2, TILE - 4, TILE - 4, 6).fill({ color: col, alpha: 0.22 });
            overlay.roundRect(tx + 2, ty + 2, TILE - 4, TILE - 4, 6).stroke({ width: 2, color: col });
          }

          // Auto-Haul cart: loops THIS zone's stations once unlocked — the
          // visible sign the milestone changed how hauling works.
          if (state.autoHaulUnlocked && !prevAutoHaul) arrivalT = 0; // just unlocked
          prevAutoHaul = state.autoHaulUnlocked;

          if (state.autoHaulUnlocked && zoneStations.length > 0) {
            const dt = app.ticker.deltaMS / 1000;
            const stops = zoneStations;

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
  }, [engine, zoneId, unlocked]);

  // The host is an aspect-ratio box capped at the board's native size: on a
  // desktop it renders 1:1 as before; on a narrow screen it shrinks to fit and
  // the canvas (CSS-sized to fill it — see .board-host in index.css) scales
  // down with it. Pointer mapping survives because Pixi translates client
  // coordinates through the canvas's CSS box, not its render-target size.
  return (
    <div
      ref={hostRef}
      className="board-host inline-block w-full leading-none"
      style={{ maxWidth: W, aspectRatio: `${W} / ${H}` }}
    />
  );
}
