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

    // ---- catch-up: serve only the complement, and detect what we lack ----
    // Server has the merged log {a,b,c}; requester has only {a} → server serves {b,c}
    // and notices nothing missing on its side.
    std::vector<Event> requesterHas{ev("a", 1, "d1")};
    auto req = catchup::buildRequest(requesterHas);
    auto ans = catchup::answerRequest(m1, req);
    assert(ans.serve.size() == 2);                       // b, c (not a)
    assert(ans.iLack.empty());
    // Fresh requester (empty) → whole log.
    auto fresh = catchup::answerRequest(m1, catchup::buildRequest({}));
    assert(fresh.serve.size() == 3);
    // Requester holds an id the server lacks → server should pull it.
    std::vector<Event> reqHasExtra{ev("a", 1, "d1"), ev("z", 9, "d3")};
    auto ans2 = catchup::answerRequest(m1, catchup::buildRequest(reqHasExtra));
    assert(ans2.iLack.size() == 1 && ans2.iLack[0] == "z");

    // ---- fingerprint determinism (parity anchor) ----
    auto fpA = rbsr::fingerprint(rbsr::toItems(a));
    auto fpA2 = rbsr::fingerprint(rbsr::toItems(std::vector<Event>{a[1], a[0]}));  // reordered input
    assert(fpA == fpA2);                                 // order-independent
    printf("fingerprint({a,b}) = %s\n", fpA.c_str());

    printf("C++ smoke: ALL PASS\n");
    return 0;
}
