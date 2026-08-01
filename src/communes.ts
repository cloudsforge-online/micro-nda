/**
 * Communes: the shared stockpile, the daily allowance, and the joining stipend.
 *
 * Ported from `ninety-days-after/services/game/src/routes/communes.ts` and `.../stipend.ts`.
 *
 * ## The stipend rule, and why it is a flag
 *
 * Joining or founding a commune used to SET `communeCredit` to `COMMUNE_JOIN_STIPEND`,
 * unconditionally, and leaving zeroed it. Nothing recorded that a survivor had ever been paid, so
 * the documented "one-time goodwill credit" was in fact a per-join credit: join a stocked granary,
 * draw three goods, leave, and rejoin when the in-game day rolls over — `withdrawnToday` belongs to
 * yesterday, so the daily counter is no obstacle either. A member who deposits nothing extracts the
 * stipend every day of the season: 270 goods of other people's deposits against a documented
 * ceiling of 3. Founding was the same hole through a second door.
 *
 * `stipend_granted` on the player row closes it — set the first time this survivor joins any
 * commune in this world, and never cleared. Player rows are per-world, so the flag is naturally
 * scoped to the season the grant belongs to.
 *
 * The alternative on the register was "keep `commune_credit` across leaves instead of zeroing it".
 * That works arithmetically and silently reverses a rule the leave handler states on purpose:
 * leaving forfeits your share, which is what stops a member banking allowance in one commune and
 * spending it in another.
 *
 * ## The lock order, which is the whole of the concurrency story
 *
 * **Commune row first, then the member row. Everywhere in this file, without exception.** Two
 * handlers that take them in opposite orders deadlock, and the deadlock only appears under load.
 * Founding is the one path that locks only the member, because the commune it inserts is new and no
 * other transaction can be holding it.
 */

import { randomUUID } from 'node:crypto';
import {
  COMMUNE_JOIN_STIPEND,
  RESOURCE_KEYS,
  bagTotal,
  communeWithdrawCap,
  emptyBag,
  hasResources,
  sanitizeBag,
  type ResourceBag,
} from './rules.ts';
import { ConflictError, NotFoundError, ValidationError, type WithOutbox } from './worlds.ts';
import type { Db, Tx } from './outbox.ts';

/* ---------------------------------------------------------------------------- the stipend */

/** The two player-row fields the stipend rule reads and writes. */
export interface StipendState {
  /** Banked allowance: the stipend plus every unit deposited, less every unit drawn. */
  readonly communeCredit: number;
  /** Whether this survivor has ever been paid the one-time joining stipend in this world. */
  readonly stipendGranted: boolean;
}

/**
 * What the player row should hold once they are inside a commune. Pays the stipend on the first
 * join or founding of the season and never again.
 *
 * `+=` rather than `=`. Today they are the same — the grant only fires when the player is in no
 * commune, and leaving has already zeroed the credit, so there is never a banked balance for a
 * `set` to destroy. `+=` is the shape that stays correct if that stops being true, and it matches
 * how a deposit credits.
 */
export function creditOnJoin(before: StipendState): StipendState {
  if (before.stipendGranted) {
    return { communeCredit: before.communeCredit, stipendGranted: true };
  }
  return { communeCredit: before.communeCredit + COMMUNE_JOIN_STIPEND, stipendGranted: true };
}

/**
 * What the player row should hold once they have walked out. The balance is forfeited — deposited
 * goods stay with the commune — but the RECORD of the stipend is not, which is the whole of the
 * fix: clearing `stipendGranted` here would restore the per-join grant exactly.
 */
export function creditOnLeave(before: StipendState): StipendState {
  return { communeCredit: 0, stipendGranted: before.stipendGranted };
}

/** What a member may still draw today. */
export interface Allowance {
  readonly day: number;
  readonly cap: number;
  readonly used: number;
  readonly remaining: number;
  readonly credit: number;
}

export function allowanceFor(
  player: { commune_credit: number; withdraw_day: number; withdrawn_today: number },
  day: number,
): Allowance {
  const credit = player.commune_credit;
  const cap = communeWithdrawCap(credit);
  const used = player.withdraw_day === day ? player.withdrawn_today : 0;
  return { day, cap, used, remaining: Math.max(0, cap - used), credit };
}

/* ---------------------------------------------------------------------------- rows */

interface CommuneRow {
  readonly id: string;
  readonly world_id: string;
  readonly name: string;
  readonly founder_handle: string;
  readonly stockpile: ResourceBag;
  readonly created_at: Date;
}

interface MemberRow {
  readonly id: string;
  readonly handle: string;
  readonly world_id: string;
  readonly commune_id: string | null;
  readonly resources: ResourceBag;
  readonly commune_credit: number;
  readonly stipend_granted: boolean;
  readonly withdraw_day: number;
  readonly withdrawn_today: number;
  readonly joined_day: number;
  readonly created_at: Date;
  readonly is_bot: boolean;
  readonly alive: boolean;
}

export interface Commune {
  readonly id: string;
  readonly worldId: string;
  readonly name: string;
  readonly founderHandle: string;
  readonly memberCount: number;
  readonly stockpile: ResourceBag;
}

const toCommune = (row: CommuneRow, memberCount: number): Commune => ({
  id: row.id,
  worldId: row.world_id,
  name: row.name,
  founderHandle: row.founder_handle,
  memberCount,
  stockpile: row.stockpile,
});

async function lockCommune(tx: Tx, worldId: string, communeId: string): Promise<CommuneRow> {
  const [row] = await tx<CommuneRow[]>`
    select * from communes where id = ${communeId} and world_id = ${worldId} for update`;
  if (!row) throw new NotFoundError('no such commune');
  return row;
}

async function lockMember(tx: Tx, playerId: string): Promise<MemberRow> {
  const [row] = await tx<MemberRow[]>`select * from players where id = ${playerId} for update`;
  if (!row) throw new NotFoundError('you have not settled in this world');
  return row;
}

async function countMembers(tx: Tx, communeId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from players where commune_id = ${communeId}`;
  return row?.n ?? 0;
}

/* ---------------------------------------------------------------------------- reads */

export async function listCommunes(sql: Db, worldId: string): Promise<Commune[]> {
  const rows = await sql<(CommuneRow & { members: number })[]>`
    select c.*, coalesce(m.n, 0)::int as members
      from communes c
      left join (select commune_id, count(*) as n from players group by commune_id) m
             on m.commune_id = c.id
     where c.world_id = ${worldId}
     order by c.created_at, c.id`;
  return rows.map((r) => toCommune(r, r.members));
}

export interface CommuneDetail {
  readonly commune: Commune;
  readonly members: {
    readonly playerId: string;
    readonly handle: string;
    readonly isBot: boolean;
    readonly alive: boolean;
    readonly isFounder: boolean;
    readonly contribution: number;
  }[];
  readonly allowance: Allowance | null;
}

export async function communeDetail(
  sql: Db,
  worldId: string,
  communeId: string,
  viewerPlayerId: string | null,
  day: number,
): Promise<CommuneDetail> {
  const [row] = await sql<CommuneRow[]>`
    select * from communes where id = ${communeId} and world_id = ${worldId}`;
  if (!row) throw new NotFoundError('no such commune');

  const members = await sql<(MemberRow & { contribution: number | null })[]>`
    select p.*, g.contribution
      from players p left join player_progress g on g.player_id = p.id
     where p.commune_id = ${communeId} order by p.created_at, p.id`;

  const me = members.find((m) => m.id === viewerPlayerId);
  return {
    commune: toCommune(row, members.length),
    members: members
      .map((m) => ({
        playerId: m.id,
        handle: m.handle,
        isBot: m.is_bot,
        alive: m.alive,
        isFounder: m.handle === row.founder_handle,
        contribution: m.contribution ?? 0,
      }))
      .sort(
        (a, b) =>
          Number(b.isFounder) - Number(a.isFounder) ||
          b.contribution - a.contribution ||
          a.playerId.localeCompare(b.playerId),
      ),
    allowance: me ? allowanceFor(me, day) : null,
  };
}

/* ---------------------------------------------------------------------------- writes */

export async function foundCommune(
  sql: Db,
  producer: string,
  input: { worldId: string; playerId: string; name: string; correlationId?: string },
  withOutbox: WithOutbox,
): Promise<Commune> {
  const name = input.name.trim();
  if (name.length < 3 || name.length > 30) {
    throw new ValidationError('a commune name must be between 3 and 30 characters');
  }
  const id = randomUUID();

  return withOutbox(sql, producer, async (tx, emit) => {
    // Only the member row is locked: the commune this transaction inserts is new, so no other
    // transaction can be holding it and the file's commune-then-member order has nothing to order
    // against. The re-read under the lock is what stops two concurrent foundings both paying the
    // stipend, which is read and written here.
    const me = await lockMember(tx, input.playerId);
    if (me.commune_id) throw new ConflictError('leave your current commune first');

    const [created] = await tx<CommuneRow[]>`
      insert into communes (id, world_id, name, founder_handle, stockpile)
      values (${id}, ${input.worldId}, ${name}, ${me.handle},
              ${tx.json(emptyBag() as unknown as Record<string, never>)})
      returning *`;
    if (!created) throw new Error('commune vanished inside its own creating transaction');

    const credited = creditOnJoin({
      communeCredit: me.commune_credit,
      stipendGranted: me.stipend_granted,
    });
    await tx`
      update players set commune_id = ${id}, commune_credit = ${credited.communeCredit},
                         stipend_granted = ${credited.stipendGranted}
       where id = ${me.id}`;

    emit({
      topic: 'nda.commune.founded',
      key: id,
      payload: { worldId: input.worldId, communeId: id, name, founderPlayerId: me.id },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return toCommune(created, 1);
  });
}

export async function joinCommune(
  sql: Db,
  producer: string,
  input: { worldId: string; playerId: string; communeId: string; correlationId?: string },
  withOutbox: WithOutbox,
): Promise<Commune> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const commune = await lockCommune(tx, input.worldId, input.communeId);
    const me = await lockMember(tx, input.playerId);
    if (me.commune_id && me.commune_id !== commune.id) {
      throw new ConflictError('leave your current commune first');
    }

    // Re-joining the commune you are already in is a no-op, as it always was.
    if (!me.commune_id) {
      const credited = creditOnJoin({
        communeCredit: me.commune_credit,
        stipendGranted: me.stipend_granted,
      });
      await tx`
        update players set commune_id = ${commune.id}, commune_credit = ${credited.communeCredit},
                           stipend_granted = ${credited.stipendGranted}
         where id = ${me.id}`;
      emit({
        topic: 'nda.commune.joined',
        key: commune.id,
        payload: { worldId: input.worldId, communeId: commune.id, playerId: me.id },
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      });
    }
    return toCommune(commune, await countMembers(tx, commune.id));
  });
}

export async function depositToCommune(
  sql: Db,
  producer: string,
  input: {
    worldId: string;
    playerId: string;
    communeId: string;
    resources: Record<string, number>;
    correlationId?: string;
  },
  withOutbox: WithOutbox,
): Promise<Commune> {
  const deposit = sanitizeBag(input.resources);
  if (bagTotal(deposit) <= 0) throw new ValidationError('nothing to deposit');

  return withOutbox(sql, producer, async (tx, emit) => {
    const commune = await lockCommune(tx, input.worldId, input.communeId);
    const me = await lockMember(tx, input.playerId);
    // Anyone could previously deposit into any commune, including one they had left.
    if (me.commune_id !== commune.id) throw new ConflictError('you are not a member of this commune');
    if (!hasResources(me.resources, deposit)) throw new ConflictError('insufficient resources');

    const newPlayer = { ...me.resources };
    const newStock = { ...commune.stockpile };
    for (const k of RESOURCE_KEYS) {
      newPlayer[k] -= deposit[k];
      newStock[k] += deposit[k];
    }

    const [updated] = await tx<CommuneRow[]>`
      update communes set stockpile = ${tx.json(newStock as unknown as Record<string, never>)}
       where id = ${commune.id} returning *`;
    await tx`
      update players
         set resources = ${tx.json(newPlayer as unknown as Record<string, never>)},
             -- Credit tracks the QUANTITY given, not the number of deposits: counting requests
             -- would let a member deposit one wood a hundred times to buy allowance.
             commune_credit = ${me.commune_credit + bagTotal(deposit)}
       where id = ${me.id}`;
    // A deposit is also an earned contribution toward the survival score.
    await tx`
      insert into player_progress (player_id, world_id, contribution)
      values (${me.id}, ${input.worldId}, 1)
      on conflict (player_id) do update set contribution = player_progress.contribution + 1`;

    emit({
      topic: 'nda.commune.deposited',
      key: commune.id,
      payload: {
        worldId: input.worldId,
        communeId: commune.id,
        playerId: me.id,
        units: bagTotal(deposit),
      },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    if (!updated) throw new Error('commune vanished mid-deposit');
    return toCommune(updated, await countMembers(tx, commune.id));
  });
}

export interface WithdrawResult {
  readonly commune: Commune;
  readonly taken: ResourceBag;
  readonly allowance: Allowance;
}

/**
 * Draw from the stockpile, capped daily.
 *
 * `FOR UPDATE` on the commune row serialises concurrent withdrawals: the second caller blocks until
 * the first commits and then re-reads the drained stockpile, so two requests can never each spend
 * the same goods.
 */
export async function withdrawFromCommune(
  sql: Db,
  producer: string,
  input: {
    worldId: string;
    playerId: string;
    communeId: string;
    day: number;
    resources: Record<string, number>;
    correlationId?: string;
  },
  withOutbox: WithOutbox,
): Promise<WithdrawResult> {
  const want = sanitizeBag(input.resources);
  const total = bagTotal(want);
  if (total <= 0) throw new ValidationError('nothing requested');

  return withOutbox(sql, producer, async (tx, emit) => {
    const commune = await lockCommune(tx, input.worldId, input.communeId);
    const me = await lockMember(tx, input.playerId);
    if (me.commune_id !== commune.id) throw new ConflictError('you are not a member of this commune');

    const allowance = allowanceFor(me, input.day);
    if (total > allowance.remaining) {
      throw new ConflictError(
        `your daily share is ${allowance.cap} goods — ${allowance.remaining} left today`,
      );
    }
    if (!hasResources(commune.stockpile, want)) {
      throw new ConflictError('the stockpile does not hold that much');
    }

    const newStock = { ...commune.stockpile };
    const newPlayer = { ...me.resources };
    for (const k of RESOURCE_KEYS) {
      newStock[k] -= want[k];
      newPlayer[k] += want[k];
    }

    const [updated] = await tx<CommuneRow[]>`
      update communes set stockpile = ${tx.json(newStock as unknown as Record<string, never>)}
       where id = ${commune.id} returning *`;
    await tx`
      update players
         set resources = ${tx.json(newPlayer as unknown as Record<string, never>)},
             withdraw_day = ${input.day},
             withdrawn_today = ${allowance.used + total},
             -- Spending the credit is what makes this an entitlement rather than a daily stipend
             -- anyone can farm forever.
             commune_credit = ${allowance.credit - total}
       where id = ${me.id}`;

    emit({
      topic: 'nda.commune.withdrawn',
      key: commune.id,
      payload: { worldId: input.worldId, communeId: commune.id, playerId: me.id, units: total },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    if (!updated) throw new Error('commune vanished mid-withdrawal');
    return {
      commune: toCommune(updated, await countMembers(tx, commune.id)),
      taken: want,
      allowance: {
        day: input.day,
        cap: communeWithdrawCap(allowance.credit - total),
        used: allowance.used + total,
        remaining: Math.max(0, allowance.cap - allowance.used - total),
        credit: allowance.credit - total,
      },
    };
  });
}

export interface LeaveResult {
  readonly commune: Commune | null;
  readonly disbanded: boolean;
  readonly newFounderHandle: string | null;
}

/** Longest-tenured member inherits an abandoned commune: earliest join day wins. */
const tenureOrder = (a: MemberRow, b: MemberRow): number =>
  a.joined_day - b.joined_day ||
  a.created_at.getTime() - b.created_at.getTime() ||
  a.id.localeCompare(b.id);

export async function leaveCommune(
  sql: Db,
  producer: string,
  input: { worldId: string; playerId: string; communeId: string; correlationId?: string },
  withOutbox: WithOutbox,
): Promise<LeaveResult> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const commune = await lockCommune(tx, input.worldId, input.communeId);
    const me = await lockMember(tx, input.playerId);
    if (me.commune_id !== commune.id) throw new ConflictError('you are not a member of this commune');

    const credited = creditOnLeave({
      communeCredit: me.commune_credit,
      stipendGranted: me.stipend_granted,
    });
    await tx`
      update players set commune_id = null, commune_credit = ${credited.communeCredit},
                         stipend_granted = ${credited.stipendGranted}
       where id = ${me.id}`;

    const remaining = await tx<MemberRow[]>`
      select * from players where commune_id = ${commune.id}`;

    emit({
      topic: 'nda.commune.left',
      key: commune.id,
      payload: { worldId: input.worldId, communeId: commune.id, playerId: me.id },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });

    // Last one out disbands it — an ownerless commune could never be dissolved. The stockpile is
    // scattered with it, so a founder cannot launder goods by depositing and disbanding.
    if (remaining.length === 0) {
      await tx`delete from communes where id = ${commune.id}`;
      emit({
        topic: 'nda.commune.disbanded',
        key: commune.id,
        payload: { worldId: input.worldId, communeId: commune.id },
      });
      return { commune: null, disbanded: true, newFounderHandle: null };
    }

    // The founder leaving hands the commune to the longest-tenured member left.
    if (commune.founder_handle === me.handle) {
      const heir = [...remaining].sort(tenureOrder)[0];
      if (!heir) throw new Error('a non-empty roster produced no heir');
      const [updated] = await tx<CommuneRow[]>`
        update communes set founder_handle = ${heir.handle} where id = ${commune.id} returning *`;
      if (!updated) throw new Error('commune vanished mid-succession');
      return {
        commune: toCommune(updated, remaining.length),
        disbanded: false,
        newFounderHandle: heir.handle,
      };
    }

    return {
      commune: toCommune(commune, remaining.length),
      disbanded: false,
      newFounderHandle: null,
    };
  });
}
