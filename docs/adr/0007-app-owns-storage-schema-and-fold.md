# 7. The app owns storage, schema, and the fold

- **Status:** accepted
- **Date:** 2026-08-13

## Context

The four apps store their logs differently (Scala: sqlite blobs of gzipped GPX and
per-calendar event tables; KYM/Qaku: their own persistence; mobile: localStorage /
files). Their events also *mean* different things — a calendar `event.put`, a Q&A
`vote`, a budget `delta`. logos-sync must serve all of them without owning any of it.

## Decision

The library never owns storage or interprets a payload. The app supplies:

1. **Event `type` + `payload` schemas** — logos-sync treats `payload` as opaque JSON.
2. **The fold** `computeState(mergedLog) → state` — pure and deterministic, and where
   each field's write-shape is chosen: a **commutative delta** for a true accumulator
   (KYM's balance), a **per-actor register** for "who did it" counters (a vote/RSVP),
   or **LWW-by-HLC** for a single-valued field (a title, a calendar event). Getting
   this classification right is the real modelling work; the library can't do it for
   you because only you know the field's meaning.
3. **A store adapter** — the minimal surface the catch-up path needs:
   `allEvents()` (for `buildRequest` / `answerRequest`), `append(e)` (persist a merged
   event), and the accessors `idOf` / `hlcOf` (already `Event` fields).

logos-sync calls *out* to these; it holds no database handle.

## Alternatives rejected

- **A built-in store.** Would fight each app's existing persistence and force a
  migration; and the "right" store (sqlite vs localStorage vs a blob) differs per
  platform anyway.
- **A generic fold engine with a rules DSL.** The fold is ~30 lines of plain code per
  app and needs full language power (the tombstone-is-terminal rule, the per-actor
  aggregation); a DSL would be less clear and less testable than the code it replaces.

## Consequences

- Adopting logos-sync is **additive**: keep your storage and your fold, delete only
  the bespoke merge/reconcile/backfill and call the library's.
- The **invariant oracle** (does the balance sum to zero? is at most one answer
  accepted?) also stays app-side — it's a property of the folded state, asserted in
  the app's convergence test (0001, 0005), never enforced at merge.
