#!/usr/bin/env bash
# Constrói libssh2 + OpenSSL estáticos para iOS.
#
# Por que isto existe: o app usa o NMSSH (pod 2.3.1, de 2018), que embute a libssh2
# 1.8.0. Aquela libssh2 só conhece chaves de host `ssh-rsa` (SHA-1) e `ssh-dss`, as
# duas aposentadas por padrão no OpenSSH 8.8+. Contra um Ubuntu 22.04, que oferece
# rsa-sha2-512/256, ecdsa-sha2-nistp256 e ssh-ed25519, não sobra algoritmo em comum:
# o aperto de mão morre antes de qualquer senha, e a instalação por SSH no iPhone
# nunca conecta. O plugin `with-modern-libssh2` faz o Xcode usar o que sai daqui.
#
# Uso: apps/mobile/scripts/build-ios-libssh2.sh [iphoneos|iphonesimulator]
# Sem argumento, constrói os dois. A saída fica em apps/mobile/ios-libssh2/<sdk>/.
set -euo pipefail

OPENSSL_VERSION="3.5.4"
OPENSSL_SHA256="967311f84955316969bdb1d8d4b983718ef42338639c621ec4c34fddef355e99"
LIBSSH2_VERSION="1.11.1"
LIBSSH2_SHA256="d9ec76cbe34db98eec3539fe2c899d26b0c837cb3eb466a56b0f109cabf658f7"
IOS_MIN="15.1"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_root="$here/ios-libssh2"
work="$out_root/.work"
mkdir -p "$work"

fetch() {
  local url="$1" file="$2" expected="$3"
  if [[ ! -f "$work/$file" ]]; then
    curl -fsSL --retry 3 -o "$work/$file.part" "$url"
    mv "$work/$file.part" "$work/$file"
  fi
  local actual
  actual="$(shasum -a 256 "$work/$file" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "checksum de $file não confere: $actual" >&2
    exit 1
  fi
}

build_one() {
  local sdk="$1"
  local prefix="$out_root/$sdk"
  local build="$work/$sdk"
  rm -rf "$build"
  mkdir -p "$prefix" "$build"

  local sysroot
  sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  local min_flag="-mios-version-min=$IOS_MIN"
  local openssl_target="ios64-cross"
  if [[ "$sdk" == "iphonesimulator" ]]; then
    min_flag="-mios-simulator-version-min=$IOS_MIN"
    openssl_target="iossimulator-arm64-xcrun"
  fi

  # OpenSSL leva minutos e quase nunca muda; reaproveita o que já está no prefixo.
  if [[ -f "$prefix/lib/libcrypto.a" && -f "$prefix/lib/libssl.a" ]]; then
    echo "==> OpenSSL $OPENSSL_VERSION ($sdk) já construído"
  else
  echo "==> OpenSSL $OPENSSL_VERSION ($sdk)"
  tar -xzf "$work/openssl-$OPENSSL_VERSION.tar.gz" -C "$build"
  (
    cd "$build/openssl-$OPENSSL_VERSION"
    CC="$(xcrun --sdk "$sdk" --find clang)" \
    CFLAGS="-arch arm64 -isysroot $sysroot $min_flag -fembed-bitcode-marker" \
      ./Configure "$openssl_target" no-shared no-tests no-apps no-docs \
        --prefix="$prefix" --openssldir="$prefix/ssl" >/dev/null
    make -j"$(sysctl -n hw.ncpu)" build_libs >/dev/null
    make install_dev >/dev/null
  )
  fi

  echo "==> libssh2 $LIBSSH2_VERSION ($sdk)"
  tar -xzf "$work/libssh2-$LIBSSH2_VERSION.tar.gz" -C "$build"
  (
    cd "$build/libssh2-$LIBSSH2_VERSION"
    cmake -S . -B build \
      -DCMAKE_SYSTEM_NAME=iOS \
      -DCMAKE_OSX_ARCHITECTURES=arm64 \
      -DCMAKE_OSX_SYSROOT="$sysroot" \
      -DCMAKE_OSX_DEPLOYMENT_TARGET="$IOS_MIN" \
      -DCMAKE_INSTALL_PREFIX="$prefix" \
      -DCRYPTO_BACKEND=OpenSSL \
      -DOPENSSL_ROOT_DIR="$prefix" \
      -DOPENSSL_USE_STATIC_LIBS=ON \
      -DOPENSSL_INCLUDE_DIR="$prefix/include" \
      -DOPENSSL_CRYPTO_LIBRARY="$prefix/lib/libcrypto.a" \
      -DOPENSSL_SSL_LIBRARY="$prefix/lib/libssl.a" \
      -DCMAKE_FIND_ROOT_PATH="$prefix" \
      -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH \
      -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
      -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_EXAMPLES=OFF \
      -DBUILD_TESTING=OFF \
      -DENABLE_ZLIB_COMPRESSION=OFF \
      -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build build --config Release -j"$(sysctl -n hw.ncpu)" >/dev/null
    cmake --install build >/dev/null
  )

  # O Xcode procura por -lssh2 -lssl -lcrypto num único diretório; o cmake do libssh2
  # instala em lib/ com o mesmo nome, então só conferimos que os três estão lá.
  local lib="$prefix/lib"
  for name in libssh2.a libssl.a libcrypto.a; do
    [[ -f "$lib/$name" ]] || { echo "faltou $name em $lib" >&2; exit 1; }
  done

  echo "==> algoritmos de chave de host em $sdk:"
  strings "$lib/libssh2.a" | grep -E '^(ssh-rsa|ssh-dss|ssh-ed25519|ecdsa-sha2-nistp[0-9]+|rsa-sha2-[0-9]+)$' | sort -u | sed 's/^/    /'
}

fetch "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" \
  "openssl-$OPENSSL_VERSION.tar.gz" "$OPENSSL_SHA256"
fetch "https://www.libssh2.org/download/libssh2-$LIBSSH2_VERSION.tar.gz" \
  "libssh2-$LIBSSH2_VERSION.tar.gz" "$LIBSSH2_SHA256"

for sdk in "${@:-iphoneos iphonesimulator}"; do
  build_one "$sdk"
done

echo "pronto: $out_root"
