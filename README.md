# logos-sync

A **shared, transport-agnostic sync engine** for multi-writer [Logos](https://logos.co)
apps. It is the *brain* that sits above [`logos-transport`](https://github.com/vpavlin/logos-transport):
the transport moves opaque sealed bytes over Waku; **logos-sync decides *which*
bytes** — how events converge, and exactly which events a peer is missing.

It is extracted from the sync core proven in shipping apps (KYM's convergence
suite, qaku's Q&A board) and generalised so **Perun, KYM, Qaku and Scala** can
share one implementation instead of four divergent copies.

> **One idea:** never store derived state, never mutate a record. Every change is
> an immutable **event**; state is a pure **fold** over the merged log. Get that
> right and offline-merge, idempotent redelivery, and convergence come for free.
> logos-sync owns the log, the merge, and the backfill; **your app owns the event
> schema, the fold, and the crypto.**

---

## The layering

```
  your app            logos-sync (this repo)              logos-transport
  ────────            ──────────────────────              ───────────────
  event schema  ────► Event {id, hlc, type, payload}
  fold → state  ◄──── mergeEvents (union-by-id + HLC)
  seal/open     ─────                                ────► publishSealed(topic, bytes)
                      reconcile / catch-up  ─────────┘      onReceive(topic, bytes)
                      "who is missing what"
```

logos-sync is **pure logic** — no node, no threads, no I/O. You feed it event sets;
it returns merged logs and "here's exactly what to send." The bytes travel over
`logos-transport`; the encryption is yours.

## Two implementations, one contract

| side | path | used by |
|---|---|---|
| **C++** (header-only) | [`basecamp/`](basecamp/README.md) | Basecamp cores — `scala_core`, `kym_core`, `qaku_core`, the Perun module |
| **TypeScript** | [`src/`](src/) | the mobile apps (React Native / Expo) |

The two are kept **byte-identical** by golden-vector parity tests (the RBSR
fingerprint must match across languages, or a phone and a desktop silently fail to
converge). See [`docs/PARITY.md`](docs/PARITY.md).

## What's in the box

| module | C++ / TS | what it does |
|---|---|---|
| **event** | `event.hpp` / `event.ts` | the `{v,id,hlc,dev,type,payload}` envelope + the HLC `Clock` |
| **merge** | `merge.hpp` / `merge.ts` | `mergeEvents` — union-by-id, HLC-ordered; the CRDT |
| **reconcile** | `reconcile.hpp` / `reconcile.ts` | Range-Based Set Reconciliation — the exact symmetric difference of two id-sets |
| **catchup** | `catchup.hpp` / `catchup.ts` | the backfill protocol — summarise, then serve only the delta |

## What you supply (the contract)

1. **Event `type` + `payload` schemas** — logos-sync never looks inside `payload`.
2. **The fold** `log → state` — your `computeState(mergedLog)`; pure, deterministic.
3. **A store adapter** — `allEvents()` / `append(e)` so the lib never owns storage.
4. **seal/open** — your AEAD (Scala uses AES-256-GCM, the others ChaCha20-Poly1305);
   logos-sync only ever handles plaintext events (see [`docs/adr/0006`](docs/adr/0006-crypto-and-transport-are-out-of-scope.md)).

## Why not just let SDS Reliable Channels do it?

Because they don't — not for history. SDS heals *live* drops (a missed message is
re-requested via its successor's causal history and retransmitted). It does **not**
reconstruct the log for a peer that starts cold or was offline past the buffer
window, and liblogosdelivery has no Store query on desktop. So a joining peer needs
an explicit backfill — and the naive "re-broadcast the whole log every 60 s" wastes
bandwidth that grows with the log forever. logos-sync serves **only the delta**.
The full reasoning is [`docs/adr/0003`](docs/adr/0003-set-reconciliation-over-resend-all.md)
and [`docs/adr/0004`](docs/adr/0004-catch-up-protocol.md).

## Docs

- [`docs/SYNC_SPEC.md`](docs/SYNC_SPEC.md) — the protocol, top to bottom.
- [`docs/adr/`](docs/adr/) — the Architecture Decision Records (why it's shaped this way).
- [`docs/PARITY.md`](docs/PARITY.md) — how the C++ and TS sides are kept identical.
- [`examples/scala.md`](examples/scala.md) — a real integration, end to end.

## Status

`v0.1` — event/merge/reconcile/catch-up, C++ + TS, golden-vector parity. First
consumer: **scala**. KYM/Qaku/Perun migrate onto it next, deleting their bespoke
copies. See [`CHANGELOG.md`](CHANGELOG.md).

## License

Dual MIT / Apache-2.0.
