#!/usr/bin/env python3
"""Offline tests for candidate evidence and cleanup, with no Docker or chain access."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('chicory_flow_runner', Path(__file__).with_name('chicory-flow-container-test.py'))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
IMAGE = 'local-primary:test-arm64'
IMAGE_ID = 'sha256:' + 'a' * 64
HASHES = {'portable_bundle': 'engine-hash', 'wallet_core': 'core-hash', 'fixture_adapter': 'adapter-hash'}


def passing_fixture(name, hashes=HASHES):
    return {
        'passed': True, 'chain': 'regtest',
        'checks': [{'name': check} for check in runner.SCENARIOS[name][1]],
        'packages': {'engineSha256': hashes['portable_bundle'], 'walletCoreSha256': hashes['wallet_core']},
        'primaryBinarySha256': hashes['fixture_adapter'],
        'directFundingScope': 'existing-home-and-initial-channel',
    }


class EvidenceTests(unittest.TestCase):
    def test_success_requires_exit_result_scenario_and_exact_inputs(self):
        for name in runner.SCENARIOS:
            with self.subTest(name=name):
                fixture = passing_fixture(name)
                self.assertEqual(runner.validate_result(name, fixture, 0, HASHES), [])
                self.assertTrue(runner.validate_result(name, fixture, 1, HASHES))
                for field, value in (('passed', False), ('chain', 'main'), ('checks', []),
                                     ('checks', None), ('packages', None), ('primaryBinarySha256', 'other')):
                    self.assertTrue(runner.validate_result(name, {**fixture, field: value}, 0, HASHES))
                wrong_client = {**fixture, 'packages': {**fixture['packages'], 'walletCoreSha256': 'other'}}
                self.assertTrue(runner.validate_result(name, wrong_client, 0, HASHES))
        fixture = passing_fixture('direct-funding')
        fixture['directFundingScope'] = 'initial-channel-only'
        self.assertTrue(runner.validate_result('direct-funding', fixture, 0, HASHES))
        self.assertTrue(runner.validate_result('drain', None, 0, HASHES))

    def test_authentication_is_absent_from_saved_values_and_diagnostics(self):
        redact = runner.redactor(['rpc://fixture-user:encoded%21secret@localhost:18443'])
        data = {
            'password': 'generated-password', 'nested': [{'cookie': 'generated-cookie', 'preimage': 'generated-preimage'}],
            'message': 'rpc://fixture-user:encoded%21secret@localhost:18443 encoded!secret polarpass',
            'log': 'PASS check\nAuthorization: generated-auth\npassword = generated-password\nPASS next\n',
        }
        sanitized = redact(data)
        text = json.dumps(sanitized)
        for secret in ('fixture-user', 'encoded%21secret', 'encoded!secret', 'polarpass',
                       'generated-password', 'generated-cookie', 'generated-preimage', 'generated-auth'):
            self.assertNotIn(secret, text)
        self.assertIn('PASS check', text)
        self.assertIn('PASS next', text)

    def test_selection_cannot_inherit_hidden_scenario_or_target_overrides(self):
        args = runner.parse_args([
            '--image', IMAGE, '--architecture', 'arm64', '--native-source', '/tmp/native',
            '--chicory-source', '/tmp/chicory', '--bitcoin-container', 'fixture-core',
            '--primary-chain-url', 'rpc://u:p@127.0.0.1:18443', '--electrum-url', 'tcp://127.0.0.1:50001',
            '--scenario', 'direct-funding', '--scenario', 'direct-funding',
        ])
        inherited = {
            'PATH': '/bin', 'CHICORY_DF_ONLY_FRESH': '1', 'CHICORY_TEST_IOS': '1',
            'CHICORY_KEEP_TEST_STATE': '1', 'LFBW_PRIMARY': 'other', 'LDK_CONTAINER_IMAGE': 'other',
            'BEIGNET_SOURCE_DIR': 'other', 'BEIGNET_EVIDENCE_FILE': 'other',
        }
        with patch.dict(os.environ, inherited, clear=True):
            env = runner.scenario_environment(args, runner.SCENARIOS['direct-funding'][0], Path('/tmp/evidence'),
                                              Path('/tmp/resources'), Path('/tmp/adapter'))
        self.assertEqual(args.scenario, ['direct-funding'])
        self.assertEqual(env['LDK_CONTAINER_IMAGE'], IMAGE)
        self.assertEqual(env['CHICORY_TEST_DIRECT_FUNDING'], '1')
        self.assertEqual(env['BEIGNET_EVIDENCE_FILE'], '/tmp/evidence')
        for key in ('CHICORY_DF_ONLY_FRESH', 'CHICORY_TEST_IOS', 'CHICORY_KEEP_TEST_STATE', 'LFBW_PRIMARY'):
            self.assertNotIn(key, env)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chicory-runner-cleanup-test-')
        self.addCleanup(self.temp.cleanup)
        self.resources = Path(self.temp.name) / 'resources.jsonl'
        self.name = 'ldk-umbrel-funded-' + 'c' * 14
        self.volume = self.name + '-data'
        self.item = {'container': self.name, 'volume': self.volume, 'architecture': 'arm64'}

    def save(self, items):
        self.resources.write_text(''.join(json.dumps(item) + '\n' for item in items))

    def test_invalid_records_never_reach_docker(self):
        for changes in ({'container': 'user-wallet'}, {'volume': 'user-data'}, {'architecture': 'amd64'}):
            with self.subTest(changes=changes):
                self.save([self.item, {**self.item, **changes}])
                with patch.object(runner, 'docker') as docker:
                    with self.assertRaises(ValueError):
                        runner.cleanup_resources(self.resources, 'arm64', IMAGE)
                docker.assert_not_called()

    def test_cleanup_only_removes_recorded_container_and_its_data_volume(self):
        self.save([self.item, self.item])
        calls = []
        def docker(*args, **kwargs):
            calls.append(args)
            if args[:2] == ('container', 'inspect'):
                return json.dumps([{'Config': {'Image': IMAGE}, 'Mounts': [{'Name': self.volume, 'Destination': '/data'}]}])
            return '[]'
        with patch.object(runner, 'docker', side_effect=docker):
            result = runner.cleanup_resources(self.resources, 'arm64', IMAGE)
        self.assertEqual(result, {'removed': [{'container': self.name, 'volume': self.volume}], 'errors': []})
        self.assertEqual(calls, [
            ('container', 'inspect', self.name), ('rm', '--force', self.name),
            ('volume', 'inspect', self.volume), ('volume', 'rm', self.volume),
        ])

    def test_mismatched_ownership_preserves_both_resources(self):
        self.save([self.item])
        other = json.dumps([{'Config': {'Image': 'unrelated-image'}, 'Mounts': []}])
        with patch.object(runner, 'docker', return_value=other) as docker:
            result = runner.cleanup_resources(self.resources, 'arm64', IMAGE)
        self.assertEqual(result['removed'], [])
        self.assertEqual(len(result['errors']), 1)
        self.assertEqual(docker.call_count, 1)


class SuiteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chicory-runner-suite-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.native = self.root / 'native'
        self.chicory = self.root / 'chicory'
        self.payer = self.root / 'payer'
        self.output = self.root / 'evidence'
        self.files = {
            'native_driver': self.native / 'scripts/chicory-portable-interop.cjs',
            'portable_bundle': self.chicory / 'node_modules/@beignet/portable-engine/dist/portable.cjs',
            'wallet_core': self.chicory / 'node_modules/@beignet/wallet-core/src/index.js',
            'payer_entry': self.payer / 'dist/cli/beignet-node.js',
            'portable_package': self.chicory / 'node_modules/@beignet/portable-engine/package.json',
            'wallet_core_package': self.chicory / 'node_modules/@beignet/wallet-core/package.json',
            'wallet_core_module': self.chicory / 'node_modules/@beignet/wallet-core/src/direct-funding.js',
            'portable_receipts': self.chicory / 'node_modules/@beignet/portable-engine/dist/receipts.cjs',
        }
        for name, file in self.files.items():
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('stub-' + name)
        self.adapter = Path(runner.__file__).resolve().with_name('fixture-primary.cjs')
        self.hashes = {key: runner.digest(self.files[key]) for key in ('portable_bundle', 'wallet_core')}
        self.hashes['fixture_adapter'] = runner.digest(self.adapter)
        self.calls = []

    def args(self, scenarios):
        args = [
            '--image', IMAGE, '--architecture', 'arm64', '--native-source', str(self.native),
            '--chicory-source', str(self.chicory), '--beignet-source', str(self.payer),
            '--bitcoin-container', 'fixture-core', '--primary-chain-url', 'rpc://fixture-user:secret-value@127.0.0.1:18443',
            '--electrum-url', 'tcp://127.0.0.1:50001', '--output-dir', str(self.output),
        ]
        for name in scenarios:
            args.extend(['--scenario', name])
        return args

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        if args[:2] == ('image', 'inspect'):
            return json.dumps([{'Id': IMAGE_ID, 'Architecture': 'arm64', 'Os': 'linux'}])
        if args[:2] == ('exec', 'fixture-core') and args[-1] == 'getblockchaininfo':
            return json.dumps({'chain': 'regtest'})
        self.fail('Unexpected Docker operation: ' + repr(args[:2]))

    def run_suite(self, scenarios, failure=None, wrong_chain=False):
        invoked = []
        def run_process(command, cwd, env, log_file, timeout, redact):
            name = log_file.stem
            invoked.append(name)
            fixture = passing_fixture(name, self.hashes)
            fixture['password'] = 'unknown-auth-value'
            if failure == name:
                fixture['checks'] = []
            Path(env['BEIGNET_EVIDENCE_FILE']).write_text(json.dumps(fixture))
            log_file.write_text(redact('PASS stub scenario\npassword: unknown-auth-value\n'))
            return 0
        def docker(*args, **kwargs):
            if wrong_chain and args[0] == 'exec':
                return json.dumps({'chain': 'main'})
            return self.docker(*args, **kwargs)
        with patch.object(runner, 'docker', side_effect=docker), \
                patch.object(runner, 'repo_state', return_value={'revision': 'b' * 40, 'tracked_changes': True}), \
                patch.object(runner, 'run_process', side_effect=run_process), \
                contextlib.redirect_stdout(io.StringIO()):
            exit_code = runner.main(self.args(scenarios))
        return exit_code, invoked, json.loads((self.output / 'summary.json').read_text())

    def test_selected_passes_keep_precise_provenance_without_release_claim(self):
        exit_code, invoked, report = self.run_suite(['direct-funding', 'drain'])
        self.assertEqual(exit_code, 0)
        self.assertEqual(invoked, ['direct-funding', 'drain'])
        self.assertTrue(report['passed'])
        self.assertFalse(report['full_matrix_selected'])
        self.assertFalse(report['published_release_qualified'])
        self.assertEqual(report['provenance']['image']['id'], IMAGE_ID)
        self.assertEqual(report['provenance']['sha256']['wallet-core/src/direct-funding.js'], runner.digest(self.files['wallet_core_module']))
        self.assertEqual(report['provenance']['sha256']['portable-engine/dist/receipts.cjs'], runner.digest(self.files['portable_receipts']))
        self.assertEqual(report['provenance']['sha256']['portable_package'], runner.digest(self.files['portable_package']))
        self.assertEqual(report['provenance']['sha256']['matrix_runner'], runner.digest(runner.__file__))
        for name in invoked:
            scenario = json.loads((self.output / (name + '.json')).read_text())
            self.assertTrue(scenario['passed'])
            self.assertEqual(scenario['log'], name + '.log')
            self.assertEqual(scenario['provenance'], report['provenance'])
        for file in self.output.iterdir():
            for secret in ('unknown-auth-value', 'secret-value', 'fixture-user'):
                self.assertNotIn(secret, file.read_text())
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)

    def test_failed_scenario_stops_and_cannot_qualify_unrun_scenarios(self):
        exit_code, invoked, report = self.run_suite(['direct-funding', 'drain'], failure='direct-funding')
        self.assertEqual(exit_code, 1)
        self.assertEqual(invoked, ['direct-funding'])
        self.assertFalse(report['passed'])
        self.assertFalse(report['results'][0]['passed'])
        self.assertIn('Missing scenario check:', report['results'][0]['reasons'][0])
        self.assertTrue((self.output / 'direct-funding.log').exists())
        self.assertFalse((self.output / 'drain.json').exists())

    def test_non_regtest_chain_never_starts_the_funded_driver(self):
        exit_code, invoked, report = self.run_suite(['drain'], wrong_chain=True)
        self.assertEqual(exit_code, 1)
        self.assertEqual(invoked, [])
        self.assertFalse(report['passed'])
        self.assertIn('Refusing funded scenarios outside regtest', report['results'][0]['reasons'])


if __name__ == '__main__':
    unittest.main()
