import { Assets, Texture } from 'pixi.js';
import type { StationType } from '../config/balance';
import { COLORS, type Color } from '../game/state';

/**
 * Sprite-loading pipeline. Station/duck art is hand-drawn pixel art baked into
 * /public/assets/farm/; ground tiles are Kenney "Tiny Town" (CC0). Everything
 * in the renderer draws FROM these textures; if a load fails the canvas falls
 * back to flat-color placeholders, so the game still runs with zero assets.
 *
 * To drop in different art later, only this manifest changes.
 */
const FARM = '/assets/farm';
const GROUND = '/assets/tiny-town';

export const STATION_TEXTURE_URL: Record<StationType, string> = {
  plot: `${FARM}/plot.png`,
  mill: `${FARM}/mill.png`,
  coop: `${FARM}/coop.png`,
  peaPatch: `${FARM}/peaPatch.png`,
  mealwormFarm: `${FARM}/mealwormFarm.png`,
  yeastVat: `${FARM}/yeastVat.png`,
  oysterSource: `${FARM}/oysterSource.png`,
  // Winterstead (Phase 6d stations, baked in the Phase 5 pixel pass).
  seedStore: `${FARM}/seedStore.png`,
  fodderRack: `${FARM}/fodderRack.png`,
  winterCoop: `${FARM}/winterCoop.png`,
  heater: `${FARM}/heater.png`,
  heatedWaterer: `${FARM}/heatedWaterer.png`,
};

export const MILL_SAILS_URL = `${FARM}/mill_sails.png`;
export const DUCK_URLS = [`${FARM}/duck_a.png`, `${FARM}/duck_b.png`];
export const WATER_URLS = [`${FARM}/water_a.png`, `${FARM}/water_b.png`];

// Mostly grass, with the occasional flower tile for subtle variety (~1 in 6).
export const GROUND_URLS = [
  `${GROUND}/ground_grass.png`,
  `${GROUND}/ground_grass.png`,
  `${GROUND}/ground_grass.png`,
  `${GROUND}/ground_grass.png`,
  `${GROUND}/ground_grass.png`,
  `${GROUND}/ground_grass_flowers.png`,
];

export interface GameTextures {
  stations: Partial<Record<StationType, Texture>>;
  millSails: Texture | null;
  ducks: Texture[];
  /** Per-phenotype recolored duck frames (black/blue/splash Swedish), so the
   *  ambient ducks reflect the flock's colors. Falls back to `ducks` if recolor
   *  fails. */
  duckTints: Record<Color, Texture[]>;
  ground: Texture[];
  water: Texture[];
}

// ── Duck recoloring (Phase 5 polish) ─────────────────────────────────
// The baked duck sprite's BODY is exactly three yellow shades; beak/eye/legs are
// separate. So we exact-match the body pixels and swap in three shades of the
// flock's body color (orange bill + legs stay — Swedish ducks have those too).
export type RGB = [number, number, number];
const DUCK_BODY: RGB[] = [
  [246, 212, 60], // C.duck  — main body
  [224, 182, 42], // C.duckD — wing/tail shade
  [255, 236, 150], // C.duckH — belly highlight
];
/** Body color per phenotype (matches the Flock panel swatches). Exported so
 *  other plain-DOM renderers (e.g. WaterBoard's pond swimmers) can recolor
 *  without duplicating the palette. */
export const DUCK_BODY_COLOR: Record<Color, RGB> = {
  black: [56, 56, 66],
  blue: [91, 122, 157],
  splash: [174, 190, 210],
};
const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const darker = (c: RGB, f: number): RGB => [clampByte(c[0] * f), clampByte(c[1] * f), clampByte(c[2] * f)];
const lighter = (c: RGB, t: number): RGB =>
  [clampByte(c[0] + (255 - c[0]) * t), clampByte(c[1] + (255 - c[1]) * t), clampByte(c[2] + (255 - c[2]) * t)];

export function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Recolor one duck frame's body to `body`, returning the plain canvas (no
 *  Pixi dependency) — the shared core for both the Pixi texture path below
 *  and any plain-DOM consumer (e.g. WaterBoard's pond swimmers). */
export function recolorDuckCanvas(img: HTMLImageElement, body: RGB): HTMLCanvasElement | null {
  try {
    const w = img.naturalWidth || 16;
    const h = img.naturalHeight || 16;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const shades: RGB[] = [body, darker(body, 0.78), lighter(body, 0.45)];
    const near = (a: number, b: number) => Math.abs(a - b) <= 4;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      for (let k = 0; k < DUCK_BODY.length; k++) {
        const f = DUCK_BODY[k];
        if (near(px[i], f[0]) && near(px[i + 1], f[1]) && near(px[i + 2], f[2])) {
          const t = shades[k];
          px[i] = t[0];
          px[i + 1] = t[1];
          px[i + 2] = t[2];
          break;
        }
      }
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

/** Recolor one duck frame's body to `body`, returning a crisp pixel texture. */
function recolorDuck(img: HTMLImageElement, body: RGB): Texture | null {
  const canvas = recolorDuckCanvas(img, body);
  if (!canvas) return null;
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  return tex;
}

/** Sample a texture with no smoothing — crisp pixels when scaled up. */
function pixelate(tex: Texture): Texture {
  tex.source.scaleMode = 'nearest';
  return tex;
}

async function tryLoad(url: string): Promise<Texture | null> {
  try {
    return pixelate(await Assets.load(url));
  } catch {
    return null;
  }
}

/** Load all game textures; resolves even if some assets are missing. */
export async function loadTextures(): Promise<GameTextures> {
  const stations: Partial<Record<StationType, Texture>> = {};
  const ducks: Texture[] = [];
  const ground: Texture[] = [];
  const water: Texture[] = [];
  let millSails: Texture | null = null;

  await Promise.all([
    ...WATER_URLS.map(async (url, i) => {
      const t = await tryLoad(url);
      if (t) water[i] = t;
    }),
    ...(Object.keys(STATION_TEXTURE_URL) as StationType[]).map(async (type) => {
      const t = await tryLoad(STATION_TEXTURE_URL[type]);
      if (t) stations[type] = t;
    }),
    (async () => {
      millSails = await tryLoad(MILL_SAILS_URL);
    })(),
    ...DUCK_URLS.map(async (url, i) => {
      const t = await tryLoad(url);
      if (t) ducks[i] = t;
    }),
    ...GROUND_URLS.map(async (url, i) => {
      const t = await tryLoad(url);
      if (t) ground[i] = t;
    }),
  ]);

  // Recolored ambient-duck frames per phenotype (from the raw PNGs, so we have
  // pixel access). Falls back gracefully to the yellow base if recolor fails.
  const duckTints: Record<Color, Texture[]> = { black: [], blue: [], splash: [] };
  const duckImgs = await Promise.all(DUCK_URLS.map(loadImage));
  for (const color of COLORS) {
    duckImgs.forEach((img, i) => {
      if (!img) return;
      const t = recolorDuck(img, DUCK_BODY_COLOR[color]);
      if (t) duckTints[color][i] = t;
    });
  }

  return { stations, millSails, ducks, duckTints, ground, water };
}

/** Recolored duck frames as data URLs, per phenotype — for plain-DOM (non-
 *  Pixi) consumers, namely WaterBoard's ambient pond swimmers (Phase 5
 *  juice). Same source art + palette as the canvas's duckTints above. */
export async function loadDuckTintImages(): Promise<Record<Color, string[]>> {
  const out: Record<Color, string[]> = { black: [], blue: [], splash: [] };
  const duckImgs = await Promise.all(DUCK_URLS.map(loadImage));
  for (const color of COLORS) {
    duckImgs.forEach((img, i) => {
      if (!img) return;
      const canvas = recolorDuckCanvas(img, DUCK_BODY_COLOR[color]);
      if (canvas) out[color][i] = canvas.toDataURL();
    });
  }
  return out;
}

/** Stable pseudo-random ground-variant index for a tile, so it doesn't flicker. */
export function groundVariant(x: number, y: number, count: number): number {
  const h = (x * 73856093) ^ (y * 19349663);
  return ((h % count) + count) % count;
}
