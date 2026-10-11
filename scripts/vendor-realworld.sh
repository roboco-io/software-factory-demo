#!/usr/bin/env bash
# RealWorld 공식 Hurl 스위트를 고정 커밋에서 가져온다. 갱신 시 SHA를 바꾸고 다시 실행한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="${1:-$(cat "$ROOT/tests/realworld/UPSTREAM.txt")}"
DEST="$ROOT/tests/realworld/vendor"
FILES=(articles auth comments errors_articles errors_auth errors_authorization errors_comments errors_profiles favorites feed pagination profiles tags)
rm -rf "$DEST" && mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  curl -fsSL "https://raw.githubusercontent.com/realworld-apps/realworld/$SHA/specs/api/hurl/$f.hurl" -o "$DEST/$f.hurl"
done
echo "$SHA" > "$ROOT/tests/realworld/UPSTREAM.txt"
echo "vendored ${#FILES[@]} files at $SHA"
