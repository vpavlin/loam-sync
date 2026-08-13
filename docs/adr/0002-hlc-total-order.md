# 2. HLC for a deterministic, replica-identical order

- **Status:** accepted
- **Date:** 2026-08-13

## Context

The fold needs a **total order** over events that is (a) identical on every device
and (b) roughly respects causality, without a central sequencer. Wall-clock time
alone is neither: two devices' clocks differ, and equal timestamps need a tiebreak.

## Decision

Every event carries a **Hybrid Logical Clock** `{wall, ctr, dev}`. The total order is
`wall → ctr → dev`:

```
compareHlc(a,b) = (a.wall - b.wall) || (a.ctr - b.ctr) || cmp(a.dev, b.dev)
```

- `wall` — a millisecond timestamp, **for ordering only**. Never use it for a
  quantity or an amount: a lagging clock must never change a number.
- `ctr` — increments for multiple events stamped within the same millisecond,
  carrying causal information forward.
- `dev` — the author's stable device id, the final tiebreak, so the order is *total*
  (no two distinct events compare equal) and identical everywhere.

The `Clock`:
- `send(nowMs)` stamps a new local event (monotonic wall; ctr resets on a new ms).
- `receive(hlc)` advances the clock past an ingested event's cause.

**Two rules that are easy to get wrong:** call `receive()` for *every* event you
ingest, and **prime the clock from your whole log on load**. Skip either and a device
can author an event that sorts *before* a cause it has already seen — a silent
ordering bug that only shows up as "my edit didn't win when it should have."

## Alternatives rejected

- **Plain wall clock.** Clock skew reorders events across devices; equal-ms ties are
  undefined. Non-deterministic order ⇒ non-convergent fold.
- **A pure Lamport counter.** Loses the wall component, so the UI can't show a sensible
  "when," and cross-device ordering drifts from real time.
- **Vector clocks.** O(devices) metadata per event for an ordering an HLC gives in 16
  bytes; we don't need per-pair causality, just a deterministic total order.

## Consequences

- The reconciliation key is exactly `(wall, id)` (0003) — the HLC and the backfill
  order agree by construction.
- `wall` being ordering-only is a rule the *app* must honour for quantities (store
  money/counts as integers in `payload`, never derive them from `wall`).
