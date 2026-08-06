// The HTTP surface, over a real socket and a real Postgres.
//
// The first test in this file is the important one and it is structural: it walks the built router
// and fails if any non-GET route lacks an idempotency policy. `micro-market` shipped two mutating
// routes with none, and a retry there created a duplicate; that was found by ENUMERATING the
// routes, not by anyone remembering. This is that enumeration, run on every build.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type postgres from 'postgres';
import { Lifecycle } from '@cloudsforge/lifecycle';
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs';
import type { Principal } from '@cloudsforge/auth';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetNda,
  asDb,
  quietLogger,
  testMetrics,
  fakeBilling,
  signedEvent,
  seedWorld,
  ALICE,
  BOB,
  type FakeBilling,
} from './testsupport.ts';
import { buildRoutes, createServer, type PrincipalVerifier } from './server.ts';
import { withOutbox } from './outbox.ts';
import { playerOf, queueActions, resolveWorldDay } from './worlds.ts';
import { foundCommune } from './communes.ts';

const SIGNING_SECRET = 'a-real-signing-secret-of-good-length';

let sql: postgres.Sql;
let server: Server;
let base: string;
let billing: FakeBilling;

/** A verifier keyed by the bearer token itself, so a test says who it is by the token it sends. */
const PRINCIPALS = new Map<string, Principal>([
  ['alice', { kind: 'user', userId: ALICE, handle: 'alice', roles: ['player'] }],
  ['bob', { kind: 'user', userId: BOB, handle: 'bob', roles: ['player'] }],
  ['admin', { kind: 'user', userId: 'admin-user', handle: 'root', roles: ['admin'] }],
]);

const verifier: PrincipalVerifier = {
  async principal(token) {
    const found = PRINCIPALS.get(token);
    if (!found) {
      const { TokenError } = await import('@cloudsforge/auth');
      throw new TokenError('unknown token', 'invalid');
    }
    return found;
  },
};

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  options: { as?: string; key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
  if (options.as) headers['authorization'] = `Bearer ${options.as}`;
  if (options.key) headers['idempotency-key'] = options.key;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

before(async () => {
  if (!enabled) return;
  sql = openDb(10);
  await migrateTestDb(sql);
  billing = fakeBilling();
  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 100 });
  lifecycle.markReady();
  server = createServer({
    lifecycle,
    logger: quietLogger(),
    metrics: testMetrics(),
    verifier,
    sql: asDb(sql),
    producer: 'nda',
    billing,
    queue: new JobQueue(sql as unknown as JobsSql, { owner: 'test' }),
    eventSigningSecret: SIGNING_SECRET,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  if (enabled) await resetNda(sql);
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (sql) await sql.end();
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ENUMERATION
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('routes: every mutating route declares an idempotency policy', () => {
  const routes = buildRoutes();
  const mutating = routes.filter((r) => r.method !== 'GET');
  assert.ok(mutating.length >= 12, `only ${mutating.length} mutating routes found — did the router shrink?`);

  const naked = mutating.filter((r) => r.idempotency === null);
  assert.deepEqual(
    naked.map((r) => `${r.method} ${r.path}`),
    [],
    'a mutating route with no idempotency policy: a retry of it creates a duplicate',
  );

  // And the inverse: a GET must never claim one, or a reader would be told to send a key.
  const confused = routes.filter((r) => r.method === 'GET' && r.idempotency !== null);
  assert.deepEqual(confused.map((r) => r.path), []);
});

test('routes: exactly one route uses the inbox policy, and it is the event webhook', () => {
  // Every other mutation is keyed on a client header. The webhook is keyed on the event envelope's
  // own id, because a producer's retry reuses the event id and not an HTTP header — taking a
  // client key there would let one event be processed twice.
  const byInbox = buildRoutes().filter((r) => r.idempotency === 'inbox');
  assert.deepEqual(
    byInbox.map((r) => `${r.method} ${r.path}`),
    ['POST /v1/events'],
  );
});

test('routes: no two routes share a method and path', () => {
  const seen = new Set<string>();
  for (const r of buildRoutes()) {
    const id = `${r.method} ${r.path}`;
    assert.ok(!seen.has(id), `${id} is defined twice; the first match would always win`);
    seen.add(id);
  }
});

/* ------------------------------------------------------------------ health */

test('server: /livez is static and needs no auth', { skip }, async () => {
  const res = await call('GET', '/livez');
  assert.equal(res.status, 200);
});

test('server: /readyz reports the probes', { skip }, async () => {
  const res = await call('GET', '/readyz');
  assert.ok(res.status === 200 || res.status === 503);
  assert.ok('ready' in res.body);
});

test('server: /metrics is Prometheus text', { skip }, async () => {
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(await res.text(), /http_requests_total/);
});

test('server: an unknown path is an honest 404', { skip }, async () => {
  const res = await call('GET', '/v1/nothing-here', { as: 'alice' });
  assert.equal(res.status, 404);
});

/* ------------------------------------------------------------------ auth */

test('server: a read without a token is 401', { skip }, async () => {
  assert.equal((await call('GET', '/v1/worlds')).status, 401);
});

test('server: creating a world needs admin', { skip }, async () => {
  const res = await call('POST', '/v1/worlds', {
    as: 'alice',
    key: 'k1',
    body: { name: 'not yours' },
  });
  assert.equal(res.status, 403);
});

/* ------------------------------------------------------------------ idempotency */

test('server: a missing Idempotency-Key on a mutation is refused, not silently accepted', { skip }, async () => {
  const res = await call('POST', '/v1/worlds', { as: 'admin', body: { name: 'keyless world' } });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /Idempotency-Key/);
});

test(
  'server: an action retry REPLAYS rather than 409s, and does not queue twice',
  { skip },
  async () => {
    // The requirement, exactly: a client that resends the same request with the same key must get
    // its original answer back, not a conflict. A 409 here would push every client into "did that
    // work?" logic, and the honest answer would be "sometimes".
    const { worldId } = await seedWorld(sql, { seed: 'idem' });
    const body = { actions: [{ type: 'work' }, { type: 'rest' }] };

    const first = await call('PUT', `/v1/worlds/${worldId}/actions`, {
      as: 'alice',
      key: 'queue-1',
      body,
    });
    assert.equal(first.status, 200);
    assert.equal(first.body['replayed'], false);

    const second = await call('PUT', `/v1/worlds/${worldId}/actions`, {
      as: 'alice',
      key: 'queue-1',
      body,
    });
    assert.equal(second.status, 200, 'a retry was refused instead of replayed');
    assert.equal(second.body['replayed'], true);
    assert.deepEqual(second.body['actions'], first.body['actions']);

    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from queued_actions where world_id = ${worldId}`;
    assert.equal(n!.n, 2, 'the retry queued the actions a second time');
  },
);

test(
  'server: the fingerprint ignores correlationId, so a retry with a fresh trace id still replays',
  { skip },
  async () => {
    // The sharp edge from `micro-wallet`: correlationId is SUPPOSED to change per attempt — that is
    // what makes a retry visible in a trace — so including it in the fingerprint tells a caller
    // doing exactly the right thing that its key was reused with a different payload.
    const { worldId } = await seedWorld(sql, { seed: 'trace' });
    const a = await call('PUT', `/v1/worlds/${worldId}/actions`, {
      as: 'alice',
      key: 'trace-1',
      body: { actions: [{ type: 'work' }], correlationId: 'attempt-one' },
      headers: { 'x-request-id': 'attempt-one' },
    });
    const b = await call('PUT', `/v1/worlds/${worldId}/actions`, {
      as: 'alice',
      key: 'trace-1',
      body: { actions: [{ type: 'work' }], correlationId: 'attempt-two' },
      headers: { 'x-request-id': 'attempt-two' },
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200, 'a retry with a fresh correlation id was rejected as key reuse');
    assert.equal(b.body['replayed'], true);
  },
);

test('server: the same key with a DIFFERENT body is a 409, not a silent replay', { skip }, async () => {
  const { worldId } = await seedWorld(sql, { seed: 'reuse' });
  await call('PUT', `/v1/worlds/${worldId}/actions`, {
    as: 'alice',
    key: 'reuse-1',
    body: { actions: [{ type: 'work' }] },
  });
  const res = await call('PUT', `/v1/worlds/${worldId}/actions`, {
    as: 'alice',
    key: 'reuse-1',
    body: { actions: [{ type: 'rest' }] },
  });
  assert.equal(res.status, 409);
  assert.equal((res.body['error'] as Record<string, unknown>)['code'], 'idempotency_key_reuse');
});

test('server: one key on two different routes does not cross over', { skip }, async () => {
  // The key is namespaced by route. Without that, a client reusing one key across two endpoints
  // would be served the FIRST endpoint's response from the second — worse than no idempotency,
  // because it looks like success.
  const { worldId } = await seedWorld(sql, { seed: 'namespace' });
  const a = await call('PUT', `/v1/worlds/${worldId}/actions`, {
    as: 'alice',
    key: 'shared',
    body: { actions: [{ type: 'work' }] },
  });
  const b = await call('POST', `/v1/worlds/${worldId}/communes`, {
    as: 'alice',
    key: 'shared',
    body: { name: 'a commune' },
  });
  assert.equal(a.status, 200);
  assert.equal(b.status, 201, 'the second route replayed the first route stored response');
  assert.ok(b.body['commune']);
});

test('server: joining twice with different keys still yields one survivor', { skip }, async () => {
  // Idempotency at the route AND at the constraint. Two DIFFERENT keys defeat the key store
  // entirely, so what is left is the unique index — and the join has to answer with the survivor
  // that exists rather than fail.
  const { worldId } = await seedWorld(sql, { seed: 'join-twice', humans: [] });
  const a = await call('POST', `/v1/worlds/${worldId}/join`, { as: 'alice', key: 'j1' });
  const b = await call('POST', `/v1/worlds/${worldId}/join`, { as: 'alice', key: 'j2' });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(
    (a.body['player'] as Record<string, unknown>)['id'],
    (b.body['player'] as Record<string, unknown>)['id'],
  );
});

/* ------------------------------------------------------------------ the event webhook */

test('server: an event with no signature is refused before it is parsed', { skip }, async () => {
  const res = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', topic: 'x' }),
  });
  // 403, not 401. This is not a bearer surface: the MAC is the credential, and answering 401
  // invites a caller to go and find a token that would not help them.
  assert.equal(res.status, 403);
});

test('server: an event signed with the wrong secret is refused', { skip }, async () => {
  const { body, signature, header } = await signedEvent('the-wrong-secret-entirely-0000', {
    id: '11111111-1111-4111-8111-111111111111',
    topic: 'identity.user.deleted',
    payload: {},
  });
  const res = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [header]: signature },
    body,
  });
  assert.equal(res.status, 403);
});

test(
  'server: identity.user.deleted erases the account link but keeps the world history',
  { skip },
  async () => {
    // GDPR erasure — 17-definition-of-done §2 makes this non-optional for any service storing a
    // user_id. The survivor is NOT deleted: a world's history is other players' history too, the
    // raids they survived and the trades they made. What goes is the link to the account.
    const { worldId, playerIds } = await seedWorld(sql, { seed: 'erasure' });

    // The survivor must actually DO something before the day resolves, or the only report the
    // engine writes is the world summary — which carries no handle at all, and an erasure test
    // built on that fixture asserts nothing. A single `work` action produces a report with
    // `actor_handle = 'alice'` AND a message reading "alice worked the homestead"
    // (`engine/resolve.ts`), which is the denormalisation this test exists to catch.
    await queueActions(
      asDb(sql),
      'nda',
      { worldId, userId: ALICE, actions: [{ type: 'work' }] },
      withOutbox,
    );
    // Founding a commune denormalises the handle a second way, into `communes.founder_handle`.
    await foundCommune(
      asDb(sql),
      'nda',
      { worldId, playerId: playerIds[0]!, name: 'the last holdouts' },
      withOutbox,
    );
    await resolveWorldDay(asDb(sql), 'nda', worldId, new Date(), withOutbox);

    const [seeded] = await sql<{ n: number }[]>`
      select (
        (select count(*) from reports
          where world_id = ${worldId}
            and (actor_handle = 'alice' or position('alice' in message) > 0))
      + (select count(*) from communes where world_id = ${worldId} and founder_handle = 'alice')
      )::int as n`;
    assert.ok(seeded!.n > 0, 'the fixture wrote no denormalised handle, so this test proves nothing');

    const [before] = await sql<{ n: number }[]>`
      select count(*)::int as n from reports where world_id = ${worldId}`;
    assert.ok(before!.n > 0);

    // ── THE PAYLOAD `identity` ACTUALLY SENDS ────────────────────────────────────────────
    // `{ userId, tombstoneAt, reason }`, with the envelope key set to the bare user id —
    // `identity/src/deletion.ts`. This test used to send `{ subject: 'user:<uuid>' }`,
    // a shape identity has never emitted, and the handler read `subject`. Both agreed with each
    // other and neither agreed with the producer, so the test passed while every real deletion
    // erased nothing and answered 202.
    const envelope = {
      id: '22222222-2222-4222-8222-222222222222',
      topic: 'identity.user.deleted',
      key: ALICE,
      payload: {
        userId: ALICE,
        tombstoneAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        reason: 'user_requested',
      },
    };
    const { body, signature, header } = await signedEvent(SIGNING_SECRET, envelope);
    const res = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [header]: signature },
      body,
    });
    assert.equal(res.status, 202);

    const [player] = await sql<{ user_id: string | null; handle: string; alive: boolean }[]>`
      select user_id, handle, alive from players where id = ${playerIds[0]!}`;
    assert.equal(player!.user_id, null, 'the account link survived erasure');
    assert.notEqual(player!.handle, 'alice', 'the handle survived erasure');
    assert.equal(player!.alive, true, 'erasure killed the survivor');

    const [after] = await sql<{ n: number }[]>`
      select count(*)::int as n from reports where world_id = ${worldId}`;
    assert.equal(after!.n, before!.n, "erasure destroyed other players' history");

    // ── THE HANDLE IS DENORMALISED, AND ERASING ONLY `players` LEAVES IT EVERYWHERE ──────
    // A self-chosen handle is personal data. The resolution engine copies it into
    // `reports.actor_handle`, `reports.target_handle`, `communes.founder_handle` and into the
    // free text of `reports.message` and `world_events.description`. Nulling `user_id` while
    // leaving "alice raided bob" in a herald line is a rename, not an erasure.
    const [leaks] = await sql<{ n: number }[]>`
      select (
        (select count(*) from reports
          where world_id = ${worldId}
            and (actor_handle = 'alice' or target_handle = 'alice'
                 or position('alice' in message) > 0))
      + (select count(*) from communes where world_id = ${worldId} and founder_handle = 'alice')
      + (select count(*) from world_events
          where world_id = ${worldId}
            and (position('alice' in title) > 0 or position('alice' in description) > 0))
      )::int as n`;
    assert.equal(leaks!.n, 0, 'a denormalised copy of the handle survived erasure');

    // The schema refuses to let an erased survivor be re-attached to an account, whatever the
    // code path — `players_erased_stays_erased`, migration 6.
    await assert.rejects(
      () => sql`update players set user_id = ${ALICE} where id = ${playerIds[0]!}`,
      /players_erased_stays_erased/,
      'an erased survivor could be re-attributed to an account',
    );

    // A redelivery of the same event is deduped on (topic, event_id) and does nothing.
    const again = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [header]: signature },
      body,
    });
    assert.equal(again.status, 202);
    assert.equal(((await again.json()) as Record<string, unknown>)['status'], 'duplicate');
  },
);

test('server: an event on a topic we do not subscribe to is acknowledged and ignored', { skip }, async () => {
  const { body, signature, header } = await signedEvent(SIGNING_SECRET, {
    id: '33333333-3333-4333-8333-333333333333',
    topic: 'market.listing.created',
    payload: {},
  });
  const res = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [header]: signature },
    body,
  });
  assert.equal(res.status, 202);
  assert.equal(((await res.json()) as Record<string, unknown>)['status'], 'ignored');
});

/* ------------------------------------------------------------------ reads and visibility */

test('server: a private report reaches only the survivor it belongs to', { skip }, async () => {
  // `viewer_player_id` IS the access control. A private entry belongs to exactly one reader.
  const { worldId } = await seedWorld(sql, {
    seed: 'privacy',
    humans: [
      { userId: ALICE, handle: 'alice' },
      { userId: BOB, handle: 'bob' },
    ],
  });
  await call('PUT', `/v1/worlds/${worldId}/actions`, {
    as: 'alice',
    key: 'p1',
    body: { actions: [{ type: 'work' }] },
  });
  await resolveWorldDay(asDb(sql), 'nda', worldId, new Date(), withOutbox);

  const mine = await call('GET', `/v1/worlds/${worldId}/reports`, { as: 'alice' });
  const theirs = await call('GET', `/v1/worlds/${worldId}/reports`, { as: 'bob' });
  const messages = (r: Res): string[] =>
    (r.body['reports'] as { message: string }[]).map((x) => x.message);

  assert.ok(
    messages(mine).some((m) => m.includes('worked the homestead')),
    "alice cannot read her own private report",
  );
  assert.ok(
    !messages(theirs).some((m) => m.includes('worked the homestead')),
    "bob can read alice's private report",
  );
  // Both see the public herald.
  assert.ok(messages(theirs).some((m) => m.startsWith('Day 1:')));
});

test('server: the map, roster and leaderboard are readable and consistent', { skip }, async () => {
  const { worldId } = await seedWorld(sql, {
    seed: 'reads',
    humans: [
      { userId: ALICE, handle: 'alice' },
      { userId: BOB, handle: 'bob' },
    ],
  });
  const map = await call('GET', `/v1/worlds/${worldId}/map`, { as: 'alice' });
  assert.equal((map.body['tiles'] as unknown[]).length, 256);

  const roster = await call('GET', `/v1/worlds/${worldId}/roster`, { as: 'alice' });
  assert.equal((roster.body['roster'] as unknown[]).length, 2);

  const board = await call('GET', `/v1/worlds/${worldId}/leaderboard`, { as: 'alice' });
  const ranks = (board.body['leaderboard'] as { rank: number }[]).map((e) => e.rank);
  assert.deepEqual(ranks, [1, 2], 'the leaderboard is not ranked from one');
});

test('server: the archive is refused until the season ends', { skip }, async () => {
  const { worldId } = await seedWorld(sql, { seed: 'archive', seasonLength: 5 });
  assert.equal((await call('GET', `/v1/worlds/${worldId}/archive`, { as: 'alice' })).status, 409);
  for (let i = 0; i < 5; i++) await resolveWorldDay(asDb(sql), 'nda', worldId, new Date(), withOutbox);
  const res = await call('GET', `/v1/worlds/${worldId}/archive`, { as: 'alice' });
  assert.equal(res.status, 200);
  assert.equal(res.body['finalDay'], 5);
  assert.ok((res.body['winners'] as unknown[]).length >= 1);
});

test('server: progress never publishes the internal streak cursor', { skip }, async () => {
  const { worldId } = await seedWorld(sql, { seed: 'progress' });
  const res = await call('GET', `/v1/worlds/${worldId}/progress`, { as: 'alice' });
  assert.equal(res.status, 200);
  const progress = res.body['progress'] as Record<string, unknown>;
  assert.ok('level' in progress && 'streak' in progress);
  assert.ok(
    !('lastSeenDay' in progress),
    'lastSeenDay is an internal cursor; publishing it makes it a thing a client depends on',
  );
});

/* ------------------------------------------------------------------ input validation */

test('server: an unknown action type is a 400, not a silently dropped action', { skip }, async () => {
  const { worldId } = await seedWorld(sql, { seed: 'unknown-action' });
  const res = await call('PUT', `/v1/worlds/${worldId}/actions`, {
    as: 'alice',
    key: 'bad-1',
    body: { actions: [{ type: 'teleport' }] },
  });
  assert.equal(res.status, 400);
});

test('server: a malformed body is a 400 and changes nothing', { skip }, async () => {
  const { worldId } = await seedWorld(sql, { seed: 'malformed' });
  const res = await fetch(`${base}/v1/worlds/${worldId}/actions`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer alice',
      'idempotency-key': 'm1',
    },
    body: '{not json',
  });
  assert.equal(res.status, 400);
});

/* ------------------------------------------------------------------ the cosmetic bridge */

test('server: equipping a cosmetic the account does not own is refused', { skip }, async () => {
  const { worldId } = await seedWorld(sql, { seed: 'cosmetic-deny' });
  const res = await call('PUT', `/v1/worlds/${worldId}/cosmetics`, {
    as: 'alice',
    key: 'c1',
    body: { slot: 'homestead_skin', itemUrn: 'skin_bunker' },
  });
  assert.equal(res.status, 403);
  assert.equal((res.body['error'] as Record<string, unknown>)['code'], 'cosmetic_not_owned');

  const me = await playerOf(asDb(sql), worldId, ALICE);
  assert.equal(me?.cosmetic_style, null, 'a refused cosmetic was persisted anyway');
});

test('server: equipping an OWNED cosmetic succeeds and is visible on the roster', { skip }, async () => {
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'cosmetic-allow' });
  billing.grant(playerIds[0]!, {
    id: 'e1',
    sku: 'skin_bunker',
    scope: 'title:nda',
    active: true,
  });
  const res = await call('PUT', `/v1/worlds/${worldId}/cosmetics`, {
    as: 'alice',
    key: 'c2',
    body: { slot: 'homestead_skin', itemUrn: 'skin_bunker' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body['equipped'], { homestead_skin: 'skin_bunker' });

  const roster = await call('GET', `/v1/worlds/${worldId}/roster`, { as: 'alice' });
  const entry = (roster.body['roster'] as { cosmeticStyle: string | null }[])[0];
  assert.match(entry!.cosmeticStyle ?? '', /skin_bunker/);
});

test('server: a billing outage fails the equip CLOSED and the read OPEN', { skip }, async () => {
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'cosmetic-outage' });
  billing.grant(playerIds[0]!, { id: 'e1', sku: 'frame_iron', scope: 'platform', active: true });
  billing.setUnavailable(true);
  try {
    // WRITE: "ask again later", never "wear it anyway".
    const write = await call('PUT', `/v1/worlds/${worldId}/cosmetics`, {
      as: 'alice',
      key: 'c3',
      body: { slot: 'avatar_frame', itemUrn: 'frame_iron' },
    });
    assert.equal(write.status, 503);
    assert.equal(
      (write.body['error'] as Record<string, unknown>)['code'],
      'entitlements_unavailable',
    );

    // READ: this runs on every load and reads only our own data, so a shop restarting must not
    // break the game screen.
    const read = await call('GET', `/v1/worlds/${worldId}/cosmetics`, { as: 'alice' });
    assert.equal(read.status, 200);
    assert.equal(read.body['unlocked'], null, 'the read should say "unknown", not fail');
    assert.deepEqual(read.body['equipped'], {});
  } finally {
    billing.setUnavailable(false);
  }
});

test('server: clearing a slot never needs an entitlement', { skip }, async () => {
  // You may always take something off, including something you no longer own.
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'cosmetic-clear' });
  billing.grant(playerIds[0]!, { id: 'e1', sku: 'name_gold', scope: 'platform', active: true });
  await call('PUT', `/v1/worlds/${worldId}/cosmetics`, {
    as: 'alice',
    key: 'c4',
    body: { slot: 'name_color', itemUrn: 'name_gold' },
  });
  billing.setUnavailable(true);
  try {
    const res = await call('PUT', `/v1/worlds/${worldId}/cosmetics`, {
      as: 'alice',
      key: 'c5',
      body: { slot: 'name_color', itemUrn: null },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body['equipped'], {});
  } finally {
    billing.setUnavailable(false);
  }
});

test('server: an unknown cosmetic slot is refused', { skip }, async () => {
  const { worldId } = await seedWorld(sql, { seed: 'cosmetic-slot' });
  const res = await call('PUT', `/v1/worlds/${worldId}/cosmetics`, {
    as: 'alice',
    key: 'c6',
    body: { slot: 'weapon', itemUrn: 'sword_of_winning' },
  });
  assert.equal(res.status, 400);
});

/* ------------------------------------------------------------------ admin */

test('server: an admin can create, start, populate and force a tick on a world', { skip }, async () => {
  const created = await call('POST', '/v1/worlds', {
    as: 'admin',
    key: 'w1',
    body: { name: 'an admin world', width: 16, height: 16, tickIntervalMinutes: 1 },
  });
  assert.equal(created.status, 201);
  const worldId = (created.body['world'] as Record<string, string>)['id']!;

  const started = await call('POST', `/v1/worlds/${worldId}/start`, { as: 'admin', key: 's1' });
  assert.equal(started.status, 200);

  const bots = await call('PUT', `/v1/worlds/${worldId}/bots`, {
    as: 'admin',
    key: 'b1',
    body: { enabled: true, count: 3 },
  });
  assert.equal(bots.status, 200);
  assert.equal(bots.body['bots'], 3);

  // A forced tick ENQUEUES the leased job rather than resolving inline, so an operator and the
  // scheduler go through one lease rather than being two writers.
  const ticked = await call('POST', `/v1/worlds/${worldId}/tick`, { as: 'admin', key: 't1' });
  assert.equal(ticked.status, 202);
  const [job] = await sql<{ n: number }[]>`
    select count(*)::int as n from jobs where kind = 'world.tick' and key = ${worldId}`;
  assert.equal(job!.n, 1);
});
