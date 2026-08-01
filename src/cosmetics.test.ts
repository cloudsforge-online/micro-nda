// The entitlement bridge, and the line it must never cross.
//
// The behavioural half — owned, not owned, billing unreachable, clearing a slot — is exercised over
// HTTP in `server.test.ts`. This file adds the part that behaviour cannot demonstrate: that there
// is NO PATH from a cosmetic to a stat. That is an absence, and an absence is proved by looking, so
// this walks the source and the schema for one.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type postgres from 'postgres';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetNda,
  asDb,
  fakeBilling,
  seedWorld,
  ALICE,
} from './testsupport.ts';
import { withOutbox } from './outbox.ts';
import {
  CosmeticNotOwnedError,
  EQUIPPABLE_SLOTS,
  TITLE_SCOPE,
  equipCosmetic,
  parseEquipped,
  serialiseEquipped,
} from './cosmetics.ts';
import { resolveWorldDay, playerOf } from './worlds.ts';
import { ValidationError } from './worlds.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A source file with its comments removed.
 *
 * Stripping first is not fussiness. A grep over raw source fires on the very comment that EXPLAINS
 * the boundary — this file's own "no path from here to any column of player_progress" tripped the
 * check that asserts it. The estate's CI hit the same thing in `service-ci.yml` rule 1 and records
 * why it matters: a rule that punishes documenting the rule teaches people to delete the
 * explanation, and the codebase loses precisely the comments that make a boundary survive a
 * reviewer who was not there when it was drawn.
 */
const source = (name: string): string =>
  readFileSync(join(here, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

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

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * A COSMETIC IS NEVER A STAT
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

test('cosmetics: the module writes exactly one column, and it is not a stat', () => {
  // Every `update <table> set <column>` in cosmetics.ts, extracted. Behaviour cannot prove this —
  // a test can only show that the paths it thought to try do not move a stat. Reading the source
  // shows that no path does.
  const text = source('cosmetics.ts');
  const writes = [...text.matchAll(/update\s+(\w+)\s+set\s+([a-z_]+)/gi)].map(
    (m) => `${m[1]}.${m[2]}`,
  );
  assert.deepEqual(
    [...new Set(writes)],
    ['players.cosmetic_style'],
    'the cosmetic path writes something other than which slot a survivor is wearing',
  );

  for (const stat of [
    'hp',
    'morale',
    'defense',
    'reputation',
    'resources',
    'ap_per_day',
    'alive',
    'level',
    'xp',
    'skill_points',
    'perks',
    'tokens',
    'days_survived',
    'contribution',
  ]) {
    assert.ok(
      !new RegExp(`set\\s+${stat}\\b`, 'i').test(text),
      `cosmetics.ts writes ${stat} — a cosmetic has become a stat`,
    );
  }
  assert.ok(
    !/player_progress/.test(text),
    'cosmetics.ts touches player_progress; nothing about a purchase may reach progression',
  );
});

test('cosmetics: the engine cannot see what a survivor is wearing', () => {
  // The other end of the same argument. `engine/state.ts` is the complete list of what a day of
  // simulation reads out of a player; if `cosmetic_style` is not in it, no cosmetic can change an
  // outcome even if something did write one into a stat by accident.
  const state = source('engine/state.ts');
  assert.ok(!/cosmetic/i.test(state), 'the engine snapshot now carries cosmetics');
  const resolve = source('engine/resolve.ts');
  assert.ok(!/cosmetic/i.test(resolve), 'the resolution engine now reads a cosmetic');
});

test('cosmetics: no ledger client exists for a purchase to post to', () => {
  // 03/19 §1.2 sells cosmetics as billing entitlements. Billing owns the money; this service
  // records the equip. A ledger client here would be a second place value moved.
  for (const file of ['cosmetics.ts', 'worlds.ts', 'communes.ts', 'jobs.ts', 'index.ts']) {
    assert.ok(
      !/ledgerclient|LedgerClient|postEntry/.test(source(file)),
      `${file} reaches a ledger; this service moves no value`,
    );
  }
});

test('cosmetics: the equippable slots are all things a client can actually draw', () => {
  // The ancestor's catalogue had six kinds and three of them resolved to nothing anyone could see;
  // equipping what cannot be rendered was the bug that list replaced.
  assert.deepEqual(
    [...EQUIPPABLE_SLOTS],
    ['homestead_skin', 'avatar_frame', 'name_color', 'commune_crest'],
  );
  assert.equal(TITLE_SCOPE, 'nda');
});

/* ------------------------------------------------------------------ parsing */

test('cosmetics: a hand-edited or retired slot never reaches a renderer', () => {
  assert.deepEqual(parseEquipped(null), {});
  assert.deepEqual(parseEquipped('not json'), {});
  assert.deepEqual(parseEquipped('[]'), {});
  assert.deepEqual(parseEquipped('"a string"'), {});
  // An unknown slot is dropped on the way out, not just on the way in.
  assert.deepEqual(parseEquipped('{"weapon":"sword","avatar_frame":"frame_iron"}'), {
    avatar_frame: 'frame_iron',
  });
  // A non-string value is dropped rather than coerced.
  assert.deepEqual(parseEquipped('{"avatar_frame":42}'), {});
});

test('cosmetics: wearing nothing round-trips to null, not to an empty object', () => {
  assert.equal(serialiseEquipped({}), null);
  assert.deepEqual(parseEquipped(serialiseEquipped({ name_color: 'gold' })), { name_color: 'gold' });
});

/* ------------------------------------------------------------------ against the database */

test('cosmetics: equipping does not move a single stat', { skip }, async () => {
  const db = asDb(sql);
  const billing = fakeBilling();
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'no-stat' });
  const me = playerIds[0]!;
  billing.grant(me, { id: 'e1', sku: 'skin_bunker', scope: 'title:nda', active: true });

  const before = await sql<Record<string, unknown>[]>`
    select hp, morale, defense, reputation, resources, ap_per_day, alive from players where id = ${me}`;
  const progressBefore = await sql<Record<string, unknown>[]>`
    select * from player_progress where player_id = ${me}`;

  await equipCosmetic(
    db,
    'nda',
    billing,
    { worldId, playerId: me, slot: 'homestead_skin', itemUrn: 'skin_bunker' },
    withOutbox,
  );

  const after = await sql<Record<string, unknown>[]>`
    select hp, morale, defense, reputation, resources, ap_per_day, alive from players where id = ${me}`;
  assert.deepEqual(after[0], before[0], 'equipping a cosmetic changed a survivor stat');
  const progressAfter = await sql<Record<string, unknown>[]>`
    select * from player_progress where player_id = ${me}`;
  assert.deepEqual(progressAfter[0], progressBefore[0], 'equipping a cosmetic changed progression');
});

test(
  'cosmetics: two survivors resolve a day identically whether or not one is wearing anything',
  { skip },
  async () => {
    // The strongest form of the claim available: run the same seeded day twice, once with a
    // cosmetic equipped and once without, and compare the whole outcome.
    const db = asDb(sql);
    const billing = fakeBilling();

    const run = async (equip: boolean): Promise<Record<string, unknown>[]> => {
      await resetNda(sql);
      const { worldId, playerIds } = await seedWorld(sql, { seed: 'cosmetic-parity' });
      const me = playerIds[0]!;
      if (equip) {
        billing.grant(me, { id: 'e1', sku: 'skin_bunker', scope: 'title:nda', active: true });
        await equipCosmetic(
          db,
          'nda',
          billing,
          { worldId, playerId: me, slot: 'homestead_skin', itemUrn: 'skin_bunker' },
          withOutbox,
        );
      }
      await resolveWorldDay(db, 'nda', worldId, new Date(0), withOutbox);
      return sql<Record<string, unknown>[]>`
        select p.hp, p.morale, p.defense, p.reputation, p.resources, p.alive,
               g.level, g.xp, g.days_survived
          from players p join player_progress g on g.player_id = p.id
         where p.world_id = ${worldId} order by p.id`;
    };

    const bare = await run(false);
    const dressed = await run(true);
    assert.deepEqual(dressed, bare, 'a cosmetic changed how the day resolved');
  },
);

test('cosmetics: an unowned item is refused and nothing is written', { skip }, async () => {
  const db = asDb(sql);
  const billing = fakeBilling();
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'deny' });
  await assert.rejects(
    () =>
      equipCosmetic(
        db,
        'nda',
        billing,
        { worldId, playerId: playerIds[0]!, slot: 'avatar_frame', itemUrn: 'frame_iron' },
        withOutbox,
      ),
    CosmeticNotOwnedError,
  );
  const me = await playerOf(db, worldId, ALICE);
  assert.equal(me?.cosmetic_style, null);
});

test('cosmetics: an entitlement for a DIFFERENT title does not unlock this one', { skip }, async () => {
  const db = asDb(sql);
  const billing = fakeBilling();
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'scope' });
  const me = playerIds[0]!;
  billing.grant(me, { id: 'e1', sku: 'skin_bunker', scope: 'title:emberkin', active: true });
  await assert.rejects(
    () =>
      equipCosmetic(
        db,
        'nda',
        billing,
        { worldId, playerId: me, slot: 'homestead_skin', itemUrn: 'skin_bunker' },
        withOutbox,
      ),
    CosmeticNotOwnedError,
  );
  // A platform-scoped entitlement crosses titles and DOES unlock it.
  billing.grant(me, { id: 'e2', sku: 'skin_bunker', scope: 'platform', active: true });
  const equipped = await equipCosmetic(
    db,
    'nda',
    billing,
    { worldId, playerId: me, slot: 'homestead_skin', itemUrn: 'skin_bunker' },
    withOutbox,
  );
  assert.deepEqual(equipped, { homestead_skin: 'skin_bunker' });
});

test('cosmetics: a revoked entitlement can no longer be equipped', { skip }, async () => {
  const db = asDb(sql);
  const billing = fakeBilling();
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'revoked' });
  const me = playerIds[0]!;
  billing.grant(me, { id: 'e1', sku: 'frame_iron', scope: 'platform', active: false });
  await assert.rejects(
    () =>
      equipCosmetic(
        db,
        'nda',
        billing,
        { worldId, playerId: me, slot: 'avatar_frame', itemUrn: 'frame_iron' },
        withOutbox,
      ),
    CosmeticNotOwnedError,
  );
});

test('cosmetics: two slots equipped concurrently do not drop one another', { skip }, async () => {
  // Each request names only the slot it is changing, so without the row lock both would read the
  // old map and the later write would drop the earlier slot.
  const db = asDb(sql);
  const billing = fakeBilling();
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'two-slots' });
  const me = playerIds[0]!;
  billing.grant(me, { id: 'e1', sku: 'frame_iron', scope: 'platform', active: true });
  billing.grant(me, { id: 'e2', sku: 'name_gold', scope: 'platform', active: true });

  await Promise.all([
    equipCosmetic(
      db,
      'nda',
      billing,
      { worldId, playerId: me, slot: 'avatar_frame', itemUrn: 'frame_iron' },
      withOutbox,
    ),
    equipCosmetic(
      db,
      'nda',
      billing,
      { worldId, playerId: me, slot: 'name_color', itemUrn: 'name_gold' },
      withOutbox,
    ),
  ]);

  const me2 = await playerOf(db, worldId, ALICE);
  assert.deepEqual(parseEquipped(me2?.cosmetic_style ?? null), {
    avatar_frame: 'frame_iron',
    name_color: 'name_gold',
  });
});

test('cosmetics: an unknown slot is refused before billing is consulted', { skip }, async () => {
  const db = asDb(sql);
  const billing = fakeBilling();
  billing.setUnavailable(true);
  const { worldId, playerIds } = await seedWorld(sql, { seed: 'slot-first' });
  try {
    await assert.rejects(
      () =>
        equipCosmetic(
          db,
          'nda',
          billing,
          { worldId, playerId: playerIds[0]!, slot: 'sword', itemUrn: 'excalibur' },
          withOutbox,
        ),
      ValidationError,
      'an unknown slot produced a billing error instead of a validation one',
    );
  } finally {
    billing.setUnavailable(false);
  }
});
