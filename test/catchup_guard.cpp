// Malformed catch-up frames from a peer are ignored by catchup::respond, never thrown on.
// Before frameWellFormed(), a numeric id threw and a missing "bounds" was an assertion abort,
// either of which kills a Basecamp core module. A well-formed exchange still converges.
#include "../basecamp/logos_sync.hpp"
#include <cstdio>
#include <cassert>
using namespace logos_sync;

static Event ev(const std::string& id) { Event e; e.id = id; e.type = "x"; e.hlc = {1, 0, "d"}; e.dev = "d"; return e; }

int main() {
    std::vector<Event> mine{ev("a"), ev("b"), ev("c")};
    const char* bad[] = {
        R"({"t":"ids","ids":[5]})",                    // id not a string (threw)
        R"({"t":"fp","fps":["x","y"]})",               // no bounds (assertion abort)
        R"({"t":"fp","fps":["x","y"],"bounds":[]})",    // too few bounds (out of range)
        R"({"t":"fp","fps":[1],"bounds":[]})",         // fp not a string
        R"({"t":"need","ids":"abc"})",                 // ids not an array
        R"({"t":"need"})",                             // no ids
        R"({"t":5})", R"({"t":"ids","ids":["a"],"lo":3})", R"({"t":"ids","ids":["a"],"from":[1]})",
        R"("just a string")", R"([1,2,3])", R"(null)",
    };
    for (const char* b : bad) {
        auto s = catchup::respond(mine, json::parse(b), "B");
        assert(s.replies.empty() && s.serve.empty());
    }
    printf("malformed catch-up frames: %zu ignored, none thrown\n", sizeof(bad) / sizeof(bad[0]));

    // well-formed frames still work: a peer that has nothing asks, we serve all three
    auto init = catchup::buildInitial({}, "A");
    auto s1 = catchup::respond(mine, init, "B");
    size_t served = s1.serve.size();
    for (auto& r : s1.replies) { auto s2 = catchup::respond({}, r, "A"); for (auto& n : s2.replies) served += catchup::respond(mine, n, "B").serve.size(); }
    assert(served == 3);
    auto need = catchup::respond(mine, json::parse(R"({"v":2,"t":"need","from":"A","ids":["a","zz"]})"), "B");
    assert(need.serve.size() == 1 && need.serve[0].id == "a");
    printf("well-formed catch-up: fresh peer gets all %zu events, need serves what we have\n", served);
    printf("catchup guard: ALL PASS\n");
    return 0;
}
