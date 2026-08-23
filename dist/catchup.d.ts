import { Event } from "./event.js";
interface FpMsg {
    v: 2;
    t: "fp";
    from: string;
    lo?: string;
    hi?: string;
    bounds: string[];
    fps: string[];
}
interface IdsMsg {
    v: 2;
    t: "ids";
    from: string;
    lo?: string;
    hi?: string;
    ids: string[];
}
interface NeedMsg {
    v: 2;
    t: "need";
    from: string;
    ids: string[];
}
export type CatchupMsg = FpMsg | IdsMsg | NeedMsg;
/** The initial message a joining/reconnecting peer publishes. */
export declare function buildInitial(myEvents: Event[], from: string, buckets?: number): FpMsg;
export interface Step {
    replies: CatchupMsg[];
    serve: Event[];
}
/** Pure state-machine step: process one incoming message against my set. */
export declare function respond(myEvents: Event[], msg: CatchupMsg, me: string, threshold?: number, buckets?: number): Step;
export {};
