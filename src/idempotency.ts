/**
 * Idempotency for mutating routes — rule 6 of docs/ecosystem/03 §2.
 *
 * The mechanism and its rationale are `micro-ledger`'s (`ledger/src/idempotency.ts`), reproduced
 * here rather than imported: a cross-service source import is banned by CI rule 2, and this is not
 * a runtime library — it is a table this service owns and a policy about this service's routes.
 *
 * ## Which routes need it, established by enumeration
 *
 * `micro-market` was found on 2026-07-31 to have two mutating routes with no idempotency at all,
 * where a retry created a duplicate. That was not found by anyone remembering; it was found by
 * listing the routes. So: every non-GET route in `server.ts` is listed in `MUTATING_ROUTES` below,
 * and `server.test.ts` walks the router and fails if a mutating route is absent from that list.
 * A route added tomorrow cannot quietly opt out.
 *
 * ## The fingerprint excludes per-attempt fields
 *
 * `correlationId` is a trace identifier and is *supposed* to change on every attempt — that is what
 * makes a retry distinguishable from the original in a trace. Including it in the fingerprint means
 * a caller doing exactly the right thing is told its key was reused with a different payload, and
 * then cannot tell a genuine collision from its own tracing. `micro-wallet` had to carry a
 * correlation id that was stable per operation to work around that, and should not have had to.
 */

import { createHash } from 'node:crypto';
import type { Db, Tx } from './outbox.ts';

export class IdempotencyInFlightError extends Error {
  constructor() {
    super('a request with this idempotency key is still in flight; retry shortly');
    this.name = 'IdempotencyInFlightError';
  }
}

export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('this idempotency key was already used with a different request body');
    this.name = 'IdempotencyKeyReuseError';
  }
}

/** Fields that legitimately differ between attempts at the *same* operation. See the header. */
const PER_ATTEMPT_FIELDS = new Set(['correlationId']);

/**
 * A stable fingerprint of a request body, so a reused key with a changed payload is caught.
 *
 * Keys are sorted at every depth before hashing. `JSON.stringify` preserves insertion order, so two
 * semantically identical bodies that serialised their fields in a different order would fingerprint
 * differently and a legitimate retry would be rejected as reuse.
 */
export function requestFingerprint(value: unknown): string {
  const subject =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([key]) => !PER_ATTEMPT_FIELDS.has(key),
          ),
        )
      : value;
  return createHash('sha256').update(canonicalise(subject)).digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

/**
 * The stored key, namespaced by route.
 *
 * Without the route, one client key reused across two different endpoints would replay the FIRST
 * endpoint's response from the second — which is worse than no idempotency, because it looks like
 * success.
 */
export function namespacedKey(route: string, clientKey: string): string {
  return `${route}:${clientKey}`;
}

export interface IdempotentOutcome<T> {
  readonly result: T;
  readonly replayed: boolean;
}

export interface IdempotencyInput<T> {
  readonly route: string;
  readonly clientKey: string;
  readonly requestHash: string;
  readonly run: (tx: Tx) => Promise<T>;
}

export async function withIdempotency<T>(
  sql: Db,
  input: IdempotencyInput<T>,
): Promise<IdempotentOutcome<T>> {
  const key = namespacedKey(input.route, input.clientKey);

  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ key: string }[]>`
      insert into idempotency_keys (key, route, request_hash)
      values (${key}, ${input.route}, ${input.requestHash})
      on conflict (key) do nothing
      returning key
    `;

    if (claimed.length === 0) {
      // Someone else holds the key. By the time this read runs, their transaction has either
      // committed (so the response is here) or rolled back (so the row is gone).
      const rows = await tx<{ request_hash: string; response: unknown }[]>`
        select request_hash, response from idempotency_keys where key = ${key}
      `;
      const existing = rows[0];
      if (!existing) throw new IdempotencyInFlightError();
      if (existing.request_hash !== input.requestHash) throw new IdempotencyKeyReuseError();
      if (existing.response === null || existing.response === undefined) {
        throw new IdempotencyInFlightError();
      }
      return { value: { result: existing.response as T, replayed: true } };
    }

    const response = await input.run(tx);

    await tx`
      update idempotency_keys
         set response = ${tx.json(response as Record<string, never>)}
       where key = ${key}
    `;

    return { value: { result: response, replayed: false } };
  });

  // Wrapped above so postgres.js does not treat an array-shaped result as a list of promises to
  // unwrap, which would rewrite the caller's return type.
  return outcome.value;
}

/**
 * Delete idempotency keys past their TTL, in bounded batches.
 *
 * An unbounded DELETE over a table that has never been pruned is one long transaction holding a row
 * lock on everything it removes. Short statements let autovacuum keep up and keep the reaper out of
 * the way of the claim INSERT on the hot path.
 */
export async function reapIdempotencyKeys(sql: Db, ttlHours: number, batch = 1_000): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    with doomed as (
      select key from idempotency_keys
       where created_at < now() - (${ttlHours} * interval '1 hour')
       limit ${batch}
    )
    delete from idempotency_keys where key in (select key from doomed)
    returning 1 as n
  `;
  return rows.length;
}
