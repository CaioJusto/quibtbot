#!/bin/sh
# Quibt Bot — instalar o servidor com um comando.
#
#   curl -fsSL https://raw.githubusercontent.com/CaioJusto/quibtbot/main/scripts/install.sh | sh
#
# Baixa o binário `quibtbot` da última release do GitHub para esta arquitetura, confere o
# SHA-256 publicado ao lado dele, coloca-o no PATH e roda `quibtbot install`. O binário
# leva o manifesto do compose dentro de si; o install detecta (ou instala, no Linux) o Docker,
# gera os segredos, sobe os serviços e imprime a URL e o código para o celular.
#
# Variáveis opcionais:
#   QUIBT_RELEASE   versão a baixar (padrão: latest)
#   QUIBT_BIN_DIR   onde deixar o binário (padrão: /usr/local/bin, ou ~/.local/bin sem permissão)
#   QUIBT_NO_RUN=1  só baixar; não rodar o install
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
curl -fsSL "$base/$asset" -o "$tmp/quibtbot"
curl -fsSL "$base/$asset.sha256" -o "$tmp/quibtbot.sha256"

expected=$(awk '{print $1}' "$tmp/quibtbot.sha256")
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
if [ -t 1 ]; then
  exec "$bin_dir/quibtbot" install
else
  exec "$bin_dir/quibtbot" install --non-interactive
fi
