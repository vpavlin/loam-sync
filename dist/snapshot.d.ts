import { Event, HLC } from "./event.js";
import { type Identity } from "./crypto.js";
/** Content-addressed blob store (e.g. a Codex client). `put` returns a CID that is a pure function of
 *  the bytes, so identical bytes ⇒ identical CID (the property snapshots rely on). */
export interface Storage {
    put(bytes: Uint8Array): Promise<string>;
    get(cid: string): Promise<Uint8Array>;
}
/** Deterministic authenticated sealing. `seal` MUST be a pure function of `plaintext` (a random nonce
 *  would defeat CID convergence). `cryptoSealer` builds one from the household crypto (ADR 0011). */
export interface Sealer {
    seal(plaintext: Uint8Array): Uint8Array;
    open(sealed: Uint8Array): Uint8Array;
}
/** A deterministic Sealer over the household key: nonce is derived from a hash of the plaintext, so
 *  identical snapshots collide (same bytes) while distinct snapshots get distinct nonces (no reuse). */
export declare function cryptoSealer(id: Identity, domain: string): Sealer;
/** The sync-layer pointer that advertises a snapshot. NOT an app fold event — it never enters
 *  container state. Latest-wins by `epoch`/`coversUpToHlc`; same-epoch pointers carry the same `cid`. */
export interface SnapshotPointer {
    v: number;
    cid: string;
    epoch: number;
    coversUpToHlc: HLC;
    count: number;
}
/** The snapshot-epoch grid: the most recent COMPLETED boundary at or before `nowMs`. Snapshotters
 *  target a boundary in the PAST so RBSR has propagated every event with HLC < boundary to all peers,
 *  making the cut (and thus the CID) converge across independent writers. */
export declare function epochBoundary(nowMs: number, epochSizeMs: number): number;
/** The exclusive HLC upper bound for a wall-clock boundary — the minimal HLC at `boundaryMs`. */
export declare function boundaryHlc(boundaryMs: number): HLC;
/** Select the events of a cut, in canonical (HLC, then id) order. Pure. Includes exactly the events
 *  with HLC strictly before the boundary — the same set on every replica that holds them. */
export declare function selectCut(log: Event[], boundaryMs: number): Event[];
/** Canonical, deterministic bytes for a snapshot: `cjson({v,coversUpToHlc,count,events})`. Events keep
 *  pub/sig (the reader verifies them) and are canonicalised key-sorted, so equal cuts ⇒ equal bytes,
 *  independent of each writer's in-memory key order. No writer identity / timestamp in the bytes. */
export declare function serializeSnapshot(events: Event[], coversUpToHlc: HLC): Uint8Array;
/** Inverse of serializeSnapshot (the bytes are valid JSON). Does NOT verify — the caller must. */
export declare function parseSnapshot(bytes: Uint8Array): {
    v: number;
    coversUpToHlc: HLC;
    count: number;
    events: Event[];
};
/** Writer: cut the log at the latest completed epoch, serialize → seal → upload, return the pointer to
 *  publish. Returns null when the cut is empty (nothing to snapshot yet). Deterministic: two writers of
 *  the same cut return the same `cid`. */
export declare function writeSnapshot(args: {
    log: Event[];
    epochSizeMs: number;
    sealer: Sealer;
    storage: Storage;
    now?: number;
}): Promise<SnapshotPointer | null>;
/** Reader: fetch the pointer's blob → open → parse → VERIFY every signature → return the events to
 *  merge. Bootstrap = `mergeEvents(localLog, await readSnapshot(...))`, then RBSR-tail from
 *  `pointer.coversUpToHlc`. `verify` defaults to a `domain`-based `verifyEvent`; pass one or the other
 *  (an unverified read is refused unless `verify:()=>true` is passed explicitly). */
export declare function readSnapshot(pointer: SnapshotPointer, args: {
    sealer: Sealer;
    storage: Storage;
    domain?: string;
    verify?: (ev: Event) => boolean;
}): Promise<Event[]>;
/** Pointer resolution: given the pointers seen for a container, pick the best snapshot to bootstrap
 *  from. Newest epoch wins; within an epoch the CID the most pointers agree on wins (a minority CID is a
 *  behind writer), breaking ties by higher `count`. Returns null if none. */
export declare function bestPointer(pointers: SnapshotPointer[]): SnapshotPointer | null;
