# Shared DATABASE_PATH checks for the Docker entrypoint.
# Sources must run under `set -eu`. Sets resolved_path, resolved_mount, and data_dir.

mount="${RAILWAY_VOLUME_MOUNT_PATH:-/data}"
data_path="${DATABASE_PATH:-/data/oauth.sqlite}"

case "$data_path" in
  /*) ;;
  *)
    echo "DATABASE_PATH must be an absolute file path" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

case "$mount" in
  /*) ;;
  *)
    echo "RAILWAY_VOLUME_MOUNT_PATH must be an absolute directory" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

if [ "$mount" = "/" ]; then
  echo "volume mount directory must not be /" >&2
  return 1 2>/dev/null || exit 1
fi

resolved_path=$(realpath -m -- "$data_path")
resolved_mount=$(realpath -m -- "$mount")
data_dir=$(dirname -- "$resolved_path")

case "$resolved_path" in
  "$resolved_mount"/*) ;;
  *)
    echo "DATABASE_PATH must be an absolute file under ${resolved_mount}" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

if [ "$data_dir" = "/" ] || [ "$data_dir" = "$resolved_path" ]; then
  echo "DATABASE_PATH parent directory is unsafe" >&2
  return 1 2>/dev/null || exit 1
fi

return 0 2>/dev/null || exit 0
