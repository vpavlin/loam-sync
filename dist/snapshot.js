// snapshot.ts — deterministic log snapshots to content-addressed Storage (docs/adr/0020).
//
// Bootstrap a joining/reconnecting device from ONE sealed blob in Storage (Codex) instead of
// receiving hundreds of individually relay-served messages — the pattern from web Qaku. A snapshot
// is a bag of signed events up to a cut; the newcomer fetches it, re-verifies every signature, folds
// it exactly as if received on the wire, then RBSR-tails the delta from `coversUpToHlc`.
//
// RBSR stays the correctness guarantee — a snapshot is an accelerator. A malicious/stale snapshotter
// can only OMIT events (healed by RBSR) or include forged ones (dropped by verify); it can never inject
// fake state, so any peer may write one and none need be trusted.
//
// DETERMINISM (the reason for the canonical form + snapshot epochs): the blob is a pure function of the
// cut, so independent snapshotters of the same cut produce byte-identical blobs → the SAME Storage CID.
// That gives content-addressed dedup (one copy, not N), pointer convergence, and a trust signal (N
// parties agreeing on a CID for a cut). Four things are deterministic here: (1) event ORDER — (HLC, id);
// (2) SERIALIZATION — the shared `cjson` canonicaliser (sorted keys, no whitespace), events carry pub/sig
// so the reader can verify; (3) SEALING — a deterministic nonce (crypto.ts / ADR 0011), so identical
// plaintext ⇒ identical ciphertext; (4) MEMBERSHIP — a CUT (events with HLC before the epoch boundary),
// not "what I currently hold". See `epochBoundary` for the snapshot-epoch grid.
import { compareHlc } from "./event.js";
import { cjson, verifyEvent } from "./signing.js";
import { seal as cryptoSeal, open as cryptoOpen } from "./crypto.js";
import { sha256 } from "@noble/hashes/sha2.js";
const HEXC = "0123456789abcdef";
const hex = (b) => { let s = ""; for (const x of b)
    s += HEXC[x >> 4] + HEXC[x & 15]; return s; };
const utf8 = (s) => new TextEncoder().encode(s);
const fromUtf8 = (b) => new TextDecoder().decode(b);
/** A deterministic Sealer over the household key: nonce is derived from a hash of the plaintext, so
 *  identical snapshots collide (same bytes) while distinct snapshots get distinct nonces (no reuse). */
export function cryptoSealer(id, domain) {
    const aad = `${domain}/snapshot/v1`;
    return {
        seal: (pt) => cryptoSeal(id, domain, hex(sha256(pt)), pt, aad),
        open: (sealed) => cryptoOpen(id, sealed, aad),
    };
}
/** The snapshot-epoch grid: the most recent COMPLETED boundary at or before `nowMs`. Snapshotters
 *  target a boundary in the PAST so RBSR has propagated every event with HLC < boundary to all peers,
 *  making the cut (and thus the CID) converge across independent writers. */
export function epochBoundary(nowMs, epochSizeMs) {
    if (!(epochSizeMs > 0))
        throw new Error("epochSizeMs must be > 0");
    return Math.floor(nowMs / epochSizeMs) * epochSizeMs;
}
/** The exclusive HLC upper bound for a wall-clock boundary — the minimal HLC at `boundaryMs`. */
export function boundaryHlc(boundaryMs) {
    return { wall: boundaryMs, ctr: 0, dev: "" };
}
/** Select the events of a cut, in canonical (HLC, then id) order. Pure. Includes exactly the events
 *  with HLC strictly before the boundary — the same set on every replica that holds them. */
export function selectCut(log, boundaryMs) {
    const bound = boundaryHlc(boundaryMs);
    return log
        .filter((e) => e && e.id && compareHlc(e.hlc, bound) < 0)
        .sort((a, b) => compareHlc(a.hlc, b.hlc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Canonical, deterministic bytes for a snapshot: `cjson({v,coversUpToHlc,count,events})`. Events keep
 *  pub/sig (the reader verifies them) and are canonicalised key-sorted, so equal cuts ⇒ equal bytes,
 *  independent of each writer's in-memory key order. No writer identity / timestamp in the bytes. */
export function serializeSnapshot(events, coversUpToHlc) {
    return utf8(cjson({ v: 1, coversUpToHlc, count: events.length, events }));
}
/** Inverse of serializeSnapshot (the bytes are valid JSON). Does NOT verify — the caller must. */
export function parseSnapshot(bytes) {
    const o = JSON.parse(fromUtf8(bytes));
    return { v: o.v, coversUpToHlc: o.coversUpToHlc, count: o.count, events: Array.isArray(o.events) ? o.events : [] };
}
/** Writer: cut the log at the latest completed epoch, serialize → seal → upload, return the pointer to
 *  publish. Returns null when the cut is empty (nothing to snapshot yet). Deterministic: two writers of
 *  the same cut return the same `cid`. */
export async function writeSnapshot(args) {
    const boundary = epochBoundary(args.now ?? Date.now(), args.epochSizeMs);
    const events = selectCut(args.log, boundary);
    if (events.length === 0)
        return null;
    const coversUpToHlc = boundaryHlc(boundary);
    const plaintext = serializeSnapshot(events, coversUpToHlc);
    const sealed = args.sealer.seal(plaintext);
    const cid = await args.storage.put(sealed);
    return { v: 1, cid, epoch: boundary, coversUpToHlc, count: events.length };
}
/** Reader: fetch the pointer's blob → open → parse → VERIFY every signature → return the events to
 *  merge. Bootstrap = `mergeEvents(localLog, await readSnapshot(...))`, then RBSR-tail from
 *  `pointer.coversUpToHlc`. `verify` defaults to a `domain`-based `verifyEvent`; pass one or the other
 *  (an unverified read is refused unless `verify:()=>true` is passed explicitly). */
export async function readSnapshot(pointer, args) {
    const verify = args.verify ?? (args.domain ? (ev) => verifyEvent(args.domain, ev) : null);
    if (!verify)
        throw new Error("readSnapshot: pass `domain` or `verify` — snapshots must be re-verified");
    const sealed = await args.storage.get(pointer.cid);
    const plaintext = args.sealer.open(sealed);
    const { events } = parseSnapshot(plaintext);
    return events.filter(verify);
}
/** Pointer resolution: given the pointers seen for a container, pick the best snapshot to bootstrap
 *  from. Newest epoch wins; within an epoch the CID the most pointers agree on wins (a minority CID is a
 *  behind writer), breaking ties by higher `count`. Returns null if none. */
export function bestPointer(pointers) {
    if (!pointers || pointers.length === 0)
        return null;
    const maxEpoch = Math.max(...pointers.map((p) => p.epoch));
    const inEpoch = pointers.filter((p) => p.epoch === maxEpoch);
    const byCid = new Map();
    for (const p of inEpoch) {
        const e = byCid.get(p.cid);
        if (e)
            e.votes++;
        else
            byCid.set(p.cid, { p, votes: 1 });
    }
    let best = null;
    for (const e of byCid.values()) {
        if (!best || e.votes > best.votes || (e.votes === best.votes && e.p.count > best.p.count))
            best = e;
    }
    return best ? best.p : null;
}
