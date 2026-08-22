# ADR 0012: Ephemeral control plane

- **Status:** Proposed
- **Date:** 2026-08-21

## Context

The sync wire carries two kinds of message. **Data events** are the durable,
sealed, immutable log entries an app authors (per ADR 0010 the log *is* the
state). **Control-plane messages** are the transient reconciliation traffic that
drives backfill — `SYNC_REQ`, the catchup `fp` / `ids` / `need` rounds, and
`SUMMARY`. Only the first kind is history; the second kind is a live negotiation
between two peers that are online *right now* and is worthless once that exchange
completes.

Today both kinds are published the same way — **non-ephemeral** — so the fleet
store persists control messages forever alongside real events. This produces the
cold-start reconciliation storm the 2026-08 sync review flagged as a top-priority
bandwidth/cold-start defect:

- On cold start a joining device does a store-pull to bootstrap history. That pull
  returns not just data events but every historical `SYNC_REQ` and catchup round
  ever sent on the topic.
- At least one app's receive path routes those store-pulled control messages
  straight back into `respond()` / `serveLog` — it treats a months-old `SYNC_REQ`
  as a live request and **re-answers it by re-broadcasting its whole log**. Every
  joiner triggers a fresh whole-log reconciliation, which itself is published and
  stored, which the next joiner re-pulls and re-answers.
- The stored control traffic also inflates the per-topic message count against the
  **2500-msg/topic store-pull cap** (see ADR 0011), so cold-start pulls truncate on
  reconciliation noise and drop genuine history.

The mechanism is entirely in how messages are published and how the store-pull
path folds what it receives. It needs no wire-format change: live subscribers
already receive *relayed* messages whether or not the store keeps a copy, so
reconciliation between two online peers works identically if control messages are
never stored at all.

## Decision

**Control-plane messages are published ephemeral.** `SYNC_REQ`, the catchup
`fp` / `ids` / `need` rounds, and `SUMMARY` — and any re-serve intended only for a
live peer — are published with `ephemeral: true`. Ephemeral messages are relayed
to current subscribers but **never persisted to the fleet store and never
SDS-retransmitted**. They exist only for the duration of the live exchange.

**Data events remain non-ephemeral and sealed.** Durable log entries are still
published `ephemeral: false` and sealed exactly as before (ADR 0011's deterministic
nonce applies to them). They are the only thing the store keeps and the only thing a
cold-start pull should ever return.

**Receivers fold EVENT-only and never route store-pulled control into the
responder.** Independent of the ephemeral flag, the receive / store-pull path is
guarded to fold `type === 'EVENT'` messages only, and to **never** hand a
store-pulled control message to `respond()` / `serveLog`. This is a defence in
depth: it protects against legacy non-ephemeral control messages already sitting in
the store, and against any peer still on an old sender that has not yet adopted the
ephemeral flag.

Together these kill the cold-start reconciliation storm at both ends — nothing new
gets stored to re-pull, and anything already stored is filtered before it can
trigger a re-answer.

Plumbing: an `ephemeral` flag is threaded through `publishSealed` / `sendEvent` on
mobile (the real-node path currently hardcodes `ephemeral: false`) and exposed on
the desktop `loam_core` / `sendSealed` path. The EVENT-only guard is added to
`storeSync` / `onEvent`.

## Consequences

**Store and bandwidth.** The fleet store stops accumulating reconciliation traffic;
its per-topic count reflects real events only, so the 2500-msg cold-start cap is
spent on history instead of noise. Cold-start no longer amplifies into a whole-log
re-broadcast per joiner.

**Rollout / compatibility.** Backward-compatible and no flag-day. The ephemeral
flag is a publisher-side choice; live subscribers still receive relayed control
messages regardless, so a new sender and an old sender interoperate. Senders adopt
independently and **per app at leisure** — mobile and desktop of one app do not
have to flip together, and one app flipping does not affect another. The EVENT-only
receive guard is a pure local receive-path filter and should land first, since it
protects a device from control messages other (un-migrated) peers still store.

**Risks.**

- *Legacy stored control messages* linger in the store until fleet/hub retention
  ages them out. The EVENT-only guard is what makes this harmless in the interim —
  it must ship before or with the ephemeral publish change, not after.
- *A dropped ephemeral message is never recoverable from the store* — that is the
  point, but it means reconciliation must be self-healing rather than relying on a
  later store-pull to recover a lost `SYNC_REQ`. Re-triggering catchup on peer-up /
  reconnect edges and while `behind > 0` (review fix #4) is the companion mechanism
  that makes ephemeral control safe.
- *Ordering with responder election* — if a control message is both ephemeral and
  suppressed by responder election (review fix #10), a slow responder tier must not
  be the only holder; the always-on hub (review fix #6) remains the canonical live
  responder for its shard.

## Related fixes

From the 2026-08 sync review (`docs/sync-review-2026-08.md`):

- **#3** *(S/low)* — Guard `storeSync`/`onEvent` to fold EVENT-only and never route
  store-pulled control messages into `respond()`/`serveLog`. The receive-path half
  of this decision; qaku already guards `env.type === 'EVENT'`, kith and scala do
  not.
- **#11** *(S/low/WIRE)* — Send control-plane messages (`SYNC_REQ` / catchup
  `fp`/`ids`/`need` / `SUMMARY`) as ephemeral on both platforms. The publish-side
  half; threads the ephemeral flag through `publishSealed`/`sendEvent` and
  `loam_core`/`sendSealed`.

Supporting / adjacent:

- **#4** *(M/low)* — Self-healing catchup (re-trigger on peer-up/reconnect and while
  `behind > 0`) is the recovery mechanism that makes non-durable control safe.
- **#6** *(M/low)* — Always-on store-backed hub per shard as the canonical live
  responder.
- **#10** *(M/medium/WIRE)* — Responder election (jitter + seen-serve suppression)
  interacts with which peer emits the ephemeral serve.

See also ADR 0011 (deterministic AEAD nonce), which addresses store dedup for the
*data* events this ADR keeps non-ephemeral.
