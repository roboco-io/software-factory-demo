#!/usr/bin/env bash
# 로컬 wrangler dev(로컬 D1)를 띄우고 RealWorld Hurl 스위트를 실행한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
HOST="http://localhost:$PORT"
VENDOR="$ROOT/tests/realworld/vendor"
SKIP_FILE="$ROOT/tests/realworld/skip.txt"

SKIP=()
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  if [ ! -f "$VENDOR/$line" ]; then echo "skip.txt lists unknown file: $line" >&2; exit 2; fi
  SKIP+=("$line")
done < "$SKIP_FILE"

FILES=()
for f in "$VENDOR"/*.hurl; do
  name="$(basename "$f")"
  skipped=0
  # bash 3.2(macOS)에서 set -u 아래 빈 배열 확장이 실패하므로 길이를 먼저 확인한다.
  if [ "${#SKIP[@]}" -gt 0 ]; then
    for s in "${SKIP[@]}"; do [ "$s" = "$name" ] && skipped=1; done
  fi
  if [ "$skipped" = 1 ]; then echo "skip: $name"; else FILES+=("$f"); fi
done

cd "$ROOT/apps/api"
rm -rf .wrangler/state
pnpm exec wrangler d1 migrations apply sfd-prod --local
pnpm exec wrangler dev --port "$PORT" --var JWT_SECRET:realworld-local > "$ROOT/.wrangler-dev.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fsS "$HOST/api/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$HOST/api/health" > /dev/null || { tail -n 50 "$ROOT/.wrangler-dev.log"; exit 1; }

hurl --test --jobs 1 --variable "host=$HOST" --variable "uid=$(date +%s)$$" "${FILES[@]}"
