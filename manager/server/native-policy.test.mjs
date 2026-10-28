import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { WalletManager } from './wallets.mjs';
import { atomicJson } from './files.mjs';
import { walletConfig, publicConfig } from './config.mjs';

const config = {
  name: 'Saved primary', network: 'regtest', autostart: false,
  chain_source: { type: 'bitcoind', host: '127.0.0.1', port: 18443, user: 'fixture', password: 'fixture' },
  chicory: { enabled: true, flat_fee_sat: 123, fee_ppm: 456, max_client_funding_sats: 300000, max_total_fronted_sats: 2000000 },
};

class NativeFixture extends EventEmitter {
  constructor(options) { super(); this.options = options; this.closed = false; this.logs = []; }
  async start() {
    this.config = JSON.parse(await fs.readFile(this.options.config, 'utf8'));
    assert.equal(Object.hasOwn(this.config.chicory, 'offline_enabled'), false);
    return { node_id: `02${'ab'.repeat(32)}`, network: 'regtest' };
  }
  async stop() { this.closed = true; this.emit('exit'); }
}

async function snapshot(directory) {
  const entries = {};
  async function read(parent) {
    for (const item of await fs.readdir(parent, { withFileTypes: true })) {
      const file = path.join(parent, item.name);
      if (item.isDirectory()) await read(file);
      else entries[path.relative(directory, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await read(directory);
  return entries;
}

for (const offline_enabled of [false, true]) {
  test(`saved offline option ${offline_enabled} is omitted only from daemon config and never rewrites custody`, async t => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-native-policy-'));
    const options = { dataDir, binary: '/unused', processFactory: settings => new NativeFixture(settings) };
    const original = new WalletManager(options); await original.initialize();
    const wallet = await original.create(config);
    const sibling = await original.create({ ...config, name: 'Other wallet' });
    await original.close();
    const registry = path.join(dataDir, 'wallets.json');
    const saved = JSON.parse(await fs.readFile(registry, 'utf8'));
    saved[0].chicory.offline_enabled = offline_enabled;
    saved[0].autostart = true;
    await atomicJson(registry, saved);
    const nodeDirectory = path.join(dataDir, 'wallets', wallet.id, 'node');
    await fs.mkdir(path.join(nodeDirectory, 'monitors'), { mode: 0o700 });
    await fs.writeFile(path.join(nodeDirectory, 'channel_manager'), 'opaque legacy custody fixture', { mode: 0o600 });
    await fs.writeFile(path.join(nodeDirectory, 'monitors', 'funding-monitor'), 'opaque monitor fixture', { mode: 0o600 });
    const beforeRegistry = await fs.readFile(registry);
    const beforeNode = await snapshot(nodeDirectory);
    const beforeSibling = await snapshot(path.join(dataDir, 'wallets', sibling.id));
    const manager = new WalletManager(options);
    t.after(async () => { await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
    await manager.initialize(); await manager.boot();
    assert.equal(manager.state(wallet.id).status, 'running');
    assert.equal(manager.state(sibling.id).status, 'stopped');
    const generated = manager.state(wallet.id).process.config;
    assert.deepEqual(generated.chicory, config.chicory);
    assert.equal(generated.network, 'regtest');
    assert.equal(generated.data_dir, nodeDirectory);
    assert.deepEqual(generated.chain_source, config.chain_source);
    assert.equal(Object.hasOwn(manager.list()[0].chicory, 'offline_enabled'), false);
    assert.equal(manager.get(wallet.id).chicory.offline_enabled, offline_enabled);
    assert.deepEqual(await fs.readFile(registry), beforeRegistry);
    assert.deepEqual(await snapshot(nodeDirectory), beforeNode);
    assert.deepEqual(await snapshot(path.join(dataDir, 'wallets', sibling.id)), beforeSibling);
    await manager.stop(wallet.id); await manager.start(wallet.id);
    assert.deepEqual(await fs.readFile(registry), beforeRegistry);
    assert.deepEqual(await snapshot(nodeDirectory), beforeNode);
  });
}

test('new offline requests are refused and disabled legacy options do not enter saved settings', () => {
  assert.throws(() => walletConfig({ ...config, chicory: { ...config.chicory, offline_enabled: true } }), { code: 'OFFLINE_RECEIVE_REMOVED' });
  const normalized = walletConfig({ ...config, chicory: { ...config.chicory, offline_enabled: false } });
  assert.deepEqual(normalized.chicory, config.chicory);
  const saved = { ...normalized, chicory: { ...normalized.chicory, offline_enabled: true } };
  assert.equal(Object.hasOwn(publicConfig(saved).chicory, 'offline_enabled'), false);
  assert.equal(saved.chicory.offline_enabled, true);
});
