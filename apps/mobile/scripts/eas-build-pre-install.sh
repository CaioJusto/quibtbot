#!/usr/bin/env bash
set -euo pipefail

# O pod install do iOS exige a libssh2/OpenSSL modernas geradas pelo plugin
# with-modern-libssh2. O hook pre-install e o único hook EAS executado antes do
# prebuild e do CocoaPods; no Android não há artefato equivalente para preparar.
if [[ "${EAS_BUILD_PLATFORM:-}" == "ios" ]]; then
  "$(dirname "$0")/build-ios-libssh2.sh" iphoneos
fi
