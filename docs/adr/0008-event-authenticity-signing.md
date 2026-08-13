# 8. Event authenticity — optional signing (Keycard-ready), a Signer the library injects

- **Status:** accepted
- **Date:** 2026-08-13

## Context

Roles/admission are folded from the event log, but they trust each event's **author
claim** (`hlc.dev`). Without a signature that claim is forgeable by anyone holding the
shared key, so roles are *attribution, not authorization* (Scala ADR 0004 says as much).
Two consumers (Scala, Qaku) independently added the **same** secp256k1 event-signing layer
— near-identical `*_identity.hpp` + `identity.ts` copies. That duplication, and the goal
of a **single hardware-key integration point (Keycard)**, means authenticity belongs in
the spine — *if* it can be added without contradicting ADR
[0006](0006-crypto-and-transport-are-out-of-scope.md) ("the library never sees a key").

The distinction that makes it fit: ADR 0006 is about **confidentiality** — the app-owned
seal/open (Scala AES-GCM, others ChaCha20-Poly1305), which hides bytes and needs a secret
the app must own. **Authenticity** is different: it proves *who authored* an event, its
verification needs only **public** keys, and its signing can be **delegated** so the
library never touches the private key. So it is a spine capability that keeps 0006 intact.

## Decision

logos-sync gains an **optional authenticity layer** — off unless the app opts in.

- **The envelope carries optional `pub` / `sig`** (public key + signature), outside the
  signed canonical. Unsigned events remain first-class (legacy/opt-out).
- **Canonical, parameterised by an app domain tag** (ADR 0005 "one reference, mirrored"):
  ```
  canonical = "<domain>-sig-v1|"+type+"|"+wall+"|"+ctr+"|"+dev+"|"+id+"|"+cjson(payload)
  cjson     = compact JSON, object keys sorted, no spaces
  address   = "0x" + hex(sha256(pub_compressed_33B))[24:64]     (SHA-256, not keccak)
  sig       = secp256k1 ECDSA over sha256(utf8(canonical)), compact r‖s (64B), LOW-S
  verify    = address(pub)===dev  AND  secp256k1.verify(sig, digest, pub)      // PUBLIC-key only
  ```
  The domain tag (`scala-sig-v1`, `qaku-sig-v1`, …) is the only per-app parameter.
- **The library never holds a private key — it injects a `Signer`.** This is how 0006's
  key-ownership rule survives:
  ```
  interface Signer { publicKey(): Bytes33; signDigest(d: Bytes32): Bytes64 }   // low-S compact
    ├─ SoftwareSigner  — key in the app's keystore (SecureStore / kv)         (today)
    └─ KeycardSigner   — key on a Keycard secure element; sign over NFC / PC-SC (drop-in)
  ```
  `verifyEvent` is pure and public-key-only; `signEvent` is the *only* path that touches a
  secret, and it reaches it solely through the injected `Signer`. So the spine sees a
  `Signer`, never a key — and a Keycard-signed event verifies on every peer exactly like a
  software-signed one, because the digest is the same 32 bytes.
- **Verify-on-merge is a helper; the fold decides policy.** The library exposes
  `verifyEvent`; the app's fold (which it already owns, ADR 0007) chooses how to use the
  `verified` bit — e.g. drop a tampered event, and require an authenticated author for
  privileged/role operations while leaving open content admissible.
- **Keypair generation uses the platform RNG** (never a JS-runtime RNG that may be
  unseeded); the reference + mirror are pinned by a golden-vector cross-verify.

## Consequences

- One shared implementation → **Keycard integrated once** benefits every consumer; roles
  become real write-authorization behind a key that can live in hardware.
- ADR 0006 stands: confidentiality (seal/open) is still app-side, and the eventual **MLS**
  membership/forward-secrecy upgrade remains a *read/seal* concern, orthogonal to this
  *write-authenticity* layer.
- Purity preserved: `verifyEvent` and the convergence/parity suites need no keys and no
  network; only a live `Signer` needs a secret (or a card).

## Parity gotcha (pinned by the golden-vector test)

`@noble/curves` **v2** `sign`/`verify` hash the input again by default; OpenSSL signs the
digest as-is. Pass **`{ prehash: false }`** on both sides or, with identical digest and
pubkey, the two libraries still reject each other's signatures.

## Alternatives rejected

- **Bundle a keystore / hold the private key in the library** — violates ADR 0006's
  key-ownership rule and blocks hardware signers. The `Signer` seam avoids it entirely.
- **Leave signing app-side (status quo: duplicate copies)** — works, but forks the
  Keycard integration N ways and lets the canonical form drift between apps.
- **Sign the sealed bytes instead of the plaintext event** — couples authenticity to each
  app's cipher and hides the author from the fold; sign the canonical plaintext envelope.
