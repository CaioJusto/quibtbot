#!/bin/sh
# Quibt Bot — instalar o servidor com um comando.
#
#   curl -fsSL https://raw.githubusercontent.com/CaioJusto/quibtbot/main/scripts/install.sh | sh
#
# Baixa o binário `quibtbot` da última release do GitHub para esta arquitetura, confere o
# SHA-256 do manifesto autenticado pelo metadata da release, coloca-o no PATH e roda
# `quibtbot install`. O binário
# leva o manifesto do compose dentro de si; o install detecta (ou instala, no Linux) o Docker,
# gera os segredos, sobe os serviços e imprime a URL e o código para o celular.
#
# Variáveis opcionais:
#   QUIBT_RELEASE   versão a baixar (padrão: latest)
#   QUIBT_BIN_DIR   onde deixar o binário (padrão: /usr/local/bin, ou ~/.local/bin sem permissão)
#   QUIBT_NO_RUN=1  só baixar; não rodar o install
#   QUIBT_SHOW_SENSITIVE=1  mostra o código/QR no fluxo remoto autenticado
#   QUIBT_BASE_URL  de onde baixar (padrão: a release no GitHub; útil para fork ou espelho)
set -eu

REPO="CaioJusto/quibtbot"
RELEASE="${QUIBT_RELEASE:-latest}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) platform="linux" ;;
  Darwin) platform="darwin" ;;
  *) echo "quibtbot: este script cobre Linux e macOS. No Windows, baixe o instalador em https://quibt.com.br." >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) cpu="x64" ;;
  aarch64|arm64) cpu="arm64" ;;
  *) echo "quibtbot: arquitetura não suportada: $arch" >&2; exit 1 ;;
esac
asset="quibtbot-$platform-$cpu"
if [ "$platform" = "darwin" ] && [ "$cpu" = "x64" ]; then
  echo "quibtbot: no Mac com Intel use o app de desktop (https://quibt.com.br); o binário é só para Apple silicon." >&2
  exit 1
fi

if [ -n "${QUIBT_BASE_URL:-}" ]; then
  base="${QUIBT_BASE_URL%/}"
elif [ "$RELEASE" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/v$RELEASE"
fi
case "$base" in
  https://*) ;;
  *) echo "quibtbot: a origem do download precisa usar HTTPS." >&2; exit 1 ;;
esac

command -v curl >/dev/null 2>&1 || { echo "quibtbot: preciso do curl." >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Baixando $asset ($RELEASE)…"
if [ "$RELEASE" = "latest" ]; then
  release_api="https://api.github.com/repos/$REPO/releases/latest"
else
  release_api="https://api.github.com/repos/$REPO/releases/tags/v$RELEASE"
fi
curl -fsSL -H "Accept: application/vnd.github+json" "$release_api" -o "$tmp/release.json"
tag=$(sed -n 's/^[[:space:]]*"tag_name": "\([^"]*\)",$/\1/p' "$tmp/release.json" | head -n 1)
printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || {
  echo "quibtbot: a API do GitHub não devolveu uma tag de release válida." >&2
  exit 1
}
if [ "$RELEASE" != "latest" ] && [ "$tag" != "v$RELEASE" ]; then
  echo "quibtbot: a release resolvida ($tag) não é a versão pedida (v$RELEASE)." >&2
  exit 1
fi
release_version=${tag#v}
checksums_asset="checksums-$release_version.txt"

asset_digest() {
  awk -v wanted="$1" '
    /^[[:space:]]*"name":/ {
      current=$0
      sub(/^[[:space:]]*"name": "/, "", current)
      sub(/".*$/, "", current)
    }
    current == wanted && /^[[:space:]]*"digest": "sha256:/ {
      digest=$0
      sub(/^.*"digest": "sha256:/, "", digest)
      sub(/".*$/, "", digest)
      print digest
      exit
    }
  ' "$tmp/release.json"
}

manifest_digest=$(asset_digest "$checksums_asset")
api_asset_digest=$(asset_digest "$asset")
if [ -z "$manifest_digest" ] || [ -z "$api_asset_digest" ]; then
  echo "quibtbot: a release não publicou o manifesto ou o binário esperado." >&2
  exit 1
fi
curl -fsSL "https://github.com/$REPO/releases/download/$tag/$checksums_asset" -o "$tmp/checksums.txt"
if command -v sha256sum >/dev/null 2>&1; then
  manifest_actual=$(sha256sum "$tmp/checksums.txt" | awk '{print $1}')
else
  manifest_actual=$(shasum -a 256 "$tmp/checksums.txt" | awk '{print $1}')
fi
if [ "$manifest_actual" != "$manifest_digest" ]; then
  echo "quibtbot: o manifesto de checksums não bate com o metadata imutável do GitHub." >&2
  exit 1
fi

curl -fsSL "$base/$asset" -o "$tmp/quibtbot"
expected=$(awk -v wanted="$asset" '$2 == wanted || $2 == "*" wanted { print $1; exit }' "$tmp/checksums.txt")
if [ -z "$expected" ] || [ "$expected" != "$api_asset_digest" ]; then
  echo "quibtbot: o binário não confere entre o manifesto e o metadata da release." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/quibtbot" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/quibtbot" | awk '{print $1}')
fi
if [ "$actual" != "$expected" ]; then
  echo "quibtbot: o SHA-256 do download não bate com o publicado. Abortando." >&2
  exit 1
fi
chmod +x "$tmp/quibtbot"

bin_dir="${QUIBT_BIN_DIR:-}"
if [ -z "$bin_dir" ]; then
  if [ -w /usr/local/bin ]; then
    bin_dir=/usr/local/bin
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    bin_dir=/usr/local/bin
    sudo install -m 0755 "$tmp/quibtbot" "$bin_dir/quibtbot"
  else
    bin_dir="$HOME/.local/bin"
  fi
fi
if [ ! -f "$bin_dir/quibtbot" ] || [ "$bin_dir/quibtbot" -ot "$tmp/quibtbot" ]; then
  mkdir -p "$bin_dir"
  install -m 0755 "$tmp/quibtbot" "$bin_dir/quibtbot"
fi
echo "quibtbot instalado em $bin_dir/quibtbot"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Aviso: $bin_dir não está no PATH. Use $bin_dir/quibtbot ou adicione a pasta ao PATH." ;;
esac

if [ "${QUIBT_NO_RUN:-0}" = "1" ]; then
  exit 0
fi

# Credenciais de pareamento nunca vão automaticamente para logs de CI/provedor. Fluxos
# remotos autenticados precisam pedir --show-sensitive explicitamente e limpar a saída.
if [ "${QUIBT_SHOW_SENSITIVE:-0}" = "1" ]; then
  exec "$bin_dir/quibtbot" install --non-interactive --show-sensitive
elif [ -t 1 ]; then
  exec "$bin_dir/quibtbot" install
else
  exec "$bin_dir/quibtbot" install --non-interactive
fi
