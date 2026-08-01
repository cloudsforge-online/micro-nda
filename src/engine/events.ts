/**
 * World events: what the season throws at the region on a given day.
 *
 * Ported from `ninety-days-after/services/game/src/engine/events.ts:94-173`. Two behavioural
 * changes, both deliberate and both about REPRODUCIBILITY, which is the whole point of this
 * service's engine:
 *
 *   1. The ancestor stamped each event with `randomUUID()` (`events.ts:112`, `:132`). An event's
 *      identity was therefore different on every run of the same day, so a resolved day could
 *      never be compared row-for-row against a re-resolution of it. Here the id is DERIVED from
 *      `(worldId, day, type)` — the tuple that already determines the event completely. Two runs
 *      of one day now produce identical rows, which is what makes the conformance corpus able to
 *      assert on the whole result rather than on a hand-picked subset of its fields.
 *
 *   2. `scheduleEvents` takes the world's `seed` rather than its `id`. In the ancestor those were
 *      the same string (`world/generate.ts:30` — "The world id is the map seed"), so passing the
 *      id reproduces the ancestor exactly; the parameter merely stops the identity of a row and
 *      the identity of a simulation from being the same value by accident.
 *
 * Everything else — the `day % 5` cadence, the `progress >= 0.66 / 0.33` severity bands, the
 * `h % 3 === 0` late-season souring of booms and caravans, the `1 + ((h >> 8) % baseSeverity)`
 * severity draw, the `12 *` / `10 *` stock swings — is transcribed unchanged.
 */

import { SEASON_MILESTONES, type WorldEventType } from '../rules.ts';
import { hash } from './rng.ts';

export interface WorldEvent {
  readonly id: string;
  readonly worldId: string;
  readonly day: number;
  readonly type: WorldEventType;
  readonly title: string;
  readonly description: string;
  readonly severity: number;
}

/** Flags derived from a day's events, consumed by `resolveDay`. */
export interface EventFlags {
  /** > 0 → reduced work yields that day. */
  stormSeverity: number;
  /** > 0 → hp loss unless medicine is held. */
  diseaseSeverity: number;
  /** > 0 → NPC raids on low-defense homesteads. */
  warbandSeverity: number;
  /** > 0 → favourable trade window. */
  caravanSeverity: number;
  /** fuel/medicine/seeds added to the global pool. */
  stockBoom: number;
  /** fuel/medicine/seeds removed from the global pool. */
  stockBust: number;
}

export const emptyFlags = (): EventFlags => ({
  stormSeverity: 0,
  diseaseSeverity: 0,
  warbandSeverity: 0,
  caravanSeverity: 0,
  stockBoom: 0,
  stockBust: 0,
});

/** The ambient (non-milestone) event pool. Order is load-bearing — it is indexed by a hash. */
const AMBIENT: readonly WorldEventType[] = [
  'storm',
  'disease_outbreak',
  'raider_warband',
  'caravan',
  'resource_boom',
  'resource_bust',
];

const TITLES: Readonly<Record<WorldEventType, string>> = {
  storm: 'Squall Line',
  disease_outbreak: 'Fever Spreads',
  raider_warband: 'Warband on the Road',
  caravan: 'Caravan Arrives',
  resource_boom: 'Lucky Find',
  resource_bust: 'The Wells Run Low',
  season_milestone: 'Season Turns',
};

function describe(type: WorldEventType, severity: number): string {
  switch (type) {
    case 'storm':
      return `A ${severity > 2 ? 'ferocious' : 'driving'} storm batters the region — homestead yields suffer today.`;
    case 'disease_outbreak':
      return 'Sickness moves between homesteads. Those without medicine will weaken.';
    case 'raider_warband':
      return 'A roaming warband strikes poorly-defended homesteads under cover of night.';
    case 'caravan':
      return 'A trade caravan passes through — deals struck today carry extra goods and goodwill.';
    case 'resource_boom':
      return 'Word of a fresh cache spreads; the region’s stores swell.';
    case 'resource_bust':
      return 'Stores spoil and springs dry up; the region’s reserves dwindle.';
    case 'season_milestone':
      return 'The season turns.';
  }
}

/**
 * The id of an event row. Derived, never random — see the header.
 *
 * `(worldId, day, type)` is total: a milestone and an ambient event never share a type on one day
 * (a milestone is always `season_milestone`, an ambient never is), and `scheduleEvents` emits at
 * most one of each per day.
 */
export const worldEventId = (worldId: string, day: number, type: WorldEventType): string =>
  `${worldId}:${day}:${type}`;

/**
 * Deterministically schedule the events for a single day.
 *
 * - Season milestones always fire on day 30/60/90.
 * - Ambient events fire roughly every 5 days, chosen by a per-(seed, day) hash.
 * - Severity escalates over the season (later days = harsher) — the season arc.
 */
export function scheduleEvents(
  worldId: string,
  seed: string,
  day: number,
  seasonLength: number,
): WorldEvent[] {
  const events: WorldEvent[] = [];

  // Season arc scarcity: the severity band grows 1 → 3 across the season.
  const progress = seasonLength > 0 ? day / seasonLength : 0;
  const baseSeverity = progress >= 0.66 ? 3 : progress >= 0.33 ? 2 : 1;

  const milestone = SEASON_MILESTONES.find((m) => m.day === day);
  if (milestone) {
    events.push({
      id: worldEventId(worldId, day, 'season_milestone'),
      worldId,
      day,
      type: 'season_milestone',
      title: milestone.title,
      description: milestone.description,
      severity: baseSeverity,
    });
  }

  // Ambient event ~ every 5 days.
  if (day > 2 && day % 5 === 0) {
    const h = hash(`${seed}:${day}`);
    // `AMBIENT` is non-empty and the modulus is its length, so the read is always in range;
    // `noUncheckedIndexedAccess` cannot see that, hence the non-null assertion rather than a
    // fallback that would silently change the schedule if the pool were ever emptied.
    let type: WorldEventType = AMBIENT[h % AMBIENT.length]!;
    // Late season leans harsher: booms and caravans sour past the two-thirds mark.
    if (progress >= 0.66 && (type === 'resource_boom' || type === 'caravan') && h % 3 === 0) {
      type = 'resource_bust';
    }
    const severity = 1 + ((h >> 8) % baseSeverity);
    events.push({
      id: worldEventId(worldId, day, type),
      worldId,
      day,
      type,
      title: TITLES[type],
      description: describe(type, severity),
      severity,
    });
  }

  return events;
}

/** Fold a day's events into the flag bundle `resolveDay` consumes. */
export function flagsFromEvents(events: readonly WorldEvent[]): EventFlags {
  const f = emptyFlags();
  for (const e of events) {
    switch (e.type) {
      case 'storm':
        f.stormSeverity = Math.max(f.stormSeverity, e.severity);
        break;
      case 'disease_outbreak':
        f.diseaseSeverity = Math.max(f.diseaseSeverity, e.severity);
        break;
      case 'raider_warband':
        f.warbandSeverity = Math.max(f.warbandSeverity, e.severity);
        break;
      case 'caravan':
        f.caravanSeverity = Math.max(f.caravanSeverity, e.severity);
        break;
      case 'resource_boom':
        f.stockBoom += 12 * e.severity;
        break;
      case 'resource_bust':
        f.stockBust += 10 * e.severity;
        break;
      case 'season_milestone':
        break;
    }
  }
  return f;
}
