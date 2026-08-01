# micro-nda

*Ninety Days After* — the survival-strategy Forge Worlds title. Worlds, tiles, homesteads, queued
actions, the **day-resolution engine**, reports, communes, progress, objectives and world events.

Ported from `ninety-days-after/services/game`, which is frozen. Every `path:line` below points into
that repository.

---

## The headline: the resolution engine is byte-identical to the ancestor

**Yes.** `src/conformance.test.ts` replays 21 recorded worlds and asserts that every field the
ancestor made deterministic comes out the same.

The corpus is not this port played back at itself. `scripts/record-ancestor-corpus.ts` imports
`ninety-days-after/services/game/src/engine/resolve.ts` — that file, unmodified — seeds a real
Postgres with hand-built worlds, calls `resolveDay`, and reads back every row it wrote. It is a
one-shot, run by hand, because it reads a frozen repository that does not exist on a CI runner;
which is exactly why its output is committed rather than regenerated. This is the same method
`micro-emberkin` used against the C# `BattleEngine`.

Compared exactly, for all 21 worlds: every survivor's resources, hp, morale, defense, reputation and
alive flag; every ruin's remaining stock; the region's finite pool; the persisted `player_progress`
rows after the delta write; every objective row; every achievement row; every world event's type,
title, description and severity; and every report's kind, visibility, message, actor, target and
reader.

**Two columns are not compared, and cannot be.** `reports.id` and `world_events.id` were
`randomUUID()` in the ancestor (`services/game/src/engine/resolve.ts:827`,
`services/game/src/engine/events.ts:112`). They do not match a second run of the *ancestor* either.
This port derives both instead — `${worldId}:${day}:${ordinal}` and `${worldId}:${day}:${type}` —
so a resolved day is now comparable row-for-row with a replay of it, which is what let the corpus
assert on the whole result rather than on a chosen subset. `src/engine.test.ts` asserts that
derivation is stable and collision-free. Saying this out loud rather than quietly dropping two
columns is the difference between a proof and a claim.

Two further corpora exist because the day corpus structurally cannot reach them: `resolveDay` never
draws from `seededRng`, so mutating mulberry32's `0x6d2b79f5` by one left all 21 world assertions
green. mulberry32 lives in map generation and in a raider bot's choice of prey, so
`ancestor-maps.json` (7 maps, recorded tile-for-tile) and `ancestor-bots.json` (3 bot-planning
passes, recorded through the ancestor's own `enqueueBotActions`) cover it.

### The corpus was mutation-tested, which is what made it worth having

The first version was green against one-digit changes to the season upkeep step, the claimed-
objective guard, the warband threshold, the raid power divisor, the stock bust, the bot trade
reserve, and mulberry32. Eighteen mutations are now caught, and the scenarios that catch them say in
a comment what they are for. A corpus chosen by what looks interesting rather than by what the
arithmetic can hide is a corpus that proves very little.

---

## Defects found in the ancestor

### 1. World event severity can be zero, or negative

`services/game/src/engine/events.ts:130`:

```js
const severity = 1 + ((h >> 8) % baseSeverity)
```

`hash` ends in `>>> 0`, so `h` is unsigned 32-bit — but `>>` is an **arithmetic** shift. For any
`h >= 2^31`, which is half of all seeds, `h >> 8` is negative, JavaScript's `%` keeps the sign of
the dividend, and the severity comes out **0**, or **-1** in the season's final third where
`baseSeverity` is 3.

A severity-0 event fires, is announced in the day report, and does nothing at all — roughly 13% of
ambient events at `baseSeverity` 2. A severity **-1** `resource_boom` is worse: the world announces
*"Lucky Find — the region's stores swell"* and `flagsFromEvents` then computes
`stockBoom += 12 * -1`, **draining** the pool by 12 of each scarce resource. `hash('w-final-0010:85')`
is such a seed.

**Recorded, not repaired.** The headline claim of this repository is that a day resolves exactly as
the ancestor resolved it, and changing this formula would make that false for every world ever
played. It is pinned by a named corpus scenario
(`inherited-defect-a-lucky-find-of-negative-severity`) and by a test in `src/engine.test.ts` that
fails in **both** directions, so a fix has to arrive as a decision rather than as a diff. Changing
`>>` to `>>>` turns four tests red, which is the point.

### 2. The upkeep loop's order depended on the query plan

`services/game/src/engine/resolve.ts:116` read the roster with a bare `db.select()` and no
`ORDER BY`, then `resolve.ts:503` iterated that result for upkeep. Most of upkeep is per-player and
order-blind, but the disease relief draws from the world's finite medicine pool first-come — so with
fewer units than sufferers, *which* survivor was resupplied depended on the plan Postgres happened
to pick. The action loop already sorted (`resolve.ts:246`); this port extends the same total order
(oldest homestead, ties on id) to the rest of the day, and `src/engine.test.ts` asserts that
reversing the input roster does not change the day.

### 3. A `setInterval` guarded by a module-local variable

`services/game/src/engine/tick.ts:11` guards concurrent ticks with `const ticking = new Set<string>()`
— a variable that is, by construction, invisible to a second process. Correct with exactly one
replica. With two, both sweeps see the same due worlds. See "Two workers, one day" below.

---

## What was ported, what was rewritten, what was dropped

### Ported — transcribed, with the arithmetic unchanged

| Here | From | Notes |
| --- | --- | --- |
| `src/engine/resolve.ts` | `services/game/src/engine/resolve.ts:112-876` | The whole day. Now pure — see below. |
| `src/engine/trade.ts` | `services/game/src/engine/trade.ts` | Already pure; carried across essentially verbatim, rationale included. |
| `src/engine/events.ts` | `services/game/src/engine/events.ts:94-173` | Ids derived rather than random; takes a seed rather than the world id. |
| `src/engine/progression.ts` | `services/game/src/engine/progression.ts` | Plus `applyProgressDelta`, which the ancestor had inline at `resolve.ts:751-810`. |
| `src/engine/mapgen.ts` | `services/game/src/world/mapgen.ts` | Verbatim, including the two-draws-before-either-is-used ordering. |
| `src/engine/homestead.ts` | `services/game/src/world/homestead.ts` | Verbatim, comments and all. |
| `src/engine/bots.ts` | `services/game/src/engine/bots.ts:120-303` | The decision half; the database half moved to `src/worlds.ts`. |
| `src/engine/rng.ts` | `events.ts:9-34`, `progression.ts:24-33` | FNV-1a, mulberry32, LCG Fisher–Yates. |
| `src/rules.ts` | `@cloudsforge/shared@0.4.0` `src/game.ts` | See "where the rules live". |
| `src/communes.ts` | `services/game/src/routes/communes.ts`, `.../stipend.ts` | Handlers rewritten; the rules and their reasons are the ancestor's. |

### Rewritten — same behaviour, different machinery

| What | Was | Is | Why |
| --- | --- | --- | --- |
| Turn scheduling | `setInterval` + a module-local `Set` (`engine/tick.ts:46-72`) | a `world.tick` leased job keyed on `world_id` | Rule 8. A module-local guard cannot see a second process. |
| Schema | `CREATE TABLE IF NOT EXISTS` in a loop from `index.ts` (`db/migrate.ts:226`) | versioned migrations, one-shot migrator under an advisory lock | Rule 7. You could not ask the old one which schema a container was serving. |
| HTTP | Fastify + `@fastify/cors` + `@fastify/rate-limit` | `node:http` and the estate router | House style; CORS and rate limiting are the edge's now. |
| Data access | drizzle-orm | `postgres` template SQL | House style, and the constraints are in the migration where they can be tested. |
| Auth | bespoke `jose` wrapper (`auth.ts`) | `@cloudsforge/auth` `Verifier` | Rule: use the runtime, do not reimplement. |
| Entitlements | Forge Pay, forwarding the caller's own bearer (`clients/pay.ts`) | `micro-billing` with this service's scoped token | SD-05. |
| Achievements | rows in the world, dying with the season | recorded locally, bridged to `micro-worlds` by a leased job | The ancestor had no bridge at all. |
| Events out | nothing | Postgres outbox → signed HTTP → inbox, deduped on the source event id | Rule 5, AD-10. |
| Idempotency | none | every mutating route, fingerprint excluding per-attempt fields | Rule 6. |

### Dropped, on purpose

- **`player_cosmetics`** (`services/game/src/db/schema.ts:158`). An account-level wardrobe keyed on
  `user_id` made a per-title game service the second registry of what an account owns.
  `03-repository-responsibilities.md:168` assigns player identity, cosmetics and the entitlement
  bridge to `worlds`. What survives here is `players.cosmetic_style` — which slot *this survivor in
  this world* is wearing something in, which is simulation state and is ours.
- **CORS, the rate limiter, and `trust proxy`** (`services/game/src/env.ts:21-36`, `index.ts:44-50`).
  The browser does not talk to this service directly any more; `worlds-web` is a separate repository
  and the edge terminates both. The ancestor's own comment there was apologising for a limiter keyed
  on a spoofable forwarded address.
- **The three cosmetic kinds with nowhere to draw them.** `services/game/src/cosmetics.ts:16` kept
  three of six for exactly this reason. `commune_crest` is added back because a commune has a roster
  page to draw one on; map banners and herald flair still do not.
- **Any ledger client.** There is no `LEDGER_URL` and no `postEntry` anywhere. This service moves no
  value: cosmetics are billing entitlements, achievements are `worlds` rows, and the only integers
  it owns are game integers. `player_progress.tokens` is a gameplay counter earned by claiming an
  objective and read by one achievement; `src/cosmetics.test.ts` asserts there is no path from it to
  anything a customer paid for.
- **`GET /admin/worlds/:id/stats`**. Its content is `/metrics` plus the roster and leaderboard reads.

### Added

- **`worlds.seed`.** The ancestor used the world's id (`world/generate.ts:30` — "The world id is the
  map seed"), so identity and reproducibility were one value and a world could not be re-seeded
  without becoming a different row. Defaulted to the id on the way in, so a world carried forward
  replays exactly.
- **`achievements.points`.** `worlds`' shared profile takes a points value; the ancestor's badges
  never left their world and had none.
- **`identity.user.deleted`.** GDPR erasure. The survivor is **not** deleted — a world's history is
  other players' history too, the raids they survived and the trades they made. The account link and
  the handle go.

### Where the rules live

`docs/ecosystem/03-repository-responsibilities.md:177` assigns `shared-libs/packages/shared/game.ts`
to `cloudsforge-nda`, with the reason stated: *game rules are not a platform contract*. In the
ancestor they were in `@cloudsforge/shared`, a package the wallet, the mint and the identity service
all installed — so a balance tweak to the Farmer perk tree was a release all of them consumed. They
are in `src/rules.ts` now.

---

## Two workers, one day

`04-domain-model.md:513` names the harm exactly: `world.tick`, keyed on `world_id`, prevents
**"double XP and double days-survived"**. There are two defences, in order:

1. **The lease.** `world.tick` is a leased job keyed on the world id, claimed
   `for update skip locked` by `@cloudsforge/jobs`. Two runners cannot hold one key.
2. **The day re-check.** `persistDay` opens by taking `select ... from worlds where id = ? for
   update` and refuses unless the row still reads `status = 'active'` and the day the simulation was
   computed from. A second writer blocks on that lock, wakes to a day that has moved, and writes
   nothing.

`src/jobs.test.ts` proves the **second** without the queue at all — deterministically, by having a
separate connection take the world row's lock and move the day out from under a resolution that has
already simulated it. That is what holds when the first fails: an expired lease under a slow
resolution, an operator forcing a tick mid-sweep, a redelivered job. A defence only ever exercised
through the thing it backs up has never actually been tested. Deleting the re-check turns three
tests red.

The `where ... and day = ...` on the final `UPDATE` is a third line and is honestly redundant — the
row lock makes it unreachable, and deleting it turns nothing red. It is kept because it states the
invariant at the statement that would violate it, and it is documented as untested rather than
counted as a defence.

---

## Running it

```bash
pnpm install
cp .env.example .env          # then set OUTBOX_SIGNING_SECRET and NDA_SERVICE_TOKEN
pnpm migrate                  # a SEPARATE one-shot; index.ts asserts the version, never applies it
pnpm start
```

```bash
pnpm typecheck
NDA_TEST_DATABASE_URL=postgres://nda:nda@127.0.0.1:55560/nda_test pnpm test
```

The suite needs a real Postgres whose database name contains `test` — `resetNda` truncates every
table this service owns, and the name check is the difference between a red build and an emptied
environment.

```bash
docker build -t nda --build-context runtimepkgs=../runtime .
```

Only one build context: this service depends on no `@cloudsforge/contracts-*` package.

### Re-recording the ancestor corpus

Only if the frozen repository is on disk, and only by hand:

```bash
ANCESTOR_DATABASE_URL=postgres://nda:nda@127.0.0.1:55560/nda_ancestor \
  node --import tsx scripts/record-ancestor-corpus.ts
```

---

## The HTTP surface

`/livez` (static) · `/readyz` (Postgres hard; identity, billing and worlds soft) · `/metrics`

`POST /v1/events` — signature-checked over the exact bytes **before** parsing, then deduped on the
source event id. Subscribes to `billing.entitlement.granted` and `identity.user.deleted`.

Everything else is under `/v1/worlds`. Reads are GET; every other route is built by
`defineMutation`, which cannot be called without naming an Idempotency-Key policy —
`src/server.test.ts` walks the built router and fails if one slips through. `micro-market` shipped
two mutating routes with no idempotency at all, and that was found by enumerating routes, not by
anyone remembering.

---

## Tests

175, none skipped. `pnpm test`.

- `conformance.test.ts` — 21 recorded worlds replayed against the ancestor's own output.
- `engine.test.ts` — 7 recorded maps, 3 recorded bot plans, the RNG primitives pinned against
  values read out of the ancestor's `hash`, the derived-id properties, and determinism in both
  directions (same seed identical, different seed genuinely divergent).
- `jobs.test.ts` — the lease, and one day resolved once under two, five and stale-snapshot races.
- `domain.test.ts` — the invariants the ancestor fought for, including the ninety-day commune
  stipend farming loop replayed end to end.
- `server.test.ts` — route enumeration, idempotent replay, the signed webhook, report visibility,
  the cosmetic gate.
- `cosmetics.test.ts` — a cosmetic is never a stat, proved as an absence in the source and by
  resolving one seeded day twice, dressed and bare.
- `achievements.test.ts` — the worlds bridge: delivered once, outages delayed not lost, refusals
  terminal.
- `migrations.test.ts` — every constraint fires, by inserting the illegal row.
- `env.test.ts` — every required variable names itself when missing.
