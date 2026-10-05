#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Copies each tool's page into the keyvaluestore.com site, so the site serves
# the same files as this repository: static/tools/<tool>/app/ for the page,
# static/tools/<tool>/<tool>.js for the tool itself, static/tools/common/ for
# the files the pages share.
#
# Usage: scripts/copy-to-site.sh /path/to/keyvaluestore.com
set -e
SITE="$1"
if [ -z "$SITE" ] || [ ! -f "$SITE/config.toml" ]; then
  echo "Give the path of the site, the folder that holds config.toml." >&2
  exit 2
fi
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$SITE/static/tools"
rm -rf "$OUT"
mkdir -p "$OUT/common"
cp "$ROOT/common/"* "$OUT/common/"
for tool in slots typed-json pipe keyspace ring snapshot traffic inspect; do
  mkdir -p "$OUT/$tool/app"
  lib=$(ls "$ROOT/$tool"/*.js | grep -v '/cli\.js$')
  cp $lib "$OUT/$tool/"
  cp "$ROOT/$tool/app/"* "$OUT/$tool/app/"
done
echo "Copied the tools into $OUT"
