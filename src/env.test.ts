// env.ts validation — a missing required variable and a placeholder secret both refuse to boot,
// naming themselves. No database needed.
//
// A valid environment is applied to the process BEFORE `./env.ts` is imported: env.ts validates
// eagerly and calls process.exit(1) on a bad configuration, so the dynamic import below is itself a
// test that these values suffice. `loadEnv` is otherwise pure over its source.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

const BASE: Record<string, string> = {
  NDA_DATABASE_URL: 'postgres://nda:nda@127.0.0.1:5432/nda',
  IDENTITY_JWKS_URL: 'http://id/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://id',
  // GENERATED, never written. The boot guard refuses a typed value, and the former fixture here —
  // `a-real-secret-of-sufficient-length-000` — is precisely the kind of string that claimed to be
  // a secret and was not. A fixture exempt from the rule it exercises is how the placeholder in
  // micro-org #142 survived every test in the estate.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
  BILLING_URL: 'http://billing',
  WORLDS_URL: 'http://worlds',
};
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

/**
 * The credential is NOT in `BASE`, because it is not required — see the field comment in `env.ts`.
 * `NDA_SERVICE_TOKEN` is not there either: it was removed, and the tests below assert that its absence is
 * fine and its presence is reported rather than silently obeyed.
 */
const CREDENTIAL = 'cfsc_a-long-lived-credential-that-does-not-expire';

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
  // NDA_SERVICE_TOKEN was the second subject here; it is retired, and the credential that
  // replaced it takes the same placeholder and length checks for the same reasons.
  assert.throws(
    () => loadEnv({ ...BASE, NDA_IDENTITY_CREDENTIAL: 'changeme' }),
    (err: unknown) => err instanceof EnvError && /placeholder/.test(err.message),
  );
});

test('env: a short secret is refused — and for the key, the unit is DECODED BYTES', () => {
  // The credential is an opaque value identity minted, so length is still the only proxy available
  // for it. The signing key is generated, so it is measured in what an HMAC key is actually made
  // of: 32 characters of prose is not 32 bytes of key.
  assert.throws(() => loadEnv({ ...BASE, NDA_IDENTITY_CREDENTIAL: 'short' }), EnvError);
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'abc' }),
    (err: unknown) => err instanceof EnvError && /bytes of key material/.test(err.message),
  );
});

test('THE VALUE THAT SAT IN A PUBLIC REPOSITORY IS REFUSED, and every near miss with it', () => {
  // micro-org #142. Each of these cleared the old guard — a deny-list of exact strings plus a
  // 24-character floor — and each is a real string that was deployed or set in CI, not an invented
  // one. If a future edit weakens the floor, it fails against evidence rather than against taste.
  //
  // This key does not only sign here: `POST /v1/events` VERIFIES `identity.user.deleted` against
  // it, and that handler erases an account's link to every survivor it has in every world.
  for (const value of [
    'estate-only-outbox-secret-00000000000000', // 54 lines of a PUBLIC compose file, 40 chars
    'ci-only-not-a-real-secret-000000000000', // this repository's own CI, in two places
    'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4', // 32 chars, 24 bytes: right alphabet, too little key
    '0'.repeat(64), // right alphabet, right length, no entropy
  ]) {
    assert.throws(
      () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: value }),
      (err: unknown) => {
        // The refusal must not echo the value: the reason this guard exists is that the value was
        // readable, and a message carrying it moves the secret to the log collector.
        const message = (err as Error).message;
        assert.ok(!message.includes(value), 'the refusal echoed the value');
        assert.match(message, /OUTBOX_SIGNING_SECRET/);
        assert.match(message, /openssl rand -base64 48/);
        // Re-wrapped into this file's own class, so `loadEnv` still raises exactly one thing.
        return err instanceof EnvError;
      },
    );
  }
});

test('env: what the estate actually runs is accepted, in either alphabet', () => {
  assert.doesNotThrow(() =>
    loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64') }),
  );
  assert.doesNotThrow(() =>
    loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: randomBytes(32).toString('hex') }),
  );
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

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The credential that replaced NDA_SERVICE_TOKEN. See `env.ts` and `@cloudsforge/auth`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('the identity credential is read, and its absence is a null rather than a throw', () => {
  assert.equal(loadEnv({ ...BASE, NDA_IDENTITY_CREDENTIAL: CREDENTIAL }).identityCredential, CREDENTIAL)
  // Absent must LOAD — the image has to boot without one so the CI smoke test can read /livez —
  // and is caught by the hard `identity-credential` readiness probe instead.
  assert.equal(loadEnv(BASE).identityCredential, null)
})

test('a credential that is present but too short is refused, not accepted as configured', () => {
  // Absent is a deployment nobody has given a credential to. A short one is a deployment that
  // BELIEVES it has one, and would fail on its first call to a peer with a 401 that reads as
  // "identity rejected this service" rather than "nobody set this variable".
  assert.throws(
    () => loadEnv({ ...BASE, NDA_IDENTITY_CREDENTIAL: 'cfsc_short' }),
    (err: unknown) => err instanceof EnvError && err.message.includes('NDA_IDENTITY_CREDENTIAL'),
  )
})

test('identityUrl derives from the issuer, and IDENTITY_URL overrides it', () => {
  // The issuer of a token is by definition where the token came from, so demanding a fourth
  // identity variable would only create a way for the exchange and the JWKS to disagree.
  assert.equal(loadEnv(BASE).identityUrl, BASE['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv({ ...BASE, IDENTITY_URL: 'http://identity.internal:4000' }).identityUrl,
    'http://identity.internal:4000',
  )
})

test('NDA_SERVICE_TOKEN is no longer required, and being set is reported rather than obeyed', () => {
  // The retired variable. It was a 600-second token read once at boot; ten minutes into every
  // deployment every call to a peer failed and nothing could re-mint it.
  assert.equal(loadEnv(BASE).legacyServiceTokenPresent, false)
  const withLegacy = loadEnv({ ...BASE, NDA_SERVICE_TOKEN: 'a-real-looking-secret-of-sufficient-length' })
  assert.equal(withLegacy.legacyServiceTokenPresent, true)
  // And it confers nothing: setting it must not make the service look configured.
  assert.equal(withLegacy.identityCredential, null)
})
