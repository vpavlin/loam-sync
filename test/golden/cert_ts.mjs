import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { SoftwareSigner, issueCert, verifyCert } from "../../src/signing.ts";
const idPriv = Uint8Array.from(Buffer.from("0101010101010101010101010101010101010101010101010101010101010101","hex"));
const s = new SoftwareSigner(idPriv);
const cert = issueCert(s, "test", "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", { notAfter: 0, maxSigs: 5, scope: "cal-1" });
writeFileSync("/tmp/ts_cert.json", JSON.stringify(cert));
console.log("TS issued cert idPub", cert.idPub.slice(0,12), "idSig", cert.idSig.slice(0,12)+"…");
if (existsSync("/tmp/cpp_cert.json")) {
  const c = JSON.parse(readFileSync("/tmp/cpp_cert.json","utf8"));
  console.log("TS verifyCert(C++-issued):", verifyCert("test", c, Date.now()));
  console.log("TS verifyCert(C++, wrong domain):", verifyCert("bad", c, Date.now()));
}
