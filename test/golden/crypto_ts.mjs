import * as L from "../../src/crypto.ts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const S = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const id = L.deriveIdentity(S, "kym"); const t = L.topicFor(id, "kym");
const pt = new TextEncoder().encode("hello loam-sync ✦ deterministic");
const sealed = L.seal(id, "kym", "evt-123", pt, t);
writeFileSync("/tmp/ts_sealed.hex", Buffer.from(sealed).toString("hex"));
console.log(Buffer.from(sealed).toString("hex"));
if (existsSync("/tmp/cpp_sealed.hex")) {
  const b = Uint8Array.from(Buffer.from(readFileSync("/tmp/cpp_sealed.hex","utf8").trim(),"hex"));
  console.error("TS-opens-C++: " + (new TextDecoder().decode(L.open(id, b, t)) === "hello loam-sync ✦ deterministic"));
}
