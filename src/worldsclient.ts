/**
 * Worlds, as this service uses it.
 *
 * Worlds owns the cross-title shared player profile and its achievements (03/19 §1.5.2). Ninety Days After
 * does not keep a reputation of its own; when a Warden crosses a Resonance milestone or completes
 * the dex, that becomes a profile achievement visible across the estate. This client is the bridge.
 *
 * Delivery is a LEASED JOB (see jobs.ts), not an inline call: the achievement is recorded locally
 * first (once, by the `player_achievements` unique), and the job posts it to worlds and marks it
 * delivered — so a worlds outage delays the badge, it does not lose or double it.
 */

import { HttpClient, HttpError } from '@cloudsforge/http';

export const WORLDS_SCOPES: readonly string[] = Object.freeze(['worlds:write']);

/** Worlds refused the post permanently (4xx). Not retried as-is. */
export class WorldsRefusedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorldsRefusedError';
    this.status = status;
  }
}

/** Worlds could not be reached, or answered 5xx. Retry with the same idempotency key. */
export class WorldsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorldsUnavailableError';
  }
}

export interface AchievementPost {
  readonly userId: string;
  readonly titleSlug: string;
  readonly code: string;
  readonly name: string;
  readonly points: number;
  readonly correlationId: string;
  /** Derived from (user, code) — a redelivery posts once. */
  readonly idempotencyKey: string;
}

export interface WorldsClient {
  postAchievement(post: AchievementPost): Promise<{ replayed: boolean }>;
}

export interface WorldsClientOptions {
  readonly baseUrl: string;
  readonly token: () => Promise<string | undefined> | string | undefined;
  readonly deadlineMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

export function httpWorldsClient(options: WorldsClientOptions): WorldsClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'worlds',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    async postAchievement(post) {
      try {
        const body = await client.request<{ replayed?: boolean }>('/internal/achievements', {
          method: 'POST',
          body: {
            userId: post.userId,
            titleSlug: post.titleSlug,
            code: post.code,
            name: post.name,
            points: post.points,
            idempotencyKey: post.idempotencyKey,
          },
          idempotencyKey: post.idempotencyKey,
          requestId: post.correlationId,
        });
        return { replayed: body.replayed ?? false };
      } catch (err) {
        if (err instanceof HttpError && err.peerDecided) throw new WorldsRefusedError(err.status, `worlds answered ${err.status}`);
        throw new WorldsUnavailableError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
