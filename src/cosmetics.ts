/**
 * Cosmetics: what a survivor is wearing, and nothing else.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * A COSMETIC IS A BILLING ENTITLEMENT AND NEVER A STAT.
 *
 * That is the anti-pay-to-win rule (03/19 §1.2), and here it is expressed as an ABSENCE that can be
 * grepped for: there is no code path from this file to `players.hp`, `.morale`, `.defense`,
 * `.reputation`, `.resources`, `.ap_per_day`, or to any column of `player_progress`. The only thing
 * `equipCosmetic` writes is `players.cosmetic_style`, a JSON map of slot to item, and the only
 * thing the engine reads out of a player is the numbers listed in `engine/state.ts` — which does
 * not include it. `cosmetics.test.ts` walks the module for a write to any of those columns and
 * fails if one appears.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Where the ownership lives
 *
 * Not here. Billing owns entitlements and `worlds` owns the account-level wardrobe
 * (03-repository-responsibilities:168 — "player identity, cosmetics, entitlement bridge → worlds").
 * The ancestor kept its own `player_cosmetics` table keyed on `user_id`
 * (`db/schema.ts`), which made a per-title game service the second registry of what an account
 * owns. That table is deliberately not in this schema. What survives here is per-WORLD: which slot
 * this survivor is wearing which item in, which is simulation state and is ours.
 *
 * ## Fail closed
 *
 * Setting a cosmetic requires owning it; clearing a slot never does — you may always take something
 * off, including something you no longer own. If billing cannot be REACHED, the write fails with a
 * 503: "ask again later", never "wear it anyway". That is the hole this closes.
 */

import type { EntitlementReader } from './billingclient.ts';
import { TITLE_SLUG } from './rules.ts';
import { ConflictError, NotFoundError, ValidationError, type WithOutbox } from './worlds.ts';
import type { Db } from './outbox.ts';

/** The title scope this game's cosmetics are entitled under. */
export const TITLE_SCOPE = TITLE_SLUG;

export class CosmeticNotOwnedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CosmeticNotOwnedError';
  }
}

/**
 * The slots a survivor can be rendered wearing.
 *
 * The ancestor's catalogue had six cosmetic kinds and only three of them resolved to anything a
 * client could draw; equipping what cannot be seen was the bug that list replaced
 * (`cosmetics.ts`). The same three are here. `commune_crest` is added because a commune has a
 * roster page to draw one on — the other two the ancestor withheld (map banners, herald flair)
 * still have nowhere to go and are still absent.
 */
export const EQUIPPABLE_SLOTS: readonly string[] = Object.freeze([
  'homestead_skin',
  'avatar_frame',
  'name_color',
  'commune_crest',
]);

export type Equipped = Record<string, string>;

/**
 * `players.cosmetic_style` is a text column. It carries this map as JSON, so no column had to be
 * added to a populated table, and a row written by an older build still reads back as "wearing
 * nothing".
 *
 * Unknown slots are dropped on the way OUT as well as on the way in: a slot that was retired, or a
 * row hand-edited in the database, must not reach a renderer.
 */
export function parseEquipped(raw: string | null): Equipped {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Equipped = {};
  for (const slot of EQUIPPABLE_SLOTS) {
    const id = (parsed as Record<string, unknown>)[slot];
    if (typeof id === 'string' && id.length > 0) out[slot] = id;
  }
  return out;
}

export function serialiseEquipped(equipped: Equipped): string | null {
  const keys = Object.keys(equipped);
  return keys.length === 0 ? null : JSON.stringify(equipped);
}

export interface EquipInput {
  readonly worldId: string;
  readonly playerId: string;
  readonly slot: string;
  /** The item urn to equip, or null to clear the slot. */
  readonly itemUrn: string | null;
  readonly correlationId?: string;
}

export async function equipCosmetic(
  sql: Db,
  producer: string,
  billing: EntitlementReader,
  input: EquipInput,
  withOutbox: WithOutbox,
): Promise<Equipped> {
  if (!EQUIPPABLE_SLOTS.includes(input.slot)) {
    throw new ValidationError(
      `unknown cosmetic slot '${input.slot}' (one of ${EQUIPPABLE_SLOTS.join(', ')})`,
    );
  }

  // Setting requires owning; clearing never does. A failure to REACH billing throws
  // BillingUnavailableError, which the server maps to 503 — the write fails closed.
  if (input.itemUrn) {
    const owns = await billing.owns(input.playerId, input.itemUrn, TITLE_SCOPE);
    if (!owns) throw new CosmeticNotOwnedError(`this account does not own '${input.itemUrn}'`);
  }

  return withOutbox(sql, producer, async (tx, emit) => {
    // The row lock makes two concurrent equips serial. Each request names only the slot it is
    // changing — a player can equip a frame and a name colour in the same second — so without it
    // both would read the old map and the later write would drop the earlier slot.
    const [row] = await tx<{ id: string; cosmetic_style: string | null; user_id: string | null }[]>`
      select id, cosmetic_style, user_id from players where id = ${input.playerId} for update`;
    if (!row) throw new NotFoundError('you have not settled in this world');
    if (!row.user_id) throw new ConflictError('a bot wears what it is given');

    const equipped = parseEquipped(row.cosmetic_style);
    if (input.itemUrn) equipped[input.slot] = input.itemUrn;
    else delete equipped[input.slot];

    await tx`
      update players set cosmetic_style = ${serialiseEquipped(equipped)} where id = ${row.id}`;

    emit({
      topic: 'nda.cosmetic.equipped',
      key: row.id,
      payload: {
        worldId: input.worldId,
        playerId: row.id,
        slot: input.slot,
        itemUrn: input.itemUrn,
      },
      actor: `user:${row.user_id}`,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return equipped;
  });
}
