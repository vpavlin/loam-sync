// crypto.ts — the shared household AEAD envelope for loam-sync (ADR 0011).
// Domain-parameterised so every app derives the SAME keys it always did (kym/qaku/…),
// with ONE change: the nonce is DERIVED from the event id, not random — so re-sealing an
// immutable event yields byte-identical ciphertext the fleet store dedups (no bloat, no
// cold-start truncation). No nonce reuse: one id ↦ one immutable plaintext.
//
//   K     = HKDF-SHA256(ikm=S,  salt="<domain>-pair-v1", info="",                  32)
//   Ke    = HKDF-SHA256(ikm=K,  salt="",                 info="<domain>/payload/v1",32)
//   topic = "/<domain>/1/" + hex(HMAC-SHA256(K,"<domain>/topic/v1|"+epoch)[0..15]) + "/proto"
//   nonce = HMAC-SHA256(Ke, "<domain>/nonce/v1|"+eventId)[0..11]         (12 bytes, DETERMINISTIC)
//   wire  = nonce(12) ‖ ChaCha20-Poly1305(Ke, nonce, plaintext, aad=topic)
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

const enc = (s: string) => new TextEncoder().encode(s);
const HEXC = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

export interface Identity { secret: Uint8Array; K: Uint8Array; Ke: Uint8Array; fpBytes: Uint8Array; }

/** Derive the household identity from a 32-byte secret, for an app `domain`. Pure.
 *  Byte-identical to each app's legacy deriveIdentity when domain is that app's name. */
export function deriveIdentity(secret: Uint8Array, domain: string): Identity {
  if (secret.length !== 32) throw new Error("household secret must be 32 bytes");
  const K = hkdf(sha256, secret, enc(domain + "-pair-v1"), new Uint8Array(0), 32);
  const Ke = hkdf(sha256, K, new Uint8Array(0), enc(domain + "/payload/v1"), 32);
  return { secret, K, Ke, fpBytes: sha256(K).slice(0, 3) };
}

export function topicFor(id: Identity, domain: string, epoch = 0): string {
  const t = hmac(sha256, id.K, enc(`${domain}/topic/v1|${epoch}`)).slice(0, 16);
  return `/${domain}/1/${hex(t)}/proto`;
}

/** Deterministic per-event nonce (ADR 0011). */
export function nonceFor(id: Identity, domain: string, eventId: string): Uint8Array {
  return hmac(sha256, id.Ke, enc(`${domain}/nonce/v1|${eventId}`)).slice(0, 12);
}

/** Seal with the DETERMINISTIC id-derived nonce. Re-sealing the same event ↦ identical bytes. */
export function seal(id: Identity, domain: string, eventId: string, plaintext: Uint8Array, topic: string): Uint8Array {
  const n = nonceFor(id, domain, eventId);
  const ct = chacha20poly1305(id.Ke, n, enc(topic)).encrypt(plaintext);
  const out = new Uint8Array(12 + ct.length);
  out.set(n, 0); out.set(ct, 12);
  return out;
}

/** Inverse of seal(). Throws if the tag doesn't verify. The nonce still travels on the wire,
 *  so a legacy (random-nonce) message opens unchanged — fully backward-compatible. */
export function open(id: Identity, sealed: Uint8Array, topic: string): Uint8Array {
  return chacha20poly1305(id.Ke, sealed.subarray(0, 12), enc(topic)).decrypt(sealed.subarray(12));
}
