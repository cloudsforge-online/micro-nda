/**
 * The shapes a day of simulation reads and writes.
 *
 * These exist so that `resolveDay` can be a **pure function**: it takes a complete snapshot of a
 * world and returns a complete description of what one day did to it, with no database handle, no
 * clock, and no `randomUUID`. That is not tidiness. It is the only way to make
 *
 *     same seed + same inputs → byte-identical resolution
 *
 * a thing a test can assert, and `conformance.test.ts` asserts it against a corpus recorded by
 * executing the frozen ancestor for real.
 *
 * The ancestor's `resolveDay` (`ninety-days-after/services/game/src/engine/resolve.ts`) opened
 * with seven `db.select()` calls and closed with a transaction, so the engine and its persistence
 * were the same function. Anything you wanted to know about how a day resolved, you learned by
 * running Postgres.
 *
 * `createdAt` is carried as an epoch-millisecond NUMBER rather than a `Date`. The ancestor's
 * resolution order is `createdAt` then `id` (`resolve.ts`), so the wall clock is a genuine
 * input to the simulation; making the caller supply it keeps the engine pure without changing the
 * order a single homestead acts in.
 */

import type {
  BotPersonality,
  ObjectiveKind,
  ObjectivePeriod,
  QueuedAction,
  ReportKind,
  ResourceBag,
  WorldStatus,
} from '../rules.ts';

export interface WorldSnapshot {
  readonly id: string;
  readonly name: string;
  /**
   * The simulation seed. In the ancestor this was always the world's id
   * (`world/generate.ts` — "The world id is the map seed"), so a world carried forward from
   * there sets `seed = id` and replays identically. Separating them means a world can be re-seeded
   * for a rerun without its rows changing identity.
   */
  readonly seed: string;
  readonly status: WorldStatus;
  /** The day already resolved. Resolution produces `day + 1`. */
  readonly day: number;
  readonly seasonLength: number;
  readonly width: number;
  readonly height: number;
  readonly tickIntervalMinutes: number;
}

export interface PlayerSnapshot {
  readonly id: string;
  readonly worldId: string;
  readonly userId: string | null;
  readonly handle: string;
  readonly isBot: boolean;
  readonly personality: BotPersonality | null;
  readonly homesteadX: number;
  readonly homesteadY: number;
  readonly resources: ResourceBag;
  readonly hp: number;
  readonly morale: number;
  readonly defense: number;
  readonly reputation: number;
  readonly alive: boolean;
  readonly apPerDay: number;
  readonly communeId: string | null;
  readonly joinedDay: number;
  /** Epoch ms. The primary key of the resolution order; `id` breaks ties. */
  readonly createdAt: number;
}

/** One row of `queued_actions`, already globally ordered by `seq`. */
export interface QueuedActionRow {
  readonly playerId: string;
  readonly seq: number;
  readonly action: QueuedAction;
}

export interface RuinSnapshot {
  readonly x: number;
  readonly y: number;
  readonly name: string;
  readonly stock: ResourceBag;
}

export interface ProgressSnapshot {
  readonly playerId: string;
  readonly level: number;
  readonly xp: number;
  readonly skillPoints: number;
  readonly perks: readonly string[];
  readonly tokens: number;
  readonly streak: number;
  readonly lastSeenDay: number;
  readonly daysSurvived: number;
  readonly contribution: number;
}

export interface ObjectiveSnapshot {
  readonly id: string;
  readonly playerId: string;
  readonly progress: number;
  readonly claimed: boolean;
}

/* --------------------------------------------------------------------------------- results */

/** A player's state after the day. Absolute values — the row is overwritten with these. */
export interface PlayerResult {
  readonly id: string;
  readonly resources: ResourceBag;
  readonly hp: number;
  readonly morale: number;
  readonly defense: number;
  readonly reputation: number;
  readonly alive: boolean;
}

/**
 * What one resolved day ADDS to a player's progress row.
 *
 * Deltas, not absolutes — the ancestor's hard-won lesson, kept verbatim
 * (`resolve.ts`): the day is simulated from a snapshot of `player_progress` read before the
 * transaction opens — correct for the simulation, which must resolve against yesterday's perks —
 * but writing that snapshot back reverted anything the player did while the day was being
 * computed. An objective claimed or a skill point spent mid-tick vanished. So the row is re-read
 * under `FOR UPDATE` at persist time and these are applied to whatever is there.
 *
 * `tokens` is deliberately absent: nothing in a tick awards them, so the tick has no business
 * writing the one column an objective claim exists to move.
 */
export interface ProgressDelta {
  readonly playerId: string;
  readonly xpGained: number;
  readonly daysSurvived: number;
  readonly contribution: number;
  /** Bots have no session, so the tick is their login and their skill spender. */
  readonly isBot: boolean;
  readonly personality: BotPersonality | null;
  /** Whether the bot was alive at the end of the day, which is what advances its streak. */
  readonly aliveAtEnd: boolean;
}

export interface ObjectiveUpsert {
  readonly id: string;
  readonly worldId: string;
  readonly playerId: string;
  readonly bucket: number;
  readonly kind: ObjectiveKind;
  readonly description: string;
  readonly target: number;
  readonly progress: number;
  readonly period: ObjectivePeriod;
  readonly rewardXp: number;
  readonly rewardTokens: number;
  readonly claimed: boolean;
}

export interface AchievementUnlock {
  readonly id: string;
  readonly worldId: string;
  readonly playerId: string;
  readonly achId: string;
  readonly name: string;
  readonly description: string;
  readonly points: number;
  readonly unlockedAt: number;
}

export interface ReportRow {
  /** Derived from `(worldId, day, ordinal)`. Never random — see `resolve.ts`. */
  readonly id: string;
  readonly worldId: string;
  readonly day: number;
  readonly kind: ReportKind;
  readonly isPublic: boolean;
  readonly message: string;
  readonly actorHandle: string | null;
  readonly targetHandle: string | null;
  readonly viewerPlayerId: string | null;
}

export interface RuinResult {
  readonly x: number;
  readonly y: number;
  readonly stock: ResourceBag;
}

export interface DayStats {
  readonly aliveCount: number;
  readonly raids: number;
  readonly trades: number;
  readonly deaths: number;
  readonly actions: number;
}
