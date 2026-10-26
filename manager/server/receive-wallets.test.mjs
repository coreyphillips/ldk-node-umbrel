import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { bech32 } from '@scure/base';
import { WalletManager } from './wallets.mjs';
import { atomicJson } from './files.mjs';

const nodeId = `02${'ab'.repeat(32)}`;
const config = { name: 'Receive test', network: 'regtest', chain_source: { type: 'electrum', url: 'tcp://127.0.0.1:50001' }, autostart: false };
const address = n => bech32.encode('bcrt', [0, ...bech32.toWords(Buffer.alloc(20, n))]);
const confirmation = wallet => ({ confirmation_name: wallet.name, acknowledge_data_loss: true });
const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
class FakeNative extends EventEmitter {
  constructor() { super(); this.closed = false; this.logs = []; this.calls = []; this.nextAddress = address(1); }
  async start() { return { node_id: nodeId, network: 'regtest' }; }
  async stop() { this.closed = true; this.emit('exit'); }
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'address') return this.addressGate ? this.addressGate.promise : { address: this.nextAddress };
    if (method === 'sync') { this.emit('sync_started'); this.emit('sync_settled'); }
    return {};
  }
}
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-receive-wallets-'));
  const watchers = []; const timers = new Map(); let timerId = 0;
  const manager = new WalletManager({
    dataDir, binary: '/unused', processFactory: () => new FakeNative(),
    receiveSyncOptions: { setTimer(action) { const id = ++timerId; timers.set(id, action); return id; }, clearTimer: id => timers.delete(id) },
    receiveWatcherFactory: options => {
      const watcher = { options, updates: [], started: false, closed: false, start() { this.started = true; }, update(addresses) { this.updates.push([...addresses]); }, close() { this.closed = true; } };
      watchers.push(watcher); return watcher;
    }, ...options,
  });
  t.after(async () => { await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await manager.initialize(); const wallet = await manager.create(config);
  const file = path.join(manager.directory(wallet.id), 'receive-addresses.json');
  const tick = async () => { for (const [id, action] of [...timers]) { timers.delete(id); action(); } await turn(); };
  return { manager, wallet, file, watchers, timers, tick, dataDir };
}

test('only native-generated addresses enter a private bounded persisted watch list', async t => {
  const { manager, wallet, file, watchers } = await fixture(t); await manager.start(wallet.id);
  const native = manager.state(wallet.id).process; assert.equal(watchers[0].started, true);
  assert.deepEqual(watchers[0].options.chainSource, config.chain_source); assert.equal(watchers[0].options.network, 'regtest'); assert.deepEqual(watchers[0].options.addresses, []);
  for (let n = 1; n <= 18; n++) { native.nextAddress = address(n); assert.deepEqual(await manager.call(wallet.id, 'address', { address: address(99) }), { address: address(n) }); }
  native.nextAddress = address(3); await manager.call(wallet.id, 'address');
  const expected = [...Array.from({ length: 15 }, (_, n) => address(n + 4)), address(3)];
  assert.deepEqual(JSON.parse(await fs.readFile(file)), { version: 1, network: 'regtest', addresses: expected });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.deepEqual(watchers[0].updates.at(-1), expected);
  assert.equal(expected.includes(address(99)), false); assert.equal(native.calls.every(call => call.method === 'address'), true);
  native.nextAddress = 'invalid'; assert.deepEqual(await manager.call(wallet.id, 'address'), { address: 'invalid' });
  assert.deepEqual(JSON.parse(await fs.readFile(file)).addresses, expected); assert.match(manager.logs(wallet.id), /could not be saved/);
});

test('manager restart restores selected wallet watches with no cross-wallet registration', async t => {
  const { manager, wallet, watchers, dataDir } = await fixture(t); const sibling = await manager.create({ ...config, name: 'Sibling' });
  await manager.start(wallet.id); await manager.start(sibling.id); await manager.call(wallet.id, 'address');
  assert.equal(watchers[1].updates.length, 0); await manager.close(); assert.equal(watchers.every(item => item.closed), true);
  const restartedWatchers = [];
  const restarted = new WalletManager({ dataDir, binary: '/unused', processFactory: () => new FakeNative(), receiveWatcherFactory: options => { restartedWatchers.push(options); return { start() {}, close() {} }; } });
  t.after(() => restarted.close()); await restarted.initialize(); await restarted.start(wallet.id); await restarted.start(sibling.id);
  assert.deepEqual(restartedWatchers[0].addresses, [address(1)]); assert.deepEqual(restartedWatchers[1].addresses, []);
});

test('Bitcoin Core retains receive addresses without adding a watcher or sync scheduler', async t => {
  const { manager, wallet, file, watchers } = await fixture(t);
  await manager.update(wallet.id, { ...config, chain_source: { type: 'bitcoind', host: 'bitcoin', port: 18443, user: 'fixture', password: 'fixture' } });
  await manager.start(wallet.id); await manager.call(wallet.id, 'address'); assert.equal(watchers.length, 0);
  assert.equal(manager.state(wallet.id).receiveSync, undefined); assert.deepEqual(JSON.parse(await fs.readFile(file)).addresses, [address(1)]);
});

for (const saved of ['invalid json', JSON.stringify({ version: 1, network: 'bitcoin', addresses: [address(1)] }), JSON.stringify({ version: 1, network: 'regtest', addresses: [address(1), address(1)] })]) {
  test(`corrupt or mismatched watch state is preserved and native startup still succeeds: ${saved.slice(0, 30)}`, async t => {
    const { manager, wallet, file, watchers } = await fixture(t); await fs.writeFile(file, saved, { mode: 0o600 });
    await manager.start(wallet.id); assert.equal(manager.state(wallet.id).status, 'running'); assert.match(manager.logs(wallet.id), /could not be loaded/);
    await manager.call(wallet.id, 'address'); assert.deepEqual(watchers[0].updates, [[address(1)]]); assert.equal(await fs.readFile(file, 'utf8'), saved);
  });
}

for (const ending of ['stop', 'fault', 'exit']) test(`${ending} closes observers and invalidates already queued hints`, async t => {
  const { manager, wallet, watchers, timers, tick } = await fixture(t); await manager.start(wallet.id);
  const native = manager.state(wallet.id).process; const observer = watchers[0]; observer.options.onChange(); assert.equal(timers.size, 1);
  if (ending === 'stop') await manager.stop(wallet.id);
  else if (ending === 'fault') native.emit('fault', 'Fixture durability failure');
  else await native.stop();
  assert.equal(observer.closed, true); assert.equal(timers.size, 0); observer.options.onChange(); await tick();
  assert.equal(native.calls.length, 0); assert.equal(native.listenerCount('sync_started'), 0); assert.equal(native.listenerCount('sync_settled'), 0);
});

test('active hints request only native sync and old process generations cannot sync replacements', async t => {
  const { manager, wallet, watchers, tick } = await fixture(t); await manager.start(wallet.id);
  const oldNative = manager.state(wallet.id).process; watchers[0].options.onChange(); await tick();
  assert.deepEqual(oldNative.calls, [{ method: 'sync', params: {} }]); await manager.stop(wallet.id); await manager.start(wallet.id);
  watchers[0].options.onChange(); await tick(); assert.equal(manager.state(wallet.id).process.calls.length, 0);
  watchers[1].options.onChange(); await tick(); assert.deepEqual(manager.state(wallet.id).process.calls, [{ method: 'sync', params: {} }]);
});

test('late address results cannot recreate deleted state or attach to another process generation', async t => {
  const { manager, wallet, file, watchers } = await fixture(t); await manager.start(wallet.id);
  const native = manager.state(wallet.id).process; native.addressGate = gate(); const pending = manager.call(wallet.id, 'address');
  await manager.stop(wallet.id); await manager.start(wallet.id); native.addressGate.resolve({ address: address(9) }); await pending;
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }); assert.equal(watchers[1].updates.length, 0);
  const replacement = manager.state(wallet.id).process; replacement.addressGate = gate(); const late = manager.call(wallet.id, 'address');
  await manager.stop(wallet.id); await manager.remove(wallet.id, confirmation(wallet)); replacement.addressGate.resolve({ address: address(10) }); await late;
  await assert.rejects(fs.stat(path.dirname(file)), { code: 'ENOENT' });
});

test('queued cache writes recheck liveness after stop and do not interfere with backup', async t => {
  const { manager, wallet, file } = await fixture(t, { backupFactory: async () => ({ backedUp: true }) }); await manager.start(wallet.id);
  const hold = gate(); const blocker = manager.exclusive(() => hold.promise); const pending = manager.call(wallet.id, 'address'); await turn();
  await manager.stop(wallet.id); const backup = manager.backup('fixture-passphrase'); hold.resolve(); await blocker; await pending;
  assert.deepEqual(await backup, { backedUp: true }); await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('watcher startup and cleanup failures cannot prevent native lifecycle operations', async t => {
  const { manager, wallet } = await fixture(t, { receiveWatcherFactory: () => ({ start() { throw new Error('private backend URL'); }, close() { throw new Error('cleanup failed'); } }) });
  await manager.start(wallet.id); assert.equal(manager.state(wallet.id).status, 'running'); assert.match(manager.logs(wallet.id), /Fast receive monitoring is unavailable/);
  assert.doesNotMatch(manager.logs(wallet.id), /private backend URL|cleanup failed/); assert.equal(manager.state(wallet.id).process.listenerCount('sync_started'), 0);
  await manager.stop(wallet.id); assert.equal(manager.state(wallet.id).process.closed, true);
});

test('startup stays unavailable to address requests while loading saved watches and respects a concurrent stop', async t => {
  const { manager, wallet, watchers } = await fixture(t); const entered = gate(); const hold = gate(); const original = manager.loadReceiveAddresses.bind(manager);
  manager.loadReceiveAddresses = async (...args) => { entered.resolve(); await hold.promise; return original(...args); };
  const starting = manager.start(wallet.id); await entered.promise;
  assert.equal(manager.state(wallet.id).status, 'starting'); assert.throws(() => manager.call(wallet.id, 'address'), { code: 'NODE_STOPPED' });
  await manager.stop(wallet.id); hold.resolve(); assert.deepEqual(await starting, { status: 'stopped' }); assert.equal(watchers.length, 0);
});

test('native exit during watch cache loading fails startup without launching an observer', async t => {
  const { manager, wallet, watchers } = await fixture(t); const original = manager.loadReceiveAddresses.bind(manager);
  manager.loadReceiveAddresses = async (...args) => { await original(...args); await manager.state(wallet.id).process.stop(); };
  await assert.rejects(manager.start(wallet.id), /stopped during startup/); assert.equal(manager.state(wallet.id).status, 'failed'); assert.equal(watchers.length, 0);
});

test('native fault while cache loading cannot promote the process back to running', async t => {
  const { manager, wallet, watchers } = await fixture(t); const original = manager.loadReceiveAddresses.bind(manager);
  manager.loadReceiveAddresses = async (...args) => { await original(...args); const native = manager.state(wallet.id).process; native.faulted = true; native.emit('fault', 'Fixture durability failure'); };
  await assert.rejects(manager.start(wallet.id), { code: 'NODE_FAULT' }); assert.equal(manager.state(wallet.id).status, 'stopping'); assert.equal(watchers.length, 0);
  assert.equal(manager.state(wallet.id).noRestart, true); assert.equal(manager.state(wallet.id).process.closed, false);
  const old = manager.state(wallet.id).process; await assert.rejects(manager.start(wallet.id), /already active/); assert.equal(manager.state(wallet.id).process, old);
  await old.stop(); manager.loadReceiveAddresses = original; await manager.start(wallet.id); assert.notEqual(manager.state(wallet.id).process, old); assert.equal(watchers.length, 1);
});

test('a failed state or closed wrapper cannot admit a second native writer before actual child exit', async t => {
  const { manager, wallet } = await fixture(t); await manager.start(wallet.id); const state = manager.state(wallet.id); const old = state.process;
  state.status = 'failed'; await assert.rejects(manager.start(wallet.id), { code: 'STOP_REQUIRED' });
  old.closed = true; old.child = { pid: 123, exitCode: null, signalCode: null };
  await assert.rejects(manager.start(wallet.id), { code: 'STOP_REQUIRED' });
  // Ownership also protects a child whose runtime wrapper was detached.
  manager.runtime.delete(wallet.id); await assert.rejects(manager.start(wallet.id), { code: 'STOP_REQUIRED' });
  old.child.exitCode = 0; await manager.start(wallet.id); assert.notEqual(manager.state(wallet.id).process, old);
});

test('quick restart waits for an entered old-generation cache write before reading watches', async t => {
  const { manager, wallet, file, watchers } = await fixture(t); await manager.start(wallet.id);
  const entered = gate(); const hold = gate(); const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => { if (to === file) { entered.resolve(); await hold.promise; } return rename(from, to); });
  const pending = manager.call(wallet.id, 'address'); await entered.promise; await manager.stop(wallet.id);
  let restarted = false; const starting = manager.start(wallet.id).then(result => { restarted = true; return result; });
  await turn(); assert.equal(restarted, false); assert.equal(watchers.length, 1);
  hold.resolve(); await pending; await starting;
  assert.deepEqual(watchers[1].options.addresses, [address(1)]);
  manager.state(wallet.id).process.nextAddress = address(2); await manager.call(wallet.id, 'address');
  assert.deepEqual(JSON.parse(await fs.readFile(file)).addresses, [address(1), address(2)]);
});

test('a persisted watch list is included in stopped wallet backup and removed with only that wallet', async t => {
  let archived;
  const { manager, wallet, file } = await fixture(t, { backupFactory: async () => { archived = JSON.parse(await fs.readFile(file)); return {}; } });
  await atomicJson(file, { version: 1, network: 'regtest', addresses: [address(1)] });
  await manager.start(wallet.id); await manager.stop(wallet.id); await manager.backup('fixture-passphrase'); assert.deepEqual(archived.addresses, [address(1)]);
  const sibling = await manager.create({ ...config, name: 'Sibling' }); const siblingFile = path.join(manager.directory(sibling.id), 'receive-addresses.json');
  await atomicJson(siblingFile, { version: 1, network: 'regtest', addresses: [address(2)] });
  await manager.remove(wallet.id, confirmation(wallet)); await assert.rejects(fs.stat(file), { code: 'ENOENT' }); assert.deepEqual(JSON.parse(await fs.readFile(siblingFile)).addresses, [address(2)]);
});
