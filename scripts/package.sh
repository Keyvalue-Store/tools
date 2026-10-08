#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Packs the tools for a release: every tool's library, command line, page
# and manual, the files the pages share, and the license files, in a folder
# named keyvaluestore-tools. The tests, their fixtures and the scripts stay
# out, since nobody needs them to run the tools.
#
# Writes keyvaluestore-tools.tar.gz and keyvaluestore-tools.zip to OUT_DIR.
# The names carry no version, so links to releases/latest/download keep
# working from one release to the next.
#
# Usage: scripts/package.sh [OUT_DIR]   (default: dist)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-dist}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PKG="$WORK/keyvaluestore-tools"
mkdir -p "$PKG"

cp "$ROOT/LICENSE" "$ROOT/NOTICE" "$ROOT/README.md" "$ROOT/package.json" "$PKG/"
cp -R "$ROOT/common" "$PKG/"
count=0
for dir in "$ROOT"/*/; do
  tool=$(basename "$dir")
  [ -f "$dir/cli.js" ] || continue
  mkdir -p "$PKG/$tool"
  for item in "$dir"*; do
    [ "$(basename "$item")" = test ] && continue
    cp -R "$item" "$PKG/$tool/"
  done
  count=$((count + 1))
done
if [ "$count" -eq 0 ]; then
  echo "Found no tools to pack." >&2
  exit 1
fi

rm -f "$OUT/keyvaluestore-tools.tar.gz" "$OUT/keyvaluestore-tools.zip"
tar -czf "$OUT/keyvaluestore-tools.tar.gz" -C "$WORK" keyvaluestore-tools
(cd "$WORK" && zip -qr "$OUT/keyvaluestore-tools.zip" keyvaluestore-tools)
echo "Packed $count tools into $OUT/keyvaluestore-tools.tar.gz and $OUT/keyvaluestore-tools.zip"
