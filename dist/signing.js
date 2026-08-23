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
// @noble v2 (aligned ecosystem-wide, ADR 0019): sign(digest, priv, {prehash:false}) signs the
// 32-byte digest directly and returns a 64B compact r‖s Uint8Array; verify(...,{prehash:false}).
// Low-S canonical by default; cross-verifies with the desktop OpenSSL core (proven by the golden gate).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
const HEXC = "0123456789abcdef";
export function hex(b) { let s = ""; for (const x of b)
    s += HEXC[x >> 4] + HEXC[x & 15]; return s; }
export function fromHex(s) { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++)
    a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }
// Minimal UTF-8 encoder (inlined so the library carries no TextEncoder/polyfill dependency
// — Hermes lacks TextEncoder). Matches the desktop's byte view of the canonical string.
export function utf8Bytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80)
            out.push(c);
        else if (c < 0x800) {
            out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        }
        else if (c >= 0xd800 && c <= 0xdbff) { // surrogate pair
            const c2 = s.charCodeAt(++i);
            c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
            out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        else {
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
    }
    return new Uint8Array(out);
}
// address = "0x" + last 20 bytes of sha256(compressed pubkey), lowercase hex (SHA-256, not
// keccak, so OpenSSL and @noble derive it byte-identically).
export function address(pubCompressed) { return "0x" + hex(sha256(pubCompressed)).slice(24, 64); }
// Deterministic canonical form of an event's SIGNED fields (everything except pub/sig).
function cjson(v) {
    if (v === null || v === undefined)
        return "null";
    if (Array.isArray(v))
        return "[" + v.map(cjson).join(",") + "]";
    if (typeof v === "object") {
        const ks = Object.keys(v).sort();
        return "{" + ks.map((k) => JSON.stringify(k) + ":" + cjson(v[k])).join(",") + "}";
    }
    if (typeof v === "string")
        return JSON.stringify(v);
    if (typeof v === "number")
        return String(v);
    if (typeof v === "boolean")
        return v ? "true" : "false";
    return "null";
}
export function canonicalMessage(domain, ev) {
    const dev = (ev.hlc && ev.hlc.dev) || ev.dev || "";
    const wall = ev.hlc ? ev.hlc.wall : 0, ctr = ev.hlc ? ev.hlc.ctr : 0;
    // ADR 0017: canonical over the payload AS-IS (no `|| {}` coercion). A null/absent
    // payload canonicalises to "null" — byte-identical to the C++ cjson(e.payload) —
    // so a signature verifies across TS and C++ regardless of payload shape.
    return domain + "-sig-v1|" + ev.type + "|" + wall + "|" + ctr + "|" + dev + "|" + ev.id + "|" + cjson(ev.payload === undefined ? null : ev.payload);
}
export class SoftwareSigner {
    priv;
    pub;
    constructor(priv32) { this.priv = priv32; this.pub = secp256k1.getPublicKey(priv32, true); }
    publicKey() { return this.pub; }
    signDigest(d) { return secp256k1.sign(d, this.priv, { prehash: false }); }
}
export function canonicalCert(domain, c) {
    return domain + "-deleg-v1|" + c.delegatePub + "|" + c.idPub + "|" + c.notAfter + "|" + c.maxSigs + "|" + c.scope;
}
// Verify the cert's identity signature and that it had not expired at `atMs`. Does NOT check
// maxSigs/scope — those are count/scope-dependent and belong in the deterministic fold (the
// app owns the fold, docs/adr/0007), alongside role gating.
export function verifyCert(domain, c, atMs) {
    try {
        if (!c || !c.delegatePub || !c.idPub || !c.idSig)
            return false;
        const idPub = fromHex(c.idPub);
        if (idPub.length !== 33)
            return false;
        if (c.notAfter !== 0 && atMs > c.notAfter)
            return false;
        const digest = sha256(utf8Bytes(canonicalCert(domain, c)));
        return secp256k1.verify(fromHex(c.idSig), digest, idPub, { prehash: false });
    }
    catch {
        return false;
    }
}
// Issue a cert: the identity signer (the card, on-card) signs the canonical cert. Sync form for
// a SoftwareSigner; issueCertAsync for a hardware AsyncSigner.
export function issueCert(idSigner, domain, delegatePub, opts) {
    const c = { delegatePub, idPub: hex(idSigner.publicKey()), notAfter: opts?.notAfter ?? 0, maxSigs: opts?.maxSigs ?? 0, scope: opts?.scope ?? "", idSig: "" };
    c.idSig = hex(idSigner.signDigest(sha256(utf8Bytes(canonicalCert(domain, c)))));
    return c;
}
export async function issueCertAsync(idSigner, domain, delegatePub, opts) {
    const c = { delegatePub, idPub: hex(idSigner.publicKey()), notAfter: opts?.notAfter ?? 0, maxSigs: opts?.maxSigs ?? 0, scope: opts?.scope ?? "", idSig: "" };
    c.idSig = hex(await idSigner.signDigest(sha256(utf8Bytes(canonicalCert(domain, c)))));
    return c;
}
// Stamp the event with the AUTHOR address (the card identity when delegated, else the signer's
// own key) and sign with `signer`; attach the cert when delegated. Mutates + returns ev. With
// no cert this is exactly the pre-delegation behaviour (author = signer address, no `cert`).
export function signEvent(signer, domain, ev, cert) {
    const pub = signer.publicKey();
    const author = cert ? address(fromHex(cert.idPub)) : address(pub);
    ev.dev = author;
    if (ev.hlc)
        ev.hlc.dev = author;
    const digest = sha256(utf8Bytes(canonicalMessage(domain, ev)));
    ev.pub = hex(pub);
    ev.sig = hex(signer.signDigest(digest));
    if (cert)
        ev.cert = cert;
    return ev;
}
// Async form for a hardware signer (Keycard tap-per-sign: `signer` is the card identity, no cert).
export async function signEventAsync(signer, domain, ev, cert) {
    const pub = signer.publicKey();
    const author = cert ? address(fromHex(cert.idPub)) : address(pub);
    ev.dev = author;
    if (ev.hlc)
        ev.hlc.dev = author;
    const digest = sha256(utf8Bytes(canonicalMessage(domain, ev)));
    ev.pub = hex(pub);
    ev.sig = hex(await signer.signDigest(digest));
    if (cert)
        ev.cert = cert;
    return ev;
}
// True iff the event is well-signed by the key whose address it claims. Pure, public-key only,
// never throws — the fold decides policy (docs/adr/0007). Cert-aware (docs/adr/0009): with no
// `cert`, author = address of the signing key (unchanged); with a `cert`, the signing key is a
// delegate a card identity authorized, and the author is the card identity. A cert-less event
// verifies exactly as before — the delegation layer is purely additive.
export function verifyEvent(domain, ev) {
    try {
        if (!ev || !ev.pub || !ev.sig || !ev.type || !ev.id)
            return false;
        const dev = (ev.hlc && ev.hlc.dev) || ev.dev;
        if (!dev)
            return false;
        const pub = fromHex(ev.pub);
        if (pub.length !== 33)
            return false;
        // The event body is always signed by ev.pub (the delegate, or the identity key itself).
        const digest = sha256(utf8Bytes(canonicalMessage(domain, ev)));
        if (!secp256k1.verify(fromHex(ev.sig), digest, pub, { prehash: false }))
            return false;
        if (ev.cert) {
            const c = ev.cert;
            if (c.delegatePub !== ev.pub)
                return false; // cert must bind THIS delegate
            // DETERMINISTIC expiry: check against the event's OWN authored time (hlc.wall), never
            // wall-clock-at-fold — else two devices folding the same log at different moments could
            // disagree and diverge. The fold must be a pure function of the log.
            const evWall = (ev.hlc && ev.hlc.wall) || 0;
            if (!verifyCert(domain, c, evWall))
                return false;
            return address(fromHex(c.idPub)) === dev; // author = card identity
        }
        return address(pub) === dev; // direct: author = signing key
    }
    catch {
        return false;
    }
}
// An event is "legacy" (pre-signing) when it carries no signature.
export function isSigned(ev) { return !!(ev && ev.sig); }
