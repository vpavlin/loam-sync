#include "../../basecamp/logos_sync/crypto.hpp"
#include <fstream>
#include <iostream>
using namespace logos_sync::crypto;
int main(){
  Bytes S; for(int i=1;i<=32;i++) S.push_back((unsigned char)i);
  Identity id = deriveIdentity(S,"kym"); std::string t = topicFor(id,"kym");
  Bytes pt = sbytes("hello loam-sync \xE2\x9C\xA6 deterministic");
  Bytes sealed = seal(id,"kym","evt-123",pt,t);
  std::string h = hexs(sealed); std::ofstream("/tmp/cpp_sealed.hex")<<h; std::cout<<h<<"\n";
  std::ifstream f("/tmp/ts_sealed.hex"); std::string th; f>>th;
  if(!th.empty()){ Bytes tb; for(size_t i=0;i+1<th.size();i+=2) tb.push_back((unsigned char)std::stoi(th.substr(i,2),nullptr,16));
    Bytes o=open(id,tb,t); std::cerr<<"C++-opens-TS: "<<(std::string(o.begin(),o.end())=="hello loam-sync \xE2\x9C\xA6 deterministic"?"true":"false")<<"\n"; }
}
