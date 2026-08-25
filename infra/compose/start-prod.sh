#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV=production
export DATA_DIR="${DATA_DIR:-/data}"
export WEB_DIST="${WEB_DIST:-/app/apps/web/dist}"

# Hosted production fleet is Box (box.ascii.dev), one VM per bot.
# Never invent a key. Without BOX_API_KEY the API must not claim a live computer.
if [ -n "${BOX_API_KEY:-}" ]; then
  export SANDBOX_PROVIDER=box
elif [ "${SANDBOX_PROVIDER:-}" = "box" ]; then
  echo "BOX_API_KEY missing; falling back to SANDBOX_PROVIDER=fake. Computer/Take control will not work. Create a key at https://box.ascii.dev and paste BOX_API_KEY on the Railway app service." >&2
  export SANDBOX_PROVIDER=fake
fi

mkdir -p "${DATA_DIR}"

pnpm --filter @quibt/db generate
pnpm --filter @quibt/db exec prisma migrate deploy

pnpm --filter @quibt/worker start &
WORKER_PID=$!

term() {
  kill "$WORKER_PID" 2>/dev/null || true
  wait || true
}
trap term TERM INT

pnpm --filter @quibt/api start
wait
