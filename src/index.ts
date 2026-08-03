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
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db';
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
const sql = postgres(env.databaseUrl, { max: env.databasePoolMax, onnotice: () => {} });

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
const queue = new JobQueue(sql as unknown as JobsSql, {
  owner: env.instanceId,
  leaseMs: env.tickLeaseMs,
});

// 8. Routes.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer });
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: db,
  producer: SERVICE,
  billing,
  queue,
  eventSigningSecret: env.outboxSigningSecret,
  beforeScrape: async () => {
    const stats = await queue.stats();
    metrics.set('jobs_pending', stats.pending);
    metrics.set('jobs_overdue', stats.overdue);
  },
});

// 9. The job runner, started before listen().
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind });
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind });
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind });
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind });
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind });
      }
    }
    onRunnerEvent(queue, logger)(event);
  },
});
registerHandlers(runner, {
  sql: db,
  logger,
  metrics,
  worlds,
  producer: SERVICE,
  signingSecret: env.outboxSigningSecret,
  tickBatchSize: env.tickBatchSize,
  queue,
});
await seedRecurring(queue);
runner.start();

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
  const clean = await runner.stop(20_000);
  logger.info('job runner stopped', { clean });
});
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    }),
);
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 });
  logger.info('database pool closed');
});

installSignalHandlers(lifecycle);
