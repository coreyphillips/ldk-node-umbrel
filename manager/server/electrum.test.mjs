import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { electrumUrl, electrumSettings, createElectrumChecker } from './electrum.mjs';
import { walletConfig } from './config.mjs';
import { WalletManager } from './wallets.mjs';
import { createServer } from './index.mjs';
import { Authentication } from './auth.mjs';
import { failure } from './files.mjs';

const merkle = '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a';
const parameters = { bitcoin: [1231006505, 0x1d00ffff, 2083236893], testnet: [1296688602, 0x1d00ffff, 414098458], signet: [1598918400, 0x1e0377ae, 52613770], regtest: [1296688602, 0x207fffff, 2] };
function header(network) {
  const value = Buffer.alloc(80); value.writeUInt32LE(1); Buffer.from(merkle, 'hex').copy(value, 36);
  parameters[network].forEach((number, index) => value.writeUInt32LE(number, 68 + index * 4)); return value.toString('hex');
}
const reply = (id, result) => `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-electrum-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function fixture(t, callback) {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); callback(socket); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return `tcp://127.0.0.1:${server.address().port}`;
}
function requests(socket, callback) {
  let buffer = ''; const messages = [];
  socket.on('data', chunk => { buffer += chunk; let newline; while ((newline = buffer.indexOf('\n')) !== -1) { messages.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1); } if (messages.length === 3) callback(messages); });
}

test('Electrum URLs and environment defaults validate before connecting and preserve plaintext Fulcrum', () => {
  assert.deepEqual(electrumUrl('tcp://MINT.local:50002/'), { url: 'tcp://mint.local:50002', host: 'mint.local', port: 50002, tls: false });
  assert.equal(electrumUrl('ssl://[2001:db8::1]:50002').host, '2001:db8::1');
  for (const invalid of ['tcp://user:secret@host:50001', 'https://host:50001', 'tcp://host', 'tcp://host:0', 'tcp://host:65536', 'tcp://host:50001/path', 'tcp://host:50001?q=secret', 'tcp://host:50001#secret', 'tcp://host:50001\nsecret', 'tcp://127.1:50001']) assert.throws(() => electrumUrl(invalid), error => error.code === 'ELECTRUM_URL' && !error.message.includes('secret'));
  const none = electrumSettings({}); assert.equal(none.default_electrum_url, '');
  assert.deepEqual(electrumSettings({ DEFAULT_ELECTRUM_HOST: '', DEFAULT_ELECTRUM_PORT: '50001', DEFAULT_ELECTRUM_TLS: 'false' }), none);
  assert.equal(none.electrum_presets.find(value => value.id === 'fulcrum').url, 'tcp://10.21.21.200:50002');
  assert.equal(electrumSettings({ DEFAULT_ELECTRUM_HOST: '10.21.21.10', DEFAULT_ELECTRUM_PORT: '50001', DEFAULT_ELECTRUM_TLS: 'false' }).default_electrum_url, 'tcp://10.21.21.10:50001');
  assert.equal(electrumSettings({ DEFAULT_ELECTRUM_HOST: '2001:db8::1', DEFAULT_ELECTRUM_PORT: '50002', DEFAULT_ELECTRUM_TLS: 'true' }).default_electrum_url, 'ssl://[2001:db8::1]:50002');
  for (const environment of [{ DEFAULT_ELECTRUM_HOST: 'host' }, { DEFAULT_ELECTRUM_HOST: 'host/path', DEFAULT_ELECTRUM_PORT: '1' }, { DEFAULT_ELECTRUM_HOST: 'host', DEFAULT_ELECTRUM_PORT: '1', DEFAULT_ELECTRUM_TLS: 'yes' }]) assert.throws(() => electrumSettings(environment), /configuration/);
  const saved = walletConfig({ name: 'Existing', chain_source: { type: 'electrum', url: 'tcp://mint.local:50002' } });
  assert.equal(saved.chain_source.url, 'tcp://mint.local:50002'); assert.equal(saved.network, 'bitcoin');
  assert.equal(walletConfig({ name: 'New', chain_source: { type: 'electrum', url: 'tcp://mint.local:50002/' } }).chain_source.url, 'tcp://mint.local:50002');
});

test('Electrum probe verifies each network from the header with fragmented and out-of-order replies', async t => {
  for (const network of Object.keys(parameters)) {
    const url = await fixture(t, socket => requests(socket, messages => {
      assert.deepEqual(messages.map(message => message.method), ['server.version', 'blockchain.block.header', 'blockchain.headers.subscribe']);
      assert.deepEqual(messages[1].params, [0]);
      const data = reply(3, { height: 250 }) + reply(2, header(network)) + reply(1, ['fixture', '1.4.3']);
      socket.write(data.slice(0, 17)); setImmediate(() => socket.write(data.slice(17)));
    }));
    assert.deepEqual(await createElectrumChecker()({ url, network }), { url, network, height: 250 });
  }
});

test('Electrum rejects a different or unknown genesis before reporting success', async t => {
  for (const genesis of [header('regtest'), '00'.repeat(80)]) {
    const url = await fixture(t, socket => requests(socket, () => socket.write(reply(2, genesis))));
    await assert.rejects(createElectrumChecker()({ url, network: 'bitcoin' }), error => error.code === 'ELECTRUM_WRONG_NETWORK' && error.status === 409 && /Mainnet/.test(error.message) && /Regtest|unknown/.test(error.message));
  }
});

test('height is optional after version and genesis verification', async t => {
  for (const ending of ['error', 'close', 'timeout']) {
    const url = await fixture(t, socket => requests(socket, () => {
      socket.write(reply(1, ['fixture', '1.4']) + reply(2, header('bitcoin')));
      if (ending === 'error') socket.write(`${JSON.stringify({ id: 3, error: { code: -32601, message: 'unavailable' } })}\n`);
      if (ending === 'close') socket.end();
    }));
    assert.deepEqual(await createElectrumChecker({ timeoutMs: 100 })({ url, network: 'bitcoin' }), { url, network: 'bitcoin' });
  }
});

test('Electrum rejects invalid, oversized, duplicate and excessive protocol frames', async t => {
  const invalidReplies = ['not-json\n', 'x'.repeat(65537), reply(2, '00'), reply(1, ['fixture', '1.3']), reply(1, ['fixture', '1.4']) + reply(1, ['fixture', '1.4']), reply(3, { height: -1 }), `${JSON.stringify({ method: 'blockchain.headers.subscribe', params: [] })}\n`.repeat(17)];
  for (const data of invalidReplies) {
    const url = await fixture(t, socket => requests(socket, () => socket.write(data)));
    await assert.rejects(createElectrumChecker()({ url, network: 'bitcoin' }), { code: 'ELECTRUM_PROTOCOL' });
  }
});

test('wall-clock deadline stops trickling peers and closes the socket', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const url = await fixture(t, socket => { const timer = setInterval(() => socket.write(' '), 5); socket.on('close', () => { clearInterval(timer); closed(); }); });
  const started = Date.now();
  await assert.rejects(createElectrumChecker({ timeoutMs: 80 })({ url, network: 'bitcoin' }), { code: 'ELECTRUM_TIMEOUT' });
  await disconnected; assert.ok(Date.now() - started < 1500);
});

class FakeSocket extends EventEmitter {
  destroyed = false; writes = [];
  write(value) { this.writes.push(value); }
  destroy() { this.destroyed = true; }
}
test('connection failures have safe DNS, refused and TLS messages and keep TLS verification enabled', async () => {
  for (const [code, expected, url] of [['ENOTFOUND', 'ELECTRUM_DNS', 'tcp://mint.local:50002'], ['ECONNREFUSED', 'ELECTRUM_REFUSED', 'tcp://127.0.0.1:50001'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'ELECTRUM_TLS', 'ssl://server.example:50002']]) {
    let socket; let options;
    const connector = value => { options = value; socket = new FakeSocket(); setImmediate(() => socket.emit('error', Object.assign(new Error('secret-token'), { code }))); return socket; };
    const checker = createElectrumChecker({ connectTcp: connector, connectTls: connector });
    await assert.rejects(checker({ url, network: 'bitcoin' }), error => error.code === expected && !error.message.includes('secret-token') && (expected !== 'ELECTRUM_DNS' || error.message.includes('.local')));
    assert.equal(socket.destroyed, true);
    if (url.startsWith('ssl:')) { assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, 'server.example'); }
  }
});

test('concurrent Electrum probes are bounded and slots are released after failure', async () => {
  const checker = createElectrumChecker({ timeoutMs: 50, maxConcurrent: 2, connectTcp: () => new FakeSocket() });
  const input = { url: 'tcp://host:50001', network: 'bitcoin' };
  const first = checker(input).catch(error => error.code); const second = checker(input).catch(error => error.code);
  await assert.rejects(checker(input), { code: 'ELECTRUM_BUSY' });
  assert.deepEqual(await Promise.all([first, second]), ['ELECTRUM_TIMEOUT', 'ELECTRUM_TIMEOUT']);
  await assert.rejects(checker(input), { code: 'ELECTRUM_TIMEOUT' });
});

test('Electrum HTTP endpoint requires session proof, origin and CSRF before making a connection', async t => {
  const auth = new Authentication({ dataDir: await directory(t) }); const password = 'electrum-test-password'; await auth.initialize(undefined, password);
  let calls = 0; const electrumCheck = async input => { calls++; if (input.network === 'regtest') throw failure('Wrong network', 409, 'ELECTRUM_WRONG_NETWORK'); return { ...input, height: 500 }; };
  const electrumConfig = electrumSettings({ DEFAULT_ELECTRUM_HOST: '10.21.21.10', DEFAULT_ELECTRUM_PORT: '50001', DEFAULT_ELECTRUM_TLS: 'false' });
  const server = createServer({ auth, wallets: {}, allowedHosts: new Set(['127.0.0.1']), electrumCheck, electrumConfig });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { auth.close(); await new Promise(resolve => server.close(resolve)); });
  const payload = { url: 'tcp://mint.local:50002', network: 'bitcoin' };
  const check = headers => fetch(`${origin}/api/electrum/check`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal((await check({ 'content-type': 'application/json', origin })).status, 401);
  const loggedIn = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const session = await loggedIn.json(); const cookie = loggedIn.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin, 'content-type': 'application/json', 'x-session-proof': session.proof, 'x-csrf-token': session.csrf };
  assert.equal((await check({ ...headers, 'x-csrf-token': '' })).status, 403);
  assert.equal((await check({ ...headers, origin: 'http://attacker.invalid' })).status, 403); assert.equal(calls, 0);
  assert.deepEqual(await (await check(headers)).json(), { ...payload, height: 500 });
  const badNetwork = await fetch(`${origin}/api/electrum/check`, { method: 'POST', headers, body: JSON.stringify({ ...payload, network: 'regtest' }) });
  assert.equal(badNetwork.status, 409); assert.equal((await badNetwork.json()).error.code, 'ELECTRUM_WRONG_NETWORK');
  const config = await (await fetch(`${origin}/api/config`, { headers })).json();
  assert.equal(config.default_electrum_url, 'tcp://10.21.21.10:50001'); assert.equal(config.default_network, 'bitcoin'); assert.deepEqual(config.electrum_presets, electrumConfig.electrum_presets);
});

test('wallet startup exposes the probe failure without launching native or changing saved configuration', async t => {
  const dir = await directory(t); let launched = false;
  const electrumCheck = async input => { assert.deepEqual(input, { url: 'tcp://mint.local:50002', network: 'bitcoin' }); throw failure('The Electrum host could not be resolved. Use the server LAN IP.', 502, 'ELECTRUM_DNS'); };
  const manager = new WalletManager({ dataDir: dir, binary: '/unused', electrumCheck, processFactory: () => { launched = true; } });
  await manager.initialize(); t.after(() => manager.close());
  const wallet = await manager.create({ name: 'Home', chain_source: { type: 'electrum', url: 'tcp://mint.local:50002' }, autostart: false });
  const original = await fs.readFile(path.join(dir, 'wallets.json'), 'utf8');
  await assert.rejects(manager.start(wallet.id), { code: 'ELECTRUM_DNS' });
  assert.equal(launched, false); assert.equal(manager.list()[0].status, 'failed'); assert.match(manager.list()[0].last_error, /LAN IP/);
  assert.equal(await fs.readFile(path.join(dir, 'wallets.json'), 'utf8'), original);
  await assert.rejects(fs.stat(path.join(dir, 'wallets', wallet.id, 'node.json')), { code: 'ENOENT' });
});

test('stopping during a probe prevents a delayed native launch', async t => {
  let finish; let launched = false;
  const checker = () => new Promise(resolve => { finish = resolve; });
  const manager = new WalletManager({ dataDir: await directory(t), binary: '/unused', electrumCheck: checker, processFactory: () => { launched = true; } });
  await manager.initialize(); t.after(() => manager.close());
  const wallet = await manager.create({ name: 'Home', chain_source: { type: 'electrum', url: 'tcp://mint.local:50002' }, autostart: false });
  const starting = manager.start(wallet.id); await manager.stop(wallet.id); finish();
  assert.deepEqual(await starting, { status: 'stopped' }); assert.equal(launched, false); assert.equal(manager.list()[0].status, 'stopped');
});


test('legacy Electrum trailing slashes normalize only at native startup without changing identity or node state', async t => {
  const dir = await directory(t); const initial = new WalletManager({ dataDir: dir, binary: '/unused' }); await initial.initialize();
  const wallet = await initial.create({ name: 'Existing', chain_source: { type: 'electrum', url: 'tcp://mint.local:50002' }, autostart: false });
  const registryFile = path.join(dir, 'wallets.json'); const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  registry[0].chain_source.url += '/'; const originalRegistry = `${JSON.stringify(registry)}\n`; await fs.writeFile(registryFile, originalRegistry);
  const nodeDirectory = path.join(dir, 'wallets', wallet.id, 'node'); await fs.mkdir(nodeDirectory);
  const persisted = ['keys-fixture', 'channels-fixture', 'payments-fixture'];
  for (const name of persisted) await fs.writeFile(path.join(nodeDirectory, name), `retained-${name}`, { mode: 0o600 });
  let nativeConfig; let checked;
  class NativeFixture extends EventEmitter {
    logs = []; closed = false;
    constructor(options) { super(); this.options = options; }
    async start() { nativeConfig = JSON.parse(await fs.readFile(this.options.config, 'utf8')); return { node_id: `02${'ab'.repeat(32)}`, network: 'bitcoin' }; }
    async stop() { this.closed = true; this.emit('exit'); }
  }
  const manager = new WalletManager({ dataDir: dir, binary: '/unused', processFactory: options => new NativeFixture(options), electrumCheck: async value => { checked = value; } });
  await manager.initialize(); t.after(() => manager.close()); await manager.start(wallet.id);
  assert.deepEqual(checked, { url: 'tcp://mint.local:50002', network: 'bitcoin' });
  assert.deepEqual(nativeConfig.chain_source, { type: 'electrum', url: 'tcp://mint.local:50002' });
  assert.equal(nativeConfig.data_dir, nodeDirectory); assert.equal(nativeConfig.listen_address, '0.0.0.0:9735');
  assert.equal(manager.list()[0].id, wallet.id); assert.equal(manager.list()[0].public_port, wallet.public_port);
  assert.equal(await fs.readFile(registryFile, 'utf8'), originalRegistry);
  for (const name of persisted) assert.equal(await fs.readFile(path.join(nodeDirectory, name), 'utf8'), `retained-${name}`);
});

test('failed Electrum preflight retains bounded autostart retries and stop cancels them', async t => {
  const manager = new WalletManager({ dataDir: await directory(t), binary: '/unused', electrumCheck: async () => { throw failure('Connection refused', 502, 'ELECTRUM_REFUSED'); } });
  await manager.initialize(); t.after(() => manager.close());
  const config = { name: 'Home', chain_source: { type: 'electrum', url: 'tcp://mint.local:50002' }, autostart: false };
  const wallet = await manager.create(config); await manager.update(wallet.id, { ...config, autostart: true });
  await assert.rejects(manager.start(wallet.id), { code: 'ELECTRUM_REFUSED' });
  const state = manager.state(wallet.id); assert.equal(state.attempts.length, 1); assert.ok(state.restartTimer);
  await manager.stop(wallet.id); assert.equal(state.status, 'stopped'); assert.equal(state.restartTimer._destroyed, true);
});
