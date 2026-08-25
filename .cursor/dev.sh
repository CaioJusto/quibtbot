#!/usr/bin/env bash
# Long-running dev stack: API (:3100), Graphile worker, Vite web (:5173), and
# the sandbox supervisor (:7091). Kept in a visible terminal for logs/restarts.
set -euo pipefail

cd "$(dirname "$0")/.."

# Select the required Node and put it ahead of any earlier `node` shim on PATH so
# `env node` (Vite's shebang) resolves to a version that strips TypeScript.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use 22.22.2 >/dev/null 2>&1 || nvm install 22.22.2 >/dev/null
export PATH="$(dirname "$(nvm which 22.22.2)"):$PATH"

# Safety net: if the boot-time `start` phase has not run yet (Postgres down or
# migrations not applied), reconcile now so the stack can serve requests.
if ! sudo -u postgres pg_isready -p 5433 >/dev/null 2>&1; then
  bash .cursor/start.sh
fi

exec pnpm dev
