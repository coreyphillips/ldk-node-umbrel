#!/usr/bin/env python3
"""Run installed-Chicory payment scenarios through an explicit local Umbrel image.

This is a funded disposable-regtest runner. It never loads or publishes images.
Coordinate exclusive use of the supplied chain before running it. Bitcoin CLI
uses the native fixture's fixed RPC port 43782 and fixture credentials.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
from urllib.parse import unquote, urlsplit


SCENARIOS = {
    'initial-deposit-growth': ({'INITIAL_DEPOSIT': '1', 'INITIAL_DEPOSIT_GROWTH': '1'}, [
        'phone reopen preserves the initial deposit home and post-spend balance',
        'operator explicitly trusts this disposable wallet for instant confirmed-channel growth',
        'explicitly trusted JIT growth settles one HTLC before the splice confirms',
        'grown channel sends above its original capacity and survives both restarts',
    ]),
    'baseline-growth-splices': ({'EXISTING_RECEIVE': '1', 'JIT_GROWTH': '1', 'SPLICES': '1'}, [
        'installed wallet receives fixed-amount Lightning without a splice or JIT fee',
        'installed wallet receives amountless Lightning without a splice or JIT fee',
        'installed wallet routes Lightning to an external recipient through the native primary',
        'grown channel sends above its original capacity and survives both restarts',
        'installed wallet splice-out pays the exact destination amount',
    ]),
    'direct-funding': ({'DIRECT_FUNDING': '1'}, [
        'unconfirmed direct-funding existing-home receipt remains pending after both restarts',
        'unconfirmed direct-funding initial-channel receipt remains pending after both restarts',
        'installed wallet spends from the direct-funded existing-home channel after both restarts',
        'installed wallet spends from the direct-funded initial-channel channel after both restarts',
        'operator explicitly trusts this disposable wallet for instant confirmed-channel growth',
        'explicitly trusted JIT growth settles one HTLC before the splice confirms',
        'direct-funding receive completion survives a later JIT splice and both restarts',
    ]),
    **{f'send-max-{kind}': ({'SEND_MAX': kind}, [
        f'installed send-max pays the exact reviewed {kind} destination',
        'installed send-max retains one completed Activity row and its home after both restarts',
    ]) for kind in ('bech32', 'bech32m', 'p2wsh')},
    'drain': ({'DRAIN': '1'}, [
        'installed drain completes once after both restarts and excludes later receipts',
    ]),
    'conflict': ({'CONFLICT': '1'}, [
        'six-confirmation conflict restores matching usable prior funding on both peers',
        'reverted direct funding restores the unpaid request without a phantom receive',
        'installed wallet spends from recovered prior funding after both restarts',
    ]),
    'recovery-sweep': ({'RECOVERY': '1', 'RECOVERY_SWEEP': '1'}, [
        'restored phone sweeps the primary current commitment without signing stale state',
    ]),
}
RESOURCE_NAME = re.compile(r'ldk-umbrel-funded-[0-9a-f]{14}')
SECRET_KEY = re.compile(r'^(password|rpc_password|authorization|cookie|seed|mnemonic|preimage|private_key|privatekey|payment_preimage)$', re.I)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(file):
    value = hashlib.sha256()
    with Path(file).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def write_json(path, value):
    pending = path.with_suffix(path.suffix + '.pending')
    pending.write_text(json.dumps(value, indent=2) + '\n')
    pending.replace(path)


def docker(*args, missing_ok=False):
    result = subprocess.run(['docker', *args], text=True, capture_output=True, timeout=180)
    if result.returncode:
        if missing_ok and re.search(r'No such (container|volume|object)', result.stderr, re.I):
            return None
        raise RuntimeError('Docker operation failed: ' + args[0])
    return result.stdout.strip()


def repo_state(path):
    revision = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True, capture_output=True)
    status = subprocess.run(['git', '-C', str(path), 'status', '--porcelain', '--untracked-files=no'], text=True, capture_output=True)
    if revision.returncode or status.returncode:
        raise ValueError('Source directories must be Git checkouts')
    return {'revision': revision.stdout.strip(), 'tracked_changes': bool(status.stdout.strip())}


def redactor(urls):
    secrets = {'polaruser', 'polarpass'}
    for url in urls:
        parsed = urlsplit(url)
        for value in (parsed.username, parsed.password):
            if value:
                secrets.update((value, unquote(value)))
    ordered = sorted(secrets, key=len, reverse=True)

    def redact(value):
        if isinstance(value, dict):
            return {key: '[redacted]' if SECRET_KEY.match(key) else redact(item) for key, item in value.items()}
        if isinstance(value, list):
            return [redact(item) for item in value]
        if isinstance(value, str):
            # Suppress complete diagnostic lines containing authentication fields,
            # including values generated inside the manager and unknown here.
            value = ''.join('[redacted authentication detail]\n' if re.search(
                r'\b(?:password|rpc_password|authorization|cookie|mnemonic|private_key)\b["\x27]?\s*[:=]', line, re.I
            ) else line for line in value.splitlines(keepends=True))
            value = re.sub(r'([a-z][a-z0-9+.-]*://)[^\s/]*@', r'\1[redacted]@', value, flags=re.I)
            for secret in ordered:
                value = value.replace(secret, '[redacted]')
        return value
    return redact


def scenario_environment(args, flags, raw_evidence, resources, adapter):
    # Caller flags must not silently narrow or add scenarios, replace the image,
    # switch transports, or retain live test state after a successful fixture.
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('CHICORY_', 'LFBW_', 'LDK_CONTAINER_'))
           and key not in ('BEIGNET_EVIDENCE_FILE', 'BEIGNET_SOURCE_DIR', 'BEIGNET_REGTEST_BITCOIN')}
    env.update({
        'CHICORY_PRIMARY_BIN': str(adapter), 'CHICORY_SOURCE_DIR': str(args.chicory_source),
        'BEIGNET_SOURCE_DIR': str(args.beignet_source), 'BEIGNET_REGTEST_BITCOIN': args.bitcoin_container,
        'CHICORY_PRIMARY_CHAIN_SOURCE': args.primary_chain_url, 'CHICORY_ELECTRUM_URL': args.electrum_url,
        'LDK_CONTAINER_IMAGE': args.image, 'LDK_CONTAINER_ARCH': args.architecture,
        'LDK_CONTAINER_RESOURCE_LOG': str(resources), 'BEIGNET_EVIDENCE_FILE': str(raw_evidence),
        'CHICORY_TEST_TIMEOUT_MS': str(args.operation_timeout * 1000),
    })
    env.update({'CHICORY_TEST_' + key: value for key, value in flags.items()})
    return env


def terminate(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=15)


def run_process(command, cwd, env, log_file, timeout, redact):
    process = subprocess.Popen(command, cwd=cwd, env=env, text=True, errors='replace',
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    errors = []
    with log_file.open('w') as output:
        def copy():
            try:
                for line in process.stdout:
                    output.write(redact(line))
                    output.flush()
            except Exception:
                errors.append('Could not preserve the fixture log')
        reader = threading.Thread(target=copy, daemon=True)
        reader.start()
        try:
            result = process.wait(timeout=timeout)
        except BaseException:
            terminate(process)
            raise
        finally:
            reader.join(timeout=20)
            if reader.is_alive():
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                reader.join(timeout=5)
        if errors or reader.is_alive():
            raise RuntimeError('Could not finish preserving the fixture log')
    return result


def validate_result(name, result, returncode, hashes):
    reasons = []
    if returncode != 0:
        reasons.append('Fixture exited unsuccessfully')
    if not isinstance(result, dict):
        return reasons + ['Fixture did not write a JSON evidence object']
    if result.get('passed') is not True or result.get('chain') != 'regtest':
        reasons.append('Fixture did not report a successful regtest run')
    checks = result.get('checks', [])
    if not isinstance(checks, list):
        checks = []
    names = {check.get('name') for check in checks if isinstance(check, dict)}
    for expected in SCENARIOS[name][1]:
        if expected not in names:
            reasons.append('Missing scenario check: ' + expected)
    packages = result.get('packages', {})
    if not isinstance(packages, dict):
        packages = {}
    if packages.get('engineSha256') != hashes['portable_bundle'] or packages.get('walletCoreSha256') != hashes['wallet_core']:
        reasons.append('Fixture client hashes do not match the recorded installed inputs')
    if result.get('primaryBinarySha256') != hashes['fixture_adapter']:
        reasons.append('Fixture did not use the recorded package adapter')
    if name == 'direct-funding' and result.get('directFundingScope') != 'existing-home-and-initial-channel':
        reasons.append('Direct funding did not exercise both channel paths')
    return reasons


def cleanup_resources(file, architecture, image):
    if not file.exists():
        return {'removed': [], 'errors': []}
    entries = {}
    for line in file.read_text().splitlines():
        item = json.loads(line)
        name, volume = item.get('container', ''), item.get('volume', '')
        if not RESOURCE_NAME.fullmatch(name) or volume != name + '-data' or item.get('architecture') != architecture:
            raise ValueError('Refusing cleanup of an invalid recorded fixture resource')
        entries[name] = volume
    result = {'removed': [], 'errors': []}
    for name, volume in entries.items():
        try:
            raw = docker('container', 'inspect', name, missing_ok=True)
            if raw is not None:
                info = json.loads(raw)[0]
                if info['Config']['Image'] != image or not any(mount.get('Name') == volume and mount.get('Destination') == '/data' for mount in info['Mounts']):
                    raise ValueError('Recorded fixture container ownership does not match')
                docker('rm', '--force', name)
            if docker('volume', 'inspect', volume, missing_ok=True) is not None:
                docker('volume', 'rm', volume)
            result['removed'].append({'container': name, 'volume': volume})
        except Exception as error:
            result['errors'].append({'container': name, 'error': str(error)})
    return result


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, help='Existing local candidate image, never loaded or published by this runner')
    parser.add_argument('--architecture', choices=['arm64', 'amd64'], required=True)
    parser.add_argument('--native-source', type=Path, required=True)
    parser.add_argument('--chicory-source', type=Path, required=True)
    parser.add_argument('--beignet-source', type=Path, help='Built payer checkout; defaults to the native fixture sibling checkout')
    parser.add_argument('--bitcoin-container', required=True, help='Disposable regtest Core container with the native fixture RPC configuration')
    parser.add_argument('--primary-chain-url', required=True)
    parser.add_argument('--electrum-url', required=True)
    parser.add_argument('--scenario', action='append', choices=list(SCENARIOS), help='Repeat to select scenarios; default runs all nine sequentially')
    parser.add_argument('--output-dir', type=Path, help='New private output directory; defaults to a private temporary directory')
    parser.add_argument('--operation-timeout', type=int, default=180, help='Native fixture operation timeout in seconds, 30 through 600')
    parser.add_argument('--scenario-timeout', type=int, default=1800, help='Whole-scenario deadline in seconds, 60 through 7200')
    args = parser.parse_args(argv)
    args.native_source = args.native_source.resolve()
    args.chicory_source = args.chicory_source.resolve()
    args.beignet_source = (args.beignet_source or args.native_source.parent.parent / 'testing/beignet').resolve()
    args.scenario = list(dict.fromkeys(args.scenario or SCENARIOS))
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', args.bitcoin_container):
        parser.error('Use a literal Docker container name')
    if not args.image or args.image.startswith('-') or any(char.isspace() for char in args.image):
        parser.error('Use a literal local image reference')
    if not 30 <= args.operation_timeout <= 600 or not 60 <= args.scenario_timeout <= 7200:
        parser.error('Timeout outside supported bounds')
    for value, schemes in ((args.primary_chain_url, ('rpc', 'tcp', 'ssl')), (args.electrum_url, ('tcp', 'ssl'))):
        try:
            parsed = urlsplit(value)
            valid = parsed.scheme in schemes and bool(parsed.hostname) and parsed.port is not None and not parsed.query and not parsed.fragment
            if parsed.scheme != 'rpc' and (parsed.username or parsed.password):
                valid = False
        except ValueError:
            valid = False
        if not valid:
            parser.error('Use an explicit supported chain URL with host and port')
    return args


def main(argv=None):
    os.umask(0o077)
    args = parse_args(argv)
    package = Path(__file__).resolve().parents[1]
    files = {
        'matrix_runner': Path(__file__).resolve(),
        'native_driver': args.native_source / 'scripts/chicory-portable-interop.cjs',
        'fixture_adapter': package / 'scripts/fixture-primary.cjs',
        'portable_bundle': args.chicory_source / 'node_modules/@beignet/portable-engine/dist/portable.cjs',
        'wallet_core': args.chicory_source / 'node_modules/@beignet/wallet-core/src/index.js',
        'payer_entry': args.beignet_source / 'dist/cli/beignet-node.js',
        'portable_package': args.chicory_source / 'node_modules/@beignet/portable-engine/package.json',
        'wallet_core_package': args.chicory_source / 'node_modules/@beignet/wallet-core/package.json',
    }
    for package_name, subtree in (('portable-engine', 'dist'), ('wallet-core', 'src')):
        installed = args.chicory_source / 'node_modules/@beignet' / package_name
        for file in sorted((installed / subtree).rglob('*')):
            if file.is_file():
                files[package_name + '/' + file.relative_to(installed).as_posix()] = file
    for file in files.values():
        if not file.is_file():
            raise ValueError('Missing required source or installed bundle: ' + str(file))
    hashes = {name: digest(file) for name, file in files.items()}
    image = json.loads(docker('image', 'inspect', args.image))[0]
    if image['Architecture'] != args.architecture or image.get('Os') != 'linux':
        raise ValueError('Candidate image platform does not match the requested Linux architecture')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image.get('Id', '')):
        raise ValueError('Candidate image does not have a SHA-256 identity')
    provenance = {
        'image': {'reference': args.image, 'id': image['Id'], 'architecture': args.architecture},
        'sources': {name: repo_state(directory) for name, directory in (
            ('package', package), ('native_driver', args.native_source), ('chicory', args.chicory_source), ('payer', args.beignet_source))},
        'sha256': hashes,
    }
    if args.output_dir:
        args.output_dir.mkdir(mode=0o700)
        output = args.output_dir.resolve()
    else:
        output = Path(tempfile.mkdtemp(prefix='chicory-flow-container-'))
    resources = output / 'resources.jsonl'
    redact = redactor((args.primary_chain_url, args.electrum_url))
    report = {
        'scope': 'local candidate installed-Chicory flows through authenticated Umbrel manager',
        'started_at': now(), 'provenance': provenance, 'selected_scenarios': args.scenario,
        'full_matrix_selected': set(args.scenario) == set(SCENARIOS), 'results': [], 'passed': False,
        'network': 'disposable regtest', 'physical_umbrel': False, 'published_release_qualified': False,
    }
    write_json(output / 'summary.json', redact(report))
    print(json.dumps({'artifacts': str(output), 'selected_scenarios': args.scenario}), flush=True)
    interrupted = False
    try:
        for name in args.scenario:
            scenario = {
                'name': name, 'started_at': now(), 'passed': False, 'reasons': [],
                'log': name + '.log', 'fixture_evidence': name + '.fixture.json',
                'provenance': provenance,
            }
            print(json.dumps({'scenario': name, 'status': 'running'}), flush=True)
            raw = output / (name + '.fixture.json')
            try:
                chain = json.loads(docker('exec', args.bitcoin_container, 'bitcoin-cli', '-rpcport=43782',
                                         '-rpcuser=polaruser', '-rpcpassword=polarpass', '-rpcwallet=default', 'getblockchaininfo'))
                if chain.get('chain') != 'regtest':
                    raise ValueError('Refusing funded scenarios outside regtest')
                if json.loads(docker('image', 'inspect', args.image))[0]['Id'] != image['Id']:
                    raise ValueError('Candidate image reference changed during the suite')
                if any(digest(file) != hashes[key] for key, file in files.items()):
                    raise ValueError('Fixture or installed client input changed during the suite')
                env = scenario_environment(args, SCENARIOS[name][0], raw, resources, files['fixture_adapter'])
                code = run_process(['node', str(files['native_driver'])], args.native_source, env,
                                   output / (name + '.log'), args.scenario_timeout, redact)
                fixture = json.loads(raw.read_text()) if raw.exists() else None
                scenario['returncode'] = code
                scenario['fixture'] = redact(fixture)
                scenario['reasons'] = validate_result(name, fixture, code, hashes)
                if json.loads(docker('image', 'inspect', args.image))[0]['Id'] != image['Id']:
                    scenario['reasons'].append('Candidate image reference changed during the scenario')
                if any(digest(file) != hashes[key] for key, file in files.items()):
                    scenario['reasons'].append('Fixture or installed client input changed during the scenario')
                scenario['passed'] = not scenario['reasons']
            except Exception as error:
                scenario['reasons'].append(redact(str(error)))
            finally:
                # Keep only the sanitized copy; fixture evidence should not carry credentials.
                if raw.exists():
                    try:
                        write_json(raw, redact(json.loads(raw.read_text())))
                    except ValueError:
                        raw.write_text(redact(raw.read_text()))
                scenario['completed_at'] = now()
                write_json(output / (name + '.json'), redact(scenario))
                report['results'].append(scenario)
                write_json(output / 'summary.json', redact(report))
            print(json.dumps({'scenario': name, 'passed': scenario['passed'], 'evidence': str(output / (name + '.json'))}), flush=True)
            if not scenario['passed']:
                break
    except KeyboardInterrupt:
        interrupted = True
        report['interrupted'] = True
    finally:
        try:
            report['cleanup'] = cleanup_resources(resources, args.architecture, args.image)
        except Exception as error:
            report['cleanup'] = {'removed': [], 'errors': [redact(str(error))]}
        report['completed_at'] = now()
        report['passed'] = (not interrupted and len(report['results']) == len(args.scenario)
                            and all(item['passed'] for item in report['results']) and not report['cleanup']['errors'])
        write_json(output / 'summary.json', redact(report))
        print(json.dumps({'evidence': str(output / 'summary.json'), 'passed': report['passed']}), flush=True)
    return 130 if interrupted else 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        # No command, URL, environment or credentials are printed on setup failure.
        print(json.dumps({'passed': False, 'error': type(error).__name__, 'message': 'Runner setup failed; verify the explicit paths, image and chain configuration.'}), flush=True)
        raise SystemExit(1)
