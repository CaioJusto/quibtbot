#!/usr/bin/env bash
# Per-boot reconciliation: bring up Postgres, ensure the dev .env exists, and
# apply migrations. Must be idempotent and return (no long-running processes).
set -euo pipefail

cd "$(dirname "$0")/.."

# Select the required Node and put it ahead of any earlier `node` shim on PATH.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use 22.22.2 >/dev/null 2>&1 || nvm install 22.22.2 >/dev/null
export PATH="$(dirname "$(nvm which 22.22.2)"):$PATH"

# --- PostgreSQL cluster on 127.0.0.1:5433 (matches .env.example) --------------
sudo pg_conftool 16 main set port 5433 >/dev/null 2>&1 || true
if ! sudo pg_lsclusters -h 2>/dev/null | awk '{print $4}' | grep -q online; then
  sudo pg_ctlcluster 16 main start || true
fi

# Wait for Postgres to accept connections.
for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -p 5433 >/dev/null 2>&1; then break; fi
  sleep 1
done

# Ensure the quibt role + database exist.
if ! sudo -u postgres psql -p 5433 -tAc "SELECT 1 FROM pg_roles WHERE rolname='quibt'" | grep -q 1; then
  sudo -u postgres psql -p 5433 -c "CREATE ROLE quibt LOGIN PASSWORD 'quibt' CREATEDB;"
fi
if ! sudo -u postgres psql -p 5433 -tAc "SELECT 1 FROM pg_database WHERE datname='quibt'" | grep -q 1; then
  sudo -u postgres createdb -p 5433 -O quibt quibt
fi

# --- .env with real dev secrets (never overwrite an existing file) ------------
if [ ! -f .env ]; then
  cp .env.example .env
  secret="$(openssl rand -hex 32)"
  enckey="$(openssl rand -hex 32)"
  sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=${secret}|" .env
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${enckey}|" .env
fi

# --- Apply database migrations ------------------------------------------------
pnpm db:migrate

echo "start.sh: done"
