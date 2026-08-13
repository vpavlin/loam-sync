// Smoke + self-check for the C++ side: merge is idempotent/commutative, reconcile
// finds the exact diff, catch-up serves only the complement. Exit non-zero on any
// failed assertion. Compile: see test/run.sh.
#include "../basecamp/logos_sync.hpp"
#include <cstdio>
#include <cassert>
using namespace logos_sync;

static Event ev(const std::string& id, long long wall, const std::string& dev) {
    Event e; e.id = id; e.type = "t"; e.hlc = HLC{wall, 0, dev}; e.dev = dev;
    e.payload = json::object(); return e;
}

int main() {
    // ---- merge: idempotent + commutative ----
    std::vector<Event> a{ev("b", 2, "d1"), ev("a", 1, "d1")};
    std::vector<Event> b{ev("a", 1, "d1"), ev("c", 3, "d2")};
    auto m1 = mergeEvents(a, b);
    auto m2 = mergeEvents(b, a);
    assert(m1.size() == 3);                              // union, dedup by id
    assert(m1.size() == m2.size());
    for (size_t i = 0; i < m1.size(); i++) assert(m1[i].id == m2[i].id);  // order-independent
    assert(m1[0].id == "a" && m1[1].id == "b" && m1[2].id == "c");        // HLC-ordered
    auto again = mergeEvents(m1, m1);
    assert(again.size() == 3);                           // idempotent

    // ---- reconcile: exact symmetric difference ----
    // A has {a,b}; B has {a,c}. A needs c; B needs b.
    auto diff = rbsr::reconcile(rbsr::toItems(a), rbsr::toItems(b));
    assert(diff.aNeeds.size() == 1 && diff.aNeeds[0] == "c");
    assert(diff.bNeeds.size() == 1 && diff.bNeeds[0] == "b");
    // identical sets → empty diff
    auto same = rbsr::reconcile(rbsr::toItems(m1), rbsr::toItems(m1));
    assert(same.aNeeds.empty() && same.bNeeds.empty());

    // ---- catch-up v2: recursive RBSR converges two peers via message passing ----
    // Simulate the on-wire exchange between peer A and peer B over a broadcast
    // channel until quiescent, then assert BOTH hold the union — and that every
    // message stayed tiny (single-segment) even for a large log.
    auto converge = [](std::vector<Event> A, std::vector<Event> B) {
        size_t maxMsgBytes = 0;
        std::vector<json> toB{ catchup::buildInitial(A, "A") };
        std::vector<json> toA;
        for (auto& m : toB) maxMsgBytes = std::max(maxMsgBytes, m.dump().size());
        for (int round = 0; round < 64 && (!toA.empty() || !toB.empty()); round++) {
            std::vector<json> nA, nB;
            for (auto& m : toB) {                          // messages addressed to B
                auto s = catchup::respond(B, m, "B");
                for (auto& e : s.serve) mergeOne(A, e);     // B broadcasts → A receives
                for (auto& r : s.replies) { nA.push_back(r); maxMsgBytes = std::max(maxMsgBytes, r.dump().size()); }
            }
            for (auto& m : toA) {                          // messages addressed to A
                auto s = catchup::respond(A, m, "A");
                for (auto& e : s.serve) mergeOne(B, e);     // A broadcasts → B receives
                for (auto& r : s.replies) { nB.push_back(r); maxMsgBytes = std::max(maxMsgBytes, r.dump().size()); }
            }
            toA = nA; toB = nB;
        }
        std::set<std::string> ia, ib;
        for (auto& e : A) ia.insert(e.id);
        for (auto& e : B) ib.insert(e.id);
        return std::make_tuple(ia, ib, maxMsgBytes);
    };

    // 1) fresh peer (empty) vs a peer with {a,b,c}
    {
        auto [ia, ib, mb] = converge({}, m1);
        assert(ia.size() == 3 && ib.size() == 3 && ia == ib);   // both hold the union
        printf("v2 fresh-join: both converged to %zu events, max msg %zu B\n", ia.size(), mb);
    }
    // 2) two partially-overlapping peers, LARGE log — check convergence AND that no
    //    message ever segments (stays well under a Waku segment ~a few hundred B).
    {
        std::vector<Event> A, B;
        for (int i = 0; i < 200; i++) { char id[8]; snprintf(id, 8, "e%03d", i); A.push_back(ev(id, i, "dA")); }
        B = A;                                    // start equal…
        A.push_back(ev("x-late", 1, "dA"));       // …A authored 2 offline
        A.push_back(ev("y-late", 2, "dA"));
        B.push_back(ev("z-late", 3, "dB"));       // …B authored 1 offline
        auto [ia, ib, mb] = converge(A, B);
        assert(ia.size() == 203 && ib.size() == 203 && ia == ib);   // exact 3-way delta
        assert(mb < 900);                                            // every message single-segment
        printf("v2 large+behind: 200-event logs converged to %zu (delta=3), max msg %zu B\n", ia.size(), mb);
    }

    // ---- fingerprint determinism (parity anchor) ----
    auto fpA = rbsr::fingerprint(rbsr::toItems(a));
    auto fpA2 = rbsr::fingerprint(rbsr::toItems(std::vector<Event>{a[1], a[0]}));  // reordered input
    assert(fpA == fpA2);                                 // order-independent
    printf("fingerprint({a,b}) = %s\n", fpA.c_str());

    printf("C++ smoke: ALL PASS\n");
    return 0;
}
