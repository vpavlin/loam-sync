# logos-sync protocol specification

This is the behaviour both the C++ (`basecamp/`) and TypeScript (`src/`)
implementations must reproduce. It is the reference; neither language is (0005).

## 1. Event envelope

```
Event = {
  v:       1,                       // envelope version
  id:      string (UUIDv4),         // idempotency / dedup key
  type:    string,                  // app-defined
  hlc:     { wall:int, ctr:int, dev:string },
  dev:     string,                  // author device id (== hlc.dev)
  payload: any                      // app-defined, opaque to logos-sync
}
```

The JSON serialization (`eventToJson` / `event.ts`) is the wire shape. Fields are
emitted in the order shown; missing fields decode to defaults (`v=1`, empty strings,
`payload={}`).

## 2. Ordering — HLC

Total order `compareHlc(a,b)`:

```
a.wall - b.wall,  then  a.ctr - b.ctr,  then  lexicographic(a.dev, b.dev)
```

`wall` is milliseconds, ordering-only. The `Clock`:

- `send(nowMs)`: `wall = max(wall, nowMs)`; `ctr = (nowMs > oldWall) ? 0 : ctr+1`.
- `receive(h)`: if `h.wall > wall` adopt `(h.wall, h.ctr)`; if equal, `ctr = max(ctr, h.ctr)`.

## 3. Merge — the CRDT

`mergeEvents(...logs)`:

1. Union all events into a map keyed by `id` (first occurrence wins — ids are unique,
   so this only affects exact-duplicate redelivery).
2. Return the values sorted by `compareHlc`.

Idempotent, commutative, associative. `mergeOne(log, e)` is the in-place form, returning
`false` if `e.id` is already present (a duplicate).

## 4. Reconciliation — RBSR

`reconcile(A, B)` over the id-sets, ordered by the key `(wall, id)`:

- **Fingerprint** of an item range: `acc = XOR over items of SHA-256(utf8(id))` (32
  bytes); `fp = SHA-256(acc ‖ uint32_be(count))[0..16]`, lowercase hex. Order-independent.
- Start with the full range `(-∞, +∞)`. For each range: if `fingerprint(A∩range) ==
  fingerprint(B∩range)`, the range agrees — done. Else let `larger` be the bigger side;
  if `|larger| ≤ threshold(8)` exchange id lists (each side records what the other
  lacks); otherwise split into `buckets(16)` sub-ranges keyed by `larger`'s items and
  recurse.
- Result: `aNeeds` (ids A lacks), `bNeeds` (ids B lacks) — the exact symmetric difference.

The byte layout of the fingerprint is frozen (0005); golden vectors pin it.

## 5. Catch-up protocol (v2 — recursive RBSR)

Control envelope `SYNC_REQ` carries a reconciliation message — never folded, never
stored. Every message is single-segment (a bounded set of fingerprints or ids), which
is mandatory: the delivery module can't encrypt multi-segment channel sends (ADR 0004).

Ordering for ranges is by **id alone** (unique ⇒ a valid total order); bounds are one id.

Message types:
```
"fp"   { from, lo?, hi?, bounds:[id…], fps:[hex…] }   (lo,hi] split into fps.length
                                                      sub-ranges, fingerprint each
"ids"  { from, lo?, hi?, ids:[id…] }                  exact ids in a small range
"need" { from, ids:[id…] }                            serve exactly these events
```

- `buildInitial(myLog, from, buckets=8)` → an `fp` message over the whole range.
- `respond(myLog, msg, me, threshold=8, buckets=8)` → `{ replies, serve }`:
  - `fp`: for each sub-range, if my fingerprint matches → drop; else if `|mine| ≤
    threshold` → reply `ids` (mine); else → reply `fp` over sub-buckets.
  - `ids`: `serve` = my events in range the peer lacks; reply `need` for ids I lack.
  - `need`: `serve` = exactly those events I hold.
  - ignore `msg.from == me`.
- Fingerprint = order-independent XOR of `SHA-256(id)` folded with count (§4), so peers
  holding the same ids in a range always agree.

**Convergence:** the symmetric difference strictly shrinks each round → terminates. A
fresh peer recurses down to receive everything; a slightly-behind peer recurses only
into the changed range. Empirically single-segment throughout (≤ ~400 B for a 200-event
log).

**Trigger (app-owned):** publish `buildInitial` at **0, 3, 10, 25 s** after the node is
ready (the mesh needs ~10 s to form; a single early message is lost). Idempotent.

**Broadcast-tolerant:** `from` gives self-ignore; serves are idempotent (dedup by id).

## 6. What the app supplies

Event `type`/`payload` schemas · the fold `computeState(mergedLog)` · a store adapter
(`allEvents`, `append`) · `seal`/`open` crypto · the catch-up trigger + transport.
See ADR 0006, 0007.
