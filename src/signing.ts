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
  // ADR 0017: canonical over the payload AS-IS (no `|| {}` coercion). A null/absent
  // payload canonicalises to "null" — byte-identical to the C++ cjson(e.payload) —
  // so a signature verifies across TS and C++ regardless of payload shape.
  return domain + "-sig-v1|" + ev.type + "|" + wall + "|" + ctr + "|" + dev + "|" + ev.id + "|" + cjson(ev.payload === undefined ? null : ev.payload);
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

// An async Signer — same seam, but signDigest may await (a Keycard taps NFC to sign on-card).
// The library still never holds a key; a hardware backend (loam-keycard) implements this.
export interface AsyncSigner {
  publicKey(): Uint8Array;
  signDigest(digest32: Uint8Array): Promise<Uint8Array>; // 64B low-S compact
}

// ── delegation certs + custody policy (docs/adr/0009) ────────────────────────
// Keycard's key never leaves the card. To sign a high-frequency event stream (and to work on
// a device with no reader), the card identity signs — ON CARD, one tap — a cert authorizing an
// ephemeral DELEGATE key to author events on its behalf, within bounds. Events then carry
// (delegate sig + cert); a verifier chains delegate→cert→identity, and the AUTHOR is the card
// identity, not the delegate. This is one mechanism spanning the whole custody slider:
//   tap-per-sign — the "delegate" IS the identity key, on-card, no cert (maxSigs≡1)
//   delegated    — bounded cert (notAfter / maxSigs), re-tap on expiry
//   exported     — an unbounded cert (notAfter=0) over an exported key (least secure)
export type CustodyMode = "tap-per-sign" | "delegated" | "exported";
export interface CustodyPolicy { mode: CustodyMode; ttlMinutes?: number; maxSigs?: number }

export interface DelegationCert {
  delegatePub: string; // hex compressed 33B — the key that signs the events
  idPub: string;       // hex compressed 33B — the card identity key (the person)
  notAfter: number;    // unix ms; 0 = never expires (exported mode)
  maxSigs: number;     // 0 = unlimited; else max events this delegate may author (FOLD-enforced)
  scope: string;       // "" = any; else the container id this delegation is limited to (FOLD-enforced)
  idSig: string;       // secp256k1 sig by idPub over canonicalCert() — issued on-card
}
export function canonicalCert(domain: string, c: DelegationCert): string {
  return domain + "-deleg-v1|" + c.delegatePub + "|" + c.idPub + "|" + c.notAfter + "|" + c.maxSigs + "|" + c.scope;
}
// Verify the cert's identity signature and that it had not expired at `atMs`. Does NOT check
// maxSigs/scope — those are count/scope-dependent and belong in the deterministic fold (the
// app owns the fold, docs/adr/0007), alongside role gating.
export function verifyCert(domain: string, c: DelegationCert, atMs: number): boolean {
  try {
    if (!c || !c.delegatePub || !c.idPub || !c.idSig) return false;
    const idPub = fromHex(c.idPub);
    if (idPub.length !== 33) return false;
    if (c.notAfter !== 0 && atMs > c.notAfter) return false;
    const digest = sha256(utf8Bytes(canonicalCert(domain, c)));
    return secp256k1.verify(fromHex(c.idSig), digest, idPub);
  } catch { return false; }
}
// Issue a cert: the identity signer (the card, on-card) signs the canonical cert. Sync form for
// a SoftwareSigner; issueCertAsync for a hardware AsyncSigner.
export function issueCert(idSigner: Signer, domain: string, delegatePub: string, opts?: { notAfter?: number; maxSigs?: number; scope?: string }): DelegationCert {
  const c: DelegationCert = { delegatePub, idPub: hex(idSigner.publicKey()), notAfter: opts?.notAfter ?? 0, maxSigs: opts?.maxSigs ?? 0, scope: opts?.scope ?? "", idSig: "" };
  c.idSig = hex(idSigner.signDigest(sha256(utf8Bytes(canonicalCert(domain, c)))));
  return c;
}
export async function issueCertAsync(idSigner: AsyncSigner, domain: string, delegatePub: string, opts?: { notAfter?: number; maxSigs?: number; scope?: string }): Promise<DelegationCert> {
  const c: DelegationCert = { delegatePub, idPub: hex(idSigner.publicKey()), notAfter: opts?.notAfter ?? 0, maxSigs: opts?.maxSigs ?? 0, scope: opts?.scope ?? "", idSig: "" };
  c.idSig = hex(await idSigner.signDigest(sha256(utf8Bytes(canonicalCert(domain, c)))));
  return c;
}

// Stamp the event with the AUTHOR address (the card identity when delegated, else the signer's
// own key) and sign with `signer`; attach the cert when delegated. Mutates + returns ev. With
// no cert this is exactly the pre-delegation behaviour (author = signer address, no `cert`).
export function signEvent(signer: Signer, domain: string, ev: any, cert?: DelegationCert): Event {
  const pub = signer.publicKey();
  const author = cert ? address(fromHex(cert.idPub)) : address(pub);
  ev.dev = author;
  if (ev.hlc) ev.hlc.dev = author;
  const digest = sha256(utf8Bytes(canonicalMessage(domain, ev)));
  ev.pub = hex(pub);
  ev.sig = hex(signer.signDigest(digest));
  if (cert) ev.cert = cert;
  return ev;
}
// Async form for a hardware signer (Keycard tap-per-sign: `signer` is the card identity, no cert).
export async function signEventAsync(signer: AsyncSigner, domain: string, ev: any, cert?: DelegationCert): Promise<Event> {
  const pub = signer.publicKey();
  const author = cert ? address(fromHex(cert.idPub)) : address(pub);
  ev.dev = author;
  if (ev.hlc) ev.hlc.dev = author;
  const digest = sha256(utf8Bytes(canonicalMessage(domain, ev)));
  ev.pub = hex(pub);
  ev.sig = hex(await signer.signDigest(digest));
  if (cert) ev.cert = cert;
  return ev;
}

// True iff the event is well-signed by the key whose address it claims. Pure, public-key only,
// never throws — the fold decides policy (docs/adr/0007). Cert-aware (docs/adr/0009): with no
// `cert`, author = address of the signing key (unchanged); with a `cert`, the signing key is a
// delegate a card identity authorized, and the author is the card identity. A cert-less event
// verifies exactly as before — the delegation layer is purely additive.
export function verifyEvent(domain: string, ev: any): boolean {
  try {
    if (!ev || !ev.pub || !ev.sig || !ev.type || !ev.id) return false;
    const dev = (ev.hlc && ev.hlc.dev) || ev.dev;
    if (!dev) return false;
    const pub = fromHex(ev.pub);
    if (pub.length !== 33) return false;
    // The event body is always signed by ev.pub (the delegate, or the identity key itself).
    const digest = sha256(utf8Bytes(canonicalMessage(domain, ev)));
    if (!secp256k1.verify(fromHex(ev.sig), digest, pub)) return false;
    if (ev.cert) {
      const c = ev.cert as DelegationCert;
      if (c.delegatePub !== ev.pub) return false;                 // cert must bind THIS delegate
      // DETERMINISTIC expiry: check against the event's OWN authored time (hlc.wall), never
      // wall-clock-at-fold — else two devices folding the same log at different moments could
      // disagree and diverge. The fold must be a pure function of the log.
      const evWall = (ev.hlc && ev.hlc.wall) || 0;
      if (!verifyCert(domain, c, evWall)) return false;
      return address(fromHex(c.idPub)) === dev;                   // author = card identity
    }
    return address(pub) === dev;                                  // direct: author = signing key
  } catch { return false; }
}

// An event is "legacy" (pre-signing) when it carries no signature.
export function isSigned(ev: any): boolean { return !!(ev && ev.sig); }
