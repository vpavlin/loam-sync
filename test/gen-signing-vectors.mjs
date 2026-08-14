// gen-signing-vectors.mjs — regenerate the frozen `signing` parity anchors in
// test/golden/vectors.json from the TS reference (src/signing.ts is the source of
// truth; @noble is deterministic RFC-6979 so these values are stable). The C++ core
// (OpenSSL, random-k) can't reproduce `sig` byte-for-byte, so the parity gate is
// cross-VERIFY (each impl verifies the other's frozen sig), not byte-equality.
//
//   node test/gen-signing-vectors.mjs        # prints the signing block as JSON
//
// A fixed 32-byte scalar + a fixed event → pub / address / canonical / digest / sig.
import {
  SoftwareSigner, signEvent, verifyEvent, canonicalMessage, address, hex, utf8Bytes,
} from "../src/signing.ts";
import { sha256 } from "@noble/hashes/sha256";

const DOMAIN = "logos"; // neutral domain tag; apps pass their own ("scala", "qaku", …)
const PRIV = "0000000000000000000000000000000000000000000000000000000000000001"; // fixed scalar = 1

// Input event BEFORE signing. signEvent() overwrites dev + hlc.dev with the signer's
// address, so the placeholder here is intentionally wrong to prove the stamp happens.
function freshEvent() {
  return {
    type: "note.add",
    id: "evt-1",
    hlc: { wall: 1700000000000, ctr: 7, dev: "PLACEHOLDER" },
    payload: { text: "hello", tags: ["a", "b"], n: 42, ok: true },
  };
}

const signer = new SoftwareSigner(Uint8Array.from(Buffer.from(PRIV, "hex")));
const pub = signer.publicKey();
const addr = address(pub);

const ev = freshEvent();
signEvent(signer, DOMAIN, ev);
const canonical = canonicalMessage(DOMAIN, ev);
const digest = hex(sha256(utf8Bytes(canonical)));

if (!verifyEvent(DOMAIN, ev)) { console.error("FATAL: freshly signed event fails self-verify"); process.exit(1); }

const block = {
  note: "secp256k1 event-signing anchors (adr/0008). sig is @noble-deterministic; C++ (OpenSSL random-k) VERIFIES it, does not reproduce it.",
  domain: DOMAIN,
  priv: PRIV,
  pub: hex(pub),
  address: addr,
  event: freshEvent(),      // pre-sign input (dev = PLACEHOLDER)
  canonical,                // post-stamp canonical string
  digest,                   // sha256(utf8(canonical))
  sig: ev.sig,              // deterministic low-S compact r||s (128 hex)
  signed: ev,               // full signed event (pub/sig/dev/hlc.dev all populated)
};

console.log(JSON.stringify(block, null, 2));
