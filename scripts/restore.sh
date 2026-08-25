#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:?usage: restore.sh backups/<stamp> [--yes]}"
CONFIRM="${2:-}"
DUMP="$SRC/quibt.sql"
COMPOSE=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")

if [[ ! -f "$DUMP" ]]; then
  echo "missing dump: $DUMP" >&2
  exit 1
fi

# Restoring overwrites the live database, so it never happens by accident.
if [[ "$CONFIRM" != "--yes" && "${RESTORE_YES:-}" != "1" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Restore $DUMP over the quibt database? Current data is lost. [y/N] " answer
    if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
      echo "aborted" >&2
      exit 1
    fi
  else
    echo "refusing to restore without confirmation: pass --yes or set RESTORE_YES=1" >&2
    exit 2
  fi
fi

"${COMPOSE[@]}" up -d postgres
DEADLINE=$((SECONDS + 120))
until "${COMPOSE[@]}" exec -T postgres pg_isready -U quibt >/dev/null 2>&1; do
  if (( SECONDS > DEADLINE )); then
    echo "postgres did not become ready in 120s" >&2
    exit 1
  fi
  sleep 1
done

# ON_ERROR_STOP plus one transaction: a broken dump fails loudly instead of leaving a
# half-restored database behind.
"${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 --single-transaction -U quibt -d quibt < "$DUMP"
if [[ -f "$SRC/homes.tgz" ]]; then
  tar -xzf "$SRC/homes.tgz" -C "$ROOT"
fi
"${COMPOSE[@]}" up -d
echo "Restore complete from $SRC"
