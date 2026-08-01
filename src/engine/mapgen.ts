/**
 * Map generation.
 *
 * Ported verbatim from `ninety-days-after/services/game/src/world/mapgen.ts`. Two seeded streams —
 * `${seed}:terrain` and `${seed}:ruins` — so that adding a ruin cannot shift the terrain
 * underneath it. The ancestor's own note there is worth keeping: this used to draw from
 * `Math.random()`, which made the map the one part of a world that could never be reproduced.
 *
 * `RUIN_NAMES` order and the `2 + floor(rng * (dim - 4))` placement arithmetic are load-bearing:
 * change either and every recorded world generates a different map.
 */

import { type ResourceBag, type Terrain, type Tile } from '../rules.ts';
import { seededRng } from './rng.ts';

export interface WorldMap {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly Tile[];
}

const RUIN_NAMES: readonly string[] = [
  'Old Hospital',
  'Rusted Mall',
  'Sunken Depot',
  'Collapsed Refinery',
  'Silent Library',
  'Broken Overpass',
  'Ashen Church',
  'Drowned Cannery',
  'Fallow Silo',
  'Ruined Precinct',
];

/** Loot for a named ruin, keyed by its placement index so worlds feel varied but fair. */
export function ruinStock(index: number): ResourceBag {
  const b = index % 3;
  return {
    food: 24 + b * 8,
    water: 20 + b * 6,
    materials: 40 + b * 10,
    fuel: 18 + b * 6,
    medicine: 12 + b * 4,
    seeds: 10 + b * 3,
  };
}

/**
 * Generate a WorldMap: a wilderness base with forest/water patches, a couple of crossing roads,
 * and a handful of named ruins scattered away from the edges.
 *
 * Homesteads are NOT placed here — join and bot-spawn claim free tiles at runtime.
 */
export function generateMap(width: number, height: number, seed: string): WorldMap {
  const terrainRng = seededRng(`${seed}:terrain`);
  const ruinRng = seededRng(`${seed}:ruins`);

  const tiles: Tile[] = [];
  const terrainAt = (x: number, y: number): Terrain => {
    // Two roads crossing roughly through the middle.
    if (x === Math.floor(width / 2) || y === Math.floor(height / 2)) return 'road';
    const r = terrainRng();
    if (r < 0.14) return 'forest';
    if (r < 0.2) return 'water';
    return 'wilderness';
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({ x, y, terrain: terrainAt(x, y) });
    }
  }

  // Scatter ruins: ~1 per 60 tiles, min 4, capped by the name list.
  const ruinCount = Math.min(RUIN_NAMES.length, Math.max(4, Math.floor((width * height) / 60)));
  let placed = 0;
  let guard = 0;
  while (placed < ruinCount && guard < ruinCount * 50) {
    guard++;
    // Both draws happen before either is used, exactly as in the ancestor — a `continue` below
    // must consume two numbers from the stream, not one, or the placement sequence diverges.
    const x = 2 + Math.floor(ruinRng() * (width - 4));
    const y = 2 + Math.floor(ruinRng() * (height - 4));
    const tile = tiles[y * width + x];
    if (!tile) continue;
    if (tile.terrain === 'ruins' || tile.terrain === 'road' || tile.terrain === 'water') continue;
    tile.terrain = 'ruins';
    // `placed < ruinCount <= RUIN_NAMES.length`, so the name is always there; the fallback is a
    // type narrowing under `noUncheckedIndexedAccess` and is never the value written.
    tile.ruinName = RUIN_NAMES[placed] ?? 'ruins';
    placed++;
  }

  return { width, height, tiles };
}
