/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * The ancestor had no migration tooling at all: `db/migrate.ts` was an array of
 * `CREATE TABLE IF NOT EXISTS` statements run in a bare loop from `index.ts` on every boot, whose
 * failure exited the process (`ninety-days-after/services/game/src/db/migrate.ts:226-230`). It
 * worked, and it made two things impossible: knowing which schema a running container was serving,
 * and a rolling deploy, since two versions against one schema needs an expand/contract discipline
 * that "IF NOT EXISTS" cannot express.
 *
 * ## What this schema owns
 *
 * `worlds`, `tiles`, `players`, `queued_actions`, `reports`, `communes`, `world_stock`,
 * `player_progress`, `objectives`, `achievements`, `world_events` — 04-domain-model §7.4, verbatim.
 * Plus the estate furniture: leased jobs, outbox, inbox, idempotency keys.
 *
 * ## What it deliberately does NOT own
 *
 * **No balance column, and no money of any kind.** A cosmetic is a billing entitlement; this
 * service records only which slot a survivor is wearing it in. `player_progress.tokens` is a
 * gameplay counter earned by claiming an objective and read by one achievement — there is no
 * ledger client in this repository for it to reach, and `migrations.test.ts` asserts the absence
 * of a balance column the way `micro-emberkin` does.
 *
 * The ancestor also carried `player_cosmetics`, an account-level wardrobe keyed on `user_id`
 * (`db/schema.ts:158`). That table is NOT here: 03-repository-responsibilities:168 assigns the
 * player identity and the entitlement bridge to `worlds`, and a per-title service keeping its own
 * copy of what an account owns is the second registry that document exists to prevent. What a
 * survivor wears in THIS world is `players.cosmetic_style`, which is per-world state and is ours.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs';
import type { Migration } from '@cloudsforge/db';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Verbatim from the runtime package so the claim query's table and the table that exists
    // cannot drift.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'idempotency',
    up: `
      -- Rule 6 of docs/ecosystem/03 §2. The claim row is inserted first and the response written
      -- into it, so a second attempt either finds a committed response to replay or finds the
      -- first attempt still in flight — never a half-applied mutation.
      create table if not exists idempotency_keys (
        key          text        primary key,
        route        text        not null,
        request_hash text        not null,
        response     jsonb,
        created_at   timestamptz not null default now()
      );

      create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);
    `,
  },
  {
    version: 5,
    name: 'worlds',
    up: `
      create table if not exists worlds (
        id                    text        primary key,
        name                  text        not null,
        status                text        not null default 'lobby',
        day                   integer     not null default 0,
        season_length         integer     not null,
        width                 integer     not null,
        height                integer     not null,
        tick_interval_minutes integer     not null,
        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **THE SIMULATION SEED.** The ancestor used the world's id for this (world/generate.ts:30
        -- — "The world id is the map seed"), so identity and reproducibility were the same value
        -- and a world could not be re-seeded without becoming a different row. Split, and
        -- defaulted to the id on the way in, so a world carried forward from the ancestor replays
        -- exactly.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        seed                  text        not null,
        bots_enabled          boolean     not null default false,
        bot_count             integer     not null default 0,
        next_tick_at          timestamptz,
        created_at            timestamptz not null default now(),
        constraint worlds_status_known check (status in ('lobby','active','archived')),
        constraint worlds_day_non_negative check (day >= 0),
        constraint worlds_season_sane check (season_length between 5 and 365),
        constraint worlds_size_sane check (width between 12 and 64 and height between 12 and 64),
        constraint worlds_tick_sane check (tick_interval_minutes between 1 and 1440),
        constraint worlds_bot_count_sane check (bot_count between 0 and 200),
        -- A day past the end of the season is a world that resolved after archiving.
        constraint worlds_day_within_season check (day <= season_length)
      );

      create index if not exists worlds_due_idx
        on worlds (next_tick_at)
        where status = 'active' and next_tick_at is not null;

      create table if not exists tiles (
        id         text    primary key,
        world_id   text    not null references worlds (id) on delete cascade,
        x          integer not null,
        y          integer not null,
        terrain    text    not null,
        ruin_name  text,
        -- Finite scavenge stock for ruins tiles; null elsewhere.
        ruin_stock jsonb,
        owner_id   text,
        constraint tiles_terrain_known check (
          terrain in ('wilderness','forest','ruins','water','road','homestead')
        ),
        -- One tile per coordinate. The ancestor had no such constraint and generated the grid in
        -- one pass, so a re-run of world creation could have doubled it.
        constraint tiles_world_xy_uniq unique (world_id, x, y)
      );

      create index if not exists tiles_world_idx on tiles (world_id);
      -- The homestead claim reads the free list and writes conditionally; this is its access path.
      create index if not exists tiles_free_idx on tiles (world_id) where owner_id is null;

      create table if not exists players (
        id             text        primary key,
        world_id       text        not null references worlds (id) on delete cascade,
        user_id        text,
        handle         text        not null,
        is_bot         boolean     not null default false,
        personality    text,
        homestead_x    integer     not null,
        homestead_y    integer     not null,
        resources      jsonb       not null,
        hp             integer     not null default 100,
        morale         integer     not null default 100,
        defense        integer     not null default 0,
        reputation     integer     not null default 0,
        alive          boolean     not null default true,
        ap_per_day     integer     not null default 6,
        commune_id     text,
        cosmetic_style text,
        -- Spawn protection runs on the GAME clock, not created_at: a world day can be a minute or
        -- twenty-four hours.
        joined_day     integer     not null default 0,
        -- Commune withdraw allowance: the day the counter belongs to, and how much has been drawn.
        withdraw_day     integer   not null default -1,
        withdrawn_today  integer   not null default 0,
        commune_credit   integer   not null default 0,
        -- The joining stipend is once per survivor per world, not once per join. Leaving forfeits
        -- commune_credit, so without this flag rejoining paid the goodwill credit again and a
        -- member who deposited nothing could farm it daily. Never cleared once set.
        stipend_granted  boolean   not null default false,
        created_at     timestamptz not null default now(),
        constraint players_bot_has_personality check (
          (is_bot = false and personality is null) or
          (is_bot = true and personality in ('farmer','hermit','trader','raider','nomad'))
        ),
        -- A BOT has no account. Stated one-directionally on purpose.
        --
        -- The obvious form is "(is_bot = true) = (user_id is null)" — a bot has no account AND a
        -- human always has one — and it is wrong, because it makes GDPR erasure impossible. The
        -- identity.user.deleted handler does not delete the survivor: a world's history
        -- is other players' history too, so the row stays and the LINK to the account goes. That
        -- leaves a legitimate human with a null user_id, which the two-directional form refuses.
        -- Caught by the erasure test, which is what tests of a rule are for.
        --
        -- The hazard actually worth constraining is the other direction: a bot carrying a user_id
        -- would post its achievements to a real person's profile.
        constraint players_bot_has_no_user check (not (is_bot = true and user_id is not null)),
        constraint players_vitals_bounded check (hp between 0 and 100 and morale between 0 and 100),
        constraint players_defense_non_negative check (defense >= 0),
        constraint players_ap_sane check (ap_per_day between 0 and 6),
        constraint players_commune_credit_non_negative check (commune_credit >= 0),
        constraint players_withdrawn_non_negative check (withdrawn_today >= 0)
      );

      create index if not exists players_world_idx on players (world_id);
      create index if not exists players_user_idx on players (user_id);
      create index if not exists players_commune_idx on players (commune_id);
      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- **ONE ACCOUNT, ONE SURVIVOR PER WORLD.** Partial, because bots are players rows with a
      -- null user_id and a world holds many of them. This is the arbiter for the
      -- ON CONFLICT DO NOTHING in the join path: without it two tabs joining at once produced two
      -- survivors for one account — two starting bags, two lots of AP, and a lookup that returned
      -- whichever row Postgres listed first.
      -- ════════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists players_world_user_uniq
        on players (world_id, user_id) where user_id is not null;

      create table if not exists queued_actions (
        id        text    primary key,
        world_id  text    not null references worlds (id) on delete cascade,
        player_id text    not null references players (id) on delete cascade,
        seq       integer not null,
        action    jsonb   not null,
        constraint queued_actions_seq_non_negative check (seq >= 0)
      );

      create index if not exists queued_actions_world_idx on queued_actions (world_id, seq);
      create index if not exists queued_actions_player_idx on queued_actions (player_id);

      create table if not exists reports (
        id               text        primary key,
        world_id         text        not null references worlds (id) on delete cascade,
        day              integer     not null,
        kind             text        not null,
        is_public        boolean     not null,
        message          text        not null,
        actor_handle     text,
        target_handle    text,
        -- For private entries: the player allowed to read it. Null means a public herald.
        viewer_player_id text,
        created_at       timestamptz not null default now(),
        constraint reports_kind_known check (
          kind in ('work','rest','fortify','scavenge','raid','trade','death','event','world')
        )
      );

      create index if not exists reports_world_day_idx on reports (world_id, day desc);
      create index if not exists reports_viewer_idx on reports (viewer_player_id)
        where viewer_player_id is not null;

      create table if not exists communes (
        id             text        primary key,
        world_id       text        not null references worlds (id) on delete cascade,
        name           text        not null,
        founder_handle text        not null,
        stockpile      jsonb       not null,
        created_at     timestamptz not null default now(),
        constraint communes_name_length check (char_length(name) between 3 and 30)
      );

      create index if not exists communes_world_idx on communes (world_id);

      create table if not exists world_stock (
        world_id text  primary key references worlds (id) on delete cascade,
        -- The region's finite pool. fuel/medicine/seeds are the meaningful entries.
        stock    jsonb not null
      );

      create table if not exists player_progress (
        player_id      text    primary key references players (id) on delete cascade,
        world_id       text    not null references worlds (id) on delete cascade,
        level          integer not null default 1,
        xp             integer not null default 0,
        skill_points   integer not null default 0,
        perks          jsonb   not null default '[]'::jsonb,
        -- A GAMEPLAY COUNTER, not money. Earned by claiming an objective, read by one achievement.
        -- Nothing in this service prices, posts or purchases anything with it, and there is no
        -- ledger client here for it to reach.
        tokens         integer not null default 0,
        streak         integer not null default 0,
        last_seen_day  integer not null default -1,
        days_survived  integer not null default 0,
        contribution   integer not null default 0,
        constraint player_progress_level_positive check (level >= 1),
        constraint player_progress_counters_non_negative check (
          xp >= 0 and skill_points >= 0 and tokens >= 0 and streak >= 0
          and days_survived >= 0 and contribution >= 0
        )
      );

      create index if not exists player_progress_world_idx on player_progress (world_id);

      create table if not exists objectives (
        id            text    primary key,
        world_id      text    not null references worlds (id) on delete cascade,
        player_id     text    not null references players (id) on delete cascade,
        bucket        integer not null,
        kind          text    not null,
        description   text    not null,
        target        integer not null,
        progress      integer not null default 0,
        period        text    not null,
        reward_xp     integer not null,
        reward_tokens integer not null,
        claimed       boolean not null default false,
        constraint objectives_period_known check (period in ('daily','weekly')),
        constraint objectives_kind_known check (
          kind in ('work','scavenge','trade','fortify','rest','survive_raid','survive_day')
        ),
        constraint objectives_progress_bounded check (progress >= 0 and progress <= target)
      );

      create index if not exists objectives_player_idx on objectives (player_id);

      create table if not exists achievements (
        id          text    primary key,
        world_id    text    not null references worlds (id) on delete cascade,
        player_id   text    not null references players (id) on delete cascade,
        ach_id      text    not null,
        name        text    not null,
        description text    not null,
        points      integer not null default 0,
        unlocked_at integer not null,
        -- Null until the leased delivery job has posted it to the worlds shared profile. The
        -- ancestor's achievements never left the world they were earned in.
        delivered_at timestamptz,
        -- The unique IS the idempotency: an achievement unlocks once per survivor, and a tick that
        -- re-evaluates it conflicts rather than unlocking twice.
        constraint achievements_player_ach_uniq unique (player_id, ach_id),
        constraint achievements_points_sane check (points between 0 and 1000)
      );

      create index if not exists achievements_player_idx on achievements (player_id);
      create index if not exists achievements_undelivered_idx on achievements (world_id)
        where delivered_at is null;

      create table if not exists world_events (
        id          text    primary key,
        world_id    text    not null references worlds (id) on delete cascade,
        day         integer not null,
        type        text    not null,
        title       text    not null,
        description text    not null,
        severity    integer not null,
        constraint world_events_type_known check (
          type in ('storm','disease_outbreak','raider_warband','caravan',
                   'resource_boom','resource_bust','season_milestone')
        )
      );

      create index if not exists world_events_world_idx on world_events (world_id, day desc);
    `,
  },
];

/** The version this build requires. `index.ts` asserts it at boot and refuses to serve below it. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** A new service leaves this at 0 — the frozen game's data is a copy, not a baseline. */
export const BASELINE_VERSION = 0;

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'world_events',
  'achievements',
  'objectives',
  'player_progress',
  'world_stock',
  'communes',
  'reports',
  'queued_actions',
  'players',
  'tiles',
  'worlds',
  'idempotency_keys',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
]);
