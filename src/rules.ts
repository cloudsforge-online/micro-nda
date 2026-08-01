/**
 * The rules of Ninety Days After: the constants, the tables, and the arithmetic.
 *
 * ## Why this is here and not in a contract package
 *
 * 03-repository-responsibilities.md:177 assigns `shared-libs/packages/shared/game.ts` to
 * **`cloudsforge-nda`**, with the reason stated: *game rules are not a platform contract*. In the
 * ancestor these lived in `@cloudsforge/shared@0.4.0`, a package every service in the estate
 * installed — so a balance tweak to the Farmer perk tree was a release of the library that the
 * wallet, the mint and the identity service all consumed. They are game data. They belong to the
 * game.
 *
 * ## Fidelity
 *
 * Every value below is transcribed from `@cloudsforge/shared@0.4.0` `dist/index.js` (built from
 * `src/game.ts`), which is what the frozen `ninety-days-after/services/game` actually ran against.
 * Nothing is rounded, re-tuned or "improved": the numbers ARE the port. `src/conformance.test.ts`
 * replays a corpus recorded by executing the ancestor for real, which is what turns that claim
 * into evidence.
 *
 * The one addition is `RESOURCE_KEYS`-driven `sanitizeBag`/`hasResources`/`clampBag`, lifted from
 * `ninety-days-after/services/game/src/util.ts:33-50` — they are rules, they were merely filed
 * under utilities.
 */

/* ------------------------------------------------------------------------------ resources */

export const RESOURCE_KEYS = ['food', 'water', 'materials', 'fuel', 'medicine', 'seeds'] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];
export type ResourceBag = Record<ResourceKey, number>;

export const emptyBag = (): ResourceBag => ({
  food: 0,
  water: 0,
  materials: 0,
  fuel: 0,
  medicine: 0,
  seeds: 0,
});

/** Starting resource bag handed to every fresh homestead. `util.ts:28-30`. */
export const startingBag = (): ResourceBag => ({
  food: 12,
  water: 12,
  materials: 8,
  fuel: 2,
  medicine: 1,
  seeds: 5,
});

/**
 * Only copy known resource keys out of an arbitrary record. `util.ts:33-40`.
 *
 * Note the `> 0` guard and the `Math.floor`: a negative or fractional amount is DROPPED, not
 * clamped to itself. That asymmetry is load-bearing — `tradeTermsProblem` refuses unknown keys
 * outright rather than relying on this, precisely because silently discarding `{"gold": 5}` would
 * leave a player convinced they had offered something.
 */
export function sanitizeBag(input: Readonly<Record<string, number>>): ResourceBag {
  const bag = emptyBag();
  for (const key of RESOURCE_KEYS) {
    const v = input[key];
    if (typeof v === 'number' && v > 0) bag[key] = Math.floor(v);
  }
  return bag;
}

/** True when `have` contains at least every amount listed in `need`. `util.ts:43-45`. */
export function hasResources(
  have: Readonly<ResourceBag>,
  need: Readonly<Partial<Record<ResourceKey, number>>>,
): boolean {
  return RESOURCE_KEYS.every((k) => (have[k] ?? 0) >= (need[k] ?? 0));
}

/** Whole, non-negative units. Mutates. `util.ts:47-50`. */
export function clampBag(bag: ResourceBag): ResourceBag {
  for (const k of RESOURCE_KEYS) bag[k] = Math.max(0, Math.floor(bag[k]));
  return bag;
}

export const bagTotal = (bag: Readonly<ResourceBag>): number =>
  RESOURCE_KEYS.reduce((sum, k) => sum + (bag[k] ?? 0), 0);

export const bagsEqual = (a: Readonly<ResourceBag>, b: Readonly<ResourceBag>): boolean =>
  RESOURCE_KEYS.every((k) => (a[k] ?? 0) === (b[k] ?? 0));

/* ------------------------------------------------------------------------------ the map */

export const TERRAINS = ['wilderness', 'forest', 'ruins', 'water', 'road', 'homestead'] as const;
export type Terrain = (typeof TERRAINS)[number];

export interface Tile {
  readonly x: number;
  readonly y: number;
  terrain: Terrain;
  ruinName?: string;
  ownerId?: string;
}

export type WorldStatus = 'lobby' | 'active' | 'archived';

/* ------------------------------------------------------------------------------ actions */

export type QueuedAction =
  | { readonly type: 'work' }
  | { readonly type: 'rest' }
  | { readonly type: 'fortify' }
  | { readonly type: 'scavenge'; readonly x: number; readonly y: number }
  | { readonly type: 'raid'; readonly targetPlayerId: string }
  | {
      readonly type: 'trade';
      readonly targetPlayerId: string;
      readonly offer: Readonly<Record<string, number>>;
      readonly request: Readonly<Record<string, number>>;
    };

export type ActionType = QueuedAction['type'];

/** `queueActionsSchema` capped the array at 6; the per-player AP check is separate. */
export const MAX_QUEUED_ACTIONS = 6;

/* ------------------------------------------------------------------------------ spawn protection */

/**
 * Days of grace a freshly-settled human homestead gets. Bots are deliberately excluded: they need
 * no retention, and protecting a freshly-synced bot roster would leave established humans as the
 * only legal targets in the world.
 */
export const SPAWN_PROTECTION_DAYS = 3;

export const isSpawnProtected = (joinedDay: number, currentDay: number, isBot = false): boolean =>
  !isBot && currentDay - joinedDay < SPAWN_PROTECTION_DAYS;

/* ------------------------------------------------------------------------------ communes */

export const COMMUNE_JOIN_STIPEND = 3;
export const COMMUNE_DAILY_DRAW = 10;
export const communeWithdrawCap = (credit: number): number =>
  Math.min(COMMUNE_DAILY_DRAW, Math.max(0, credit));

/* ------------------------------------------------------------------------------ progression */

export const XP_PER_ACTION = 2;
export const XP_PER_SURVIVED_DAY = 5;

/** XP required to advance FROM `level` to `level + 1`. */
export const xpToNext = (level: number): number => 50 + Math.max(0, level - 1) * 30;

export type SkillBranch = 'farmer' | 'scavenger' | 'warden' | 'trader' | 'medic';

export interface PerkEffect {
  readonly workFood?: number;
  readonly workWater?: number;
  readonly scavengeBonus?: number;
  readonly fortifyDefense?: number;
  readonly defenseGuard?: number;
  readonly raidResist?: number;
  readonly tradeRep?: number;
  readonly tradeGoods?: number;
  readonly restHp?: number;
  readonly dailyHp?: number;
  readonly diseaseResist?: number;
}

export interface SkillPerk {
  readonly id: string;
  readonly branch: SkillBranch;
  readonly name: string;
  readonly description: string;
  readonly tier: number;
  readonly requires?: string;
  readonly effect: PerkEffect;
}

/** Five branches × three tiers. Each perk costs 1 skill point; tiers require the prior tier. */
export const SKILL_PERKS: readonly SkillPerk[] = Object.freeze([
  { id: 'farmer_1', branch: 'farmer', name: 'Green Thumb', tier: 1, description: '+1 food from every work action.', effect: { workFood: 1 } },
  { id: 'farmer_2', branch: 'farmer', name: 'Crop Rotation', tier: 2, requires: 'farmer_1', description: '+1 water from every work action.', effect: { workWater: 1 } },
  { id: 'farmer_3', branch: 'farmer', name: 'Bountiful Harvest', tier: 3, requires: 'farmer_2', description: '+2 more food from every work action.', effect: { workFood: 2 } },
  { id: 'scavenger_1', branch: 'scavenger', name: 'Sharp Eyes', tier: 1, description: '+25% scavenge haul.', effect: { scavengeBonus: 0.25 } },
  { id: 'scavenger_2', branch: 'scavenger', name: 'Pack Rat', tier: 2, requires: 'scavenger_1', description: '+25% more scavenge haul.', effect: { scavengeBonus: 0.25 } },
  { id: 'scavenger_3', branch: 'scavenger', name: 'Treasure Hunter', tier: 3, requires: 'scavenger_2', description: '+50% more scavenge haul.', effect: { scavengeBonus: 0.5 } },
  { id: 'warden_1', branch: 'warden', name: 'Palisade', tier: 1, description: '+1 defense per fortify action.', effect: { fortifyDefense: 1 } },
  { id: 'warden_2', branch: 'warden', name: 'Watchtower', tier: 2, requires: 'warden_1', description: '+2 effective defense when raided.', effect: { defenseGuard: 2 } },
  { id: 'warden_3', branch: 'warden', name: 'Bastion', tier: 3, requires: 'warden_2', description: '-40% damage taken from raids.', effect: { raidResist: 0.4 } },
  { id: 'trader_1', branch: 'trader', name: 'Haggler', tier: 1, description: '+1 reputation per successful trade.', effect: { tradeRep: 1 } },
  { id: 'trader_2', branch: 'trader', name: 'Fair Broker', tier: 2, requires: 'trader_1', description: '+1 bonus good received per trade.', effect: { tradeGoods: 1 } },
  { id: 'trader_3', branch: 'trader', name: 'Merchant Prince', tier: 3, requires: 'trader_2', description: '+2 more bonus goods received per trade.', effect: { tradeGoods: 2 } },
  { id: 'medic_1', branch: 'medic', name: 'First Aid', tier: 1, description: '+5 hp restored per rest.', effect: { restHp: 5 } },
  { id: 'medic_2', branch: 'medic', name: 'Field Medicine', tier: 2, requires: 'medic_1', description: '+2 hp regenerated passively each day.', effect: { dailyHp: 2 } },
  { id: 'medic_3', branch: 'medic', name: 'Apothecary', tier: 3, requires: 'medic_2', description: '-50% disease damage.', effect: { diseaseResist: 0.5 } },
]);

export interface PerkBonuses {
  workFood: number;
  workWater: number;
  scavengeBonus: number;
  fortifyDefense: number;
  defenseGuard: number;
  raidResist: number;
  tradeRep: number;
  tradeGoods: number;
  restHp: number;
  dailyHp: number;
  diseaseResist: number;
}

/**
 * Sum the passive effects of a set of unlocked perk ids.
 *
 * The two 0.9 ceilings are the only non-additive step and they matter: `raidResist` and
 * `diseaseResist` are multiplied into `1 - resist`, so an uncapped stack would reach a damage
 * multiplier of zero and make a maxed Warden literally unkillable by raids.
 */
export const aggregatePerks = (perkIds: readonly string[]): PerkBonuses => {
  const b: PerkBonuses = {
    workFood: 0,
    workWater: 0,
    scavengeBonus: 0,
    fortifyDefense: 0,
    defenseGuard: 0,
    raidResist: 0,
    tradeRep: 0,
    tradeGoods: 0,
    restHp: 0,
    dailyHp: 0,
    diseaseResist: 0,
  };
  const set = new Set(perkIds);
  for (const perk of SKILL_PERKS) {
    if (!set.has(perk.id)) continue;
    const e = perk.effect;
    b.workFood += e.workFood ?? 0;
    b.workWater += e.workWater ?? 0;
    b.scavengeBonus += e.scavengeBonus ?? 0;
    b.fortifyDefense += e.fortifyDefense ?? 0;
    b.defenseGuard += e.defenseGuard ?? 0;
    b.raidResist += e.raidResist ?? 0;
    b.tradeRep += e.tradeRep ?? 0;
    b.tradeGoods += e.tradeGoods ?? 0;
    b.restHp += e.restHp ?? 0;
    b.dailyHp += e.dailyHp ?? 0;
    b.diseaseResist += e.diseaseResist ?? 0;
  }
  b.raidResist = Math.min(0.9, b.raidResist);
  b.diseaseResist = Math.min(0.9, b.diseaseResist);
  return b;
};

/* ------------------------------------------------------------------------------ objectives */

export type ObjectivePeriod = 'daily' | 'weekly';
export type ObjectiveKind =
  | 'work'
  | 'scavenge'
  | 'trade'
  | 'fortify'
  | 'rest'
  | 'survive_raid'
  | 'survive_day';

export interface ObjectiveTemplate {
  readonly key: string;
  readonly kind: ObjectiveKind;
  readonly description: string;
  readonly target: number;
  readonly period: ObjectivePeriod;
  readonly rewardXp: number;
  /**
   * A pure gameplay counter. NOT money, not Shards, not convertible to either — nothing in this
   * service reads `tokens` to price, post or purchase anything, and there is no ledger client here
   * to post to. `migrations.test.ts` asserts the absence, and `rules.test.ts` asserts that the
   * cosmetic path never reads it.
   */
  readonly rewardTokens: number;
}

export const DAILY_OBJECTIVES: readonly ObjectiveTemplate[] = Object.freeze([
  { key: 'work3', kind: 'work', description: 'Tend your homestead 3 times', target: 3, period: 'daily', rewardXp: 15, rewardTokens: 3 },
  { key: 'scav2', kind: 'scavenge', description: 'Scavenge 2 ruins', target: 2, period: 'daily', rewardXp: 20, rewardTokens: 4 },
  { key: 'trade2', kind: 'trade', description: 'Trade with 2 neighbours', target: 2, period: 'daily', rewardXp: 20, rewardTokens: 4 },
  { key: 'fort2', kind: 'fortify', description: 'Fortify twice', target: 2, period: 'daily', rewardXp: 15, rewardTokens: 3 },
  { key: 'rest1', kind: 'rest', description: 'Rest and recover', target: 1, period: 'daily', rewardXp: 10, rewardTokens: 2 },
  { key: 'raid1', kind: 'survive_raid', description: 'Survive a raid', target: 1, period: 'daily', rewardXp: 25, rewardTokens: 5 },
]);

export const WEEKLY_OBJECTIVES: readonly ObjectiveTemplate[] = Object.freeze([
  { key: 'wsurvive', kind: 'survive_day', description: 'Survive 7 days', target: 7, period: 'weekly', rewardXp: 60, rewardTokens: 15 },
  { key: 'wscav', kind: 'scavenge', description: 'Scavenge 8 ruins this week', target: 8, period: 'weekly', rewardXp: 50, rewardTokens: 12 },
  { key: 'wtrade', kind: 'trade', description: 'Complete 6 trades this week', target: 6, period: 'weekly', rewardXp: 50, rewardTokens: 12 },
  { key: 'wfort', kind: 'fortify', description: 'Fortify 5 times this week', target: 5, period: 'weekly', rewardXp: 40, rewardTokens: 10 },
]);

/* ------------------------------------------------------------------------------ achievements */

export interface AchievementDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * Points carried across to the worlds shared profile. NOT in the ancestor: worlds'
   * `POST /internal/achievements` takes a points value, and the ancestor's achievements never left
   * the world they were earned in. Sized so the full set is 260 — a title's contribution to a
   * cross-title profile score, not a currency.
   */
  readonly points: number;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = Object.freeze([
  { id: 'first_scavenge', name: 'Scavenger', description: 'Scavenge your first ruin.', points: 10 },
  { id: 'first_trade', name: 'Dealmaker', description: 'Complete your first trade.', points: 10 },
  { id: 'first_raid_survived', name: 'Unbroken', description: 'Survive a raid on your homestead.', points: 15 },
  { id: 'first_kill', name: 'Marauder', description: 'Overrun a rival in a raid.', points: 15 },
  { id: 'level_10', name: 'Seasoned', description: 'Reach level 10.', points: 20 },
  { id: 'level_25', name: 'Legend', description: 'Reach level 25.', points: 40 },
  { id: 'days_30', name: 'First Frost', description: 'Survive 30 days.', points: 20 },
  { id: 'days_60', name: 'Deep Winter', description: 'Survive 60 days.', points: 30 },
  { id: 'days_90', name: 'Endured', description: 'Survive the full 90-day season.', points: 60 },
  { id: 'fort_20', name: 'Stronghold', description: 'Reach defense 20.', points: 20 },
  { id: 'tokens_100', name: 'Collector', description: 'Earn 100 tokens.', points: 20 },
]);

export const achievementById = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/* ------------------------------------------------------------------------------ world events */

export const WORLD_EVENT_TYPES = [
  'storm',
  'disease_outbreak',
  'raider_warband',
  'caravan',
  'resource_boom',
  'resource_bust',
  'season_milestone',
] as const;
export type WorldEventType = (typeof WORLD_EVENT_TYPES)[number];

export interface SeasonMilestone {
  readonly day: number;
  readonly title: string;
  readonly description: string;
}

export const SEASON_MILESTONES: readonly SeasonMilestone[] = Object.freeze([
  { day: 30, title: 'First Frost', description: 'A month has passed. The nights lengthen and stores run thin.' },
  { day: 60, title: 'Deep Winter', description: 'Two months in. Scarcity bites; every scrap is contested.' },
  { day: 90, title: "Season's End", description: 'The ninetieth day. The long dark breaks — the enduring are counted.' },
]);

/* ------------------------------------------------------------------------------ reports */

export type ReportKind =
  | 'work'
  | 'rest'
  | 'fortify'
  | 'scavenge'
  | 'raid'
  | 'trade'
  | 'death'
  | 'event'
  | 'world';

/* ------------------------------------------------------------------------------ bots */

export type BotPersonality = 'farmer' | 'hermit' | 'trader' | 'raider' | 'nomad';

export const BOT_PERSONALITIES: readonly BotPersonality[] = Object.freeze([
  'farmer',
  'hermit',
  'trader',
  'raider',
  'nomad',
]);

export const PERSONALITY_BRANCH: Readonly<Record<BotPersonality, SkillBranch>> = Object.freeze({
  farmer: 'farmer',
  hermit: 'medic',
  trader: 'trader',
  raider: 'warden',
  nomad: 'scavenger',
});

/* ------------------------------------------------------------------------------ scoring */

export interface ScoreInput {
  readonly daysSurvived: number;
  readonly alive: boolean;
  readonly resources: number;
  readonly defense: number;
  readonly reputation: number;
  readonly contribution: number;
  readonly level: number;
  readonly achievements: number;
}

/** Live survival score — works mid-season and at archive time. Higher = better. */
export const survivalScore = (i: ScoreInput): number =>
  i.daysSurvived * 8 +
  (i.alive ? 150 : 0) +
  Math.max(0, i.resources) +
  i.defense * 5 +
  Math.max(0, i.reputation) * 4 +
  i.level * 20 +
  i.contribution * 2 +
  i.achievements * 40;

/* ------------------------------------------------------------------------------ world shape */

/** `createWorldSchema` bounds, transcribed. A world outside these was never creatable. */
export const WORLD_BOUNDS = Object.freeze({
  nameMin: 3,
  nameMax: 40,
  widthMin: 12,
  widthMax: 64,
  heightMin: 12,
  heightMax: 64,
  seasonLengthMin: 5,
  seasonLengthMax: 365,
  tickIntervalMin: 1,
  tickIntervalMax: 1440,
  botCountMax: 200,
});

export const WORLD_DEFAULTS = Object.freeze({
  width: 24,
  height: 24,
  seasonLength: 90,
  tickIntervalMinutes: 1440,
  apPerDay: 6,
});
