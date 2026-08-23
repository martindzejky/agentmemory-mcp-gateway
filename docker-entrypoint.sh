#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/validate-database-path.sh
. "$here/scripts/validate-database-path.sh"

mkdir -p -- "$data_dir"

if [ "$(id -u)" = "0" ]; then
  chown gateway:gateway -- "$data_dir"
  for suffix in "" "-wal" "-shm"; do
    file="${resolved_path}${suffix}"
    if [ -e "$file" ]; then
      chown gateway:gateway -- "$file"
    fi
  done
  exec setpriv --reuid=10001 --regid=10001 --init-groups -- "$@"
fi

exec "$@"
