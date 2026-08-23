#!/bin/sh
set -eu

mount="${RAILWAY_VOLUME_MOUNT_PATH:-/data}"
data_path="${DATABASE_PATH:-/data/oauth.sqlite}"

case "$data_path" in
  /*) ;;
  *)
    echo "DATABASE_PATH must be an absolute file path" >&2
    exit 1
    ;;
esac

case "$mount" in
  /*) ;;
  *)
    echo "RAILWAY_VOLUME_MOUNT_PATH must be an absolute directory" >&2
    exit 1
    ;;
esac

if [ "$mount" = "/" ]; then
  echo "volume mount directory must not be /" >&2
  exit 1
fi

resolved_path=$(realpath -m -- "$data_path")
resolved_mount=$(realpath -m -- "$mount")
data_dir=$(dirname -- "$resolved_path")

case "$resolved_path" in
  "$resolved_mount"/*) ;;
  *)
    echo "DATABASE_PATH must be an absolute file under ${resolved_mount}" >&2
    exit 1
    ;;
esac

if [ "$data_dir" = "/" ] || [ "$data_dir" = "$resolved_path" ]; then
  echo "DATABASE_PATH parent directory is unsafe" >&2
  exit 1
fi

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
