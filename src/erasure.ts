/**
 * GDPR right-to-erasure — the `identity.user.deleted` handler.
 *
 * Rule 6 of `03-repository-responsibilities.md` §2 (`org/README.md`): every service storing a
 * `user_id` subscribes to `identity.user.deleted` and erases. This service stores one on every
 * human survivor (`players.user_id`), so this file is that obligation.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE SURVIVOR IS NOT DELETED. THE PERSON IS.**
 *
 * A world's history is other players' history too — the raids they survived, the trades they made,
 * the commune they founded. Deleting a survivor row cascades to `queued_actions`, `objectives`,
 * `achievements` and `player_progress`, and it would silently rewrite the recorded outcome of
 * other people's games. So the row stays, and everything that names the person goes.
 *
 * What "names the person" means here is wider than `user_id`, and getting that wrong is the defect
 * this file was written to fix. A self-chosen handle IS personal data — it is how the person is
 * known, it is frequently reused across services, and it is DENORMALISED into five other columns
 * by the resolution engine. Nulling `players.user_id` while leaving `reports.actor_handle = 'alice'`
 * and a herald line reading "alice raided bob" is not anonymisation; it is a rename of one row.
 *
 * ── PER-TABLE DECISION ────────────────────────────────────────────────────────────────────────
 *
 * | table            | action     | reasoning, and lawful basis where the row is retained         |
 * |------------------|------------|---------------------------------------------------------------|
 * | players          | anonymise  | `user_id` → NULL (the account link, the only direct identifier)|
 * |                  |            | and `handle` → the tombstone. `cosmetic_style` goes too: a     |
 * |                  |            | purchased wardrobe is an account-level preference, not world   |
 * |                  |            | history. The row survives because the SIMULATION state         |
 * |                  |            | (resources, hp, position, commune membership) is an input to   |
 * |                  |            | other players' outcomes; after this update it is attached to   |
 * |                  |            | nobody. NOT retained under an Art. 17(3) exemption — it is     |
 * |                  |            | anonymous data, and Art. 17 no longer bites on it.             |
 * | reports          | anonymise  | `actor_handle` / `target_handle` are denormalised copies of    |
 * |                  |            | `players.handle`; `message` is free text the engine built by   |
 * |                  |            | interpolating the same handle. All three are rewritten. The    |
 * |                  |            | row survives: a report is another player's record of their own |
 * |                  |            | day, and deleting it would blank their history.                |
 * | communes         | anonymise  | `founder_handle` is a denormalised handle. Rewritten. The      |
 * |                  |            | commune is a shared institution with other members in it.      |
 * | world_events     | anonymise  | `title` / `description` are engine-built free text that can    |
 * |                  |            | interpolate a handle (a raider warband named for its leader).  |
 * |                  |            | Rewritten by exact substring, never by pattern.                |
 * | player_progress  | retain     | Keyed on `player_id` only — level, xp, streak, counters. After |
 * |                  |            | the `players` update there is no path from any of it to a      |
 * |                  |            | person, so it is anonymous data and out of Art. 17's scope.    |
 * | objectives       | retain     | Same: keyed on `player_id`, and `description` is generated     |
 * |                  |            | from the objective KIND ("scavenge 3 ruins"), never a handle.  |
 * | achievements     | retain     | Same. `name` / `description` come from the achievement         |
 * |                  |            | catalogue. Note the delivery job already refuses to post an    |
 * |                  |            | erased survivor's badge onward: it selects `user_id is not     |
 * |                  |            | null` (`achievements.ts`) and answers 'unowned'             |
 * |                  |            | (`achievements.ts`), so erasure stops future delivery.      |
 * | queued_actions   | retain     | `action` jsonb is an action SPEC (kind, target tile), keyed on |
 * |                  |            | `player_id`. It names no person.                               |
 * | tiles            | retain     | `owner_id` is a `players.id`, not a `user_id`.                 |
 * | worlds,          | retain     | No person-linked column of any kind.                           |
 * | world_stock      |            |                                                                |
 * | inbox            | retain     | `(topic, event_id)` — the acknowledgement that this erasure    |
 * |                  |            | happened. Art. 17(3)(b): the record that we complied is itself |
 * |                  |            | required to demonstrate compliance (Art. 5(2) accountability). |
 * |                  |            | It names an event, not a user.                                 |
 * | outbox           | retain     | `actor` may carry `user:<uuid>`, but the relay prunes          |
 * |                  |            | published rows and nothing here emits an event naming the      |
 * |                  |            | erased user — see `erasePlayers`, which writes no event.       |
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * **NO EVENT IS EMITTED.** Announcing "this user was erased" would leave, in every subscriber's
 * inbox and in this service's own outbox, a fresh row naming the person who asked to be forgotten.
 * The inbox row is the acknowledgement, which is what the estate's pattern already requires.
 *
 * ── WHAT IS NOT REACHABLE FROM HERE ───────────────────────────────────────────────────────────
 * Delivered achievements were POSTed to the `worlds` shared-profile service keyed on `user_id`
 * (`achievements.ts`). Those rows live in `micro-worlds` and this service cannot erase them.
 */

import type { TransactionSql } from 'postgres'

type Tx = TransactionSql<Record<string, unknown>>

/**
 * The handle an erased survivor is known by afterwards.
 *
 * A single constant rather than a per-player nonce, deliberately. It has to be substituted into
 * free text that other players read, so it has to be a name rather than an id; and every erased
 * survivor collapsing to the same name is a FEATURE — it means the count of erased players in a
 * world is not itself a per-person signal.
 *
 * `players_erased_stays_erased` (migration 6) makes it structural: a row carrying this handle may
 * not also carry a `user_id`, so no future code path can re-attach an account to an erased
 * survivor, whether by a repair script, a rejoin race or a restore.
 */
export const ERASED_HANDLE = 'a departed settler'

export interface ErasureOutcome {
  /** Survivors whose account link was removed. */
  readonly players: number
  /** Rows in which a denormalised copy of the handle was rewritten. */
  readonly reports: number
  readonly communes: number
  readonly worldEvents: number
}

/**
 * Erase one account from every world it played in.
 *
 * Runs inside the caller's `withInbox` transaction, so the erasure and the acknowledgement that
 * records it commit together or neither does.
 *
 * The rewrite of free text is an EXACT substring replacement of the handle that was actually on
 * the row, scoped to the worlds that survivor played in. It is not a pattern, not a regex and not
 * a fuzzy match, because the failure mode of a loose rule here is silently corrupting a different
 * player's history.
 *
 * The one residual imprecision is stated rather than hidden: handles are not unique within a
 * world (there is no unique index on `(world_id, handle)` — only on `(world_id, user_id)`), so if
 * two survivors in one world chose the same handle, this rewrites the narrative text of both. That
 * over-erases rather than under-erases, which is the correct direction to fail in.
 */
export async function erasePlayers(tx: Tx, userId: string): Promise<ErasureOutcome> {
  const survivors = await tx<{ id: string; world_id: string; handle: string }[]>`
    select id, world_id, handle from players where user_id = ${userId}
  `
  if (survivors.length === 0) {
    return { players: 0, reports: 0, communes: 0, worldEvents: 0 }
  }

  let reports = 0
  let communes = 0
  let worldEvents = 0

  for (const survivor of survivors) {
    // Nothing to substitute, and `replace(x, '', y)` is not a no-op in Postgres.
    if (survivor.handle === '' || survivor.handle === ERASED_HANDLE) continue

    const named = await tx<{ id: string }[]>`
      update reports
         set actor_handle  = case when actor_handle  = ${survivor.handle} then ${ERASED_HANDLE} else actor_handle  end,
             target_handle = case when target_handle = ${survivor.handle} then ${ERASED_HANDLE} else target_handle end,
             message       = replace(message, ${survivor.handle}, ${ERASED_HANDLE})
       where world_id = ${survivor.world_id}
         and (actor_handle = ${survivor.handle}
              or target_handle = ${survivor.handle}
              or position(${survivor.handle} in message) > 0)
      returning id
    `
    reports += named.length

    const founded = await tx<{ id: string }[]>`
      update communes set founder_handle = ${ERASED_HANDLE}
       where world_id = ${survivor.world_id} and founder_handle = ${survivor.handle}
      returning id
    `
    communes += founded.length

    const events = await tx<{ id: string }[]>`
      update world_events
         set title       = replace(title, ${survivor.handle}, ${ERASED_HANDLE}),
             description = replace(description, ${survivor.handle}, ${ERASED_HANDLE})
       where world_id = ${survivor.world_id}
         and (position(${survivor.handle} in title) > 0
              or position(${survivor.handle} in description) > 0)
      returning id
    `
    worldEvents += events.length
  }

  // Last, so that every rewrite above could still read the handle it was replacing. The CHECK
  // added in migration 6 refuses this row if a `user_id` were left behind alongside the tombstone.
  const erased = await tx<{ id: string }[]>`
    update players
       set user_id = null, handle = ${ERASED_HANDLE}, cosmetic_style = null
     where user_id = ${userId}
    returning id
  `

  return { players: erased.length, reports, communes, worldEvents }
}
