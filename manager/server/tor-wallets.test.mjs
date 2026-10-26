import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { WalletManager } from './wallets.mjs';
import { walletConfig } from './config.mjs';
import { restoreBackup } from './backup.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const NODE = `02${'ab'.repeat(32)}`;
const ONION = `${'a'.repeat(56)}.onion:9735`;
const config = (changes = {}) => ({ name: 'Tor fixture', network: 'regtest', chain_source: { type: 'electrum', url: 'tcp://127.0.0.1:50001' }, autostart: false, ...changes });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
class Native extends EventEmitter {
  constructor() { super(); this.closed = false; this.logs = []; }
  async start() { return { node_id: NODE, network: 'regtest' }; }
  async stop() { if (!this.closed) { this.closed = true; this.emit('exit'); } }
}
class Tor extends EventEmitter {
  constructor(options, { pendingStart = false, pendingStop = false, fail = false } = {}) {
    super(); this.options = options; this.closed = true; this.startupInFlight = false; this.status = 'stopped'; this.address = null; this.bootstrap = 0; this.fail = fail;
    this.startGate = deferred(); this.stopGate = deferred();
    if (!pendingStart) this.startGate.resolve(); if (!pendingStop) this.stopGate.resolve();
  }
  async start() {
    this.closed = false; this.startupInFlight = true; this.status = 'starting';
    await this.startGate.promise;
    this.startupInFlight = false;
    if (this.stopping) return;
    if (this.fail) { this.closed = true; this.status = 'failed'; this.error = 'Synthetic Tor startup failure'; this.emit('exit'); throw new Error(this.error); }
    this.address = ONION; this.status = 'bootstrapping'; this.bootstrap = 10;
  }
  stop() {
    return this.stopping ||= (async () => {
      this.startGate.resolve(); await this.stopGate.promise;
      this.closed = true; this.startupInFlight = false; this.status = 'stopped'; this.address = null; this.emit('exit');
    })();
  }
}
async function fixture(t, { wallet = {}, torOptions = {}, torBinary = '/fixture/tor', backupFactory } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-tor-wallets-'));
  const tors = [];
  const manager = new WalletManager({ dataDir, binary: '/unused', torBinary, processFactory: () => new Native(), torFactory: options => { const tor = new Tor(options, torOptions); tors.push(tor); return tor; }, backupFactory });
  await manager.initialize();
  manager.wallets = [{ ...walletConfig(config(wallet)), id: ID, slot: 0 }];
  t.after(async () => { for (const tor of tors) { tor.startGate.resolve(); tor.stopGate.resolve(); } await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { manager, tors, dataDir };
}

test('automatic Tor is opt-in, independent of Iroh, and exclusive with an external onion', () => {
  assert.deepEqual(walletConfig(config()).tor, { enabled: false });
  const iroh = { enabled: true, discovery: true, default_relays: true };
  const configured = walletConfig(config({ tor: { enabled: true }, iroh }));
  assert.equal(configured.tor.enabled, true); assert.deepEqual(configured.iroh, iroh);
  assert.throws(() => walletConfig(config({ tor: { enabled: true }, tor_onion_address: ONION })), /not both/);
  assert.equal(walletConfig(config({ tor_onion_address: ONION })).tor_onion_address, ONION);
});

test('missing bundled Tor refuses new opt-in without creating a wallet or rewriting settings', async t => {
  const { manager, dataDir } = await fixture(t, { torBinary: null });
  await assert.rejects(manager.create(config({ tor: { enabled: true } })), { code: 'TOR_UNAVAILABLE' });
  await assert.rejects(manager.update(ID, config({ tor: { enabled: true } })), { code: 'TOR_UNAVAILABLE' });
  assert.equal(manager.wallets.length, 1); assert.equal(manager.get(ID).tor.enabled, false);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'wallets')), []);
  manager.get(ID).tor.enabled = true;
  await manager.update(ID, config({ tor: { enabled: true }, name: 'Keep existing preference' }));
  assert.equal(manager.get(ID).tor.enabled, true);
  await manager.start(ID); assert.equal(manager.state(ID).status, 'running'); assert.equal(manager.list()[0].tor_status, 'failed');
  assert.equal(manager.pairing(ID, 'umbrel.local').tor_uri, null);
});

test('Tor disabled launches no process and preserves legacy external pairing', async t => {
  const { manager, tors } = await fixture(t, { wallet: { tor_onion_address: ONION } });
  await manager.start(ID);
  assert.equal(tors.length, 0);
  const pairing = manager.pairing(ID, 'umbrel.local');
  assert.equal(pairing.tor_uri, `${NODE}@${ONION}`); assert.equal(pairing.tor_managed, false); assert.equal(pairing.tor_status, 'external');
});

test('Tor startup never blocks native or Iroh and uses the private native port', async t => {
  const { manager, tors, dataDir } = await fixture(t, { wallet: { tor: { enabled: true }, iroh: { enabled: true, discovery: true, default_relays: true } }, torOptions: { pendingStart: true } });
  manager.startIroh = async (_wallet, state) => { state.iroh = { ready: true, status: 'ready', uri: 'iroh://fixture' }; };
  assert.deepEqual(await manager.start(ID), { status: 'running' });
  assert.equal(manager.list()[0].tor_status, 'starting'); assert.equal(manager.torProcesses.size, 1);
  assert.equal(tors[0].options.directory, path.join(dataDir, 'wallets', ID, 'tor')); assert.equal(tors[0].options.port, 9735);
  let pairing = manager.pairing(ID, 'umbrel.local');
  assert.equal(pairing.iroh_uri, 'iroh://fixture'); assert.match(pairing.tcp_uri, /:19351$/); assert.equal(pairing.tor_uri, null);
  tors[0].startGate.resolve(); await setImmediate();
  pairing = manager.pairing(ID, 'umbrel.local');
  assert.equal(pairing.tor_uri, `${NODE}@${ONION}`); assert.equal(pairing.tor_managed, true); assert.equal(pairing.tor_status, 'bootstrapping'); assert.equal(pairing.tor_bootstrap, 10);
  assert.equal(pairing.iroh_uri, 'iroh://fixture');
  tors[0].status = 'ready'; tors[0].bootstrap = 100;
  assert.equal(manager.list()[0].tor_status, 'ready');
  assert.equal(JSON.stringify(manager.list()).includes('private_key'), false);
});

test('Tor failures leave the running native wallet usable with no stale onion URI', async t => {
  const { manager } = await fixture(t, { wallet: { tor: { enabled: true } }, torOptions: { fail: true } });
  await manager.start(ID); await setImmediate();
  assert.equal(manager.state(ID).status, 'running'); assert.equal(manager.state(ID).process.closed, false);
  assert.equal(manager.list()[0].tor_status, 'failed'); assert.equal(manager.torProcesses.size, 0);
  assert.equal(manager.pairing(ID, 'umbrel.local').tor_uri, null);
});

test('native exit during pending Tor startup cancels it and retains backup/start guards until actual exit', async t => {
  const { manager, tors } = await fixture(t, { wallet: { tor: { enabled: true } }, torOptions: { pendingStart: true, pendingStop: true }, backupFactory: async () => Buffer.from('snapshot') });
  await manager.start(ID);
  const state = manager.state(ID); state.process.closed = true; state.process.emit('exit');
  await setImmediate();
  assert.equal(state.status, 'failed'); assert.equal(tors[0].address, null); assert.equal(manager.torProcesses.size, 1);
  await assert.rejects(manager.start(ID), /Tor process to stop/);
  const stop = manager.stop(ID); await setImmediate();
  assert.equal(state.status, 'stopping');
  await assert.rejects(manager.backup('test backup password'), { code: 'STOP_REQUIRED' });
  tors[0].stopGate.resolve(); await stop; await setImmediate();
  assert.equal(manager.torProcesses.size, 0); assert.equal(state.status, 'stopped'); assert.equal(tors[0].address, null);
  assert.equal((await manager.backup('test backup password')).toString(), 'snapshot');
});

test('a tracked Tor writer blocks backup even after its runtime state is detached', async t => {
  const { manager, tors } = await fixture(t, { wallet: { tor: { enabled: true } }, torOptions: { pendingStart: true }, backupFactory: async () => Buffer.from('snapshot') });
  await manager.start(ID); const state = manager.state(ID);
  await state.process.stop(); await setImmediate();
  // Retain a fake independent writer to exercise the global gate separately
  // from the registered wallet's ordinary native lifecycle guards.
  const writer = new Tor({}, { pendingStart: true }); manager.torProcesses.add(writer); tors.push(writer);
  manager.runtime.clear();
  await assert.rejects(manager.backup('test backup password'), { code: 'STOP_REQUIRED' });
  manager.torProcesses.delete(writer);
  assert.equal((await manager.backup('test backup password')).toString(), 'snapshot');
});

test('encrypted full backups preserve Tor onion identity and entry guard state', async t => {
  const { manager, dataDir } = await fixture(t, { wallet: { tor: { enabled: true } } });
  const torDir = path.join(dataDir, 'wallets', ID, 'tor');
  await fs.mkdir(path.join(torDir, 'onion'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(torDir, 'data'), { mode: 0o700 });
  const files = { 'onion/hs_ed25519_secret_key': Buffer.from('fixture-only-onion-key'), 'onion/hostname': Buffer.from(ONION.split(':')[0]), 'data/state': Buffer.from('fixture-only-entry-guards'), 'identity.json': Buffer.from(JSON.stringify({ address: ONION })) };
  for (const [name, value] of Object.entries(files)) await fs.writeFile(path.join(torDir, name), value, { mode: 0o600 });
  const archive = await manager.backup('test backup password');
  const restored = path.join(dataDir, 'restored'); await restoreBackup(archive, 'test backup password', restored);
  for (const [name, value] of Object.entries(files)) assert.deepEqual(await fs.readFile(path.join(restored, 'wallets', ID, 'tor', name)), value);
});
