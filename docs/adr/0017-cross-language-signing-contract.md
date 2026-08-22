# ADR 0017: Cross-language signing contract

- **Status:** Proposed
- **Date:** 2026-08-21

## Context

The event-authenticity layer (ADR [0008 — event authenticity](0008-event-authenticity-signing.md))
and its Keycard extension (ADR [0009 — delegation custody](0009-keycard-delegation-custody.md))
define a single canonical form that both the TypeScript reference and the C++ mirror must
produce **byte-identically** — the signature is computed over `sha256(utf8(canonicalMessage))`,
so any divergence in the pre-image makes a valid signature verify as invalid on the other
platform. The 2026-08 sync review (`docs/sync-review-2026-08.md`) found that the mirror has
drifted in two load-bearing ways, and that the C++ core silently corrupts delegated events.
These are the parity holes called out in the review's target architecture ("Identity/admission
parity: the canonicalMessage contract is byte-identical across TS and C++ and round-trips the
cert field losslessly") and enumerated as fixes **#14** and **#15**.

Concretely:

1. **`canonicalMessage` diverges on falsy payloads.** `src/signing.ts:56` canonicalizes
   `cjson(ev.payload || {})`, rewriting a `null` / `false` / `0` / `""` payload to `{}` before
   hashing. The C++ side (`basecamp/logos_sync/signing.hpp:105`) canonicalizes the real
   payload. An event whose payload is any falsy-but-legal value therefore produces two
   different digests, and cross-platform verify fails.

2. **`canonicalMessage` diverges on number encoding.** The TS number path renders with
   `String(v)` (`src/signing.ts:49`); C++ renders whole-number floats via nlohmann's
   `dump()` (`basecamp/logos_sync/signing.hpp:85`). Whole-number floats, large integers, and
   exponent forms serialize differently between `String()` and `nlohmann::json::dump`, so a
   payload carrying such a number is unverifiable across the boundary.

3. **C++ drops the delegation `cert`.** `basecamp/logos_sync/event.hpp` has no `cert` field,
   so a desktop/hub core that reserializes an event **strips `cert` on re-serialize**. Every
   downstream verifier then rejects the (now certless) delegated event. Worse, C++
   `verifyEvent` has no cert-chaining path at all, so it rejects any delegated event where the
   signing delegate key differs from the card identity (`pub != dev`). This breaks the moment
   any app enables Keycard custody in a topic that includes a C++ node.

These three defects share one root cause — two hand-maintained implementations of one contract,
with no enforced equivalence — and they block the convergence endpoint (fix **#13**) and the
signature-verification rollout (fix **#9**), both of which assume a single, byte-stable signing
contract across platforms.

## Decision

Pin one signing contract and enforce it with cross-repo golden vectors.

1. **`canonicalMessage` is byte-identical across TS and C++.**
   - Drop the TS `payload || {}` coercion (`src/signing.ts:56`): canonicalize the real
     payload on both sides. A `null` payload canonicalizes as `null`, not `{}`. (Apps that
     want an empty-object default must set `payload = {}` explicitly before signing; the
     signing layer does not silently rewrite it.)
   - Pin **one canonical-number serialization rule** that both `cjson` implementations produce
     identically for whole-number floats, large integers, and exponent forms. The rule is
     documented in `docs/SYNC_SPEC.md` and implemented byte-for-byte in `src/signing.ts` and
     `basecamp/logos_sync/signing.hpp`; neither side may fall back to its language default
     (`String()` / `nlohmann dump`) for numbers.

2. **The `cert` field round-trips losslessly through C++.**
   - Add `cert` to `Event` in `basecamp/logos_sync/event.hpp` and to `eventFromJson` /
     `eventToJson`, so a desktop/hub core reserializes a delegated event unchanged.
   - Port `canonicalCert` / `verifyCert` and cert-aware `verifyEvent` into
     `basecamp/logos_sync/signing.hpp`, chaining `delegate -> cert -> identity` exactly as
     `src/signing.ts` does (ADR 0018): with a cert, require `cert.delegatePub == ev.pub`, a
     valid non-expired `idSig` checked against the event's own `hlc.wall`, and
     `address(cert.idPub) == ev.hlc.dev`. `maxSigs` / `scope` remain fold-enforced, not
     verify-enforced (ADR 0018 invariant 2).

3. **Golden vectors are the enforcement mechanism, as a cross-repo CI gate.**
   - Freeze shared golden vectors covering the frozen edge cases: **null** payload, **empty**
     payload, **float** (whole-number) payload, **large-int** payload, and a **delegated**
     (cert-bearing) event. Each vector fixes the canonical pre-image and an expected
     signature/verify outcome.
   - Both platforms consume the same vectors — TS in the existing suite, C++ in `test/smoke.cpp`
     (the mechanism already used for ADR 0017/0009 parity) — and CI fails if either side
     produces a different canonical form or verify result. This is what makes "byte-identical"
     an enforced invariant rather than a hope, and is the concrete realization of the review's
     "golden vectors as a cross-repo CI gate."

## Consequences

- **Correctness / security:** cross-platform verify becomes reliable for all payload shapes
  and for delegated events, unblocking the STRICT signature flip (fix #9) and the logos-sync
  convergence (fix #13), both of which require a single stable contract.
- **Rollout is wire-impacting and must be coordinated.** Dropping the `payload || {}` coercion
  changes the canonical pre-image — and therefore the signature — for any existing event whose
  payload is falsy; making C++ round-trip `cert` changes what a C++ node re-emits. Land the
  contract change **before** enabling delegation or strict signing in any mixed-platform topic,
  and ensure every writer (mobile, desktop, hub) ships the new canonical form together.
  Sequence with fix #14 (cert layer) and fix #15 (canonical parity) so no C++ node joins a
  delegated topic until it round-trips `cert`.
- **Compatibility for the common case:** events with an object payload and no falsy/edge-case
  numbers already canonicalize identically today, so the overwhelming majority of live events
  are unaffected — the change bites only the edge cases the golden vectors now freeze. Until an
  app actually emits certs, the delegated-event path is dormant, so the C++ cert work can land
  ahead of the first hardware consumer without wire impact (per ADR 0018).
- **Risk:** the pinned number serializer is the sharp edge — if the TS and C++ implementations
  disagree on any exotic numeric form not covered by a vector, verify silently fails there.
  Mitigation is to keep the canonical-number rule narrow, explicit in `SYNC_SPEC.md`, and to
  extend the golden vectors whenever a new numeric shape enters a payload. A second risk is
  divergence recurring after the fix; the CI gate exists precisely to make any future drift a
  build failure rather than a field bug.
- **Convergence hygiene:** this ADR turns the two-implementation reality (ADR
  [0005 — two implementations, one reference](0005-two-implementations-one-reference.md)) into a
  contract that cannot silently drift, which is a precondition for retiring the bespoke
  kym/qaku mirrors onto logos-sync (fix #13).

## Related fixes

- **#14** — Port the delegation-cert layer to C++ `signing.hpp` and round-trip the `cert`
  field through Event JSON.
- **#15** — Fix `canonicalMessage` cross-language parity (drop TS `payload || {}`; pin one
  number-encoding rule) with golden vectors for null/empty/float/large-int.
- **#9** — Port signature verification into the qaku C++ fold; the STRICT flip depends on a
  stable cross-platform contract this ADR pins.
- **#13** — Converge kym + qaku onto logos-sync; a single, CI-enforced signing contract is a
  precondition for retiring the hand-maintained mirrors.
- Builds on ADR [0008 — event authenticity](0008-event-authenticity-signing.md) and ADR
  [0009 — Keycard delegation custody](0009-keycard-delegation-custody.md).
