// The achievement bridge to the worlds shared profile.
//
// This is the thing the ancestor did not have: its achievements were rows in the world they were
// earned in and died with the season. Delivery here is a leased job, so the properties that matter
// are the ones a job has to have — a worlds outage delays a badge rather than losing it, and no
// number of retries posts one twice.
//
// `fakeWorlds` is a real `node:http` server, so the idempotency key, the bearer header and the
// error mapping are exercised over a socket rather than stubbed.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type postgres from 'postgres';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetNda,
  asDb,
  quietLogger,
  fakeWorlds,
  worldsClientFor,
  fakeWorldsClient,
  seedWorld,
  ALICE,
  NDA_TITLE_ID,
  type FakeWorlds,
} from './testsupport.ts';
import { withOutbox } from './outbox.ts';
import { deliverAchievement, outstandingAchievementIds } from './achievements.ts';
import {
  WorldsMisroutedError,
  WorldsRefusedError,
  WorldsUnavailableError,
  httpWorldsClient,
  type WorldsClient,
} from './worldsclient.ts';
import { resolveWorldDay, syncBots } from './worlds.ts';
import { ACHIEVEMENTS } from './rules.ts';

let sql: postgres.Sql;
let worlds: FakeWorlds;
let client: WorldsClient;

before(async () => {
  if (!enabled) return;
  sql = openDb();
  await migrateTestDb(sql);
  worlds = await fakeWorlds();
  client = await worldsClientFor(worlds);
});
beforeEach(async () => {
  if (enabled) await resetNda(sql);
});
after(async () => {
  if (worlds) await worlds.close();
  if (sql) await sql.end();
});

/** Unlock a badge directly, so the delivery path can be tested without playing ninety days. */
async function unlock(worldId: string, playerId: string, achId: string): Promise<string> {
  const def = ACHIEVEMENTS.find((a) => a.id === achId)!;
  const id = `${playerId}:${achId}`;
  await sql`
    insert into achievements (id, world_id, player_id, ach_id, name, description, points, unlocked_at)
    values (${id}, ${worldId}, ${playerId}, ${achId}, ${def.name}, ${def.description},
            ${def.points}, 1)`;
  return id;
}

/* ------------------------------------------------------------------ the catalogue */

test('achievements: every achievement carries points the shared profile can use', () => {
  // The ancestor's badges never left their world, so they had no points. Worlds' profile takes one.
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.points > 0 && a.points <= 1000, `${a.id} has an unusable points value`);
  }
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length, 'duplicate id');
});

/* ------------------------------------------------------------------ delivery */

test('achievements: an unlocked badge is delivered once and marked', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'deliver' });
  const id = await unlock(worldId, playerIds[0]!, 'days_30');

  assert.deepEqual(await outstandingAchievementIds(db), [id]);
  const outcome = await deliverAchievement({ sql: db, worlds: client, logger: quietLogger() }, id, 'c1');
  assert.equal(outcome, 'delivered');
  assert.equal(worlds.posted.length, 1);
  assert.equal(worlds.posted[0]!.key, 'days_30');
  assert.equal(worlds.posted[0]!.userId, ALICE);

  // The badge landed on the route worlds actually serves, under the title's UUID. Asserted against
  // the literal path rather than against a helper the client also uses: a test that builds the
  // expected URL the same way the client does compares a value with a copy of itself.
  assert.ok(
    worlds.requested.includes(`POST /v1/titles/${NDA_TITLE_ID}/achievements/unlock`),
    `the unlock never reached worlds' real route; it asked for ${JSON.stringify(worlds.requested)}`,
  );
  assert.ok(
    !worlds.requested.some((r) => r.includes('/internal/')),
    'the client is still calling a route worlds does not serve',
  );

  // Marked, so the sweep stops finding it.
  assert.deepEqual(await outstandingAchievementIds(db), []);
  const again = await deliverAchievement({ sql: db, worlds: client, logger: quietLogger() }, id, 'c2');
  assert.equal(again, 'already');
  assert.equal(worlds.posted.length, 1, 'a re-run posted the badge a second time');
});

test('achievements: the delivery key is derived from (user, code), not from the job', { skip }, async () => {
  // A retried, redelivered or differently-replica'd job must post the SAME key, or worlds records
  // the badge twice. Keying on the job id would be the obvious mistake and would look correct in
  // every single-attempt test.
  const db = asDb(sql);
  const recorder = fakeWorldsClient();
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'key' });
  const id = await unlock(worldId, playerIds[0]!, 'first_trade');

  await deliverAchievement({ sql: db, worlds: recorder, logger: quietLogger() }, id, 'job-alpha');
  await sql`update achievements set delivered_at = null where id = ${id}`;
  await deliverAchievement({ sql: db, worlds: recorder, logger: quietLogger() }, id, 'job-beta');

  assert.equal(recorder.posts.length, 1, 'two attempts produced two distinct posts');
  assert.equal(recorder.posts[0]!.key, 'first_trade');
  assert.equal(recorder.posts[0]!.userId, ALICE);
});

test('achievements: a brief outage is absorbed inside one delivery, on the same key', { skip }, async () => {
  // `@cloudsforge/http` retries an idempotency-keyed POST twice before giving up (three attempts
  // total). It reuses the SAME key, which is what makes retrying a POST safe at all — so a worlds
  // instance restarting mid-post costs a couple of hundred milliseconds and nothing else.
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'blip' });
  const id = await unlock(worldId, playerIds[0]!, 'fort_20');

  worlds.failNext(2);
  assert.equal(
    await deliverAchievement({ sql: db, worlds: client, logger: quietLogger() }, id, 'c1'),
    'delivered',
  );
  assert.equal(worlds.posted.filter((p) => p.key === 'fort_20').length, 1);
});

test('achievements: a longer outage delays the badge and then it lands', { skip }, async () => {
  // Past the client's own budget, so the failure reaches the JOB — which is the layer that turns a
  // sustained outage into a delay rather than a lost badge. Throwing here is load-bearing: a
  // swallowed error would be recorded as success and the runner would never come back.
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'outage' });
  const id = await unlock(worldId, playerIds[0]!, 'first_kill');
  // Its OWN client: `HttpClient` keeps a circuit breaker per instance, and failures deliberately
  // accumulate across calls. Sharing the module-level client would make this test's result depend
  // on how many 503s the tests before it happened to provoke.
  const isolated = await worldsClientFor(worlds);

  // Exactly the client's budget of three attempts, so the first delivery exhausts it and throws,
  // and the second — the job's retry — finds worlds healthy again.
  worlds.failNext(3);
  await assert.rejects(
    () => deliverAchievement({ sql: db, worlds: isolated, logger: quietLogger() }, id, 'c1'),
    WorldsUnavailableError,
    'an outage was swallowed instead of thrown — the job would never retry',
  );
  // Still outstanding, so the sweep comes back for it. That is the whole point of the job.
  assert.deepEqual(await outstandingAchievementIds(db), [id]);
  const [row] = await sql<{ delivered_at: Date | null }[]>`
    select delivered_at from achievements where id = ${id}`;
  assert.equal(row!.delivered_at, null, 'a failed post was recorded as delivered');

  assert.equal(
    await deliverAchievement({ sql: db, worlds: await worldsClientFor(worlds), logger: quietLogger() }, id, 'c2'),
    'delivered',
  );
  assert.equal(
    worlds.posted.filter((p) => p.key === 'first_kill').length,
    1,
    'the outage produced a duplicate badge once worlds came back',
  );
});

test('achievements: a permanent refusal is terminal, not an infinite retry', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'refused' });
  const id = await unlock(worldId, playerIds[0]!, 'level_10');
  const refusing: WorldsClient = {
    async postAchievement() {
      throw new WorldsRefusedError(422, 'worlds answered 422');
    },
  };
  const outcome = await deliverAchievement(
    { sql: db, worlds: refusing, logger: quietLogger() },
    id,
    'c1',
  );
  assert.equal(outcome, 'refused', 'a 4xx was retried; the job would spin until it died');
});

/* ------------------------------------------- the defect: a badge that was thrown away in silence */

/**
 * A worlds that serves its registry and nothing else — the exact shape of production for four
 * months. Real worlds has 22 routes and none of them was the one this client asked for, so every
 * unlock came back 404.
 */
async function worldsWithoutTheUnlockRoute(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown): void => {
      const payload = `${JSON.stringify(body)}\n`;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    };
    if (url.pathname === '/v1/titles' && req.method === 'GET') {
      return send(200, { titles: [{ id: NDA_TITLE_ID, slug: 'nda', name: 'Ninety Days After' }] });
    }
    return send(404, { error: { code: 'not_found', message: 'no route' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test(
  'achievements: a route worlds does not serve keeps the badge, it does not discard it',
  { skip },
  async () => {
    // THE REGRESSION. This is the defect exactly: worlds answers 404 because the endpoint is not
    // there. 404 is a 4xx, so `HttpError.peerDecided` is true, so the old client raised
    // `WorldsRefusedError` and `deliverAchievement` returned the TERMINAL outcome 'refused' — the
    // row was left undelivered but the sweep had already been told the answer was final, and the
    // badge was gone. Nothing threw, nothing was logged at error, and every test was green.
    //
    // "The endpoint does not exist" and "the peer declined" are different facts. Only the second is
    // safe to stop retrying on. So this must THROW, keeping the badge for a later sweep.
    const db = asDb(sql);
    const dead = await worldsWithoutTheUnlockRoute();
    try {
      const { worldId, playerIds } = await seedWorld(sql, { seed: 'missing-route' });
      const id = await unlock(worldId, playerIds[0]!, 'days_60');
      const blind = httpWorldsClient({
        baseUrl: dead.baseUrl,
        token: () => 'worlds-token',
        deadlineMs: 5_000,
      });

      const outcome = await deliverAchievement(
        { sql: db, worlds: blind, logger: quietLogger() },
        id,
        'c1',
      ).then(
        (value) => ({ kind: 'returned' as const, value }),
        (err: unknown) => ({ kind: 'threw' as const, err }),
      );

      assert.equal(
        outcome.kind,
        'threw',
        `a 404 was recorded as the terminal outcome ${JSON.stringify((outcome as { value?: string }).value)} — the badge was discarded, not delayed`,
      );
      assert.ok(
        outcome.kind === 'threw' && outcome.err instanceof WorldsMisroutedError,
        `expected a misrouted error, got ${String(outcome.kind === 'threw' ? outcome.err : '')}`,
      );
      assert.notEqual(
        outcome.kind === 'threw' && outcome.err instanceof WorldsRefusedError,
        true,
        'a missing endpoint was classified as the peer refusing',
      );

      // And the badge survives, which is the property the user actually cares about.
      assert.deepEqual(
        await outstandingAchievementIds(db),
        [id],
        'the badge left the sweep — it can never be delivered now',
      );
      const [row] = await sql<{ delivered_at: Date | null }[]>`
        select delivered_at from achievements where id = ${id}`;
      assert.equal(row!.delivered_at, null, 'an undelivered badge was marked delivered');
    } finally {
      await dead.close();
    }
  },
);

test(
  'achievements: the scope worlds demands is the scope we present, and a wrong one is not terminal',
  { skip },
  async () => {
    // Both clients declared `worlds:write` for months. The unlock route demands `worlds:title`
    // (worlds/src/server.ts) — a separate authority so a title's credential cannot edit a
    // player's profile. Fixing only the route would have turned a silent 404 into a silent 403.
    const db = asDb(sql);
    const underscoped = await fakeWorlds({ scopes: ['worlds:write'] });
    try {
      const { worldId, playerIds } = await seedWorld(sql, { seed: 'scope' });
      const id = await unlock(worldId, playerIds[0]!, 'level_10');
      const client403 = await worldsClientFor(underscoped);

      await assert.rejects(
        () => deliverAchievement({ sql: db, worlds: client403, logger: quietLogger() }, id, 'c1'),
        WorldsMisroutedError,
        'a 403 for a missing scope was swallowed as a refusal; the badge would be gone',
      );
      assert.deepEqual(await outstandingAchievementIds(db), [id]);
      assert.equal(underscoped.posted.length, 0);
    } finally {
      await underscoped.close();
    }
  },
);

test(
  'achievements: an achievement is defined before it is unlocked',
  { skip },
  async () => {
    // `worlds/src/rewards.ts` refuses an unlock for an achievement it has never been told
    // about, and the server maps that to 400. The old client sent `name` and `points` on the
    // unlock, believing worlds would create the achievement for it — it does not. Two calls, two
    // documents.
    const db = asDb(sql);
    const fresh = await fakeWorlds();
    try {
      const { worldId, playerIds } = await seedWorld(sql, { seed: 'define' });
      const id = await unlock(worldId, playerIds[0]!, 'days_90');
      const c = await worldsClientFor(fresh);

      assert.equal(
        await deliverAchievement({ sql: db, worlds: c, logger: quietLogger() }, id, 'c1'),
        'delivered',
      );
      assert.ok(fresh.defined.has('days_90'), 'the badge was unlocked without ever being defined');
      assert.ok(
        fresh.requested.indexOf(`PUT /v1/titles/${NDA_TITLE_ID}/achievements`) <
          fresh.requested.indexOf(`POST /v1/titles/${NDA_TITLE_ID}/achievements/unlock`),
        'the unlock was sent before the definition',
      );
    } finally {
      await fresh.close();
    }
  },
);

test('achievements: a bot badge is never posted to a profile', { skip }, async () => {
  // A bot has no account, so there is no profile to post to. Excluded at the SOURCE rather than at
  // delivery, or the sweep would carry a permanent backlog it could never drain and would hide a
  // real one behind it.
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'bot-badge', width: 20, height: 20 });
  await syncBots(db, 'nda', worldId, true, 3, withOutbox);
  const [bot] = await sql<{ id: string }[]>`
    select id from players where world_id = ${worldId} and is_bot = true limit 1`;
  const id = await unlock(worldId, bot!.id, 'first_scavenge');

  assert.deepEqual(await outstandingAchievementIds(db), [], 'a bot badge entered the sweep');
  assert.equal(
    await deliverAchievement({ sql: db, worlds: client, logger: quietLogger() }, id, 'c1'),
    'unowned',
  );
});

test('achievements: a badge that has been deleted is not an error', { skip }, async () => {
  const db = asDb(sql);
  assert.equal(
    await deliverAchievement({ sql: db, worlds: client, logger: quietLogger() }, 'gone', 'c1'),
    'gone',
  );
});

/* ------------------------------------------------------------------ from the engine */

test(
  'achievements: a real day of play unlocks a badge exactly once, however many days follow',
  { skip },
  async () => {
    // The unique constraint IS the idempotency: a tick that re-evaluates the milestone conflicts
    // rather than unlocking twice.
    const db = asDb(sql);
    const { worldId, playerIds } = await seedWorld(sql, { seed: 'earned', seasonLength: 40 });
    const me = playerIds[0]!;
    // Two days short of the days_30 milestone, so the very next tick crosses it.
    await sql`update player_progress set days_survived = 29 where player_id = ${me}`;
    // Enough food and water to survive the run without starving out.
    await sql`
      update players set resources = '{"food":400,"water":400,"materials":40,"fuel":10,"medicine":10,"seeds":10}'::jsonb
       where id = ${me}`;

    for (let i = 0; i < 4; i++) await resolveWorldDay(db, 'nda', worldId, new Date(), withOutbox);

    const rows = await sql<{ ach_id: string; unlocked_at: number }[]>`
      select ach_id, unlocked_at from achievements where player_id = ${me} order by ach_id`;
    const days30 = rows.filter((r) => r.ach_id === 'days_30');
    assert.equal(days30.length, 1, 'days_30 was unlocked more than once across four days');
    assert.equal(days30[0]!.unlocked_at, 1, 'the milestone was not credited on the day it was met');
  },
);
