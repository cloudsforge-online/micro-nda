/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out has
 * nothing to justify it.
 *
 * Two behaviours are deliberate estate house style:
 *   1. A missing variable names itself (rather than surfacing as an unreadable driver error later).
 *   2. A secret that is not SHAPED like a generated one is refused outright — a placeholder that
 *      boots is a placeholder that reaches production. The rule is `@cloudsforge/secrets`, shared
 *      with the whole estate, and it replaced a per-service deny-list that could not fail: see
 *      `requiredSigningSecret` below and micro-org #142.
 *
 * The ancestor read `GAME_DATABASE_URL`, `NIMBUS_JWKS_URL`, `NIMBUS_ISSUER`, `PAY_API_URL`,
 * `CORS_ORIGINS`, `TRUST_PROXY`, `GAME_PORT` and `GAME_RATE_LIMIT_MAX`
 * (`ninety-days-after/services/game/src/env.ts`). CORS and the rate limiter are gone: the
 * browser never talks to this service directly any more — `worlds-web` is a separate repository
 * and the edge terminates both concerns — and a limiter keyed on a spoofable forwarded address was
 * the thing the ancestor's own comment there was apologising for.
 *
 * There is deliberately NO ledger URL and no ledger client. This service moves no value at all:
 * cosmetics are billing entitlements, achievements are worlds rows, and the only integers it owns
 * are game integers. A ledger client here would be the first step of an economy this title does
 * not have.
 */

import { hostname } from 'node:os';
import { assertGeneratedSecret, assertServiceCredential, SecretError } from '@cloudsforge/secrets';

/** This service's own name. A constant — a property of the repository, not the deployment. */
export const SERVICE = 'nda';


export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

type Source = Readonly<Record<string, string | undefined>>;

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`);
  return value;
}

/**
 * `@cloudsforge/secrets` raises `SecretError`; this file's contract is that `loadEnv` raises
 * `EnvError`, and every test and caller in this repository is written to that.
 *
 * So the shape failures are re-wrapped rather than rethrown, and the message is carried across
 * VERBATIM: it already names the variable and the command that fixes it, and by construction it
 * contains no part of the value. Only the class changes, so there is one thing to catch here and
 * nothing to re-derive by matching on text.
 */
function asEnvError(err: unknown): never {
  throw err instanceof SecretError ? new EnvError(err.message) : err;
}

/**
 * The estate's shared event-bus HMAC key, held to a SHAPE rather than to a deny-list.
 *
 * This service does not merely sign with it: it VERIFIES inbound deliveries on `POST /v1/events`
 * against it, and one of the two topics that arrive there is `identity.user.deleted`, which erases
 * an account's link to every survivor it has in every world. A forgeable key is an anonymous
 * erasure endpoint.
 *
 * The `requiredSecret` this replaced could not fail. It refused a fixed list of exact strings and
 * anything under 24 characters, and the value that sat on 54 lines of a PUBLIC compose file —
 * `estate-only-outbox-secret-00000000000000` — was on no list and was 40 characters, so it passed
 * every service in the estate (micro-org #142). A check that cannot fail is worse than no check,
 * because the absence of an alarm gets read as the absence of a problem.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. It has no NODE_ENV exemption and no escape
 * hatch, so CI generates a real value per run rather than being let through.
 *
 * `required` rather than a length check first, deliberately: the weaker checks are a strict subset
 * of the stronger ones, and running them first would answer a 40-character placeholder with "must
 * be at least 24 characters" — true, useless, and pointing the operator at the wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name);
  try {
    assertGeneratedSecret(name, value);
  } catch (err) {
    asEnvError(err);
  }
  return value;
}

/**
 * A service credential that may be absent, but must be a REAL credential if present.
 *
 * The distinction matters: absent is a deployment that has not been given one yet and is reported
 * by `/readyz`; a placeholder is a deployment that believes it HAS one, and fails on its first call
 * to a peer with a 401 that reads as "identity rejected this service" rather than "nobody set this
 * variable".
 *
 * ── THE CLASS WAS MEASURED, NOT READ OFF THE NAME ─────────────────────────────────────────────
 *
 * The deny-list this replaces sat under a header calling `NDA_IDENTITY_CREDENTIAL` an OPAQUE
 * credential that "cannot be held to a shape". THAT WAS WRONG, AND A WRONG COMMENT IS BELIEVED.
 * Measured on the live estate, both networks, 2026-08-06:
 *
 *     mainnet   cfsc_ + 43 characters, base64url body
 *     testnet   cfsc_ + 43 characters, base64url body, CONTAINS A HYPHEN
 *
 * It has a shape and identity defines it: `cfsc_` then base64url. Opaque is the class for a value
 * a VENDOR issued — an SMTP password, a chain node's RPC password — where the alphabet belongs to
 * somebody else. This is minted by micro-identity, in this estate, to a format this estate wrote.
 *
 * It is not `assertGeneratedSecret` either, which is the obvious-looking reuse: a credential is
 * neither wholly base64 nor wholly hex — the underscore in its own prefix disqualifies it — so
 * that rule would refuse every credential ever minted and exit 1 at boot on BOTH networks.
 *
 * AND THE HYPHEN IS THE TRAP. Testnet's body carries one and mainnet's does not. A "no hyphens"
 * rule is correct for a generated key, reads as obviously right in review, passes mainnet and
 * kills testnet at boot. `@cloudsforge/secrets` pins a hyphenated fixture so that regression fails
 * CI rather than one estate.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim();
  if (!value) return null;
  try {
    assertServiceCredential(name, value);
  } catch (err) {
    asEnvError(err);
  }
  return value;
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`);
  }
  return value;
}

export interface Env {
  readonly port: number;
  readonly env: string;
  readonly version: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Rule 1: one database, named by this service's own variable. */
  readonly databaseUrl: string
  /**
   * The TESTNET database, when this deployment serves both networks. Empty means single-network —
   * `networkSql` then holds one handle and REFUSES a testnet request rather than answering it out
   * of mainnet rows (micro-deploy `docs/network-consolidation.md` §2.2).
   */
  readonly databaseUrlTestnet: string
  /**
   * The network to assume when a request carries no `CF-Network`, or empty to refuse. Set for
   * `pnpm dev`, which has no gateway. Never in production, where guessing makes a routing fault a
   * silent cross-network write.
   */
  readonly singleNetwork: string
  readonly databasePoolMax: number;
  readonly identityJwksUrl: string;
  readonly identityIssuer: string;
  /** HMAC key for outbound event signatures AND for verifying inbound ones (POST /v1/events). */
  readonly outboxSigningSecret: string;
  readonly instanceId: string;

  readonly billingUrl: string;
  /** Worlds owns the shared profile + achievements; this service posts to it via the bridge. */
  readonly worldsUrl: string;

  /**
   * Where identity is, for `POST /service-tokens/exchange`.
   *
   * Defaults to `IDENTITY_ISSUER`, which is already required and is identity's own base URL — the
   * issuer of a token is by definition where the token came from. `IDENTITY_URL` overrides it for a
   * deployment where the two genuinely differ. Deriving rather than demanding a fourth identity
   * variable keeps them in step: pointing the exchange at one identity and trusting the JWKS of
   * another fails with a signature error nobody reads as a configuration mistake.
   */
  readonly identityUrl: string

  /**
   * **The long-lived credential this service exchanges for short-lived tokens.**
   *
   * It replaces `NDA_SERVICE_TOKEN`, which was a 600-second token read once at boot
   * (identity/src/tokens.ts). Ten minutes into any deployment it expired and every call to a
   * peer failed; nothing could re-mint it, because minting requires the `admin` role. A credential
   * is not a token: it confers nothing by itself, it is revocable, and it survives a restart. See
   * `micro-identity` `src/serviceCredentials.ts` and `@cloudsforge/auth` `ServiceTokenProvider`.
   *
   * OPTIONAL, AND DELIBERATELY SO — but not "unconfigured is fine". It is optional because the
   * image must be able to BOOT without one: CI's startup smoke test builds the container, migrates
   * it and reads `/livez`, and that job's environment is fixed in a workflow file. Making this
   * required would fail that job rather than this service.
   *
   * The absence is not silent. `/readyz` reports the `identity-credential` probe as a HARD failure,
   * so an unconfigured replica never takes traffic, and every upstream call fails closed with 503
   * rather than being sent unauthenticated.
   */
  readonly identityCredential: string | null

  /**
   * Whether the retired `NDA_SERVICE_TOKEN` is still set.
   *
   * Read for exactly one purpose: to say so at boot. An operator who redeploys with the old
   * variable and not the new one would otherwise get a service that looks configured and is not.
   */
  readonly legacyServiceTokenPresent: boolean
  readonly upstreamDeadlineMs: number;

  /**
   * How long the `world.tick` lease is held.
   *
   * A MEANINGFUL SAFETY VALUE, not a knob. A day resolution that outlives its lease can be
   * claimed by a second worker while the first is still writing, which is the double-XP defect
   * 04-domain-model §10.5 names against `world.tick`. The conditional day advance in
   * `advanceDay` makes the second worker's write a no-op even then, but the lease is the first
   * line and should comfortably exceed the slowest world's resolution.
   */
  readonly tickLeaseMs: number;
  /** How many worlds one sweep may enqueue. Bounds the work a single claim can create. */
  readonly tickBatchSize: number;
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info');
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`);
  }

  return {
    port: integer(source, 'PORT', 4110, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'NDA_DATABASE_URL'),
    databaseUrlTestnet: source['NDA_DATABASE_URL_TESTNET'] ?? '',
    singleNetwork: source['CF_NETWORK_SINGLE'] ?? '',
    databasePoolMax: integer(source, 'NDA_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    billingUrl: required(source, 'BILLING_URL'),
    worldsUrl: required(source, 'WORLDS_URL'),
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    // Not `requiredSecret`: see the field comment. The absence is caught by `/readyz`, which is
    // a check that can fail, rather than by a boot CI cannot perform.
    identityCredential: optionalCredential(source, 'NDA_IDENTITY_CREDENTIAL'),
    legacyServiceTokenPresent: (source['NDA_SERVICE_TOKEN']?.trim() ?? '').length > 0,
    upstreamDeadlineMs: integer(source, 'NDA_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),

    tickLeaseMs: integer(source, 'NDA_TICK_LEASE_MS', 120_000, 5_000, 900_000),
    tickBatchSize: integer(source, 'NDA_TICK_BATCH_SIZE', 50, 1, 500),
  };
}

function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  );
  process.exit(1);
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname());
  } catch (err) {
    fatalConfig(err);
  }
})();
