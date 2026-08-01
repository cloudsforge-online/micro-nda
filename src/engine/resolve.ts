/**
 * One in-game day, resolved. **Pure.**
 *
 * Ported from `ninety-days-after/services/game/src/engine/resolve.ts:112-876`. Every arithmetic
 * step, every clamp, every message string and every ordering rule is transcribed unchanged. What
 * is NOT transcribed is the seven `db.select()` calls it opened with and the transaction it closed
 * with: those are `../worlds.ts`, and their removal is what makes this function a thing you can
 * replay.
 *
 * ## The order, which is the game
 *
 * schedule world events → apply event stock swings → resolve queued actions (with perk bonuses and
 * storm/caravan effects) → server-driven warband raids → upkeep (season-scaling consumption,
 * disease, passive regen, streak morale, starvation/death) → XP, level-ups, objective progress,
 * achievements → day reports → advance the calendar.
 *
 * ## What changed, and why
 *
 * 1. **Report and event ids are derived, not random.** The ancestor stamped `randomUUID()` on
 *    every report row (`resolve.ts:827`) and every event (`events.ts:112`). Two runs of one day
 *    therefore produced rows that differed in a column, so "the same day resolves the same way"
 *    could only ever be asserted about a chosen subset of the output. Here a report's id is
 *    `${worldId}:${day}:${ordinal}` and an event's is `${worldId}:${day}:${type}`, so the WHOLE
 *    result is comparable and the conformance corpus asserts on all of it.
 * 2. **`Date.now()` is gone.** The ancestor computed `nextTickAt` inside the resolution
 *    (`resolve.ts:727`); scheduling is the caller's business and lives in `../worlds.ts`.
 * 3. **The bot streak/perk replay is described, not performed.** The ancestor ran
 *    `autoSpendBotPerks` twice — once on the in-memory copy so the achievement checks below could
 *    see today's levels (`resolve.ts:613`) and once against the freshly-read row at persist time
 *    (`resolve.ts:777`). Both still happen; the second is `ProgressDelta.isBot` telling the
 *    persistence layer to do it.
 *
 * There is no `Math.random()` in this file and no import that reaches one. Every draw comes from
 * `./rng.ts`, keyed on the world's seed and the day.
 */

import {
  ACHIEVEMENTS,
  RESOURCE_KEYS,
  SPAWN_PROTECTION_DAYS,
  XP_PER_ACTION,
  XP_PER_SURVIVED_DAY,
  aggregatePerks,
  clampBag,
  emptyBag,
  isSpawnProtected,
  type ObjectiveKind,
  type PerkBonuses,
  type QueuedAction,
  type ReportKind,
  type ResourceBag,
} from '../rules.ts';
import { flagsFromEvents, scheduleEvents, type WorldEvent } from './events.ts';
import {
  autoSpendBotPerks,
  dailyTemplatesFor,
  defaultProgressWork,
  grantXp,
  objectiveId,
  streakMoraleBonus,
  weekOf,
  weeklyTemplatesFor,
  type ProgressWork,
} from './progression.ts';
import { resolveTrade } from './trade.ts';
import type {
  AchievementUnlock,
  DayStats,
  ObjectiveSnapshot,
  ObjectiveUpsert,
  PlayerResult,
  PlayerSnapshot,
  ProgressDelta,
  ProgressSnapshot,
  QueuedActionRow,
  ReportRow,
  RuinResult,
  RuinSnapshot,
  WorldSnapshot,
} from './state.ts';

export interface DayInput {
  readonly world: WorldSnapshot;
  readonly players: readonly PlayerSnapshot[];
  /** Every queued action in the world, globally ordered by `seq` as the ancestor's query was. */
  readonly queue: readonly QueuedActionRow[];
  readonly ruins: readonly RuinSnapshot[];
  /** The world's finite global pool. */
  readonly stock: ResourceBag;
  readonly progress: readonly ProgressSnapshot[];
  readonly objectives: readonly ObjectiveSnapshot[];
  readonly achievements: readonly { readonly playerId: string; readonly achId: string }[];
}

export interface DayResult {
  /** The day just resolved — `world.day + 1`. */
  readonly day: number;
  /** True when this was the last day of the season and the world is now archived. */
  readonly archived: boolean;
  readonly players: readonly PlayerResult[];
  readonly ruins: readonly RuinResult[];
  readonly stock: ResourceBag;
  readonly progressDeltas: readonly ProgressDelta[];
  readonly objectives: readonly ObjectiveUpsert[];
  readonly achievements: readonly AchievementUnlock[];
  readonly events: readonly WorldEvent[];
  readonly reports: readonly ReportRow[];
  readonly stats: DayStats;
}

/** Per-player accumulator for objective/achievement tracking + XP. */
interface Tally {
  actions: number;
  work: number;
  rest: number;
  fortify: number;
  scavengeTiles: Set<string>;
  tradePartners: Set<string>;
  raidedSurvived: boolean;
  killed: boolean;
}

const newTally = (): Tally => ({
  actions: 0,
  work: 0,
  rest: 0,
  fortify: 0,
  scavengeTiles: new Set(),
  tradePartners: new Set(),
  raidedSurvived: false,
  killed: false,
});

interface MutableDelta {
  xpGained: number;
  daysSurvived: number;
  contribution: number;
}

const newDelta = (): MutableDelta => ({ xpGained: 0, daysSurvived: 0, contribution: 0 });

/** The in-flight copy of a player. Mutable where the snapshot is not. */
interface Working {
  readonly id: string;
  readonly handle: string;
  readonly isBot: boolean;
  readonly personality: PlayerSnapshot['personality'];
  readonly homesteadX: number;
  readonly homesteadY: number;
  readonly joinedDay: number;
  readonly createdAt: number;
  resources: ResourceBag;
  hp: number;
  morale: number;
  defense: number;
  reputation: number;
  alive: boolean;
}

const tileKey = (x: number, y: number): string => `${x},${y}`;

interface PendingReport {
  readonly kind: ReportKind;
  readonly isPublic: boolean;
  readonly message: string;
  readonly actorHandle: string | null;
  readonly targetHandle: string | null;
  readonly viewerPlayerId: string | null;
}

export function resolveDay(input: DayInput): DayResult {
  const { world } = input;
  const day = world.day + 1;

  /* ---------------------------------------------------------------- progression snapshot */

  const PROG = new Map<string, ProgressWork>();
  for (const row of input.progress) {
    PROG.set(row.playerId, {
      playerId: row.playerId,
      worldId: world.id,
      level: row.level,
      xp: row.xp,
      // The ancestor left `xpToNext` at 0 here and let `grantXp` recompute it
      // (`resolve.ts:136`); it is a display field and never read by the simulation.
      xpToNext: 0,
      skillPoints: row.skillPoints,
      perks: [...row.perks],
      tokens: row.tokens,
      streak: row.streak,
      lastSeenDay: row.lastSeenDay,
      daysSurvived: row.daysSurvived,
      contribution: row.contribution,
    });
  }
  for (const p of input.players) {
    if (!PROG.has(p.id)) PROG.set(p.id, defaultProgressWork(world.id, p.id));
  }

  // Perk bonuses in force during today's resolution — yesterday's unlocked perks.
  const BONUS = new Map<string, PerkBonuses>();
  for (const p of input.players) BONUS.set(p.id, aggregatePerks(PROG.get(p.id)?.perks ?? []));
  const noBonus = aggregatePerks([]);
  const bonusOf = (id: string): PerkBonuses => BONUS.get(id) ?? noBonus;

  /* ---------------------------------------------------------------- events */

  const events = scheduleEvents(world.id, world.seed, day, world.seasonLength);
  const flags = flagsFromEvents(events);

  /* ---------------------------------------------------------------- working copies */

  // Built in a DEFINED order — oldest homestead first, ties on id — rather than in whatever order
  // the caller's array happened to arrive in. The ancestor read its roster with a bare
  // `db.select()` and no `ORDER BY` (`resolve.ts:116`), then iterated that result for upkeep. Most
  // of upkeep is per-player and order-blind, but the disease relief draws from the world's finite
  // medicine pool, so with fewer units than sufferers WHICH survivor was resupplied depended on
  // the plan Postgres picked. The action loop already sorted (`resolve.ts:246`); this extends the
  // same total order to the rest of the day.
  const P = new Map<string, Working>();
  const orderedPlayers = [...input.players].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  for (const p of orderedPlayers) {
    P.set(p.id, {
      id: p.id,
      handle: p.handle,
      isBot: p.isBot,
      personality: p.personality,
      homesteadX: p.homesteadX,
      homesteadY: p.homesteadY,
      joinedDay: p.joinedDay,
      createdAt: p.createdAt,
      resources: { ...p.resources },
      hp: p.hp,
      morale: p.morale,
      defense: p.defense,
      reputation: p.reputation,
      alive: p.alive,
    });
  }

  const stock: ResourceBag = { ...emptyBag(), ...input.stock };
  const ruinStockByKey = new Map<string, ResourceBag>();
  const ruinNameByKey = new Map<string, string>();
  for (const r of input.ruins) {
    ruinStockByKey.set(tileKey(r.x, r.y), { ...r.stock });
    ruinNameByKey.set(tileKey(r.x, r.y), r.name);
  }

  // Event stock swings applied up-front to the global pool.
  if (flags.stockBoom > 0) {
    for (const k of ['fuel', 'medicine', 'seeds'] as const) stock[k] += flags.stockBoom;
  }
  if (flags.stockBust > 0) {
    for (const k of ['fuel', 'medicine', 'seeds'] as const) {
      stock[k] = Math.max(0, stock[k] - flags.stockBust);
    }
  }

  const tallies = new Map<string, Tally>();
  const tallyOf = (id: string): Tally => {
    let t = tallies.get(id);
    if (!t) {
      t = newTally();
      tallies.set(id, t);
    }
    return t;
  };

  const deltas = new Map<string, MutableDelta>();
  const deltaOf = (id: string): MutableDelta => {
    let d = deltas.get(id);
    if (!d) {
      d = newDelta();
      deltas.set(id, d);
    }
    return d;
  };

  // Group queued actions per player (already globally sorted by seq).
  const queueByPlayer = new Map<string, QueuedAction[]>();
  for (const row of input.queue) {
    const list = queueByPlayer.get(row.playerId) ?? [];
    list.push(row.action);
    queueByPlayer.set(row.playerId, list);
  }

  // Queue entries consumed by a completed swap. A trade appears twice in the day — once in each
  // party's queue — and must move goods once: whichever half resolves first marks both, and the
  // other half resolves to a no-op. Identity, not value: these are the exact objects held in
  // `queueByPlayer`, so two identical proposals against a single acceptance cannot both be paid.
  const settledTrades = new Set<QueuedAction>();

  // Pre-count scavenge contention: how many distinct players target each ruin tile.
  const contesters = new Map<string, Set<string>>();
  for (const [pid, actions] of queueByPlayer) {
    for (const a of actions) {
      if (a.type === 'scavenge') {
        const key = tileKey(a.x, a.y);
        const set = contesters.get(key) ?? new Set<string>();
        set.add(pid);
        contesters.set(key, set);
      }
    }
  }

  const out: PendingReport[] = [];
  const push = (r: PendingReport): void => {
    out.push(r);
  };
  const mine = (actor: Working, kind: ReportKind, message: string): PendingReport => ({
    kind,
    isPublic: false,
    message,
    actorHandle: actor.handle,
    targetHandle: null,
    viewerPlayerId: actor.id,
  });

  let raidsToday = 0;
  let tradesToday = 0;

  // Season scarcity: daily food/water upkeep tightens over the season.
  const upkeep = 2 + Math.floor((day - 1) / 40);

  // Emit event heralds first so the day report leads with the world state.
  for (const e of events) {
    push({
      kind: 'event',
      isPublic: true,
      message: `${e.title}: ${e.description}`,
      actorHandle: null,
      targetHandle: null,
      viewerPlayerId: null,
    });
  }

  /* ---------------------------------------------------------------- queued actions */

  // Deterministic resolution order: oldest homesteads act first.
  const order = [...P.values()]
    .filter((p) => p.alive)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  for (const actor of order) {
    if (!actor.alive) continue;
    const actions = queueByPlayer.get(actor.id) ?? [];
    const b = bonusOf(actor.id);
    const tally = tallyOf(actor.id);
    for (const action of actions) {
      if (!actor.alive) break;
      switch (action.type) {
        case 'work': {
          // Storm cuts yields; Farmer perks raise them.
          actor.resources.food += Math.max(0, 3 + b.workFood - flags.stormSeverity);
          actor.resources.water += Math.max(0, 2 + b.workWater - flags.stormSeverity);
          actor.resources.materials += 1;
          if (actor.resources.seeds > 0) {
            actor.resources.seeds -= 1;
            actor.resources.food += 3;
          } else if (stock.seeds > 0) {
            stock.seeds -= 1;
            actor.resources.seeds += 1;
          }
          // Fuel runs the pump and the saw: burn a unit for a better day's build, or draw one from
          // the region's reserve when you have none. Same shape as seeds above, and for the same
          // reason — fuel was scavenged, traded and stolen but never spent by anything, so "finite
          // fuel" was not true of it.
          if (actor.resources.fuel > 0) {
            actor.resources.fuel -= 1;
            actor.resources.materials += 2;
          } else if (stock.fuel > 0) {
            stock.fuel -= 1;
            actor.resources.fuel += 1;
          }
          tally.actions++;
          tally.work++;
          push(mine(actor, 'work', `${actor.handle} worked the homestead (+food, +water).`));
          break;
        }
        case 'rest': {
          actor.hp = Math.min(100, actor.hp + 15 + b.restHp);
          actor.morale = Math.min(100, actor.morale + 15);
          tally.actions++;
          tally.rest++;
          push(mine(actor, 'rest', `${actor.handle} rested and recovered.`));
          break;
        }
        case 'fortify': {
          if (actor.resources.materials >= 3) {
            actor.resources.materials -= 3;
            actor.defense += 2 + b.fortifyDefense;
            tally.actions++;
            tally.fortify++;
            push(
              mine(actor, 'fortify', `${actor.handle} reinforced defenses (defense ${actor.defense}).`),
            );
          } else {
            push(mine(actor, 'fortify', `${actor.handle} lacked materials to fortify.`));
          }
          break;
        }
        case 'scavenge': {
          const key = tileKey(action.x, action.y);
          const ruin = ruinStockByKey.get(key);
          if (!ruin) {
            push(mine(actor, 'scavenge', `${actor.handle} found nothing worth scavenging there.`));
            break;
          }
          const share = Math.max(1, contesters.get(key)?.size ?? 1);
          let hauled = 0;
          for (const k of RESOURCE_KEYS) {
            const base = Math.floor(Math.max(1, Math.floor(ruin[k] * 0.2)) / share);
            const slice = Math.floor(base * (1 + b.scavengeBonus)); // Scavenger perks boost the haul
            const take = Math.min(ruin[k], slice);
            if (take > 0) {
              ruin[k] -= take;
              actor.resources[k] += take;
              hauled += take;
            }
          }
          tally.actions++;
          const name = ruinNameByKey.get(key) ?? 'the ruins';
          if (hauled > 0) {
            tally.scavengeTiles.add(key);
            push({
              kind: 'scavenge',
              isPublic: share > 1,
              message:
                share > 1
                  ? `${actor.handle} scavenged ${name} alongside ${share - 1} others (+${hauled} goods).`
                  : `${actor.handle} scavenged ${name} (+${hauled} goods).`,
              actorHandle: actor.handle,
              targetHandle: null,
              viewerPlayerId: share > 1 ? null : actor.id,
            });
          } else {
            push(mine(actor, 'scavenge', `${actor.handle} picked ${name} clean — nothing left.`));
          }
          break;
        }
        case 'raid': {
          const target = P.get(action.targetPlayerId);
          raidsToday++;
          tally.actions++;
          if (!target || target.id === actor.id || !target.alive) {
            push(mine(actor, 'raid', `${actor.handle}'s raid found no one home.`));
            break;
          }
          // Spawn protection — enforced here too, so a human griefer cannot do what the raider
          // bots are forbidden from doing. The raid is a loud no-op: the AP is spent, nothing is
          // stolen, and both sides see why it failed.
          if (isSpawnProtected(target.joinedDay, day, target.isBot)) {
            push({
              kind: 'raid',
              isPublic: true,
              message: `${actor.handle} rode on ${target.handle} but turned back — the settlement shelters new arrivals for their first ${SPAWN_PROTECTION_DAYS} days.`,
              actorHandle: actor.handle,
              targetHandle: target.handle,
              viewerPlayerId: null,
            });
            break;
          }
          const tb = bonusOf(target.id);
          const power = 8 + Math.floor(actor.morale / 25); // ~8–12
          const guard = target.defense + tb.defenseGuard; // Warden perk stiffens the defence
          if (guard >= power) {
            actor.hp = Math.max(0, actor.hp - 6);
            actor.morale = Math.max(0, actor.morale - 5);
            tallyOf(target.id).raidedSurvived = true;
            push({
              kind: 'raid',
              isPublic: true,
              message: `${actor.handle} raided ${target.handle} but was repelled by the fortifications.`,
              actorHandle: actor.handle,
              targetHandle: target.handle,
              viewerPlayerId: null,
            });
          } else {
            const frac = (power - guard) / power;
            let stolen = 0;
            for (const k of ['food', 'water', 'materials', 'fuel', 'medicine'] as const) {
              const amt = Math.floor(target.resources[k] * frac * 0.6);
              if (amt > 0) {
                target.resources[k] -= amt;
                actor.resources[k] += amt;
                stolen += amt;
              }
            }
            const dmg = Math.max(1, Math.round(12 * (1 - tb.raidResist))); // Bastion softens the blow
            target.hp = Math.max(0, target.hp - dmg);
            target.defense = Math.max(0, target.defense - 2);
            actor.reputation -= 5;
            if (target.hp <= 0) {
              target.alive = false;
              tally.killed = true;
              push({
                kind: 'death',
                isPublic: true,
                message: `${target.handle} was slain when ${actor.handle} overran the homestead.`,
                actorHandle: actor.handle,
                targetHandle: target.handle,
                viewerPlayerId: null,
              });
            } else {
              tallyOf(target.id).raidedSurvived = true;
            }
            push({
              kind: 'raid',
              isPublic: true,
              message: `${actor.handle} raided ${target.handle}, making off with ${stolen} goods.`,
              actorHandle: actor.handle,
              targetHandle: target.handle,
              viewerPlayerId: null,
            });
          }
          break;
        }
        case 'trade': {
          // Two-sided by construction: goods move only when the partner queued the mirror-image
          // trade. See engine/trade.ts for what that costs and why the rule is not spawn
          // protection. The action point is spent either way.
          const target = P.get(action.targetPlayerId);
          tally.actions++;
          const outcome = resolveTrade({
            actor,
            action,
            target,
            targetQueue: target ? queueByPlayer.get(target.id) ?? [] : [],
            settled: settledTrades,
            actorBonus: b,
            targetBonus: bonusOf(action.targetPlayerId),
            caravanSeverity: flags.caravanSeverity,
          });
          for (const r of outcome.reports) push({ kind: 'trade', ...r });
          if (outcome.status === 'executed' && target) {
            // Both sides queued it, so both sides earned the credit for it — the objective, the
            // achievement and the contribution that feeds survivalScore.
            tally.tradePartners.add(target.id);
            tallyOf(target.id).tradePartners.add(actor.id);
            deltaOf(actor.id).contribution += 1;
            deltaOf(target.id).contribution += 1;
            tradesToday++;
          }
          break;
        }
      }
    }
  }

  /* ---------------------------------------------------------------- warband raids */

  if (flags.warbandSeverity > 0) {
    const threshold = 4 + flags.warbandSeverity;
    for (const p of order) {
      if (!p.alive) continue;
      if (isSpawnProtected(p.joinedDay, day, p.isBot)) continue; // new arrivals are off the warband's map
      const guard = p.defense + bonusOf(p.id).defenseGuard;
      if (guard >= threshold) continue; // well-defended homesteads aren't targeted
      const frac = Math.min(0.5, (threshold - guard) / threshold) * 0.5;
      let stolen = 0;
      for (const k of ['food', 'water', 'materials', 'fuel', 'medicine'] as const) {
        const amt = Math.floor(p.resources[k] * frac);
        if (amt > 0) {
          p.resources[k] -= amt;
          stolen += amt;
        }
      }
      const dmg = Math.max(
        1,
        Math.round(8 * flags.warbandSeverity * (1 - bonusOf(p.id).raidResist)),
      );
      p.hp = Math.max(0, p.hp - dmg);
      raidsToday++;
      if (p.hp <= 0) {
        p.alive = false;
        push({
          kind: 'death',
          isPublic: true,
          message: `${p.handle}'s homestead was overrun by the warband.`,
          actorHandle: null,
          targetHandle: p.handle,
          viewerPlayerId: null,
        });
      } else {
        tallyOf(p.id).raidedSurvived = true;
        push({
          kind: 'raid',
          isPublic: false,
          message: `A warband struck ${p.handle} (−${stolen} goods, −${dmg} hp).`,
          actorHandle: null,
          targetHandle: p.handle,
          viewerPlayerId: p.id,
        });
      }
    }
  }

  /* ---------------------------------------------------------------- upkeep */

  let deaths = 0;
  for (const p of P.values()) {
    if (!p.alive) continue;
    const b = bonusOf(p.id);
    const prog = PROG.get(p.id);

    // Passive medic regen + login-streak morale (earned by consistent play).
    if (b.dailyHp > 0) p.hp = Math.min(100, p.hp + b.dailyHp);
    const moraleBonus = streakMoraleBonus(prog?.streak ?? 0);
    if (moraleBonus > 0) p.morale = Math.min(100, p.morale + moraleBonus);

    // Disease outbreak: medicine wards it off, otherwise it bites (Medic perk resists).
    let metFeverWithNothing = false;
    if (flags.diseaseSeverity > 0) {
      if (p.resources.medicine > 0) {
        p.resources.medicine -= 1;
      } else {
        metFeverWithNothing = true;
        const dmg = Math.max(1, Math.round(8 * flags.diseaseSeverity * (1 - b.diseaseResist)));
        p.hp = Math.max(0, p.hp - dmg);
        if (p.hp <= 0) {
          p.alive = false;
          deaths++;
          push({
            kind: 'death',
            isPublic: true,
            message: `${p.handle} succumbed to the fever.`,
            actorHandle: p.handle,
            targetHandle: null,
            viewerPlayerId: null,
          });
        }
      }
    }
    if (!p.alive) {
      clampBag(p.resources);
      continue;
    }

    // Relief reaches those who met the fever with nothing — after it, never in time for it, so
    // holding your own medicine is still the thing that saves you, and spending your last unit is
    // not silently refunded. Drawn from the region's finite reserve: when that is empty nobody is
    // resupplied, which is the whole point of a finite pool.
    if (metFeverWithNothing && stock.medicine > 0) {
      stock.medicine -= 1;
      p.resources.medicine += 1;
    }

    let shortages = 0;
    if (p.resources.food >= upkeep) p.resources.food -= upkeep;
    else {
      p.resources.food = 0;
      shortages++;
    }
    if (p.resources.water >= upkeep) p.resources.water -= upkeep;
    else {
      p.resources.water = 0;
      shortages++;
    }
    if (shortages > 0) {
      p.hp = Math.max(0, p.hp - 10 * shortages);
      p.morale = Math.max(0, p.morale - 5);
      if (p.hp <= 0) {
        p.alive = false;
        deaths++;
        push({
          kind: 'death',
          isPublic: true,
          message: `${p.handle} succumbed to ${
            shortages > 1 ? 'starvation and thirst' : p.resources.food === 0 ? 'starvation' : 'thirst'
          }.`,
          actorHandle: p.handle,
          targetHandle: null,
          viewerPlayerId: null,
        });
      } else {
        push({
          kind: 'event',
          isPublic: false,
          message: `${p.handle} went hungry (hp ${p.hp}).`,
          actorHandle: p.handle,
          targetHandle: null,
          viewerPlayerId: p.id,
        });
      }
    }
    clampBag(p.resources);
  }

  /* ---------------------------------------------------------------- progression */

  for (const p of P.values()) {
    const prog = PROG.get(p.id);
    if (!prog) continue;
    const tally = tallies.get(p.id) ?? newTally();
    const delta = deltaOf(p.id);
    if (p.alive) {
      prog.daysSurvived += 1;
      delta.daysSurvived += 1;
    }
    const xp = tally.actions * XP_PER_ACTION + (p.alive ? XP_PER_SURVIVED_DAY : 0);
    if (xp > 0) {
      grantXp(prog, xp);
      delta.xpGained += xp;
    }
    if (p.isBot) {
      // Bots "log in" daily and auto-invest skill points into their branch. Both are replayed
      // against the freshly-read row at persist time; this copy exists so the achievement checks
      // below see today's levels.
      if (p.alive) {
        prog.streak = prog.lastSeenDay === day - 1 ? prog.streak + 1 : Math.max(1, prog.streak);
        prog.lastSeenDay = day;
      }
      autoSpendBotPerks(prog, p.personality);
    }
  }

  /* ---------------------------------------------------------------- objectives */

  const week = weekOf(day);
  const objByKey = new Map(input.objectives.map((o) => [o.id, o]));
  const objUpserts: ObjectiveUpsert[] = [];

  const increment = (kind: ObjectiveKind, t: Tally, alive: boolean): number => {
    switch (kind) {
      case 'work':
        return t.work;
      case 'fortify':
        return t.fortify;
      case 'rest':
        return t.rest;
      case 'scavenge':
        return t.scavengeTiles.size;
      case 'trade':
        return t.tradePartners.size;
      case 'survive_raid':
        return t.raidedSurvived ? 1 : 0;
      case 'survive_day':
        return alive ? 1 : 0;
    }
  };

  for (const p of P.values()) {
    if (!p.alive) continue;
    const tally = tallies.get(p.id) ?? newTally();
    const templates = [
      ...dailyTemplatesFor(p.id, day).map((t) => ({ t, bucket: day })),
      ...weeklyTemplatesFor(p.id, week).map((t) => ({ t, bucket: week })),
    ];
    for (const { t, bucket } of templates) {
      const id = objectiveId(p.id, t.period, bucket, t.key);
      const existing = objByKey.get(id);
      const priorProgress = existing?.progress ?? 0;
      const claimed = existing?.claimed ?? false;
      const next = Math.min(t.target, priorProgress + increment(t.kind, tally, p.alive));
      objUpserts.push({
        id,
        worldId: world.id,
        playerId: p.id,
        bucket,
        kind: t.kind,
        description: t.description,
        target: t.target,
        progress: claimed ? priorProgress : next,
        period: t.period,
        rewardXp: t.rewardXp,
        rewardTokens: t.rewardTokens,
        claimed,
      });
    }
  }

  /* ---------------------------------------------------------------- achievements */

  const haveAch = new Set(input.achievements.map((a) => `${a.playerId}:${a.achId}`));
  const achInserts: AchievementUnlock[] = [];
  const unlock = (playerId: string, achId: string): void => {
    if (haveAch.has(`${playerId}:${achId}`)) return;
    const def = ACHIEVEMENTS.find((a) => a.id === achId);
    if (!def) return;
    haveAch.add(`${playerId}:${achId}`);
    achInserts.push({
      id: `${playerId}:${achId}`,
      worldId: world.id,
      playerId,
      achId,
      name: def.name,
      description: def.description,
      points: def.points,
      unlockedAt: day,
    });
  };
  for (const p of P.values()) {
    const prog = PROG.get(p.id);
    if (!prog) continue;
    const tally = tallies.get(p.id) ?? newTally();
    if (tally.scavengeTiles.size > 0) unlock(p.id, 'first_scavenge');
    if (tally.tradePartners.size > 0) unlock(p.id, 'first_trade');
    if (tally.raidedSurvived) unlock(p.id, 'first_raid_survived');
    if (tally.killed) unlock(p.id, 'first_kill');
    if (prog.level >= 10) unlock(p.id, 'level_10');
    if (prog.level >= 25) unlock(p.id, 'level_25');
    if (prog.daysSurvived >= 30) unlock(p.id, 'days_30');
    if (prog.daysSurvived >= 60) unlock(p.id, 'days_60');
    if (prog.daysSurvived >= 90) unlock(p.id, 'days_90');
    if (p.defense >= 20) unlock(p.id, 'fort_20');
    if (prog.tokens >= 100) unlock(p.id, 'tokens_100');
  }

  /* ---------------------------------------------------------------- the herald */

  const aliveCount = [...P.values()].filter((p) => p.alive).length;
  push({
    kind: 'world',
    isPublic: true,
    message: `Day ${day}: ${aliveCount} survivors remain. ${raidsToday} raid(s), ${tradesToday} trade(s)${
      deaths ? `, ${deaths} died` : ''
    }.`,
    actorHandle: null,
    targetHandle: null,
    viewerPlayerId: null,
  });

  /* ---------------------------------------------------------------- results */

  const archived = day >= world.seasonLength;

  const progressDeltas: ProgressDelta[] = [];
  for (const p of P.values()) {
    const d = deltas.get(p.id) ?? newDelta();
    progressDeltas.push({
      playerId: p.id,
      xpGained: d.xpGained,
      daysSurvived: d.daysSurvived,
      contribution: d.contribution,
      isBot: p.isBot,
      personality: p.personality,
      aliveAtEnd: p.alive,
    });
  }

  return {
    day,
    archived,
    players: [...P.values()].map((p) => ({
      id: p.id,
      resources: p.resources,
      hp: p.hp,
      morale: p.morale,
      defense: p.defense,
      reputation: p.reputation,
      alive: p.alive,
    })),
    ruins: input.ruins.map((r) => ({
      x: r.x,
      y: r.y,
      stock: ruinStockByKey.get(tileKey(r.x, r.y)) ?? { ...r.stock },
    })),
    stock,
    progressDeltas,
    objectives: objUpserts,
    achievements: achInserts,
    events,
    // The ordinal is the push order, which is the resolution order, which is deterministic. A
    // uuid here (as the ancestor had) would be the one column that stopped a resolved day from
    // being comparable with a replay of it.
    reports: out.map((r, i) => ({
      id: `${world.id}:${day}:${i}`,
      worldId: world.id,
      day,
      kind: r.kind,
      isPublic: r.isPublic,
      message: r.message,
      actorHandle: r.actorHandle,
      targetHandle: r.targetHandle,
      viewerPlayerId: r.viewerPlayerId,
    })),
    stats: {
      aliveCount,
      raids: raidsToday,
      trades: tradesToday,
      deaths,
      actions: input.queue.length,
    },
  };
}
