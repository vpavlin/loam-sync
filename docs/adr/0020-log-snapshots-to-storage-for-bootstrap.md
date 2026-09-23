# ADR 0020: Log snapshots to Storage for bootstrap catch-up

- **Status:** Proposed (2026-09-23)
- **Relates to:** 0018 (tombstone semantics), 0019 (no backwards-compat pre-1.0), the RBSR catch-up path;
  complements loam-transport ADR 0018 (RLN readiness) but is independent of it.

## Context

A device joining a container (a calendar, a budget, a Q&A) for the first time — or reconnecting after a
long absence — must acquire the whole event log. Today it does so **over the wire**: either a live
`SYNC_REQ`/RBSR re-serve (the serving peer relay-publishes the delta) or a paginated **store-pull** (up to
`STORE_PAGE=100 × STORE_MAX_PAGES=25 = 2,500` messages per topic). Both are the biggest single burst of
messages any user action produces, and both have problems:

- **Store-pull depends on fleet store retention** — store nodes prune old messages, so a long-lived
  container's early history may simply be gone.
- **Live re-serve is expensive for the server** and — critically — becomes a hard limiter once **RLN**
  (loam-transport ADR 0018) is enforced: serving a joining peer means the server relay-publishes hundreds
  of messages, which blows its 100-per-10-minute budget.

There is a proven pattern (used in the earlier web Qaku): the creator **serializes the log into one object
and uploads it to Storage**; a newcomer **pulls that object** instead of receiving hundreds of individual
messages. This maps cleanly onto our stack: the log is a CRDT (union-by-id + HLC merge, idempotent and
commutative), and we already have content-addressed **Storage** (Codex) with a proven mobile fetch path.

## Decision

**Bootstrap from a sealed log snapshot in Storage, with RBSR as the fallback and the correctness
guarantee.** A snapshot is an accelerator, never a source of truth.

1. **Snapshot the signed event log, not the fold.** Serialize the set of live signed events (optionally
   compacting obviously-dead ones — tombstoned/superseded that can never affect the fold). Keeping raw
   signed events preserves the CRDT invariant: the newcomer **re-verifies every signature and folds them
   exactly as if they'd arrived on the wire**, and late/out-of-order events still merge afterward.

2. **Seal it with the container key** before upload. Storage is content-addressed and may be public, so
   the blob is sealed like any channel payload (ChaCha20-Poly1305, per ADR 0011). Membership stays "who
   holds the key," unchanged.

3. **Advertise via a snapshot-pointer record** on the sync layer: `snapshot { cid, coversUpToHlc, count }`
   — one small message published when a snapshot is made, latest-wins by `coversUpToHlc`. This is a
   **sync-layer control record alongside RBSR, not an app fold event** (it never enters container state),
   so apps need no new event type.

4. **Newcomer path:** on join, read the latest snapshot pointer → fetch + decrypt from Storage → verify +
   fold → then **RBSR-tail from `coversUpToHlc`** for anything newer. If the CID is unfetchable (nobody
   pinned it, holder offline), **fall back to RBSR/store-pull** — slower but correct.

5. **The hub writes snapshots** (always-on, holds the full log + Storage write). Any editor/desktop *may*
   also write one; the pointer's `coversUpToHlc` resolves "which is freshest" by LWW. Start hub-only.
   Cadence (every N events / size threshold) is a pure tuning knob — a stale snapshot just means a bigger
   RBSR tail, still correct.

**Trust model.** The snapshot is a bag of signed events the newcomer fully re-verifies. A malicious or
stale snapshotter can therefore only **omit** events (denial) or include forged ones (dropped by the
signature check) — it cannot inject fake state. Omissions self-heal via RBSR. So correctness does not
depend on trusting the snapshotter: **any peer may publish a snapshot and newcomers may trust none of
them.** This is the same principle as the local-first write path (the optimization can be wrong and we
still converge).

## Consequences

- **Bootstrap moves off the metered relay path.** A fresh device joining a 1,000-event container goes from
  hundreds of relay publishes on the serving side (and hundreds received) to **~0 metered messages**: one
  Storage upload + one pointer event to serve; one fetch + a small RBSR tail to join. This is the highest-
  leverage mitigation for loam-transport ADR 0018 (RLN), and it independently gives faster cold starts,
  less battery, and resilience to store pruning.
- **Better than store-pull for bootstrap** on three counts: one fetch vs. thousands of paginated queries;
  no dependence on fleet store retention; content-addressed + verifiable. Store-pull stays useful for the
  recent tail when RBSR alone isn't enough.
- **Complements, does not replace, event batching.** Snapshots kill the *bootstrap* burst; the steady-state
  edit stream still needs batching/pacing to stay under budget.
- **Verify cost moves local.** The newcomer still re-verifies every signature (~40 ms/event on Hermes) —
  the same total work as wire ingest, now a one-time local CPU burst. The memoized + persisted verify
  cache covers this; a very large log may warrant sharding the snapshot.
- **Storage becomes a soft dependency for fast bootstrap** (not for correctness). We must host/pin
  snapshots (the hub's Storage node) and degrade gracefully to RBSR when a CID is unavailable.

**Open questions:** who may write snapshots beyond the hub, and the regeneration cadence; whether to
compact dead events in the snapshot or ship the full live set; sharding strategy for very large logs.
