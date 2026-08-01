// The engine, beyond the recorded corpus.
//
// `conformance.test.ts` proves this port resolves a DAY as the ancestor did. This file covers the
// two things that corpus structurally cannot reach, plus the properties the port added.
//
// WHY MAPS AND BOT PLANS NEED THEIR OWN CORPORA. `resolveDay` never draws from `seededRng` — its
// only randomness is the FNV-1a hash behind the event schedule and the LCG behind the objective
// shuffle. Mutating mulberry32's `0x6d2b79f5` by one therefore left every day-resolution assertion
// green. mulberry32 lives in map generation and in a raider bot's choice of prey, so those are
// recorded from the ancestor too, and the mutation is caught here instead.
//
// No database. Everything in this file is pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { generateMap, ruinStock } from './engine/mapgen.ts';
import { planBotDay, type BotView } from './engine/bots.ts';
import { hash, seededRng, seededShuffle } from './engine/rng.ts';
import { scheduleEvents, flagsFromEvents, worldEventId } from './engine/events.ts';
import { resolveDay, type DayInput } from './engine/resolve.ts';
import { aggregatePerks, SKILL_PERKS, type QueuedAction, type ResourceBag } from './rules.ts';
import { homesteadCandidates, claimFirstFree, type FreeTile } from './engine/homestead.ts';

const here = dirname(fileURLToPath(import.meta.url));
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8')) as T;

/* ------------------------------------------------------------------ recorded maps */

interface RecordedMap {
  seed: string;
  width: number;
  height: number;
  terrain: string;
  ruins: { x: number; y: number; name: string }[];
}

const mapFixture = read<{ maps: RecordedMap[]; ruinStock: ResourceBag[] }>('ancestor-maps.json');

const GLYPH: Record<string, string> = {
  wilderness: '.',
  forest: 'f',
  water: '~',
  road: '=',
  ruins: 'R',
  homestead: 'H',
};

for (const recorded of mapFixture.maps) {
  test(`mapgen: seed '${recorded.seed}' generates the ancestor's map, tile for tile`, () => {
    const map = generateMap(recorded.width, recorded.height, recorded.seed);
    const terrain = map.tiles.map((t) => GLYPH[t.terrain] ?? '?').join('');
    assert.equal(terrain, recorded.terrain, 'a tile of terrain differs from the ancestor');
    assert.deepEqual(
      map.tiles
        .filter((t) => t.terrain === 'ruins')
        .map((t) => ({ x: t.x, y: t.y, name: t.ruinName })),
      recorded.ruins,
      'the ruins were placed or named differently',
    );
  });
}

test('mapgen: ruin stock matches the ancestor for every placement index', () => {
  assert.deepEqual(
    mapFixture.ruinStock.map((_, i) => ruinStock(i)),
    mapFixture.ruinStock,
  );
});

test('mapgen: the same seed generates the same map twice', () => {
  const a = generateMap(24, 24, 'repeatable');
  const b = generateMap(24, 24, 'repeatable');
  assert.deepEqual(a, b);
});

test('mapgen: a different seed generates a genuinely different map', () => {
  // "Deterministic" is worthless if the seed is ignored. Two seeds must disagree on a real
  // fraction of the grid, not merely somewhere.
  const a = generateMap(32, 32, 'seed-one');
  const b = generateMap(32, 32, 'seed-two');
  let differing = 0;
  for (let i = 0; i < a.tiles.length; i++) {
    if (a.tiles[i]?.terrain !== b.tiles[i]?.terrain) differing++;
  }
  assert.ok(
    differing > a.tiles.length * 0.05,
    `only ${differing}/${a.tiles.length} tiles differ between two seeds`,
  );
});

/* ------------------------------------------------------------------ recorded bot plans */

interface RecordedBots {
  name: string;
  input: {
    seed: string;
    day: number;
    players: (BotView & { defense: number })[];
    ruins: { x: number; y: number }[];
    pending: { playerId: string; seq: number; action: QueuedAction }[];
  };
  expected: { playerId: string; seq: number; action: QueuedAction }[];
}

const botCorpus = read<RecordedBots[]>('ancestor-bots.json');

for (const recorded of botCorpus) {
  test(`bots: '${recorded.name}' plans the day exactly as the ancestor did`, () => {
    const { input } = recorded;
    const bots = input.players
      .filter((p) => p.isBot && p.alive)
      .sort((a, b) => a.id.localeCompare(b.id));
    const plan = planBotDay(bots, input.players, input.ruins, input.pending, input.seed, input.day);

    const flat = [...plan.entries()]
      .flatMap(([playerId, actions]) => actions.map((action, seq) => ({ playerId, seq, action })))
      .sort((a, b) => a.playerId.localeCompare(b.playerId) || a.seq - b.seq);

    // The ancestor's rows include the humans' untouched pending actions; only the bots' half is
    // rewritten, so only that half is comparable with a plan.
    const botIds = new Set(bots.map((b) => b.id));
    const expected = recorded.expected.filter((r) => botIds.has(r.playerId));

    assert.deepEqual(flat, expected, 'a bot chose a different day');
  });
}

test('bots: a raider never targets a spawn-protected settler', () => {
  const scenario = botCorpus.find((c) => c.name === 'raiders-spread-across-eligible-prey');
  assert.ok(scenario, 'the raider scenario is missing from the corpus');
  const protectedIds = new Set(
    scenario.input.players.filter((p) => p.joinedDay >= scenario.input.day - 2).map((p) => p.id),
  );
  assert.ok(protectedIds.size > 0, 'the scenario has nobody under spawn protection to test');
  for (const row of scenario.expected) {
    if (row.action.type === 'raid') {
      assert.ok(
        !protectedIds.has(row.action.targetPlayerId),
        `a raider was aimed at spawn-protected ${row.action.targetPlayerId}`,
      );
    }
  }
});

test('bots: raiders spread across the map instead of dogpiling one homestead', () => {
  // The property the weighted draw exists for. Every raider used to sort the same roster the same
  // way and take `[0]`, so the whole raider population converged on the single lowest-defence
  // homestead. Two hundred raiders here must reach every eligible target and none of the
  // ineligible one.
  //
  // The exact `+ 0.05` weight floor is pinned by the recorded plans above rather than here: it is
  // a balance constant with no crisp behavioural boundary, and a test that claimed otherwise would
  // be asserting a coincidence.
  const prey = [8, 0, 3, 400].map((defense, i) => ({
    id: `prey-${i}`,
    handle: `prey-${i}`,
    isBot: false,
    personality: null,
    homesteadX: 4 + i * 5,
    homesteadY: 4 + i * 5,
    resources: { food: 0, water: 0, materials: 0, fuel: 0, medicine: 0, seeds: 0 },
    hp: 100,
    reputation: 0,
    defense,
    alive: true,
    apPerDay: 6,
    joinedDay: 0,
  }));
  const sheltered = { ...prey[0]!, id: 'prey-new', joinedDay: 30, defense: 0 };
  const roster = [...prey, sheltered];

  const hits = new Map<string, number>();
  for (let i = 0; i < 200; i++) {
    const bot = { ...prey[0]!, id: `raider-${i}`, isBot: true, personality: 'raider' as const };
    const plan = planBotDay([bot], [bot, ...roster], [], [], 'spread-seed', 30);
    for (const action of plan.get(bot.id) ?? []) {
      if (action.type === 'raid') hits.set(action.targetPlayerId, (hits.get(action.targetPlayerId) ?? 0) + 1);
    }
  }

  assert.equal(hits.get('prey-new'), undefined, 'a spawn-protected settler was raided');
  for (const p of prey) {
    assert.ok((hits.get(p.id) ?? 0) > 0, `nobody ever raided ${p.id} — the draw has collapsed`);
  }
  const most = Math.max(...hits.values());
  assert.ok(most < 200, 'every raider picked the same target — this is the dogpile the draw removes');
});

/* ------------------------------------------------------------------ the primitives */

test('rng: hash is the ancestor FNV-1a, pinned on known inputs', () => {
  // These four values were read out of the ancestor's own `hash` (
  // `ninety-days-after/services/game/src/engine/events.ts:9`) by importing it and calling it —
  // not derived from this transcription, which would only prove the transcription agrees with
  // itself. A hash that silently changes re-rolls every world event and every objective
  // assignment in every world ever played.
  assert.equal(hash(''), 2166136261);
  assert.equal(hash('a'), 3826002220);
  assert.equal(hash('w-final-0010:90'), 2478722786);
  assert.equal(hash('ninety-days-after'), 2733823365);
  assert.ok(hash('anything') >= 0 && hash('anything') <= 0xffffffff, 'hash must be unsigned 32-bit');
});

test('rng: seededRng is reproducible and stays in [0, 1)', () => {
  const a = seededRng('x');
  const b = seededRng('x');
  for (let i = 0; i < 500; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1, `draw ${v} left [0, 1)`);
  }
});

test('rng: a different key gives a different stream', () => {
  const a = seededRng('key-one');
  const b = seededRng('key-two');
  let same = 0;
  for (let i = 0; i < 100; i++) if (a() === b()) same++;
  assert.equal(same, 0, 'two different keys produced overlapping draws');
});

test('rng: seededShuffle is a permutation, and seed-stable', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = seededShuffle(items, 12345);
  assert.deepEqual([...a].sort((x, y) => x - y), items, 'the shuffle lost or duplicated an element');
  assert.deepEqual(a, seededShuffle(items, 12345));
  assert.notDeepEqual(a, seededShuffle(items, 999));
});

/* ------------------------------------------------------------------ derived identifiers */

test('events: an event id is derived from (world, day, type) and is stable', () => {
  const a = scheduleEvents('w1', 'w1', 90, 90);
  const b = scheduleEvents('w1', 'w1', 90, 90);
  assert.deepEqual(a, b);
  for (const e of a) assert.equal(e.id, worldEventId('w1', e.day, e.type));
  // The ancestor's uuid meant two runs of one day disagreed here; that is the whole point.
  assert.equal(new Set(a.map((e) => e.id)).size, a.length, 'two events on one day share an id');
});

test('events: severity can be zero or negative — an inherited defect, pinned', () => {
  // `severity = 1 + ((h >> 8) % baseSeverity)`. `hash` returns unsigned 32-bit but `>>` is an
  // ARITHMETIC shift, so half of all seeds give a negative shift result, and JS `%` keeps the
  // sign. In the season's final third (baseSeverity 3) that reaches -1.
  //
  // The consequence is real: `flagsFromEvents` computes `stockBoom += 12 * severity`, so a
  // "Lucky Find" of severity -1 DRAINS the region by 12 of each scarce resource while announcing
  // that its stores swell. Severity 0 fires an event that does nothing at all.
  //
  // Not repaired here: this repository's headline claim is that a day resolves exactly as the
  // ancestor resolved it, and changing this would make that false for every world ever played.
  // It is reported in README.md. This test exists so it cannot change silently, in either
  // direction — a fix must come with a decision, not a diff.
  const events = scheduleEvents('w-final-0010', 'w-final-0010', 85, 90);
  const boom = events.find((e) => e.type === 'resource_boom');
  assert.ok(boom, 'the pinned seed no longer produces a resource_boom on day 85');
  assert.equal(boom.severity, -1, 'the negative-severity defect has changed shape');
  assert.equal(
    flagsFromEvents(events).stockBoom,
    -12,
    'a Lucky Find of severity -1 should still drain the pool by 12 — see README',
  );
});

test('reports: ids are derived, unique within a day, and stable across runs', () => {
  const input = dayWithTwoWorkers();
  const a = resolveDay(input);
  const b = resolveDay(input);
  assert.deepEqual(
    a.reports.map((r) => r.id),
    b.reports.map((r) => r.id),
  );
  assert.equal(
    new Set(a.reports.map((r) => r.id)).size,
    a.reports.length,
    'two reports in one day share an id',
  );
  for (const r of a.reports) assert.ok(r.id.startsWith(`${input.world.id}:${a.day}:`));
});

/* ------------------------------------------------------------------ determinism, both ways */

test('resolve: the same seed resolves identically; a different seed genuinely diverges', () => {
  // A day that ignored its seed would pass the first half of this and fail the second. Day 90 of a
  // 90-day season fires an ambient event whose type and severity are drawn from the seed, so two
  // seeds must produce different world events.
  const base = dayWithTwoWorkers();
  const same = resolveDay({ ...base, world: { ...base.world, day: 89, seasonLength: 90 } });
  const sameAgain = resolveDay({ ...base, world: { ...base.world, day: 89, seasonLength: 90 } });
  assert.deepEqual(same.events, sameAgain.events);

  const other = resolveDay({
    ...base,
    world: { ...base.world, day: 89, seasonLength: 90, seed: 'a-completely-different-seed' },
  });
  assert.notDeepEqual(
    same.events.map((e) => `${e.type}/${e.severity}`),
    other.events.map((e) => `${e.type}/${e.severity}`),
    'changing the seed did not change the day — the engine is ignoring it',
  );
});

test('resolve: the resolution order is total and does not depend on the input array order', () => {
  // The ancestor read its roster with a bare `db.select()` and no ORDER BY, then iterated that
  // result for upkeep — where the finite medicine pool is drawn from first-come. Which survivor
  // was resupplied therefore depended on the plan Postgres picked. This port sorts.
  const base = dayWithTwoWorkers();
  const forwards = resolveDay(base);
  const backwards = resolveDay({ ...base, players: [...base.players].reverse() });
  assert.deepEqual(forwards, backwards, 'reversing the roster changed the day');
});

/* ------------------------------------------------------------------ perks */

test('perks: the resist ceilings hold even if the tree ever stacks past them', () => {
  // Unreachable through the shipped tree (Bastion alone gives 0.4), and deliberately kept: without
  // the cap a `1 - resist` multiplier could reach zero and make a survivor literally unkillable.
  // The corpus cannot cover this, because no combination of real perks gets there.
  const stacked = aggregatePerks(SKILL_PERKS.map((p) => p.id));
  assert.ok(stacked.raidResist <= 0.9);
  assert.ok(stacked.diseaseResist <= 0.9);
  const bonuses = aggregatePerks(['warden_3', 'warden_3', 'warden_3', 'medic_3', 'medic_3']);
  // A Set dedupes ids, so repetition cannot stack — which is itself the guarantee worth pinning.
  assert.equal(bonuses.raidResist, 0.4);
  assert.equal(bonuses.diseaseResist, 0.5);
});

test('perks: an unknown perk id contributes nothing', () => {
  assert.deepEqual(aggregatePerks(['not_a_perk']), aggregatePerks([]));
});

/* ------------------------------------------------------------------ homestead placement */

test('homestead: candidates prefer open ground, then scan row-major', () => {
  const free: FreeTile[] = [
    { x: 5, y: 5, terrain: 'water' },
    { x: 3, y: 1, terrain: 'wilderness' },
    { x: 1, y: 1, terrain: 'road' },
    { x: 9, y: 0, terrain: 'ruins' },
    { x: 0, y: 2, terrain: 'forest' },
  ];
  assert.deepEqual(
    homesteadCandidates(free).map((t) => `${t.x},${t.y}`),
    ['1,1', '3,1', '0,2', '9,0', '5,5'],
  );
});

test('homestead: a claim refused moves on to the next tile rather than overwriting the winner', async () => {
  const free: FreeTile[] = [
    { x: 0, y: 0, terrain: 'wilderness' },
    { x: 1, y: 0, terrain: 'wilderness' },
    { x: 2, y: 0, terrain: 'wilderness' },
  ];
  const attempted: string[] = [];
  const won = await claimFirstFree(homesteadCandidates(free), async (t) => {
    attempted.push(`${t.x},${t.y}`);
    return t.x === 2; // the first two were taken between the read and the write
  });
  assert.deepEqual(attempted, ['0,0', '1,0', '2,0']);
  assert.equal(won?.x, 2);
});

test('homestead: a full map yields nobody a tile rather than a wrong one', async () => {
  const won = await claimFirstFree(homesteadCandidates([{ x: 0, y: 0, terrain: 'wilderness' }]), async () => false);
  assert.equal(won, undefined);
});

/* ------------------------------------------------------------------ fixtures */

function dayWithTwoWorkers(): DayInput {
  const bag = (o: Partial<ResourceBag> = {}): ResourceBag => ({
    food: 20,
    water: 20,
    materials: 10,
    fuel: 2,
    medicine: 1,
    seeds: 2,
    ...o,
  });
  return {
    world: {
      id: 'w-unit',
      name: 'unit',
      seed: 'w-unit',
      status: 'active',
      day: 4,
      seasonLength: 90,
      width: 16,
      height: 16,
      tickIntervalMinutes: 1440,
    },
    players: [
      {
        id: 'p1',
        worldId: 'w-unit',
        userId: 'u1',
        handle: 'one',
        isBot: false,
        personality: null,
        homesteadX: 2,
        homesteadY: 2,
        resources: bag(),
        hp: 100,
        morale: 100,
        defense: 0,
        reputation: 0,
        alive: true,
        apPerDay: 6,
        communeId: null,
        joinedDay: 0,
        createdAt: 1_000,
      },
      {
        id: 'p2',
        worldId: 'w-unit',
        userId: 'u2',
        handle: 'two',
        isBot: false,
        personality: null,
        homesteadX: 6,
        homesteadY: 6,
        resources: bag(),
        hp: 100,
        morale: 100,
        defense: 0,
        reputation: 0,
        alive: true,
        apPerDay: 6,
        communeId: null,
        joinedDay: 0,
        createdAt: 2_000,
      },
    ],
    queue: [
      { playerId: 'p1', seq: 0, action: { type: 'work' } },
      { playerId: 'p2', seq: 1, action: { type: 'work' } },
    ],
    ruins: [],
    stock: { food: 0, water: 0, materials: 0, fuel: 40, medicine: 40, seeds: 40 },
    progress: [],
    objectives: [],
    achievements: [],
  };
}
