#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "$(uname -m)" in x86_64|amd64) architecture=amd64 ;; aarch64|arm64) architecture=arm64 ;; *) echo 'Only amd64 and arm64 are supported.' >&2; exit 1 ;; esac
archive="$package_dir/dist/ldk-node-umbrel-0.1.9-$architecture.tar"
if [[ ! -f "$archive" ]]; then echo "Missing local image archive: $archive" >&2; exit 1; fi
if [[ -f "$package_dir/dist/SHA256SUMS" ]]; then
  (cd "$package_dir/dist" && if command -v sha256sum >/dev/null; then sha256sum --ignore-missing --check SHA256SUMS; else shasum -a 256 --check SHA256SUMS; fi)
fi
docker load --input "$archive"
docker tag "ldk-node-umbrel:0.1.9-$architecture" ldk-node-umbrel:0.1.9
printf 'LDK_ARCH=%s\nPUBLIC_ORIGIN=http://umbrel.local:2114\nALLOWED_HOSTS=umbrel.local,localhost,127.0.0.1\n' "$architecture" > "$package_dir/.env.local.new"
if [[ ! -e "$package_dir/.env" ]]; then mv "$package_dir/.env.local.new" "$package_dir/.env"; else rm "$package_dir/.env.local.new"; fi
echo "Loaded $architecture image. Review .env, then run: docker compose -f compose.local.yml up -d"
