#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Clones and builds the 15 Redis and Valkey versions that the Memory
# Calculator, Config Checker and ACL Builder recorded their test data from.
# You need it only to record that data again. npm test doesn't need it.
#
# Each version is cloned at its release tag into KV_SRC/<server>-<version>/
# and built with plain "make BUILD_TLS=no", so with the server's own bundled
# jemalloc. Keep the build as it is: the recorded data depends on it. The
# server and its cli then go to KV_BIN/<server>-<version>/, for example
# KV_BIN/redis-7.2.16/redis-server.
#
# What uses the result:
#   memory/test/generate/record.py, config/test/generate/record.py and
#   acl/test/generate/record.py run the servers in KV_BIN.
#   config/test/generate/extract.py and acl/test/generate/extract.py run
#   them too, and read the sources in KV_SRC: every <server>-<version>/src/
#   folder they find there.
# All five take KV_BIN from the environment, and the extract scripts take
# KV_SRC, with the same defaults as here.
#
# Needs git, make and a C compiler, about 4.5 GB of disk, and Linux. On other
# systems these servers build with libc malloc instead of jemalloc, and the
# check after each build fails. All 15 take about half an hour on 2 CPUs.
# Versions already in KV_BIN are skipped. Each build writes its output to
# KV_SRC/build-<server>-<version>.log. Exits with 1 if any version failed.
#
# Usage: scripts/build-servers.sh [redis-7.2.16 valkey-9.1.2 ...]
#   KV_SRC  where the sources go (default /opt/kvsrc)
#   KV_BIN  where the servers go (default /opt/kv)
#   JOBS    make jobs at once (default: the number of CPUs)
set -u

KV_SRC=${KV_SRC:-/opt/kvsrc}
KV_BIN=${KV_BIN:-/opt/kv}
JOBS=${JOBS:-$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}

# The versions the test data was recorded from. Change this list only
# together with the record scripts and their data.
ALL="redis-6.2.24 redis-7.0.15 redis-7.2.16 redis-7.4.11 redis-8.0.6 \
redis-8.2.10 redis-8.4.7 redis-8.6.7 redis-8.8.3 redis-8.10.2 \
valkey-7.2.14 valkey-8.0.11 valkey-8.1.10 valkey-9.0.6 valkey-9.1.2"

if [ $# -eq 0 ]; then
  # No names given: build them all. $ALL splits into words on purpose.
  # shellcheck disable=SC2086
  set -- $ALL
fi
for id in "$@"; do
  found=
  for known in $ALL; do
    [ "$id" = "$known" ] && found=yes
  done
  if [ -z "$found" ]; then
    echo "Unknown server: $id" >&2
    echo "Usage: $0 [server-version ...]" >&2
    echo "Versions: $ALL" >&2
    exit 2
  fi
done
case $JOBS in
  '' | *[!0-9]* | 0) echo "JOBS must be a whole number above 0, not '$JOBS'." >&2; exit 2 ;;
esac
CC_CMD=${CC:-cc}
for tool in git make "${CC_CMD%% *}"; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "This needs $tool, which isn't installed." >&2
    exit 2
  fi
done
mkdir -p "$KV_SRC" "$KV_BIN" || exit 2

BUILT=
SKIPPED=
FAILED=

# Says why a version failed, shows the end of its log, and remembers it.
fail() {
  printf '%s: %s. The end of %s:\n' "$id" "$1" "$log" >&2
  tail -n 20 "$log" >&2
  FAILED="$FAILED
    $id: $1, see $log"
}

# Clones, builds, checks and copies one version, such as redis-7.2.16.
build() {
  id=$1
  name=${id%%-*}
  ver=${id#*-}
  src=$KV_SRC/$id
  bin=$KV_BIN/$id
  log=$KV_SRC/build-$id.log
  if [ "$name" = redis ]; then repo=redis/redis; else repo=valkey-io/valkey; fi

  if [ -x "$bin/$name-server" ] && [ -x "$bin/$name-cli" ]; then
    echo "$id: already built in $bin"
    [ -d "$src/src" ] || echo "$id: but the extract scripts need its sources in $src"
    SKIPPED="$SKIPPED $id"
    return
  fi
  start=$(date +%s)
  : > "$log"
  if [ ! -f "$src/Makefile" ]; then
    echo "$id: cloning $repo at $ver"
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$ver" \
      "https://github.com/$repo" "$src" >> "$log" 2>&1 || { fail "clone failed"; return; }
  fi
  echo "$id: building with $JOBS jobs"
  (cd "$src" && make -j"$JOBS" BUILD_TLS=no) >> "$log" 2>&1 || { fail "build failed"; return; }

  # The data was recorded from this version, built with jemalloc.
  says=$("$src/src/$name-server" --version 2>&1)
  printf '%s\n' "$says" >> "$log"
  case $says in
    *" v=$ver "*"malloc=jemalloc"*) ;;
    *) fail "wrong version or allocator: $says"; return ;;
  esac
  if ! { mkdir -p "$bin" && cp "$src/src/$name-server" "$src/src/$name-cli" "$bin/"; } >> "$log" 2>&1; then
    fail "copying to $bin failed"
    return
  fi
  took=$(($(date +%s) - start))
  printf '%s: built in %dm %ds: %s\n' "$id" $((took / 60)) $((took % 60)) "$says"
  BUILT="$BUILT $id"
}

for id in "$@"; do
  build "$id"
done

echo
echo "Servers in $KV_BIN, sources in $KV_SRC:"
[ -n "$BUILT" ] && echo "  built:$BUILT"
[ -n "$SKIPPED" ] && echo "  already built:$SKIPPED"
if [ -n "$FAILED" ]; then
  echo "  FAILED:$FAILED"
  exit 1
fi
echo "  nothing failed"
