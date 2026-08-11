/**
 * What this relay puts on the wire.
 *
 * No database — `buildEnvelope` is a pure function of a stored row, exported for exactly that
 * reason. The version defect below survived because every test of this outbox looked at the
 * INSERT and at the signature, both of which were right, and none looked inside the bytes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyEnvelope, type EventVersion } from '@cloudsforge/contracts-events'
import { buildEnvelope, type OutboxRow } from './outbox.ts'

/* ------------------------------------------------------------------ what goes on the wire */

/**
 * A real stored row, read from the mainnet estate on 2026-08-11 — micro-org#366.
 *
 * `nda.world.day_resolved` is the day roll, written by a scheduled job with NO actor and NO
 * correlation id — 8 of this service's 13 rows. The nulls are why this row is the fixture: an
 * invented row with an actor in it would have passed against the shipped code and proved nothing,
 * and it is the reason a version-only patch does not reach this service.
 */
const STORED_ROW: OutboxRow = {
  id: '03ec8780-e66b-4fde-8903-b7442b90a038',
  topic: 'nda.world.day_resolved',
  key: '0ef66815-fbed-4407-9e30-b926a55fa41d',
  occurred_at: new Date('2026-08-04T22:34:09.448Z'),
  producer: 'nda',
  version: 1,
  actor: null,
  correlation_id: null,
  payload: { day: 1, deaths: 0, worldId: '0ef66815-fbed-4407-9e30-b926a55fa41d', archived: false, aliveCount: 13 },
}

/**
 * **THE SIGNATURE WAS RIGHT AND THE ENVELOPE WAS NOT.**
 *
 * `@cloudsforge/contracts-events` types the wire version as "major.minor" — a STRING — and this
 * relay stamped the stored INTEGER. A delivery that verified was still discarded at the envelope
 * before any consumer read a payload. Eight relays did this at once and every suite in the estate
 * stayed green, because each one declared its OWN `EventEnvelope` and no compiler ever compared
 * the two.
 *
 * Measured with the contract's own `classifyEnvelope` against `STORED_ROW` on 2026-08-11:
 *
 *      as shipped -> malformed: version: missing, actor: missing, correlationId: missing
 *     fixed      -> well-formed; only the registration is outstanding
 *
 * The verdict is taken from the CONTRACT'S OWN classifier, never from a shape restated here. A
 * local copy of the rule agrees with a wrong implementation instead of catching it, which is the
 * mistake that produced the defect in the first place.
 *
 * MUTATIONS THIS KILLS — each one applied to `buildEnvelope` and each one confirmed red:
 *   - `version: row.version`, the stored integer, which is what shipped: `classifyEnvelope`
 *     answers `version: missing` and the defect assertion fails.
 *   - `version: String(row.version)` — a string, but "1" rather than "1.0": the shape assertion
 *     fails, so widening the fix to "any string" does not survive either.
 *   - `actor: row.actor` / `correlationId: row.correlation_id`, the nullable columns passed
 *     straight through, which is the other half of what the estate measured above.
 */
test('the envelope this relay puts on the wire is one the contract accepts', () => {
  const envelope = buildEnvelope(STORED_ROW)

  assert.equal(typeof envelope.version, 'string', 'an integer version is refused as "version: missing"')
  assert.match(envelope.version, /^\d+\.\d+$/, 'the contract types the wire version as "major.minor"')
  assert.equal(envelope.version, '1.0', 'major 1 as stored, minor 0 — storage records the major')
  // The nullable columns never reach the wire. `system` is the contract's own value for "no
  // principal did this"; the correlation id falls back to the event id so it is never absent.
  // This row has actor and correlationId null in storage, which is two of the defects measured above.
  assert.equal(envelope.actor, 'system')
  assert.equal(envelope.correlationId, STORED_ROW.id)

  // The topic is not in the contract's registry yet, so the honest verdict is `unregistered_topic`
  // and NOT `valid` — a different fact with a different remedy. What matters here is `defects`:
  // once the registration lands, an EMPTY defect list is the difference between this event being
  // read and being discarded, and `version: missing` is what used to be in it.
  const verdict = classifyEnvelope(envelope)
  assert.equal(verdict.reason, 'unregistered_topic', `got: ${JSON.stringify(verdict)}`)
  assert.deepEqual(verdict.defects, [], 'well-formed: the ONLY thing outstanding is the registration')
})

/**
 * The teeth of the test above. Without this, every assertion there would still pass against a
 * classifier that accepted anything at all, and "the contract accepts it" would be a claim about
 * this file rather than about the estate.
 */
test('the shape this relay used to send is REFUSED by the same classifier', () => {
  const asShipped = { ...buildEnvelope(STORED_ROW), version: STORED_ROW.version as unknown as EventVersion }

  const verdict = classifyEnvelope(asShipped)
  assert.equal(verdict.ok, false, 'an integer version must be refused at the envelope')
  assert.equal(verdict.reason, 'malformed', 'refused as malformed, not merely shelved as unregistered')
  assert.ok(
    verdict.defects.some((d) => d.startsWith('version')),
    `refused FOR THE VERSION, not incidentally: ${JSON.stringify(verdict)}`,
  )
})
