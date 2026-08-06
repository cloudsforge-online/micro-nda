/**
 * Local fakes for the upstreams, and the database harness.
 *
 * The harness mechanism is `micro-beacon`'s (`beacon/src/testsupport.ts`) and `micro-emberkin`'s,
 * copied rather than reinvented: a real Postgres, a name-guarded DSN, the real MIGRATIONS, and a
 * truncate between cases.
 *
 * **A database test runs only against a database whose name says it is a test database.** Not a
 * convenience: `resetNda` truncates every table this service owns, and requiring "test" in the name
 * is the difference between a red build and an emptied environment — this service holds the only
 * record of a season's play.
 *
 * `fakeWorlds` is a REAL `node:http` server implementing the achievement bridge contract, so the
 * delivery job is exercised against a socket: its idempotency key, its auth header and its error
 * mapping are genuinely tested rather than stubbed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FAKE USED TO BE WRITTEN FROM THE CLIENT, WHICH IS WHY IT COULD NOT FAIL.**
 *
 * It served exactly one route — `POST /internal/achievements` — because that is the route
 * `worldsclient.ts` posted to. Real worlds serves no such route and never has. The two halves
 * agreed with each other and disagreed with reality, so the whole achievement suite passed, green,
 * for months, while every cross-title badge in the estate was silently discarded in production.
 * A fake that is a copy of the caller tests that the caller equals itself.
 *
 * It is now written from the SERVER: the routes below are `worlds/src/server.ts`'s real routes and
 * nothing else, its real gates (`worlds:title`, not `worlds:write`), its real UUID path check
 * (`itemIdOf`), its real define-before-unlock rule (`rewards.ts`) and its real
 * 201/200 split. Anything else 404s, exactly as worlds does. The bodies are parsed with
 * `@cloudsforge/contracts-worlds`' parsers — the same functions the real server would use — so a
 * client that renames a field cannot satisfy this fake either.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import {
  SCOPE_FOR,
  achievementIdempotencyKey,
  isTitleId,
  parseAchievementDefinition,
  parseAchievementUnlock,
} from '@cloudsforge/contracts-worlds';
import { migrate, type Sql as DbSql } from '@cloudsforge/db';
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry';
import { MIGRATIONS, TABLES } from './migrations.ts';
import { registerServiceMetrics } from './server.ts';
import type { EntitlementReader, EntitlementWire } from './billingclient.ts';
import type { AchievementPost, WorldsClient } from './worldsclient.ts';
import type { Db } from './outbox.ts';

export const ALICE = '11111111-1111-4111-8111-111111111111';
export const BOB = '22222222-2222-4222-8222-222222222222';
export const CAROL = '33333333-3333-4333-8333-333333333333';

/* ------------------------------------------------------------------ the fake worlds service */

/** This service's title id in the fake registry. A UUID, because `itemIdOf` accepts nothing else. */
export const NDA_TITLE_ID = '9d1a7c40-3f4b-4a2e-8b77-0f2c6d5e1a34';

export interface FakeWorlds {
  readonly baseUrl: string;
  readonly token: string;
  /** Unlocks that actually landed, in worlds' vocabulary — `key`, never `code`. */
  readonly posted: ReadonlyArray<{ userId: string; key: string; idempotencyKey: string }>;
  /** Achievement keys worlds has been told about, via `PUT /v1/titles/:id/achievements`. */
  readonly defined: ReadonlySet<string>;
  /** Every path worlds was asked for, including the ones it 404'd. */
  readonly requested: ReadonlyArray<string>;
  /** Make the next N requests fail with a 503, for the retry tests. */
  failNext(count: number): void;
  close(): Promise<void>;
}

export interface FakeWorldsOptions {
  readonly token?: string;
  /**
   * The scopes the presented token carries. Defaults to what the unlock route actually demands.
   * A test can hand over `['worlds:write']` — what this client claimed for months — and watch the
   * delivery fail, which is the only way that gate is a gate rather than a comment.
   */
  readonly scopes?: readonly string[];
  /** Register this service under a different slug, to exercise the unregistered-title path. */
  readonly slug?: string;
}

export async function fakeWorlds(options: FakeWorldsOptions | string = {}): Promise<FakeWorlds> {
  const opts: FakeWorldsOptions = typeof options === 'string' ? { token: options } : options;
  const token = opts.token ?? 'worlds-token';
  const scopes = opts.scopes ?? [SCOPE_FOR.unlockAchievement];
  const slug = opts.slug ?? 'nda';

  const posted: Array<{ userId: string; key: string; idempotencyKey: string }> = [];
  const defined = new Set<string>();
  const requested: string[] = [];
  const unlocked = new Set<string>();
  let failures = 0;

  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      const payload = `${JSON.stringify(body)}\n`;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    };
    const readBody = (then: (body: unknown) => void): void => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          then(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
        } catch {
          reply(400, { error: { code: 'bad_request', message: 'not json' } });
        }
      });
    };
    /** worlds/src/server.ts — authenticate, then `requireScope(principal, TITLE_SCOPE)`. */
    const authorised = (): boolean => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        reply(401, { error: { code: 'unauthenticated', message: 'token required' } });
        return false;
      }
      if (!scopes.includes(SCOPE_FOR.unlockAchievement)) {
        reply(403, {
          error: { code: 'forbidden', message: `missing required authority: ${SCOPE_FOR.unlockAchievement}` },
        });
        return false;
      }
      return true;
    };

    const url = new URL(req.url ?? '/', 'http://localhost');
    requested.push(`${req.method ?? 'GET'} ${url.pathname}`);

    if (url.pathname === '/livez') return reply(200, { ok: true });
    if (failures > 0 && url.pathname !== '/v1/titles') {
      failures -= 1;
      return reply(503, { error: { code: 'unavailable', message: 'restarting' } });
    }

    // worlds/src/server.ts — the registry, public and unauthenticated.
    if (url.pathname === '/v1/titles' && req.method === 'GET') {
      return reply(200, {
        titles: [
          { id: NDA_TITLE_ID, slug, name: 'Ninety Days After', status: 'live', capabilities: [], assetScopes: [] },
        ],
      });
    }

    // worlds/src/server.ts and :775 — the only two achievement writes that exist, both under a
    // UUID path. `itemIdOf` answers 404 to a path parameter that is not a UUID, which is
    // exactly what a client sending a slug used to get.
    const define = /^\/v1\/titles\/([^/]+)\/achievements$/.exec(url.pathname);
    const unlock = /^\/v1\/titles\/([^/]+)\/achievements\/unlock$/.exec(url.pathname);
    const id = define?.[1] ?? unlock?.[1];
    if (id !== undefined && !isTitleId(id)) {
      return reply(404, { error: { code: 'not_found', message: 'no such record' } });
    }
    if (id !== undefined && id !== NDA_TITLE_ID) {
      return reply(404, { error: { code: 'not_found', message: 'no such title' } });
    }

    if (define && req.method === 'PUT') {
      if (!authorised()) return undefined;
      return readBody((body) => {
        const parsed = parseAchievementDefinition(body);
        if (!parsed.ok) {
          return reply(400, { error: { code: 'bad_request', message: parsed.errors.join('; ') } });
        }
        defined.add(parsed.value.key);
        return reply(200, {
          achievement: { ...parsed.value, rewardShards: parsed.value.rewardShards.toString() },
        });
      });
    }

    if (unlock && req.method === 'POST') {
      if (!authorised()) return undefined;
      return readBody((body) => {
        const parsed = parseAchievementUnlock(body);
        if (!parsed.ok) {
          return reply(400, { error: { code: 'bad_request', message: parsed.errors.join('; ') } });
        }
        // worlds/src/rewards.ts — an unlock of an achievement worlds was never told about
        // is refused, and the server maps that to 400.
        if (!defined.has(parsed.value.key)) {
          return reply(400, {
            error: { code: 'bad_request', message: `no achievement ${parsed.value.key} for this title` },
          });
        }
        const seen = `${parsed.value.userId}:${parsed.value.key}`;
        const fresh = !unlocked.has(seen);
        if (fresh) {
          unlocked.add(seen);
          posted.push({
            userId: parsed.value.userId,
            key: parsed.value.key,
            idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
          });
        }
        // :790 — 201 on a fresh unlock, 200 on one that had already happened.
        return reply(fresh ? 201 : 200, {
          unlocked: fresh,
          achievement: { key: parsed.value.key },
        });
      });
    }

    return reply(404, { error: { code: 'not_found', message: 'no route' } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    posted,
    defined,
    requested,
    failNext(count) {
      failures = count;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A WorldsClient backed by the fake worlds server. */
export async function worldsClientFor(worlds: FakeWorlds): Promise<WorldsClient> {
  const { httpWorldsClient } = await import('./worldsclient.ts');
  return httpWorldsClient({ baseUrl: worlds.baseUrl, token: () => worlds.token, deadlineMs: 5_000 });
}

/**
 * A WorldsClient that records posts in-process (no socket), for unit-level tests.
 *
 * It derives the idempotency key the same way the real client does — through the contract — rather
 * than reading one off the post. The old fake trusted a caller-supplied `idempotencyKey` field,
 * so a caller that derived it from the job id would have looked correct here.
 */
export function fakeWorldsClient(): WorldsClient & { readonly posts: readonly AchievementPost[] } {
  const posts: AchievementPost[] = [];
  const seen = new Set<string>();
  return {
    posts,
    async postAchievement(post) {
      const key = achievementIdempotencyKey({
        titleId: NDA_TITLE_ID,
        userId: post.userId,
        key: post.key,
      });
      const fresh = !seen.has(key);
      if (fresh) {
        seen.add(key);
        posts.push(post);
      }
      return { unlocked: fresh };
    },
  };
}

/* ------------------------------------------------------------------ billing */

export interface FakeBilling extends EntitlementReader {
  grant(userId: string, entitlement: EntitlementWire): void;
  setUnavailable(value: boolean): void;
}

export function fakeBilling(): FakeBilling {
  const owned = new Map<string, EntitlementWire[]>();
  let unavailable = false;
  const reader: FakeBilling = {
    grant(userId, entitlement) {
      owned.set(userId, [...(owned.get(userId) ?? []), entitlement]);
    },
    setUnavailable(value) {
      unavailable = value;
    },
    async list(userId) {
      if (unavailable) {
        const { BillingUnavailableError } = await import('./billingclient.ts');
        throw new BillingUnavailableError('the fake billing is unavailable');
      }
      return owned.get(userId) ?? [];
    },
    async owns(userId, itemUrn, scope) {
      const { skuOf } = await import('./billingclient.ts');
      const sku = skuOf(itemUrn);
      const entitlements = await reader.list(userId);
      return entitlements.some((entitlement) => {
        if (!entitlement.active || entitlement.sku !== sku) return false;
        if (!scope || scope === '*') return true;
        return entitlement.scope === 'platform' || entitlement.scope === `title:${scope}`;
      });
    },
  };
  return reader;
}

/* ------------------------------------------------------------------ the database harness */

const url = process.env['NDA_TEST_DATABASE_URL'];

export const enabled = Boolean(url && /test/i.test(url));

export const skip = enabled ? false : 'set NDA_TEST_DATABASE_URL (name must contain "test")';

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled');
  return postgres(url!, { max, onnotice: () => {} });
}

/** Bring the schema up. Idempotent — the real MIGRATIONS, so the constraints cannot drift. */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'nda-test' });
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetNda(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`);
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'nda-test', sink: () => {} });
}

/** Registered exactly as `index.ts` registers them, so a test scrapes what production scrapes. */
export function testMetrics(): Metrics {
  return registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())));
}

export function asDb(sql: postgres.Sql): Db {
  return sql as unknown as Db;
}

/** Sign an envelope the way a producer's relay would, for the inbound-webhook tests. */
/**
 * A delivery signed the way the ESTATE signs one, not the way this repository used to.
 *
 * `signDelivery` from `@cloudsforge/contracts-events` is the exact function every outbox relay
 * calls (`identity/src/outbox.ts`), so a test built on it exercises the bytes and the header
 * name a real producer sends. It used to call this repository's own `signEvent`, which produced
 * `x-cloudsforge-signature: sha256=<hmac>` — a format nothing in the estate emits — so the inbound
 * route was only ever tested against a producer that does not exist.
 *
 * The header NAME is returned alongside the value for the same reason: a test that hardcodes it is
 * a test that keeps passing after the route stops agreeing with the estate.
 */
export async function signedEvent(
  secret: string,
  envelope: Record<string, unknown>,
): Promise<{ body: string; signature: string; header: string }> {
  const { SIGNATURE_HEADER, signDelivery } = await import('@cloudsforge/contracts-events');
  const body = JSON.stringify(envelope);
  return { body, signature: signDelivery(body, secret), header: SIGNATURE_HEADER };
}

/* ------------------------------------------------------------------ world fixtures */

/**
 * A started world with N settled humans, ready to be ticked.
 *
 * The seed is fixed by the caller so a test that asserts on a world event can name the day it
 * expects one on. `tickIntervalMinutes: 1` keeps `next_tick_at` near enough to now that a test can
 * make a world due by asking for a date one minute later, rather than by editing the row.
 */
export async function seedWorld(
  sql: postgres.Sql,
  options: {
    seed?: string;
    name?: string;
    humans?: readonly { userId: string; handle: string }[];
    seasonLength?: number;
    width?: number;
    height?: number;
  } = {},
): Promise<{ worldId: string; playerIds: string[] }> {
  const { createWorld, startWorld, joinWorld } = await import('./worlds.ts');
  const { withOutbox } = await import('./outbox.ts');
  const db = asDb(sql);

  const world = await createWorld(
    db,
    'nda',
    {
      name: options.name ?? 'test world',
      width: options.width ?? 16,
      height: options.height ?? 16,
      seasonLength: options.seasonLength ?? 90,
      tickIntervalMinutes: 1,
      ...(options.seed ? { seed: options.seed } : {}),
    },
    withOutbox,
  );
  await startWorld(db, 'nda', world.id, new Date(), withOutbox);

  const playerIds: string[] = [];
  for (const h of options.humans ?? [{ userId: ALICE, handle: 'alice' }]) {
    const { player } = await joinWorld(
      db,
      'nda',
      { worldId: world.id, userId: h.userId, handle: h.handle },
      withOutbox,
    );
    playerIds.push(player.id);
  }
  return { worldId: world.id, playerIds };
}
