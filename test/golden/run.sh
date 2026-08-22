#!/usr/bin/env bash
# Cross-language canonicalMessage parity gate (ADR 0017): TS signing.ts and C++
# signing.hpp MUST produce byte-identical canonical for every vector. CI runs this.
set -euo pipefail
cd "$(dirname "$0")/../.."
NJ=$(dirname "$(find /nix/store -maxdepth 3 -name json.hpp -path '*nlohmann*' 2>/dev/null | head -1)")/..
SSL_INC=$(find /nix/store -maxdepth 2 -name opensslv.h -path '*include*' 2>/dev/null | head -1); SSL_INC=${SSL_INC%/openssl/opensslv.h}
SSL_LIB=$(ls -d /nix/store/*openssl*/lib 2>/dev/null | grep -v -- -dev | head -1)
node test/golden/canonical_ts.mjs > /tmp/lgs_ts.out
g++ -std=c++17 -w -I"$NJ" -I"$SSL_INC" test/golden/canonical_cpp.cpp -o /tmp/lgs_cpp -L"$SSL_LIB" -lcrypto
LD_LIBRARY_PATH="$SSL_LIB" /tmp/lgs_cpp > /tmp/lgs_cpp.out
if diff -u /tmp/lgs_ts.out /tmp/lgs_cpp.out; then echo "✅ canonicalMessage TS==C++ (byte-identical)"; else echo "❌ PARITY BROKEN"; exit 1; fi
