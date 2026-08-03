/**
 * Worlds, as this service uses it.
 *
 * Worlds owns the cross-title shared player profile and its achievements (03/19 §1.5.2). Ninety
 * Days After does not keep a reputation of its own; when a Warden crosses a Resonance milestone or
 * completes the dex, that becomes a profile achievement visible across the estate. This client is
 * the bridge.
 *
 * Delivery is a LEASED JOB (see jobs.ts), not an inline call: the achievement is recorded locally
 * first (once, by the `achievements_player_ach_uniq` unique), and the job posts it to worlds and
 * marks it delivered — so a worlds outage delays the badge, it does not lose or double it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHAT THIS FILE USED TO BE, AND WHY EVERY CROSS-TITLE BADGE WAS SILENTLY DROPPED.**
 *
 * Until this commit these 89 lines were a byte-identical copy of `emberkin/src/worldsclient.ts`
 * (they differed in one word of one comment), and the copy was wrong in four independent ways.
 * None of them could fail a typecheck, because all four are agreements about BYTES that no build
 * ever saw both halves of:
 *
 *   1. **The route did not exist.** It posted `/internal/achievements`. `worlds/src/server.ts`
 *      defines 22 routes (`:374`–`:847`) and none of them is that one — there is no `/internal/*`
 *      prefix in worlds at all. The route that unlocks an achievement is
 *      `POST /v1/titles/:id/achievements/unlock` (`worlds/src/server.ts:775`).
 *   2. **The failure was misclassified.** A 404 is a 4xx, so `HttpError.peerDecided` was true, so
 *      this client raised `WorldsRefusedError`, which `achievements.ts` recorded as the terminal
 *      outcome `'refused'` and never retried. The badge was not delayed; it was discarded, and the
 *      caller believed worlds had DECLINED it rather than that we had never reached worlds at all.
 *      That is the line that turned a wiring bug into permanent data loss. See `classify` below.
 *   3. **The scope was wrong.** It declared `worlds:write`. The unlock route demands `worlds:title`
 *      (`worlds/src/server.ts:777`, constant at `:106`) — a separate authority precisely so that a
 *      title's credential cannot edit a player's profile. Fixing (1) alone turns a 404 into a 403.
 *   4. **The identifier was a different kind of thing.** It sent `titleSlug` in the body. The title
 *      is a UUID in the PATH, and `itemIdOf` (`worlds/src/server.ts:968-972`) answers 404 to
 *      anything that is not one, before the handler runs. The body field was spelled `code` here
 *      and `key` at the server (`:781`).
 *
 * The wire shapes now come from `@cloudsforge/contracts-worlds`, which ships a `serialise`/`parse`
 * pair per document rather than bare types, for the reason above: types alone would have caught
 * none of these four. Nothing in this file hand-rolls a path, a scope or a body.
 *
 * **Why the callers use the route worlds already serves, rather than worlds growing
 * `/internal/achievements`.** The existing route does the whole job — service principal under
 * `worlds:title`, `{userId, key}` body, 201 fresh / 200 replayed, dedupe on
 * `(user_id, achievement_id)`. Adding the invented route would have been a second spelling of an
 * existing capability, and a worse one: it would have to take the title in the BODY, which throws
 * away the authorization property the path form gives. `worlds/src/server.ts:756-757` states it —
 * a title cannot touch another title's achievements *because the id is in the path*. A
 * body-supplied slug would let any `worlds:title` credential award badges as any title.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient, HttpError } from '@cloudsforge/http';
import {
  SCOPE_FOR,
  achievementDefinePath,
  achievementIdempotencyKey,
  achievementUnlockPath,
  isTitleId,
  parseAchievementUnlockResult,
  serialiseAchievementDefinition,
  serialiseAchievementUnlock,
} from '@cloudsforge/contracts-worlds';
import { TITLE_SLUG } from './rules.ts';
import type { LiveScope } from '@cloudsforge/contracts-auth';

/**
 * The scope this service's credential must carry to post a badge — read from the contract, which
 * reads it from worlds' own gate. Never spelled as a literal here again: a literal is what let
 * `worlds:write` sit in this file, wrong, for months.
 *
 * ── THE ANNOTATION: AN OUTBOUND DEMAND, TYPED AGAINST THE REGISTRY ───────────────────────────
 *
 * `readonly LiveScope[]`, not `readonly string[]`. `service-ci.yml` proves that every scope a
 * repository's route GATES demand is registered — the INBOUND direction. This constant is the
 * other one: what this service PRESENTS to a peer. Nothing had ever checked it, which is how
 * `micro-market` declared `policy:evaluate` and `micro-wallet` `custody:address` — neither ever
 * a registry key — for the life of both services. `derive-grants.mjs` reads this into
 * `IDENTITY_SERVICE_TOKEN_GRANTS`, and identity validates that list at import and REFUSES TO
 * START on an unknown name (`identity/src/env.ts:141`): a dead identity container, so no tokens
 * for anybody.
 *
 * `LiveScope` rather than `Scope` because `Scope` is `keyof typeof SCOPES` — every registered
 * key, DEPRECATED ones included — and identity will not mint a deprecated scope either.
 * `LiveScope = Exclude<Scope, DeprecatedScope>`, with `DeprecatedScope` computed FROM `SCOPES` by
 * a conditional type over the `deprecated` field rather than hand-listed
 * (`contracts/packages/auth/src/index.ts:507`), so it cannot drift from the registry. `Scope`
 * keeps its wide meaning and this does not narrow it: a token arriving from anywhere may carry a
 * scope that has since died, so reading is wide and demanding is narrow. This is demanding.
 */
export const WORLDS_SCOPES: readonly LiveScope[] = Object.freeze([SCOPE_FOR.unlockAchievement]);

/**
 * Worlds considered the request and declined it. TERMINAL — not retried.
 *
 * Reserved for an answer that means "this cannot happen", which retrying cannot change. It is
 * deliberately NOT what a 404, a 401, a 403 or a 400 produces any more; see `classify`.
 */
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

/**
 * We called worlds wrongly: the endpoint does not exist, our credential lacks the authority, or the
 * document we sent is not the one worlds parses.
 *
 * **This is a distinct fact from `WorldsRefusedError`, and conflating the two is the defect this
 * class exists to make impossible.** "The peer declined" and "we never reached the peer" are
 * different sentences, and only the first is safe to stop retrying on. A misrouted badge is
 * undelivered data, not a decision about it, so it is thrown — the job keeps it, backs off, and
 * retries — and it is logged at `error`, because the fix is a deploy and an operator has to see it.
 *
 * Retrying is safe here in a way that "retry any 4xx" would not be: nothing has been created, so
 * there is nothing to double, and the idempotency key is derived from `(titleId, userId, key)` and
 * so is stable across every attempt. The cost of the choice is a badge that retries until someone
 * ships a fix; the cost of the old choice was a badge that vanished and told no one. Loud and
 * pending beats quiet and gone.
 */
export class WorldsMisroutedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorldsMisroutedError';
    this.status = status;
  }
}

/**
 * The statuses that mean "we are wired wrong", not "worlds decided".
 *
 * 404 — no such route, or no such title id.   401 — our credential was not accepted at all.
 * 403 — it was accepted and lacks the scope.  400 — worlds could not parse what we sent.
 * 405 — the route exists under another verb.  415 — we sent the wrong content type.
 *
 * Every one of these is fixed by changing this service or its configuration, never by worlds
 * changing its mind, and every one of them was previously recorded as a permanent refusal.
 */
const WIRING_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 405, 415]);

function classify(err: unknown, what: string): Error {
  if (err instanceof HttpError) {
    if (WIRING_STATUSES.has(err.status)) {
      return new WorldsMisroutedError(err.status, `${what}: worlds answered ${err.status} — this service is wired wrong, the badge is still pending`);
    }
    // A 4xx that is not in the wiring set is a real decision about this specific badge (409, 410,
    // 422 …). 5xx and transport faults fall through to "we do not know", which is retried.
    if (err.peerDecided) return new WorldsRefusedError(err.status, `${what}: worlds answered ${err.status}`);
  }
  return new WorldsUnavailableError(err instanceof Error ? err.message : String(err));
}

/** What the delivery job hands over. The title is this service; it is not a parameter. */
export interface AchievementPost {
  readonly userId: string;
  /** Worlds' spelling. This was `code` here and `key` there, and nothing compared them. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly points: number;
  readonly correlationId: string;
}

export interface WorldsClient {
  /** Resolves to whether this call was the one that created the badge (201) or a replay (200). */
  postAchievement(post: AchievementPost): Promise<{ unlocked: boolean }>;
}

export interface WorldsClientOptions {
  readonly baseUrl: string;
  readonly token: () => Promise<string | undefined> | string | undefined;
  readonly deadlineMs: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Overridable only for tests; a title knows its own slug. */
  readonly titleSlug?: string;
}

interface TitleWire {
  readonly id?: unknown;
  readonly slug?: unknown;
}

export function httpWorldsClient(options: WorldsClientOptions): WorldsClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'worlds',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const slug = options.titleSlug ?? TITLE_SLUG;

  /**
   * Our own title id, resolved from our slug through worlds' public registry.
   *
   * `GET /v1/titles` (`worlds/src/server.ts:507-522`) is unauthenticated and returns `id` and
   * `slug` together — so the slug-to-UUID step that the old client skipped needs no new route and
   * no new configuration. Cached for the life of the process; a title's id does not change, and
   * re-resolving per badge would put a second request in front of every delivery.
   *
   * Not memoised as a resolved promise on failure: a rejected lookup must not be cached, or one
   * blip at boot would pin this replica into a permanent failure the job could never retry out of.
   */
  let titleIdCache: string | null = null;
  async function titleId(): Promise<string> {
    if (titleIdCache !== null) return titleIdCache;
    let body: { titles?: readonly TitleWire[] };
    try {
      body = await client.request<{ titles?: readonly TitleWire[] }>('/v1/titles', { method: 'GET' });
    } catch (err) {
      throw classify(err, 'resolving our title id');
    }
    const mine = (body.titles ?? []).find((t) => t.slug === slug);
    const id = typeof mine?.id === 'string' ? mine.id : '';
    if (!isTitleId(id)) {
      // A named, local failure instead of a 404 from a path built out of nothing. Misrouted, not
      // refused: an unregistered title is a deployment that has not been finished, and the badge
      // must survive until it is.
      throw new WorldsMisroutedError(
        404,
        `worlds has no registered title with slug "${slug}" — the badge is still pending`,
      );
    }
    titleIdCache = id;
    return id;
  }

  /**
   * Worlds refuses an unlock for an achievement it has never been told about — `findAchievement`
   * returns nothing and `worlds/src/rewards.ts:216` raises, which the server maps to 400. So the
   * definition is pushed first. `PUT /v1/titles/:id/achievements` is an upsert
   * (`worlds/src/rewards.ts:155-159`), so this is idempotent and safe to repeat.
   *
   * Once per key per process, not once per badge: a sweep delivering fifty `days_30` badges sends
   * one definition, and a restart re-sends one. The values are this service's catalogue
   * (`rules.ts` ACHIEVEMENTS), which is the authority on its own badges — that is what the
   * `worlds:title` scope means (`worlds/src/server.ts:756-757`).
   */
  const defined = new Set<string>();

  return {
    async postAchievement(post) {
      const id = await titleId();

      if (!defined.has(post.key)) {
        try {
          await client.request(achievementDefinePath(id), {
            method: 'PUT',
            body: serialiseAchievementDefinition({
              key: post.key,
              name: post.name,
              description: post.description,
              points: post.points,
              // This service awards no Shards; a badge here is reputation only. `0n` is a truthful
              // statement of that, not a placeholder — see the `rules.ts` catalogue, which has no
              // reward column at all.
              rewardShards: 0n,
            }),
            requestId: post.correlationId,
          });
        } catch (err) {
          throw classify(err, `defining achievement ${post.key}`);
        }
        defined.add(post.key);
      }

      let raw: unknown;
      try {
        raw = await client.request<unknown>(achievementUnlockPath(id), {
          method: 'POST',
          body: serialiseAchievementUnlock({ userId: post.userId, key: post.key }),
          // Derived from (titleId, userId, key) by the contract and from nothing else — never from
          // a job id or a timestamp. A job that is retried, redelivered or run by another replica
          // must present the SAME key. This service and emberkin previously derived it two
          // different ways from two different alphabets.
          idempotencyKey: achievementIdempotencyKey({ titleId: id, userId: post.userId, key: post.key }),
          requestId: post.correlationId,
        });
      } catch (err) {
        throw classify(err, `unlocking achievement ${post.key}`);
      }

      const result = parseAchievementUnlockResult(raw);
      if (!result.ok) {
        // A 2xx whose body is not the document worlds documents. Treated as an outage rather than
        // a success: recording `delivered` on the strength of an unreadable answer is how a badge
        // is lost while every counter says it landed.
        throw new WorldsUnavailableError(
          `worlds answered the unlock with a body we cannot read: ${result.errors.join('; ')}`,
        );
      }
      return { unlocked: result.value.unlocked };
    },
  };
}
