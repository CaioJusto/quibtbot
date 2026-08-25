#!/usr/bin/env bash
# Idempotent dependency + toolchain setup for Quibt Bot Cloud Agents.
# Runs after the repository is checked out. Must terminate and start no servers.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Node (repo requires >=22.19; the default image ships an older 22.x) -------
# The base image and the /exec-daemon shim expose Node 22.14, but a transitive
# dependency (undici) enforces >=22.19 under engine-strict. Install and, crucially,
# put the nvm Node *ahead* of any earlier `node` shim on PATH so `env node` (used by
# Vite's shebang) resolves to a version with TypeScript type-stripping.
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22.22.2 >/dev/null
nvm use 22.22.2 >/dev/null
export PATH="$(dirname "$(nvm which 22.22.2)"):$PATH"
corepack enable >/dev/null 2>&1 || true

# --- PostgreSQL 16 (required for the API/worker/auth; provider "computer" aside) -
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib
fi

# --- Workspace dependencies + generated Prisma client -------------------------
pnpm install --frozen-lockfile
pnpm db:generate

echo "install.sh: done (node $(node --version))"
