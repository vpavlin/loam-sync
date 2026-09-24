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

1. **Snapshot the signed event log, not the fold.** Serialize the signed events **up to a cut** (see
   §Determinism), in the fold's canonical total order **(HLC, then id)**. Keeping raw signed events
   preserves the CRDT invariant: the newcomer **re-verifies every signature and folds them exactly as if
   they'd arrived on the wire**, and late/out-of-order events still merge afterward. (Compaction of
   obviously-dead events — tombstoned/superseded — is possible later but only if it stays a *pure function
   of the cut*, or it breaks the determinism below; deferred.)

2. **Seal it with the container key** before upload. Storage is content-addressed and may be public, so
   the blob is sealed like any channel payload (ChaCha20-Poly1305, per ADR 0011). Membership stays "who
   holds the key," unchanged.

3. **Advertise via a snapshot-pointer record** on the sync layer:
   `snapshot { cid, epoch, coversUpToHlc, count }` — one small message published when a snapshot is made,
   latest-wins by `epoch`/`coversUpToHlc`. This is a **sync-layer control record alongside RBSR, not an app
   fold event** (it never enters container state), so apps need no new event type. Because snapshots are
   deterministic (§Determinism), many peers publishing for the same `epoch` carry the **same `cid`** — the
   pointers reinforce rather than compete; a differing `cid` for an epoch means a divergent (incomplete)
   set, resolved by preferring the `cid` the most pointers agree on (or the highest `count`), with RBSR
   healing any gap regardless.

4. **Newcomer path:** on join, read the latest snapshot pointer → fetch + decrypt from Storage → verify +
   fold → then **RBSR-tail from `coversUpToHlc`** for anything newer. If the CID is unfetchable (nobody
   pinned it, holder offline), **fall back to RBSR/store-pull** — slower but correct.

5. **The hub writes snapshots** (always-on, holds the full log + Storage write). Any editor/desktop *may*
   also write one; because writers on the same epoch produce the same CID, extra writers cost nothing
   (content-addressed dedup) and add trust rather than contention. Start hub-only. Cadence follows the
   epoch grid (below); a stale snapshot just means a bigger RBSR tail, still correct.

### Determinism and snapshot epochs

The snapshot blob is a **pure function of the log-cut**, so independent snapshotters of the same cut
produce **byte-identical blobs → the same CID**. This gives Storage dedup (one copy, not N), pointer
convergence (all reference one CID), and a trust signal (N independent parties agreeing on a CID for a cut
is strong evidence it is the honest snapshot). It is an *optimization + trust bonus, not a correctness
requirement* — RBSR remains the guarantee, and a non-deterministic/divergent snapshot is still safe.

Four things must be deterministic:

- **Order** — events sorted by the fold's total order **(HLC, then id)**.
- **Serialization** — each event in the **canonical signing form** (fixed field order, no whitespace); the
  container is just the ordered events + a minimal fixed header (`version`, `coversUpToHlc`). **No
  snapshotter identity, no creation timestamp, no per-writer metadata** in the hashed bytes.
- **Sealing** — a **deterministic AEAD nonce** (ChaCha20-Poly1305 per ADR 0011), derived from a hash of
  the canonical plaintext, so identical plaintext → identical ciphertext → identical CID. A random nonce
  would defeat the whole scheme. (Safe from nonce-reuse: distinct snapshots hash to distinct nonces, so no
  nonce is ever paired with two different plaintexts under the container key.)
- **Membership = a CUT, not "what I currently hold."** Include exactly the events with
  `compareHlc(e.hlc, {wall:T, ctr:0, dev:""}) < 0`.

**Snapshot epochs.** The cut `T` follows a fixed wall-clock grid of size `E`: a snapshotter targets a
**completed (past) epoch** `T = floor(now/E)*E`, never the bleeding edge. Targeting a past epoch is what
makes convergence reliable — by then RBSR has almost certainly propagated every event with `HLC < T` to
every peer, so all snapshotters of epoch `T` hold the same set and emit the same CID. `E` is a tuning knob
(freshness vs. convergence reliability vs. churn); it is conceptually — not mechanically — analogous to the
RLN epoch. A snapshotter that is genuinely behind will emit a minority CID for the epoch; the pointer
resolution in step 3 and RBSR both absorb that.

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

**Open questions:** who may write snapshots beyond the hub; the epoch size `E` (freshness vs. convergence
reliability); whether to compact dead events (only if kept a pure function of the cut, else it breaks
determinism); the exact canonical container encoding + nonce-derivation function; sharding strategy for
very large logs (and whether shards stay individually deterministic).
