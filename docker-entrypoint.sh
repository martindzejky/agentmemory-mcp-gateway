#!/bin/sh
set -eu

data_path="${DATABASE_PATH:-/data/oauth.sqlite}"
data_dir=$(dirname "$data_path")

mkdir -p "$data_dir"

if [ "$(id -u)" = "0" ]; then
  chown -R gateway:gateway "$data_dir"
  exec setpriv --reuid=10001 --regid=10001 --init-groups -- "$@"
fi

exec "$@"
