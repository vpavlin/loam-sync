#pragma once
// logos_sync.hpp — umbrella include for the C++ (Basecamp core) side of logos-sync.
//
//   #include <logos_sync.hpp>
//
// gives you the whole sync spine: the event envelope + HLC (event.hpp), the CRDT
// merge (merge.hpp), Range-Based Set Reconciliation (reconcile.hpp), and the
// catch-up protocol (catchup.hpp). What stays YOURS: the event `type`/`payload`
// schemas, the fold from log → state, and seal/open crypto (docs/adr/0006-0007).
//
// Header-only; depends on nlohmann/json and OpenSSL (libcrypto, for the RBSR
// fingerprint). See basecamp/README.md for the integration recipe.
#include "logos_sync/event.hpp"
#include "logos_sync/merge.hpp"
#include "logos_sync/reconcile.hpp"
#include "logos_sync/catchup.hpp"
