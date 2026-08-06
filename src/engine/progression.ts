/**
 * Levels, perks, objectives and the login streak.
 *
 * Ported from `ninety-days-after/services/game/src/engine/progression.ts`. Pure throughout —
 * the ancestor's version was too, which is why the whole of it is exercised without a database.
 *
 * `PlayerProgress.tokens` is a gameplay counter and nothing else. It is earned by claiming an
 * objective, it is read by one achievement (`tokens_100`), and no code path anywhere in this
 * service converts it to, from, or against anything a customer paid for — there is no ledger
 * client in this repository to convert it with. See `rules.ts` `ObjectiveTemplate.rewardTokens`.
 */

import {
  DAILY_OBJECTIVES,
  PERSONALITY_BRANCH,
  SKILL_PERKS,
  WEEKLY_OBJECTIVES,
  xpToNext,
  type BotPersonality,
  type ObjectiveTemplate,
} from '../rules.ts';
import { hash, seededShuffle } from './rng.ts';

/** Per-player earned progression. */
export interface PlayerProgress {
  readonly playerId: string;
  readonly worldId: string;
  level: number;
  xp: number;
  xpToNext: number;
  skillPoints: number;
  perks: string[];
  tokens: number;
  streak: number;
  daysSurvived: number;
  contribution: number;
}

/** The shared type plus the internal streak cursor, which never leaves the service. */
export interface ProgressWork extends PlayerProgress {
  lastSeenDay: number;
}

/** Week index (1-based) that a given day belongs to. */
export const weekOf = (day: number): number => Math.max(1, Math.ceil(day / 7));

/** The 3 daily objective templates assigned to a player for a given day. */
export function dailyTemplatesFor(playerId: string, day: number): ObjectiveTemplate[] {
  return seededShuffle(DAILY_OBJECTIVES, hash(`${playerId}:d:${day}`)).slice(0, 3);
}

/** The 2 weekly objective templates assigned to a player for a given week. */
export function weeklyTemplatesFor(playerId: string, week: number): ObjectiveTemplate[] {
  return seededShuffle(WEEKLY_OBJECTIVES, hash(`${playerId}:w:${week}`)).slice(0, 2);
}

/** Deterministic objective row id — idempotent across every call that ensures one. */
export const objectiveId = (
  playerId: string,
  period: 'daily' | 'weekly',
  bucket: number,
  key: string,
): string => `${playerId}:${period}:${bucket}:${key}`;

/**
 * Apply earned XP, rolling over level-ups (1 skill point each). Mutates and returns the record.
 *
 * The `while` rather than an `if` is the whole of it: a single claim can carry a player through
 * more than one level, and an `if` would silently bank the overflow at the level boundary.
 */
export function grantXp<T extends PlayerProgress>(prog: T, amount: number): T {
  prog.xp += Math.max(0, Math.floor(amount));
  let need = xpToNext(prog.level);
  while (prog.xp >= need) {
    prog.xp -= need;
    prog.level += 1;
    prog.skillPoints += 1;
    need = xpToNext(prog.level);
  }
  prog.xpToNext = need;
  return prog;
}

/** Recompute the derived `xpToNext` for display without granting anything. */
export function refreshXpToNext<T extends PlayerProgress>(prog: T): T {
  prog.xpToNext = xpToNext(prog.level);
  return prog;
}

/**
 * Validate a perk unlock. Returns an error string, or null on success.
 *
 * Order matters for the message a player sees, and it is the ancestor's: unknown before duplicate
 * before affordability before prerequisite.
 */
export function validateUnlock(prog: PlayerProgress, perkId: string): string | null {
  const perk = SKILL_PERKS.find((p) => p.id === perkId);
  if (!perk) return 'unknown perk';
  if (prog.perks.includes(perkId)) return 'perk already unlocked';
  if (prog.skillPoints < 1) return 'no skill points available';
  if (perk.requires && !prog.perks.includes(perk.requires)) return 'prerequisite perk not unlocked';
  return null;
}

/**
 * Spend all available skill points for a bot into its personality's branch, in tier order.
 * Bots gain the same passive perk bonuses as players, but pick automatically.
 */
export function autoSpendBotPerks(
  prog: PlayerProgress,
  personality: BotPersonality | null,
): boolean {
  if (!personality) return false;
  const branch = PERSONALITY_BRANCH[personality];
  const branchPerks = SKILL_PERKS.filter((p) => p.branch === branch).sort((a, b) => a.tier - b.tier);
  let changed = false;
  while (prog.skillPoints > 0) {
    const next = branchPerks.find(
      (p) => !prog.perks.includes(p.id) && (!p.requires || prog.perks.includes(p.requires)),
    );
    if (!next) break;
    prog.perks = [...prog.perks, next.id];
    prog.skillPoints -= 1;
    changed = true;
  }
  return changed;
}

/**
 * Login streak on a human "touch" (viewing the world). Consecutive in-game days grow the streak;
 * a gap resets it. No-op if already seen today. Returns whether it changed.
 */
export function touchStreak(prog: ProgressWork, currentDay: number): boolean {
  const last = prog.lastSeenDay ?? -1;
  if (last === currentDay) return false;
  if (last === currentDay - 1) prog.streak += 1;
  else prog.streak = 1;
  prog.lastSeenDay = currentDay;
  return true;
}

/** Morale bonus from the current login streak (escalating, capped). */
export const streakMoraleBonus = (streak: number): number => Math.min(12, streak * 2);

/**
 * Fold one resolved day's delta into a progress row that has just been re-read under `FOR UPDATE`.
 *
 * This is the second half of the ancestor's delta design (`resolve.ts`) and it lives here,
 * as one function, so that the persistence layer and the conformance test cannot disagree about
 * what a delta means. `tokens` is untouched on purpose — the tick never awards them, and writing
 * the column would revert a claim made while the day was being computed.
 *
 * A bot has no session, so the tick is its login and its skill spender; both are replayed against
 * the fresh row rather than copied from the simulation's snapshot of it.
 */
export function applyProgressDelta(
  fresh: ProgressWork,
  delta: {
    readonly xpGained: number;
    readonly daysSurvived: number;
    readonly contribution: number;
    readonly isBot: boolean;
    readonly personality: BotPersonality | null;
    readonly aliveAtEnd: boolean;
  },
  day: number,
): ProgressWork {
  if (delta.xpGained > 0) grantXp(fresh, delta.xpGained);
  fresh.daysSurvived += delta.daysSurvived;
  fresh.contribution += delta.contribution;
  if (delta.isBot) {
    if (delta.aliveAtEnd) {
      fresh.streak = fresh.lastSeenDay === day - 1 ? fresh.streak + 1 : Math.max(1, fresh.streak);
      fresh.lastSeenDay = day;
    }
    autoSpendBotPerks(fresh, delta.personality);
  }
  return fresh;
}

/** A fresh in-engine progress working copy, for a player with no row yet. */
export function defaultProgressWork(worldId: string, playerId: string): ProgressWork {
  return {
    playerId,
    worldId,
    level: 1,
    xp: 0,
    xpToNext: xpToNext(1),
    skillPoints: 0,
    perks: [],
    tokens: 0,
    streak: 0,
    lastSeenDay: -1,
    daysSurvived: 0,
    contribution: 0,
  };
}
