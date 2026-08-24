/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * It deliberately does NOT run migrations — that is `src/migrator.ts`, a separate one-shot — and it
 * asserts the schema version and refuses to serve below it, because below `SCHEMA_VERSION` the
 * jobs, outbox and idempotency tables may not exist, and the `players_world_user_uniq` index that
 * keeps one account to one survivor may not exist either.
 */

import postgres from 'postgres';
import { assertSchemaAtLeast, type Sql as DbSql , networkSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs';
import { Verifier, serviceTokenProbe } from '@cloudsforge/auth';
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle';
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry';
import { SERVICE, env } from './env.ts';
import { SCHEMA_VERSION } from './migrations.ts';
import { createServer, registerServiceMetrics } from './server.ts';
import { onRunnerEvent, registerHandlers, seedRecurring } from './jobs.ts';
import { buildUpstreams } from './upstreams.ts';
import type { Db } from './outbox.ts';

// ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
//
// Every per-network map in this file keys its primary entry by THIS, never by the literal
// `mainnet`. Same image, same code, different env: a testnet pod that hardcodes the key holds
// its own database and its own queue under the other estate's name, and then refuses — or, when
// the throw escapes a request listener, DIES — on every request the gateway correctly stamped.
//
// It happened twice. The handle, then the job plane.
const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet';


// 1. Environment — validated on import of ./env.ts.

// 2. Telemetry, before anything that can fail.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
});
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())));
logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION });

// 3. The database pool.
const poolOptions = { max: env.databasePoolMax, onnotice: () => {} }
const sql = postgres(env.databaseUrl, poolOptions)

// ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
//
// `NDA_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment until the
// consolidation reaches this service. `networkSql` then holds one handle and REFUSES a testnet
// request rather than answering it out of mainnet rows — substituting would be a query that
// SUCCEEDS against the other estate and says nothing.
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined;

// 4. Assert the schema. This does NOT migrate.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION);
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION });
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

// 5. The upstreams, and the credential that authenticates every call to them. There is still no
//    ledger client, on purpose: this service moves no value. See env.ts. The wiring itself lives
//    in `./upstreams.ts` and is covered by `servicetoken.test.ts` — it was untestable here, and
//    what was untestable here was wrong for months. See that file.
const { identityTokens, billing, worlds } = buildUpstreams(env, {
  onEvent: (event) => {
    if (event.kind === 'exchange_failed') {
      // `warn`, not `error`, while a usable token is still held: the 20% slack after the refresh
      // point exists precisely so a few of these are survivable and uninteresting.
      const level = event.hadUsableToken ? 'warn' : 'error';
      logger[level]('service token exchange failed', {
        err: event.err,
        hadUsableToken: event.hadUsableToken,
      });
    } else if (event.kind === 'minted') {
      logger.info('service token minted', {
        service: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      });
    } else {
      logger.warn('service token', { event: event.kind, url: event.url });
    }
  },
});

if (!identityTokens) {
  // Not `fatal` and exit: the image must be able to boot without this so CI's startup smoke test
  // can read /livez, and a service that refuses to start is a service whose logs nobody reads.
  // `/readyz` is where the absence is enforced — the `identity-credential` probe below is hard,
  // so an unconfigured replica takes no traffic.
  logger.error('NDA_IDENTITY_CREDENTIAL is not set; every call to a peer will fail 503', {
    hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
  });
}
if (env.legacyServiceTokenPresent) {
  logger.error('NDA_SERVICE_TOKEN is set and is IGNORED', {
    hint: 'it was a 600-second token read once at boot; NDA_IDENTITY_CREDENTIAL replaces it',
  });
}

// 6. Lifecycle and probes.
//
// Postgres is HARD: without it there is no world to resolve and no state to serve, so a replica
// that cannot reach it must leave the load balancer's rotation.
//
// The rest are SOFT, deliberately. Billing gates the equip button and worlds receives achievements;
// neither is on the path of the thing this service exists to do, which is advance a world. Making
// them hard would take a whole game out of rotation because a shop was restarting — and, worse,
// would stop the very job backlog that drains once they return.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
});
lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
        }),
      ]),
    ),
  )
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  // HARD, unlike the two soft upstream probes below. It does not report a peer having a bad
  // minute — it fails only when no credential is configured at all, which is a deployment that
  // cannot make a single authenticated call and will not fix itself. An identity OUTAGE returns
  // warn, deliberately, so one bad minute in identity does not empty every balancer in the estate.
  .addProbe(serviceTokenProbe(identityTokens))
  .addProbe(httpProbe('billing', `${env.billingUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('worlds', `${env.worldsUrl}/livez`, { kind: 'soft' }));

// 7. Shared bundles.
const db = sql as unknown as Db;
// ── ONE PLANE PER NETWORK ───────────────────────────────────────────────────────────────────
//
// Pool, handle and queue together. The QUEUE is per-network as much as the pool is: an enqueue is
// a WRITE, and a job claimed by a runner holding the other estate's handle applies to the other
// estate's rows and leaves a completed row behind saying it went exactly as intended.
const queueFor = (handle: typeof sql) =>
  new JobQueue(handle as unknown as JobsSql, {
  owner: env.instanceId,
  leaseMs: env.tickLeaseMs,
});

const planes = [
  { network: ownNetwork, pool: sql, db, queue: queueFor(sql) },
  ...(sqlTestnet && ownNetwork !== 'testnet'
    ? [{ network: 'testnet' as const, pool: sqlTestnet, db: sqlTestnet as unknown as Db, queue: queueFor(sqlTestnet) }]
    : []),
]
const planeFor = (network: 'mainnet' | 'testnet') => {
  const plane = planes.find((p) => p.network === network)
  if (!plane) throw new Error(`no plane for network ${network}`)
  return plane
}

// 8. Routes.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer });
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
  sql: networkSql({
    [ownNetwork]: sql as unknown as RuntimeSql,
    ...(sqlTestnet && ownNetwork !== 'testnet' ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  }),
  // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
  // call, because those go container to container and never reach the gateway that stamps one.
  // `requestNetwork` still prefers the header, so this cannot mask a mis-stamped external
  // request; it only answers the internal callers that never had one.
  singleNetwork: ownNetwork,
  producer: SERVICE,
  billing,
  // The boot-time value. `forRequest` in server.ts replaces it with this request's network before
  // any route sees it — an enqueue into the other estate's queue is a write nothing would flag.
  queue: planeFor(ownNetwork).queue,
  queueFor: (network: 'mainnet' | 'testnet') => planeFor(network).queue,
  eventSigningSecret: env.outboxSigningSecret,
  beforeScrape: async () => {
    // Per network. Summed across both queues the gauge reads healthy while one estate's
    // backlog grows for ever — micro-org#398 in another form.
    for (const plane of planes) {
      const stats = await plane.queue.stats()
      metrics.set('jobs_pending', stats.pending, { network: plane.network })
      metrics.set('jobs_overdue', stats.overdue, { network: plane.network })
    }
  },
});

// 9. The job runner, started before listen().
// ── ONE RUNNER PER NETWORK ──────────────────────────────────────────────────────────────────
//
// Bulkheaded deliberately. A single runner over a single queue would drain mainnet and leave the
// other estate's jobs to accumulate for ever, and every handler would hold the mainnet handle —
// so the work would apply to the wrong rows and record success.
const runners = planes.map((plane) => {
  const runner = new JobRunner({
      queue: plane.queue,
    concurrency: 4,
    pollMs: 1_000,
    shouldClaim: () => lifecycle.claimingJobs,
    onEvent: (event) => {
      if (event.kind) {
        const labels = { kind: event.kind, network: plane.network }
        if (event.type === 'claimed') metrics.increment('jobs_claimed_total', labels);
        if (event.type === 'completed') metrics.increment('jobs_completed_total', labels);
        if (event.type === 'failed') metrics.increment('jobs_failed_total', labels);
        if (event.type === 'dead') metrics.increment('jobs_dead_total', labels);
        if (event.durationMs !== undefined) {
          metrics.observe('jobs_duration_ms', event.durationMs, labels);
        }
      }
      onRunnerEvent(plane.queue, logger)(event);
    },
  });
  registerHandlers(runner, {
    sql: plane.db,
    logger,
    metrics,
    worlds,
    producer: SERVICE,
    signingSecret: env.outboxSigningSecret,
    tickBatchSize: env.tickBatchSize,
    queue: plane.queue,
  });
  return runner
})
// Seeded into EVERY queue: an estate with no recurring sweep is half-running, not dormant.
for (const plane of planes) await seedRecurring(plane.queue)
for (const runner of runners) runner.start();

// 10. Listen.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(env.port, () => resolve());
});
logger.info('listening', { port: env.port });

// 11. Ready.
lifecycle.markReady();

lifecycle.onShutdown(async () => {
  // The runner stops FIRST, so a day resolution in flight is allowed to finish and commit rather
  // than being cut off mid-transaction with its pool closed under it.
  const clean = (await Promise.all(runners.map((r) => r.stop(20_000)))).every(Boolean)
  logger.info('job runners stopped', { clean, runners: runners.length })
});
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    }),
);
lifecycle.onShutdown(async () => {
  await Promise.all(planes.map((plane) => plane.pool.end({ timeout: 5 })))
  logger.info('database pools closed', { networks: planes.length })
});

installSignalHandlers(lifecycle);
