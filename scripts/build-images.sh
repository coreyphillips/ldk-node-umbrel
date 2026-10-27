#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_dir="${LDK_SOURCE_DIR:-$(cd "$package_dir/../../synonym/ldk-node" 2>/dev/null && pwd)}"
if [[ ! -f "$native_dir/tools/ldk-node-daemon/Cargo.lock" ]]; then
  echo 'Set LDK_SOURCE_DIR to the local LDK Node checkout containing tools/ldk-node-daemon/Cargo.lock.' >&2
  exit 1
fi
architectures="${LDK_BUILD_ARCHS:-amd64 arm64}"
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
mkdir -p "$package_dir/dist"
python3 "$package_dir/scripts/stage-native-source.py" "$native_dir" "$context/native" "$package_dir/licenses/native-source-0.1.12.json"
COPYFILE_DISABLE=1 tar -czf "$package_dir/dist/native-source-0.1.12.tar.gz" -C "$context/native" .
native_revision="$(git -C "$native_dir" rev-parse HEAD)"
python3 - "$package_dir/licenses" "$native_revision" <<'PY_NOTICES'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
name = 'native-source-0.1.12.json'
digest = hashlib.sha256((root / name).read_bytes()).hexdigest()
manifest = root / 'package-manifest.json'
packages = json.loads(manifest.read_text())
for package in packages:
    if package.get('source') == 'local native fork':
        package.update(source_manifest=name, source_manifest_sha256=digest, source_base_commit=sys.argv[2])
manifest.write_text(json.dumps(packages, indent=2) + '\n')
with (root / 'SHA256SUMS').open('w') as output:
    for file in sorted(root.rglob('*')):
        if file.is_file() and file.name != 'SHA256SUMS':
            output.write(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + str(file.relative_to(root)) + '\n')
PY_NOTICES
printf '%s\n' "$native_revision" > "$package_dir/dist/native-revision.txt"
python3 - "$context/native" "$package_dir/dist/native-source.sha256" <<'PY_MANIFEST'
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1])
with open(sys.argv[2], 'w') as manifest:
    for source in sorted(root.rglob('*')):
        if source.is_file():
            manifest.write(hashlib.sha256(source.read_bytes()).hexdigest() + '  ' + str(source.relative_to(root)) + '\n')
PY_MANIFEST
for architecture in $architectures; do
  case "$architecture" in amd64|arm64) ;; *) echo "Unsupported architecture: $architecture" >&2; exit 1 ;; esac
  docker buildx build --platform "linux/$architecture" --build-context "native=$context/native" \
    --file "$package_dir/docker/Dockerfile.release" --tag "ldk-node-umbrel:0.1.12-$architecture" \
    --output "type=docker,dest=$package_dir/dist/ldk-node-umbrel-0.1.12-$architecture.tar" "$package_dir"
done
cd "$package_dir/dist"
if command -v sha256sum >/dev/null; then sha256sum ldk-node-umbrel-0.1.12-*.tar > SHA256SUMS; else shasum -a 256 ldk-node-umbrel-0.1.12-*.tar > SHA256SUMS; fi
echo 'Local image archives are in dist/. No image was published.'
