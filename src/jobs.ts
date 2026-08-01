/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no `setInterval`
 * in this repository doing domain work and CI greps for one. The ancestor's whole scheduler was a
 * `setInterval` guarded by a module-local boolean (`engine/tick.ts:46-72`) — correct with exactly
 * one replica, and with two, two sweeps see the same due worlds.
 *
 * **The lease key names the contended resource, not the row.** That single decision is where the
 * correctness lives:
 *
 *   | Work                 | Key         | Why                                                   |
 *   |----------------------|-------------|-------------------------------------------------------|
 *   | world.sweep          | `stream`    | Finds due worlds and enqueues them. Enqueues and       |
 *   |                      |             | nothing else, so it can be cheap and frequent.        |
 *   | world.tick           | `<world id>`| **One resolution per world per day.** Keying on a day |
 *   |                      |             | would let two replicas resolve two different days of  |
 *   |                      |             | one world concurrently, out of order. Keying on the   |
 *   |                      |             | world serialises a world's whole history — which is   |
 *   |                      |             | what a simulation with carry-over state needs, and    |
 *   |                      |             | what 04-domain-model §10.5 names against double XP.   |
 *   | achievement.sweep    | `stream`    | The backlog of undelivered badges.                    |
 *   | achievement.deliver  | `<ach id>`  | The one job that posts to worlds. Keyed per            |
 *   |                      |             | achievement, so two workers cannot both deliver one.  |
 *   | outbox.relay         | `stream`    | The outbox stream. Keying on an event id would let    |
 *   |                      |             | two relays deliver one batch to a subscriber twice.   |
 *   | idempotency.reap     | `stream`    | Housekeeping over one table.                          |
 *
 * `world.tick` runs the bot planning and the day resolution TOGETHER, under one lease, in the order
 * the ancestor used: bots choose, then the day resolves. Splitting them would let a world resolve a
 * day whose bots had not yet acted.
 */

import { JobRunner, type Job, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs';
import type { Logger, Metrics } from '@cloudsforge/telemetry';
import type { WorldsClient } from './worldsclient.ts';
import { createRelay, withOutbox, type Db } from './outbox.ts';
import { deliverAchievement, outstandingAchievementIds } from './achievements.ts';
import { dueWorldIds, enqueueBotActions, resolveWorldDay } from './worlds.ts';
import { reapIdempotencyKeys } from './idempotency.ts';

export const RELAY_KIND = 'outbox.relay';
export const WORLD_SWEEP_KIND = 'world.sweep';
export const WORLD_TICK_KIND = 'world.tick';
export const ACH_SWEEP_KIND = 'achievement.sweep';
export const ACH_DELIVER_KIND = 'achievement.deliver';
export const IDEMPOTENCY_REAP_KIND = 'idempotency.reap';

/** How long an idempotency claim is replayable before it is reaped. */
export const IDEMPOTENCY_TTL_HOURS = 48;

export interface JobDeps {
  readonly sql: Db;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly worlds: WorldsClient;
  readonly producer: string;
  readonly signingSecret: string;
  readonly tickBatchSize: number;
  readonly queue: Pick<JobQueue, 'enqueue'>;
  /** Injectable so tests can drive the calendar rather than wait for it. */
  readonly now?: () => Date;
}

export interface Recurring {
  readonly kind: string;
  readonly key: string;
  readonly everyMs: number;
}

export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
  // A world's tick interval is measured in minutes, so a five-second sweep is far finer than the
  // finest schedule anyone can configure and costs one indexed query.
  { kind: WORLD_SWEEP_KIND, key: 'stream', everyMs: 5_000 },
  { kind: ACH_SWEEP_KIND, key: 'stream', everyMs: 5_000 },
  { kind: IDEMPOTENCY_REAP_KIND, key: 'stream', everyMs: 3_600_000 },
]);

/** Enqueue each recurring job once. `keep` collapses N replicas booting into one row. */
export async function seedRecurring(queue: Pick<JobQueue, 'enqueue'>): Promise<void> {
  for (const r of RECURRING) await queue.enqueue({ kind: r.kind, key: r.key, onConflict: 'keep' });
}

/** Re-arm a recurring job after it completes — never from inside the handler. */
export async function rescheduleRecurring(
  queue: Pick<JobQueue, 'enqueue'>,
  kind: string,
  key: string,
): Promise<void> {
  const r = RECURRING.find((x) => x.kind === kind && x.key === key);
  if (!r) return;
  await queue.enqueue({
    kind,
    key,
    runAt: new Date(Date.now() + r.everyMs),
    onConflict: 'keep',
  });
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): void {
  const now = deps.now ?? ((): Date => new Date());

  runner.register(
    RELAY_KIND,
    createRelay({ sql: deps.sql, logger: deps.logger, signingSecret: deps.signingSecret }),
  );

  // Enqueues and nothing else. A sweep that also resolved would hold one lease across every due
  // world, so a single slow world would stall the rest — and the whole batch would be retried when
  // it failed. One job per world means one world's failure is one world's failure.
  runner.register(WORLD_SWEEP_KIND, async () => {
    const ids = await dueWorldIds(deps.sql, now(), deps.tickBatchSize);
    for (const id of ids) {
      await deps.queue.enqueue({
        kind: WORLD_TICK_KIND,
        key: id,
        payload: { worldId: id },
        onConflict: 'keep',
      });
    }
    if (ids.length > 0) deps.metrics.set('nda_worlds_due', ids.length);
  });

  runner.register<{ worldId?: string }>(WORLD_TICK_KIND, async (job: Job<{ worldId?: string }>) => {
    const worldId = job.payload.worldId ?? job.key;
    // Bots first, then the day — the ancestor's order (`engine/tick.ts:23-24`). A day resolved
    // before its bots have chosen is a day in which every bot stood still.
    await enqueueBotActions(deps.sql, worldId);
    const outcome = await resolveWorldDay(deps.sql, deps.producer, worldId, now(), withOutbox);
    if (!outcome) {
      // Not an error. The world is not active, or another writer resolved this day while we were
      // simulating it and our write was correctly refused. Counted, because a climbing rate here
      // means the lease is not doing its job and the second defence is carrying the service.
      deps.metrics.increment('nda_ticks_refused_total');
      return;
    }
    deps.metrics.increment('nda_days_resolved_total', {
      outcome: outcome.archived ? 'archived' : 'advanced',
    });
    // The product is this loop. One line per world per day is what makes "the world stopped
    // advancing" answerable from the log alone.
    deps.logger.info('day resolved', {
      worldId: outcome.worldId,
      day: outcome.day,
      alive: outcome.aliveCount,
      raids: outcome.raids,
      trades: outcome.trades,
      deaths: outcome.deaths,
      reports: outcome.reports,
      archived: outcome.archived,
    });
    if (outcome.achievementsUnlocked > 0) {
      deps.metrics.increment('nda_achievements_unlocked_total');
      // Nudge the sweep so badges reach worlds promptly; it would pick them up anyway.
      await deps.queue.enqueue({ kind: ACH_SWEEP_KIND, key: 'stream', onConflict: 'keep' });
    }
    if (!outcome.archived) {
      // Re-arm immediately. The world's own `next_tick_at` decides WHEN; this only ensures the
      // sweep has something to find without waiting a full sweep interval for a fast dev world.
      await deps.queue.enqueue({ kind: WORLD_SWEEP_KIND, key: 'stream', onConflict: 'keep' });
    }
  });

  runner.register(ACH_SWEEP_KIND, async () => {
    const ids = await outstandingAchievementIds(deps.sql);
    for (const id of ids) {
      await deps.queue.enqueue({
        kind: ACH_DELIVER_KIND,
        key: id,
        payload: { id },
        onConflict: 'keep',
      });
    }
  });

  runner.register<{ id?: string }>(ACH_DELIVER_KIND, async (job: Job<{ id?: string }>) => {
    const id = job.payload.id ?? job.key;
    const outcome = await deliverAchievement(
      { sql: deps.sql, worlds: deps.worlds, logger: deps.logger },
      id,
      `ach:${job.id}`,
    );
    deps.metrics.increment('nda_achievement_deliveries_total', { outcome });
  });

  runner.register(IDEMPOTENCY_REAP_KIND, async () => {
    const removed = await reapIdempotencyKeys(deps.sql, IDEMPOTENCY_TTL_HOURS);
    if (removed > 0) deps.logger.info('reaped idempotency keys', { removed });
  });
}

/** Wire the recurring re-arm to the runner's completed event. */
export function onRunnerEvent(
  queue: Pick<JobQueue, 'enqueue'>,
  logger: Logger,
): (event: RunnerEvent) => void {
  return (event) => {
    if (event.type === 'completed' && event.kind && event.key) {
      void rescheduleRecurring(queue, event.kind, event.key).catch((err) =>
        logger.warn('reschedule failed', {
          kind: event.kind,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (event.type === 'dead' || event.type === 'error') {
      logger.warn('job event', { type: event.type, kind: event.kind, err: event.error });
    }
  };
}
