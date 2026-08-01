/**
 * Where a homestead goes, and how the claim survives another settler taking the same tile in the
 * same instant.
 *
 * Ported from `ninety-days-after/services/game/src/world/homestead.ts`, comments and all, because
 * the reasoning is the code's justification:
 *
 * Placement used to be one `find` over the unowned tiles followed by an unconditional
 * `UPDATE … WHERE id = ?`. Two joins running at once read the same free list, picked the same tile
 * and both wrote it: the second silently won the row, and the first player kept coordinates the
 * map says belong to someone else — enough to make `releaseHomestead` (which matches on
 * `owner_id`) never give that tile back.
 *
 * The rules live here, away from the database, so the retry can be tested without one:
 * `homesteadCandidates` says which tile to try and in what order, and `claimFirstFree` says what
 * to do when the claim is refused.
 */

import type { Terrain } from '../rules.ts';

/** Open ground — always preferred for a new homestead. */
export const CLAIMABLE: readonly Terrain[] = ['wilderness', 'forest', 'road'];

/** Everything the placement rules need to know about an unowned tile. */
export interface FreeTile {
  readonly x: number;
  readonly y: number;
  readonly terrain: Terrain;
}

/** 0 = open ground, 1 = any other land, 2 = water or ruins (last resort). */
function preference(terrain: Terrain): number {
  if (CLAIMABLE.includes(terrain)) return 0;
  if (terrain !== 'water' && terrain !== 'ruins') return 1;
  return 2;
}

/**
 * The unowned tiles in the order they should be attempted: best terrain first, and within one
 * terrain band a row-major scan of the map.
 *
 * The scan order is a tiebreak rather than an accident. The free list arrives from a `SELECT` with
 * no `ORDER BY`, so leaving ties to Postgres would make the homestead a settler is given depend on
 * the plan the database happened to pick — the same class of thing `resolve.ts`'s action sort
 * spells out a total order to avoid.
 */
export function homesteadCandidates<T extends FreeTile>(free: readonly T[]): T[] {
  return [...free].sort(
    (a, b) => preference(a.terrain) - preference(b.terrain) || a.y - b.y || a.x - b.x,
  );
}

/**
 * Walk the candidates in order and return the first tile the claim actually won, or `undefined`
 * when every one of them was taken.
 *
 * `claim` answers false when the tile stopped being free between the read and the write. That is
 * the whole point of the conditional claim: the loser of a race finds out it lost and moves to the
 * next tile, instead of overwriting the winner and handing two settlers one homestead.
 */
export async function claimFirstFree<T>(
  candidates: readonly T[],
  claim: (tile: T) => Promise<boolean>,
): Promise<T | undefined> {
  for (const tile of candidates) {
    if (await claim(tile)) return tile;
  }
  return undefined;
}
