# ADR 0013: HLC clock discipline on all platforms

- **Status:** Proposed
- **Date:** 2026-08-21

## Context

logos-sync orders a multi-writer event log by a Hybrid Logical Clock (per
ADR 0011 "HLC total order"): every event carries an `hlc` stamp, and the fold
resolves last-write-wins conflicts by comparing stamps. That ordering is only
correct if two disciplines hold on **every** node that authors events:

1. **Seed on boot/join** — the local clock must be primed from the highest stamp
   in the *full persisted log* before it issues its first new stamp
   (`Clock.primeFrom`).
2. **Advance on ingest** — for every event received from a peer, the clock must
   observe that event's stamp (`clock.receive(e.hlc)`) *before* the next local
   stamp is minted.

Without both, a device's clock can trail the events it already holds. The next
local edit is then stamped *lower* than an edit it is meant to supersede, and the
LWW fold silently keeps the stale value — a user's newer change is reverted with
no error. This is exactly the failure the 2026-08 sync review rates its
**highest-value safe fix (fix #1)**: silent LWW data-loss under clock skew or
same-millisecond concurrency.

The review found the discipline is applied unevenly across the four apps and two
platforms:

- **scala mobile** already implements the reference pattern —
  `Clock.primeFrom` on context load and `clock.receive` on every incoming event.
- **kym mobile** (`BudgetContext.ingest`) omits `clock.receive`, so ingested
  peer stamps never advance the local clock.
- **kym_core** (desktop) mints stamps via a bespoke `nextHlc` and does not prime
  from or receive across the persisted log.
- **scala desktop** carries an ad-hoc `m_wall` / `m_ctr` pair in
  `scala_impl` (`applyIncoming` / `onContextReady`) rather than the shared
  `Clock`, and does not seed/receive consistently.

The mechanism is entirely local: it changes only how each node *derives* its own
stamps from what it has already seen. The wire format, the sealed-Event
envelope, the fold contract, and the fingerprint/catchup paths are all
unchanged.

## Decision

**Every platform seeds its HLC from the full persisted log on boot/join, and
calls `clock.receive(e.hlc)` for every ingested event before issuing the next
local stamp.**

Concretely:

- On boot or on joining a container, call `Clock.primeFrom(log)` over the
  *complete* persisted log — not a recent window — so the clock starts at or
  above the highest stamp the node already holds.
- In the ingest path, for each incoming event, call `clock.receive(e.hlc)`
  before any subsequent local authoring. This applies to events from live
  relay, catchup serves, and cold-start store-pull alike.
- Use the **shared `logos-sync` `Clock`** as the single implementation. The
  desktop ad-hoc `m_wall`/`m_ctr` and the `kym_core` `nextHlc` are replaced by
  it, so mobile and desktop derive stamps identically and cannot drift.

**scala mobile is the reference implementation.** The port brings the others to
parity:

- kym mobile `BudgetContext.ingest` — add `clock.receive` on every ingested
  event; prime from the persisted budget log on load.
- kym_core — replace `nextHlc` with the shared `Clock`; prime and receive across
  the merged log.
- scala desktop `scala_impl` `applyIncoming` / `onContextReady` — adopt the
  shared `Clock` with `primeFrom` on ready and `receive` on incoming.

This is mandatory for **mobile and desktop of all four apps**; a node that
authors events without both disciplines is a correctness bug.

Fold-parity note carried from the review: while touching the kym fold, restore
`account.edit`'s `closed` field in `kym_engine.hpp` so the desktop fold matches
mobile.

## Consequences

**Correctness.** Closes the silent LWW data-loss window: once a node has seen an
event, any local edit it makes is stamped strictly after it, so a newer edit can
never be reverted by a stale one under skew or same-ms concurrency.

**Purely local — no wire or fold change.** Nothing on the wire changes; peers
that have not yet adopted the discipline still interoperate. There is no
flag-day and no coordinated migration. Each app/platform can adopt independently.

**Rollout / compatibility.**
- Land per app, per platform, at leisure — mobile and desktop of one app need
  not ship together, and apps are independent.
- A mixed fleet is safe: an un-updated node is the *only* one that can still
  emit an under-stamped event and lose its own concurrent edit; it never harms a
  peer's data. Updating that node fixes it. Convergence between nodes is
  unaffected either way because the fold and wire are unchanged.
- No data migration is required. `primeFrom` reads the existing persisted log as
  it already is; historical events keep their stamps.

**Risks.**
- **`primeFrom` must read the *full* log, not a recent window.** If it seeds
  from a truncated or paged subset, the clock can start below stamps the node
  actually holds and the data-loss window reopens. On large logs this is an
  O(N) scan at boot — acceptable, but a place where a well-meaning "optimize the
  cold path" change could silently reintroduce the bug. Guard it with a test.
- **`clock.receive` must run before persistence-driven re-authoring.** Any
  ingest path that folds/persists an event without first advancing the clock
  (e.g. a batched cold-start ingest — see fix #7) must still `receive` every
  stamp in the batch before the next local stamp. Batching must not skip the
  receive.
- **Replacing bespoke clocks changes stamp derivation subtly.** Swapping
  `nextHlc` / `m_wall`+`m_ctr` for the shared `Clock` must preserve monotonicity
  across the swap (the new clock must start no lower than the old one left off),
  or the first post-upgrade stamp could regress. Prime from the persisted log on
  first run after upgrade covers this.

## Related fixes

From the 2026-08 sync review (`docs/sync-review-2026-08.md`):

- **Fix #1 — Seed HLC from the log on boot/join and call `clock.receive()` on
  every ingest (kym mobile + kym_core + scala desktop).** This ADR is the
  decision record for that fix; scala mobile is the named reference pattern.
- **Fix #7 — Batch cold-start ingest.** Must still `receive` every stamp in a
  batched window before the next local stamp; the two fixes touch the same
  ingest path and must not conflict.
- **Fix #13 — Converge kym + qaku onto logos-sync.** The strategic endpoint that
  makes the shared `Clock` (and one fold/fingerprint/catchup) the single source
  of truth; this ADR is the local, non-wire down payment that can land first.
- **ADR 0011 (HLC total order).** Defines the clock this decision disciplines;
  this ADR makes the seed-and-receive contract mandatory on every authoring node
  rather than assumed.
