#!/usr/bin/env python3
"""Copy only native build inputs; never copy local wallets or developer state."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def stage(source: Path, destination: Path):
    inputs = [
        'Cargo.toml', 'Cargo.lock', 'build.rs', 'README.md', 'LICENSE-MIT',
        'LICENSE-APACHE', '.cargo/config.toml', 'src', 'crates', 'vendor',
        'bindings/ldk_node.udl', 'tools/ldk-node-daemon', 'tests', 'benches',
        'examples/chicory-primary.rs',
    ]
    excluded = {'.git', 'target', 'node_modules', '.DS_Store', '__pycache__'}
    hashes = {}
    for entry in inputs:
        item = source / entry
        if not item.exists():
            raise ValueError(f'Missing native build input: {entry}')
        candidates = item.rglob('*') if item.is_dir() else [item]
        for path in sorted(candidates):
            relative = path.relative_to(source)
            if any(part in excluded or part.startswith('.env') for part in relative.parts):
                continue
            if path.is_symlink():
                raise ValueError(f'Symlink in native build input: {relative}')
            if not path.is_file():
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            hashes[relative.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()
    return dict(sorted(hashes.items()))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('manifest', type=Path)
    args = parser.parse_args()
    manifest = stage(args.source.resolve(), args.destination.resolve())
    args.manifest.write_text(json.dumps(manifest, indent=2) + '\n')
