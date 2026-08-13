# 4. The catch-up protocol: summarise, then serve the delta

- **Status:** accepted
- **Date:** 2026-08-13

## Context

0003 decided *what* to transfer (only the difference). This ADR fixes *how* the peers
talk — the wire protocol that rides the app's normal sealed send/receive, plus the
two operational rules that make it actually deliver history in a gossip mesh.

## Decision

**v1, single round, "summarise then serve the complement":**

1. On join/reconnect, a peer publishes a **`SYNC_REQ`** carrying `buildRequest(myLog)`
   = `{ have: [id, …] }` — the ids it already holds for the channel.
2. Every peer that receives it runs `answerRequest(myLog, req)`:
   - `serve` = the events the requester lacks → **publish just those**;
   - `iLack` = ids the requester listed that *we* don't have → **we publish our own
     `SYNC_REQ`**.
   Rule (2) is what makes one request converge **both** peers: the joiner pulls
   history, and anything the joiner authored offline pulls back to everyone else.
3. A fresh peer sends `have: []` and receives the whole log once; a peer slightly
   behind receives only its gap.

`SYNC_REQ` is a control message — it is **never folded into state** and never stored
(the app's fold ignores its type).

### Two operational rules (or it silently delivers nothing)

- **Trigger on a timer, not once.** The node finishes `start()` *before* the gossip
  mesh has peers (~10 s to form) and before the async subscribe/channel-join have
  landed. A single `SYNC_REQ` fired at "ready" goes into the void. Re-send at
  **0 / 3 / 10 / 25 s** after ready (mobile already does this; it is exactly the bug
  that left Scala's desktop never catching up). Idempotent, so retries are safe.
- **Rate-limit the response.** Overlapping `SYNC_REQ`s (several peers joining, or a
  retrying joiner) must not restack full serves into a flood; cap `answerRequest`
  responses per channel (e.g. one per 3 s). Dedup-by-id on the receiver makes any
  extra serve harmless anyway.

## Alternatives rejected

- **Push-only periodic re-broadcast** (0003) — unbounded waste, no per-peer targeting.
- **One-shot request at `onReady`** — the precise defect being fixed; races the mesh.
- **A dedicated request/response RPC channel** — unnecessary; the existing sealed
  channel carries `EVENT` and `SYNC_REQ` envelopes fine, and reusing it keeps the
  transport contract tiny.

## Consequences

- Backfill is **on-demand and bidirectional**; no steady-state traffic.
- The app owns the **trigger** (node lifecycle) and the **transport** (seal + publish);
  logos-sync owns the **decision** (`buildRequest` / `answerRequest`). Clean seam.
- v2 swaps the `have: [id]` list for RBSR fingerprints (0003) behind the same two
  functions — apps don't change.
