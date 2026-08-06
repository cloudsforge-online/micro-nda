/**
 * What the bots do with their day. **Pure.**
 *
 * Ported from `ninety-days-after/services/game/src/engine/bots.ts`. The database half of
 * that file — spawning a roster, freeing tiles, writing the queue — is `../worlds.ts`; what is
 * here is the decision, so it can be tested and replayed without one.
 *
 * The one substitution is that `pickRaidTarget` keys its stream on the world's `seed` rather than
 * its `id`. In the ancestor those were the same string (`world/generate.ts`), so a world
 * carried forward picks exactly the same prey.
 *
 * A bot's CONSENT is the part worth reading. Under the mirror-consent trade rule a bot has to be
 * able to agree to a deal, and there is nobody to ask — so `acceptable` is the rule that stands in
 * for a person. It is deliberately dull: it must be able to pay, it must not come out behind in
 * units, and it must not trade away the two days of food and water that keep it alive. That is
 * what stops the consent design from becoming a way to launder the very theft it was added to
 * prevent — offer a bot one seed for its whole larder and it declines, on all three counts.
 */

import {
  bagTotal,
  hasResources,
  type BotPersonality,
  type QueuedAction,
  type ResourceBag,
} from '../rules.ts';
import { seededRng } from './rng.ts';
import { isSpawnProtected } from '../rules.ts';
import { mirrorTerms, termsOf, toWire, tradeTermsProblem, type TradeAction, type TradeTerms } from './trade.ts';

/** Everything the planner needs to know about a survivor. */
export interface BotView {
  readonly id: string;
  readonly handle: string;
  readonly isBot: boolean;
  readonly personality: BotPersonality | null;
  readonly homesteadX: number;
  readonly homesteadY: number;
  readonly resources: ResourceBag;
  readonly hp: number;
  readonly reputation: number;
  readonly alive: boolean;
  readonly apPerDay: number;
  readonly joinedDay: number;
}

export interface RuinView {
  readonly x: number;
  readonly y: number;
}

/** A trade someone has already put in front of a bot: who proposed it, and on what terms. */
export interface StandingOffer {
  readonly fromId: string;
  readonly seq: number;
  readonly action: TradeAction;
}

const manhattan = (ax: number, ay: number, bx: number, by: number): number =>
  Math.abs(ax - bx) + Math.abs(ay - by);

/** Would this bot take that deal? See the header — this is a bot's consent. */
export function acceptable(bot: BotView, terms: TradeTerms): boolean {
  if (
    tradeTermsProblem({
      type: 'trade',
      targetPlayerId: bot.id,
      offer: terms.offer,
      request: terms.request,
    }) !== null
  ) {
    return false;
  }
  if (!hasResources(bot.resources, terms.request)) return false;
  if (bagTotal(terms.offer) < bagTotal(terms.request)) return false;
  const RESERVE = 4; // two days of upkeep at the opening rate
  for (const k of ['food', 'water'] as const) {
    if (bot.resources[k] + terms.offer[k] - terms.request[k] < RESERVE) return false;
  }
  return true;
}

/**
 * Choose a raid target with a seeded weighted draw rather than a strict argmin.
 *
 * Every raider used to sort the same roster the same way and take `[0]`, so the whole raider
 * population dogpiled the single lowest-defense homestead. Weighting favours near and poorly-
 * defended neighbours but leaves every eligible target reachable, so the aggression spreads across
 * the world. Spawn-protected settlers are never candidates.
 */
export function pickRaidTarget(
  bot: BotView,
  others: readonly (BotView & { readonly defense: number })[],
  seed: string,
  day: number,
): (BotView & { readonly defense: number }) | undefined {
  const candidates = others.filter((p) => !isSpawnProtected(p.joinedDay, day, p.isBot));
  if (candidates.length === 0) return undefined;

  const weights = candidates.map((p) => {
    const distance = manhattan(bot.homesteadX, bot.homesteadY, p.homesteadX, p.homesteadY);
    const soft = 1 / (1 + Math.max(0, p.defense)); // weak walls look inviting
    const near = 1 / (1 + distance / 4); // a long march is a bad raid
    return soft * near + 0.05; // floor: nobody is ever completely safe or completely doomed
  });

  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = seededRng(`${seed}:${day}:${bot.id}:raid`)() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i] ?? 0;
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/** Pick up to `apPerDay` actions for one bot based on its personality. */
export function chooseActions(
  bot: BotView & { readonly defense: number },
  everyone: readonly (BotView & { readonly defense: number })[],
  ruins: readonly RuinView[],
  seed: string,
  /** Actions queued now resolve on the world's next day — judge protection against it. */
  day: number,
): QueuedAction[] {
  const ap = bot.apPerDay;
  const others = everyone.filter((p) => p.alive && p.id !== bot.id);
  const out: QueuedAction[] = [];

  const nearestRuin = ruins
    .slice()
    .sort(
      (a, b) =>
        manhattan(bot.homesteadX, bot.homesteadY, a.x, a.y) -
        manhattan(bot.homesteadX, bot.homesteadY, b.x, b.y),
    )[0];

  switch (bot.personality) {
    case 'farmer':
      for (let i = 0; i < ap; i++) out.push(i % 3 === 2 ? { type: 'fortify' } : { type: 'work' });
      break;
    case 'hermit':
      for (let i = 0; i < ap; i++) {
        out.push(bot.hp < 70 && i % 2 === 0 ? { type: 'rest' } : { type: 'work' });
      }
      break;
    case 'trader': {
      // Copy before sorting — `others` is shared with the other personality branches.
      const partner = [...others].sort((a, b) => b.reputation - a.reputation)[0];
      if (partner) {
        // Offer surplus materials for food — a fair, common swap.
        out.push({
          type: 'trade',
          targetPlayerId: partner.id,
          offer: { materials: 2 },
          request: { food: 2 },
        });
      }
      while (out.length < ap) out.push({ type: 'work' });
      break;
    }
    case 'raider': {
      const prey = pickRaidTarget(bot, others, seed, day);
      if (prey) out.push({ type: 'raid', targetPlayerId: prey.id });
      while (out.length < ap) out.push({ type: 'work' });
      break;
    }
    case 'nomad':
      for (let i = 0; i < ap; i++) {
        if (nearestRuin) out.push({ type: 'scavenge', x: nearestRuin.x, y: nearestRuin.y });
        else out.push({ type: 'work' });
      }
      break;
    default:
      for (let i = 0; i < ap; i++) out.push({ type: 'work' });
  }

  return out.slice(0, ap);
}

/**
 * Let each trader bot take at most one standing offer, by queueing the mirror of it.
 *
 * The acceptance is an ordinary queued trade costing an ordinary action point — it replaces one
 * `work` — so a bot that has nothing else to do trades, and a bot with a full day does not. Offers
 * come from two places: rows humans queued during the day, and proposals the other bots are making
 * in this same pass. Ties break on the proposer's id so a tick always resolves the same way.
 *
 * Mutates the plans in `plan`, which is what the caller then writes.
 */
export function acceptStandingOffers(
  bots: readonly (BotView & { readonly defense: number })[],
  everyone: readonly BotView[],
  plan: Map<string, QueuedAction[]>,
  pending: readonly { readonly playerId: string; readonly seq: number; readonly action: QueuedAction }[],
): void {
  const alive = new Set(everyone.filter((p) => p.alive).map((p) => p.id));
  const botIds = new Set(bots.map((b) => b.id));

  const offers: StandingOffer[] = [];
  for (const row of pending) {
    // A bot's own row is last tick's leftover: it has just been deleted and replaced.
    if (botIds.has(row.playerId)) continue;
    if (!alive.has(row.playerId)) continue;
    if (row.action.type === 'trade') {
      offers.push({ fromId: row.playerId, seq: row.seq, action: row.action });
    }
  }
  for (const bot of bots) {
    plan.get(bot.id)?.forEach((action, seq) => {
      if (action.type === 'trade') offers.push({ fromId: bot.id, seq, action });
    });
  }
  offers.sort((a, b) => a.fromId.localeCompare(b.fromId) || a.seq - b.seq);

  const taken = new Set<StandingOffer>();
  for (const bot of bots) {
    if (bot.personality !== 'trader') continue;
    const queue = plan.get(bot.id);
    if (!queue) continue;
    const slot = queue.findIndex((a) => a.type === 'work');
    if (slot < 0) continue; // a full day: nothing to give up for it

    const best = offers
      .filter((o) => !taken.has(o) && o.action.targetPlayerId === bot.id && o.fromId !== bot.id)
      .map((o) => ({ offer: o, terms: termsOf(o.action) }))
      .filter(({ terms }) => acceptable(bot, terms))
      .sort(
        (a, b) =>
          bagTotal(b.terms.offer) - bagTotal(a.terms.offer) ||
          bagTotal(a.terms.request) - bagTotal(b.terms.request) ||
          a.offer.fromId.localeCompare(b.offer.fromId),
      )[0];
    if (!best) continue;

    taken.add(best.offer);
    const mirror = mirrorTerms(best.terms);
    queue[slot] = {
      type: 'trade',
      targetPlayerId: best.offer.fromId,
      offer: toWire(mirror.offer),
      request: toWire(mirror.request),
    };
  }
}

/** The whole bot pass: plan every alive bot's day, then let the traders accept what is on offer. */
export function planBotDay(
  bots: readonly (BotView & { readonly defense: number })[],
  everyone: readonly (BotView & { readonly defense: number })[],
  ruins: readonly RuinView[],
  pending: readonly { readonly playerId: string; readonly seq: number; readonly action: QueuedAction }[],
  seed: string,
  day: number,
): Map<string, QueuedAction[]> {
  const plan = new Map<string, QueuedAction[]>();
  for (const bot of bots) plan.set(bot.id, chooseActions(bot, everyone, ruins, seed, day));
  acceptStandingOffers(bots, everyone, plan, pending);
  return plan;
}
