#!/usr/bin/env bash
# Cross-language canonicalMessage parity gate (ADR 0017): TS signing.ts and C++
# signing.hpp MUST produce byte-identical canonical for every vector. CI runs this.
set -euo pipefail
cd "$(dirname "$0")/../.."
NJ=$(find /nix/store -maxdepth 5 -name json.hpp -path '*nlohmann*/include/nlohmann/*' 2>/dev/null | head -1); NJ=${NJ%/nlohmann/json.hpp}
SSL_INC=$(find /nix/store -maxdepth 5 -name opensslv.h -path '*include*' 2>/dev/null | head -1); SSL_INC=${SSL_INC%/openssl/opensslv.h}
SSL_LIB=$(ls -d /nix/store/*openssl*/lib 2>/dev/null | grep -v -- -dev | head -1)
node test/golden/canonical_ts.mjs > /tmp/lgs_ts.out
g++ -std=c++17 -w -I"$NJ" -I"$SSL_INC" test/golden/canonical_cpp.cpp -o /tmp/lgs_cpp -L"$SSL_LIB" -lcrypto
LD_LIBRARY_PATH="$SSL_LIB" /tmp/lgs_cpp > /tmp/lgs_cpp.out
if diff -u /tmp/lgs_ts.out /tmp/lgs_cpp.out; then echo "✅ canonicalMessage TS==C++ (byte-identical)"; else echo "❌ PARITY BROKEN"; exit 1; fi

# ── delegation-cert cross-language round-trip (ADR 0017) ──────────────────────
rm -f /tmp/ts_cert.json /tmp/cpp_cert.json
node test/golden/cert_ts.mjs >/dev/null                       # TS issues -> /tmp/ts_cert.json
g++ -std=c++17 -w -I"$NJ" -I"$SSL_INC" test/golden/cert_cpp.cpp -o /tmp/lgs_certcpp -L"$SSL_LIB" -lcrypto
CPPV=$(LD_LIBRARY_PATH="$SSL_LIB" /tmp/lgs_certcpp)           # C++ verifies TS cert + issues its own
TSV=$(node test/golden/cert_ts.mjs | grep "verifyCert(C++-issued)")
echo "$CPPV" | grep -q "verifyCert(TS-issued): true" \
  && echo "$CPPV" | grep -q "tampered scope): false" \
  && echo "$TSV"  | grep -q "true" \
  && echo "✅ delegation cert TS<->C++ round-trip (issue+verify+tamper-reject)" \
  || { echo "❌ CERT PARITY BROKEN"; echo "$CPPV"; echo "$TSV"; exit 1; }

# ── shared AEAD envelope: cross-language seal parity + deterministic nonce (ADR 0011) ──
rm -f /tmp/ts_sealed.hex /tmp/cpp_sealed.hex
node test/golden/crypto_ts.mjs > /tmp/lgs_tsz.hex 2>/dev/null
g++ -std=c++17 -w -I"$SSL_INC" test/golden/crypto_cpp.cpp -o /tmp/lgs_cz -L"$SSL_LIB" -lcrypto
LD_LIBRARY_PATH="$SSL_LIB" /tmp/lgs_cz > /tmp/lgs_cz.hex 2>/tmp/lgs_cz.err
diff /tmp/lgs_tsz.hex /tmp/lgs_cz.hex >/dev/null \
  && grep -q "C++-opens-TS: true" /tmp/lgs_cz.err \
  && node test/golden/crypto_ts.mjs 2>&1 >/dev/null | grep -q "TS-opens-C++: true" \
  && echo "✅ AEAD seal TS==C++ (byte-identical, deterministic nonce) + cross-open" \
  || { echo "❌ CRYPTO PARITY BROKEN"; exit 1; }
