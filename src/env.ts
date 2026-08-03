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
 *   2. A known placeholder is refused outright — a default secret that boots is a default secret
 *      that reaches production.
 *
 * The ancestor read `GAME_DATABASE_URL`, `NIMBUS_JWKS_URL`, `NIMBUS_ISSUER`, `PAY_API_URL`,
 * `CORS_ORIGINS`, `TRUST_PROXY`, `GAME_PORT` and `GAME_RATE_LIMIT_MAX`
 * (`ninety-days-after/services/game/src/env.ts:59-73`). CORS and the rate limiter are gone: the
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

/** This service's own name. A constant — a property of the repository, not the deployment. */
export const SERVICE = 'nda';


export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

const PLACEHOLDERS = new Set([
  'changeme',
  'change_me',
  'change-me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
]);

type Source = Readonly<Record<string, string | undefined>>;

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`);
  return value;
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name);
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`);
  }
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`);
  }
  return value;
}

/**
 * A secret that may be absent, but must be real if present.
 *
 * The distinction matters for the identity credential: absent is a deployment that has not been
 * given one yet and is reported by `/readyz`; a short placeholder is a deployment that believes it
 * HAS one, and would fail on its first call to a peer with a 401 that reads as "identity rejected
 * this service" rather than "nobody set this variable".
 */
function optionalSecret(source: Source, name: string, minLength = 24): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
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
  readonly databaseUrl: string;
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
   * (identity/src/tokens.ts:28). Ten minutes into any deployment it expired and every call to a
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
    databasePoolMax: integer(source, 'NDA_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    billingUrl: required(source, 'BILLING_URL'),
    worldsUrl: required(source, 'WORLDS_URL'),
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    // Not `requiredSecret`: see the field comment. The absence is caught by `/readyz`, which is
    // a check that can fail, rather than by a boot CI cannot perform.
    identityCredential: optionalSecret(source, 'NDA_IDENTITY_CREDENTIAL'),
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
