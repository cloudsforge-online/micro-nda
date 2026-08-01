// Schema tests. Prove the migrations apply to SCHEMA_VERSION, every owned table exists, and the
// constraints actually FIRE — by inserting the illegal row and matching the constraint name in the
// error. A CHECK nobody has seen reject anything is a comment.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts';
import { enabled, skip, openDb, migrateTestDb, resetNda } from './testsupport.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb();
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetNda(sql);
});
after(async () => {
  if (sql) await sql.end();
});

/** A world row the constraint tests can hang children off. */
async function aWorld(id = 'w1'): Promise<string> {
  await sql`
    insert into worlds (id, name, season_length, width, height, tick_interval_minutes, seed)
    values (${id}, 'w', 90, 16, 16, 1440, ${id})`;
  return id;
}

async function aPlayer(worldId: string, id = 'p1', userId: string | null = 'u1'): Promise<string> {
  await sql`
    insert into players (id, world_id, user_id, handle, is_bot, homestead_x, homestead_y, resources)
    values (${id}, ${worldId}, ${userId}, 'h', ${userId === null}, 0, 0, '{}'::jsonb)`;
  return id;
}

test('migrations: applied up to SCHEMA_VERSION', { skip }, async () => {
  const rows = await sql<{ v: number }[]>`select max(version)::int as v from schema_migrations`;
  assert.equal(rows[0]!.v, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
});

test('migrations: every owned table exists', { skip }, async () => {
  for (const table of TABLES) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables where table_name = ${table}`;
    assert.equal(rows[0]!.n, 1, `table ${table} is missing`);
  }
});

test('migrations: migrating twice is a no-op', { skip }, async () => {
  await migrateTestDb(sql);
  const rows = await sql<{ v: number }[]>`select max(version)::int as v from schema_migrations`;
  assert.equal(rows[0]!.v, SCHEMA_VERSION);
});

/* ------------------------------------------------------------------ the load-bearing indexes */

test('migrations: one account gets one survivor per world', { skip }, async () => {
  const w = await aWorld();
  await aPlayer(w, 'p1', 'user-a');
  await assert.rejects(
    () => aPlayer(w, 'p2', 'user-a'),
    /players_world_user_uniq/,
    'a second survivor for one account was accepted — two starting bags, two lots of AP',
  );
  // Bots are players rows with a null user_id and a world holds many; the index must be partial.
  await aPlayer(w, 'b1', null);
  await aPlayer(w, 'b2', null);
});

test('migrations: the same account may settle in two different worlds', { skip }, async () => {
  const a = await aWorld('wa');
  const b = await aWorld('wb');
  await aPlayer(a, 'pa', 'user-a');
  await aPlayer(b, 'pb', 'user-a');
});

test('migrations: an achievement unlocks once per survivor', { skip }, async () => {
  const w = await aWorld();
  const p = await aPlayer(w);
  const insert = (): Promise<unknown> => sql`
    insert into achievements (id, world_id, player_id, ach_id, name, description, unlocked_at)
    values (${`${p}:days_30`}, ${w}, ${p}, 'days_30', 'n', 'd', 30)`;
  await insert();
  await assert.rejects(
    insert,
    /achievements_player_ach_uniq|achievements_pkey/,
    'a re-evaluating tick could unlock the same badge twice',
  );
});

test('migrations: a tile coordinate is unique within a world', { skip }, async () => {
  const w = await aWorld();
  const insert = (id: string): Promise<unknown> => sql`
    insert into tiles (id, world_id, x, y, terrain) values (${id}, ${w}, 3, 4, 'wilderness')`;
  await insert('t1');
  await assert.rejects(() => insert('t2'), /tiles_world_xy_uniq/);
});

/* ------------------------------------------------------------------ the CHECK constraints */

test('migrations: a world cannot resolve past the end of its season', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into worlds (id, name, season_length, width, height, tick_interval_minutes, seed, day)
      values ('over', 'w', 90, 16, 16, 1440, 'over', 91)`,
    /worlds_day_within_season/,
  );
});

test('migrations: an unknown world status is refused', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into worlds (id, name, season_length, width, height, tick_interval_minutes, seed, status)
      values ('bad', 'w', 90, 16, 16, 1440, 'bad', 'paused')`,
    /worlds_status_known/,
  );
});

test('migrations: hp and morale are bounded to the range the engine clamps to', { skip }, async () => {
  const w = await aWorld();
  await assert.rejects(
    () => sql`
      insert into players (id, world_id, user_id, handle, homestead_x, homestead_y, resources, hp)
      values ('px', ${w}, 'ux', 'h', 0, 0, '{}'::jsonb, 101)`,
    /players_vitals_bounded/,
  );
});

test('migrations: a bot has no account and a human always has one', { skip }, async () => {
  const w = await aWorld();
  await assert.rejects(
    () => sql`
      insert into players (id, world_id, user_id, handle, is_bot, personality, homestead_x, homestead_y, resources)
      values ('pb', ${w}, 'someone', 'h', true, 'farmer', 0, 0, '{}'::jsonb)`,
    /players_bot_has_no_user/,
    'a bot carrying a user id would post achievements to a real account',
  );
  await assert.rejects(
    () => sql`
      insert into players (id, world_id, user_id, handle, is_bot, homestead_x, homestead_y, resources)
      values ('ph', ${w}, null, 'h', false, 0, 0, '{}'::jsonb)`,
    /players_bot_has_no_user/,
  );
});

test('migrations: a non-bot cannot carry a bot personality', { skip }, async () => {
  const w = await aWorld();
  await assert.rejects(
    () => sql`
      insert into players (id, world_id, user_id, handle, is_bot, personality, homestead_x, homestead_y, resources)
      values ('pp', ${w}, 'up', 'h', false, 'raider', 0, 0, '{}'::jsonb)`,
    /players_bot_has_personality/,
  );
});

test('migrations: an objective cannot exceed its own target', { skip }, async () => {
  const w = await aWorld();
  const p = await aPlayer(w);
  await assert.rejects(
    () => sql`
      insert into objectives (id, world_id, player_id, bucket, kind, description, target, progress,
                              period, reward_xp, reward_tokens)
      values ('o1', ${w}, ${p}, 1, 'work', 'd', 3, 4, 'daily', 1, 1)`,
    /objectives_progress_bounded/,
  );
});

test('migrations: commune credit cannot go negative', { skip }, async () => {
  const w = await aWorld();
  const p = await aPlayer(w);
  await assert.rejects(
    () => sql`update players set commune_credit = -1 where id = ${p}`,
    /players_commune_credit_non_negative/,
    'a withdrawal that overdrew the allowance would be silently possible',
  );
});

test('migrations: progression counters cannot go negative', { skip }, async () => {
  const w = await aWorld();
  const p = await aPlayer(w);
  await sql`insert into player_progress (player_id, world_id) values (${p}, ${w})`;
  await assert.rejects(
    () => sql`update player_progress set tokens = -1 where player_id = ${p}`,
    /player_progress_counters_non_negative/,
  );
  await assert.rejects(
    () => sql`update player_progress set level = 0 where player_id = ${p}`,
    /player_progress_level_positive/,
  );
});

test('migrations: an unknown report kind or event type is refused', { skip }, async () => {
  const w = await aWorld();
  await assert.rejects(
    () => sql`
      insert into reports (id, world_id, day, kind, is_public, message)
      values ('r1', ${w}, 1, 'gossip', true, 'm')`,
    /reports_kind_known/,
  );
  await assert.rejects(
    () => sql`
      insert into world_events (id, world_id, day, type, title, description, severity)
      values ('e1', ${w}, 1, 'meteor', 't', 'd', 1)`,
    /world_events_type_known/,
  );
});

/* ------------------------------------------------------------------ the money rule */

test('migrations: there is no balance column anywhere — this service holds no money', { skip }, async () => {
  // The same assertion micro-emberkin makes, for the same reason: a balance column is the first
  // step of a second ledger. `player_progress.tokens` is a gameplay counter (see rules.ts) and is
  // deliberately not matched by these patterns — it is asserted separately, in cosmetics.test.ts,
  // that nothing converts it to anything.
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public'
       and (column_name like '%balance%' or column_name = 'shards'
            or column_name like '%_amount%' or column_name like '%price%')`;
  assert.equal(rows.length, 0, `unexpected money column: ${JSON.stringify(rows)}`);
});

test('migrations: the account-level cosmetics table is deliberately absent', { skip }, async () => {
  // The ancestor kept `player_cosmetics` keyed on user_id (db/schema.ts:158), making a per-title
  // game service the second registry of what an account owns. 03 line 168 assigns that to worlds.
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.tables where table_name = 'player_cosmetics'`;
  assert.equal(rows[0]!.n, 0, 'the account wardrobe has come back; it belongs to worlds');
});

test('migrations: deleting a world takes its whole simulation with it', { skip }, async () => {
  const w = await aWorld();
  const p = await aPlayer(w);
  await sql`insert into player_progress (player_id, world_id) values (${p}, ${w})`;
  await sql`
    insert into reports (id, world_id, day, kind, is_public, message)
    values ('r1', ${w}, 1, 'world', true, 'm')`;
  await sql`delete from worlds where id = ${w}`;
  for (const table of ['players', 'player_progress', 'reports'] as const) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from ${sql(table)}`;
    assert.equal(rows[0]!.n, 0, `${table} outlived its world`);
  }
});
