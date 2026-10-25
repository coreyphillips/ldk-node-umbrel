#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
destination="${1:?Usage: scripts/backup.sh /absolute/private/backup.tar.gz}"
[[ "$destination" = /* ]] || { echo 'Use an absolute backup path.' >&2; exit 1; }
[[ ! -e "$destination" ]] || { echo 'Refusing to overwrite a backup.' >&2; exit 1; }
cd "$package_dir"
running="$(docker compose -f compose.local.yml ps --status running -q)" || { echo 'Cannot verify container state; backup refused.' >&2; exit 1; }
if [[ -n "$running" ]]; then
  echo 'Stop the dashboard with docker compose -f compose.local.yml stop before backing up.' >&2; exit 1
fi
[[ -d data ]] || { echo 'No data directory exists.' >&2; exit 1; }
umask 077
case "$destination" in "$package_dir/data/"*) echo 'Keep the backup outside the live data directory.' >&2; exit 1 ;; esac
if command -v flock >/dev/null; then
  exec 9>data/.manager.lock
  flock -n 9 || { echo 'Another manager is using this data directory.' >&2; exit 1; }
fi
tar -czf "$destination" data
echo 'Private cold backup created. It contains wallet secrets. Store it securely and never run two copies of the same Lightning wallet.'
