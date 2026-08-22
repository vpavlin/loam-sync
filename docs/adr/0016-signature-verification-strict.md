# ADR 0016: Signature verification and STRICT-mode rollout

- **Status:** Proposed
- **Date:** 2026-08-21

## Context

ADR [0008](0008-event-authenticity-signing.md) defines the authenticity layer —
a secp256k1 signature over the canonical event, verified with **public keys
only** as `address(pub) === dev AND secp256k1.verify(sig, digest, pub)` — and ADR
[0009](0009-keycard-delegation-custody.md) extends the verify to chain a
`DelegationCert` for Keycard custody. Those ADRs give the fold a `verified` bit;
they deliberately leave **policy** to the per-app fold (ADR 0016
"app owns the fold"): which events must be authenticated, and what happens to one
that is not.

The 2026-08 sync review found that policy is applied inconsistently, and on one
platform not at all. The core defect is in the **qaku C++ fold**: `admitEvents`
folds gated/privileged events (`admin.add`, `answer`, `moderate`) **without ever
verifying the signature** — it trusts the author claim `hlc.dev` directly. There
is no `qaku_identity.hpp` in the fold path and no `sigOk` check, so the desktop
and hub cores admit a **forged** admin or answer event from any peer holding the
shared key. The mobile qaku fold *does* drop invalid-signed gated events, so the
same merged log **diverges by platform** — desktop admits what mobile rejects.
This is both a spoofing hole and a convergence hole from a single cause.

Two contract-parity gaps make a naive flip unsafe even where verification
*is* wired:

- **canonicalMessage is not byte-identical across TS and C++** (review fix #15):
  TS coerces a falsy payload with `payload || {}` before canonicalizing while
  C++ canonicalizes the real payload, and the two sides render numbers
  differently (JS `String()` vs `nlohmann` dump for whole-number floats, large
  ints, exponents). A digest mismatch makes a genuine signature *fail to verify*
  cross-platform — so turning on strict dropping would drop **valid** events.
- **The `cert` field does not round-trip in C++** (review fix #14): `event.hpp`
  has no `cert` field, so a desktop/hub core silently strips it on re-serialize
  and `verifyEvent` rejects every Keycard-delegated event. Enabling strict
  verification in a delegated topic before this is fixed would reject all
  hardware-signed writes.

The problem is therefore not "add a flag" — it is **bring every writer's fold to
identical verification behaviour first**, then flip enforcement as a coordinated,
per-app step.

## Decision

**The fold verifies every gated/privileged event, identically on mobile and
desktop, before any STRICT flag is flipped.** Verification is exactly the ADR
0008 contract — `ecdsaVerify(sig, digest, pub)` **AND** `address(pub) ==
signer` (the `hlc.dev` author claim) — extended per ADR 0018 to chain a
delegation cert (`cert.delegatePub == ev.pub`, valid non-expired `idSig`,
`address(cert.idPub) == dev`) when one is present. Participant/open-content
events remain unauthenticated and first-class; only **gated** operations
(role/admin/moderation and their app equivalents) are subject to the check.

**qaku's C++ fold is brought to parity.** `admitEvents` gates every privileged
event on the check above by including `qaku_identity.hpp` and mirroring the
mobile `sigOk` logic, binding `hlc.dev` to the recovered secp256k1 signer rather
than trusting it. A **golden-vector parity test** feeding one forged gated event
to both the TS and C++ engines gates CI, so the two folds can never again reach
different verdicts on the same log (review fix #9).

**The canonical contract is made byte-identical first.** The TS `payload || {}`
coercion is dropped, one canonical-number serializer is pinned on both sides, and
the C++ `Event` struct round-trips the `cert` field losslessly through
`eventFromJson`/`eventToJson`. These are prerequisites, frozen by shared golden
vectors (review fixes #14, #15) — verification parity is meaningless while the
digest itself diverges.

**STRICT (dropping unsigned gated events) is a coordinated, per-app flip.** The
verifying-but-non-strict fold is deployed to **every** writer first — mobile,
desktop, and the always-on hub. STRICT is flipped only after a concrete gate
confirms that every long-lived writer on the topic (the hub included) ships the
verifying fold; flipping earlier would drop legitimate events authored by an
un-upgraded peer and split the topic into non-converging halves.

**Legacy unsigned gated events: grandfather vs drop is decided per app at flip
time.** Some apps have pre-signing gated events already in their logs. Whether
those are grandfathered (admitted despite no signature, e.g. by an
`hlc.wall < cutoff` clause in the fold) or dropped on flip is a per-app product
decision made when that app flips STRICT — not a library-wide default. The
library provides the `verified` bit and the cutoff hook; the app's fold sets the
policy.

## Consequences

**Security.** Once verification is wired, a forged `admin.add` / `answer` /
`moderate` is rejected by the fold on every platform — roles become real write
authorization behind a key (software or Keycard), not mere attribution.

**Convergence.** With identical verification and an identical canonical digest,
mobile, desktop, and hub reach the same verdict on the same merged log; the
existing qaku platform divergence closes. The golden-vector parity test keeps it
closed.

**Rollout / compatibility.**

- **Verification is deployed before STRICT.** The verifying-but-non-strict fold
  changes no wire format and no admission outcome for correctly-signed events, so
  it can roll out per platform at leisure. It is the safe first step.
- **STRICT is flipped per app, only after full writer coverage.** The gate is
  explicit: every writer that authors gated events on the topic — including any
  long-lived hub — must be on the verifying fold. A single un-upgraded writer
  authoring unsigned gated events after the flip has its events dropped by
  upgraded peers, which is a divergence, so the flip waits.
- **Delegated topics wait on cert round-trip.** No C++ node joins a
  Keycard-delegated topic in STRICT until fix #14 ships (cert field +
  cert-aware verify), or it rejects every delegated event. Until then delegation
  stays TS-only, as ADR 0018 notes.

**Risks.**

- *Digest drift drops valid events.* If STRICT is flipped before canonicalMessage
  parity (#15) lands, a cross-platform signature that should verify fails and a
  genuine event is dropped. The parity fix and its golden vectors are a hard
  prerequisite, not a follow-up.
- *Silent grandfather scope.* A grandfather clause that is too broad (e.g. a
  cutoff that also admits post-cutoff unsigned events) re-opens the spoofing hole
  it was meant to bound. The cutoff must key on the event's own `hlc.wall`
  (deterministic, per ADR 0018's expiry rule) so every device folds the same
  verdict.
- *Mixed strict/non-strict window.* During the interval when some writers verify
  and others do not, the log still converges (non-strict peers admit everything
  strict peers admit plus unsigned events); the divergence appears only once
  STRICT drops what a lagging writer still produces. Sequencing the flip after
  full coverage is what avoids it.

## Related fixes

From the 2026-08 sync review (`docs/sync-review-2026-08.md`):

- **#9** *(M/medium)* — Port signature verification into the qaku C++ fold:
  `admitEvents` gates on `ecdsaVerify` AND `address(pub) == hlc.dev`, include
  `qaku_identity.hpp`, mirror `sigOk`, add the forged-gated-event golden-vector
  parity test. The core of this decision.
- **#14** *(M/medium/WIRE)* — Port the delegation-cert layer to C++
  `signing.hpp` and round-trip the `cert` field through Event JSON. Prerequisite
  for STRICT in any Keycard-delegated topic.
- **#15** *(M/medium/WIRE)* — Fix canonicalMessage cross-language parity (drop
  the TS `payload || {}` coercion, pin one number-encoding rule, golden vectors
  for null/empty/float/large-int). Prerequisite: verification parity requires an
  identical digest.

See also ADR 0017 (event authenticity — the verify contract this ADR enforces)
and ADR 0018 (Keycard delegation custody — the cert chaining STRICT must honour).
The review's open question on STRICT + legacy data ("grandfather vs drop, and the
concrete gate confirming every writer ships the verifying fold") is answered here:
per-app policy at flip time, behind a full-writer-coverage gate.
