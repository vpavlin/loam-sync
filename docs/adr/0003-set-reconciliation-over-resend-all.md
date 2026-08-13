# 3. Set reconciliation, not resend-all

- **Status:** accepted
- **Date:** 2026-08-13

## Context

A peer that starts cold, or was offline past the live-reliability window, is missing
events. SDS Reliable Channels do **not** fix this: they heal *live* drops (a missed
message is re-requested via its successor's causal history and retransmitted), but
they don't reconstruct arbitrary history — causal-history depth is bounded, the
retransmit buffer is bounded, and liblogosdelivery exposes **no Store query on
desktop**. So backfill is the app's job.

The first, naive backfill (Qaku's, and what Scala nearly copied) is a hub that
**re-broadcasts the entire log on a timer** (every 60 s). It works, but:

- the cost is O(log size) **every tick, forever**, and grows with every event;
- it re-seals and re-sends events every peer already has;
- it was already observed amplifying "into a shard flood" at shorter intervals.

That is a brute-force safety net, not a design.

## Decision

Compute the **exact set difference** and transfer only the events a peer is actually
missing. Two mechanisms, same result:

- **v1 — id-summary + complement** (`catchup.hpp`, see 0004): the requester lists the
  ids it holds; the server sends `myLog \ have`. Downstream is minimal; upstream is
  the id list (O(N), one-time per reconnect).
- **v2 — Range-Based Set Reconciliation** (`reconcile.hpp`): peers exchange 16-byte
  fingerprints over sorted `(wall, id)` ranges and recurse only where they disagree,
  learning the exact symmetric difference. Upstream drops to O(log N + diff).

Both give the property the user asked for: *a fresh peer needs everything; a peer two
minutes behind needs only the gap.* v1 ships first because it makes the **downstream**
(the expensive part) minimal with trivial code; v2 is the bandwidth-optimal upgrade
for logs that grow large.

The RBSR fingerprint (XOR of `SHA-256(id)`, folded with the count) is
**order-independent**, so two peers holding the same id-set in a range always agree —
and its byte layout is a cross-language parity contract (0005).

## Alternatives rejected

- **Periodic full re-broadcast.** The status quo we're replacing; unbounded waste.
- **Waku Store query.** The right archive mechanism, but not exposed on desktop by
  liblogosdelivery — so it can't be the desktop backfill path today.
- **A high-watermark ("send me events after time T").** Lossy: a concurrently-authored
  event with an earlier HLC that arrived late would be silently skipped. Set-based
  reconciliation is correct where a watermark is not.

## Consequences

- No periodic traffic at all: backfill happens **on join/reconnect**, then stops.
- v1's upstream id list is bounded by the log size; for the calendar/Q&A/budget scale
  this is kilobytes. The migration to v2 is transparent to apps (same `catchup` API).
