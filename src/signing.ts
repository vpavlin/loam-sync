// signing.ts — the OPTIONAL event-authenticity layer (docs/adr/0008).
// TypeScript mirror of basecamp/logos_sync/signing.hpp — a phone-signed event verifies
// on the desktop and vice-versa. Proves WHO authored an event (secp256k1); verification
// is public-key only; signing is delegated through an injected `Signer`, so the library
// never holds a private key (software key today, Keycard tomorrow — same code path).
//
//   canonical = "<domain>-sig-v1|"+type+"|"+wall+"|"+ctr+"|"+dev+"|"+id+"|"+cjson(payload)
//   address   = "0x" + hex(sha256(pub_compressed_33B)).slice(24,64)
//   digest    = sha256(utf8(canonical));  sig = secp256k1 ECDSA over digest, compact r‖s, low-S
//
// @noble v1 (the Hermes-proven stack): sign(digest, priv) signs the hash directly and
// returns a Signature (.toCompactHex()); it cross-verifies with the desktop OpenSSL core.
// (v2 needs {prehash:false} AND misbehaves on Hermes — docs/adr/0008 parity gotcha.)
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import type { Event } from "./event.js";

const HEXC = "0123456789abcdef";
export function hex(b: Uint8Array): string { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; }
export function fromHex(s: string): Uint8Array { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }

// Minimal UTF-8 encoder (inlined so the library carries no TextEncoder/polyfill dependency
// — Hermes lacks TextEncoder). Matches the desktop's byte view of the canonical string.
export function utf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff) { // surrogate pair
      const c2 = s.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return new Uint8Array(out);
}

// address = "0x" + last 20 bytes of sha256(compressed pubkey), lowercase hex (SHA-256, not
// keccak, so OpenSSL and @noble derive it byte-identically).
export function address(pubCompressed: Uint8Array): string { return "0x" + hex(sha256(pubCompressed)).slice(24, 64); }

// Deterministic canonical form of an event's SIGNED fields (everything except pub/sig).
function cjson(v: any): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(cjson).join(",") + "]";
  if (typeof v === "object") { const ks = Object.keys(v).sort(); return "{" + ks.map((k) => JSON.stringify(k) + ":" + cjson(v[k])).join(",") + "}"; }
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return "null";
}
export function canonicalMessage(domain: string, ev: any): string {
  const dev = (ev.hlc && ev.hlc.dev) || ev.dev || "";
  const wall = ev.hlc ? ev.hlc.wall : 0, ctr = ev.hlc ? ev.hlc.ctr : 0;
  return domain + "-sig-v1|" + ev.type + "|" + wall + "|" + ctr + "|" + dev + "|" + ev.id + "|" + cjson(ev.payload || {});
}

// ── the Signer seam (docs/adr/0008) ──────────────────────────────────────────
// The library sees a Signer, never a key. Key storage + RNG are the APP's job (SecureStore /
// expo-crypto on mobile, kv / OpenSSL on desktop); the app constructs a signer and injects it.
export interface Signer {
  publicKey(): Uint8Array;            // 33B compressed
  signDigest(digest32: Uint8Array): Uint8Array; // 64B low-S compact
}

export class SoftwareSigner implements Signer {
  private readonly priv: Uint8Array;
  private readonly pub: Uint8Array;
  constructor(priv32: Uint8Array) { this.priv = priv32; this.pub = secp256k1.getPublicKey(priv32, true); }
  publicKey(): Uint8Array { return this.pub; }
  signDigest(d: Uint8Array): Uint8Array { return fromHex(secp256k1.sign(d, this.priv).toCompactHex()); }
}

// Stamp the event with the signer's address as author (dev + hlc.dev) and sign. Mutates + returns ev.
export function signEvent(signer: Signer, domain: string, ev: any): Event {
  const pub = signer.publicKey();
  const addr = address(pub);
  ev.dev = addr;
  if (ev.hlc) ev.hlc.dev = addr;
  const digest = sha256(utf8Bytes(canonicalMessage(domain, ev)));
  ev.pub = hex(pub);
  ev.sig = hex(signer.signDigest(digest));
  return ev;
}

// True iff the event is well-signed by the key whose address it claims (dev). Pure,
// public-key only, never throws — the fold decides policy (docs/adr/0007).
export function verifyEvent(domain: string, ev: any): boolean {
  try {
    if (!ev || !ev.pub || !ev.sig || !ev.type || !ev.id) return false;
    const dev = (ev.hlc && ev.hlc.dev) || ev.dev;
    if (!dev) return false;
    const pub = fromHex(ev.pub);
    if (pub.length !== 33) return false;
    if (address(pub) !== dev) return false;
    const digest = sha256(utf8Bytes(canonicalMessage(domain, ev)));
    return secp256k1.verify(fromHex(ev.sig), digest, pub);
  } catch { return false; }
}

// An event is "legacy" (pre-signing) when it carries no signature.
export function isSigned(ev: any): boolean { return !!(ev && ev.sig); }
