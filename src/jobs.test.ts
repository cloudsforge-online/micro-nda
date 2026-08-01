// Leased-job safety, and the races that matter in a simulation.
//
// The estate rule is that background work is a leased job claimed FOR UPDATE SKIP LOCKED and that
// two workers on one job produce exactly one run. 04-domain-model §10.5 names the specific harm for
// `world.tick`: **double XP and double days-survived.**
//
// This file proves it twice, at both defences, because they are independent:
//
//   1. With the real JobQueue — two runners racing one `world.tick` key, one claim.
//   2. WITHOUT the queue at all — two concurrent `resolveWorldDay` calls on one world, straight at
//      the persistence layer. This is the one that matters, because it is what holds when the lease
//      does NOT: an expired lease under a slow resolution, an operator forcing a tick while the
//      scheduler is mid-flight, a redelivered job. A defence only ever exercised through the thing
//      it backs up has never actually been tested.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetNda,
  asDb,
  seedWorld,
  ALICE,
  BOB,
} from './testsupport.ts';
import { withOutbox } from './outbox.ts';
import { dueWorldIds, enqueueBotActions, queueActions, resolveWorldDay, syncBots } from './worlds.ts';
import { WORLD_TICK_KIND, RECURRING, RELAY_KIND, WORLD_SWEEP_KIND } from './jobs.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb(10);
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetNda(sql);
});
after(async () => {
  if (sql) await sql.end();
});

/* ------------------------------------------------------------------ the queue primitive */

test('jobs: two workers racing one job — exactly one claims it', { skip }, async () => {
  const a = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  const b = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-b' });
  await a.enqueue({ kind: WORLD_TICK_KIND, key: 'world-1' });

  const [ca, cb] = await Promise.all([
    a.claim(1, [WORLD_TICK_KIND]),
    b.claim(1, [WORLD_TICK_KIND]),
  ]);
  assert.equal([...ca, ...cb].length, 1, 'exactly one worker must claim the single job');
});

test('jobs: enqueue is idempotent per (kind, key)', { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  for (let i = 0; i < 5; i++) {
    await q.enqueue({ kind: WORLD_TICK_KIND, key: 'world-1', onConflict: 'keep' });
  }
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from jobs where kind = ${WORLD_TICK_KIND}`;
  assert.equal(rows[0]!.n, 1, 'five enqueues of one world produced more than one pending tick');
});

test('jobs: the tick lease is keyed on the world, so two worlds run in parallel', { skip }, async () => {
  // The key names the CONTENDED RESOURCE. Two different worlds contend for nothing, and a key that
  // serialised them (a global 'stream', say) would make the whole estate's throughput one world.
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await q.enqueue({ kind: WORLD_TICK_KIND, key: 'world-1' });
  await q.enqueue({ kind: WORLD_TICK_KIND, key: 'world-2' });
  const claimed = await q.claim(2, [WORLD_TICK_KIND]);
  assert.equal(claimed.length, 2);
});

test('jobs: every recurring job is registered exactly once and has a sane interval', { skip }, () => {
  const seen = new Set<string>();
  for (const r of RECURRING) {
    const id = `${r.kind}:${r.key}`;
    assert.ok(!seen.has(id), `${id} is declared twice`);
    seen.add(id);
    assert.ok(r.everyMs >= 1_000, `${id} would re-arm faster than once a second`);
  }
  assert.ok(seen.has(`${RELAY_KIND}:stream`));
  assert.ok(seen.has(`${WORLD_SWEEP_KIND}:stream`));
});

/* ------------------------------------------------------------------ the resolution race */

test(
  'tick: two workers, one due world — exactly one day is resolved, and it is resolved once',
  { skip },
  async () => {
    const db = asDb(sql);
    const { worldId, playerIds } = await seedWorld(sql, {
      seed: 'race-seed',
      humans: [
        { userId: ALICE, handle: 'alice' },
        { userId: BOB, handle: 'bob' },
      ],
    });
    // Both survivors work, so the day grants XP and days-survived — the two things
    // 04-domain-model §10.5 says a double resolution destroys.
    for (const userId of [ALICE, BOB]) {
      await queueActions(
        db,
        'nda',
        { worldId, userId, actions: [{ type: 'work' }, { type: 'work' }] },
        withOutbox,
      );
    }

    const now = new Date();
    const [a, b] = await Promise.all([
      resolveWorldDay(db, 'nda', worldId, now, withOutbox),
      resolveWorldDay(db, 'nda', worldId, now, withOutbox),
    ]);

    const outcomes = [a, b].filter((o) => o !== null);
    assert.equal(outcomes.length, 1, 'both workers wrote a day — this is the double-XP defect');
    assert.equal(outcomes[0]!.day, 1);

    const [world] = await sql<{ day: number }[]>`select day from worlds where id = ${worldId}`;
    assert.equal(world!.day, 1, 'the calendar advanced more than one day');

    // The observable damage, checked directly rather than inferred from the return value.
    for (const playerId of playerIds) {
      const [g] = await sql<{ xp: number; days_survived: number }[]>`
        select xp, days_survived from player_progress where player_id = ${playerId}`;
      // 2 actions × XP_PER_ACTION(2) + XP_PER_SURVIVED_DAY(5) = 9. Doubled it would be 18.
      assert.equal(g!.xp, 9, `${playerId} was granted XP twice`);
      assert.equal(g!.days_survived, 1, `${playerId} survived the same day twice`);
    }

    const [reports] = await sql<{ n: number }[]>`
      select count(*)::int as n from reports where world_id = ${worldId} and day = 1`;
    const [heralds] = await sql<{ n: number }[]>`
      select count(*)::int as n from reports where world_id = ${worldId} and kind = 'world'`;
    assert.equal(heralds!.n, 1, 'the day was heralded twice');
    assert.ok(reports!.n > 1, 'the day produced no per-action reports at all');
  },
);

test('tick: five concurrent resolutions of one world still advance exactly one day', { skip }, async () => {
  // Two is the case that matters; five is the case that catches a defence which happens to work
  // for a pair. They all read the same day, all simulate it, and all but one must write nothing.
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'five-seed' });
  const now = new Date();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => resolveWorldDay(db, 'nda', worldId, now, withOutbox)),
  );
  assert.equal(results.filter((r) => r !== null).length, 1);

  const alice = playerIds[0];
  assert.ok(alice, 'the fixture settled nobody');
  const [g] = await sql<{ days_survived: number }[]>`
    select days_survived from player_progress where player_id = ${alice}`;
  assert.equal(g!.days_survived, 1);
});

test('tick: a resolution whose day moved under it writes nothing at all', { skip }, async () => {
  // The conditional advance, tested DETERMINISTICALLY rather than by hoping a race lands the right
  // way round. A separate connection takes the world row's lock and advances the day; the
  // resolution — which has already simulated day 1 from a snapshot taken before that — then blocks
  // on the lock, wakes to find the row reading day 1, and must write nothing.
  //
  // This is the shape of an expired lease under a slow resolution, and it is the only defence left
  // standing when that happens.
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'stale-seed' });
  await queueActions(db, 'nda', { worldId, userId: ALICE, actions: [{ type: 'work' }] }, withOutbox);

  const before = await sql<{ n: number }[]>`
    select count(*)::int as n from reports where world_id = ${worldId}`;

  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: (() => void) | undefined;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });

  // Connection A: take the lock, move the day, and sit on it until told to commit.
  const usurper = sql.begin(async (tx) => {
    await tx`select day from worlds where id = ${worldId} for update`;
    await tx`update worlds set day = 1 where id = ${worldId}`;
    locked?.();
    await held;
  });

  await isLocked;
  // Connection B: resolve. It reads day 0 (its snapshot predates the commit above), simulates, then
  // blocks on the lock inside persistDay.
  const resolution = resolveWorldDay(db, 'nda', worldId, new Date(), withOutbox);
  await new Promise((r) => setTimeout(r, 150));
  release?.();
  await usurper;

  assert.equal(await resolution, null, 'a stale resolution was allowed to write');

  const after = await sql<{ n: number }[]>`
    select count(*)::int as n from reports where world_id = ${worldId}`;
  assert.equal(after[0]!.n, before[0]!.n, 'a refused resolution still wrote reports');

  const alice = playerIds[0];
  assert.ok(alice);
  const [g] = await sql<{ xp: number; days_survived: number }[]>`
    select xp, days_survived from player_progress where player_id = ${alice}`;
  assert.equal(g!.xp, 0, 'a refused resolution still granted XP');
  assert.equal(g!.days_survived, 0, 'a refused resolution still credited a day survived');

  const [world] = await sql<{ day: number }[]>`select day from worlds where id = ${worldId}`;
  assert.equal(world!.day, 1, 'the refused resolution moved the calendar anyway');
});

test('tick: sequential resolutions advance exactly one day each', { skip }, async () => {
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'sequential-seed' });
  for (let expected = 1; expected <= 3; expected++) {
    const outcome = await resolveWorldDay(db, 'nda', worldId, new Date(), withOutbox);
    assert.equal(outcome?.day, expected);
  }
  const [days] = await sql<{ n: number }[]>`
    select count(distinct day)::int as n from reports where world_id = ${worldId}`;
  assert.equal(days!.n, 3, 'three resolutions did not produce three distinct report days');
  const [heralds] = await sql<{ n: number }[]>`
    select count(*)::int as n from reports where world_id = ${worldId} and kind = 'world'`;
  assert.equal(heralds!.n, 3, 'a day was heralded more than once');
});

test('tick: a world that is not active resolves nothing', { skip }, async () => {
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'lobby-seed' });
  await sql`update worlds set status = 'archived' where id = ${worldId}`;
  assert.equal(await resolveWorldDay(db, 'nda', worldId, new Date(), withOutbox), null);
});

test('tick: the last day of a season archives the world and stops scheduling it', { skip }, async () => {
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'end-seed', seasonLength: 5 });
  let outcome = null;
  for (let i = 0; i < 5; i++) {
    outcome = await resolveWorldDay(db, 'nda', worldId, new Date(), withOutbox);
  }
  assert.equal(outcome?.day, 5);
  assert.equal(outcome?.archived, true);

  const [world] = await sql<{ status: string; next_tick_at: Date | null }[]>`
    select status, next_tick_at from worlds where id = ${worldId}`;
  assert.equal(world!.status, 'archived');
  assert.equal(world!.next_tick_at, null, 'an archived world is still scheduled to tick');
  assert.deepEqual(await dueWorldIds(db, new Date(Date.now() + 86_400_000), 10), []);
});

/* ------------------------------------------------------------------ due detection */

test('tick: only overdue active worlds are swept', { skip }, async () => {
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'due-seed' });
  // tickIntervalMinutes is 1 in the fixture, so the world is due a minute from now and not before.
  assert.deepEqual(await dueWorldIds(db, new Date(Date.now() - 60_000), 10), []);
  assert.deepEqual(await dueWorldIds(db, new Date(Date.now() + 120_000), 10), [worldId]);
});

/* ------------------------------------------------------------------ bots inside the lease */

test('tick: bots plan before the day resolves, and their queue is replaced not appended', { skip }, async () => {
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'bots-seed', width: 20, height: 20 });
  await syncBots(db, 'nda', worldId, true, 5, withOutbox);

  const first = await enqueueBotActions(db, worldId);
  assert.ok(first > 0, 'the bots planned nothing');
  const second = await enqueueBotActions(db, worldId);
  assert.equal(second, first, 'a second pass planned a different number of actions');

  const [rows] = await sql<{ n: number }[]>`
    select count(*)::int as n from queued_actions q
      join players p on p.id = q.player_id
     where q.world_id = ${worldId} and p.is_bot = true`;
  assert.equal(rows!.n, first, 'the second pass appended to the queue instead of replacing it');
});

test('tick: a human offer to a bot survives the bot planning pass', { skip }, async () => {
  // The ancestor's own note: a bot that never looks at its post can never agree to anything, and
  // every human trade with a bot would expire unmatched. The pending read has to happen BEFORE the
  // bots' half of the queue is cleared.
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'offer-seed', width: 20, height: 20 });
  await syncBots(db, 'nda', worldId, true, 5, withOutbox);

  const [trader] = await sql<{ id: string }[]>`
    select id from players where world_id = ${worldId} and personality = 'trader'`;
  assert.ok(trader, 'no trader bot was spawned');

  await queueActions(
    db,
    'nda',
    {
      worldId,
      userId: ALICE,
      actions: [
        { type: 'trade', targetPlayerId: trader.id, offer: { materials: 4 }, request: { food: 3 } },
      ],
    },
    withOutbox,
  );

  await enqueueBotActions(db, worldId);

  const rows = await sql<{ action: { type: string; targetPlayerId?: string } }[]>`
    select action from queued_actions where player_id = ${trader.id} order by seq`;
  const accepted = rows.some(
    (r) => r.action.type === 'trade' && r.action.targetPlayerId !== undefined,
  );
  assert.ok(accepted, 'the trader bot did not queue a mirror for a fair standing offer');

  const [mine] = await sql<{ n: number }[]>`
    select count(*)::int as n from queued_actions q
      join players p on p.id = q.player_id
     where q.world_id = ${worldId} and p.user_id = ${ALICE}`;
  assert.equal(mine!.n, 1, "the bot pass deleted the human's queued offer");
});
