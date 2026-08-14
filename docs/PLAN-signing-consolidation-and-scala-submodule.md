# Plan — consolidate signing into logos-sync, then submodule it into Scala

Status: **Phase A DONE** (logos-sync 0.3.0, 2026-08-14) — signing landed + parity-gated
in both langs. Phases B–E pending (all AFTER the demo). Author-driven; sequenced so
**nothing touches the demo-critical Scala artifacts** until after Logos Office Hours.

## Why

Scala and Qaku each carry a near-identical secp256k1 event-signing copy
(`*_identity.hpp` + `identity.ts`). ADR [0008](adr/0008-event-authenticity-signing.md)
decided this authenticity layer belongs in the spine, behind a `Signer` seam so the
private key can live in software today and a **Keycard** tomorrow — but the ADR is
*designed, not implemented*: the library's `event.hpp`/`event.ts` have no `pub`/`sig`,
and there is no `Signer` anywhere. Meanwhile Scala's **vendored** `src/logos_sync/event.hpp`
has drifted *ahead* of upstream (it added `pub`/`sig`). So a naive submodule swap today
would **regress Scala's signing**. The fix is to land ADR 0008 in the library first.

## Current state (verified 2026-08-14)

- **logos-sync** `@80d2e83`: C++ spine `basecamp/logos_sync/{event,merge,catchup,reconcile}.hpp`
  + TS mirror `src/{event,merge,catchup,reconcile}.ts`; golden vectors + convergence test.
  Signing: **ADR only**, no code. `event.hpp`/`event.ts` have no `pub`/`sig`.
- **Scala**: vendors logos-sync 0.2.0 headers into `src/logos_sync/` (drift: `event.hpp`
  has `pub`/`sig`; the other three are identical). Signing lives in `src/scala_identity.hpp`
  (C++) + `mobile/src/lib/identity.ts` (TS), domain tag hardcoded `scala-sig-v1`.
  `logos-transport` is already a real submodule; `logos-sync` is vendored.
- **Keycard**: no spike, no `Signer` interface — pure intent in ADRs.

## Phase A — land ADR 0008 in logos-sync  ✅ DONE (0.3.0) — demo-safe

1. **Envelope** — add optional `pub`/`sig` to `event.hpp` + `event.ts` (reconciles the
   Scala drift). Unsigned events stay first-class. ✅ matches Scala's fields exactly.
2. **Signing module** — new `basecamp/logos_sync/signing.hpp` + `src/signing.ts`, ported
   verbatim from Scala's proven code but **parameterised by a `domain` tag** (no hardcoded
   `scala-`). Exposes:
   - `canonicalMessage(domain, event)` — `<domain>-sig-v1|type|wall|ctr|dev|id|cjson(payload)`.
   - `address(pub33)` = `0x` + hex(sha256(pub))[24:64].
   - pure **`verifyEvent(domain, event)`** (public-key only) + `isSigned`.
   - the **`Signer` seam**: `interface Signer { publicKey()->Bytes33; signDigest(Bytes32)->Bytes64 }`,
     a `SoftwareSigner` (holds the 32B scalar; today), and `signEvent(signer, domain, event)`
     — the *only* path that touches a secret. `KeycardSigner` is a documented stub (Phase D).
3. **Parity** ✅ — `vectors.json.signing` (priv→pub/address, canonical, digest, sig) +
   cross-verify: `test/signing.test.mjs` (TS) and the signing block in `test/smoke.cpp`
   (C++/OpenSSL) each verify the other's frozen sig; 4 tamper cases rejected on both
   sides. Stayed on **@noble v1 ^1.9.7** (Hermes-safe, matches Scala) — sig is
   cross-verified, not byte-compared (OpenSSL random-k vs RFC-6979). `gen-signing-vectors.mjs`
   regenerates from the TS source of truth.
4. **Docs + release** ✅ — CHANGELOG 0.3.0, PARITY.md signing section, `package.json`
   0.3.0. `verifyEvent` stays a helper; the fold still owns policy (ADR 0007). (Git tag
   left for the author to cut.)

## Phase B — Scala consumes it as a submodule  (AFTER the demo)

1. Add `vpavlin/logos-sync` as a git submodule (e.g. `src/logos-sync-pkg`), pinned to the
   0.3.0 tag.
2. Repoint includes: `logos_sync/event.hpp` → the submodule's `basecamp/logos_sync/…`
   (add its `basecamp/` to `INCLUDE_DIRS` in CMake; keep the `logos_sync/…` include prefix
   so no source churn).
3. **Nix + submodules footgun**: `nix build .#` does NOT include submodule content unless the
   flake self-ref uses `?submodules=1` (or the `.lgx` deriv copies it in). Resolve this and
   prove the built `.lgx` is **byte-identical** to today's before publishing.
4. Delete `src/logos_sync/` (vendored) + `VENDORED.md`. Replace `scala_identity.hpp` with the
   library's `signing.hpp`, injecting a `SoftwareSigner` and passing `"scala"` as the domain.
5. Convergence/parity/golden all green; publish core (byte-identical fold ⇒ patch bump only).

## Phase C — mobile TS consolidation  (AFTER the demo)

Mobile currently *hand-ports* (`engine.ts`/`identity.ts` are scala-specific, not imports).
Decide: consume `logos-sync` TS from the submodule (`import { signEvent } from
'…/logos-sync-pkg/src/signing'`) vs keep the hand-port synced by the golden test. Prefer
importing to kill the second copy, minding Metro/Hermes resolution of the submodule path.

## Phase D — KeycardSigner  (future spike)

Implement `KeycardSigner` against the seam from Phase A: `publicKey()` + `signDigest()` over
NFC/PC-SC. A Keycard-signed event verifies identically (same 32-byte digest). No fold/wire
change — this is the payoff of doing the seam now. Needs a card + the Keycard SDK; scope as
a standalone spike.

## Phase E — logos-* → loam-* rename  (separate, staged)

Deliberate cut across repos + package/app ids + published catalog/F-Droid entries. High blast
radius (touches both demoed apps). Do as its own effort with a rollback plan — NOT bundled
with A–D.

## Guardrails

- A–E are independent; A ships value even if B slips.
- Never run this against the demo build. Phase A lives entirely in `vpavlin/logos-sync`.
- Every step gated by the golden-vector cross-verify — parity is the definition of done.
