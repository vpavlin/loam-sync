#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
#include "../../basecamp/logos_sync/event.hpp"
#include "../../basecamp/logos_sync/signing.hpp"
using nlohmann::json; using namespace logos_sync;
int main(){
  std::ifstream f("/tmp/ts_cert.json"); json j; f >> j;
  DelegationCert c; certFromJson(j, c);
  std::cout << "C++ verifyCert(TS-issued): " << (verifyCert("test", c, 9999999999999LL) ? "true":"false") << "\n";
  std::cout << "C++ verifyCert(TS, tampered scope): "; c.scope="evil"; std::cout << (verifyCert("test", c, 9999999999999LL)?"true":"false") << "\n";
  // issue a C++ cert with the same idPriv
  SoftwareSigner s(fromHexB("0101010101010101010101010101010101010101010101010101010101010101"));
  DelegationCert mine = issueCert(s, "test", "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 0, 5, "cal-1");
  std::ofstream o("/tmp/cpp_cert.json"); o << certToJson(mine).dump();
  std::cout << "C++ issued cert idPub " << mine.idPub.substr(0,12) << "\n";
}
