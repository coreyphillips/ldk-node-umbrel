import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Authentication } from './auth.mjs';
import { walletConfig, publicConfig, rpcRequest } from './config.mjs';
import { privateDir, atomicJson, readJson } from './files.mjs';
import { createServer } from './index.mjs';
const config = () => ({ name: 'Home', chain_source: { type: 'bitcoind', host: 'localhost', port: 8332, user: 'user', password: 'a-private-rpc-value' }, autostart: false });
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-dashboard-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
const request = (headers = {}, address = '127.0.0.1') => ({ headers: { host: 'localhost:3000', origin: 'http://localhost:3000', ...headers }, socket: { remoteAddress: address } });
const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; } });
test('mainnet default, spending opt-ins, credential redaction and immutable network', () => {
  const value = walletConfig(config()); assert.equal(value.network, 'bitcoin'); assert.equal(value.chicory.enabled, false); assert.equal(value.chicory.offline_enabled, false); assert.equal(value.iroh.enabled, false);
  assert.throws(() => walletConfig({ ...config(), iroh: { enabled: true } }), /consent/);
  assert.throws(() => walletConfig({ ...config(), tor_onion_address: 'example.com:9735' }), /v3 onion/);
  assert.equal(walletConfig({ ...config(), tor_onion_address: 'a'.repeat(56) + '.onion:9735' }).tor_onion_address.length, 67);
  assert.equal(publicConfig(value).chain_source.password, ''); assert.equal(value.chain_source.password, 'a-private-rpc-value');
  assert.throws(() => walletConfig({ ...config(), network: 'regtest' }, value), /cannot be changed/);
  assert.throws(() => walletConfig({ ...config(), name: '🍋'.repeat(9) }), /UTF-8/);
  assert.throws(() => walletConfig({ ...config(), chicory: { offline_enabled: true } }), /provider/);
  for (const url of ['http://server:50001', 'tcp://server', 'tcp://user:pass@server:50001', 'tcp://server:50001/secret', 'tcp://server:50001?token=x']) assert.throws(() => walletConfig({ ...config(), chain_source: { type: 'electrum', url } }));
  assert.equal(walletConfig({ ...config(), chain_source: { ...config().chain_source, password: '' } }, value).chain_source.password, value.chain_source.password);
  assert.throws(() => walletConfig({ ...config(), chicory: { max_client_funding_sats: 100_000, max_total_fronted_sats: 10_000 } }), /cover/);
});
test('fund-moving RPCs require explicit review and private native methods are inaccessible', () => {
  for (const method of ['pay', 'send_onchain', 'open', 'close', 'splice_in', 'splice_out']) { assert.throws(() => rpcRequest(method, {}), /Confirm/); assert.deepEqual(rpcRequest(method, { confirm: true, amount_sats: 12 }), { amount_sats: 12 }); }
  assert.throws(() => rpcRequest('stop'), /Unsupported/); assert.throws(() => rpcRequest('export_seed'), /Unsupported/); assert.throws(() => rpcRequest('invoice', { description: 'a'.repeat(40_000) }), /too large/);
});
test('durable storage uses private files and refuses symlinks', async t => {
  const dir = await directory(t); await privateDir(path.join(dir, 'private')); const file = path.join(dir, 'private', 'state.json'); await atomicJson(file, { version: 1 });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.deepEqual(await readJson(file), { version: 1 }); const link = path.join(dir, 'alias'); await fs.symlink(file, link); await assert.rejects(readJson(link), /Unsafe/);
});
test('password sessions enforce origin, CSRF, expiry and login rate limits', async t => {
  const dir = await directory(t); const password = 'a-long-test-password-only'; const file = path.join(dir, 'password'); await fs.writeFile(file, password, { mode: 0o600 });
  let now = 1000; const auth = new Authentication({ dataDir: dir, now: () => now }); await auth.initialize(file); t.after(() => auth.close());
  const out = response(); const session = auth.login(request(), out, password, false); const cookie = out.headers['Set-Cookie'].split(';')[0]; assert.match(out.headers['Set-Cookie'], /HttpOnly; SameSite=Strict/);
  assert.equal(auth.require(request({ cookie, 'x-csrf-token': session.csrf }), true).csrf, session.csrf);
  assert.throws(() => auth.require(request({ cookie, origin: 'https://attacker.invalid', 'x-csrf-token': session.csrf }), true), /origin/); assert.throws(() => auth.require(request({ cookie }), true), /Refresh/);
  now += 8 * 3600_000 + 1; assert.throws(() => auth.require(request({ cookie }), false), /Sign in/);
  for (let i = 0; i < 10; i++) assert.throws(() => auth.login(request({}, '10.0.0.8'), response(), 'wrong', false), /Invalid password/);
  assert.throws(() => auth.login(request({}, '10.0.0.8'), response(), password, false), /Too many/);
});
test('Umbrel mode fails closed during DNS failure and ignores forwarded IP spoofing', async t => {
  let records = []; const auth = new Authentication({ mode: 'umbrel', dataDir: await directory(t), proxyHosts: ['app_proxy'], lookup: async () => records }); await auth.initialize(); t.after(() => auth.close());
  assert.throws(() => auth.status(request({ 'x-forwarded-for': '10.0.0.2' }), response()), /proxy/);
  records = [{ address: '10.0.0.2' }]; await auth.refreshProxies(); assert.equal(auth.status(request({}, '::ffff:10.0.0.2'), response()).authenticated, true);
  assert.throws(() => auth.status(request({ 'x-forwarded-for': '10.0.0.2' }, '10.0.0.3'), response()), /proxy/);
  records = []; await auth.refreshProxies(); assert.throws(() => auth.status(request({}, '10.0.0.2'), response()), /proxy/);
});
test('HTTP API protects wallet data and mutations with host, session, origin and CSRF checks', async t => {
  const dir = await directory(t); const passwordFile = path.join(dir, 'password'); await fs.writeFile(passwordFile, 'local-test-password-value', { mode: 0o600 });
  const auth = new Authentication({ dataDir: dir }); await auth.initialize(passwordFile); let mutations = 0;
  const wallets = { list: () => [{ id: 'secret-wallet' }], create: async () => { mutations++; return {}; } };
  const server = createServer({ auth, wallets, allowedHosts: new Set(['127.0.0.1']) }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { auth.close(); await new Promise(resolve => server.close(resolve)); }); const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/api/wallets`)).status, 401); const wrongHostStatus = await new Promise((resolve, reject) => { const req = http.get(origin, { headers: { host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); }); assert.equal(wrongHostStatus, 403);
  const page = await fetch(origin); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(page.headers.get('cache-control'), 'no-store');
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'local-test-password-value' }) }); assert.equal(login.status, 200);
  const session = await login.json(); const cookie = login.headers.get('set-cookie').split(';')[0]; const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': session.csrf };
  assert.equal((await fetch(`${origin}/api/wallets`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/wallets`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/wallets`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${origin}/api/wallets`, { method: 'POST', headers, body: '{}' })).status, 201); assert.equal(mutations, 1);
});
