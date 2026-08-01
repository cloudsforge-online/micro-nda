/**
 * Record the conformance corpus by EXECUTING THE FROZEN ANCESTOR.
 *
 * `src/fixtures/ancestor-corpus.json` is not hand-written and it is not this port's own output
 * played back at itself — that would prove only that the port is self-consistent. It is what
 * `ninety-days-after/services/game/src/engine/resolve.ts` actually did, captured by importing that
 * file unmodified, seeding a real Postgres with a hand-built world, calling `resolveDay`, and
 * reading back every row it wrote.
 *
 * This is the same method `micro-emberkin` used against the C# `BattleEngine`. It is a ONE-SHOT,
 * run by hand and never by CI: it reads a repository that is frozen and does not exist on a
 * runner, which is exactly why its output is committed rather than regenerated.
 *
 *   cd cloudsforge-micro/nda
 *   ANCESTOR_DATABASE_URL=postgres://nda:nda@127.0.0.1:55560/nda_ancestor \
 *     node --import tsx scripts/record-ancestor-corpus.ts
 *
 * ## What is and is not comparable
 *
 * The ancestor stamped `randomUUID()` on every `reports` row (`resolve.ts:827`) and every
 * `world_events` row (`events.ts:112`). Those two columns are not comparable with anything — not
 * with this port, and not with a second run of the ancestor itself. They are recorded as `null`
 * and the conformance test says so out loud. Every other column of every other row is captured
 * and compared exactly.
 *
 * ## Why the world ids and createdAt values are literals
 *
 * The world id is the ancestor's map seed AND its event seed (`world/generate.ts:30`), and
 * `createdAt` is the primary key of the resolution order (`resolve.ts:248`). Both are therefore
 * genuine simulation inputs. `createWorld` mints a uuid and Postgres defaults `created_at` to
 * `now()`, so a corpus built through those paths would be unreproducible by construction. Rows are
 * inserted directly with fixed values instead — the same rows those functions would have written,
 * with the two nondeterministic fields pinned.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ANCESTOR = '/Users/savvaniss/dev/personal/stack/repos/ninety-days-after/services/game/src';

const dsn = process.env['ANCESTOR_DATABASE_URL'];
if (!dsn) throw new Error('set ANCESTOR_DATABASE_URL to a throwaway database');
// The ancestor's env.ts reads these at import and refuses to load without them.
process.env['GAME_DATABASE_URL'] = dsn;
process.env['NIMBUS_JWKS_URL'] ??= 'http://127.0.0.1:4001/.well-known/jwks.json';

/* eslint-disable @typescript-eslint/no-explicit-any */
const { db, sql } = (await import(`${ANCESTOR}/db/client.js`)) as any;
const { migrate } = (await import(`${ANCESTOR}/db/migrate.js`)) as any;
const schema = (await import(`${ANCESTOR}/db/schema.js`)) as any;
const { resolveDay } = (await import(`${ANCESTOR}/engine/resolve.js`)) as any;
const { generateMap, ruinStock } = (await import(`${ANCESTOR}/world/mapgen.js`)) as any;
const { startingBag } = (await import(`${ANCESTOR}/util.js`)) as any;

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => quietLog,
  level: 'silent',
} as any;

await migrate();

/* ------------------------------------------------------------------------ the scenarios */

type Bag = Record<string, number>;
const bag = (o: Partial<Bag> = {}): Bag => ({
  food: 0,
  water: 0,
  materials: 0,
  fuel: 0,
  medicine: 0,
  seeds: 0,
  ...o,
});

interface PlayerSpec {
  id: string;
  handle: string;
  isBot?: boolean;
  personality?: string | null;
  x: number;
  y: number;
  resources?: Partial<Bag>;
  hp?: number;
  morale?: number;
  defense?: number;
  reputation?: number;
  alive?: boolean;
  joinedDay?: number;
  createdAt: number;
}

interface ProgressSpec {
  playerId: string;
  level?: number;
  xp?: number;
  skillPoints?: number;
  perks?: string[];
  tokens?: number;
  streak?: number;
  lastSeenDay?: number;
  daysSurvived?: number;
  contribution?: number;
}

interface ObjectiveSpec {
  id: string;
  playerId: string;
  bucket: number;
  kind: string;
  description: string;
  target: number;
  progress: number;
  period: string;
  rewardXp: number;
  rewardTokens: number;
  claimed: boolean;
}

interface Scenario {
  name: string;
  /** Fixed — it is the map seed and the event seed. */
  worldId: string;
  day: number;
  seasonLength: number;
  width: number;
  height: number;
  players: PlayerSpec[];
  actions: { playerId: string; seq: number; action: unknown }[];
  progress?: ProgressSpec[];
  objectives?: ObjectiveSpec[];
  achievements?: { playerId: string; achId: string }[];
  stock?: Partial<Bag>;
}

const P = (
  id: string,
  handle: string,
  x: number,
  y: number,
  createdAt: number,
  extra: Partial<PlayerSpec> = {},
): PlayerSpec => ({ id, handle, x, y, createdAt, ...extra });

/**
 * Ten worlds, chosen to drive every branch of `resolveDay`: work/rest/fortify/scavenge/raid/trade,
 * every one of the six ambient event types (day 5/10/…/N with the seed picked so the hash lands on
 * the type named), a season milestone, contested scavenging, spawn protection refusing a raid, a
 * raid that kills, starvation, a disease outbreak that empties the relief pool, a maxed perk
 * stack, a bot roster, and the final day of a season (archival).
 */
const SCENARIOS: Scenario[] = [
  {
    name: 'quiet-day-work-rest-fortify',
    worldId: 'w-quiet-0001',
    day: 0,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-alice', 'alice', 3, 3, 1_000, { resources: { food: 10, water: 10, materials: 6, fuel: 1, seeds: 2 } }),
      P('p-bob', 'bob', 9, 9, 2_000, { resources: { food: 4, water: 4, materials: 3 }, hp: 60 }),
    ],
    actions: [
      { playerId: 'p-alice', seq: 0, action: { type: 'work' } },
      { playerId: 'p-alice', seq: 1, action: { type: 'work' } },
      { playerId: 'p-alice', seq: 2, action: { type: 'fortify' } },
      { playerId: 'p-bob', seq: 3, action: { type: 'rest' } },
      { playerId: 'p-bob', seq: 4, action: { type: 'fortify' } },
      { playerId: 'p-bob', seq: 5, action: { type: 'fortify' } },
    ],
  },
  {
    name: 'contested-scavenge-three-ways',
    worldId: 'w-scav-0002',
    day: 1,
    seasonLength: 90,
    width: 20,
    height: 20,
    players: [
      P('p-a', 'ann', 2, 2, 1_000),
      P('p-b', 'ben', 4, 4, 2_000),
      P('p-c', 'cyd', 6, 6, 3_000),
    ],
    // (12,4) 'Collapsed Refinery' and (4,5) 'Broken Overpass' are where generateMap puts ruins for
    // this seed. Three claimants on one tile and one on another, so the `share` divisor and the
    // Scavenger multiplier are both exercised, along with a scavenge of a tile that has no ruin.
    actions: [
      { playerId: 'p-a', seq: 0, action: { type: 'scavenge', x: 12, y: 4 } },
      { playerId: 'p-a', seq: 1, action: { type: 'scavenge', x: 4, y: 5 } },
      { playerId: 'p-b', seq: 2, action: { type: 'scavenge', x: 12, y: 4 } },
      { playerId: 'p-c', seq: 3, action: { type: 'scavenge', x: 12, y: 4 } },
      { playerId: 'p-c', seq: 4, action: { type: 'scavenge', x: 0, y: 0 } },
    ],
    progress: [{ playerId: 'p-a', perks: ['scavenger_1', 'scavenger_2'], level: 4 }],
  },
  {
    // `hash('w-probe-0001:15') % 6` selects `disease_outbreak`; a 20-day season puts day 15 past
    // the two-thirds mark, so the severity band is the season's harshest.
    name: 'disease-outbreak-medicine-relief-and-death',
    worldId: 'w-probe-0001',
    day: 14,
    seasonLength: 20,
    width: 16,
    height: 16,
    players: [
      P('p-stocked', 'stocked', 2, 2, 1_000, { resources: { food: 30, water: 30, medicine: 3 } }),
      P('p-bare', 'bare', 5, 5, 2_000, { resources: { food: 30, water: 30 }, hp: 90 }),
      P('p-frail', 'frail', 8, 8, 3_000, { resources: { food: 30, water: 30 }, hp: 4 }),
    ],
    actions: [],
    // Enough relief for everyone who needs it, so no survivor competes with another for the last
    // unit — the one place the ancestor's unordered roster read could have changed the answer.
    stock: { medicine: 8 },
  },
  {
    // `hash('w-probe-0002:25') % 6` selects `resource_bust`: the region's reserves are cut.
    name: 'resource-bust-drains-the-region',
    worldId: 'w-probe-0002',
    day: 24,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-r1', 'rina', 3, 3, 1_000, { resources: { food: 30, water: 30, materials: 5 } }),
    ],
    actions: [
      { playerId: 'p-r1', seq: 0, action: { type: 'work' } },
      { playerId: 'p-r1', seq: 1, action: { type: 'work' } },
    ],
    // Fuel is well ABOVE the bust so the subtraction itself is visible — with every resource
    // below it the pool floored at zero and the size of the bust could not be observed at all.
    // Medicine and seeds stay below it, so the `Math.max(0, ...)` floor is covered too, and the
    // seed and fuel draws in `work` then find an empty reserve.
    stock: { fuel: 34, medicine: 2, seeds: 1 },
  },
  {
    name: 'raid-repelled-and-raid-that-kills',
    worldId: 'w-raid-0003',
    day: 10,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-wolf', 'wolf', 2, 2, 1_000, { morale: 100, resources: { food: 20, water: 20 } }),
      P('p-wall', 'wall', 5, 5, 2_000, { defense: 30, joinedDay: 0, resources: { food: 30, water: 30, materials: 20 } }),
      P('p-lamb', 'lamb', 8, 8, 3_000, { hp: 8, defense: 0, joinedDay: 0, resources: { food: 40, water: 40, materials: 10, fuel: 5, medicine: 3 } }),
    ],
    actions: [
      { playerId: 'p-wolf', seq: 0, action: { type: 'raid', targetPlayerId: 'p-wall' } },
      { playerId: 'p-wolf', seq: 1, action: { type: 'raid', targetPlayerId: 'p-lamb' } },
    ],
    progress: [{ playerId: 'p-wall', perks: ['warden_1', 'warden_2', 'warden_3'], level: 6 }],
  },
  {
    name: 'raid-refused-by-spawn-protection',
    worldId: 'w-spawn-0004',
    day: 2,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-wolf', 'wolf', 2, 2, 1_000, { morale: 100 }),
      P('p-new', 'newcomer', 5, 5, 2_000, { joinedDay: 3, resources: { food: 30, water: 30 } }),
    ],
    actions: [{ playerId: 'p-wolf', seq: 0, action: { type: 'raid', targetPlayerId: 'p-new' } }],
  },
  {
    name: 'trade-consented-and-trade-merely-offered',
    worldId: 'w-trade-0005',
    day: 4,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-x', 'xan', 2, 2, 1_000, { resources: { food: 20, water: 20, materials: 10 } }),
      P('p-y', 'yves', 5, 5, 2_000, { resources: { food: 20, water: 20, materials: 10 } }),
      P('p-z', 'zia', 8, 8, 3_000, { resources: { food: 20, water: 20, materials: 10 } }),
    ],
    actions: [
      { playerId: 'p-x', seq: 0, action: { type: 'trade', targetPlayerId: 'p-y', offer: { materials: 2 }, request: { food: 3 } } },
      { playerId: 'p-y', seq: 1, action: { type: 'trade', targetPlayerId: 'p-x', offer: { food: 3 }, request: { materials: 2 } } },
      { playerId: 'p-z', seq: 2, action: { type: 'trade', targetPlayerId: 'p-x', offer: { water: 1 }, request: { materials: 5 } } },
    ],
    progress: [{ playerId: 'p-x', perks: ['trader_1', 'trader_2'], level: 5 }],
  },
  {
    name: 'starvation-and-thirst-kill',
    worldId: 'w-hunger-0006',
    day: 44,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-dry', 'dry', 2, 2, 1_000, { hp: 12, resources: {} }),
      P('p-thin', 'thin', 5, 5, 2_000, { hp: 90, resources: { water: 50 } }),
    ],
    actions: [],
  },
  {
    name: 'ambient-event-day-and-global-stock-swing',
    worldId: 'w-event-0007',
    day: 9,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-e1', 'ella', 2, 2, 1_000, { resources: { food: 30, water: 30, materials: 10, medicine: 1 } }),
      P('p-e2', 'eli', 6, 6, 2_000, { resources: { food: 30, water: 30 }, defense: 1 }),
    ],
    actions: [
      { playerId: 'p-e1', seq: 0, action: { type: 'work' } },
      { playerId: 'p-e2', seq: 1, action: { type: 'work' } },
    ],
    stock: { fuel: 3, medicine: 1, seeds: 3 },
  },
  {
    name: 'season-milestone-day-thirty',
    worldId: 'w-mile-0008',
    day: 29,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-m1', 'mila', 3, 3, 1_000, { resources: { food: 40, water: 40, materials: 30 } }),
    ],
    actions: [{ playerId: 'p-m1', seq: 0, action: { type: 'fortify' } }],
    progress: [{ playerId: 'p-m1', daysSurvived: 29, level: 9, xp: 300, tokens: 120 }],
  },
  {
    name: 'bot-roster-full-day',
    worldId: 'w-bots-0009',
    day: 14,
    seasonLength: 90,
    width: 20,
    height: 20,
    players: [
      P('p-bot-farmer', 'bot-farmer-1', 3, 3, 1_000, { isBot: true, personality: 'farmer', resources: { food: 20, water: 20, materials: 10, fuel: 2, seeds: 3 } }),
      P('p-bot-raider', 'bot-raider-2', 6, 6, 2_000, { isBot: true, personality: 'raider', morale: 90, resources: { food: 20, water: 20 } }),
      P('p-bot-trader', 'bot-trader-3', 9, 9, 3_000, { isBot: true, personality: 'trader', resources: { food: 20, water: 20, materials: 10 } }),
      P('p-human', 'human', 12, 12, 4_000, { joinedDay: 0, resources: { food: 25, water: 25, materials: 8 } }),
    ],
    actions: [
      { playerId: 'p-bot-farmer', seq: 0, action: { type: 'work' } },
      { playerId: 'p-bot-farmer', seq: 1, action: { type: 'work' } },
      { playerId: 'p-bot-farmer', seq: 2, action: { type: 'fortify' } },
      { playerId: 'p-bot-raider', seq: 3, action: { type: 'raid', targetPlayerId: 'p-human' } },
      { playerId: 'p-bot-trader', seq: 4, action: { type: 'trade', targetPlayerId: 'p-human', offer: { materials: 2 }, request: { food: 2 } } },
      { playerId: 'p-human', seq: 5, action: { type: 'trade', targetPlayerId: 'p-bot-trader', offer: { food: 2 }, request: { materials: 2 } } },
    ],
    progress: [
      { playerId: 'p-bot-farmer', level: 3, skillPoints: 2, lastSeenDay: 13, streak: 5 },
      { playerId: 'p-bot-raider', level: 2, skillPoints: 1, lastSeenDay: 11, streak: 2 },
    ],
  },
  {
    // Defence values chosen so the raid arithmetic is VISIBLE rather than saturated. With the
    // earlier corpus every raid either bounced off a wall or hit a target with defence 0, where
    // `frac = (power - 0) / power` is 1 whatever `power` is — so changing the `morale / 25` in
    // `power = 8 + floor(morale / 25)` altered nothing anybody could observe. These targets sit in
    // between, where the stolen fraction depends on the exact power.
    name: 'raid-against-partial-defences',
    worldId: 'w-partial-0016',
    day: 20,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-hot', 'hotblood', 2, 2, 1_000, { morale: 100, resources: { food: 10, water: 10 } }),
      P('p-cool', 'coolhead', 4, 2, 2_000, { morale: 12, resources: { food: 10, water: 10 } }),
      P('p-mid1', 'midwall', 8, 8, 3_000, { defense: 6, joinedDay: 0, resources: { food: 44, water: 33, materials: 27, fuel: 11, medicine: 7 } }),
      P('p-mid2', 'lowwall', 12, 12, 4_000, { defense: 3, joinedDay: 0, resources: { food: 44, water: 33, materials: 27, fuel: 11, medicine: 7 } }),
    ],
    actions: [
      { playerId: 'p-hot', seq: 0, action: { type: 'raid', targetPlayerId: 'p-mid1' } },
      { playerId: 'p-cool', seq: 1, action: { type: 'raid', targetPlayerId: 'p-mid2' } },
    ],
  },
  {
    // `threshold = 4 + warbandSeverity`, and a homestead is spared when `guard >= threshold`. With
    // only defence-0 and defence-22 survivors in the corpus, moving that `4` changed nothing: the
    // first was always struck for the same fraction and the second always spared. These four sit
    // on either side of the line. `hash('w-wb-0001:15') % 6` selects `raider_warband` at severity
    // 1, so the threshold is 5 and only `four` is struck.
    name: 'warband-picks-off-the-middling-defences',
    worldId: 'w-wb-0001',
    day: 14,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-w4', 'four', 2, 2, 1_000, { defense: 4, joinedDay: 0, resources: { food: 40, water: 40, materials: 24, fuel: 12, medicine: 8 } }),
      P('p-w5', 'five', 5, 5, 2_000, { defense: 5, joinedDay: 0, resources: { food: 40, water: 40, materials: 24, fuel: 12, medicine: 8 } }),
      P('p-w6', 'six', 8, 8, 3_000, { defense: 6, joinedDay: 0, resources: { food: 40, water: 40, materials: 24, fuel: 12, medicine: 8 } }),
      P('p-w7', 'seven', 11, 11, 4_000, { defense: 7, joinedDay: 0, resources: { food: 40, water: 40, materials: 24, fuel: 12, medicine: 8 } }),
    ],
    actions: [],
  },
  {
    // `upkeep = 2 + floor((day - 1) / 40)` steps from 2 to 3 exactly here. Before this world was
    // added, changing that `40` to a `41` left the whole corpus green — the first version of this
    // file had no scenario anywhere near a boundary, which is the failure mode of a corpus chosen
    // by what looks interesting rather than by what the arithmetic can hide.
    name: 'upkeep-steps-up-on-day-forty-one',
    worldId: 'w-upkeep-0011',
    day: 40,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-u1', 'ursa', 3, 3, 1_000, { resources: { food: 2, water: 2 }, hp: 100 }),
      P('p-u2', 'umber', 7, 7, 2_000, { resources: { food: 3, water: 3 }, hp: 100 }),
    ],
    actions: [],
  },
  {
    /** The second step, 3 → 4. `floor(80/40) = 2` and `floor(80/41) = 1`. */
    name: 'upkeep-steps-up-again-on-day-eighty-one',
    worldId: 'w-upkeep-0012',
    day: 80,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-v1', 'vela', 3, 3, 1_000, { resources: { food: 3, water: 3 }, hp: 100 }),
      P('p-v2', 'vane', 7, 7, 2_000, { resources: { food: 4, water: 4 }, hp: 100 }),
    ],
    actions: [],
  },
  {
    name: 'level-up-rollover-and-the-streak-morale-cap',
    worldId: 'w-level-0013',
    day: 12,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      // One XP short of level 2 with a full day queued: `grantXp`'s `while` has to roll over.
      P('p-brink', 'brink', 3, 3, 1_000, { resources: { food: 30, water: 30, materials: 20, fuel: 3, seeds: 3 } }),
      // streak 9 → `streakMoraleBonus` is capped at 12, not 18. Morale is low enough to see it.
      P('p-streak', 'streak', 7, 7, 2_000, { resources: { food: 30, water: 30 }, morale: 40 }),
    ],
    actions: [
      { playerId: 'p-brink', seq: 0, action: { type: 'work' } },
      { playerId: 'p-brink', seq: 1, action: { type: 'work' } },
      { playerId: 'p-brink', seq: 2, action: { type: 'work' } },
      { playerId: 'p-brink', seq: 3, action: { type: 'fortify' } },
      { playerId: 'p-brink', seq: 4, action: { type: 'fortify' } },
      { playerId: 'p-brink', seq: 5, action: { type: 'rest' } },
    ],
    progress: [
      { playerId: 'p-brink', level: 1, xp: 49, skillPoints: 0 },
      { playerId: 'p-streak', level: 2, xp: 10, streak: 9, lastSeenDay: 12 },
    ],
  },
  {
    name: 'trade-agreed-but-goods-gone-and-a-trade-with-no-terms',
    worldId: 'w-badtrade-0014',
    day: 6,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-t1', 'tam', 3, 3, 1_000, { resources: { food: 20, water: 20, materials: 2 } }),
      P('p-t2', 'tor', 7, 7, 2_000, { resources: { food: 20, water: 20, materials: 10 } }),
      P('p-t3', 'tess', 11, 11, 3_000, { resources: { food: 20, water: 20 } }),
    ],
    actions: [
      // Both queued the mirror, so consent is found — and then tam cannot pay the 5 materials.
      { playerId: 'p-t1', seq: 0, action: { type: 'trade', targetPlayerId: 'p-t2', offer: { materials: 5 }, request: { food: 4 } } },
      { playerId: 'p-t2', seq: 1, action: { type: 'trade', targetPlayerId: 'p-t1', offer: { food: 4 }, request: { materials: 5 } } },
      // An empty offer — the exploit the mirror rule exists to close. The tick refuses it.
      { playerId: 'p-t3', seq: 2, action: { type: 'trade', targetPlayerId: 'p-t2', offer: {}, request: { food: 9 } } },
      // A partner who is not in this world at all.
      { playerId: 'p-t3', seq: 3, action: { type: 'trade', targetPlayerId: 'p-nobody', offer: { food: 1 }, request: { water: 1 } } },
    ],
  },
  {
    name: 'a-claimed-objective-keeps-its-progress',
    worldId: 'w-obj-0015',
    day: 6,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [P('p-obj1', 'olive', 3, 3, 1_000, { resources: { food: 30, water: 30, materials: 30 } })],
    actions: [
      { playerId: 'p-obj1', seq: 0, action: { type: 'fortify' } },
      { playerId: 'p-obj1', seq: 1, action: { type: 'fortify' } },
    ],
    // Day 7 assigns olive scav2, fort2 and raid1. `fort2` is pre-claimed at progress ONE — below
    // its target of two — and olive fortifies twice today. A claimed objective's progress is what
    // was paid for, so it must stay at 1; without the `claimed ? priorProgress : next` guard it
    // would move to 2, and the corpus has to be able to tell those apart. (It could not when the
    // pre-claimed progress was set equal to the target: both answers were 2.)
    // `scav2` is pre-set to 1 and unclaimed, so it stays at 1 — no scavenging today.
    objectives: [
      { id: 'p-obj1:daily:7:fort2', playerId: 'p-obj1', bucket: 7, kind: 'fortify', description: 'Fortify twice', target: 2, progress: 1, period: 'daily', rewardXp: 15, rewardTokens: 3, claimed: true },
      { id: 'p-obj1:daily:7:scav2', playerId: 'p-obj1', bucket: 7, kind: 'scavenge', description: 'Scavenge 2 ruins', target: 2, progress: 1, period: 'daily', rewardXp: 20, rewardTokens: 4, claimed: false },
    ],
  },
  {
    name: 'maxed-scavenger-doubles-the-haul',
    worldId: 'w-scav-0002',
    day: 2,
    seasonLength: 90,
    width: 20,
    height: 20,
    players: [
      P('p-max', 'maxine', 2, 2, 1_000),
      P('p-none', 'norah', 4, 4, 2_000),
    ],
    // Same tile, same ruin, one with the full Scavenger branch and one with none: the
    // `floor(base * (1 + scavengeBonus))` multiplier is visible as the difference between them.
    actions: [
      { playerId: 'p-max', seq: 0, action: { type: 'scavenge', x: 6, y: 9 } },
      { playerId: 'p-none', seq: 1, action: { type: 'scavenge', x: 6, y: 9 } },
    ],
    progress: [
      { playerId: 'p-max', perks: ['scavenger_1', 'scavenger_2', 'scavenger_3'], level: 7 },
    ],
  },
  {
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // AN INHERITED DEFECT, PINNED RATHER THAN FIXED.
    //
    // `severity = 1 + ((h >> 8) % baseSeverity)` (`engine/events.ts:130`). `h` is unsigned 32-bit
    // (`hash` ends `>>> 0`) but `>>` is an ARITHMETIC shift, so for any h >= 2^31 — half of all
    // seeds — `h >> 8` is negative, JS `%` keeps the sign of the dividend, and the severity comes
    // out 0 or, in the season's final third where `baseSeverity` is 3, **-1**.
    //
    // `hash('w-final-0010:85')` is such a seed. The result is a `resource_boom` of severity -1: the
    // world announces "Lucky Find — the region's stores swell" and `flagsFromEvents` then computes
    // `stockBoom += 12 * -1`, DRAINING the pool by 12 of each scarce resource. A severity-0 event
    // (13% of ambient events at `baseSeverity` 2) fires, is announced, and does nothing at all.
    //
    // This is recorded, not repaired. The headline claim of this repository is that a day resolves
    // exactly as the ancestor resolved it, and changing this formula would make that false for
    // every world ever played. It is reported in README.md under "Defects found in the ancestor",
    // and this scenario is what stops it changing by accident.
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    name: 'inherited-defect-a-lucky-find-of-negative-severity',
    worldId: 'w-final-0010',
    day: 84,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-neg', 'nadia', 3, 3, 1_000, { resources: { food: 40, water: 40, materials: 10 } }),
    ],
    actions: [],
    stock: { fuel: 40, medicine: 40, seeds: 40 },
  },
  {
    name: 'final-day-of-the-season-archives',
    worldId: 'w-final-0010',
    day: 89,
    seasonLength: 90,
    width: 16,
    height: 16,
    players: [
      P('p-end1', 'endurer', 3, 3, 1_000, { resources: { food: 60, water: 60, materials: 40, medicine: 4 }, defense: 22 }),
      P('p-end2', 'faded', 7, 7, 2_000, { resources: { food: 1 }, hp: 15 }),
    ],
    actions: [
      { playerId: 'p-end1', seq: 0, action: { type: 'work' } },
      { playerId: 'p-end1', seq: 1, action: { type: 'scavenge', x: 0, y: 0 } },
    ],
    progress: [
      { playerId: 'p-end1', daysSurvived: 89, level: 24, xp: 700, tokens: 250, contribution: 12 },
      { playerId: 'p-end2', daysSurvived: 61, level: 11 },
    ],
    achievements: [{ playerId: 'p-end1', achId: 'days_60' }],
  },
];

/* ------------------------------------------------------------------------ the recorder */

async function truncateAll(): Promise<void> {
  await sql.unsafe(
    `truncate worlds, tiles, players, queued_actions, reports, communes, world_stock,
       player_progress, objectives, achievements, world_events, player_cosmetics restart identity cascade`,
  );
}

const sortBy =
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

interface Recorded {
  name: string;
  input: unknown;
  expected: unknown;
}

const recorded: Recorded[] = [];

for (const s of SCENARIOS) {
  await truncateAll();

  // The world. `status` is 'active' because that is the only status resolveDay is ever called on.
  await db.insert(schema.worlds).values({
    id: s.worldId,
    name: s.name,
    status: 'active',
    day: s.day,
    seasonLength: s.seasonLength,
    width: s.width,
    height: s.height,
    tickIntervalMinutes: 1440,
    botsEnabled: s.players.some((p) => p.isBot),
    botCount: s.players.filter((p) => p.isBot).length,
    nextTickAt: new Date(0),
    createdAt: new Date(0),
  });

  // The map — the ancestor's own generator, seeded on the world id exactly as createWorld does.
  const { map } = generateMap(s.width, s.height, s.worldId);
  let ruinIndex = 0;
  const tileRows = map.tiles.map((t: any) => {
    const isRuin = t.terrain === 'ruins';
    const row = {
      id: `${s.worldId}:tile:${t.x},${t.y}`,
      worldId: s.worldId,
      x: t.x,
      y: t.y,
      terrain: t.terrain,
      ruinName: t.ruinName ?? null,
      ruinStock: isRuin ? ruinStock(ruinIndex) : null,
      ownerId: null,
    };
    if (isRuin) ruinIndex++;
    return row;
  });
  for (let i = 0; i < tileRows.length; i += 500) {
    await db.insert(schema.tiles).values(tileRows.slice(i, i + 500));
  }

  await db.insert(schema.worldStock).values({
    worldId: s.worldId,
    stock: bag({ fuel: 80, medicine: 50, seeds: 120, ...(s.stock ?? {}) }),
  });

  for (const p of s.players) {
    await db.insert(schema.players).values({
      id: p.id,
      worldId: s.worldId,
      userId: p.isBot ? null : `user-${p.id}`,
      handle: p.handle,
      isBot: p.isBot ?? false,
      personality: p.personality ?? null,
      homesteadX: p.x,
      homesteadY: p.y,
      resources: bag(p.resources ?? startingBag()),
      hp: p.hp ?? 100,
      morale: p.morale ?? 100,
      defense: p.defense ?? 0,
      reputation: p.reputation ?? 0,
      alive: p.alive ?? true,
      apPerDay: 6,
      communeId: null,
      cosmeticStyle: null,
      joinedDay: p.joinedDay ?? 0,
      createdAt: new Date(p.createdAt),
    });
  }

  for (const a of s.actions) {
    await db.insert(schema.queuedActions).values({
      id: `${s.worldId}:qa:${a.seq}`,
      worldId: s.worldId,
      playerId: a.playerId,
      seq: a.seq,
      action: a.action,
    });
  }

  for (const g of s.progress ?? []) {
    await db.insert(schema.playerProgress).values({
      playerId: g.playerId,
      worldId: s.worldId,
      level: g.level ?? 1,
      xp: g.xp ?? 0,
      skillPoints: g.skillPoints ?? 0,
      perks: g.perks ?? [],
      tokens: g.tokens ?? 0,
      streak: g.streak ?? 0,
      lastSeenDay: g.lastSeenDay ?? -1,
      daysSurvived: g.daysSurvived ?? 0,
      contribution: g.contribution ?? 0,
    });
  }

  for (const o of s.objectives ?? []) {
    await db.insert(schema.objectives).values({ ...o, worldId: s.worldId });
  }

  for (const a of s.achievements ?? []) {
    await db.insert(schema.achievements).values({
      id: `${a.playerId}:${a.achId}`,
      worldId: s.worldId,
      playerId: a.playerId,
      achId: a.achId,
      name: a.achId,
      description: a.achId,
      unlockedAt: 1,
    });
  }

  /* ---- capture the INPUT exactly as it stands, then run the ancestor ---- */

  const beforePlayers = await sql`select * from players where world_id = ${s.worldId} order by id`;
  const beforeProgress = await sql`select * from player_progress where world_id = ${s.worldId} order by player_id`;
  const beforeTiles = await sql`select * from tiles where world_id = ${s.worldId} and terrain = 'ruins' order by y, x`;
  const beforeStock = await sql`select * from world_stock where world_id = ${s.worldId}`;
  const beforeObjectives = await sql`select * from objectives where world_id = ${s.worldId} order by id`;
  const beforeAchievements = await sql`select * from achievements where world_id = ${s.worldId} order by id`;
  const [worldRow] = await sql`select * from worlds where id = ${s.worldId}`;

  await resolveDay(
    {
      ...worldRow,
      seasonLength: worldRow.season_length,
      tickIntervalMinutes: worldRow.tick_interval_minutes,
      id: worldRow.id,
      name: worldRow.name,
      day: worldRow.day,
      status: worldRow.status,
      width: worldRow.width,
      height: worldRow.height,
    },
    quietLog,
  );

  const afterPlayers = await sql`select * from players where world_id = ${s.worldId} order by id`;
  const afterProgress = await sql`select * from player_progress where world_id = ${s.worldId} order by player_id`;
  const afterTiles = await sql`select * from tiles where world_id = ${s.worldId} and terrain = 'ruins' order by y, x`;
  const afterStock = await sql`select * from world_stock where world_id = ${s.worldId}`;
  const afterObjectives = await sql`select * from objectives where world_id = ${s.worldId} order by id`;
  const afterAchievements = await sql`select * from achievements where world_id = ${s.worldId} order by id`;
  const afterEvents = await sql`select * from world_events where world_id = ${s.worldId} order by day, type`;
  // Reports carry a uuid id and a now() timestamp; neither is comparable with anything. They are
  // ordered by insertion, which `reports.id` cannot express, so the recorder relies on the
  // physical order postgres returns for a single un-updated insert batch — deliberately NOT part
  // of the assertion. `created_at` ties are broken by the message, which is what the test compares.
  const afterReports = await sql`select * from reports where world_id = ${s.worldId}`;
  const [afterWorld] = await sql`select * from worlds where id = ${s.worldId}`;

  recorded.push({
    name: s.name,
    input: {
      world: {
        id: worldRow.id,
        name: worldRow.name,
        seed: worldRow.id, // the ancestor's seed IS the id
        status: worldRow.status,
        day: worldRow.day,
        seasonLength: worldRow.season_length,
        width: worldRow.width,
        height: worldRow.height,
        tickIntervalMinutes: worldRow.tick_interval_minutes,
      },
      players: beforePlayers.map((p: any) => ({
        id: p.id,
        worldId: p.world_id,
        userId: p.user_id,
        handle: p.handle,
        isBot: p.is_bot,
        personality: p.personality,
        homesteadX: p.homestead_x,
        homesteadY: p.homestead_y,
        resources: p.resources,
        hp: p.hp,
        morale: p.morale,
        defense: p.defense,
        reputation: p.reputation,
        alive: p.alive,
        apPerDay: p.ap_per_day,
        communeId: p.commune_id,
        joinedDay: p.joined_day,
        createdAt: new Date(p.created_at).getTime(),
      })),
      queue: s.actions.map((a) => ({ playerId: a.playerId, seq: a.seq, action: a.action })),
      ruins: beforeTiles.map((t: any) => ({
        x: t.x,
        y: t.y,
        name: t.ruin_name ?? 'ruins',
        stock: t.ruin_stock,
      })),
      stock: beforeStock[0].stock,
      progress: beforeProgress.map((g: any) => ({
        playerId: g.player_id,
        level: g.level,
        xp: g.xp,
        skillPoints: g.skill_points,
        perks: g.perks,
        tokens: g.tokens,
        streak: g.streak,
        lastSeenDay: g.last_seen_day,
        daysSurvived: g.days_survived,
        contribution: g.contribution,
      })),
      objectives: beforeObjectives.map((o: any) => ({
        id: o.id,
        playerId: o.player_id,
        progress: o.progress,
        claimed: o.claimed,
      })),
      achievements: beforeAchievements.map((a: any) => ({ playerId: a.player_id, achId: a.ach_id })),
    },
    expected: {
      day: afterWorld.day,
      status: afterWorld.status,
      players: afterPlayers
        .map((p: any) => ({
          id: p.id,
          resources: p.resources,
          hp: p.hp,
          morale: p.morale,
          defense: p.defense,
          reputation: p.reputation,
          alive: p.alive,
        }))
        .sort(sortBy((r: any) => r.id)),
      ruins: afterTiles
        .map((t: any) => ({ x: t.x, y: t.y, stock: t.ruin_stock }))
        .sort(sortBy((r: any) => r.y, (r: any) => r.x)),
      stock: afterStock[0].stock,
      /** The persisted row after the ancestor's FOR UPDATE delta write. */
      progress: afterProgress
        .map((g: any) => ({
          playerId: g.player_id,
          level: g.level,
          xp: g.xp,
          skillPoints: g.skill_points,
          perks: g.perks,
          tokens: g.tokens,
          streak: g.streak,
          lastSeenDay: g.last_seen_day,
          daysSurvived: g.days_survived,
          contribution: g.contribution,
        }))
        .sort(sortBy((r: any) => r.playerId)),
      objectives: afterObjectives
        .map((o: any) => ({
          id: o.id,
          playerId: o.player_id,
          bucket: o.bucket,
          kind: o.kind,
          description: o.description,
          target: o.target,
          progress: o.progress,
          period: o.period,
          rewardXp: o.reward_xp,
          rewardTokens: o.reward_tokens,
          claimed: o.claimed,
        }))
        .sort(sortBy((r: any) => r.id)),
      // NEWLY unlocked only. `resolveDay` returns the inserts it made, not the table; a scenario
      // that pre-seeds an achievement (to prove the day does not unlock it twice) would otherwise
      // record that pre-seeded row as if the day had produced it.
      achievements: afterAchievements
        .filter(
          (a: any) => !beforeAchievements.some((b: any) => b.id === a.id),
        )
        .map((a: any) => ({
          id: a.id,
          playerId: a.player_id,
          achId: a.ach_id,
          name: a.name,
          description: a.description,
          unlockedAt: a.unlocked_at,
        }))
        .sort(sortBy((r: any) => r.id)),
      /** `id` is deliberately dropped — the ancestor's was a uuid. */
      events: afterEvents
        .map((e: any) => ({
          day: e.day,
          type: e.type,
          title: e.title,
          description: e.description,
          severity: e.severity,
        }))
        .sort(sortBy((r: any) => r.day, (r: any) => r.type)),
      /** `id` and `created_at` dropped, same reason. Sorted into a stable total order. */
      reports: afterReports
        .map((r: any) => ({
          day: r.day,
          kind: r.kind,
          isPublic: r.is_public,
          message: r.message,
          actorHandle: r.actor_handle,
          targetHandle: r.target_handle,
          viewerPlayerId: r.viewer_player_id,
        }))
        .sort(sortBy((r: any) => r.kind, (r: any) => r.message, (r: any) => r.viewerPlayerId)),
    },
  });

  process.stdout.write(`recorded ${s.name}\n`);
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'fixtures', 'ancestor-corpus.json');
writeFileSync(out, `${JSON.stringify(recorded, null, 2)}\n`);
process.stdout.write(`wrote ${recorded.length} scenarios to ${out}\n`);

/* ------------------------------------------------------------------------ maps
 *
 * `resolveDay` never draws from `seededRng` — its only randomness is the FNV-1a hash behind the
 * event schedule and the LCG behind the objective shuffle. So the day corpus above, however
 * thorough, cannot detect a mulberry32 that has drifted. Mutating `0x6d2b79f5` by one left all 21
 * day-resolution assertions green, which is exactly the sort of thing a corpus is supposed to
 * catch and this one could not.
 *
 * The map is where mulberry32 lives. Two streams, `${seed}:terrain` and `${seed}:ruins`, over a
 * grid — a single drifted draw moves a terrain patch or a ruin and shows up immediately.
 */

const MAP_SEEDS: [string, number, number][] = [
  ['w-quiet-0001', 16, 16],
  ['w-scav-0002', 20, 20],
  ['w-final-0010', 16, 16],
  ['map-seed-alpha', 12, 12],
  ['map-seed-beta', 24, 24],
  ['map-seed-gamma', 64, 64],
  ['map-seed-delta', 13, 31],
];

const maps = MAP_SEEDS.map(([seed, width, height]) => {
  const { map } = generateMap(width, height, seed);
  return {
    seed,
    width,
    height,
    // The whole grid as one row-major string, one character per terrain. A single moved tile
    // changes a character, and the fixture stays readable.
    terrain: map.tiles
      .map((t: any) => ({ w: '.', forest: 'f', water: '~', road: '=', ruins: 'R', homestead: 'H' } as any)[t.terrain === 'wilderness' ? 'w' : t.terrain] ?? '?')
      .join(''),
    ruins: map.tiles
      .filter((t: any) => t.terrain === 'ruins')
      .map((t: any) => ({ x: t.x, y: t.y, name: t.ruinName })),
  };
});

const mapsOut = join(here, '..', 'src', 'fixtures', 'ancestor-maps.json');
writeFileSync(
  mapsOut,
  `${JSON.stringify({ maps, ruinStock: Array.from({ length: 10 }, (_, i) => ruinStock(i)) }, null, 2)}\n`,
);
process.stdout.write(`wrote ${maps.length} maps to ${mapsOut}\n`);

/* ------------------------------------------------------------------------ bot planning
 *
 * `chooseActions`, `pickRaidTarget` and `acceptStandingOffers` are module-private in the ancestor;
 * only `enqueueBotActions` is exported, and it writes to the database. So the recording is made
 * through that door: seed a world, call it, read `queued_actions` back. That is a stronger
 * recording than calling the private functions would have been — it captures the ordering of the
 * whole pass, including a trader bot accepting a human's standing offer.
 */

const { enqueueBotActions } = (await import(`${ANCESTOR}/engine/bots.js`)) as any;

interface BotScenario {
  name: string;
  worldId: string;
  day: number;
  width: number;
  height: number;
  players: PlayerSpec[];
  pending: { playerId: string; seq: number; action: unknown }[];
}

const BOT_SCENARIOS: BotScenario[] = [
  {
    name: 'one-of-each-personality',
    worldId: 'w-botplan-0001',
    day: 7,
    width: 20,
    height: 20,
    players: [
      P('b-farmer', 'bot-farmer-1', 3, 3, 1_000, { isBot: true, personality: 'farmer' }),
      P('b-hermit', 'bot-hermit-2', 6, 6, 2_000, { isBot: true, personality: 'hermit', hp: 55 }),
      P('b-trader', 'bot-trader-3', 9, 9, 3_000, { isBot: true, personality: 'trader', resources: { food: 20, water: 20, materials: 10 } }),
      P('b-raider', 'bot-raider-4', 12, 12, 4_000, { isBot: true, personality: 'raider' }),
      P('b-nomad', 'bot-nomad-5', 15, 15, 5_000, { isBot: true, personality: 'nomad' }),
      P('h-1', 'human-one', 2, 18, 6_000, { joinedDay: 0, reputation: 30, resources: { food: 20, water: 20, materials: 10 } }),
      P('h-2', 'human-two', 18, 2, 7_000, { joinedDay: 0, reputation: 5, defense: 1 }),
    ],
    pending: [],
  },
  {
    name: 'a-trader-bot-accepts-a-human-offer',
    worldId: 'w-botplan-0002',
    day: 9,
    width: 20,
    height: 20,
    players: [
      P('b-trader', 'bot-trader-1', 4, 4, 1_000, { isBot: true, personality: 'trader', resources: { food: 20, water: 20, materials: 10 } }),
      P('b-farmer', 'bot-farmer-2', 8, 8, 2_000, { isBot: true, personality: 'farmer' }),
      P('h-rich', 'trader-human', 12, 12, 3_000, { joinedDay: 0, resources: { food: 30, water: 30, materials: 30, fuel: 5 } }),
    ],
    pending: [
      // A fair deal the bot can pay for and stays above its reserve on — it should be taken.
      { playerId: 'h-rich', seq: 0, action: { type: 'trade', targetPlayerId: 'b-trader', offer: { materials: 4 }, request: { food: 3 } } },
      // Robbery dressed as a trade: the bot must refuse it on the reserve rule.
      { playerId: 'h-rich', seq: 1, action: { type: 'trade', targetPlayerId: 'b-trader', offer: { seeds: 1 }, request: { food: 19, water: 19 } } },
      // Exactly on the reserve boundary. The bot holds 20 food; this leaves it 3, and the rule is
      // `>= 4`. With no offer at the boundary, changing RESERVE from 4 to 3 changed no plan in the
      // whole corpus — the refusals were all refused several times over.
      { playerId: 'h-rich', seq: 2, action: { type: 'trade', targetPlayerId: 'b-trader', offer: { materials: 20 }, request: { food: 17 } } },
    ],
  },
  {
    name: 'raiders-spread-across-eligible-prey',
    worldId: 'w-botplan-0003',
    day: 12,
    width: 24,
    height: 24,
    players: [
      P('b-r1', 'bot-raider-1', 2, 2, 1_000, { isBot: true, personality: 'raider' }),
      P('b-r2', 'bot-raider-2', 12, 2, 2_000, { isBot: true, personality: 'raider' }),
      P('b-r3', 'bot-raider-3', 2, 12, 3_000, { isBot: true, personality: 'raider' }),
      P('b-r4', 'bot-raider-4', 20, 20, 4_000, { isBot: true, personality: 'raider' }),
      P('h-a', 'prey-a', 6, 6, 5_000, { joinedDay: 0, defense: 0 }),
      P('h-b', 'prey-b', 16, 6, 6_000, { joinedDay: 0, defense: 4 }),
      P('h-c', 'prey-c', 6, 16, 7_000, { joinedDay: 0, defense: 9 }),
      // A fortress. `soft = 1 / (1 + 400)` is negligible, so this target is reachable ONLY through
      // the `+ 0.05` floor — which is what the floor is for, and what nothing else in the corpus
      // could distinguish from its absence.
      P('h-fort', 'prey-fortress', 22, 22, 9_000, { joinedDay: 0, defense: 400 }),
      // Spawn-protected: `pickRaidTarget` must never select this one.
      P('h-new', 'prey-new', 10, 10, 8_000, { joinedDay: 12, defense: 0 }),
    ],
    pending: [],
  },
];

const botRecords: unknown[] = [];

for (const s of BOT_SCENARIOS) {
  await truncateAll();
  await db.insert(schema.worlds).values({
    id: s.worldId,
    name: s.name,
    status: 'active',
    day: s.day,
    seasonLength: 90,
    width: s.width,
    height: s.height,
    tickIntervalMinutes: 1440,
    botsEnabled: true,
    botCount: s.players.filter((p) => p.isBot).length,
    nextTickAt: new Date(0),
    createdAt: new Date(0),
  });

  const { map } = generateMap(s.width, s.height, s.worldId);
  let ri = 0;
  const rows = map.tiles.map((t: any) => {
    const isRuin = t.terrain === 'ruins';
    const row = {
      id: `${s.worldId}:tile:${t.x},${t.y}`,
      worldId: s.worldId,
      x: t.x,
      y: t.y,
      terrain: t.terrain,
      ruinName: t.ruinName ?? null,
      ruinStock: isRuin ? ruinStock(ri) : null,
      ownerId: null,
    };
    if (isRuin) ri++;
    return row;
  });
  for (let i = 0; i < rows.length; i += 500) await db.insert(schema.tiles).values(rows.slice(i, i + 500));

  for (const p of s.players) {
    await db.insert(schema.players).values({
      id: p.id,
      worldId: s.worldId,
      userId: p.isBot ? null : `user-${p.id}`,
      handle: p.handle,
      isBot: p.isBot ?? false,
      personality: p.personality ?? null,
      homesteadX: p.x,
      homesteadY: p.y,
      resources: bag(p.resources ?? startingBag()),
      hp: p.hp ?? 100,
      morale: p.morale ?? 100,
      defense: p.defense ?? 0,
      reputation: p.reputation ?? 0,
      alive: p.alive ?? true,
      apPerDay: 6,
      communeId: null,
      cosmeticStyle: null,
      joinedDay: p.joinedDay ?? 0,
      createdAt: new Date(p.createdAt),
    });
  }
  for (const a of s.pending) {
    await db.insert(schema.queuedActions).values({
      id: `${s.worldId}:qa:${a.seq}`,
      worldId: s.worldId,
      playerId: a.playerId,
      seq: a.seq,
      action: a.action,
    });
  }

  const [worldRow] = await sql`select * from worlds where id = ${s.worldId}`;
  await enqueueBotActions({
    ...worldRow,
    seasonLength: worldRow.season_length,
    tickIntervalMinutes: worldRow.tick_interval_minutes,
  });

  const after = await sql`
    select player_id, seq, action from queued_actions
     where world_id = ${s.worldId} order by player_id, seq`;

  botRecords.push({
    name: s.name,
    input: {
      seed: s.worldId,
      /** The day the plan is judged against — `world.day + 1`, as `chooseActions` computes it. */
      day: s.day + 1,
      players: s.players.map((p) => ({
        id: p.id,
        handle: p.handle,
        isBot: p.isBot ?? false,
        personality: p.personality ?? null,
        homesteadX: p.x,
        homesteadY: p.y,
        resources: bag(p.resources ?? startingBag()),
        hp: p.hp ?? 100,
        reputation: p.reputation ?? 0,
        defense: p.defense ?? 0,
        alive: p.alive ?? true,
        apPerDay: 6,
        joinedDay: p.joinedDay ?? 0,
      })),
      ruins: map.tiles
        .filter((t: any) => t.terrain === 'ruins')
        .map((t: any) => ({ x: t.x, y: t.y })),
      pending: s.pending.map((a) => ({ playerId: a.playerId, seq: a.seq, action: a.action })),
    },
    expected: after.map((r: any) => ({ playerId: r.player_id, seq: r.seq, action: r.action })),
  });
  process.stdout.write(`recorded bot plan ${s.name}\n`);
}

const botsOut = join(here, '..', 'src', 'fixtures', 'ancestor-bots.json');
writeFileSync(botsOut, `${JSON.stringify(botRecords, null, 2)}\n`);
process.stdout.write(`wrote ${botRecords.length} bot plans to ${botsOut}\n`);

await sql.end();
