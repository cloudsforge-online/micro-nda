// The conformance corpus — the load-bearing proof that this port resolves a day the way the
// frozen ancestor did.
//
// `src/fixtures/ancestor-corpus.json` was RECORDED by executing
// `stack/repos/ninety-days-after/services/game/src/engine/resolve.ts` — that file, unmodified,
// imported directly — against a real Postgres seeded with twelve hand-built worlds, and reading
// back every row it wrote. `scripts/record-ancestor-corpus.ts` is the recorder; it is a one-shot
// that reads a frozen repository which does not exist on a CI runner, which is exactly why its
// output is committed rather than regenerated.
//
// The twelve worlds between them drive every branch of the engine: work, rest, fortify, contested
// and unclaimed scavenging, a raid repelled by fortifications, a raid that kills, a raid refused
// by spawn protection, a consented trade and one that merely stands as an offer, starvation and
// thirst, all six ambient event types plus a season milestone, a bot roster planning and trading,
// a disease outbreak with and without medicine, a resource bust that floors the region's pool at
// zero, and the last day of a season (archival).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// WHAT "BYTE-IDENTICAL" MEANS HERE, EXACTLY.
//
// Every field the ancestor made deterministic is compared exactly: resources, hp, morale, defense,
// reputation, alive, the ruin stocks, the world pool, the persisted progress rows after the delta
// write, every objective row, every achievement row, every event's type/title/description/severity
// and every report's kind/visibility/message/actor/target/viewer.
//
// TWO COLUMNS ARE NOT COMPARED, and cannot be: `reports.id` and `world_events.id` were
// `randomUUID()` in the ancestor (`resolve.ts:827`, `events.ts:112`). They do not match a second
// run of the ANCESTOR either. This port derives both instead — see `resolve.ts` — and
// `engine.test.ts` asserts that derivation is stable and collision-free. Saying so here rather
// than quietly dropping them is the difference between a proof and a claim.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveDay, type DayInput } from './engine/resolve.ts';
import {
  applyProgressDelta,
  defaultProgressWork,
  refreshXpToNext,
  type ProgressWork,
} from './engine/progression.ts';
import type { ResourceBag } from './rules.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface RecordedProgress {
  playerId: string;
  level: number;
  xp: number;
  skillPoints: number;
  perks: string[];
  tokens: number;
  streak: number;
  lastSeenDay: number;
  daysSurvived: number;
  contribution: number;
}

interface RecordedCase {
  name: string;
  input: DayInput & { progress: RecordedProgress[] };
  expected: {
    day: number;
    status: string;
    players: { id: string; resources: ResourceBag; hp: number; morale: number; defense: number; reputation: number; alive: boolean }[];
    ruins: { x: number; y: number; stock: ResourceBag }[];
    stock: ResourceBag;
    progress: RecordedProgress[];
    objectives: Record<string, unknown>[];
    achievements: Record<string, unknown>[];
    events: { day: number; type: string; title: string; description: string; severity: number }[];
    reports: Record<string, unknown>[];
  };
}

const corpus = JSON.parse(
  readFileSync(join(here, 'fixtures', 'ancestor-corpus.json'), 'utf8'),
) as RecordedCase[];

/** The total order the recorder wrote the fixture in. Applied to this port's output to match. */
const byKeys =
  <T>(...keys: ((r: T) => string | number | boolean | null)[]) =>
  (a: T, b: T): number => {
    for (const k of keys) {
      const x = k(a);
      const y = k(b);
      if (x === y) continue;
      if (x === null) return -1;
      if (y === null) return 1;
      return x < y ? -1 : 1;
    }
    return 0;
  };

test('conformance: the corpus is non-trivial and covers the whole engine', () => {
  assert.ok(corpus.length >= 18, `expected >= 18 recorded worlds, got ${corpus.length}`);

  const eventTypes = new Set(corpus.flatMap((c) => c.expected.events.map((e) => e.type)));
  for (const type of [
    'storm',
    'disease_outbreak',
    'raider_warband',
    'caravan',
    'resource_boom',
    'resource_bust',
    'season_milestone',
  ]) {
    assert.ok(eventTypes.has(type), `the corpus never fires a '${type}' event`);
  }

  const reportKinds = new Set(
    corpus.flatMap((c) => c.expected.reports.map((r) => String(r['kind']))),
  );
  for (const kind of ['work', 'rest', 'fortify', 'scavenge', 'raid', 'trade', 'death', 'event', 'world']) {
    assert.ok(reportKinds.has(kind), `the corpus never produces a '${kind}' report`);
  }

  assert.ok(
    corpus.some((c) => c.expected.status === 'archived'),
    'no recorded world reaches the end of its season',
  );
  assert.ok(
    corpus.some((c) => c.expected.players.some((p) => !p.alive)),
    'nobody dies anywhere in the corpus',
  );
  assert.ok(
    corpus.some((c) => c.expected.achievements.length > 0),
    'no achievement is ever unlocked in the corpus',
  );
});

for (const recorded of corpus) {
  test(`conformance: '${recorded.name}' resolves exactly as the ancestor did`, () => {
    const result = resolveDay(recorded.input);
    const { expected } = recorded;

    assert.equal(result.day, expected.day, 'the calendar advanced differently');
    assert.equal(
      result.archived ? 'archived' : 'active',
      expected.status,
      'the world archived at a different moment',
    );

    assert.deepEqual(
      [...result.players].sort(byKeys((p) => p.id)),
      expected.players,
      'a survivor came out of the day in a different state',
    );

    assert.deepEqual(
      [...result.ruins].sort(byKeys((r) => r.y, (r) => r.x)),
      expected.ruins,
      'a ruin was picked over differently',
    );

    assert.deepEqual(result.stock, expected.stock, "the region's finite pool moved differently");

    // The delta write, replayed through the SAME helper the persistence layer uses. Starting rows
    // are the recorded inputs; a player with no row starts from the documented default, exactly as
    // `resolve.ts` did.
    const before = new Map<string, ProgressWork>(
      recorded.input.progress.map((g) => [
        g.playerId,
        refreshXpToNext({ ...g, worldId: recorded.input.world.id, perks: [...g.perks], xpToNext: 0 }),
      ]),
    );
    const after = result.progressDeltas
      .map((d) => {
        const fresh =
          before.get(d.playerId) ?? defaultProgressWork(recorded.input.world.id, d.playerId);
        applyProgressDelta(fresh, d, result.day);
        return {
          playerId: fresh.playerId,
          level: fresh.level,
          xp: fresh.xp,
          skillPoints: fresh.skillPoints,
          perks: fresh.perks,
          tokens: fresh.tokens,
          streak: fresh.streak,
          lastSeenDay: fresh.lastSeenDay,
          daysSurvived: fresh.daysSurvived,
          contribution: fresh.contribution,
        };
      })
      .sort(byKeys((g) => g.playerId));
    assert.deepEqual(after, expected.progress, 'a progress row landed on different numbers');

    // `worldId` is dropped on both sides only because the recorder did not capture the column;
    // every objective row is scoped to one world by construction and the recorder re-read them
    // `where world_id = <this world>`, so there is nothing it could disagree about.
    assert.deepEqual(
      result.objectives
        .map(({ worldId: _worldId, ...rest }) => rest)
        .sort(byKeys((o) => o.id)),
      expected.objectives,
      'a different set of objectives, or different progress on them',
    );

    // `points` is this port's addition — the ancestor's achievements never left the world they
    // were earned in, and worlds' shared profile takes a points value. Everything the ancestor
    // wrote is compared.
    assert.deepEqual(
      result.achievements
        .map(({ points: _points, worldId: _worldId, ...rest }) => rest)
        .sort(byKeys((a) => a.id)),
      expected.achievements,
      'a different set of achievements unlocked',
    );

    // `id` dropped on both sides: the ancestor's was a uuid. See the header.
    assert.deepEqual(
      result.events
        .map((e) => ({
          day: e.day,
          type: e.type,
          title: e.title,
          description: e.description,
          severity: e.severity,
        }))
        .sort(byKeys((e) => e.day, (e) => e.type)),
      expected.events,
      'a different day of world events',
    );

    assert.deepEqual(
      result.reports
        .map((r) => ({
          day: r.day,
          kind: r.kind,
          isPublic: r.isPublic,
          message: r.message,
          actorHandle: r.actorHandle,
          targetHandle: r.targetHandle,
          viewerPlayerId: r.viewerPlayerId,
        }))
        .sort(byKeys((r) => r.kind, (r) => r.message, (r) => r.viewerPlayerId)),
      expected.reports,
      'the day was reported differently — a message, a visibility or a reader changed',
    );
  });
}

test('conformance: the engine is deterministic — the same input twice is identical', () => {
  for (const recorded of corpus) {
    const a = resolveDay(recorded.input);
    const b = resolveDay(recorded.input);
    assert.deepEqual(
      JSON.parse(JSON.stringify(a)),
      JSON.parse(JSON.stringify(b)),
      `'${recorded.name}' did not replay identically`,
    );
  }
});

test('conformance: resolveDay does not mutate the input it was handed', () => {
  // A day that quietly edited its own snapshot would replay differently the second time and the
  // test above would catch it — but only for the fields it compares. This catches the whole thing.
  for (const recorded of corpus) {
    const frozen = JSON.stringify(recorded.input);
    resolveDay(recorded.input);
    assert.equal(JSON.stringify(recorded.input), frozen, `'${recorded.name}' mutated its input`);
  }
});
