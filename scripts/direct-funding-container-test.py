#!/usr/bin/env python3
"""Funded bgnq qualification of one built Umbrel image on a disposable regtest chain.

Example:
  BGNQ_RPC_URL=rpc://USER:PASS@127.0.0.1:PORT LDK_SOURCE_DIR=/path/to/ldk-node \
    python3 scripts/direct-funding-container-test.py arm64

Set LDK_CONTAINER_IMAGE to test a preloaded local candidate without loading or
claiming the released image archive. Use --evidence-file to select its record.

The native fixture verifies regtest before funding. Only test containers and
volumes explicitly recorded by fixture-primary.cjs are removed after the run.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('architecture', choices=['arm64', 'amd64'])
parser.add_argument('--rpc-url', default=os.environ.get('BGNQ_RPC_URL'))
parser.add_argument('--native-source', type=pathlib.Path, default=os.environ.get('LDK_SOURCE_DIR'))
parser.add_argument('--evidence-file', type=pathlib.Path)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
if not args.rpc_url:
    parser.error('--rpc-url or BGNQ_RPC_URL is required')
native = (args.native_source or root.parent.parent / 'synonym' / 'ldk-node').resolve()
version = (root / 'VERSION').read_text().strip()
candidate_image = os.environ.get('LDK_CONTAINER_IMAGE')
image = candidate_image or f'ldk-node-umbrel:{version}-{args.architecture}'
archive = root / 'dist' / f'ldk-node-umbrel-{version}-{args.architecture}.tar'
binary = native / 'target' / 'debug' / 'examples' / 'chicory-primary'
driver = native / 'scripts' / 'direct-funding-regtest.py'
fixture = root / 'scripts' / 'fixture-primary.cjs'
required = (binary, driver, fixture) + (() if candidate_image else (archive,))
for file in required:
    if not file.is_file():
        parser.error(f'Required artifact missing: {file}')
run = pathlib.Path(tempfile.mkdtemp(prefix=f'bgnq-container-{args.architecture}-'))
resources = run / 'resources.jsonl'

def docker(*command, check=True):
    return subprocess.run(['docker', *command], check=check, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180).stdout.strip()

def digest(file):
    hasher = hashlib.sha256()
    with file.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()

started = datetime.datetime.now(datetime.timezone.utc).isoformat()
if not candidate_image:
    docker('load', '--input', str(archive))
info = json.loads(docker('image', 'inspect', image))[0]
assert info['Architecture'] == args.architecture
assert info['Config']['Labels']['org.opencontainers.image.version'] == version
checks = []
fixture_run = None
cleanup = []
try:
    env = dict(os.environ, LDK_CONTAINER_ARCH=args.architecture, LDK_CONTAINER_IMAGE=image,
        LDK_CONTAINER_RESOURCE_LOG=str(resources))
    command = ['python3', str(driver), '--rpc-url', args.rpc_url,
        '--primary-driver', str(fixture)]
    process = subprocess.Popen(command, env=env, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1)
    with (run / 'test.log').open('w') as log:
        for line in process.stdout:
            print(line, end='', flush=True)
            log.write(line)
            try:
                item = json.loads(line)
                if 'name' in item:
                    checks.append(item)
                if 'artifacts' in item:
                    fixture_run = item['artifacts']
            except ValueError:
                pass
    assert process.wait() == 0, f'Funded qualification failed; see {run / "test.log"}'
    assert len(checks) == 4, checks
    assert checks[-1].get('primaryRestarted') is True
    assert checks[-1].get('primaryIdentityPreserved') is True
finally:
    if resources.exists():
        for line in resources.read_text().splitlines():
            resource = json.loads(line)
            container, volume = resource['container'], resource['volume']
            assert re.fullmatch(r'ldk-umbrel-funded-[0-9a-f]{14}', container)
            assert volume == container + '-data'
            assert resource['architecture'] == args.architecture
            docker('rm', '--force', container)
            docker('volume', 'rm', volume)
            cleanup.append(container)
    (run / 'cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
record = {
    'version': version,
    'scope': 'native direct-funding sender and receiver with built Umbrel primary image',
    'architecture': args.architecture,
    'image': image,
    'image_source': 'preloaded candidate' if candidate_image else 'release archive',
    'image_id': info['Id'],
    'image_archive_sha256': None if candidate_image else digest(archive),
    'fixture_adapter_sha256': digest(fixture),
    'native_driver_sha256': digest(driver),
    'native_wallet_binary_sha256': digest(binary),
    'chain': 'regtest',
    'physical_umbrel': False,
    'started_at': started,
    'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'checks': checks,
    'fixture_artifacts': fixture_run,
    'qualification_artifacts': str(run),
    'test_containers_and_volumes_removed': cleanup,
    'passed': True,
}
name = f'candidate-direct-funding-{args.architecture}.json' if candidate_image else f'release-{version}-direct-funding-{args.architecture}.json'
output = args.evidence_file or root / 'docs' / 'qualification' / name
output.write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'evidence': str(output), 'passed': True}), flush=True)
