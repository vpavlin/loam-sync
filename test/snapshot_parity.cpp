// snapshot_parity.cpp — cross-language parity for log snapshots (docs/adr/0020).
// Folds the SAME frozen log (test/golden/snapshot.json, produced by the TS side) through the C++
// selectCut → serializeSnapshot and asserts the bytes are IDENTICAL to the TS output — the property
// that makes a C++ writer and a TS writer of the same cut hash to the same Storage CID. Also checks
// the deterministic seal round-trips. Self-contained (does not depend on the signing golden).
// Compile: see test/run.sh.
#include "../basecamp/logos_sync/snapshot.hpp"
#include <fstream>
#include <cstdio>
#include <cassert>
using namespace logos_sync;

int main() {
    std::ifstream f("test/golden/snapshot.json");
    assert(f && "cannot open test/golden/snapshot.json (run: node test/gen-snapshot-vectors.mjs)");
    json G; f >> G;

    std::vector<Event> log;
    for (const auto& je : G.at("log")) log.push_back(eventFromJson(je));

    long long boundary = snapshot::epochBoundary(G.at("now").get<long long>(), G.at("epochSizeMs").get<long long>());
    assert(boundary == G.at("boundary").get<long long>() && "epochBoundary must match TS");

    auto cut = snapshot::selectCut(log, boundary);
    std::vector<std::string> ids; for (auto& e : cut) ids.push_back(e.id);
    std::vector<std::string> want; for (auto& s : G.at("cutIds")) want.push_back(s.get<std::string>());
    assert(ids == want && "selectCut must match TS");

    std::string ser = snapshot::serializeSnapshot(cut, snapshot::boundaryHlc(boundary));
    if (ser != G.at("serialized").get<std::string>()) {
        printf("MISMATCH\n C++: %s\n TS : %s\n", ser.c_str(), G.at("serialized").get<std::string>().c_str());
        return 1;
    }

    // Deterministic seal round-trips (open(seal(x)) == x) with the household det-nonce.
    crypto::Identity kid = crypto::deriveIdentity(Bytes(32, 7), "snaptest");
    auto sealed = snapshot::cryptoSealSnapshot(kid, "snaptest", ser);
    assert(snapshot::cryptoOpenSnapshot(kid, "snaptest", sealed) == ser && "seal round-trip");

    // parseSnapshot round-trips the header + count.
    auto parsed = snapshot::parseSnapshot(ser);
    assert(parsed.count == (long long)cut.size() && parsed.events.size() == cut.size());

    printf("snapshot parity: C++ serializeSnapshot == TS (%zu B, cut=%zu) OK  seal RT OK  parse OK\n", ser.size(), cut.size());
    return 0;
}
