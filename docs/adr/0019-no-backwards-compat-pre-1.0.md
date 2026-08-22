# ADR 0019: No backwards compatibility before 1.0

- **Status:** Accepted (2026-08-21, vpavlin directive)

## Context
Converging four apps onto loam-sync (ADR 0010) tempted a lot of compatibility
machinery: wire version negotiation, dual-read windows (old + new cipher/envelope),
legacy fallbacks (whole-log `serveLog` for pre-RBSR peers, random-nonce reads). That
machinery is complexity we'd carry forever to protect data/protocols that are still
pre-release.

## Decision
**Until 1.0, breaking changes are acceptable. Optimise for design, features, and
security over backwards compatibility.** Concretely:
- **One cipher:** ChaCha20-Poly1305, AAD=topic, deterministic id-derived nonce (ADR 0011).
  Scala moves off AES-256-GCM; the AES path is deleted — no dual-read bridge.
- **One wire:** sealed-Event + recursive RBSR catchup. Retire the `{type:EVENT}` envelope
  and the whole-log `SYNC_REQ` re-serve outright — no version negotiation, no legacy serve.
- **One sync brain:** kym/qaku drop `packages/sync` + `packages/contract` + the C++ mirror
  and consume loam-sync directly. No shim layer.
- Coordinated cutover: all peers (apps + crib-hub) rebuild onto the new wire together.

## Consequences
- Much simpler library + apps: no suite tags, no version fields, no fallback branches.
- A device on an old build won't interop with a new one — acceptable pre-1.0; the cutover
  is coordinated (rebuild everything, incl. the hub).
- Old fleet-store data under the old cipher/envelope becomes unreadable and is dropped;
  devices re-publish their local (plaintext) logs under the new wire. Acceptable for
  test-stage data; the crib-hub holds the canonical logs and re-seeds.
- **Still required (this is NOT "ship broken"):** verify **new↔new convergence** before
  release — loam-sync tests + kym/qaku JS tests + a crib-hub run + a two-device check.
- At 1.0 we freeze the wire and this ADR is superseded by a compatibility policy.
