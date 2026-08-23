import { fingerprintIds } from "./reconcile.js";
function sortedIds(evs) {
    return evs.map((e) => e.id).filter(Boolean).sort();
}
// ids in the half-open range (lo, hi] by string order; undefined bound = ±infinity.
function idsInRange(ids, lo, hi) {
    return ids.filter((id) => (lo === undefined || id > lo) && (hi === undefined || id <= hi));
}
// Split `ids` (the subset in (lo,hi]) into `buckets` sub-ranges, one fingerprint each.
function buildFp(from, ids, lo, hi, buckets) {
    const msg = { v: 2, t: "fp", from, bounds: [], fps: [] };
    if (lo !== undefined)
        msg.lo = lo;
    if (hi !== undefined)
        msg.hi = hi;
    const n = ids.length;
    const k = Math.max(1, Math.min(buckets, n === 0 ? 1 : n));
    const step = Math.max(1, Math.ceil(n / k));
    for (let i = 0; i < n || (n === 0 && i === 0); i += step) {
        const end = Math.min(n, i + step);
        const last = end >= n;
        const sub = ids.slice(Math.min(i, n), end);
        msg.fps.push(fingerprintIds(sub));
        if (!last)
            msg.bounds.push(ids[end - 1]); // interior boundary
        if (n === 0)
            break;
    }
    return msg;
}
/** The initial message a joining/reconnecting peer publishes. */
export function buildInitial(myEvents, from, buckets = 8) {
    return buildFp(from, sortedIds(myEvents), undefined, undefined, buckets);
}
/** Pure state-machine step: process one incoming message against my set. */
export function respond(myEvents, msg, me, threshold = 8, buckets = 8) {
    const step = { replies: [], serve: [] };
    if (!msg || msg.from === me)
        return step;
    const byId = new Map(myEvents.map((e) => [e.id, e]));
    const mine = sortedIds(myEvents);
    if (msg.t === "fp") {
        const { lo, hi, bounds, fps } = msg;
        const k = fps.length;
        for (let i = 0; i < k; i++) {
            const subLo = i === 0 ? lo : bounds[i - 1];
            const subHi = i === k - 1 ? hi : bounds[i];
            const myItems = idsInRange(mine, subLo, subHi);
            if (fingerprintIds(myItems) === fps[i])
                continue; // range agrees
            if (myItems.length <= threshold) {
                const m = { v: 2, t: "ids", from: me, ids: myItems };
                if (subLo !== undefined)
                    m.lo = subLo;
                if (subHi !== undefined)
                    m.hi = subHi;
                step.replies.push(m);
            }
            else {
                step.replies.push(buildFp(me, myItems, subLo, subHi, buckets));
            }
        }
    }
    else if (msg.t === "ids") {
        const { lo, hi, ids } = msg;
        const peer = new Set(ids);
        const myItems = idsInRange(mine, lo, hi);
        const mineSet = new Set(myItems);
        for (const id of myItems)
            if (!peer.has(id))
                step.serve.push(byId.get(id)); // peer lacks it → serve
        const need = [...peer].filter((id) => !mineSet.has(id)); // I lack it → pull
        if (need.length)
            step.replies.push({ v: 2, t: "need", from: me, ids: need });
    }
    else if (msg.t === "need") {
        for (const id of msg.ids)
            if (byId.has(id))
                step.serve.push(byId.get(id));
    }
    return step;
}
