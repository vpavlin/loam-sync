# 1. Event-log CRDT, not state replication

- **Status:** accepted
- **Date:** 2026-08-13

## Context

Several devices (and, for shared datasets, several people) edit the same data while
offline, then reconnect. We need them to converge to **identical** state with **no
write silently lost** — the property "last writer wins on the whole record" fails
(two people editing different fields of the same calendar event would clobber each
other).

## Decision

Never store derived state and never mutate a record. Every change is an **immutable
event** `{v, id, type, hlc, dev, payload}`; the current state is a pure **fold** over
the merged event log. Merging two replicas is the **union of events by `id`**.

```
Event = { v:1, id:UUIDv4, type, hlc:{wall,ctr,dev}, dev, payload }
state = fold(mergeEvents(...logs))
```

- `id` (a client-generated UUIDv4) is the **idempotency key**: redelivering an event
  is a no-op. Waku *will* redeliver, so this is load-bearing, not a nicety.
- Union-by-id is idempotent, commutative and associative ⇒ **arrival order is
  irrelevant** and no concurrent value is ever overwritten at the log layer.
- Edits and deletes are just events the fold interprets (a field-scoped superseding
  event; a sticky tombstone). Concurrent edits to *different* fields both survive;
  a same-field conflict resolves last-write-wins **by HLC** (0002), deterministically.

## Alternatives rejected

- **Replicate state, LWW per record.** Silently drops concurrent writes; the whole
  reason we're here.
- **Operational Transformation.** Needs a central server or a total causal order in
  transit; both are the opposite of offline-first p2p.
- **A full OR-Set/RGA CRDT library per field.** Overkill: the event-log + fold gives
  us convergence with app-legible code, and the *app* decides each field's write-shape
  (commutative-delta vs per-actor-register vs LWW) at the fold, where it belongs.

## Consequences

- Convergence is testable and provable (shuffle + duplicate arrival, assert identical
  state — see `docs/adr/0005` and the convergence suite).
- The log only grows; compaction/GC is a future concern (snapshots), not a merge concern.
- The library is deliberately **agnostic to what the events mean** — `payload` is
  opaque to it (0007).
