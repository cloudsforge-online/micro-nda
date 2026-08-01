/**
 * Trade: the terms, the consent, and the swap.
 *
 * Ported from `ninety-days-after/services/game/src/engine/trade.ts`, which was already pure — no
 * database, no clock, no randomness — and is carried across essentially unchanged. The rationale
 * below is the ancestor's and is kept because it is the reason the code has the shape it has.
 *
 * WHAT WAS WRONG (in the version before the ancestor's own fix). A queued `trade` was executed
 * unilaterally by the tick. The only conditions were that the actor held their own `offer` and the
 * target held the `request` — the target agreed to nothing, and nothing put a floor under the
 * offer. An all-zero bag satisfies `hasResources` trivially, so
 * `{"offer":{},"request":{everything they own}}` was a valid, always-succeeding swap of nothing
 * for everything. The `offerTotal > 0` rule that made this look two-sided lived only in the
 * browser. Unlike `raid` the path cost no reputation, consulted no defense, and never called
 * `isSpawnProtected`, so any living survivor at any age could be emptied — and the theft credited
 * BOTH sides +2 reputation while the public report read "traded goods with".
 *
 * WHAT CONSENT IS HERE. A trade moves goods only when both sides queued it: the target must have a
 * `trade` of their own aimed back at the actor whose bags are the mirror image. Two independent
 * authenticated decisions, each costing an action point. An unmatched trade is a standing offer
 * for the day: it moves nothing and is reported privately to both sides, which is also how the
 * target learns there is something to accept.
 *
 * WHY NOT SPAWN PROTECTION. Deliberately not applied: protection exists to stop goods being taken
 * from a new settler without their say-so, and consent already does that — while blocking
 * consented trade would fall hardest on exactly the players who most need to trade their way out
 * of a bad opening.
 */

import { RESOURCE_KEYS, bagTotal, bagsEqual, hasResources, sanitizeBag, type PerkBonuses, type QueuedAction, type ResourceBag } from '../rules.ts';

export type TradeAction = Extract<QueuedAction, { type: 'trade' }>;

/** The two bags of a trade, sanitised: known resource keys, whole units, no negatives. */
export interface TradeTerms {
  readonly offer: ResourceBag;
  readonly request: ResourceBag;
}

/** Anything a trade can move goods and reputation between. A player state satisfies it. */
export interface TradeParty {
  readonly id: string;
  readonly handle: string;
  readonly alive: boolean;
  resources: ResourceBag;
  reputation: number;
}

/** What became of one queued trade. */
export type TradeStatus =
  /** Both sides queued it and both could pay: goods moved. */
  | 'executed'
  /** The other half of a swap that already resolved on the partner's turn. */
  | 'settled'
  /** One side of the bargain was empty — nothing was ever going to be paid for it. */
  | 'no_terms'
  /** The partner is gone, dead, or is the actor. */
  | 'unavailable'
  /** Nobody agreed: the offer stands for the day and moves nothing. */
  | 'offered'
  /** Both agreed, but the goods were not there when the day resolved. */
  | 'insufficient';

/** A day-report entry, less the `kind` the caller stamps on. */
export interface TradeReport {
  readonly isPublic: boolean;
  readonly message: string;
  readonly actorHandle: string | null;
  readonly targetHandle: string | null;
  readonly viewerPlayerId: string | null;
}

export interface TradeOutcome {
  readonly status: TradeStatus;
  readonly reports: readonly TradeReport[];
}

/** Read the wire action's two records as sanitised bags. */
export const termsOf = (action: TradeAction): TradeTerms => ({
  offer: sanitizeBag(action.offer),
  request: sanitizeBag(action.request),
});

/** The terms the partner has to queue for this trade to be agreed. */
export const mirrorTerms = (terms: TradeTerms): TradeTerms => ({
  offer: terms.request,
  request: terms.offer,
});

/**
 * A bag as it goes onto the wire: only the resources actually in it.
 *
 * A queued action is stored and read back as JSON, and a bag full of zeros is both noise in the
 * row and something the action list would have to filter before showing it.
 */
export const toWire = (bag: Readonly<ResourceBag>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of RESOURCE_KEYS) if ((bag[k] ?? 0) > 0) out[k] = bag[k];
  return out;
};

/** Human-readable bag, for report copy: "2 materials, 1 fuel". */
export const describeBag = (bag: Readonly<ResourceBag>): string =>
  RESOURCE_KEYS.filter((k) => (bag[k] ?? 0) > 0)
    .map((k) => `${bag[k]} ${k}`)
    .join(', ') || 'nothing';

/**
 * Why this queued trade cannot be accepted at all, or null if its shape is sound.
 *
 * Both sides must be non-empty. An empty `offer` is the exploit itself. An empty `request` looks
 * harmless — a gift — but it cannot be accepted under the mirror rule, because the acceptance
 * would itself be a trade with an empty offer; goods are given away through the commune stockpile,
 * not through a trade nobody can agree to.
 *
 * Unknown keys are refused rather than dropped: `sanitizeBag` would silently discard `{"gold": 5}`
 * and leave a player convinced they had offered something.
 */
export function tradeTermsProblem(action: TradeAction): string | null {
  for (const [side, raw] of [
    ['offer', action.offer],
    ['request', action.request],
  ] as const) {
    for (const [key, value] of Object.entries(raw)) {
      if (!(RESOURCE_KEYS as readonly string[]).includes(key)) {
        return `trade ${side} names "${key}", which is not a resource`;
      }
      if (!Number.isInteger(value) || value < 0) {
        return `trade ${side} of "${key}" must be a whole number of units`;
      }
    }
  }
  const terms = termsOf(action);
  if (bagTotal(terms.offer) <= 0) {
    return 'a trade must offer something — an empty offer is a demand, not a trade';
  }
  if (bagTotal(terms.request) <= 0) return 'a trade must ask for something in return';
  return null;
}

/**
 * The partner's matching trade, if they queued one that is still unspent.
 *
 * Matched on the terms rather than on any identifier because there is nothing else to match on:
 * both sides compose their entry independently. `settled` holds the entries a completed swap has
 * already consumed, so two identical proposals against a single acceptance execute once — the
 * second finds nothing left to match and stands as an offer.
 */
export function findConsent(
  actorId: string,
  terms: TradeTerms,
  partnerQueue: readonly QueuedAction[],
  settled: ReadonlySet<QueuedAction>,
): TradeAction | undefined {
  const wanted = mirrorTerms(terms);
  for (const candidate of partnerQueue) {
    if (candidate.type !== 'trade') continue;
    if (candidate.targetPlayerId !== actorId) continue;
    if (settled.has(candidate)) continue;
    const reply = termsOf(candidate);
    if (bagsEqual(reply.offer, wanted.offer) && bagsEqual(reply.request, wanted.request)) {
      return candidate;
    }
  }
  return undefined;
}

export interface ResolveTradeArgs {
  readonly actor: TradeParty;
  readonly action: TradeAction;
  /** The addressed player, or undefined when the id names nobody in this world. */
  readonly target: TradeParty | undefined;
  /** The target's queue for this day — where their consent would be. */
  readonly targetQueue: readonly QueuedAction[];
  /** Queue entries already consumed by a swap this day. Mutated on execution. */
  readonly settled: Set<QueuedAction>;
  readonly actorBonus: PerkBonuses;
  readonly targetBonus: PerkBonuses;
  /** `caravan` event severity in force today. */
  readonly caravanSeverity: number;
}

/**
 * Resolve one queued trade, mutating both parties on success.
 *
 * The caller keeps the bookkeeping that is not a trade's business — action points, objective
 * tallies, contribution, the day's trade counter — and stamps `kind` onto the reports.
 */
export function resolveTrade(args: ResolveTradeArgs): TradeOutcome {
  const { actor, action, target, targetQueue, settled, actorBonus, targetBonus, caravanSeverity } =
    args;

  // The far half of a swap that already moved when the partner's entry resolved. The action point
  // is spent (the caller counted it); saying so twice would put the same trade in the report twice.
  if (settled.has(action)) return { status: 'settled', reports: [] };

  const terms = termsOf(action);

  // Re-checked here and not only at the route: entries queued before this rule existed are still
  // sitting in `queued_actions`, and the tick is the last place that can refuse them.
  if (tradeTermsProblem(action) !== null) {
    return {
      status: 'no_terms',
      reports: [
        toActor(
          actor,
          target,
          `${actor.handle}'s trade went nowhere — a trade has to put goods on both sides of the table.`,
        ),
      ],
    };
  }

  if (!target || target.id === actor.id || !target.alive) {
    return {
      status: 'unavailable',
      reports: [toActor(actor, target, `${actor.handle}'s trade fell through — partner unavailable.`)],
    };
  }

  const consent = findConsent(actor.id, terms, targetQueue, settled);
  if (!consent) {
    const deal = `${describeBag(terms.offer)} for ${describeBag(terms.request)}`;
    return {
      status: 'offered',
      reports: [
        {
          isPublic: false,
          message: `${actor.handle} offered ${target.handle} ${deal}. ${target.handle} did not queue the matching trade, so nothing changed hands.`,
          actorHandle: actor.handle,
          targetHandle: target.handle,
          viewerPlayerId: actor.id,
        },
        {
          isPublic: false,
          message: `${actor.handle} offers ${deal}. Queue the matching trade with ${actor.handle} to take it.`,
          actorHandle: actor.handle,
          targetHandle: target.handle,
          viewerPlayerId: target.id,
        },
      ],
    };
  }

  if (!hasResources(actor.resources, terms.offer) || !hasResources(target.resources, terms.request)) {
    // Both sides agreed, so both sides are told why the agreed swap did not happen.
    const message = `The trade between ${actor.handle} and ${target.handle} failed (insufficient goods).`;
    return {
      status: 'insufficient',
      reports: [
        { isPublic: false, message, actorHandle: actor.handle, targetHandle: target.handle, viewerPlayerId: actor.id },
        { isPublic: false, message, actorHandle: actor.handle, targetHandle: target.handle, viewerPlayerId: target.id },
      ],
    };
  }

  for (const k of RESOURCE_KEYS) {
    actor.resources[k] += terms.request[k] - terms.offer[k];
    target.resources[k] += terms.offer[k] - terms.request[k];
  }

  // Trader perk + a passing caravan sweeten the deal. The goods go to whoever's entry resolved
  // first (the oldest homestead of the two — see the resolution order in resolve.ts); the
  // reputation is earned by both, because under the mirror rule both sides really did agree.
  const bonusGoods = actorBonus.tradeGoods + caravanSeverity;
  if (bonusGoods > 0) actor.resources.food += bonusGoods;
  const caravanRep = caravanSeverity > 0 ? 1 : 0;
  actor.reputation += 2 + actorBonus.tradeRep + caravanRep;
  target.reputation += 2 + targetBonus.tradeRep + caravanRep;

  settled.add(action);
  settled.add(consent);

  return {
    status: 'executed',
    reports: [
      {
        isPublic: true,
        message: `${actor.handle} traded goods with ${target.handle}${caravanSeverity > 0 ? ' at the caravan' : ''}.`,
        actorHandle: actor.handle,
        targetHandle: target.handle,
        viewerPlayerId: null,
      },
    ],
  };
}

/** A private entry only the actor sees. */
function toActor(actor: TradeParty, target: TradeParty | undefined, message: string): TradeReport {
  return {
    isPublic: false,
    message,
    actorHandle: actor.handle,
    targetHandle: target?.handle ?? null,
    viewerPlayerId: actor.id,
  };
}
