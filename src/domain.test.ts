// The world's own rules, against a real Postgres.
//
// The centre of this file is the set of invariants the ANCESTOR fought for and wrote down. Each one
// was a live defect there before someone closed it, and each one would be silently re-opened by a
// port that transcribed the happy path. They are named for what they prevent, and several replay
// the exact exploit the ancestor's comments describe.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
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
  CAROL,
} from './testsupport.ts';
import { withOutbox } from './outbox.ts';
import {
  ConflictError,
  ValidationError,
  claimObjective,
  createWorld,
  joinWorld,
  playerOf,
  queueActions,
  queuedActionsOf,
  resolveWorldDay,
  roster,
  startWorld,
  syncBots,
  unlockPerk,
} from './worlds.ts';
import {
  communeDetail,
  creditOnJoin,
  creditOnLeave,
  depositToCommune,
  foundCommune,
  joinCommune,
  leaveCommune,
  listCommunes,
  withdrawFromCommune,
} from './communes.ts';
import { COMMUNE_JOIN_STIPEND } from './rules.ts';

let sql: postgres.Sql;
const P = 'nda';

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

/* ------------------------------------------------------------------ world lifecycle */

test('worlds: a created world has a full map, a seeded pool, and no survivors', { skip }, async () => {
  const db = asDb(sql);
  const world = await createWorld(db, P, { name: 'a new region', width: 16, height: 16 }, withOutbox);
  const [tiles] = await sql<{ n: number }[]>`
    select count(*)::int as n from tiles where world_id = ${world.id}`;
  assert.equal(tiles!.n, 256, 'the map is not 16 by 16');
  const [ruins] = await sql<{ n: number }[]>`
    select count(*)::int as n from tiles where world_id = ${world.id} and terrain = 'ruins'`;
  assert.ok(ruins!.n >= 4, 'a region with fewer than four ruins has nothing to scavenge');
  const [stock] = await sql<{ stock: Record<string, number> }[]>`
    select stock from world_stock where world_id = ${world.id}`;
  assert.ok(stock!.stock['fuel']! > 0 && stock!.stock['medicine']! > 0 && stock!.stock['seeds']! > 0);
  // Food, water and materials are the players' to produce; the region holds none.
  assert.equal(stock!.stock['food'], 0);
});

test('worlds: the seed defaults to the id, which is what the ancestor always used', { skip }, async () => {
  const db = asDb(sql);
  const world = await createWorld(db, P, { name: 'default seed' }, withOutbox);
  assert.equal(world.seed, world.id);
  const named = await createWorld(db, P, { name: 'named seed', seed: 'chosen' }, withOutbox);
  assert.equal(named.seed, 'chosen');
});

test('worlds: two worlds on one seed generate the same map', { skip }, async () => {
  const db = asDb(sql);
  const a = await createWorld(db, P, { name: 'twin a', seed: 'same', width: 16, height: 16 }, withOutbox);
  const b = await createWorld(db, P, { name: 'twin b', seed: 'same', width: 16, height: 16 }, withOutbox);
  const terrain = async (id: string): Promise<string[]> => {
    const rows = await sql<{ terrain: string }[]>`
      select terrain from tiles where world_id = ${id} order by y, x`;
    return rows.map((r) => r.terrain);
  };
  assert.deepEqual(await terrain(a.id), await terrain(b.id));
});

test('worlds: an out-of-bounds world is refused before a map is generated', { skip }, async () => {
  const db = asDb(sql);
  await assert.rejects(() => createWorld(db, P, { name: 'x' }, withOutbox), ValidationError);
  await assert.rejects(
    () => createWorld(db, P, { name: 'too big', width: 200 }, withOutbox),
    ValidationError,
  );
  const [n] = await sql<{ n: number }[]>`select count(*)::int as n from worlds`;
  assert.equal(n!.n, 0, 'a rejected world left a row behind');
});

test('worlds: a world can only be started once', { skip }, async () => {
  const db = asDb(sql);
  const world = await createWorld(db, P, { name: 'start once' }, withOutbox);
  await startWorld(db, P, world.id, new Date(), withOutbox);
  await assert.rejects(() => startWorld(db, P, world.id, new Date(), withOutbox), ConflictError);
});

/* ------------------------------------------------------------------ settlement */

test(
  'invariant: one account gets one survivor per world, even when two tabs join at once',
  { skip },
  async () => {
    // The ancestor's own note: two tabs both read nothing and both inserted, giving one account two
    // survivors — two starting bags, two lots of 6 AP, two roster entries, and a lookup that
    // returned whichever row Postgres listed first, so the account flipped between characters from
    // request to request.
    const db = asDb(sql);
    const world = await createWorld(db, P, { name: 'race' }, withOutbox);
    await startWorld(db, P, world.id, new Date(), withOutbox);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        joinWorld(db, P, { worldId: world.id, userId: ALICE, handle: 'alice' }, withOutbox),
      ),
    );
    const ids = new Set(results.map((r) => r.player.id));
    assert.equal(ids.size, 1, 'one account was given more than one survivor');
    assert.equal(results.filter((r) => r.created).length, 1, 'more than one join reported creating');

    const [n] = await sql<{ n: number }[]>`
      select count(*)::int as n from players where world_id = ${world.id}`;
    assert.equal(n!.n, 1);
  },
);

test('invariant: a lost join race leaves no tile owned by a survivor that was never created', { skip }, async () => {
  // The tile claim happens before the insert and in the same transaction. Without that, the loser
  // leaves a tile permanently marked `homestead` owned by nobody, and `releaseHomestead` — which
  // matches on owner_id — never gives it back.
  const db = asDb(sql);
  const world = await createWorld(db, P, { name: 'tiles' }, withOutbox);
  await startWorld(db, P, world.id, new Date(), withOutbox);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      joinWorld(db, P, { worldId: world.id, userId: ALICE, handle: 'alice' }, withOutbox),
    ),
  );
  const orphans = await sql<{ id: string }[]>`
    select t.id from tiles t
     where t.world_id = ${world.id} and t.owner_id is not null
       and not exists (select 1 from players p where p.id = t.owner_id)`;
  assert.equal(orphans.length, 0, `tiles owned by nobody: ${JSON.stringify(orphans)}`);

  const [claimed] = await sql<{ n: number }[]>`
    select count(*)::int as n from tiles where world_id = ${world.id} and terrain = 'homestead'`;
  assert.equal(claimed!.n, 1, 'more than one homestead was claimed for one survivor');
});

test('worlds: two accounts settle on two different tiles', { skip }, async () => {
  const db = asDb(sql);
  const world = await createWorld(db, P, { name: 'neighbours' }, withOutbox);
  await startWorld(db, P, world.id, new Date(), withOutbox);
  const [a, b] = await Promise.all([
    joinWorld(db, P, { worldId: world.id, userId: ALICE, handle: 'alice' }, withOutbox),
    joinWorld(db, P, { worldId: world.id, userId: BOB, handle: 'bob' }, withOutbox),
  ]);
  assert.notEqual(
    `${a.player.homestead_x},${a.player.homestead_y}`,
    `${b.player.homestead_x},${b.player.homestead_y}`,
    'two settlers were handed one homestead',
  );
});

test('worlds: an archived world admits nobody', { skip }, async () => {
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'closed', seasonLength: 5 });
  for (let i = 0; i < 5; i++) await resolveWorldDay(db, P, worldId, new Date(), withOutbox);
  await assert.rejects(
    () => joinWorld(db, P, { worldId, userId: BOB, handle: 'bob' }, withOutbox),
    ConflictError,
  );
});

/* ------------------------------------------------------------------ the action queue */

test('invariant: a trade with an empty offer is refused at the route', { skip }, async () => {
  // The exploit itself. `{"offer":{},"request":{everything they own}}` was a valid,
  // always-succeeding swap of nothing for everything, because an all-zero bag satisfies
  // `hasResources` trivially. Refusing it here is what TELLS the player; the tick refuses it too,
  // which is what protects rows queued before the rule existed.
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, {
    seed: 'trade-guard',
    humans: [
      { userId: ALICE, handle: 'alice' },
      { userId: BOB, handle: 'bob' },
    ],
  });
  const target = playerIds[1]!;
  await assert.rejects(
    () =>
      queueActions(
        db,
        P,
        {
          worldId,
          userId: ALICE,
          actions: [{ type: 'trade', targetPlayerId: target, offer: {}, request: { food: 9 } }],
        },
        withOutbox,
      ),
    /a trade must offer something/,
  );
  await assert.rejects(
    () =>
      queueActions(
        db,
        P,
        {
          worldId,
          userId: ALICE,
          actions: [{ type: 'trade', targetPlayerId: target, offer: { food: 1 }, request: {} }],
        },
        withOutbox,
      ),
    /must ask for something/,
  );
  // Unknown keys are refused rather than silently dropped, which would leave the player convinced
  // they had offered something.
  await assert.rejects(
    () =>
      queueActions(
        db,
        P,
        {
          worldId,
          userId: ALICE,
          actions: [
            { type: 'trade', targetPlayerId: target, offer: { gold: 5 }, request: { food: 1 } },
          ],
        },
        withOutbox,
      ),
    /not a resource/,
  );
  assert.deepEqual(await queuedActionsOf(db, playerIds[0]!), []);
});

test('worlds: a queue is replaced, not appended, and is capped at the day AP', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'queue' });
  await queueActions(db, P, { worldId, userId: ALICE, actions: [{ type: 'work' }] }, withOutbox);
  await queueActions(
    db,
    P,
    { worldId, userId: ALICE, actions: [{ type: 'rest' }, { type: 'rest' }] },
    withOutbox,
  );
  assert.deepEqual(await queuedActionsOf(db, playerIds[0]!), [{ type: 'rest' }, { type: 'rest' }]);

  await assert.rejects(
    () =>
      queueActions(
        db,
        P,
        { worldId, userId: ALICE, actions: Array.from({ length: 7 }, () => ({ type: 'work' as const })) },
        withOutbox,
      ),
    ValidationError,
  );
});

test('worlds: a dead survivor cannot queue anything', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'dead' });
  await sql`update players set alive = false where id = ${playerIds[0]!}`;
  await assert.rejects(
    () => queueActions(db, P, { worldId, userId: ALICE, actions: [{ type: 'work' }] }, withOutbox),
    ConflictError,
  );
});

/* ------------------------------------------------------------------ the stipend */

test('stipend: the pure rule pays once and survives a leave', { skip: false }, () => {
  const fresh = { communeCredit: 0, stipendGranted: false };
  const joined = creditOnJoin(fresh);
  assert.deepEqual(joined, { communeCredit: COMMUNE_JOIN_STIPEND, stipendGranted: true });
  // A second join pays nothing.
  assert.deepEqual(creditOnJoin(joined), joined);
  // Leaving forfeits the balance but NOT the record of the grant. Clearing `stipendGranted` here
  // would restore the per-join credit exactly.
  const left = creditOnLeave(joined);
  assert.deepEqual(left, { communeCredit: 0, stipendGranted: true });
  assert.deepEqual(creditOnJoin(left), { communeCredit: 0, stipendGranted: true });
});

test(
  'invariant: the ninety-day stipend farming loop is closed',
  { skip },
  async () => {
    // The exploit the ancestor filed, replayed end to end. Join a stocked granary, draw the three
    // goods the stipend bought, leave, rejoin — and under the old rule the credit was paid again.
    // `withdrawnToday` belongs to yesterday once the in-game day rolls, so the daily counter was no
    // obstacle either: 270 goods of other people's deposits against a documented ceiling of 3.
    const db = asDb(sql);
    const { worldId, playerIds } = await seedWorld(sql, {
      seed: 'stipend',
      humans: [
        { userId: ALICE, handle: 'alice' },
        { userId: BOB, handle: 'bob' },
      ],
    });
    const [freeloader, patron] = playerIds as [string, string];

    // The patron stocks the granary.
    const commune = await foundCommune(
      db,
      P,
      { worldId, playerId: patron, name: 'the granary' },
      withOutbox,
    );
    await depositToCommune(
      db,
      P,
      { worldId, playerId: patron, communeId: commune.id, resources: { food: 10, water: 10 } },
      withOutbox,
    );

    let drawn = 0;
    for (let day = 0; day < 10; day++) {
      await joinCommune(db, P, { worldId, playerId: freeloader, communeId: commune.id }, withOutbox);
      // Draw everything the allowance permits, whatever it is.
      const detail = await communeDetail(db, worldId, commune.id, freeloader, day);
      const can = detail.allowance?.remaining ?? 0;
      if (can > 0) {
        await withdrawFromCommune(
          db,
          P,
          { worldId, playerId: freeloader, communeId: commune.id, day, resources: { food: can } },
          withOutbox,
        );
        drawn += can;
      }
      await leaveCommune(db, P, { worldId, playerId: freeloader, communeId: commune.id }, withOutbox);
    }

    assert.equal(
      drawn,
      COMMUNE_JOIN_STIPEND,
      `a freeloader drew ${drawn} goods across ten join/leave cycles against a ceiling of ${COMMUNE_JOIN_STIPEND}`,
    );
    const [row] = await sql<{ stipend_granted: boolean; commune_credit: number }[]>`
      select stipend_granted, commune_credit from players where id = ${freeloader}`;
    assert.equal(row!.stipend_granted, true, 'the record of the grant did not survive leaving');
    assert.equal(row!.commune_credit, 0);
  },
);

test('invariant: deposited goods buy allowance by QUANTITY, not by number of deposits', { skip }, async () => {
  // Counting requests would let a member deposit one wood a hundred times to buy allowance.
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'quantity' });
  const me = playerIds[0]!;
  const commune = await foundCommune(db, P, { worldId, playerId: me, name: 'ledger' }, withOutbox);
  for (let i = 0; i < 5; i++) {
    await depositToCommune(
      db,
      P,
      { worldId, playerId: me, communeId: commune.id, resources: { materials: 1 } },
      withOutbox,
    );
  }
  const [row] = await sql<{ commune_credit: number }[]>`
    select commune_credit from players where id = ${me}`;
  // The stipend plus exactly the five units given.
  assert.equal(row!.commune_credit, COMMUNE_JOIN_STIPEND + 5);
});

test('invariant: only a member may deposit into or draw from a commune', { skip }, async () => {
  // Anyone could previously deposit into any commune, including one they had left.
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, {
    seed: 'members',
    humans: [
      { userId: ALICE, handle: 'alice' },
      { userId: BOB, handle: 'bob' },
    ],
  });
  const [insider, outsider] = playerIds as [string, string];
  const commune = await foundCommune(db, P, { worldId, playerId: insider, name: 'closed' }, withOutbox);
  await assert.rejects(
    () =>
      depositToCommune(
        db,
        P,
        { worldId, playerId: outsider, communeId: commune.id, resources: { food: 1 } },
        withOutbox,
      ),
    /not a member/,
  );
  await assert.rejects(
    () =>
      withdrawFromCommune(
        db,
        P,
        { worldId, playerId: outsider, communeId: commune.id, day: 0, resources: { food: 1 } },
        withOutbox,
      ),
    /not a member/,
  );
});

test('invariant: two concurrent withdrawals cannot spend the same goods twice', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, {
    seed: 'withdraw-race',
    humans: [
      { userId: ALICE, handle: 'alice' },
      { userId: BOB, handle: 'bob' },
    ],
  });
  const [a, b] = playerIds as [string, string];
  const commune = await foundCommune(db, P, { worldId, playerId: a, name: 'shared' }, withOutbox);
  await joinCommune(db, P, { worldId, playerId: b, communeId: commune.id }, withOutbox);
  // Exactly three units in the pot, and two members each entitled to three.
  await depositToCommune(
    db,
    P,
    { worldId, playerId: a, communeId: commune.id, resources: { food: 3 } },
    withOutbox,
  );

  const draw = (playerId: string): Promise<unknown> =>
    withdrawFromCommune(
      db,
      P,
      { worldId, playerId, communeId: commune.id, day: 0, resources: { food: 3 } },
      withOutbox,
    );
  const results = await Promise.allSettled([draw(a), draw(b)]);
  assert.equal(
    results.filter((r) => r.status === 'fulfilled').length,
    1,
    'both members drew the same three units',
  );

  const [after] = await sql<{ stockpile: Record<string, number> }[]>`
    select stockpile from communes where id = ${commune.id}`;
  assert.equal(after!.stockpile['food'], 0);
});

test('invariant: a survivor belongs to at most one commune', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'one-commune' });
  const me = playerIds[0]!;
  const first = await foundCommune(db, P, { worldId, playerId: me, name: 'first' }, withOutbox);
  // Founding a second used to silently abandon the first.
  await assert.rejects(
    () => foundCommune(db, P, { worldId, playerId: me, name: 'second' }, withOutbox),
    /leave your current commune/,
  );
  const second = await sql`
    insert into communes (id, world_id, name, founder_handle, stockpile)
    values ('other', ${worldId}, 'other', 'nobody', '{}'::jsonb)`;
  void second;
  await assert.rejects(
    () => joinCommune(db, P, { worldId, playerId: me, communeId: 'other' }, withOutbox),
    /leave your current commune/,
  );
  assert.equal((await listCommunes(db, worldId)).find((c) => c.id === first.id)?.memberCount, 1);
});

test('communes: the last member out disbands it; a founder leaving hands it on', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, {
    seed: 'succession',
    humans: [
      { userId: ALICE, handle: 'alice' },
      { userId: BOB, handle: 'bob' },
    ],
  });
  const [founder, heir] = playerIds as [string, string];
  const commune = await foundCommune(db, P, { worldId, playerId: founder, name: 'legacy' }, withOutbox);
  await joinCommune(db, P, { worldId, playerId: heir, communeId: commune.id }, withOutbox);

  const handover = await leaveCommune(
    db,
    P,
    { worldId, playerId: founder, communeId: commune.id },
    withOutbox,
  );
  assert.equal(handover.disbanded, false);
  assert.equal(handover.newFounderHandle, 'bob');

  const closed = await leaveCommune(
    db,
    P,
    { worldId, playerId: heir, communeId: commune.id },
    withOutbox,
  );
  assert.equal(closed.disbanded, true);
  assert.deepEqual(await listCommunes(db, worldId), []);
});

test('invariant: leaving forfeits the stockpile, so a founder cannot launder goods', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'launder' });
  const me = playerIds[0]!;
  const commune = await foundCommune(db, P, { worldId, playerId: me, name: 'vanishing' }, withOutbox);
  await depositToCommune(
    db,
    P,
    { worldId, playerId: me, communeId: commune.id, resources: { food: 8 } },
    withOutbox,
  );
  const before = (await playerOf(db, worldId, ALICE))!.resources.food;
  await leaveCommune(db, P, { worldId, playerId: me, communeId: commune.id }, withOutbox);
  const after = (await playerOf(db, worldId, ALICE))!.resources.food;
  assert.equal(after, before, 'the stockpile came back with the founder');
  assert.deepEqual(await listCommunes(db, worldId), []);
});

/* ------------------------------------------------------------------ progression */

test('invariant: a skill point cannot be spent twice by two concurrent requests', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'skills' });
  const me = playerIds[0]!;
  await sql`update player_progress set skill_points = 1 where player_id = ${me}`;

  const results = await Promise.allSettled([
    unlockPerk(db, P, { worldId, playerId: me, perkId: 'farmer_1' }, withOutbox),
    unlockPerk(db, P, { worldId, playerId: me, perkId: 'warden_1' }, withOutbox),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);

  const [row] = await sql<{ skill_points: number; perks: string[] }[]>`
    select skill_points, perks from player_progress where player_id = ${me}`;
  assert.equal(row!.skill_points, 0);
  assert.equal(row!.perks.length, 1, 'one skill point bought two perks');
});

test('progression: a perk needs its prerequisite and cannot be bought twice', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'perks' });
  const me = playerIds[0]!;
  await sql`update player_progress set skill_points = 3 where player_id = ${me}`;
  await assert.rejects(
    () => unlockPerk(db, P, { worldId, playerId: me, perkId: 'farmer_2' }, withOutbox),
    /prerequisite/,
  );
  await unlockPerk(db, P, { worldId, playerId: me, perkId: 'farmer_1' }, withOutbox);
  await assert.rejects(
    () => unlockPerk(db, P, { worldId, playerId: me, perkId: 'farmer_1' }, withOutbox),
    /already unlocked/,
  );
  await assert.rejects(
    () => unlockPerk(db, P, { worldId, playerId: me, perkId: 'not_a_perk' }, withOutbox),
    /unknown perk/,
  );
});

test('invariant: two tabs racing one objective claim pay exactly once', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'claim' });
  const me = playerIds[0]!;
  await sql`
    insert into objectives (id, world_id, player_id, bucket, kind, description, target, progress,
                            period, reward_xp, reward_tokens)
    values ('o1', ${worldId}, ${me}, 1, 'work', 'Tend', 3, 3, 'daily', 15, 3)`;

  const results = await Promise.allSettled([
    claimObjective(db, P, { worldId, playerId: me, objectiveId: 'o1' }, withOutbox),
    claimObjective(db, P, { worldId, playerId: me, objectiveId: 'o1' }, withOutbox),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);

  const [row] = await sql<{ tokens: number; xp: number }[]>`
    select tokens, xp from player_progress where player_id = ${me}`;
  assert.equal(row!.tokens, 3, 'the objective paid its tokens twice');
  assert.equal(row!.xp, 15, 'the objective paid its XP twice');
});

test('progression: an incomplete objective cannot be claimed', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'incomplete' });
  const me = playerIds[0]!;
  await sql`
    insert into objectives (id, world_id, player_id, bucket, kind, description, target, progress,
                            period, reward_xp, reward_tokens)
    values ('o1', ${worldId}, ${me}, 1, 'work', 'Tend', 3, 1, 'daily', 15, 3)`;
  await assert.rejects(
    () => claimObjective(db, P, { worldId, playerId: me, objectiveId: 'o1' }, withOutbox),
    /not complete/,
  );
});

test(
  'invariant: a claim made while a day is resolving is not reverted by the tick',
  { skip },
  async () => {
    // The ancestor's ProgressDelta design, tested for the thing it exists for. The day is simulated
    // from a snapshot; writing that snapshot back reverted anything the player did in between. So
    // the tick advances by DELTA against a row re-read under FOR UPDATE, and never writes `tokens`
    // at all — which is the one column an objective claim exists to move.
    const db = asDb(sql);
    const { worldId, playerIds } = await seedWorld(sql, { seed: 'delta' });
    const me = playerIds[0]!;
    await queueActions(db, P, { worldId, userId: ALICE, actions: [{ type: 'work' }] }, withOutbox);
    await sql`
      insert into objectives (id, world_id, player_id, bucket, kind, description, target, progress,
                              period, reward_xp, reward_tokens)
      values ('o1', ${worldId}, ${me}, 1, 'work', 'Tend', 1, 1, 'daily', 40, 7)`;

    // Both at once: the claim adds 40 xp and 7 tokens, the tick adds 1 action (2) + survived (5).
    const [claimed] = await Promise.all([
      claimObjective(db, P, { worldId, playerId: me, objectiveId: 'o1' }, withOutbox),
      resolveWorldDay(db, P, worldId, new Date(), withOutbox),
    ]);
    assert.ok(claimed);

    const [row] = await sql<{ xp: number; level: number; tokens: number; days_survived: number }[]>`
      select xp, level, tokens, days_survived from player_progress where player_id = ${me}`;
    assert.equal(row!.tokens, 7, 'the tick reverted the claimed tokens');
    // 40 + 7 = 47 XP, below the 50 needed for level 2, so it is all still on the level-1 bar.
    assert.equal(row!.xp, 47, 'XP from the claim and the tick did not both land');
    assert.equal(row!.level, 1);
    assert.equal(row!.days_survived, 1);
  },
);

/* ------------------------------------------------------------------ bots and the roster */

test('bots: a roster syncs up and back down, returning tiles to the map', { skip }, async () => {
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, { seed: 'roster', width: 20, height: 20 });
  await syncBots(db, P, worldId, true, 5, withOutbox);
  const [up] = await sql<{ n: number }[]>`
    select count(*)::int as n from players where world_id = ${worldId} and is_bot = true`;
  assert.equal(up!.n, 5);

  await syncBots(db, P, worldId, true, 2, withOutbox);
  const [down] = await sql<{ n: number }[]>`
    select count(*)::int as n from players where world_id = ${worldId} and is_bot = true`;
  assert.equal(down!.n, 2);

  const orphans = await sql<{ id: string }[]>`
    select t.id from tiles t
     where t.world_id = ${worldId} and t.owner_id is not null
       and not exists (select 1 from players p where p.id = t.owner_id)`;
  assert.equal(orphans.length, 0, 'a removed bot kept its homestead');

  await syncBots(db, P, worldId, false, 5, withOutbox);
  const [off] = await sql<{ n: number }[]>`
    select count(*)::int as n from players where world_id = ${worldId} and is_bot = true`;
  assert.equal(off!.n, 0, 'disabling bots left some behind');
});

test('roster: spawn protection is judged against the day a raid would resolve on', { skip }, async () => {
  // Raids queued today resolve tomorrow, so protection is judged against `day + 1` — otherwise a
  // settler on their last protected day queues a raid that lands after protection ends and is told
  // they are safe.
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, {
    seed: 'protection',
    humans: [{ userId: ALICE, handle: 'alice' }],
  });
  const day0 = await roster(db, worldId, 0);
  assert.equal(day0[0]?.spawnProtected, true);
  const day2 = await roster(db, worldId, 2);
  assert.equal(day2[0]?.spawnProtected, false, 'protection outlived its window by a day');
});

test('roster: a survivor score reflects days, level, defence and achievements', { skip }, async () => {
  const db = asDb(sql);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'score' });
  const before = (await roster(db, worldId, 0))[0]!.score;
  await sql`update player_progress set days_survived = 10, level = 3 where player_id = ${playerIds[0]!}`;
  await sql`update players set defense = 6 where id = ${playerIds[0]!}`;
  const after = (await roster(db, worldId, 0))[0]!.score;
  assert.ok(after > before, 'a survivor who endured and fortified did not score higher');
});

test('worlds: a third account settles without disturbing the first two', { skip }, async () => {
  const db = asDb(sql);
  const { worldId } = await seedWorld(sql, {
    seed: 'three',
    humans: [
      { userId: ALICE, handle: 'alice' },
      { userId: BOB, handle: 'bob' },
    ],
  });
  await joinWorld(db, P, { worldId, userId: CAROL, handle: 'carol' }, withOutbox);
  const entries = await roster(db, worldId, 0);
  assert.equal(entries.length, 3);
  assert.equal(new Set(entries.map((e) => `${e.homesteadX},${e.homesteadY}`)).size, 3);
});
