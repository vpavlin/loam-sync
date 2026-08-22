# ADR 0014: Cold-start bootstrap contract

- **Status:** Proposed
- **Date:** 2026-08-21

## Context

A device that joins a topic cold — a fresh install, a reinstall, a new peer, or
one that has been offline long enough to fall behind — must reconstruct the shared
log before it can converge. Per ADR 0010 the log *is* the state, so "cold start"
means "pull enough of the event log to fold a correct current state, then close
whatever delta remains." The 2026-08 sync review flagged cold-start as the #1
priority and found today's bootstrap fragile on both counts — the initial bulk
pull is unavailable on whole classes of node, and the delta-closing catchup is
one-shot and gives up too early.

Two mechanisms exist and neither is sufficient alone:

- **Store-query bootstrap** pulls historical events from the fleet/hub store in
  bulk. It is the cheap way to acquire most of the log at once, but it is only
  wired on *embedded* mobile nodes. Desktop cores have **no store-query path at
  all** (a fresh desktop join gets history only if a live peer happens to be
  inside the retry window). Shared-node phones — the Loam ecosystem direction —
  have a **stubbed `storeSync` returning `{0,0}`**, a cold-start regression versus
  embedded phones. And the store can only ever be answered by the fleet or an
  always-on Core node; a phone is Edge-only and cannot serve it.

- **Recursive RBSR catchup** (ADR 0013) closes the residual delta between two
  peers by exchanging range fingerprints. Today it is scheduled as a **one-shot
  time-boxed burst** — the `0 / 3 / 10 / 25s` window on `onContextReady`, then
  never again. A peer that comes online at t=60s, a fleet node that recovers after
  the known 0-peer node-drop, or `joinByLink` racing the transport, all fall
  outside the window and are never re-asked until the app restarts. Because the
  control plane is now ephemeral (ADR 0012), a dropped `SYNC_REQ` is *not*
  recoverable from the store — so the schedule, not the store, is what must
  guarantee eventual convergence.

There is also a per-event cost problem. Cold-start ingest is currently `O(N^2)`:
each served event triggers a whole-log read + merge + rewrite plus a full UI
re-fold, and dedup is a linear scan. On a phone over AsyncStorage this dominates
cold-start time and can make a large backfill feel like a hang.

The mechanisms are complementary, not redundant: store-query gets the bulk cheaply
where it exists, catchup closes the tail *and* works peer-to-peer where no store
responder is present. The contract below fixes which runs when, makes the second
self-healing, and bounds the ingest cost.

## Decision

Cold-start bootstrap is a **two-path contract**: store-query first where exposed,
then recursive catchup to close the residual delta and hold convergence open.

**Path (a) — store-query bootstrap, on every platform that exposes it.** On join
and on cold boot a node pulls the fleet/hub store first to acquire the bulk of the
log in one shot. This path is available on:

- *Embedded mobile* nodes (already wired).
- *Shared-node phones*, by implementing `service-node.storeSync` as a
  **`storeQuery` proxy over the AIDL surface** to the shared Loam node — replacing
  the `{0,0}` stub — so a shared-mode phone gets the same fleet-store pull as an
  embedded one. The AIDL method is **appended**, never inserted mid-interface, per
  the Loam txn-id ordering rule.
- *Desktop cores*, once `waku_store_query` is bridged into the desktop
  `delivery_module` / `loam_core` (larger FFI work, sequenced after the always-on
  hub is in place — see Consequences).

Where the store path is genuinely unavailable, path (a) is simply skipped and
path (b) carries the whole bootstrap.

**Path (b) — recursive RBSR catchup, and it is self-healing.** After the initial
pull, recursive catchup (ADR 0013) reconciles the residual delta. Its scheduling
is no longer a one-shot window; it is **re-triggered**:

- on every **peer-up / reconnect edge** — hook the `setStatus` /
  `onStatusChanged` Connected transition, so a peer or a recovered fleet node that
  appears after startup is re-asked;
- on a **slow periodic tick while the local set reports `behind > 0`** — the
  device keeps nudging until its own deficit signal clears, rather than trusting a
  fixed timer;
- from **`joinByLink`** with the same retry cadence as `onContextReady`, so a
  link-join that races the transport still converges.

The `0 / 3 / 10 / 25s` startup burst is kept as the fast initial cadence, but it is
now the *floor*, not the ceiling. This is a local scheduling change only — no wire
format changes.

**Store-query is preserved, not replaced.** When kym/qaku migrate onto the
logos-sync recursive catchup wire, the store-query bootstrap path stays. Catchup
converges the *tail*; store-query is still the cheap way to acquire the *bulk*, and
it is the only path that works when no live peer or hub is currently reachable but
the fleet store is. The migration retires the whole-log `SYNC_REQ` re-serve, not
the store pull.

**Cold-start ingest is batched.** The receive path does not fold event-by-event
during a backfill. It:

- **accumulates a catch-up window** of incoming events;
- **persists and folds once** per window (one storage write, one merge), instead
  of a read-merge-rewrite per event;
- keeps an **in-memory id set** so dedup is `O(1)`, not a linear log scan;
- **debounces change notifications** (`notifyChange` / `bookChanged`) to one UI
  refresh per tick.

This makes bootstrap `O(N)` instead of `O(N^2)` with no wire change.

## Consequences

**Cold-start becomes reliable across node classes.** Shared-node phones and (once
bridged) desktop cores get the same store-pull bootstrap embedded phones already
have, so history no longer depends on a live peer happening to be awake inside a
25-second window. The self-healing catchup guarantees that any peer or fleet node
appearing later — or recovering from the 0-peer drop — is eventually reconciled,
which is what makes the ephemeral control plane (ADR 0012) safe: convergence is
guaranteed by re-triggering, not by the store retaining a lost `SYNC_REQ`.

**Performance.** Batched ingest removes the per-event whole-log rewrite and the
linear dedup scan that dominate cold-start on AsyncStorage; large backfills stop
reading as hangs. Land it kith-first, then generalize to the shared fold.

**Rollout / compatibility.**

- The **self-healing schedule** and **batched ingest** are local-only changes
  (no wire impact) and can land per app, per platform, at leisure. They are the
  safe, high-value first steps and should ship before the wire migration.
- The **shared-node `storeSync` proxy** is an append-only AIDL addition; existing
  clients are unaffected as long as the method is appended, not inserted.
- The **desktop `store_query` bridge** is append-only FFI work with no
  wire-protocol change. It is partly covered operationally by the always-on hub
  (a topic with an always-on Core responder needs desktop store-pull less
  urgently), so it is sequenced *after* the hub is stood up.
- **Store-query is preserved through the catchup migration**, so kym/qaku do not
  lose bulk bootstrap when they adopt the logos-sync recursive catchup wire.

**Risks.**

- *Skipping path (a) silently.* On a platform where store-query is unavailable, the
  whole bootstrap rests on path (b) reaching a live responder. The always-on
  store-backed hub per shard (review fix #6) is the mitigation — a topic must have
  at least one always-on Core member, or a long-offline cold start can only be
  served by a peer that happens to be online.
- *Self-healing tick chattiness.* A device that is genuinely `behind > 0` with no
  responder present will keep ticking. Responder election (jitter + seen-serve
  suppression, review fix #10) keeps this quiet in hub topics; the tick must be
  slow enough that a no-responder topic does not spin.
- *Batch window latency.* Debouncing trades a small amount of freshness for
  throughput during backfill. The window must be bounded so steady-state (non
  cold-start) events still surface promptly; batching is a cold-start optimization,
  not a steady-state one.

## Related fixes

From the 2026-08 sync review (`docs/sync-review-2026-08.md`):

- **#4** *(M/low)* — Make catchup / `SYNC_REQ` self-healing: re-trigger on
  peer-up / reconnect edge and periodically while `behind > 0`; add retry to
  `joinByLink`. This is path (b) of the decision.
- **#5** *(M/medium)* — Implement `service-node.storeSync` by proxying
  `storeQuery` over AIDL to the shared Loam node. Brings shared-node phones onto
  path (a); append-only AIDL method.
- **#7** *(M/low)* — Batch cold-start ingest: accumulate a window, persist+fold
  once, in-memory id set, debounce notifications. The performance half of the
  decision (kith first, then the shared fold).
- **#17** *(L/medium)* — Bridge `waku_store_query` into the desktop
  `delivery_module` / `loam_core` so desktop cores get path (a). Sequenced after
  the hub (#6).

Supporting / adjacent:

- **#6** *(M/low)* — Always-on store-backed hub per shard as the canonical
  backfill responder; the mitigation for topics with no other Core member. See
  ADR "Responder topology and always-on store-backed hub".
- **#10** *(M/medium/WIRE)* — Responder election keeps the self-healing tick quiet
  in hub topics.
- **#12 / #13** *(WIRE)* — The kym/qaku migration onto logos-sync recursive
  catchup; this ADR fixes that store-query bootstrap is **preserved** through that
  migration, not replaced.

See also ADR 0012 (ephemeral control plane), whose non-durable control traffic is
precisely why path (b) must be self-healing, and ADR 0013 (catchup protocol),
whose recursive RBSR this contract schedules.
