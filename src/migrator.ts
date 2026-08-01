/**
 * The one-shot migrator.
 *
 * A separate process, run as an init container or a Kubernetes Job, and **never** called from
 * `index.ts`: a slow migration must not stall the service's health, two replicas booting together
 * must not race on the schema, and a rollback of the image must not silently be a rollback of the
 * database. Safe to run concurrently from N processes — `@cloudsforge/db` serialises them on an
 * advisory lock derived from the service name, and the losers observe an empty pending set.
 */

import postgres from 'postgres';
import { migrate, type Sql } from '@cloudsforge/db';
import { Logger } from '@cloudsforge/telemetry';
import { SERVICE, env } from './env.ts';
import { BASELINE_VERSION, MIGRATIONS } from './migrations.ts';

const log = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
}).child({ step: 'migrate' });

// A tiny pool: the whole run happens on one reserved connection.
const sql = postgres(env.databaseUrl, { max: 2, onnotice: () => {} });

try {
  const result = await migrate(sql as unknown as Sql, MIGRATIONS, {
    service: SERVICE,
    baselineVersion: BASELINE_VERSION,
    onLog: (message, fields) => log.info(message, fields),
  });
  log.info('migrations complete', {
    from: result.alreadyAt,
    to: result.nowAt,
    applied: result.applied.map((a) => `${a.version}:${a.name}`),
  });
  await sql.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  log.fatal('migration failed', { err });
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
