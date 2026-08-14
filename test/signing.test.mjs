// signing.test.mjs — TS side of the ADR-0008 parity gate. Reconstructs every derived
// value from the frozen private key + input event in test/golden/vectors.json and asserts
// byte-equality (the TS impl is deterministic, so pub/address/canonical/digest/sig must ALL
// match the anchor). Then self-verify + tamper-detection. The C++ side (test/smoke.cpp)
// reads the SAME anchor and cross-verifies the frozen sig. Run: node test/signing.test.mjs
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  SoftwareSigner, signEvent, verifyEvent, isSigned, canonicalMessage, address, hex, utf8Bytes,
} from "../src/signing.ts";
import { sha256 } from "@noble/hashes/sha256";

const V = JSON.parse(readFileSync(new URL("./golden/vectors.json", import.meta.url))).signing;
const priv = Uint8Array.from(Buffer.from(V.priv, "hex"));
const signer = new SoftwareSigner(priv);

// 1. Key derivation is deterministic and matches the anchor.
assert.equal(hex(signer.publicKey()), V.pub, "pub mismatch");
assert.equal(address(signer.publicKey()), V.address, "address mismatch");

// 2. Signing an unsigned copy of the input reproduces canonical / digest / sig exactly.
const ev = JSON.parse(JSON.stringify(V.event));
signEvent(signer, V.domain, ev);
assert.equal(ev.dev, V.address, "signEvent must stamp dev = address");
assert.equal(ev.hlc.dev, V.address, "signEvent must stamp hlc.dev = address");
const canonical = canonicalMessage(V.domain, ev);
assert.equal(canonical, V.canonical, "canonical mismatch");
assert.equal(hex(sha256(utf8Bytes(canonical))), V.digest, "digest mismatch");
assert.equal(ev.sig, V.sig, "sig mismatch (deterministic RFC-6979 drift?)");
assert.equal(ev.pub, V.pub, "signed event pub mismatch");

// 3. The frozen signed event verifies; isSigned agrees.
assert.ok(verifyEvent(V.domain, V.signed), "frozen signed event must verify");
assert.ok(isSigned(V.signed), "frozen signed event must report signed");
assert.ok(!isSigned(V.event), "unsigned input must report unsigned");

// 4. Tamper-detection: any change to a signed field breaks verification.
const tamperPayload = JSON.parse(JSON.stringify(V.signed)); tamperPayload.payload.n = 43;
assert.ok(!verifyEvent(V.domain, tamperPayload), "mutated payload must fail verify");
const tamperType = JSON.parse(JSON.stringify(V.signed)); tamperType.type = "note.del";
assert.ok(!verifyEvent(V.domain, tamperType), "mutated type must fail verify");
const wrongDomain = JSON.parse(JSON.stringify(V.signed));
assert.ok(!verifyEvent("other", wrongDomain), "wrong domain must fail verify");
const forgedDev = JSON.parse(JSON.stringify(V.signed)); forgedDev.hlc.dev = "0x" + "0".repeat(40);
assert.ok(!verifyEvent(V.domain, forgedDev), "address≠dev must fail verify");

console.log("signing: pub/address/canonical/digest/sig anchors ✓  self-verify ✓  4 tamper cases rejected ✓");
