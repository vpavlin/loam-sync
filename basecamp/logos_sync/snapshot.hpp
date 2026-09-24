#pragma once
// snapshot.hpp — deterministic log snapshots to content-addressed Storage (docs/adr/0020).
// C++ mirror of src/snapshot.ts. serializeSnapshot() is BYTE-IDENTICAL to the TS side (same cjson +
// eventToJson), so a C++ writer and a TS writer of the SAME cut produce the SAME sealed bytes → the
// SAME Storage CID. See the TS module + ADR 0020 for the rationale (RBSR stays the guarantee; a
// snapshot is an accelerator; the reader re-verifies every signature).
//
// Sealing + Storage are SEAMS the caller provides (mirroring the TS Sealer/Storage injection): seal
// with crypto::seal using a plaintext-derived nonce (see cryptoSealSnapshot), upload the sealed bytes
// to your content-addressed store. This header owns only the deterministic, parity-critical core:
// the epoch cut, the canonical serialization, and its inverse.
#include "event.hpp"
#include "signing.hpp" // cjson, sha256b, toHexS
#include "crypto.hpp"  // crypto::Identity, seal, open
#include <string>
#include <vector>
#include <stdexcept>

namespace logos_sync {
namespace snapshot {

/** The snapshot-epoch grid: the latest boundary at or before nowMs. Snapshotters target a COMPLETED
 *  (past) epoch so RBSR has converged up to it and independent writers agree on the cut → the CID.
 *  Matches TS Math.floor(now/E)*E (nowMs is a positive wall clock, so integer division == floor). */
inline long long epochBoundary(long long nowMs, long long epochSizeMs) {
    if (epochSizeMs <= 0) throw std::runtime_error("epochSizeMs must be > 0");
    return (nowMs / epochSizeMs) * epochSizeMs;
}

/** The exclusive HLC upper bound for a wall-clock boundary — the minimal HLC at boundaryMs. */
inline HLC boundaryHlc(long long boundaryMs) { return HLC{boundaryMs, 0, std::string()}; }

/** The events of a cut, in canonical (HLC, then id) order: exactly those with HLC strictly before
 *  the boundary — the same set on every replica that holds them. */
inline std::vector<Event> selectCut(const std::vector<Event>& log, long long boundaryMs) {
    HLC bound = boundaryHlc(boundaryMs);
    std::vector<Event> out;
    for (const auto& e : log)
        if (!e.id.empty() && compareHlc(e.hlc, bound) < 0) out.push_back(e);
    std::sort(out.begin(), out.end(), [](const Event& a, const Event& b) {
        int c = compareHlc(a.hlc, b.hlc);
        return c != 0 ? c < 0 : a.id < b.id;
    });
    return out;
}

/** Canonical, deterministic serialization of a cut → a JSON string (UTF-8 bytes are the blob
 *  plaintext). Byte-identical to the TS serializeSnapshot: cjson({v,coversUpToHlc,count,events}),
 *  events via eventToJson (carry pub/sig), no writer identity/timestamp in the bytes. */
inline std::string serializeSnapshot(const std::vector<Event>& events, const HLC& coversUpToHlc) {
    json arr = json::array();
    for (const auto& e : events) arr.push_back(eventToJson(e));
    json o{
        {"v", 1},
        {"coversUpToHlc", {{"wall", coversUpToHlc.wall}, {"ctr", coversUpToHlc.ctr}, {"dev", coversUpToHlc.dev}}},
        {"count", (long long)events.size()},
        {"events", arr},
    };
    return cjson(o);
}

struct ParsedSnapshot { int v; HLC coversUpToHlc; long long count; std::vector<Event> events; };

/** Inverse of serializeSnapshot (the bytes are valid JSON). Does NOT verify — the caller must
 *  verifyEvent() every event before folding (a bad snapshotter can include forged events). */
inline ParsedSnapshot parseSnapshot(const std::string& jsonText) {
    json o = json::parse(jsonText);
    ParsedSnapshot p;
    p.v = o.value("v", 1);
    if (o.contains("coversUpToHlc") && o["coversUpToHlc"].is_object()) {
        p.coversUpToHlc.wall = o["coversUpToHlc"].value("wall", 0LL);
        p.coversUpToHlc.ctr = o["coversUpToHlc"].value("ctr", 0LL);
        p.coversUpToHlc.dev = o["coversUpToHlc"].value("dev", std::string());
    }
    p.count = o.value("count", 0LL);
    if (o.contains("events") && o["events"].is_array())
        for (const auto& je : o["events"]) p.events.push_back(eventFromJson(je));
    return p;
}

/** Deterministic sealed blob for a serialized snapshot, over the household key: the nonce is derived
 *  from a hash of the plaintext (aad = "<domain>/snapshot/v1"), so identical plaintext ⇒ identical
 *  ciphertext ⇒ identical CID, while distinct snapshots get distinct nonces (no reuse). Mirror of the
 *  TS cryptoSealer. Upload the returned bytes to your content-addressed store. */
inline crypto::Bytes cryptoSealSnapshot(const crypto::Identity& id, const std::string& domain, const std::string& plaintext) {
    crypto::Bytes pt(plaintext.begin(), plaintext.end());
    std::string contentId = toHexS(sha256b(pt).data(), 32);
    return crypto::seal(id, domain, contentId, pt, domain + "/snapshot/v1");
}

/** Inverse of cryptoSealSnapshot: open the sealed blob back to the serialized JSON string. */
inline std::string cryptoOpenSnapshot(const crypto::Identity& id, const std::string& domain, const crypto::Bytes& sealed) {
    crypto::Bytes pt = crypto::open(id, sealed, domain + "/snapshot/v1");
    return std::string(pt.begin(), pt.end());
}

} // namespace snapshot
} // namespace logos_sync
