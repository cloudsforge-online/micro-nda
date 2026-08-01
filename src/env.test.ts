// env.ts validation — a missing required variable and a placeholder secret both refuse to boot,
// naming themselves. No database needed.
//
// A valid environment is applied to the process BEFORE `./env.ts` is imported: env.ts validates
// eagerly and calls process.exit(1) on a bad configuration, so the dynamic import below is itself a
// test that these values suffice. `loadEnv` is otherwise pure over its source.

import assert from 'node:assert/strict';
import test from 'node:test';

const BASE: Record<string, string> = {
  NDA_DATABASE_URL: 'postgres://nda:nda@127.0.0.1:5432/nda',
  IDENTITY_JWKS_URL: 'http://id/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://id',
  OUTBOX_SIGNING_SECRET: 'a-real-secret-of-sufficient-length-000',
  BILLING_URL: 'http://billing',
  WORLDS_URL: 'http://worlds',
  NDA_SERVICE_TOKEN: 'another-real-token-of-good-length-0000',
};
for (const [key, value] of Object.entries(BASE)) process.env[key] = value;

const { EnvError, loadEnv, SERVICE } = await import('./env.ts');

test('env: a valid environment loads', () => {
  const env = loadEnv(BASE, 'host-1');
  assert.equal(env.port, 4110);
  assert.equal(env.databaseUrl, BASE['NDA_DATABASE_URL']);
  assert.equal(env.instanceId, 'host-1');
  assert.equal(SERVICE, 'nda');
});

test('env: a missing required variable names itself', () => {
  for (const name of Object.keys(BASE)) {
    const missing = { ...BASE } as Record<string, string | undefined>;
    delete missing[name];
    assert.throws(
      () => loadEnv(missing),
      (err: unknown) => err instanceof EnvError && new RegExp(name).test(err.message),
      `${name} can be omitted without the service refusing to start`,
    );
  }
});

test('env: a CHANGE_ME placeholder secret is refused', () => {
  // The estate's secret-hygiene job plants CHANGE_ME in .env.example on purpose; a service that
  // boots on it is a service that reaches production on it.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'CHANGE_ME' }),
    (err: unknown) => err instanceof EnvError && /placeholder/.test(err.message),
  );
  assert.throws(
    () => loadEnv({ ...BASE, NDA_SERVICE_TOKEN: 'changeme' }),
    (err: unknown) => err instanceof EnvError && /placeholder/.test(err.message),
  );
});

test('env: a short secret is refused (an entropy proxy)', () => {
  assert.throws(() => loadEnv({ ...BASE, NDA_SERVICE_TOKEN: 'short' }), EnvError);
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'abc' }), EnvError);
});

test('env: an out-of-range number is refused rather than clamped', () => {
  assert.throws(() => loadEnv({ ...BASE, PORT: '0' }), EnvError);
  assert.throws(() => loadEnv({ ...BASE, PORT: 'not-a-port' }), EnvError);
  assert.throws(() => loadEnv({ ...BASE, NDA_DATABASE_POOL_MAX: '0' }), EnvError);
  assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'chatty' }), EnvError);
});

test('env: the tick lease has a floor, because too short a lease is the double-tick defect', () => {
  // A five-second floor is not arbitrary: a lease shorter than a resolution lets a second worker
  // claim the same world mid-write. The day re-check would still refuse the write, but the lease
  // is the first line and a knob that can disable it is not a knob.
  assert.throws(() => loadEnv({ ...BASE, NDA_TICK_LEASE_MS: '100' }), EnvError);
  assert.equal(loadEnv({ ...BASE, NDA_TICK_LEASE_MS: '300000' }).tickLeaseMs, 300_000);
  assert.equal(loadEnv(BASE).tickLeaseMs, 120_000);
});

test('env: the sweep batch is bounded, so one claim cannot enqueue unbounded work', () => {
  assert.throws(() => loadEnv({ ...BASE, NDA_TICK_BATCH_SIZE: '0' }), EnvError);
  assert.throws(() => loadEnv({ ...BASE, NDA_TICK_BATCH_SIZE: '10000' }), EnvError);
});

test('env: this service declares no ledger, because it moves no value', () => {
  // Asserted as an absence. A ledger URL appearing here would be the first step of an economy this
  // title does not have — cosmetics are billing entitlements and the only integers this service
  // owns are game integers.
  const env = loadEnv(BASE) as unknown as Record<string, unknown>;
  for (const key of Object.keys(env)) {
    assert.ok(!/ledger/i.test(key), `env declares '${key}'; this service holds no money`);
  }
});
