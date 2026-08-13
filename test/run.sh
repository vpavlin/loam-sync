#!/usr/bin/env bash
# C++ smoke/parity + TS convergence. Finds nlohmann/json in the nix store or system.
set -euo pipefail
cd "$(dirname "$0")/.."
NLO=$(find /nix/store -maxdepth 4 -path "*nlohmann/json.hpp" 2>/dev/null | head -1 || true)
INC=""; [ -n "$NLO" ] && INC="-I$(dirname "$(dirname "$NLO")")"
echo "== C++ smoke =="
c++ -std=c++17 $INC test/smoke.cpp -lcrypto -o /tmp/logos_sync_smoke && /tmp/logos_sync_smoke
echo "== TS convergence =="
node test/convergence.test.mjs
