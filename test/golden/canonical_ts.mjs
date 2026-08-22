import { readFileSync } from "node:fs";
import { canonicalMessage } from "../../src/signing.ts";
const { domain, events } = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url)));
for (const e of events) process.stdout.write(canonicalMessage(domain, e) + "\n");
