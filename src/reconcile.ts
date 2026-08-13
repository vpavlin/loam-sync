// reconcile.ts — Range-Based Set Reconciliation over the event-id set.
// Mirror of basecamp/logos_sync/reconcile.hpp; the fingerprint byte layout is the
// cross-language parity contract (docs/PARITY.md, docs/adr/0003, docs/adr/0005).
import { sha256 } from "@noble/hashes/sha2.js";
import { Event } from "./event.js";

const enc = new TextEncoder();

export interface Item {
  wall: number;
  id: string;
}

// Order by (wall, id): the (timestamp, id) tuple RBSR/Negentropy orders on.
function keyCmp(a: Item, b: Item): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Project events into the canonical reconciliation order. */
export function toItems(events: Event[]): Item[] {
  return events.map((e) => ({ wall: e.hlc.wall, id: e.id })).sort(keyCmp);
}

// Order-independent fingerprint: XOR of SHA-256(id) over 32 bytes, then
// SHA-256(acc ‖ uint32_be(count))[0..16], hex. Identical bytes to the C++ mirror.
function fingerprint(items: Item[]): string {
  const acc = new Uint8Array(32);
  for (const it of items) {
    const h = sha256(enc.encode(it.id));
    for (let i = 0; i < 32; i++) acc[i] ^= h[i];
  }
  const countBuf = new Uint8Array(4);
  new DataView(countBuf.buffer).setUint32(0, items.length);
  const fp = sha256(new Uint8Array([...acc, ...countBuf])).slice(0, 16);
  return Buffer.from(fp).toString("hex");
}

function inRange(items: Item[], lo: Item | null, hi: Item | null): Item[] {
  return items.filter((it) => {
    if (lo && keyCmp(it, lo) < 0) return false;
    if (hi && keyCmp(it, hi) >= 0) return false;
    return true;
  });
}

export interface Diff {
  aNeeds: string[];
  bNeeds: string[];
  rounds: number;
  controlBytes: number;
}

/** Reconcile two event sets → exact symmetric difference. aNeeds = ids A lacks
 *  (B has); bNeeds = ids B lacks (A has). See reconcile.hpp for the algorithm. */
export function reconcile(
  eventsA: Event[],
  eventsB: Event[],
  { threshold = 8, buckets = 16 }: { threshold?: number; buckets?: number } = {},
): Diff {
  const A = toItems(eventsA);
  const B = toItems(eventsB);
  const aNeeds = new Set<string>();
  const bNeeds = new Set<string>();
  let rounds = 0;
  let controlBytes = 0;

  let frontier: { lo: Item | null; hi: Item | null }[] = [{ lo: null, hi: null }];
  while (frontier.length) {
    rounds++;
    const next: { lo: Item | null; hi: Item | null }[] = [];
    for (const { lo, hi } of frontier) {
      const ia = inRange(A, lo, hi);
      const ib = inRange(B, lo, hi);
      controlBytes += 16 * 2;
      if (fingerprint(ia) === fingerprint(ib)) continue;

      const larger = ia.length >= ib.length ? ia : ib;
      if (larger.length <= threshold) {
        const aSet = new Set(ia.map((x) => x.id));
        const bSet = new Set(ib.map((x) => x.id));
        for (const x of ib) if (!aSet.has(x.id)) aNeeds.add(x.id);
        for (const x of ia) if (!bSet.has(x.id)) bNeeds.add(x.id);
        controlBytes += (ia.length + ib.length) * 36;
        continue;
      }
      const step = Math.ceil(larger.length / buckets);
      let subLo = lo;
      for (let i = 0; i < larger.length; i += step) {
        const nextItem = larger[i + step];
        const subHi = nextItem ? { wall: nextItem.wall, id: nextItem.id } : hi;
        next.push({ lo: subLo, hi: subHi });
        subLo = subHi;
      }
    }
    frontier = next;
  }
  return { aNeeds: [...aNeeds], bNeeds: [...bNeeds], rounds, controlBytes };
}

/** The range fingerprint of a set of ids — exposed so the parity test can check
 *  it byte-for-byte against the C++ mirror. */
export function fingerprintIds(ids: string[]): string {
  return fingerprint(ids.map((id) => ({ id, wall: 0 })));
}
