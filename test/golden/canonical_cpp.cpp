#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
#include "../../basecamp/logos_sync/event.hpp"
#include "../../basecamp/logos_sync/signing.hpp"
using nlohmann::json;
int main(){
  std::ifstream f("test/golden/vectors.json"); json v; f >> v;
  std::string domain = v["domain"];
  for (auto& je : v["events"]) {
    logos_sync::Event e;
    e.type = je["type"]; e.id = je["id"];
    e.hlc.wall = je["hlc"]["wall"]; e.hlc.ctr = je["hlc"]["ctr"]; e.hlc.dev = je["hlc"]["dev"];
    e.payload = je["payload"];
    std::cout << logos_sync::canonicalMessage(domain, e) << "\n";
  }
}
