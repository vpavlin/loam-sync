import { Event } from "./event.js";
/** Union any number of logs by id (dedup), then sort by HLC. Pure. */
export declare function mergeEvents(...logs: Event[][]): Event[];
/** Merge one event into an already-merged log in place. Returns true if it was
 *  NEW (so the caller can skip re-persisting / re-broadcasting a duplicate). */
export declare function mergeOne(log: Event[], e: Event): boolean;
