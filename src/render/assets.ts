import { Assets, Texture } from 'pixi.js';
import type { StationType } from '../config/balance';

/**
 * Sprite-loading pipeline. Real pixel art (Kenney Tiny Town, CC0) is baked into
 * /public/assets/tiny-town/ and loaded here. Everything else in the renderer
 * draws FROM these textures; if a load fails the canvas falls back to the
 * flat-color placeholders, so the game still runs with zero assets.
 *
 * To drop in different art later, only this manifest changes.
 */
const BASE = '/assets/tiny-town';

export const STATION_TEXTURE_URL: Record<StationType, string> = {
  plot: `${BASE}/plot.png`,
  mill: `${BASE}/mill.png`,
  coop: `${BASE}/coop.png`,
};

export const GROUND_URLS = [
  `${BASE}/ground_grass.png`,
  `${BASE}/ground_grass.png`,
  `${BASE}/ground_grass.png`,
  `${BASE}/ground_grass_flowers.png`, // occasional flower tile for variety
];

export interface GameTextures {
  stations: Partial<Record<StationType, Texture>>;
  ground: Texture[];
}

/** Make a texture sample with no smoothing — crisp pixels when scaled up. */
function pixelate(tex: Texture): Texture {
  tex.source.scaleMode = 'nearest';
  return tex;
}

/**
 * Load all game textures. Resolves even if some assets are missing — callers
 * treat absent textures as "use the placeholder".
 */
export async function loadTextures(): Promise<GameTextures> {
  const stations: Partial<Record<StationType, Texture>> = {};
  const ground: Texture[] = [];

  await Promise.all([
    ...(Object.keys(STATION_TEXTURE_URL) as StationType[]).map(async (type) => {
      try {
        stations[type] = pixelate(await Assets.load(STATION_TEXTURE_URL[type]));
      } catch {
        /* placeholder fallback */
      }
    }),
    ...GROUND_URLS.map(async (url, i) => {
      try {
        ground[i] = pixelate(await Assets.load(url));
      } catch {
        /* placeholder fallback */
      }
    }),
  ]);

  return { stations, ground };
}

/** Stable pseudo-random ground-variant index for a tile, so it doesn't flicker. */
export function groundVariant(x: number, y: number, count: number): number {
  const h = (x * 73856093) ^ (y * 19349663);
  return ((h % count) + count) % count;
}
