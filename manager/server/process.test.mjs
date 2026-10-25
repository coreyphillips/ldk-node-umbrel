import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { NativeProcess } from './rpc.mjs';
import { WalletManager } from './wallets.mjs';
const nodeId = `02${'ab'.repeat(32)}`;
const config = () => ({ name: 'Test node', network: 'regtest', chain_source: { type: 'electrum', url: 'tcp://127.0.0.1:50001' }, autostart: false });
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-dashboard-process-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function nativeFixture(t) {
  const binary = path.join(await directory(t), 'native-fixture.cjs');
  await fs.writeFile(binary, `#!${process.execPath}\nconst readline = require('node:readline');\nconsole.log(JSON.stringify({event:'ready', node_id:'${nodeId}', network:'regtest'}));\nreadline.createInterface({input:process.stdin}).on('line', raw=>{const m=JSON.parse(raw);if(m.method==='stop')return process.exit(0);if(m.method==='hang')return;if(m.method==='crash')return process.exit(1);if(m.method==='fatal')return console.log(JSON.stringify({event:'error',code:'event_persistence_failed'}));if(m.method==='duplicate')return console.log(JSON.stringify({event:'ready',node_id:'${nodeId}',network:'regtest'}));if(m.method==='malformed')return console.log('invalid-json');setTimeout(()=>console.log(JSON.stringify({id:m.id,result:m.params})),m.params.delay||0);});\n`, { mode: 0o700 }); return binary;
}
test('JSONL correlates out-of-order replies and shuts down without replay', async t => {
  const process = new NativeProcess({ binary: await nativeFixture(t), config: '/unused', timeout: 1000 }); t.after(() => process.stop()); assert.equal((await process.start()).node_id, nodeId);
  const results = await Promise.all([process.call('echo', { delay: 25, value: 1 }), process.call('echo', { value: 2 })]); assert.equal(results[0].value, 1); assert.equal(results[1].value, 2); await process.stop(); assert.equal(process.closed, true);
});
test('uncertain outcomes are explicit and concurrent request count is bounded', async t => {
  const process = new NativeProcess({ binary: await nativeFixture(t), config: '/unused', timeout: 50 }); t.after(() => process.stop()); await process.start();
  const pending = Array.from({ length: 32 }, () => process.call('hang').catch(error => error.code)); await assert.rejects(process.call('hang'), { code: 'NODE_BUSY' }); assert.deepEqual(new Set(await Promise.all(pending)), new Set(['OUTCOME_UNKNOWN']));
  await assert.rejects(process.call('crash'), { code: 'OUTCOME_UNKNOWN' }); assert.equal(process.closed, true);
});
test('malformed native output cannot be reported as success', async t => {
  const process = new NativeProcess({ binary: await nativeFixture(t), config: '/unused', timeout: 1000 }); t.after(() => process.stop()); await process.start(); await assert.rejects(process.call('malformed'), { code: 'OUTCOME_UNKNOWN' });
});
class FakeNative extends EventEmitter {
  constructor(options) { super(); this.options = options; this.logs = []; this.closed = false; }
  async start() { return { node_id: nodeId, network: 'regtest' }; }
  async stop() { this.closed = true; this.emit('exit'); }
  async call(method, params) { return { method, params }; }
}
test('wallet identity, isolated ports, private config and network binding survive restart', async t => {
  const dir = await directory(t); const manager = new WalletManager({ dataDir: dir, binary: '/unused', processFactory: options => new FakeNative(options) }); await manager.initialize(); t.after(() => manager.close());
  const [a, b] = await Promise.all([manager.create(config()), manager.create({ ...config(), name: 'Second' })]); assert.notEqual(a.id, b.id); assert.notEqual(a.public_port, b.public_port);
  await manager.start(a.id); assert.equal(manager.list()[0].status, 'running'); assert.match(manager.pairing(a.id, 'umbrel.local').tcp_uri, /@umbrel.local:19351$/); await assert.rejects(manager.update(a.id, config()), /Stop/);
  const file = path.join(dir, 'wallets', a.id, 'node.json'); const nativeConfig = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(nativeConfig.network, 'regtest'); assert.equal(nativeConfig.listen_address, '0.0.0.0:9735'); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await manager.stop(a.id); const restored = new WalletManager({ dataDir: dir, binary: '/unused' }); await restored.initialize(); assert.equal(restored.list()[0].id, a.id); await assert.rejects(restored.update(a.id, { ...config(), network: 'bitcoin' }), /cannot be changed/);
});
test('concurrent wallet creation remains bounded with unique ports', async t => {
  const manager = new WalletManager({ dataDir: await directory(t), binary: '/unused' }); await manager.initialize(); const results = await Promise.allSettled(Array.from({ length: 10 }, () => manager.create(config())));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8); assert.equal(manager.list().length, 8); assert.equal(new Set(manager.list().map(wallet => wallet.public_port)).size, 8);
});

test('native persistence faults fail pending work and prohibit further commands', async t => {
  const process = new NativeProcess({ binary: await nativeFixture(t), config: '/unused', timeout: 1000 }); t.after(() => process.stop()); await process.start();
  const pending = process.call('hang'); const failure = assert.rejects(pending, { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(process.call('fatal'), { code: 'OUTCOME_UNKNOWN' }); await failure; assert.equal(process.faulted, true);
  await assert.rejects(process.call('echo'), { code: 'NODE_FAULT' });
});
test('duplicate native readiness is a terminal protocol fault', async t => {
  const process = new NativeProcess({ binary: await nativeFixture(t), config: '/unused', timeout: 1000 }); t.after(() => process.stop()); await process.start();
  await assert.rejects(process.call('duplicate'), { code: 'OUTCOME_UNKNOWN' }); assert.equal(process.faulted, true);
});
test('manager surfaces a native durability fault and never auto-restarts it', async t => {
  const manager = new WalletManager({ dataDir: await directory(t), binary: '/unused', processFactory: options => new FakeNative(options) }); await manager.initialize(); t.after(() => manager.close());
  const wallet = await manager.create(config()); await manager.update(wallet.id, { ...config(), autostart: true }); await manager.start(wallet.id); const state = manager.state(wallet.id);
  state.process.emit('fault', 'Native event-history persistence failed. Inspect storage.'); state.process.closed = true; state.process.emit('exit');
  assert.equal(state.status, 'failed'); assert.match(state.error, /persistence failed/); assert.equal(state.noRestart, true); assert.equal(state.restartTimer, undefined);
});
