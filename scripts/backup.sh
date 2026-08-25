#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="${1:-$(date +%Y%m%d-%H%M%S)}"
case "$STAMP" in
  ""|*/*|*..*) echo "invalid backup name: $STAMP" >&2; exit 2 ;;
esac
OUT="${ROOT}/backups/${STAMP}"
COMPOSE=(docker compose -f "$ROOT/infra/compose/docker-compose.yml")
mkdir -p "$OUT"

# The dump lands on a temporary name first: a half-written file must never look like a backup.
if ! "${COMPOSE[@]}" exec -T postgres pg_dump -U quibt quibt > "$OUT/quibt.sql.partial"; then
  rm -f "$OUT/quibt.sql.partial"
  echo "pg_dump failed: no backup was written to $OUT" >&2
  exit 1
fi
if [[ ! -s "$OUT/quibt.sql.partial" ]]; then
  rm -f "$OUT/quibt.sql.partial"
  echo "pg_dump produced an empty dump: no backup was written to $OUT" >&2
  exit 1
fi
mv "$OUT/quibt.sql.partial" "$OUT/quibt.sql"

# An empty archive is only acceptable when there is really nothing to archive.
if [[ -d "$ROOT/data" ]]; then
  tar -czf "$OUT/homes.tgz" -C "$ROOT" data
else
  tar -czf "$OUT/homes.tgz" --files-from /dev/null
fi
echo "Backup written to $OUT"
