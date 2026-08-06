/**
 * The deterministic randomness this game is built on.
 *
 * Nothing in the resolution engine calls `Math.random()`. Every draw comes from a stream keyed on
 * a string that names exactly what is being decided — `${worldId}:${day}` for the event schedule,
 * `${worldId}:${day}:${botId}:raid` for a raider's target, `${seed}:terrain` and `${seed}:ruins`
 * for the map. That is what makes "same seed + same inputs → byte-identical resolution" a fact
 * about the code rather than an aspiration.
 *
 * Ported verbatim from `ninety-days-after/services/game/src/engine/events.ts` (FNV-1a and
 * mulberry32) and `.../engine/progression.ts` (the LCG-driven Fisher–Yates). The bit
 * operations are transcribed exactly — `Math.imul`, `>>> 0`, `| 1`, `| 61`, the `/ 4294967296`
 * divisor — because every one of them is part of the answer. `conformance.test.ts` replays a
 * corpus recorded from the ancestor to prove it.
 *
 * A note on why these are 32-bit and not 64: they are what the ancestor ran. A "better" PRNG here
 * would be a different game, and every recorded world would stop replaying.
 */

/** Stable 32-bit FNV-1a hash. Deterministic per input string. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG — mulberry32 seeded by the FNV-1a hash of `seed`. Yields [0, 1). */
export function seededRng(seed: string): () => number {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic Fisher–Yates via a 32-bit LCG. Same seed → same order.
 *
 * The `|| 1` on the seed is not decoration: an LCG whose state is 0 is still an LCG, but
 * `hash('')` is 2166136261 and never zero, so the guard only ever fires for a caller passing a
 * literal 0. Kept because the ancestor has it and a shuffle order is exactly the kind of thing
 * that must not change.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const a = out[i];
    const b = out[j];
    // `noUncheckedIndexedAccess` makes the two reads `T | undefined`; both indices are in range by
    // construction (i < length, j <= i), so the guard is a type narrowing, never a branch taken.
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}
