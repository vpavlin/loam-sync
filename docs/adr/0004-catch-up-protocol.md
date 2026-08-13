# 4. The catch-up protocol: recursive set reconciliation

- **Status:** accepted
- **Date:** 2026-08-13

## Context

0003 decided *what* to transfer (only the difference). This ADR fixes *how* the peers
talk. There is a hard transport constraint that shapes the answer: the delivery
module **fails to encrypt multi-segment channel sends** (`no provider registered for
input signature … one or more segments failed`). So **every protocol message must fit
in a single segment** (a few hundred bytes) — a message that grows with the log is not
allowed on the wire at all.

## What we tried first (and rejected)

**v1 — "summarise then serve the complement":** the requester puts its entire id-list
in one `SYNC_REQ`; the server serves `myLog \ have`. Simple, and the *downstream* is
minimal. But the *request itself* is O(N) and **segments** for even ~15 events — so it
literally cannot be sent. v1 was implemented, hit the wall in testing on the hub, and
is superseded here.

## Decision

**v2 — recursive Range-Based Set Reconciliation on the wire.** Peers exchange bounded
range statements over the sorted (by id) id-set:

```
"fp"   { from, lo, hi, bounds:[id…], fps:[hex…] }   range (lo,hi] split into fps.length
                                                    sub-ranges, one fingerprint each
"ids"  { from, lo, hi, ids:[id…] }                  my exact ids in a small range
"need" { from, ids:[id…] }                          serve me exactly these events
```

- A joining/reconnecting peer publishes an `fp` message over the whole range
  (`buildInitial`, `buckets` fingerprints).
- `respond(myLog, msg)` is a **pure** step: a range whose fingerprints agree is
  dropped; a large disagreeing range is answered with sub-range `fp`s; a small one
  drops to an `ids` list. From a received `ids` list a peer serves exactly what the
  peer lacks and replies `need` for exactly what it lacks. The app publishes the
  returned messages/events (sealed, over logos-transport) and ignores its own `from`.
- **Every message is bounded** — `buckets` fingerprints, or ≤ `threshold` ids — so it
  is always a single segment. Measured: a 200-event log with a 3-event delta converges
  in a handful of messages, **max message 375 bytes**.
- **Convergence:** fingerprint agreements drop ranges, splits shrink them, `ids`/`need`
  exchanges transfer the exact missing events — the symmetric difference strictly
  shrinks each round, so it terminates. A fresh peer (empty set) disagrees on the whole
  range and recurses down to receive everything; a peer two minutes behind recurses
  only into the one range that changed.

### Operational rules (or it silently delivers nothing)

- **Trigger on a timer, not once.** The mesh needs ~10 s to form after `start()`; a
  single message at "ready" is lost. Re-send `buildInitial` at **0 / 3 / 10 / 25 s**.
  Idempotent — the reconciliation just re-runs and finds agreement.
- **Broadcast-tolerant.** Messages carry `from` for self-ignore; serves are idempotent
  (dedup by id). Over a channel with a few peers the redundant responses damp out as
  ranges reach agreement.

## Consequences

- Backfill is **on-demand, bidirectional, id-exact, and always single-segment** — no
  steady-state traffic, no segmentation wall, no whole-log re-broadcast.
- The app owns the **trigger** (node lifecycle) and the **transport** (seal + publish);
  logos-sync owns the **decision** (`buildInitial` / `respond`). Clean seam.
- `threshold`/`buckets` trade round count against message size; the defaults (8/8) keep
  messages a few hundred bytes and depth ≈ log₈(N).
