/**
 * Billing, as this service uses it. One question: does this account own that.
 *
 * Ninety Days After's monetisation is cosmetics and season passes, sold by billing as entitlements. This
 * client is how the game asks whether a player owns the cosmetic they are trying to equip. It never
 * asks about — and billing never sells — anything that touches a stat: the entitlement gates a
 * cosmetic and only a cosmetic.
 *
 * ## Uncached, deliberately
 * Equipping is a rare, interactive act; a refund or revocation should take effect the next time the
 * player opens the wardrobe, not whenever a TTL happens to lapse.
 *
 * ## `BillingUnavailableError` is a distinct class
 * "billing says no" (a 403) must be distinguishable from "billing did not answer" (a 503), so the
 * read path (`GET /saves/me`) can fail OPEN and the write path (`PUT .../cosmetics`) can fail CLOSED.
 */

import { HttpClient, HttpError } from '@cloudsforge/http';
import type { LiveScope } from '@cloudsforge/contracts-auth';

/**
 * The scopes this service's token must carry to call this peer.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `worldsclient.ts`.
 * This is an outbound demand, `derive-grants.mjs` reads it into the estate's grant list, and
 * identity
 * refuses to boot on a name the registry does not have — or has deprecated, which `Scope` alone
 * would not have caught.
 */
export const BILLING_SCOPES: readonly LiveScope[] = Object.freeze(['billing:read']);

/** Billing could not be reached, or answered 5xx. We do not know what this account owns. */
export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingUnavailableError';
  }
}

export interface EntitlementWire {
  readonly id: string;
  readonly sku: string;
  readonly scope: string;
  readonly active: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EntitlementReader {
  list(userId: string, scope?: string): Promise<readonly EntitlementWire[]>;
  /**
   * Whether the account owns a thing, in a scope. `itemUrn` is matched against the SKU and against
   * `cf:catalogue:item:<sku>`; doing the translation here stops two routes disagreeing about what
   * "owns" means.
   */
  owns(userId: string, itemUrn: string, scope?: string): Promise<boolean>;
}

export interface BillingClientOptions {
  readonly baseUrl: string;
  readonly token: () => Promise<string | undefined> | string | undefined;
  readonly deadlineMs: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** The SKU inside an item urn, or the string itself when it is already a bare SKU. */
export function skuOf(itemUrn: string): string {
  const prefix = 'cf:catalogue:item:';
  return itemUrn.startsWith(prefix) ? itemUrn.slice(prefix.length) : itemUrn;
}

export function httpBillingClient(options: BillingClientOptions): EntitlementReader {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'billing',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const reader: EntitlementReader = {
    async list(userId, scope) {
      try {
        const query = scope && scope !== '*' ? `?scope=title:${encodeURIComponent(scope)}` : '';
        const body = await client.get<{ entitlements?: EntitlementWire[] }>(
          `/internal/entitlements/${encodeURIComponent(userId)}${query}`,
        );
        return body.entitlements ?? [];
      } catch (err) {
        throw new BillingUnavailableError(
          err instanceof HttpError ? `billing answered ${err.status}` : err instanceof Error ? err.message : String(err),
        );
      }
    },

    async owns(userId, itemUrn, scope) {
      const sku = skuOf(itemUrn);
      // Asked WITHOUT the scope filter and matched here, so a cross-title (`platform`-scoped)
      // cosmetic is found when Ninety Days After asks about it.
      const entitlements = await reader.list(userId);
      return entitlements.some((entitlement) => {
        if (!entitlement.active) return false;
        if (entitlement.sku !== sku) return false;
        if (!scope || scope === '*') return true;
        return entitlement.scope === 'platform' || entitlement.scope === `title:${scope}`;
      });
    },
  };
  return reader;
}
