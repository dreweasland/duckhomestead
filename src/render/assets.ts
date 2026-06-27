import { Assets, Texture } from 'pixi.js';
import type { StationType } from '../config/balance';

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
};

export const MILL_SAILS_URL = `${FARM}/mill_sails.png`;
export const DUCK_URLS = [`${FARM}/duck_a.png`, `${FARM}/duck_b.png`];

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
  ground: Texture[];
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
  let millSails: Texture | null = null;

  await Promise.all([
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

  return { stations, millSails, ducks, ground };
}

/** Stable pseudo-random ground-variant index for a tile, so it doesn't flicker. */
export function groundVariant(x: number, y: number, count: number): number {
  const h = (x * 73856093) ^ (y * 19349663);
  return ((h % count) + count) % count;
}
