import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WalletManager } from './wallets.mjs';
import { Authentication } from './auth.mjs';
import { createServer } from './index.mjs';
import { atomicJson } from './files.mjs';

const config = { name: 'Delete test', network: 'regtest', chain_source: { type: 'electrum', url: 'tcp://127.0.0.1:50001' }, autostart: false };
const confirmation = wallet => ({ confirmation_name: wallet.name, acknowledge_data_loss: true });
const unavailable = { code: 'DELETE_PENDING' };

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-wallet-deletion-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const manager = new WalletManager({ dataDir, binary: '/unused', ...options });
  await manager.initialize();
  const wallet = await manager.create(config);
  return { manager, wallet, dataDir, directory: path.join(dataDir, 'wallets', wallet.id), registry: path.join(dataDir, 'wallets.json') };
}

async function snapshot(directory) {
  const entries = [];
  async function walk(relative) {
    for (const name of (await fs.readdir(path.join(directory, relative))).sort()) {
      const child = path.join(relative, name); const stat = await fs.lstat(path.join(directory, child));
      entries.push([child, stat.mode, stat.isFile() ? (await fs.readFile(path.join(directory, child))).toString('base64') : null]);
      if (stat.isDirectory()) await walk(child);
    }
  }
  await walk(''); return entries;
}

test('confirmed deletion removes only the selected private wallet and releases its slot after restart', async t => {
  const { manager, wallet, dataDir, directory, registry } = await fixture(t);
  const sibling = await manager.create({ ...config, name: 'Surviving wallet' });
  const siblingDir = manager.directory(sibling.id);
  const before = await snapshot(siblingDir);
  await fs.writeFile(path.join(dataDir, 'auth.json'), 'private dashboard credentials', { mode: 0o600 });
  for (const [name, value] of [['iroh.key', 'iroh identity'], ['tor/onion/key', 'tor identity'], ['tor/data/state', 'guard state']]) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(directory, name), value, { mode: 0o600 });
  }
  // A sibling can remain running while the selected wallet is stopped.
  manager.runtime.set(sibling.id, { status: 'running', process: { closed: false } });
  assert.deepEqual(await manager.remove(wallet.id, confirmation(wallet)), { deleted: true, id: wallet.id });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.deepEqual(await snapshot(siblingDir), before);
  assert.equal(await fs.readFile(path.join(dataDir, 'auth.json'), 'utf8'), 'private dashboard credentials');
  assert.deepEqual(JSON.parse(await fs.readFile(registry)).map(item => item.id), [sibling.id]);
  const restarted = new WalletManager({ dataDir, binary: '/unused' }); await restarted.initialize();
  assert.deepEqual(restarted.list().map(item => item.id), [sibling.id]);
  const replacement = await restarted.create({ ...config, name: 'New wallet' });
  assert.equal(replacement.slot, wallet.slot); assert.notEqual(replacement.id, wallet.id);
  assert.deepEqual(await snapshot(siblingDir), before);
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'NOT_FOUND' });
});

test('confirmation requires exact current name and a literal acknowledgment without touching timers or files', async t => {
  const { manager, wallet, directory, registry } = await fixture(t);
  const before = await snapshot(directory); const saved = await fs.readFile(registry);
  let restarted = false;
  const timer = setTimeout(() => { restarted = true; }, 30);
  manager.runtime.set(wallet.id, { status: 'failed', restartTimer: timer });
  const invalid = [undefined, {}, [], null, { confirmation_name: wallet.name }, { confirmation_name: wallet.name, acknowledge_data_loss: 'true' }, { confirmation_name: ` ${wallet.name}`, acknowledge_data_loss: true }, { confirmation_name: wallet.name.toLowerCase(), acknowledge_data_loss: true }];
  for (const input of invalid) await assert.rejects(manager.remove(wallet.id, input), { code: 'CONFIRMATION_REQUIRED' });
  await delay(35); assert.equal(restarted, true);
  assert.deepEqual(await snapshot(directory), before); assert.deepEqual(await fs.readFile(registry), saved);
  assert.equal(manager.deleting.size, 0); assert.equal(manager.get(wallet.id).deletion_pending, undefined);
});

test('all active states, startup preparation and live native children block deletion before registry writes', async t => {
  const { manager, wallet, directory, registry } = await fixture(t);
  const saved = await fs.readFile(registry); const before = await snapshot(directory);
  for (const state of [
    { status: 'running' }, { status: 'starting' }, { status: 'stopping' },
    { status: 'stopped', startupInFlight: true },
    { status: 'failed', process: { closed: false } },
    { status: 'stopped', process: { closed: true, child: { pid: 42, exitCode: null, signalCode: null } } },
    { status: 'stopped', tor: { closed: false } },
    { status: 'stopped', tor: { closed: true, startupInFlight: true } },
    { status: 'stopped', iroh: { child: { pid: 43, exitCode: null, signalCode: null } } },
  ]) {
    manager.runtime.set(wallet.id, state);
    await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'STOP_REQUIRED' });
  }
  assert.deepEqual(await fs.readFile(registry), saved); assert.deepEqual(await snapshot(directory), before);
});

test('detached native, Iroh and Tor ownership blocks only its registered wallet until writers exit', async t => {
  const { manager, wallet } = await fixture(t);
  const sibling = await manager.create({ ...config, name: 'Sibling' });
  const native = { closed: true, child: { pid: 44, exitCode: null, signalCode: null } };
  const iroh = {}; const tor = {};
  manager.nativeProcesses.set(native, wallet.id);
  manager.writerOwners.set(iroh, wallet.id); manager.irohChildren.add(iroh);
  manager.writerOwners.set(tor, wallet.id); manager.torProcesses.add(tor);
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'STOP_REQUIRED' });
  assert.equal((await manager.remove(sibling.id, confirmation(sibling))).deleted, true);
  native.child.exitCode = 0;
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'STOP_REQUIRED' });
  manager.irohChildren.delete(iroh);
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'STOP_REQUIRED' });
  manager.torProcesses.delete(tor);
  assert.equal((await manager.remove(wallet.id, confirmation(wallet))).deleted, true);
});

test('deletion and backup admission are mutually exclusive', async t => {
  const entered = gate(); const release = gate();
  const { manager, wallet } = await fixture(t, { backupFactory: async () => { entered.resolve(); await release.promise; return Buffer.from('encrypted'); } });
  const backup = manager.backup('test backup password'); await entered.promise;
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'BACKUP_BUSY' });
  release.resolve(); await backup;
  const holding = gate(); const queued = manager.exclusive(() => holding.promise);
  const deleting = manager.remove(wallet.id, confirmation(wallet));
  await assert.rejects(manager.backup('test backup password'), unavailable);
  holding.resolve(); await queued; await deleting;
});

test('shutdown refuses new or queued deletion without creating a pending record', async t => {
  const { manager, wallet, directory } = await fixture(t);
  manager.shuttingDown = true;
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'SHUTTING_DOWN' });
  manager.shuttingDown = false;
  const hold = gate(); const queued = manager.exclusive(() => hold.promise);
  const removal = manager.remove(wallet.id, confirmation(wallet));
  const refused = assert.rejects(removal, { code: 'SHUTTING_DOWN' });
  manager.shuttingDown = true; hold.resolve(); await queued; await refused;
  assert.equal(manager.get(wallet.id).deletion_pending, undefined);
  assert.equal(manager.deleting.size, 0); assert.equal((await fs.stat(directory)).isDirectory(), true);
});

test('the synchronous deletion guard blocks start, stop, update, recovery and a second deletion', async t => {
  const { manager, wallet } = await fixture(t);
  const hold = gate(); const queued = manager.exclusive(() => hold.promise);
  const removing = manager.remove(wallet.id, confirmation(wallet));
  assert.equal(manager.list()[0].status, 'deletion_pending');
  for (const action of [() => manager.start(wallet.id), () => manager.stop(wallet.id), () => manager.update(wallet.id, config), () => manager.recovery(wallet.id), () => manager.remove(wallet.id, confirmation(wallet))]) await assert.rejects(action(), unavailable);
  hold.resolve(); await queued; await removing;
});

test('a preceding rename revalidates confirmation and cannot accidentally delete the newly named wallet', async t => {
  const { manager, wallet, directory } = await fixture(t);
  const hold = gate(); const entered = gate(); const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to.endsWith('wallets.json')) { entered.resolve(); await hold.promise; }
    return rename(from, to);
  });
  const updating = manager.update(wallet.id, { ...config, name: 'Renamed' }); await entered.promise;
  const removing = manager.remove(wallet.id, confirmation(wallet));
  const refused = assert.rejects(removing, { code: 'CONFIRMATION_REQUIRED' });
  hold.resolve(); await updating; await refused;
  assert.equal(manager.get(wallet.id).name, 'Renamed'); assert.equal(manager.get(wallet.id).deletion_pending, undefined);
  assert.equal((await fs.stat(directory)).isDirectory(), true);
});

test('pending startup writers remain protected even after stop changes the visible status', async t => {
  const entered = gate(); const release = gate();
  const { manager, wallet } = await fixture(t, { electrumCheck: async () => { entered.resolve(); await release.promise; } });
  const startup = manager.start(wallet.id); await entered.promise;
  await manager.stop(wallet.id);
  assert.equal(manager.state(wallet.id).status, 'stopped');
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'STOP_REQUIRED' });
  release.resolve(); await startup;
  assert.equal((await manager.remove(wallet.id, confirmation(wallet))).deleted, true);
});

test('a detached native child remains owned after wrapper completion and a replacement runtime', async t => {
  let native;
  class Native extends EventEmitter {
    constructor() { super(); this.closed = false; this.child = new EventEmitter(); Object.assign(this.child, { pid: 45, exitCode: null, signalCode: null }); }
    async start() { return { node_id: `02${'ab'.repeat(32)}` }; }
  }
  const { manager, wallet } = await fixture(t, { processFactory: () => { native = new Native(); return native; } });
  await manager.start(wallet.id);
  native.closed = true; native.emit('exit');
  manager.runtime.set(wallet.id, { status: 'stopped' });
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'STOP_REQUIRED' });
  native.child.exitCode = 0; native.child.emit('exit');
  assert.equal((await manager.remove(wallet.id, confirmation(wallet))).deleted, true);
});

test('unsafe links, shared files, public paths and unregistered IDs cannot select data for deletion', async t => {
  for (const kind of ['root-link', 'nested-link', 'hardlink', 'public-file', 'public-root', 'parent-link']) await t.test(kind, async t => {
    const { manager, wallet, dataDir, directory, registry } = await fixture(t);
    const sibling = await manager.create({ ...config, name: 'Untouched' }); const siblingDir = manager.directory(sibling.id);
    const before = await snapshot(siblingDir); const registryBefore = await fs.readFile(registry);
    if (kind === 'root-link') { await fs.rename(directory, `${directory}.saved`); await fs.symlink(siblingDir, directory); }
    if (kind === 'nested-link') await fs.symlink(siblingDir, path.join(directory, 'alias'));
    if (kind === 'hardlink') await fs.link(path.join(siblingDir, 'mnemonic'), path.join(directory, 'shared'));
    if (kind === 'public-file') await fs.chmod(path.join(directory, 'mnemonic'), 0o644);
    if (kind === 'public-root') await fs.chmod(directory, 0o755);
    if (kind === 'parent-link') { await fs.rename(path.join(dataDir, 'wallets'), path.join(dataDir, 'saved-wallets')); await fs.symlink(path.join(dataDir, 'saved-wallets'), path.join(dataDir, 'wallets')); }
    await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'WALLET_PATH_UNSAFE' });
    assert.deepEqual(await fs.readFile(registry), registryBefore);
    if (kind === 'hardlink') await fs.unlink(path.join(directory, 'shared'));
    assert.deepEqual(await snapshot(siblingDir), before);
    await assert.rejects(manager.remove('../auth.json', confirmation(wallet)), { code: 'NOT_FOUND' });
  });
});

test('an initial intent write failure removes no data and keeps a retryable slot reservation', async t => {
  const { manager, wallet, dataDir, directory, registry } = await fixture(t);
  const before = await snapshot(directory); const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === registry) throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'DELETE_INCOMPLETE' });
  assert.deepEqual(await snapshot(directory), before);
  assert.equal(manager.get(wallet.id).deletion_pending, true);
  assert.equal(manager.list()[0].status, 'deletion_pending');
  assert.deepEqual((await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);
  assert.equal(JSON.parse(await fs.readFile(registry))[0].deletion_pending, undefined);
  t.mock.restoreAll();
  const next = await manager.create({ ...config, name: 'Reserved slot check' }); assert.equal(next.slot, 1);
  for (const action of [() => manager.start(wallet.id), () => manager.update(wallet.id, config), () => manager.recovery(wallet.id), () => manager.backup('test backup password')]) await assert.rejects(action(), unavailable);
  assert.equal((await manager.remove(wallet.id, confirmation(wallet))).deleted, true);
});

test('partial cleanup persists deletion intent across restart and requires a confirmed retry', async t => {
  const { manager, wallet, dataDir, directory } = await fixture(t);
  await manager.update(wallet.id, { ...config, autostart: true });
  const rm = fs.rm.bind(fs);
  t.mock.method(fs, 'rm', async (file, options) => {
    if (file === directory) { await fs.unlink(path.join(directory, 'mnemonic')); throw new Error('fixture partial removal'); }
    return rm(file, options);
  });
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'DELETE_INCOMPLETE' });
  t.mock.restoreAll();
  let starts = 0;
  const restarted = new WalletManager({ dataDir, binary: '/unused', processFactory: () => { starts++; throw new Error('must not start'); } });
  await restarted.initialize(); await restarted.boot();
  assert.equal(starts, 0); assert.equal(restarted.list()[0].status, 'deletion_pending');
  await assert.rejects(restarted.remove(wallet.id, { confirmation_name: wallet.name }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(restarted.start(wallet.id), unavailable);
  assert.equal((await restarted.create({ ...config, name: 'After interruption' })).slot, 1);
  assert.deepEqual(await restarted.remove(wallet.id, confirmation(wallet)), { deleted: true, id: wallet.id });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('registry fsync ambiguity at either transition never claims success or removes data before durable intent', async t => {
  for (const failingWrite of [1, 2]) await t.test(`registry write ${failingWrite}`, async t => {
    const { manager, wallet, dataDir, directory, registry } = await fixture(t);
    const open = fs.open.bind(fs); let writes = 0;
    t.mock.method(fs, 'open', async (file, ...args) => {
      const handle = await open(file, ...args);
      if (file === dataDir && ++writes === failingWrite) handle.sync = async () => { throw new Error('fixture directory fsync failure'); };
      return handle;
    });
    await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'DELETE_INCOMPLETE' });
    assert.equal(manager.get(wallet.id).deletion_pending, true);
    const saved = JSON.parse(await fs.readFile(registry));
    if (failingWrite === 1) { assert.equal(saved[0].deletion_pending, true); assert.equal((await fs.stat(path.join(directory, 'mnemonic'))).isFile(), true); }
    else { assert.deepEqual(saved, []); await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); }
    const restarted = new WalletManager({ dataDir, binary: '/unused' }); await restarted.initialize();
    assert.equal(restarted.list().length, failingWrite === 1 ? 1 : 0);
    if (failingWrite === 1) await assert.rejects(restarted.start(wallet.id), unavailable);
    assert.deepEqual((await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp')), []);
    t.mock.restoreAll();
    assert.deepEqual(await manager.remove(wallet.id, confirmation(wallet)), { deleted: true, id: wallet.id });
    assert.deepEqual(JSON.parse(await fs.readFile(registry)), []);
  });
});

test('a failed final registry rename retains the pending record even after the directory is gone', async t => {
  const { manager, wallet, directory, registry } = await fixture(t);
  const rename = fs.rename.bind(fs); let writes = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === registry && ++writes === 2) throw new Error('fixture final rename failure');
    return rename(from, to);
  });
  await assert.rejects(manager.remove(wallet.id, confirmation(wallet)), { code: 'DELETE_INCOMPLETE' });
  assert.equal(JSON.parse(await fs.readFile(registry))[0].deletion_pending, true);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  t.mock.restoreAll();
  assert.equal((await manager.remove(wallet.id, confirmation(wallet))).deleted, true);
});

test('registry loading rejects nonboolean deletion markers', async t => {
  const { dataDir, registry } = await fixture(t);
  const saved = JSON.parse(await fs.readFile(registry));
  for (const marker of ['true', 1, null, {}, []]) {
    await atomicJson(registry, [{ ...saved[0], deletion_pending: marker }]);
    const manager = new WalletManager({ dataDir, binary: '/unused' });
    await assert.rejects(manager.initialize(), /Invalid wallet deletion marker/);
  }
});

test('atomic JSON cleans only its own temporary file and preserves the original failure', async t => {
  const { dataDir } = await fixture(t);
  const file = path.join(dataDir, 'test.json'); const unrelated = `${file}.existing.tmp`;
  await fs.writeFile(unrelated, 'not owned by this call', { mode: 0o600 });
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (name, ...args) => {
    const handle = await open(name, ...args);
    if (name.startsWith(`${file}.`) && name.endsWith('.tmp')) handle.writeFile = async () => { throw new Error('original write failure'); };
    return handle;
  });
  await assert.rejects(atomicJson(file, { private: 'fixture' }), /original write failure/);
  assert.deepEqual((await fs.readdir(dataDir)).filter(name => name.startsWith('test.json')), ['test.json.existing.tmp']);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'not owned by this call');
});

test('DELETE HTTP route enforces host, session proof, origin, CSRF, JSON and exact confirmation', async t => {
  const { manager, wallet, dataDir, directory } = await fixture(t);
  const password = 'wallet-deletion-test-password';
  const auth = new Authentication({ dataDir }); await auth.initialize(undefined, password);
  const server = createServer({ auth, wallets: manager, allowedHosts: new Set(['127.0.0.1']) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { auth.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`; const url = `${origin}/api/wallets/${wallet.id}`;
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const session = await login.json();
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json', 'x-session-proof': session.proof, 'x-csrf-token': session.csrf };
  const request = (overrides = {}, value = confirmation(wallet)) => fetch(url, { method: 'DELETE', headers: { ...headers, ...overrides }, body: typeof value === 'string' ? value : JSON.stringify(value) });
  assert.equal((await request({ cookie: '' })).status, 401);
  assert.equal((await request({ 'x-session-proof': '' })).status, 401);
  assert.equal((await request({ 'x-csrf-token': '' })).status, 403);
  assert.equal((await request({ origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request({ origin: '' })).status, 403);
  assert.equal((await request({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request({}, '{')).status, 400);
  assert.equal((await request({}, { confirmation_name: wallet.name, acknowledge_data_loss: false })).status, 400);
  const wrongHost = await new Promise((resolve, reject) => { const req = http.request(url, { method: 'DELETE', headers: { ...headers, host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(JSON.stringify(confirmation(wallet))); });
  assert.equal(wrongHost, 403); assert.equal((await fs.stat(directory)).isDirectory(), true);
  manager.runtime.set(wallet.id, { status: 'running' }); assert.equal((await request()).status, 409);
  manager.runtime.delete(wallet.id);
  const deleted = await request(); assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { deleted: true, id: wallet.id });
  assert.equal((await request()).status, 404);
});
