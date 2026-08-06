/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY MUTATING ROUTE IS IDEMPOTENT, BY CONSTRUCTION RATHER THAN BY DISCIPLINE.
 *
 * `micro-market` was found on 2026-07-31 with two mutating routes and no idempotency on either,
 * where a retry created a duplicate. That was not caught by anyone remembering to add it. So here
 * a route is built by one of exactly two functions: `define` (GET only — `buildRoutes` throws at
 * module load if a non-GET reaches it) or `defineMutation`, which cannot be called without an
 * Idempotency-Key policy. There is no third door, and `server.test.ts` walks the built router to
 * prove it.
 *
 * `POST /v1/events` is the one non-GET route that does not take an Idempotency-Key, and it is not
 * an exception to the rule — it is the same rule with a different key. An event carries its own
 * `id`, and `withInbox` dedupes on `(topic, event_id)`, which is exactly what AD-10 requires of a
 * consumer. Taking a client-supplied key there instead would let a producer's retry, which reuses
 * the event id and not an HTTP header, be processed twice.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `POST /v1/events` is also SIGNATURE-CHECKED BEFORE IT IS PARSED, over the exact bytes received,
 * with a timing-safe comparison. A webhook with no MAC lets anyone who can reach the port assert
 * that an account bought a cosmetic.
 *
 * The fail-open / fail-closed split:
 *   `GET  /v1/worlds/:id/me`          fails OPEN — it runs on every load and reads only our data.
 *   `PUT  /v1/worlds/:id/cosmetics`   fails CLOSED with 503 on a billing outage — "ask again
 *                                     later", never "wear it anyway".
 */


import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  type Principal,
} from '@cloudsforge/auth';
import type { Lifecycle } from '@cloudsforge/lifecycle';
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry';
import type { JobQueue } from '@cloudsforge/jobs';
import { SIGNATURE_HEADER, verifyDelivery } from '@cloudsforge/contracts-events';
import { withInbox, withOutbox, type Db } from './outbox.ts';
import { erasePlayers } from './erasure.ts';
import type { EntitlementReader } from './billingclient.ts';
import {
  IdempotencyInFlightError,
  IdempotencyKeyReuseError,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts';
import {
  ConflictError,
  NoFreeHomesteadError,
  NotFoundError,
  ValidationError,
  achievementsOf,
  claimObjective,
  createWorld,
  ensureProgress,
  findWorld,
  joinWorld,
  leaderboard,
  listWorlds,
  objectivesOf,
  playerCounts,
  playerOf,
  queueActions,
  queuedActionsOf,
  recordLogin,
  reportsFor,
  roster,
  startWorld,
  syncBots,
  unlockPerk,
  worldEventsOf,
  worldMap,
} from './worlds.ts';
import {
  communeDetail,
  depositToCommune,
  foundCommune,
  joinCommune,
  leaveCommune,
  listCommunes,
  withdrawFromCommune,
} from './communes.ts';
import { CosmeticNotOwnedError, equipCosmetic, parseEquipped } from './cosmetics.ts';
import type { QueuedAction, WorldStatus } from './rules.ts';
import { WORLD_TICK_KIND } from './jobs.ts';

export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>;
}

export const WRITE_SCOPE = 'nda:write';

const GRANTED_TOPIC = 'billing.entitlement.granted';
const DELETED_TOPIC = 'identity.user.deleted';

export interface ServerDeps {
  readonly lifecycle: Lifecycle;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly verifier: PrincipalVerifier;
  readonly sql: Db;
  readonly producer: string;
  readonly billing: EntitlementReader;
  readonly queue: Pick<JobQueue, 'enqueue'>;
  readonly eventSigningSecret: string;
  readonly now?: () => Date;
  readonly beforeScrape?: () => Promise<void>;
}

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'nda_days_resolved_total',
      help: 'In-game days resolved, by outcome. `archived` is the last day of a season.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'nda_ticks_refused_total',
      help: 'Resolutions that wrote nothing because the day had already moved. A climbing value means the job lease is not holding and the conditional advance is carrying the service alone.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'nda_worlds_due',
      help: 'Worlds whose next tick is overdue at the last sweep. Sustained non-zero means resolution is slower than the schedule.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'nda_achievements_unlocked_total',
      help: 'Achievements newly unlocked by a day resolution, bridged to the worlds shared profile.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'nda_achievement_deliveries_total',
      help: 'Achievement bridge posts to worlds, by outcome.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'nda_cosmetic_refusals_total',
      help: 'Attempts to equip a cosmetic the account does not own. Non-zero means a client believes it may.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'nda_events_rejected_total',
      help: 'Inbound events refused, by reason. A climbing `bad_signature` is somebody probing the webhook.',
      kind: 'counter',
      labels: ['reason'],
    });
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 256 * 1024;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

interface RequestContext {
  readonly req: IncomingMessage;
  readonly url: URL;
  readonly requestId: string;
  readonly log: Logger;
  readonly params: Readonly<Record<string, string>>;
}

/** How a route establishes that a repeat of it is the same operation, not a second one. */
export type IdempotencyPolicy =
  /** An `Idempotency-Key` header, fingerprinted over the body minus per-attempt fields. */
  | 'header'
  /** The event envelope's own id, deduped by the inbox on `(topic, event_id)`. */
  | 'inbox';

interface Route {
  readonly method: string;
  readonly path: string;
  readonly pattern: RegExp;
  readonly idempotency: IdempotencyPolicy | null;
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>;
}

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes();
  let inFlight = 0;

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    const presented = headerOf(req, 'x-request-id');
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId();
    res.setHeader('x-request-id', requestId);

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (match) {
        matched = route;
        params = { ...match.groups };
        break;
      }
    }

    const routeLabel = matched ? matched.path : 'unmatched';
    const log = deps.logger.child({ requestId, method, route: routeLabel });

    inFlight += 1;
    deps.metrics.set('http_requests_in_flight', inFlight);

    const finish = (status: number): void => {
      inFlight -= 1;
      deps.metrics.set('http_requests_in_flight', inFlight);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
      });
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel });
    };

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId);
        finish(reply.status);
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err });
        send(
          res,
          errorReply(500, 'internal', 'the request could not be completed', requestId),
          requestId,
        );
        finish(500);
      });
  });
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(
      404,
      'not_found',
      `no route for ${ctx.req.method} ${ctx.url.pathname}`,
      ctx.requestId,
    );
  }
  try {
    return await route.handle(ctx, deps);
  } catch (err) {
    const authStatus = statusFor(err);
    if (authStatus === 401) {
      ctx.log.info('unauthenticated request', { err });
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId);
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown';
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId);
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err });
      return errorReply(
        503,
        'verifier_unavailable',
        'authentication is temporarily unavailable',
        ctx.requestId,
      );
    }
    if (err instanceof CosmeticNotOwnedError) {
      deps.metrics.increment('nda_cosmetic_refusals_total');
      return errorReply(403, 'cosmetic_not_owned', err.message, ctx.requestId);
    }
    if (err instanceof NotFoundError) return errorReply(404, 'not_found', err.message, ctx.requestId);
    if (err instanceof ConflictError) return errorReply(409, 'conflict', err.message, ctx.requestId);
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reuse', err.message, ctx.requestId);
    }
    if (err instanceof IdempotencyInFlightError) {
      return errorReply(409, 'in_flight', err.message, ctx.requestId);
    }
    if (err instanceof NoFreeHomesteadError) {
      // An operator's problem, not the caller's: the map is full. Logged loudly with the world id,
      // because the ancestor surfaced this as a bare 500 with a message naming nothing.
      ctx.log.error('no free homestead', { err: err.message });
      return errorReply(503, 'world_full', 'this world has no room for another homestead', ctx.requestId);
    }
    if (err instanceof BadRequestError || err instanceof ValidationError || err instanceof RangeError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId);
    }
    if (err instanceof Error && err.name === 'BillingUnavailableError') {
      // FAIL CLOSED. "Ask again later", not "wear it anyway".
      return errorReply(
        503,
        'entitlements_unavailable',
        'we cannot check your purchases right now — try again shortly',
        ctx.requestId,
      );
    }
    ctx.log.error('unhandled request failure', { err });
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId);
  }
}

/* ------------------------------------------------------------------ the two route builders */

type Handler = (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>;

/** A read. Throws at module load if anyone tries to define a mutation through it. */
function define(method: 'GET', path: string, handle: Handler): Route {
  if (method !== 'GET') throw new Error(`define() is for GET only; ${method} ${path} must use defineMutation()`);
  return { method, path, pattern: compile(path), idempotency: null, handle };
}

/**
 * A mutation. The Idempotency-Key policy is a required argument, so a mutating route cannot be
 * added without deciding what makes a repeat of it the same operation.
 */
function defineMutation(
  method: 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  idempotency: IdempotencyPolicy,
  handle: Handler,
): Route {
  return { method, path, pattern: compile(path), idempotency, handle };
}

/**
 * Run a handler under the header idempotency policy.
 *
 * The key is namespaced by route, and the fingerprint covers the body minus per-attempt fields —
 * see `idempotency.ts`. A missing key is a 400 rather than a silent pass: a caller that does not
 * send one has no retry safety and should be told so, not quietly given a duplicate.
 */
async function idempotently<T>(
  ctx: RequestContext,
  deps: ServerDeps,
  route: string,
  body: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const key = headerOf(ctx.req, 'idempotency-key');
  if (!key || key.length < 1 || key.length > 200) {
    throw new BadRequestError('an Idempotency-Key header (1-200 characters) is required');
  }
  return withIdempotency(deps.sql, {
    route,
    clientKey: key,
    requestHash: requestFingerprint({ ...body, path: ctx.url.pathname }),
    run: async () => run(),
  });
}

/* ------------------------------------------------------------------ the routes */

export function buildRoutes(): Route[] {
  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz();
      return { status: report.ready ? 200 : 503, body: report };
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.();
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err });
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      };
    }),

    /* ------------------------------------------------------------- the inbound webhook */

    defineMutation('POST', '/v1/events', 'inbox', async (ctx, deps) => {
      // ══════════════════════════════════════════════════════════════════════════════════════
      // **THE ESTATE'S DELIVERY SCHEME, NOT THIS REPOSITORY'S OWN.**
      //
      // This verified `x-cloudsforge-signature: sha256=<hmac>`, a format invented here. Every
      // producer in the estate sends `cf-signature: t=<unix>,v1=<hmac>` and nothing else —
      // `identity/src/outbox.ts` is the canonical relay, and `SIGNATURE_HEADER` in
      // `contracts/packages/events/src/index.ts` is the name it sends it under. So a
      // correctly signed `identity.user.deleted` arrived with no header this route looked at and
      // was refused, every time. The subscription could never have worked, which is why the
      // erasure handler below had never run against a real delivery.
      //
      // The estate scheme is also strictly stronger than the one it replaces: it binds a
      // timestamp into the MAC and `verifyDelivery` refuses a stale or future one, so a captured
      // delivery cannot be replayed. The local scheme had no replay window at all.
      //
      // `signEvent` stays for the OUTBOUND relay in `outbox.ts`, which still signs this way to
      // its own subscribers. That is a separate defect in a separate direction and it is reported
      // rather than fixed here, because changing what this service EMITS is not erasure work.
      //
      // Order is the security property: read the raw bytes, verify over exactly those bytes, and
      // only then parse. 403 rather than 401 — this is not a bearer surface, and answering 401
      // invites a caller to go and find a token. The MAC is the credential.
      // ══════════════════════════════════════════════════════════════════════════════════════
      const raw = await readRaw(ctx.req);
      const presented = headerOf(ctx.req, SIGNATURE_HEADER);
      const verification = presented
        ? verifyDelivery(raw.toString('utf8'), presented, deps.eventSigningSecret)
        : ({ ok: false, reason: 'malformed_header' } as const);
      if (!verification.ok) {
        deps.metrics.increment('nda_events_rejected_total', { reason: 'bad_signature' });
        // The reason is logged, never returned: telling a prober "stale" rather than "mismatch"
        // tells them which half of a forgery to fix.
        ctx.log.warn('an inbound event failed its signature check', { reason: verification.reason });
        return errorReply(403, 'bad_signature', 'the event signature did not verify', ctx.requestId);
      }

      let envelope: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new BadRequestError('an event envelope must be a JSON object');
        }
        envelope = parsed as Record<string, unknown>;
      } catch {
        deps.metrics.increment('nda_events_rejected_total', { reason: 'malformed' });
        throw new BadRequestError('the event body is not valid JSON');
      }

      const topic = typeof envelope['topic'] === 'string' ? envelope['topic'] : '';
      const eventId = typeof envelope['id'] === 'string' ? envelope['id'] : '';
      if (!UUID.test(eventId)) {
        deps.metrics.increment('nda_events_rejected_total', { reason: 'malformed' });
        throw new BadRequestError('an event envelope must carry a uuid id');
      }
      if (topic !== GRANTED_TOPIC && topic !== DELETED_TOPIC) {
        deps.metrics.increment('nda_events_rejected_total', { reason: 'not_subscribed' });
        return { status: 202, body: { status: 'ignored', topic } };
      }

      const payload =
        typeof envelope['payload'] === 'object' && envelope['payload'] !== null
          ? (envelope['payload'] as Record<string, unknown>)
          : {};

      const done = deps.lifecycle.track();
      try {
        // Deduped on the SOURCE event id. A failed handler leaves no inbox row, so a redelivery is
        // reprocessed rather than swallowed.
        const outcome = await withInbox(deps.sql, topic, eventId, async (tx) => {
          if (topic !== DELETED_TOPIC) return { erased: 0 };
          // ─────────────────────────────────────────────────────────────────────────────────
          // GDPR erasure. The reasoning, and the per-table decision behind it, is the header of
          // `src/erasure.ts` — in the code, next to the behaviour, so the two cannot drift.
          //
          // ── THE FIELD IS `userId`, AND READING `subject` ERASED NOBODY ──────────────────
          //
          // This read `payload.subject` and fell through to `{ erased: 0 }` when it was absent.
          // `identity` has never sent a `subject`: `identity/src/deletion.ts` emits
          // `payload: { userId, tombstoneAt, reason }` with the envelope `key` set to the bare
          // user id. So every real deletion answered 202 `accepted`, wrote an inbox row saying
          // it had been handled, and left the account link in place — the failure mode that
          // looks exactly like compliance from the outside.
          //
          // It went unnoticed because `server.test.ts` built its own envelope carrying
          // `subject`, so the test asserted the handler against a contract that does not exist.
          // The test now sends what `identity` sends.
          // ─────────────────────────────────────────────────────────────────────────────────
          const named = typeof payload['userId'] === 'string' ? payload['userId'] : '';
          // `identity` sends a bare uuid. The `user:<uuid>` ledger spelling is stripped anyway,
          // explicitly rather than by accident, because `players.user_id` holds the bare form and
          // a prefixed value would match no row while still reporting success.
          const userId = named.startsWith('user:') ? named.slice('user:'.length) : named;
          if (!UUID.test(userId)) {
            throw new BadRequestError('identity.user.deleted requires a uuid userId');
          }
          const result = await erasePlayers(tx, userId);
          return { erased: result.players, ...result };
        });
        if (outcome.status === 'duplicate') return { status: 202, body: { status: 'duplicate' } };
        if (topic === DELETED_TOPIC && outcome.value.erased > 0) {
          // Counts and column names only — never the handle, never the user id.
          ctx.log.info('erased an account from its worlds', { survivors: outcome.value.erased });
        }
        return { status: 202, body: { status: 'accepted' } };
      } finally {
        done();
      }
    }),

    /* ------------------------------------------------------------- worlds (read) */

    define('GET', '/v1/worlds', async (ctx, deps) => {
      await requirePrincipal(ctx, deps);
      const requested = (ctx.url.searchParams.get('status') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is WorldStatus => s === 'lobby' || s === 'active' || s === 'archived');
      const statuses: WorldStatus[] = requested.length > 0 ? requested : ['lobby', 'active'];
      const worlds = await listWorlds(deps.sql, statuses);
      const summaries = await Promise.all(
        worlds.map(async (w) => ({ ...w, ...(await playerCounts(deps.sql, w.id)) })),
      );
      return { status: 200, body: { worlds: summaries } };
    }),

    define('GET', '/v1/worlds/:id', async (ctx, deps) => {
      await requirePrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      return { status: 200, body: { world: { ...world, ...(await playerCounts(deps.sql, world.id)) } } };
    }),

    define('GET', '/v1/worlds/:id/map', async (ctx, deps) => {
      await requirePrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      return {
        status: 200,
        body: { width: world.width, height: world.height, tiles: await worldMap(deps.sql, world.id) },
      };
    }),

    define('GET', '/v1/worlds/:id/roster', async (ctx, deps) => {
      await requirePrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      return { status: 200, body: { roster: await roster(deps.sql, world.id, world.day) } };
    }),

    define('GET', '/v1/worlds/:id/leaderboard', async (ctx, deps) => {
      await requirePrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      return { status: 200, body: { leaderboard: await leaderboard(deps.sql, world.id, world.day) } };
    }),

    define('GET', '/v1/worlds/:id/events', async (ctx, deps) => {
      await requirePrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      return { status: 200, body: { events: await worldEventsOf(deps.sql, world.id) } };
    }),

    define('GET', '/v1/worlds/:id/archive', async (ctx, deps) => {
      await requirePrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      if (world.status !== 'archived') throw new ConflictError('the season has not finished');
      const board = await leaderboard(deps.sql, world.id, world.day);
      const events = await worldEventsOf(deps.sql, world.id);
      return {
        status: 200,
        body: {
          worldId: world.id,
          name: world.name,
          seed: world.seed,
          seasonLength: world.seasonLength,
          finalDay: world.day,
          winners: board.slice(0, 3),
          notableEvents: events
            .filter((e) => e.type === 'season_milestone' || e.severity >= 2)
            .slice(0, 12),
          finalLeaderboard: board,
        },
      };
    }),

    /* ------------------------------------------------------------- one survivor (read) */

    define('GET', '/v1/worlds/:id/me', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await mustBeSettled(deps, world.id, userId);
      // Viewing the world is a login: it advances the streak, which feeds the morale bonus.
      await recordLogin(deps.sql, world.id, me.id, world.day);
      return { status: 200, body: { player: serialisePlayer(me) } };
    }),

    define('GET', '/v1/worlds/:id/actions', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const me = await mustBeSettled(deps, ctx.params['id'] ?? '', userId);
      return { status: 200, body: { actions: await queuedActionsOf(deps.sql, me.id) } };
    }),

    define('GET', '/v1/worlds/:id/reports', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await playerOf(deps.sql, world.id, userId);
      const dayParam = ctx.url.searchParams.get('day');
      const day = dayParam !== null && /^\d+$/.test(dayParam) ? Number(dayParam) : null;
      const limit = boundedLimit(ctx.url.searchParams.get('limit'), 200, 1000);
      return {
        status: 200,
        body: { reports: await reportsFor(deps.sql, world.id, me?.id ?? null, day, limit) },
      };
    }),

    define('GET', '/v1/worlds/:id/progress', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await mustBeSettled(deps, world.id, userId);
      const work = await recordLogin(deps.sql, world.id, me.id, world.day);
      return { status: 200, body: { progress: serialiseProgress(work) } };
    }),

    define('GET', '/v1/worlds/:id/objectives', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await mustBeSettled(deps, world.id, userId);
      await ensureProgress(deps.sql, world.id, me.id);
      return { status: 200, body: { objectives: await objectivesOf(deps.sql, me.id) } };
    }),

    define('GET', '/v1/worlds/:id/achievements', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const me = await mustBeSettled(deps, ctx.params['id'] ?? '', userId);
      return { status: 200, body: { achievements: await achievementsOf(deps.sql, me.id) } };
    }),

    define('GET', '/v1/worlds/:id/cosmetics', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const me = await mustBeSettled(deps, ctx.params['id'] ?? '', userId);
      // Fails OPEN: what someone is already wearing is ours to answer, and only the Equip buttons
      // need billing. This runs on every load, so a billing outage must not break the game screen.
      let unlocked: string[] | null = null;
      try {
        const entitlements = await deps.billing.list(userId);
        unlocked = entitlements.filter((e) => e.active).map((e) => e.sku);
      } catch (err) {
        ctx.log.warn('entitlements unavailable; serving equipped only', { err });
      }
      return {
        status: 200,
        body: { equipped: parseEquipped(me.cosmetic_style), unlocked },
      };
    }),

    /* ------------------------------------------------------------- communes (read) */

    define('GET', '/v1/worlds/:id/communes', async (ctx, deps) => {
      await requirePrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      return { status: 200, body: { communes: await listCommunes(deps.sql, world.id) } };
    }),

    define('GET', '/v1/worlds/:id/communes/:cid', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await playerOf(deps.sql, world.id, userId);
      return {
        status: 200,
        body: await communeDetail(
          deps.sql,
          world.id,
          ctx.params['cid'] ?? '',
          me?.id ?? null,
          world.day,
        ),
      };
    }),

    /* ------------------------------------------------------------- mutations */

    defineMutation('POST', '/v1/worlds', 'header', async (ctx, deps) => {
      await requireAdminPrincipal(ctx, deps);
      const body = await readJson(ctx.req);
      const { result, replayed } = await idempotently(ctx, deps, 'POST /v1/worlds', body, () =>
        createWorld(
          deps.sql,
          deps.producer,
          {
            name: requireString(body, 'name'),
            ...optionalInt(body, 'width'),
            ...optionalInt(body, 'height'),
            ...optionalInt(body, 'seasonLength'),
            ...optionalInt(body, 'tickIntervalMinutes'),
            ...(typeof body['seed'] === 'string' ? { seed: body['seed'] } : {}),
            correlationId: ctx.requestId,
          },
          withOutbox,
        ),
      );
      return { status: replayed ? 200 : 201, body: { world: result, replayed } };
    }),

    defineMutation('POST', '/v1/worlds/:id/start', 'header', async (ctx, deps) => {
      await requireAdminPrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/start',
        { worldId: world.id },
        () => startWorld(deps.sql, deps.producer, world.id, nowOf(deps), withOutbox),
      );
      return { status: 200, body: { world: result, replayed } };
    }),

    defineMutation('PUT', '/v1/worlds/:id/bots', 'header', async (ctx, deps) => {
      await requireAdminPrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const body = await readJson(ctx.req);
      const enabled = body['enabled'] === true;
      const count = typeof body['count'] === 'number' ? body['count'] : 0;
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'PUT /v1/worlds/:id/bots',
        { worldId: world.id, enabled, count },
        () => syncBots(deps.sql, deps.producer, world.id, enabled, count, withOutbox),
      );
      return { status: 200, body: { ...result, replayed } };
    }),

    /**
     * Force a tick now.
     *
     * ENQUEUES the leased job rather than resolving inline. An operator's force-tick and the
     * scheduler's sweep would otherwise be two writers with only the conditional advance between
     * them; going through the queue puts them behind one lease keyed on the world, which is the
     * whole design. It also means a slow world does not hold an HTTP connection open.
     */
    defineMutation('POST', '/v1/worlds/:id/tick', 'header', async (ctx, deps) => {
      await requireAdminPrincipal(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      if (world.status !== 'active') throw new ConflictError(`world is ${world.status}`);
      const { replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/tick',
        { worldId: world.id, day: world.day },
        async () => {
          await deps.queue.enqueue({
            kind: WORLD_TICK_KIND,
            key: world.id,
            payload: { worldId: world.id },
            onConflict: 'earliest',
          });
          return { queued: true, worldId: world.id, fromDay: world.day };
        },
      );
      return { status: 202, body: { queued: true, worldId: world.id, replayed } };
    }),

    defineMutation('POST', '/v1/worlds/:id/join', 'header', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps);
      const userId = subjectOf(ctx, principal);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const handle = handleOf(principal, userId);
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/join',
        { worldId: world.id, userId },
        () =>
          joinWorld(
            deps.sql,
            deps.producer,
            { worldId: world.id, userId, handle, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return {
        status: result.created && !replayed ? 201 : 200,
        body: { player: serialisePlayer(result.player), replayed },
      };
    }),

    defineMutation('PUT', '/v1/worlds/:id/actions', 'header', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const body = await readJson(ctx.req);
      const actions = parseActions(body['actions']);
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'PUT /v1/worlds/:id/actions',
        { worldId: world.id, userId, actions },
        () =>
          queueActions(
            deps.sql,
            deps.producer,
            { worldId: world.id, userId, actions, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return { status: 200, body: { actions: result, replayed } };
    }),

    defineMutation('POST', '/v1/worlds/:id/skills', 'header', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await mustBeSettled(deps, world.id, userId);
      const body = await readJson(ctx.req);
      const perkId = requireString(body, 'perkId');
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/skills',
        { worldId: world.id, playerId: me.id, perkId },
        () =>
          unlockPerk(
            deps.sql,
            deps.producer,
            { worldId: world.id, playerId: me.id, perkId, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return { status: 200, body: { progress: serialiseProgress(result), replayed } };
    }),

    defineMutation('POST', '/v1/worlds/:id/objectives/:oid/claim', 'header', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await mustBeSettled(deps, world.id, userId);
      const objectiveId = ctx.params['oid'] ?? '';
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/objectives/:oid/claim',
        { worldId: world.id, playerId: me.id, objectiveId },
        () =>
          claimObjective(
            deps.sql,
            deps.producer,
            { worldId: world.id, playerId: me.id, objectiveId, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return {
        status: 200,
        body: {
          objectiveId: result.objectiveId,
          rewardXp: result.rewardXp,
          rewardTokens: result.rewardTokens,
          progress: serialiseProgress(result.progress),
          replayed,
        },
      };
    }),

    defineMutation('PUT', '/v1/worlds/:id/cosmetics', 'header', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await mustBeSettled(deps, world.id, userId);
      const body = await readJson(ctx.req);
      const slot = requireString(body, 'slot');
      const itemUrn =
        body['itemUrn'] === null ? null : typeof body['itemUrn'] === 'string' ? body['itemUrn'] : undefined;
      if (itemUrn === undefined) throw new BadRequestError('itemUrn must be a string or null');
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'PUT /v1/worlds/:id/cosmetics',
        { worldId: world.id, playerId: me.id, slot, itemUrn },
        () =>
          equipCosmetic(
            deps.sql,
            deps.producer,
            deps.billing,
            { worldId: world.id, playerId: me.id, slot, itemUrn, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return { status: 200, body: { equipped: result, replayed } };
    }),

    /* ------------------------------------------------------------- communes (write) */

    defineMutation('POST', '/v1/worlds/:id/communes', 'header', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const world = await mustFindWorld(deps, ctx.params['id']);
      const me = await mustBeSettled(deps, world.id, userId);
      const body = await readJson(ctx.req);
      const name = requireString(body, 'name');
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/communes',
        { worldId: world.id, playerId: me.id, name },
        () =>
          foundCommune(
            deps.sql,
            deps.producer,
            { worldId: world.id, playerId: me.id, name, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return { status: replayed ? 200 : 201, body: { commune: result, replayed } };
    }),

    defineMutation('POST', '/v1/worlds/:id/communes/:cid/join', 'header', async (ctx, deps) => {
      const { world, me, communeId } = await communeContext(ctx, deps);
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/communes/:cid/join',
        { worldId: world.id, playerId: me.id, communeId },
        () =>
          joinCommune(
            deps.sql,
            deps.producer,
            { worldId: world.id, playerId: me.id, communeId, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return { status: 200, body: { commune: result, replayed } };
    }),

    defineMutation('POST', '/v1/worlds/:id/communes/:cid/deposit', 'header', async (ctx, deps) => {
      const { world, me, communeId } = await communeContext(ctx, deps);
      const body = await readJson(ctx.req);
      const resources = parseBag(body['resources']);
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/communes/:cid/deposit',
        { worldId: world.id, playerId: me.id, communeId, resources },
        () =>
          depositToCommune(
            deps.sql,
            deps.producer,
            { worldId: world.id, playerId: me.id, communeId, resources, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return { status: 200, body: { commune: result, replayed } };
    }),

    defineMutation('POST', '/v1/worlds/:id/communes/:cid/withdraw', 'header', async (ctx, deps) => {
      const { world, me, communeId } = await communeContext(ctx, deps);
      const body = await readJson(ctx.req);
      const resources = parseBag(body['resources']);
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/communes/:cid/withdraw',
        { worldId: world.id, playerId: me.id, communeId, resources },
        () =>
          withdrawFromCommune(
            deps.sql,
            deps.producer,
            {
              worldId: world.id,
              playerId: me.id,
              communeId,
              day: world.day,
              resources,
              correlationId: ctx.requestId,
            },
            withOutbox,
          ),
      );
      return { status: 200, body: { ...result, replayed } };
    }),

    defineMutation('POST', '/v1/worlds/:id/communes/:cid/leave', 'header', async (ctx, deps) => {
      const { world, me, communeId } = await communeContext(ctx, deps);
      const { result, replayed } = await idempotently(
        ctx,
        deps,
        'POST /v1/worlds/:id/communes/:cid/leave',
        { worldId: world.id, playerId: me.id, communeId },
        () =>
          leaveCommune(
            deps.sql,
            deps.producer,
            { worldId: world.id, playerId: me.id, communeId, correlationId: ctx.requestId },
            withOutbox,
          ),
      );
      return { status: 200, body: { ...result, replayed } };
    }),
  ];
}

/* ------------------------------------------------------------------ helpers */

const nowOf = (deps: ServerDeps): Date => (deps.now ? deps.now() : new Date());

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'));
  if (!token) throw new TokenError('no bearer token presented', 'missing');
  return deps.verifier.principal(token);
}

/** Any authenticated caller. Reads that name nobody in particular take this. */
async function requirePrincipal(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  return authenticate(ctx, deps);
}

function subjectOf(ctx: RequestContext, principal: Principal): string {
  if (principal.kind === 'user') return principal.userId;
  // A service may act for a user it names in a header, but only with the write scope.
  requireScope(principal, WRITE_SCOPE);
  const onBehalf = headerOf(ctx.req, 'x-user-id');
  if (!onBehalf) throw new ForbiddenError('x-user-id (a service must name a user)');
  return onBehalf;
}

async function requireUser(ctx: RequestContext, deps: ServerDeps): Promise<string> {
  return subjectOf(ctx, await authenticate(ctx, deps));
}

async function requireAdminPrincipal(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const principal = await authenticate(ctx, deps);
  // A world is an expensive thing to create (a whole map) and a destructive thing to reconfigure.
  // Either an admin user or a service holding this title's write scope may do it.
  if (principal.kind === 'user') {
    if (!isAdmin(principal)) throw new ForbiddenError('admin');
    return principal;
  }
  requireScope(principal, WRITE_SCOPE);
  return principal;
}

function handleOf(principal: Principal, fallback: string): string {
  if (principal.kind === 'user' && principal.handle.trim().length > 0) {
    // Capped at 20, which is the length identity's own handle rule allows. A longer one here would
    // be a handle nobody could have registered.
    return principal.handle.trim().slice(0, 20);
  }
  // A service acting for a user does not carry that user's handle, and inventing one from the id is
  // better than an empty name on a roster.
  return `settler-${fallback.slice(0, 8)}`;
}

async function mustFindWorld(deps: ServerDeps, id: string | undefined): Promise<
  Awaited<ReturnType<typeof findWorld>> & object
> {
  const world = id ? await findWorld(deps.sql, id) : null;
  if (!world) throw new NotFoundError('no such world');
  return world;
}

async function mustBeSettled(
  deps: ServerDeps,
  worldId: string,
  userId: string,
): Promise<Awaited<ReturnType<typeof playerOf>> & object> {
  const me = await playerOf(deps.sql, worldId, userId);
  if (!me) throw new NotFoundError('you have not settled in this world');
  return me;
}

async function communeContext(
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<{
  world: Awaited<ReturnType<typeof findWorld>> & object;
  me: Awaited<ReturnType<typeof playerOf>> & object;
  communeId: string;
}> {
  const userId = await requireUser(ctx, deps);
  const world = await mustFindWorld(deps, ctx.params['id']);
  const me = await mustBeSettled(deps, world.id, userId);
  return { world, me, communeId: ctx.params['cid'] ?? '' };
}

function serialisePlayer(p: {
  id: string;
  world_id: string;
  user_id: string | null;
  handle: string;
  is_bot: boolean;
  homestead_x: number;
  homestead_y: number;
  resources: unknown;
  hp: number;
  morale: number;
  defense: number;
  reputation: number;
  alive: boolean;
  ap_per_day: number;
  commune_id: string | null;
  cosmetic_style: string | null;
  joined_day: number;
}): Record<string, unknown> {
  return {
    id: p.id,
    worldId: p.world_id,
    handle: p.handle,
    isBot: p.is_bot,
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
    cosmetics: parseEquipped(p.cosmetic_style),
    joinedDay: p.joined_day,
  };
}

function serialiseProgress(w: {
  level: number;
  xp: number;
  xpToNext: number;
  skillPoints: number;
  perks: string[];
  tokens: number;
  streak: number;
  daysSurvived: number;
  contribution: number;
}): Record<string, unknown> {
  // `lastSeenDay` is deliberately absent: it is an internal streak cursor, not a fact about the
  // player, and publishing it would make it a thing a client could come to depend on.
  return {
    level: w.level,
    xp: w.xp,
    xpToNext: w.xpToNext,
    skillPoints: w.skillPoints,
    perks: w.perks,
    tokens: w.tokens,
    streak: w.streak,
    daysSurvived: w.daysSurvived,
    contribution: w.contribution,
  };
}

function boundedLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  return Math.min(max, Math.max(1, Number(raw)));
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`);
  }
  return value.trim();
}

function optionalInt(body: Record<string, unknown>, field: string): Record<string, number> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestError(`${field} must be a whole number`);
  }
  return { [field]: value };
}

function parseBag(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestError('resources must be an object of resource to whole number');
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new BadRequestError(`resources.${k} must be a whole number of units`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Parse the queued action list off the wire.
 *
 * Hand-written rather than schema-driven, and exhaustive on `type`: the ancestor's zod union
 * accepted a trade whose two bags were `z.record(z.string(), z.number().int().min(0))`, which
 * happily parses `{}` — and an empty offer was the swap-nothing-for-everything exploit. The shape
 * check lives here AND in the engine, because refusing at the route is what tells the player, and
 * refusing in the tick is what protects rows queued before the rule existed.
 */
function parseActions(value: unknown): QueuedAction[] {
  if (!Array.isArray(value)) throw new BadRequestError('actions must be an array');
  return value.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new BadRequestError(`actions[${i}] must be an object`);
    const a = raw as Record<string, unknown>;
    switch (a['type']) {
      case 'work':
        return { type: 'work' };
      case 'rest':
        return { type: 'rest' };
      case 'fortify':
        return { type: 'fortify' };
      case 'scavenge': {
        const x = a['x'];
        const y = a['y'];
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
          throw new BadRequestError(`actions[${i}] scavenge needs whole-number x and y`);
        }
        return { type: 'scavenge', x: x as number, y: y as number };
      }
      case 'raid': {
        const targetPlayerId = a['targetPlayerId'];
        if (typeof targetPlayerId !== 'string' || targetPlayerId.length === 0) {
          throw new BadRequestError(`actions[${i}] raid needs a targetPlayerId`);
        }
        return { type: 'raid', targetPlayerId };
      }
      case 'trade': {
        const targetPlayerId = a['targetPlayerId'];
        if (typeof targetPlayerId !== 'string' || targetPlayerId.length === 0) {
          throw new BadRequestError(`actions[${i}] trade needs a targetPlayerId`);
        }
        return {
          type: 'trade',
          targetPlayerId,
          offer: parseBag(a['offer'] ?? {}),
          request: parseBag(a['request'] ?? {}),
        };
      }
      default:
        throw new BadRequestError(`actions[${i}] has unknown type '${String(a['type'])}'`);
    }
  });
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError('request body is not valid JSON');
  }
}

function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } };
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return;
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`;
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Exported for `server.test.ts`, which walks the built router rather than trusting a maintained list. */
export type { Route };
