# ADR 0010: Converge all four apps on logos-sync as the single sync brain

- **Status:** Proposed
- **Date:** 2026-08-21

## Context

Four apps sync over the Logos/Waku delivery layer: scala and kith already consume
`logos-sync`; kym and qaku ship their own copies. The 2026-08 sync deep-dive
(`docs/sync-review-2026-08.md`) found that of its six root causes, the most
structural is that **four parallel sync stacks exist and have already drifted in
load-bearing ways**:

- kym and qaku carry a bespoke `packages/sync` plus a `mobile/src/lib/session(s)`
  path *and* a hand-maintained C++ mirror (`kym_engine.hpp`, `qaku`'s fold), rather
  than the one `logos-sync` implementation scala/kith use.
- The drift is not cosmetic. Mobile omits `clock.receive` and does no RBSR-on-wire;
  the qaku C++ fold does **no signature verification** and is spoofable; the
  logos-sync C++ side drops delegation `cert` on re-serialize; and `canonicalMessage`
  has cross-language parity holes (TS `payload || {}` coercion, JS `String()` vs
  nlohmann number rendering). Each of these is a silent convergence break — a phone
  and a desktop fold the same log to different state and it looks like "the network
  is down."
- Two mutually incompatible wire families are in production: kym/qaku's
  `{type:EVENT}` envelope + whole-log-reserve `SYNC_REQ`, versus kith/scala's raw
  sealed-Event + recursive RBSR catchup.

Keeping the stacks in parallel guarantees the next parity bug. The review's target
architecture is explicit: **one shared sync brain, one wire family, a durable
responder tier.** This ADR records the endpoint — the wire-level convergence — which
the review sequences **last**, behind the non-wire safe fixes that de-risk cold-start
and bandwidth first.

## Decision

**kym and qaku retire their bespoke sync and their hand-ported C++ mirror, and
consume `logos-sync` exactly as scala and kith already do.**

`logos-sync` is the single source of truth for the sync mechanism:

- the **event-log CRDT fold contract**,
- the **HLC `Clock`** (with `primeFrom` on boot/join and `receive` on every ingest),
- the **XOR range fingerprint**, and
- the **recursive RBSR catchup** (`buildInitial` / `respond` / `serve`).

Concretely, kym and qaku delete `packages/sync`, the mobile bespoke
delivery/session paths, and the hand-maintained C++ mirror, and route all sync
through `logos-sync`.

The **wire** standardizes on the kith/scala family: a raw **sealed-Event envelope +
recursive catchup** for backfill. The kym/qaku `{type:EVENT}` envelope and the
whole-log-reserve `SYNC_REQ` are retired.

The **app-specific FOLD stays per-app** — each app owns its state schema and merge
semantics — but it is **single-sourced** so mobile (JS) and desktop (C++) can never
diverge again. Either one implementation is compiled to both JS and C++/wasm, or a
generated set of golden vectors is enforced as a **cross-repo CI gate** (open
question in the review; both eliminate hand-maintained drift, which is the failure
mode we are removing). This is not a contradiction of "app owns the fold" — the fold
stays app-owned; only its *duplication across languages* is eliminated.

This is the **strategic endpoint**. It lands **last**, after the safe non-wire fixes
below, and rolls out **per app across mobile + desktop + hub together**, behind a
**dual-read / version-negotiation window**: nodes accept both the legacy
`{type:EVENT}` envelope and the raw sealed Event during transition, so a topic never
splits into non-converging halves. Store-pull bootstrap is **preserved, not
replaced**, when kym/qaku move onto catchup.

## Consequences

**Positive**

- One HLC, one fingerprint, one fold contract, one catchup shared by all four apps —
  the recurring parity bugs (missing `clock.receive`, unverified fold, dropped
  `cert`, canonicalization skew) become structurally impossible instead of
  repeatedly hand-fixed.
- Future fixes (e.g. true O(diff) fingerprint exchange, fix #16) are implemented once
  in `logos-sync` and inherited, not re-ported into a soon-retired mirror.
- A fifth consumer later is one integration, not a fifth stack.

**Rollout / compatibility**

- Coordinated wire change for kym/qaku: **both** the envelope and the `SYNC_REQ`
  semantics change. Roll out per app across mobile + desktop + hub, sequenced so no
  writer in a topic is left on the old-only path once peers start emitting raw
  Events.
- Dual-read window is mandatory during transition because the two wire families are
  mutually incompatible today; retire legacy read only after all writers on a topic
  ship the new path.
- Land only after the review's safe fixes have shipped, so convergence rides on an
  already-de-risked cold-start/bandwidth base rather than compounding two migrations.
- Signature-verifying fold and STRICT flip are gated separately: STRICT flips only
  after every writer (mobile + desktop + hub) ships the verifying fold — see fix #9.

**Risks**

- A mis-sequenced rollout (one platform ahead of another on a shared topic) can split
  a topic into non-converging halves; the dual-read window and per-app coordination
  are the mitigation, worst case reverting to today's redundant-but-correct behavior.
- Fold single-sourcing carries a build cost (compile-once) or a CI-discipline cost
  (golden vectors); the review leaves the choice open but requires that hand-parity be
  eliminated either way.
- Delegation (Keycard) must not enter a mixed-platform topic until C++ round-trips
  `cert` (fix #14); convergence otherwise strips certs on desktop re-serialize.

## Related fixes

From `docs/sync-review-2026-08.md`:

- **#13** — the direct implementation of this ADR: converge kym + qaku onto
  logos-sync catchup v2 (recursive RBSR) + raw sealed-Event wire; retire the
  `{type:EVENT}` envelope and whole-log reserve; make the fold single-source.
- **#12** — mobile kym SUMMARY/RBSR producer/consumer, an explicit **stepping-stone
  superseded by #13**, not a long-lived parallel protocol.
- **Prerequisite safe fixes that land first:** **#1** (seed HLC + `clock.receive` on
  ingest), **#2** (deterministic id-derived AEAD nonce), **#3** (EVENT-only
  store-pull guard), **#11** (ephemeral control plane).
- **Parity gates the convergence must satisfy:** **#9** (signature verification in
  the qaku C++ fold + STRICT rollout), **#14** (delegation-cert round-trip in C++),
  **#15** (`canonicalMessage` cross-language parity).
- **Related but independently sequenced:** **#16** (O(diff) fingerprint exchange —
  land after convergence so it is implemented once), **#18** (retire/align the dead
  `reconcile.hpp` ordering trap).

## Directive (2026-08-21, vpavlin)

This ADR is the **primary goal** of the sync-hardening work, not a deferred endpoint: **port kym + qaku onto logos-sync and add anything missing *to logos-sync*, rather than maintaining multiple implementations.** New sync capability lands in logos-sync (TS + C++ parity) and apps consume it; per-app forks (kym/qaku `packages/sync` + the hand-ported C++ mirror) are retired. Per ADR 0019 (no pre-1.0 backwards compat) wire-affecting steps are a coordinated breaking cutover — NO version negotiation — but still need a new↔new device convergence check before release.
