/**
 * Worlds: creation, settlement, the action queue, and the day resolution's persistence.
 *
 * This is the half of the ancestor's `engine/resolve.ts` that talks to Postgres. The other half —
 * the simulation — is `engine/resolve.ts` here and is pure. Splitting them is what lets the game
 * be replayed; keeping the writes together in one transaction is what lets it be trusted.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * TWO WORKERS MUST NEVER RESOLVE ONE DAY TWICE.
 *
 * 04-domain-model §10.5 names this exactly: `world.tick`, keyed on `world_id`, prevents "double XP
 * and double days-survived". The ancestor's only guard was a module-local `Set<string>` of
 * in-flight world ids (`engine/tick.ts:11`) — a variable which is, by construction, invisible to a
 * second process. With one replica it was correct. With two it was a data-loss bug waiting for a
 * scale-up.
 *
 * There are TWO defences here and they are independent on purpose:
 *
 *   1. The lease. `world.tick` is a leased job keyed on the world id, claimed
 *      `for update skip locked` by `@cloudsforge/jobs`. Two runners cannot hold one key.
 *   2. The conditional advance. `persistDay` opens by taking `select ... from worlds where id = ?
 *      for update` and refuses unless the row still reads `status = 'active'` and
 *      `day = <the day the simulation was computed from>`. A second writer therefore blocks until
 *      the first commits, re-reads a day that has moved, and returns `null` having written nothing.
 *
 * The second is what `jobs.test.ts` proves, because it is the one that holds when the FIRST fails
 * — a lease expired under a slow resolution, a manual re-run, an operator forcing a tick while the
 * scheduler is mid-flight. A defence that is only ever tested through the thing it backs up is not
 * a defence.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */

import { randomUUID } from 'node:crypto';
import {
  WORLD_BOUNDS,
  WORLD_DEFAULTS,
  BOT_PERSONALITIES,
  MAX_QUEUED_ACTIONS,
  emptyBag,
  startingBag,
  survivalScore,
  type BotPersonality,
  type QueuedAction,
  type ResourceBag,
  type Terrain,
  type WorldStatus,
} from './rules.ts';
import { generateMap, ruinStock } from './engine/mapgen.ts';
import { claimFirstFree, homesteadCandidates } from './engine/homestead.ts';
import { planBotDay, type BotView } from './engine/bots.ts';
import { resolveDay, type DayResult } from './engine/resolve.ts';
import {
  applyProgressDelta,
  defaultProgressWork,
  grantXp,
  refreshXpToNext,
  touchStreak,
  validateUnlock,
  type ProgressWork,
} from './engine/progression.ts';
import { tradeTermsProblem } from './engine/trade.ts';
import type { Db, Emit, Tx } from './outbox.ts';
import type {
  PlayerSnapshot,
  ProgressSnapshot,
  QueuedActionRow,
  RuinSnapshot,
  WorldSnapshot,
} from './engine/state.ts';

export type WithOutbox = <T>(
  sql: Db,
  producer: string,
  fn: (tx: Tx, emit: Emit) => Promise<T>,
) => Promise<T>;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** The map is full. Distinct because it is an operator's problem, not the player's. */
export class NoFreeHomesteadError extends Error {
  constructor(worldId: string) {
    super(`world ${worldId} has no free tile for a homestead`);
    this.name = 'NoFreeHomesteadError';
  }
}

/* ------------------------------------------------------------------------------ row shapes */

interface WorldRow {
  readonly id: string;
  readonly name: string;
  readonly status: WorldStatus;
  readonly day: number;
  readonly season_length: number;
  readonly width: number;
  readonly height: number;
  readonly tick_interval_minutes: number;
  readonly seed: string;
  readonly bots_enabled: boolean;
  readonly bot_count: number;
  readonly next_tick_at: Date | null;
}

interface PlayerRow {
  readonly id: string;
  readonly world_id: string;
  readonly user_id: string | null;
  readonly handle: string;
  readonly is_bot: boolean;
  readonly personality: BotPersonality | null;
  readonly homestead_x: number;
  readonly homestead_y: number;
  readonly resources: ResourceBag;
  readonly hp: number;
  readonly morale: number;
  readonly defense: number;
  readonly reputation: number;
  readonly alive: boolean;
  readonly ap_per_day: number;
  readonly commune_id: string | null;
  readonly cosmetic_style: string | null;
  readonly joined_day: number;
  readonly created_at: Date;
}

interface ProgressRow {
  readonly player_id: string;
  readonly world_id: string;
  readonly level: number;
  readonly xp: number;
  readonly skill_points: number;
  readonly perks: string[];
  readonly tokens: number;
  readonly streak: number;
  readonly last_seen_day: number;
  readonly days_survived: number;
  readonly contribution: number;
}

const WORLD_COLUMNS = `id, name, status, day, season_length, width, height,
  tick_interval_minutes, seed, bots_enabled, bot_count, next_tick_at`;

const toSnapshot = (w: WorldRow): WorldSnapshot => ({
  id: w.id,
  name: w.name,
  seed: w.seed,
  status: w.status,
  day: w.day,
  seasonLength: w.season_length,
  width: w.width,
  height: w.height,
  tickIntervalMinutes: w.tick_interval_minutes,
});

const toProgressWork = (r: ProgressRow): ProgressWork =>
  refreshXpToNext({
    playerId: r.player_id,
    worldId: r.world_id,
    level: r.level,
    xp: r.xp,
    xpToNext: 0,
    skillPoints: r.skill_points,
    perks: [...r.perks],
    tokens: r.tokens,
    streak: r.streak,
    lastSeenDay: r.last_seen_day,
    daysSurvived: r.days_survived,
    contribution: r.contribution,
  });

/* ------------------------------------------------------------------------------ creation */

export interface CreateWorldInput {
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
  readonly seasonLength?: number;
  readonly tickIntervalMinutes?: number;
  /** Defaults to the generated id, which is what the ancestor always used. */
  readonly seed?: string;
  readonly correlationId?: string;
}

function validateCreate(input: CreateWorldInput): Required<Omit<CreateWorldInput, 'correlationId' | 'seed'>> & { seed?: string } {
  const B = WORLD_BOUNDS;
  const name = input.name.trim();
  if (name.length < B.nameMin || name.length > B.nameMax) {
    throw new ValidationError(`name must be between ${B.nameMin} and ${B.nameMax} characters`);
  }
  const width = input.width ?? WORLD_DEFAULTS.width;
  const height = input.height ?? WORLD_DEFAULTS.height;
  const seasonLength = input.seasonLength ?? WORLD_DEFAULTS.seasonLength;
  const tickIntervalMinutes = input.tickIntervalMinutes ?? WORLD_DEFAULTS.tickIntervalMinutes;
  const bounded = (v: number, min: number, max: number, what: string): number => {
    if (!Number.isInteger(v) || v < min || v > max) {
      throw new ValidationError(`${what} must be a whole number between ${min} and ${max}`);
    }
    return v;
  };
  bounded(width, B.widthMin, B.widthMax, 'width');
  bounded(height, B.heightMin, B.heightMax, 'height');
  bounded(seasonLength, B.seasonLengthMin, B.seasonLengthMax, 'seasonLength');
  bounded(tickIntervalMinutes, B.tickIntervalMin, B.tickIntervalMax, 'tickIntervalMinutes');
  return {
    name,
    width,
    height,
    seasonLength,
    tickIntervalMinutes,
    ...(input.seed ? { seed: input.seed } : {}),
  };
}

/**
 * The region's finite pool at the start of a season, scaled by map area.
 *
 * Food, water and materials stay at zero — players produce and hold those. Fuel, medicine and
 * seeds are the scarce things the world itself holds, and every one of them has a consumer in
 * `resolveDay`.
 */
function initialWorldStock(width: number, height: number): ResourceBag {
  const scale = Math.max(1, Math.floor((width * height) / 100));
  return {
    food: 0,
    water: 0,
    materials: 0,
    fuel: 80 * scale,
    medicine: 50 * scale,
    seeds: 120 * scale,
  };
}

export async function createWorld(
  sql: Db,
  producer: string,
  input: CreateWorldInput,
  withOutbox: WithOutbox,
): Promise<WorldSnapshot> {
  const v = validateCreate(input);
  const id = randomUUID();
  const seed = v.seed ?? id;
  const map = generateMap(v.width, v.height, seed);

  return withOutbox(sql, producer, async (tx, emit) => {
    await tx`
      insert into worlds (id, name, status, day, season_length, width, height,
                          tick_interval_minutes, seed, bots_enabled, bot_count, next_tick_at)
      values (${id}, ${v.name}, 'lobby', 0, ${v.seasonLength}, ${v.width}, ${v.height},
              ${v.tickIntervalMinutes}, ${seed}, false, 0, null)
    `;

    let ruinIndex = 0;
    const rows = map.tiles.map((t) => {
      const isRuin = t.terrain === 'ruins';
      const row = {
        id: `${id}:${t.x},${t.y}`,
        world_id: id,
        x: t.x,
        y: t.y,
        terrain: t.terrain,
        ruin_name: t.ruinName ?? null,
        ruin_stock: isRuin ? ruinStock(ruinIndex) : null,
        owner_id: null,
      };
      if (isRuin) ruinIndex++;
      return row;
    });
    // Chunked to keep the bind-parameter count well inside Postgres' 65,535 ceiling: a 64×64 map
    // is 4,096 rows × 8 columns, which one statement would not survive.
    for (let i = 0; i < rows.length; i += 400) {
      await tx`insert into tiles ${tx(rows.slice(i, i + 400))}`;
    }

    await tx`
      insert into world_stock (world_id, stock)
      values (${id}, ${tx.json(initialWorldStock(v.width, v.height) as unknown as Record<string, never>)})
    `;

    emit({
      topic: 'nda.world.created',
      key: id,
      payload: { worldId: id, name: v.name, seed, seasonLength: v.seasonLength },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });

    const [row] = await tx<WorldRow[]>`select ${tx.unsafe(WORLD_COLUMNS)} from worlds where id = ${id}`;
    if (!row) throw new Error('world vanished inside its own creating transaction');
    return toSnapshot(row);
  });
}

/** Lobby → active, and schedule the first tick. Idempotent only in the sense that it refuses. */
export async function startWorld(
  sql: Db,
  producer: string,
  worldId: string,
  now: Date,
  withOutbox: WithOutbox,
): Promise<WorldSnapshot> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const [w] = await tx<WorldRow[]>`
      select ${tx.unsafe(WORLD_COLUMNS)} from worlds where id = ${worldId} for update`;
    if (!w) throw new NotFoundError(`no world ${worldId}`);
    if (w.status !== 'lobby') throw new ConflictError(`world is already ${w.status}`);

    const nextTickAt = new Date(now.getTime() + w.tick_interval_minutes * 60_000);
    await tx`
      update worlds set status = 'active', next_tick_at = ${nextTickAt} where id = ${worldId}`;
    emit({ topic: 'nda.world.started', key: worldId, payload: { worldId, day: w.day } });
    return toSnapshot({ ...w, status: 'active', next_tick_at: nextTickAt });
  });
}

export async function findWorld(sql: Db, worldId: string): Promise<WorldSnapshot | null> {
  const [row] = await sql<WorldRow[]>`
    select ${sql.unsafe(WORLD_COLUMNS)} from worlds where id = ${worldId}`;
  return row ? toSnapshot(row) : null;
}

export async function listWorlds(
  sql: Db,
  statuses: readonly WorldStatus[],
): Promise<WorldSnapshot[]> {
  const rows = await sql<WorldRow[]>`
    select ${sql.unsafe(WORLD_COLUMNS)} from worlds
     where status = any(${sql.array([...statuses])}) order by created_at`;
  return rows.map(toSnapshot);
}

/* ------------------------------------------------------------------------------ settlement */

export interface JoinInput {
  readonly worldId: string;
  readonly userId: string;
  readonly handle: string;
  readonly cosmeticStyle?: string | null;
  readonly correlationId?: string;
}

/**
 * Settle a survivor. Idempotent: joining twice returns the survivor you already have.
 *
 * The tile claim happens BEFORE the player insert and inside the same transaction, so the two roll
 * back together. Without that, the loser of the `(world_id, user_id)` race leaves a tile
 * permanently marked `homestead` and owned by a player that was never created — and the release
 * path matches on `owner_id`, so nothing ever gives it back.
 */
export async function joinWorld(
  sql: Db,
  producer: string,
  input: JoinInput,
  withOutbox: WithOutbox,
): Promise<{ player: PlayerRow; created: boolean }> {
  const existing = await playerOf(sql, input.worldId, input.userId);
  if (existing) return { player: existing, created: false };

  const [w] = await sql<WorldRow[]>`
    select ${sql.unsafe(WORLD_COLUMNS)} from worlds where id = ${input.worldId}`;
  if (!w) throw new NotFoundError(`no world ${input.worldId}`);
  if (w.status === 'archived') throw new ConflictError('world is archived');

  const id = randomUUID();
  const created = await withOutbox(sql, producer, async (tx, emit) => {
    const home = await claimHomestead(tx, input.worldId, id);
    const [row] = await tx<PlayerRow[]>`
      insert into players (id, world_id, user_id, handle, is_bot, personality,
                           homestead_x, homestead_y, resources, hp, morale, defense, reputation,
                           alive, ap_per_day, commune_id, cosmetic_style, joined_day)
      values (${id}, ${input.worldId}, ${input.userId}, ${input.handle}, false, null,
              ${home.x}, ${home.y},
              ${tx.json(startingBag() as unknown as Record<string, never>)},
              100, 100, 0, 0, true, ${WORLD_DEFAULTS.apPerDay}, null,
              ${input.cosmeticStyle ?? null}, ${w.day})
      -- No conflict target: the arbiter is the partial unique index players_world_user_uniq, and
      -- the id is a fresh uuid, so the only conflict this can absorb is the one it is here for.
      on conflict do nothing
      returning *
    `;
    if (!row) return null; // lost the (world_id, user_id) race
    await tx`
      insert into player_progress (player_id, world_id) values (${id}, ${input.worldId})
      on conflict (player_id) do nothing`;
    emit({
      topic: 'nda.player.settled',
      key: id,
      payload: { worldId: input.worldId, playerId: id, userId: input.userId, day: w.day },
      actor: `user:${input.userId}`,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return row;
  });

  if (created) return { player: created, created: true };

  // Postgres held our insert until the winning transaction ended, so by the time DO NOTHING
  // reported a conflict the other survivor is committed and readable. Answering with it is what
  // makes joining twice idempotent; which request lost is not the caller's business.
  const settled = await playerOf(sql, input.worldId, input.userId);
  if (!settled) throw new ConflictError('join is already in progress; retry');
  return { player: settled, created: false };
}

async function claimHomestead(tx: Tx, worldId: string, ownerId: string): Promise<{ x: number; y: number }> {
  const free = await tx<{ id: string; x: number; y: number; terrain: Terrain }[]>`
    select id, x, y, terrain from tiles where world_id = ${worldId} and owner_id is null`;
  const claimed = await claimFirstFree(homesteadCandidates(free), async (candidate) => {
    const rows = await tx<{ id: string }[]>`
      update tiles set terrain = 'homestead', owner_id = ${ownerId}
       where id = ${candidate.id} and owner_id is null
      returning id`;
    return rows.length > 0;
  });
  if (!claimed) throw new NoFreeHomesteadError(worldId);
  return { x: claimed.x, y: claimed.y };
}

export async function playerOf(
  sql: Db,
  worldId: string,
  userId: string,
): Promise<PlayerRow | undefined> {
  const [row] = await sql<PlayerRow[]>`
    select * from players where world_id = ${worldId} and user_id = ${userId}`;
  return row;
}

export async function playerById(sql: Db, playerId: string): Promise<PlayerRow | undefined> {
  const [row] = await sql<PlayerRow[]>`select * from players where id = ${playerId}`;
  return row;
}

/* ------------------------------------------------------------------------------ the queue */

/**
 * Replace a survivor's queue for the coming day.
 *
 * Trade terms are re-checked here as well as in the tick, because refusing at the route is what
 * TELLS the player. The tick's refusal is silent and costs them a day and an action point.
 */
export async function queueActions(
  sql: Db,
  producer: string,
  input: { worldId: string; userId: string; actions: readonly QueuedAction[]; correlationId?: string },
  withOutbox: WithOutbox,
): Promise<readonly QueuedAction[]> {
  const me = await playerOf(sql, input.worldId, input.userId);
  if (!me) throw new NotFoundError('you have not settled in this world');
  if (!me.alive) throw new ConflictError('you are dead');
  if (input.actions.length > MAX_QUEUED_ACTIONS || input.actions.length > me.ap_per_day) {
    throw new ValidationError(`too many actions (max ${Math.min(MAX_QUEUED_ACTIONS, me.ap_per_day)} AP)`);
  }
  for (const action of input.actions) {
    if (action.type !== 'trade') continue;
    const problem = tradeTermsProblem(action);
    if (problem) throw new ValidationError(problem);
  }

  return withOutbox(sql, producer, async (tx, emit) => {
    await tx`delete from queued_actions where player_id = ${me.id}`;
    if (input.actions.length > 0) {
      const rows = input.actions.map((action, seq) => ({
        id: `${me.id}:${seq}`,
        world_id: me.world_id,
        player_id: me.id,
        seq,
        action: JSON.stringify(action),
      }));
      await tx`insert into queued_actions ${tx(rows)}`;
    }
    emit({
      topic: 'nda.actions.queued',
      key: me.id,
      payload: { worldId: me.world_id, playerId: me.id, count: input.actions.length },
      actor: `user:${input.userId}`,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return input.actions;
  });
}

export async function queuedActionsOf(sql: Db, playerId: string): Promise<QueuedAction[]> {
  const rows = await sql<{ action: QueuedAction }[]>`
    select action from queued_actions where player_id = ${playerId} order by seq`;
  return rows.map((r) => r.action);
}

/* ------------------------------------------------------------------------------ bots */

/** Bring a world's bot roster in line with {enabled, count}. */
export async function syncBots(
  sql: Db,
  producer: string,
  worldId: string,
  enabled: boolean,
  count: number,
  withOutbox: WithOutbox,
): Promise<{ bots: number }> {
  if (!Number.isInteger(count) || count < 0 || count > WORLD_BOUNDS.botCountMax) {
    throw new ValidationError(`count must be a whole number between 0 and ${WORLD_BOUNDS.botCountMax}`);
  }
  const target = enabled ? count : 0;

  return withOutbox(sql, producer, async (tx, emit) => {
    const [w] = await tx<WorldRow[]>`
      select ${tx.unsafe(WORLD_COLUMNS)} from worlds where id = ${worldId} for update`;
    if (!w) throw new NotFoundError(`no world ${worldId}`);

    const existing = await tx<PlayerRow[]>`
      select * from players where world_id = ${worldId} and is_bot = true order by created_at, id`;

    if (existing.length < target) {
      for (let i = existing.length; i < target; i++) {
        const personality = BOT_PERSONALITIES[i % BOT_PERSONALITIES.length] ?? 'farmer';
        const id = randomUUID();
        const home = await claimHomestead(tx, worldId, id);
        await tx`
          insert into players (id, world_id, user_id, handle, is_bot, personality,
                               homestead_x, homestead_y, resources, hp, morale, defense,
                               reputation, alive, ap_per_day, commune_id, cosmetic_style, joined_day)
          values (${id}, ${worldId}, null, ${`bot-${personality}-${i + 1}`}, true, ${personality},
                  ${home.x}, ${home.y},
                  ${tx.json(startingBag() as unknown as Record<string, never>)},
                  100, 100, 0, 0, true, ${WORLD_DEFAULTS.apPerDay}, null, null, ${w.day})
        `;
      }
    } else if (existing.length > target) {
      // Remove the most recently added bots first, and give their tiles back to the map.
      const doomed = existing.slice(target).map((b) => b.id);
      await tx`
        update tiles set terrain = 'wilderness', owner_id = null, ruin_name = null
         where world_id = ${worldId} and owner_id = any(${tx.array(doomed)})`;
      await tx`delete from players where id = any(${tx.array(doomed)})`;
    }

    await tx`
      update worlds set bots_enabled = ${enabled}, bot_count = ${target} where id = ${worldId}`;
    emit({ topic: 'nda.world.bots_synced', key: worldId, payload: { worldId, enabled, count: target } });
    return { bots: target };
  });
}

const toBotView = (p: PlayerRow): BotView & { defense: number } => ({
  id: p.id,
  handle: p.handle,
  isBot: p.is_bot,
  personality: p.personality,
  homesteadX: p.homestead_x,
  homesteadY: p.homestead_y,
  resources: p.resources,
  hp: p.hp,
  reputation: p.reputation,
  defense: p.defense,
  alive: p.alive,
  apPerDay: p.ap_per_day,
  joinedDay: p.joined_day,
});

/**
 * Plan and write this tick's actions for every alive bot.
 *
 * The pending queue is read BEFORE the bots' half of it is cleared. A trade moves goods only when
 * both sides queued it, so the offers players have aimed at bots have to be visible here — a bot
 * that never looks at its post can never agree to anything, and every human trade with a bot would
 * expire unmatched.
 */
export async function enqueueBotActions(sql: Db, worldId: string): Promise<number> {
  const [w] = await sql<WorldRow[]>`
    select ${sql.unsafe(WORLD_COLUMNS)} from worlds where id = ${worldId}`;
  if (!w) throw new NotFoundError(`no world ${worldId}`);

  const everyone = await sql<PlayerRow[]>`select * from players where world_id = ${worldId}`;
  const bots = everyone
    .filter((p) => p.is_bot && p.alive)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(toBotView);
  if (bots.length === 0) return 0;

  const ruins = await sql<{ x: number; y: number }[]>`
    select x, y from tiles where world_id = ${worldId} and terrain = 'ruins' order by y, x`;
  const pending = await sql<{ player_id: string; seq: number; action: QueuedAction }[]>`
    select player_id, seq, action from queued_actions where world_id = ${worldId} order by seq`;

  const plan = planBotDay(
    bots,
    everyone.map(toBotView),
    ruins,
    pending.map((r) => ({ playerId: r.player_id, seq: r.seq, action: r.action })),
    w.seed,
    w.day + 1,
  );

  const botIds = bots.map((b) => b.id);
  const rows = [...plan.entries()].flatMap(([playerId, actions]) =>
    actions.map((action, seq) => ({
      id: `${playerId}:${seq}`,
      world_id: worldId,
      player_id: playerId,
      seq,
      action: JSON.stringify(action),
    })),
  );

  await sql.begin(async (tx) => {
    await tx`delete from queued_actions where player_id = any(${tx.array(botIds)})`;
    if (rows.length > 0) await tx`insert into queued_actions ${tx(rows)}`;
  });
  return rows.length;
}

/* ------------------------------------------------------------------------------ the tick */

/** Worlds whose next tick is due. Ordered, so a backlog drains oldest-first. */
export async function dueWorldIds(sql: Db, now: Date, limit: number): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from worlds
     where status = 'active' and next_tick_at is not null and next_tick_at <= ${now}
     order by next_tick_at limit ${limit}`;
  return rows.map((r) => r.id);
}

export interface DayOutcome {
  readonly worldId: string;
  readonly day: number;
  readonly archived: boolean;
  readonly aliveCount: number;
  readonly raids: number;
  readonly trades: number;
  readonly deaths: number;
  readonly reports: number;
  readonly achievementsUnlocked: number;
}

/** Read everything one day of simulation needs, in the order the engine's snapshot expects it. */
async function loadSnapshot(sql: Db, w: WorldRow): Promise<{
  players: PlayerSnapshot[];
  queue: QueuedActionRow[];
  ruins: RuinSnapshot[];
  stock: ResourceBag;
  progress: ProgressSnapshot[];
  objectives: { id: string; playerId: string; progress: number; claimed: boolean }[];
  achievements: { playerId: string; achId: string }[];
}> {
  const players = await sql<PlayerRow[]>`
    select * from players where world_id = ${w.id} order by created_at, id`;
  const queue = await sql<{ player_id: string; seq: number; action: QueuedAction }[]>`
    select player_id, seq, action from queued_actions where world_id = ${w.id} order by seq`;
  const ruins = await sql<{ x: number; y: number; ruin_name: string | null; ruin_stock: ResourceBag | null }[]>`
    select x, y, ruin_name, ruin_stock from tiles
     where world_id = ${w.id} and terrain = 'ruins' order by y, x`;
  const [stockRow] = await sql<{ stock: ResourceBag }[]>`
    select stock from world_stock where world_id = ${w.id}`;
  const progress = await sql<ProgressRow[]>`
    select * from player_progress where world_id = ${w.id} order by player_id`;
  const objectives = await sql<{ id: string; player_id: string; progress: number; claimed: boolean }[]>`
    select id, player_id, progress, claimed from objectives where world_id = ${w.id}`;
  const achievements = await sql<{ player_id: string; ach_id: string }[]>`
    select player_id, ach_id from achievements where world_id = ${w.id}`;

  return {
    players: players.map((p) => ({
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
      createdAt: p.created_at.getTime(),
    })),
    queue: queue.map((r) => ({ playerId: r.player_id, seq: r.seq, action: r.action })),
    ruins: ruins.map((r) => ({
      x: r.x,
      y: r.y,
      name: r.ruin_name ?? 'ruins',
      stock: r.ruin_stock ?? emptyBag(),
    })),
    stock: stockRow?.stock ?? emptyBag(),
    progress: progress.map((g) => ({
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
    objectives: objectives.map((o) => ({
      id: o.id,
      playerId: o.player_id,
      progress: o.progress,
      claimed: o.claimed,
    })),
    achievements: achievements.map((a) => ({ playerId: a.player_id, achId: a.ach_id })),
  };
}

/**
 * Resolve exactly one day for one world.
 *
 * Returns `null` when there was nothing to do — the world is not active, or another writer got
 * there first. `null` is a success: it is what the second of two racing workers is supposed to see.
 */
export async function resolveWorldDay(
  sql: Db,
  producer: string,
  worldId: string,
  now: Date,
  withOutbox: WithOutbox,
): Promise<DayOutcome | null> {
  const [w] = await sql<WorldRow[]>`
    select ${sql.unsafe(WORLD_COLUMNS)} from worlds where id = ${worldId}`;
  if (!w || w.status !== 'active') return null;

  const snapshot = await loadSnapshot(sql, w);
  const result = resolveDay({ world: toSnapshot(w), ...snapshot });

  return persistDay(sql, producer, w, result, now, withOutbox);
}

/**
 * Write one resolved day, or write nothing.
 *
 * The `for update` on the world row plus the `day` re-check is the second of the two defences
 * described at the top of this file. It is deliberately independent of the job lease: a lease that
 * expired under a slow resolution, an operator forcing a tick while the scheduler is mid-flight, or
 * a redelivered job all arrive here, and all of them find a day that has moved and write nothing.
 */
async function persistDay(
  sql: Db,
  producer: string,
  w: WorldRow,
  result: DayResult,
  now: Date,
  withOutbox: WithOutbox,
): Promise<DayOutcome | null> {
  const nextTickAt = result.archived
    ? null
    : new Date(now.getTime() + w.tick_interval_minutes * 60_000);

  return withOutbox(sql, producer, async (tx, emit) => {
    const [locked] = await tx<{ day: number; status: WorldStatus }[]>`
      select day, status from worlds where id = ${w.id} for update`;
    if (!locked || locked.status !== 'active' || locked.day !== w.day) {
      // Somebody else resolved this day while we were simulating it. Their write is committed and
      // ours would be a duplicate — double XP, double days-survived, a second set of reports.
      return null;
    }

    for (const p of result.players) {
      await tx`
        update players set resources = ${tx.json(p.resources as unknown as Record<string, never>)},
                           hp = ${p.hp}, morale = ${p.morale}, defense = ${p.defense},
                           reputation = ${p.reputation}, alive = ${p.alive}
         where id = ${p.id}`;
    }

    for (const r of result.ruins) {
      await tx`
        update tiles set ruin_stock = ${tx.json(r.stock as unknown as Record<string, never>)}
         where world_id = ${w.id} and x = ${r.x} and y = ${r.y}`;
    }

    await tx`
      update world_stock set stock = ${tx.json(result.stock as unknown as Record<string, never>)}
       where world_id = ${w.id}`;

    // Progress rows are advanced by DELTA against a row re-read under FOR UPDATE, never written
    // from the snapshot the day was simulated from. See `state.ts` ProgressDelta: the snapshot is
    // by now seconds or minutes old, and an objective claimed or a skill point spent in between is
    // real work that must not be undone by a stale write. The lock is also what makes those routes
    // wait for us instead of interleaving. `tokens` is never written here.
    for (const d of result.progressDeltas) {
      const [row] = await tx<ProgressRow[]>`
        select * from player_progress where player_id = ${d.playerId} for update`;
      const fresh = row ? toProgressWork(row) : defaultProgressWork(w.id, d.playerId);
      applyProgressDelta(fresh, d, result.day);
      await tx`
        insert into player_progress (player_id, world_id, level, xp, skill_points, perks, tokens,
                                     streak, last_seen_day, days_survived, contribution)
        values (${d.playerId}, ${w.id}, ${fresh.level}, ${fresh.xp}, ${fresh.skillPoints},
                ${tx.json(fresh.perks as unknown as Record<string, never>)}, ${fresh.tokens},
                ${fresh.streak}, ${fresh.lastSeenDay}, ${fresh.daysSurvived}, ${fresh.contribution})
        on conflict (player_id) do update set
          level = ${fresh.level}, xp = ${fresh.xp}, skill_points = ${fresh.skillPoints},
          perks = ${tx.json(fresh.perks as unknown as Record<string, never>)},
          streak = ${fresh.streak}, last_seen_day = ${fresh.lastSeenDay},
          days_survived = ${fresh.daysSurvived}, contribution = ${fresh.contribution}
          -- tokens is absent on purpose: the tick never awards them, and writing the column
          -- would revert a claim made while this day was being computed.
      `;
    }

    for (const o of result.objectives) {
      await tx`
        insert into objectives (id, world_id, player_id, bucket, kind, description, target,
                                progress, period, reward_xp, reward_tokens, claimed)
        values (${o.id}, ${o.worldId}, ${o.playerId}, ${o.bucket}, ${o.kind}, ${o.description},
                ${o.target}, ${o.progress}, ${o.period}, ${o.rewardXp}, ${o.rewardTokens},
                ${o.claimed})
        on conflict (id) do update set progress = ${o.progress}`;
    }

    if (result.achievements.length > 0) {
      await tx`
        insert into achievements ${tx(
          result.achievements.map((a) => ({
            id: a.id,
            world_id: a.worldId,
            player_id: a.playerId,
            ach_id: a.achId,
            name: a.name,
            description: a.description,
            points: a.points,
            unlocked_at: a.unlockedAt,
          })),
        )}
        on conflict (player_id, ach_id) do nothing`;
    }

    if (result.events.length > 0) {
      await tx`
        insert into world_events ${tx(
          result.events.map((e) => ({
            id: e.id,
            world_id: e.worldId,
            day: e.day,
            type: e.type,
            title: e.title,
            description: e.description,
            severity: e.severity,
          })),
        )}
        on conflict (id) do nothing`;
    }

    if (result.reports.length > 0) {
      // Chunked for the same bind-parameter reason as the tiles insert: a busy world's day can
      // produce hundreds of report rows.
      const rows = result.reports.map((r) => ({
        id: r.id,
        world_id: r.worldId,
        day: r.day,
        kind: r.kind,
        is_public: r.isPublic,
        message: r.message,
        actor_handle: r.actorHandle,
        target_handle: r.targetHandle,
        viewer_player_id: r.viewerPlayerId,
      }));
      for (let i = 0; i < rows.length; i += 300) {
        await tx`insert into reports ${tx(rows.slice(i, i + 300))} on conflict (id) do nothing`;
      }
    }

    await tx`delete from queued_actions where world_id = ${w.id}`;

    // The conditional advance. Belt to the lock's braces: even if the row lock were somehow not
    // held, this UPDATE moves the day only from the value we simulated from.
    const advanced = await tx<{ id: string }[]>`
      update worlds
         set day = ${result.day},
             status = ${result.archived ? 'archived' : 'active'},
             next_tick_at = ${nextTickAt}
       where id = ${w.id} and day = ${w.day} and status = 'active'
      returning id`;
    if (advanced.length === 0) return null;

    emit({
      topic: 'nda.world.day_resolved',
      key: w.id,
      payload: {
        worldId: w.id,
        day: result.day,
        archived: result.archived,
        aliveCount: result.stats.aliveCount,
        deaths: result.stats.deaths,
      },
    });
    if (result.archived) {
      emit({
        topic: 'nda.world.archived',
        key: w.id,
        payload: { worldId: w.id, finalDay: result.day, seasonLength: w.season_length },
      });
    }

    return {
      worldId: w.id,
      day: result.day,
      archived: result.archived,
      aliveCount: result.stats.aliveCount,
      raids: result.stats.raids,
      trades: result.stats.trades,
      deaths: result.stats.deaths,
      reports: result.reports.length,
      achievementsUnlocked: result.achievements.length,
    };
  });
}

/* ------------------------------------------------------------------------------ progression */

/** Load a survivor's progress, creating the default row if it is somehow absent. */
export async function ensureProgress(sql: Db, worldId: string, playerId: string): Promise<ProgressWork> {
  const [row] = await sql<ProgressRow[]>`
    select * from player_progress where player_id = ${playerId}`;
  if (row) return toProgressWork(row);
  await sql`
    insert into player_progress (player_id, world_id) values (${playerId}, ${worldId})
    on conflict (player_id) do nothing`;
  const [created] = await sql<ProgressRow[]>`
    select * from player_progress where player_id = ${playerId}`;
  return created ? toProgressWork(created) : defaultProgressWork(worldId, playerId);
}

/** Record a human "login" for the current in-game day, advancing the streak. */
export async function recordLogin(
  sql: Db,
  worldId: string,
  playerId: string,
  currentDay: number,
): Promise<ProgressWork> {
  const work = await ensureProgress(sql, worldId, playerId);
  if (touchStreak(work, currentDay)) {
    await sql`
      update player_progress set streak = ${work.streak}, last_seen_day = ${work.lastSeenDay}
       where player_id = ${playerId}`;
  }
  return work;
}

/**
 * Spend a skill point on a perk.
 *
 * Read, validate and spend under the row lock. Unlocked, this is a read-modify-write against a copy
 * that a tick or a second tab could have moved underneath it — spending one skill point twice, or
 * writing back a count from before the tick granted a level.
 */
export async function unlockPerk(
  sql: Db,
  producer: string,
  input: { worldId: string; playerId: string; perkId: string; correlationId?: string },
  withOutbox: WithOutbox,
): Promise<ProgressWork> {
  await ensureProgress(sql, input.worldId, input.playerId);
  return withOutbox(sql, producer, async (tx, emit) => {
    const [row] = await tx<ProgressRow[]>`
      select * from player_progress where player_id = ${input.playerId} for update`;
    if (!row) throw new NotFoundError('no progress to spend');
    const work = toProgressWork(row);
    const problem = validateUnlock(work, input.perkId);
    if (problem) throw new ConflictError(problem);

    work.perks = [...work.perks, input.perkId];
    work.skillPoints -= 1;
    await tx`
      update player_progress
         set perks = ${tx.json(work.perks as unknown as Record<string, never>)},
             skill_points = ${work.skillPoints}
       where player_id = ${input.playerId}`;
    emit({
      topic: 'nda.perk.unlocked',
      key: input.playerId,
      payload: { worldId: input.worldId, playerId: input.playerId, perkId: input.perkId },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return work;
  });
}

/**
 * Claim a completed objective's XP and tokens.
 *
 * Progress row first, then the objective — the same order `persistDay` takes them in, so a claim
 * arriving mid-tick queues behind that tick rather than deadlocking with it, and the reward lands
 * on the XP the tick just granted rather than on a copy read before it.
 */
export async function claimObjective(
  sql: Db,
  producer: string,
  input: { worldId: string; playerId: string; objectiveId: string; correlationId?: string },
  withOutbox: WithOutbox,
): Promise<{ objectiveId: string; rewardXp: number; rewardTokens: number; progress: ProgressWork }> {
  await ensureProgress(sql, input.worldId, input.playerId);
  return withOutbox(sql, producer, async (tx, emit) => {
    const [row] = await tx<ProgressRow[]>`
      select * from player_progress where player_id = ${input.playerId} for update`;
    if (!row) throw new NotFoundError('no progress to credit');

    // Conditional flip: whoever sets `claimed` first is the one who is paid, so two tabs racing
    // the same button cannot both collect.
    const [locked] = await tx<{ id: string; reward_xp: number; reward_tokens: number }[]>`
      update objectives set claimed = true
       where id = ${input.objectiveId} and player_id = ${input.playerId}
         and claimed = false and progress >= target
      returning id, reward_xp, reward_tokens`;
    if (!locked) {
      const [exists] = await tx<{ claimed: boolean; progress: number; target: number }[]>`
        select claimed, progress, target from objectives
         where id = ${input.objectiveId} and player_id = ${input.playerId}`;
      if (!exists) throw new NotFoundError('no such objective');
      throw new ConflictError(exists.claimed ? 'already claimed' : 'objective not complete');
    }

    const work = toProgressWork(row);
    grantXp(work, locked.reward_xp);
    work.tokens += locked.reward_tokens;
    await tx`
      update player_progress
         set xp = ${work.xp}, level = ${work.level}, skill_points = ${work.skillPoints},
             tokens = ${work.tokens}
       where player_id = ${input.playerId}`;
    emit({
      topic: 'nda.objective.claimed',
      key: input.playerId,
      payload: {
        worldId: input.worldId,
        playerId: input.playerId,
        objectiveId: locked.id,
        rewardXp: locked.reward_xp,
        rewardTokens: locked.reward_tokens,
      },
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    });
    return {
      objectiveId: locked.id,
      rewardXp: locked.reward_xp,
      rewardTokens: locked.reward_tokens,
      progress: work,
    };
  });
}

/* ------------------------------------------------------------------------------ readers */

export interface RosterEntry {
  readonly id: string;
  readonly handle: string;
  readonly isBot: boolean;
  readonly alive: boolean;
  readonly reputation: number;
  readonly homesteadX: number;
  readonly homesteadY: number;
  readonly communeName: string | null;
  readonly level: number;
  readonly daysSurvived: number;
  readonly score: number;
  readonly spawnProtected: boolean;
  readonly cosmeticStyle: string | null;
}

export async function roster(sql: Db, worldId: string, currentDay: number): Promise<RosterEntry[]> {
  const rows = await sql<
    (PlayerRow & {
      commune_name: string | null;
      level: number | null;
      days_survived: number | null;
      contribution: number | null;
      achievements: number;
    })[]
  >`
    select p.*, c.name as commune_name,
           g.level, g.days_survived, g.contribution,
           coalesce(a.n, 0)::int as achievements
      from players p
      left join communes c on c.id = p.commune_id
      left join player_progress g on g.player_id = p.id
      left join (select player_id, count(*) as n from achievements group by player_id) a
             on a.player_id = p.id
     where p.world_id = ${worldId}
     order by p.created_at, p.id`;

  return rows.map((p) => {
    const resources = Object.values(p.resources).reduce((s, v) => s + v, 0);
    return {
      id: p.id,
      handle: p.handle,
      isBot: p.is_bot,
      alive: p.alive,
      reputation: p.reputation,
      homesteadX: p.homestead_x,
      homesteadY: p.homestead_y,
      communeName: p.commune_name,
      level: p.level ?? 1,
      daysSurvived: p.days_survived ?? 0,
      score: survivalScore({
        daysSurvived: p.days_survived ?? 0,
        alive: p.alive,
        resources,
        defense: p.defense,
        reputation: p.reputation,
        contribution: p.contribution ?? 0,
        level: p.level ?? 1,
        achievements: p.achievements,
      }),
      // Raids queued today resolve on the next day, so protection is judged against it.
      spawnProtected: !p.is_bot && currentDay + 1 - p.joined_day < 3,
      cosmeticStyle: p.cosmetic_style,
    };
  });
}

export interface LeaderboardEntry extends RosterEntry {
  readonly rank: number;
}

export async function leaderboard(sql: Db, worldId: string, currentDay: number): Promise<LeaderboardEntry[]> {
  const entries = await roster(sql, worldId, currentDay);
  return [...entries]
    .sort(
      (a, b) =>
        b.score - a.score || b.daysSurvived - a.daysSurvived || a.handle.localeCompare(b.handle),
    )
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

/**
 * A world's day reports, as one survivor may read them.
 *
 * Public entries plus the caller's OWN private entries. `viewerPlayerId` is the whole access
 * control: a private report belongs to exactly one reader, and this is where that is enforced.
 */
export async function reportsFor(
  sql: Db,
  worldId: string,
  viewerPlayerId: string | null,
  day: number | null,
  limit: number,
): Promise<
  {
    id: string;
    day: number;
    kind: string;
    isPublic: boolean;
    message: string;
    actorHandle: string | null;
    targetHandle: string | null;
  }[]
> {
  const rows = await sql<
    {
      id: string;
      day: number;
      kind: string;
      is_public: boolean;
      message: string;
      actor_handle: string | null;
      target_handle: string | null;
    }[]
  >`
    select id, day, kind, is_public, message, actor_handle, target_handle
      from reports
     where world_id = ${worldId}
       and (${day}::int is null or day = ${day})
       and (is_public = true or viewer_player_id = ${viewerPlayerId})
     order by day desc, id
     limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    day: r.day,
    kind: r.kind,
    isPublic: r.is_public,
    message: r.message,
    actorHandle: r.actor_handle,
    targetHandle: r.target_handle,
  }));
}

export async function worldMap(
  sql: Db,
  worldId: string,
): Promise<{ x: number; y: number; terrain: Terrain; ruinName: string | null; ownerId: string | null }[]> {
  const rows = await sql<
    { x: number; y: number; terrain: Terrain; ruin_name: string | null; owner_id: string | null }[]
  >`select x, y, terrain, ruin_name, owner_id from tiles where world_id = ${worldId} order by y, x`;
  return rows.map((t) => ({
    x: t.x,
    y: t.y,
    terrain: t.terrain,
    ruinName: t.ruin_name,
    ownerId: t.owner_id,
  }));
}

export async function worldEventsOf(
  sql: Db,
  worldId: string,
): Promise<{ day: number; type: string; title: string; description: string; severity: number }[]> {
  return sql<{ day: number; type: string; title: string; description: string; severity: number }[]>`
    select day, type, title, description, severity from world_events
     where world_id = ${worldId} order by day desc, type`;
}

export async function objectivesOf(
  sql: Db,
  playerId: string,
): Promise<
  {
    id: string;
    kind: string;
    description: string;
    target: number;
    progress: number;
    period: string;
    rewardXp: number;
    rewardTokens: number;
    claimed: boolean;
  }[]
> {
  const rows = await sql<
    {
      id: string;
      kind: string;
      description: string;
      target: number;
      progress: number;
      period: string;
      reward_xp: number;
      reward_tokens: number;
      claimed: boolean;
    }[]
  >`
    select id, kind, description, target, progress, period, reward_xp, reward_tokens, claimed
      from objectives where player_id = ${playerId} order by period, bucket desc, id`;
  return rows.map((o) => ({
    id: o.id,
    kind: o.kind,
    description: o.description,
    target: o.target,
    progress: o.progress,
    period: o.period,
    rewardXp: o.reward_xp,
    rewardTokens: o.reward_tokens,
    claimed: o.claimed,
  }));
}

export async function achievementsOf(
  sql: Db,
  playerId: string,
): Promise<{ achId: string; name: string; description: string; points: number; unlockedAt: number; delivered: boolean }[]> {
  const rows = await sql<
    { ach_id: string; name: string; description: string; points: number; unlocked_at: number; delivered_at: Date | null }[]
  >`
    select ach_id, name, description, points, unlocked_at, delivered_at
      from achievements where player_id = ${playerId} order by unlocked_at, ach_id`;
  return rows.map((a) => ({
    achId: a.ach_id,
    name: a.name,
    description: a.description,
    points: a.points,
    unlockedAt: a.unlocked_at,
    delivered: a.delivered_at !== null,
  }));
}

export async function playerCounts(sql: Db, worldId: string): Promise<{ humans: number; bots: number }> {
  const [row] = await sql<{ humans: number; bots: number }[]>`
    select count(*) filter (where is_bot = false)::int as humans,
           count(*) filter (where is_bot = true)::int as bots
      from players where world_id = ${worldId}`;
  return { humans: row?.humans ?? 0, bots: row?.bots ?? 0 };
}
