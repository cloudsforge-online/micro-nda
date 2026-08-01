/**
 * The achievement bridge to the worlds shared profile.
 *
 * `worlds` owns the cross-title player profile and its achievements (03/19 §1.5.2). Ninety Days
 * After does not keep a reputation of its own that outlives a season; when a survivor endures
 * ninety days or overruns a rival, that becomes a profile achievement visible across the estate.
 * This is the bridge, and it is the thing the ancestor did not have at all: its achievements were
 * rows in the world they were earned in and died with the season.
 *
 * Delivery is a LEASED JOB (see `jobs.ts`), not an inline call from the tick. The achievement is
 * recorded locally first — once, by the `achievements_player_ach_uniq` constraint, inside the day's
 * transaction — and the job posts it and marks it delivered. So a worlds outage delays a badge; it
 * does not lose one, and it cannot produce two.
 *
 * The delivery key is derived from `(userId, achId)`, NOT from the job id: a job that is retried,
 * redelivered or run by a different replica must post the same key, or worlds records the badge
 * twice.
 */

import type { Logger } from '@cloudsforge/telemetry';
import { WorldsRefusedError, WorldsUnavailableError, type WorldsClient } from './worldsclient.ts';
import { TITLE_SLUG } from './rules.ts';
import type { Db } from './outbox.ts';

export interface AchievementDeps {
  readonly sql: Db;
  readonly worlds: WorldsClient;
  readonly logger: Logger;
}

export type DeliverOutcome = 'delivered' | 'gone' | 'already' | 'refused' | 'unowned';

interface AchievementRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly ach_id: string;
  readonly name: string;
  readonly points: number;
  readonly delivered_at: Date | null;
}

/**
 * Achievements not yet delivered. The sweep enqueues one delivery job per id.
 *
 * Bots are excluded at the source rather than at delivery time. A bot has no account, so there is
 * no profile to post to; leaving them in the set would give the sweep a permanent backlog it could
 * never drain and would hide a real one behind it.
 */
export async function outstandingAchievementIds(sql: Db, limit = 100): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select a.id from achievements a
      join players p on p.id = a.player_id
     where a.delivered_at is null and p.user_id is not null
     order by a.unlocked_at, a.id limit ${limit}`;
  return rows.map((r) => r.id);
}

/**
 * Deliver one achievement to worlds.
 *
 * Returns a terminal outcome; throws only on an outage, so the job runner reschedules with backoff
 * and the SAME derived idempotency key.
 */
export async function deliverAchievement(
  deps: AchievementDeps,
  achievementId: string,
  correlationId: string,
): Promise<DeliverOutcome> {
  const rows = await deps.sql<AchievementRow[]>`
    select a.id, p.user_id, a.ach_id, a.name, a.points, a.delivered_at
      from achievements a join players p on p.id = a.player_id
     where a.id = ${achievementId}`;
  const row = rows[0];
  if (!row) return 'gone';
  if (row.delivered_at) return 'already';
  if (!row.user_id) return 'unowned'; // a bot's badge has no profile to reach

  try {
    await deps.worlds.postAchievement({
      userId: row.user_id,
      titleSlug: TITLE_SLUG,
      code: row.ach_id,
      name: row.name,
      points: row.points,
      correlationId,
      idempotencyKey: `${TITLE_SLUG}:achievement:${row.user_id}:${row.ach_id}`,
    });
  } catch (err) {
    if (err instanceof WorldsUnavailableError) throw err; // retry with backoff
    if (err instanceof WorldsRefusedError) {
      deps.logger.warn('worlds refused an achievement permanently', {
        achievementId,
        err: err.message,
      });
      return 'refused';
    }
    throw err;
  }

  // Marked delivered only AFTER worlds accepted it, and only if it is still undelivered. Both
  // halves matter: the first stops a lost post being recorded as a win, the second makes a re-run
  // of this function a no-op rather than a second timestamp.
  await deps.sql`
    update achievements set delivered_at = now()
     where id = ${achievementId} and delivered_at is null`;
  return 'delivered';
}
