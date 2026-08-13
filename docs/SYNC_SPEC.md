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

## 5. Catch-up protocol (v1)

Control envelope `SYNC_REQ` — never folded, never stored.

- **Request:** `buildRequest(myLog) = { have: [id, …] }`.
- **Answer:** `answerRequest(myLog, req)`:
  - `serve = myLog filter (id ∉ req.have)` — publish these to the requester.
  - `iLack = req.have filter (id ∉ myLog ids)` — publish our own `SYNC_REQ` if non-empty.
- A fresh requester sends `have: []` and receives the whole log.

**Trigger (app-owned):** publish the request at **0, 3, 10, 25 s** after the node is
ready (the mesh needs ~10 s to form; a single early request is lost). Idempotent.

**Response rate-limit (app-owned):** at most one `answerRequest` serve per channel per
~3 s, so overlapping requests can't flood. Receiver dedups by id regardless.

## 6. What the app supplies

Event `type`/`payload` schemas · the fold `computeState(mergedLog)` · a store adapter
(`allEvents`, `append`) · `seal`/`open` crypto · the catch-up trigger + transport.
See ADR 0006, 0007.
