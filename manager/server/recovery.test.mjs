import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createRecovery, readRecovery } from './recovery.mjs';
import { WalletManager } from './wallets.mjs';

const config = { name: 'Recovery test', network: 'regtest', chain_source: { type: 'electrum', url: 'tcp://127.0.0.1:50001' }, autostart: false };
async function directory(t) {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-recovery-test-'));
  t.after(() => fs.rm(result, { recursive: true, force: true }));
  return result;
}
async function manager(t, options = {}) {
  const result = new WalletManager({ dataDir: await directory(t), binary: '/unused', ...options });
  await result.initialize();
  return result;
}

test('new phrases derive the stored native seed with independent BIP39 PBKDF2 verification', async t => {
  const root = await directory(t); const phrases = new Set();
  // Exercise many independent CSPRNG outcomes, network bindings and restart reads.
  for (let i = 0; i < 24; i++) {
    const wallet = path.join(root, `wallet-${i}`);
    const network = ['bitcoin', 'testnet', 'signet', 'regtest'][i % 4];
    await createRecovery(wallet, network);
    const result = await readRecovery(wallet, 'mnemonic');
    assert.equal(result.kind, 'mnemonic'); assert.equal(result.word_count, 24);
    assert.equal(validateMnemonic(result.mnemonic, wordlist), true);
    assert.equal(phrases.has(result.mnemonic), false); phrases.add(result.mnemonic);
    const seed = await fs.readFile(path.join(wallet, 'node/keys_seed'));
    assert.deepEqual(seed, pbkdf2Sync(result.mnemonic.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(wallet, 'node/daemon-network.json'))), { version: 1, network });
    for (const name of ['', 'node']) assert.equal((await fs.stat(path.join(wallet, name))).mode & 0o777, 0o700);
    for (const name of ['mnemonic', 'node/keys_seed', 'node/daemon-network.json']) assert.equal((await fs.stat(path.join(wallet, name))).mode & 0o777, 0o600);
    assert.deepEqual(await readRecovery(wallet, 'mnemonic'), result);
  }
});

test('creation cannot overwrite any existing wallet directory or seed', async t => {
  const root = await directory(t); const wallet = path.join(root, 'wallet');
  await createRecovery(wallet, 'regtest'); const before = await fs.readFile(path.join(wallet, 'node/keys_seed'));
  await assert.rejects(createRecovery(wallet, 'regtest'), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(path.join(wallet, 'node/keys_seed')), before);
  await assert.rejects(createRecovery(path.join(root, 'invalid'), 'unknown'), /network/);
  await assert.rejects(fs.stat(path.join(root, 'invalid')), { code: 'ENOENT' });
  await fs.symlink(wallet, path.join(root, 'alias'));
  await assert.rejects(createRecovery(path.join(root, 'alias', 'child'), 'regtest'), /Unsafe/);
});

test('legacy seed recovery never invents a phrase or changes stored identity', async t => {
  const root = await directory(t); const wallet = path.join(root, 'legacy');
  await fs.mkdir(wallet, { mode: 0o700 }); await fs.mkdir(path.join(wallet, 'node'), { mode: 0o700 });
  const seed = Buffer.alloc(64, 37); await fs.writeFile(path.join(wallet, 'node/keys_seed'), seed, { mode: 0o600 });
  assert.deepEqual(await readRecovery(wallet), { kind: 'legacy_seed' });
  assert.deepEqual(await fs.readFile(path.join(wallet, 'node/keys_seed')), seed);
  assert.deepEqual(await fs.readdir(wallet), ['node']);
  await assert.rejects(readRecovery(wallet, 'mnemonic'), { code: 'RECOVERY_UNAVAILABLE' });
});

test('reveal fails closed for mismatched, corrupt, missing, shared or linked recovery files', async t => {
  const root = await directory(t); const wallet = path.join(root, 'wallet'); const other = path.join(root, 'other');
  await createRecovery(wallet, 'regtest'); await createRecovery(other, 'regtest');
  const phraseFile = path.join(wallet, 'mnemonic'); const original = await fs.readFile(phraseFile);
  const seedFile = path.join(wallet, 'node/keys_seed'); const seed = await fs.readFile(seedFile);
  await fs.copyFile(path.join(other, 'mnemonic'), phraseFile);
  await assert.rejects(readRecovery(wallet, 'mnemonic'), { code: 'RECOVERY_UNAVAILABLE' });
  for (const content of ['', 'abandon '.repeat(24), 'x'.repeat(513)]) {
    await fs.writeFile(phraseFile, content);
    await assert.rejects(readRecovery(wallet, 'mnemonic'), { code: 'RECOVERY_UNAVAILABLE' });
  }
  await fs.writeFile(phraseFile, original); await fs.writeFile(seedFile, seed.subarray(0, 63));
  await assert.rejects(readRecovery(wallet, 'mnemonic'), { code: 'RECOVERY_UNAVAILABLE' });
  await fs.writeFile(seedFile, seed); await fs.chmod(phraseFile, 0o644);
  await assert.rejects(readRecovery(wallet, 'mnemonic'), { code: 'RECOVERY_UNAVAILABLE' });
  await fs.chmod(phraseFile, 0o600); await fs.link(phraseFile, path.join(root, 'hardlink'));
  await assert.rejects(readRecovery(wallet, 'mnemonic'), { code: 'RECOVERY_UNAVAILABLE' });
  await fs.unlink(path.join(root, 'hardlink')); await fs.unlink(phraseFile);
  await fs.symlink(path.join(other, 'mnemonic'), phraseFile);
  await assert.rejects(readRecovery(wallet, 'mnemonic'), { code: 'RECOVERY_UNAVAILABLE' });
  await fs.unlink(phraseFile); await fs.writeFile(phraseFile, original, { mode: 0o600 });
  await fs.rename(path.join(wallet, 'node'), path.join(root, 'saved-node')); await fs.symlink(path.join(root, 'saved-node'), path.join(wallet, 'node'));
  await assert.rejects(readRecovery(wallet, 'mnemonic'), { code: 'RECOVERY_UNAVAILABLE' });
});

test('wallet registry never contains recovery secrets and old entries remain unchanged', async t => {
  const wallets = await manager(t); const created = await wallets.create(config);
  assert.equal(created.recovery_kind, 'mnemonic');
  const recovery = await wallets.recovery(created.id);
  const registry = await fs.readFile(path.join(wallets.dataDir, 'wallets.json'), 'utf8');
  assert.equal(registry.includes(recovery.mnemonic), false);
  assert.equal(JSON.stringify(wallets.list()).includes(recovery.mnemonic), false);
  await wallets.update(created.id, { ...config, name: 'Changed' });
  assert.deepEqual(await wallets.recovery(created.id), recovery);
  const restarted = new WalletManager({ dataDir: wallets.dataDir, binary: '/unused' }); await restarted.initialize();
  assert.deepEqual(await restarted.recovery(created.id), recovery);
  await assert.rejects(wallets.recovery('not-a-wallet'), { code: 'NOT_FOUND' });
  const saved = JSON.parse(await fs.readFile(path.join(wallets.dataDir, 'wallets.json'), 'utf8'));
  delete saved[0].recovery_kind;
  await fs.unlink(path.join(wallets.directory(created.id), 'mnemonic'));
  await fs.writeFile(path.join(wallets.dataDir, 'wallets.json'), JSON.stringify(saved));
  const legacy = new WalletManager({ dataDir: wallets.dataDir, binary: '/unused' }); await legacy.initialize();
  assert.equal(legacy.list()[0].recovery_kind, 'legacy_seed');
  assert.deepEqual(await legacy.recovery(created.id), { kind: 'legacy_seed' });
  assert.equal(await fs.readFile(path.join(wallets.dataDir, 'wallets.json'), 'utf8'), JSON.stringify(saved));
});

test('backup freezes creates, updates, starts, stops and concurrent exports until snapshot completes', async t => {
  let finish; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const wallets = await manager(t, { backupFactory: async () => { entered(); await pending; return Buffer.from('encrypted'); } });
  const wallet = await wallets.create(config);
  const exportPromise = wallets.backup('a long test password'); await started;
  for (const action of [() => wallets.create(config), () => wallets.update(wallet.id, config), () => wallets.start(wallet.id), () => wallets.stop(wallet.id), () => wallets.backup('another test password')]) {
    await assert.rejects(action(), { code: 'BACKUP_BUSY' });
  }
  finish(); assert.equal((await exportPromise).toString(), 'encrypted');
  assert.equal(wallets.backupInProgress, false);
  await wallets.update(wallet.id, { ...config, name: 'After backup' });
});

test('startup refuses missing or mismatched phrase-backed seed material without generating a new identity', async t => {
  let spawned = 0;
  const wallets = await manager(t, { processFactory: () => { spawned++; throw new Error('Must not spawn'); } });
  const wallet = await wallets.create(config); const seedFile = path.join(wallets.directory(wallet.id), 'node/keys_seed');
  await fs.unlink(seedFile);
  await assert.rejects(wallets.start(wallet.id), { code: 'RECOVERY_UNAVAILABLE' });
  await assert.rejects(fs.stat(seedFile), { code: 'ENOENT' });
  await fs.writeFile(seedFile, Buffer.alloc(64, 19), { mode: 0o600 });
  await assert.rejects(wallets.start(wallet.id), { code: 'RECOVERY_UNAVAILABLE' });
  assert.deepEqual(await fs.readFile(seedFile), Buffer.alloc(64, 19));
  assert.equal(spawned, 0);
});

test('backup requires actual process exit and resets its guard after refusal or export failure', async t => {
  let exports = 0;
  const wallets = await manager(t, { backupFactory: async () => { exports++; throw new Error('snapshot failed'); } });
  const wallet = await wallets.create(config);
  for (const state of [
    { status: 'running' }, { status: 'starting' }, { status: 'stopping' }, { status: 'failed' },
    { status: 'stopped', process: { closed: false } },
    { status: 'stopped', process: { closed: true, child: { pid: 123, exitCode: null, signalCode: null } } },
  ]) {
    wallets.runtime.set(wallet.id, state);
    await assert.rejects(wallets.backup('a long test password'), { code: 'STOP_REQUIRED' });
    assert.equal(wallets.backupInProgress, false);
  }
  wallets.runtime.clear(); wallets.irohChildren.add({});
  await assert.rejects(wallets.backup('a long test password'), { code: 'STOP_REQUIRED' });
  wallets.irohChildren.clear();
  assert.equal(exports, 0);
  await assert.rejects(wallets.backup('a long test password'), /snapshot failed/);
  assert.equal(exports, 1); assert.equal(wallets.backupInProgress, false);
  await wallets.create({ ...config, name: 'After failed backup' });
});

test('stop during asynchronous startup cannot permit a backup or a second startup', async t => {
  let release; let entered; let spawned = 0;
  const reached = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const wallets = await manager(t, { processFactory: () => { spawned++; throw new Error('Must not spawn'); }, backupFactory: async () => Buffer.from('encrypted') });
  const wallet = await wallets.create(config);
  const mkdir = fs.mkdir;
  t.mock.method(fs, 'mkdir', async (directory, options) => {
    if (directory === path.join(wallets.directory(wallet.id), 'node')) { entered(); await blocked; }
    return mkdir(directory, options);
  });
  const startup = wallets.start(wallet.id); await reached;
  await wallets.stop(wallet.id);
  assert.equal(wallets.state(wallet.id).status, 'stopped');
  await assert.rejects(wallets.backup('a long test password'), { code: 'STOP_REQUIRED' });
  await assert.rejects(wallets.start(wallet.id), /already active/);
  release(); assert.deepEqual(await startup, { status: 'stopped' });
  assert.equal(spawned, 0);
  assert.equal((await wallets.backup('a long test password')).toString(), 'encrypted');
});
