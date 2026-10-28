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
  const value = walletConfig(config()); assert.equal(value.network, 'bitcoin'); assert.equal(value.chicory.enabled, false); assert.equal(Object.hasOwn(value.chicory, 'offline_enabled'), false); assert.equal(value.iroh.enabled, false);
  assert.throws(() => walletConfig({ ...config(), iroh: { enabled: true } }), /consent/);
  assert.throws(() => walletConfig({ ...config(), tor_onion_address: 'example.com:9735' }), /v3 onion/);
  assert.equal(walletConfig({ ...config(), tor_onion_address: 'a'.repeat(56) + '.onion:9735' }).tor_onion_address.length, 67);
  assert.equal(publicConfig(value).chain_source.password, ''); assert.equal(value.chain_source.password, 'a-private-rpc-value');
  assert.throws(() => walletConfig({ ...config(), network: 'regtest' }, value), /cannot be changed/);
  assert.throws(() => walletConfig({ ...config(), name: '🍋'.repeat(9) }), /UTF-8/);
  assert.throws(() => walletConfig({ ...config(), chicory: { offline_enabled: true } }), { code: 'OFFLINE_RECEIVE_REMOVED' });
  for (const url of ['http://server:50001', 'tcp://server', 'tcp://user:pass@server:50001', 'tcp://server:50001/secret', 'tcp://server:50001?token=x']) assert.throws(() => walletConfig({ ...config(), chain_source: { type: 'electrum', url } }));
  assert.equal(walletConfig({ ...config(), chain_source: { ...config().chain_source, password: '' } }, value).chain_source.password, value.chain_source.password);
  assert.throws(() => walletConfig({ ...config(), chicory: { max_client_funding_sats: 100_000, max_total_fronted_sats: 10_000 } }), /cover/);
});
test('fund-moving RPCs require explicit review and private native methods are inaccessible', () => {
  for (const method of ['pay', 'send_onchain', 'open', 'close', 'splice_in', 'splice_out']) { assert.throws(() => rpcRequest(method, {}), /Confirm/); assert.deepEqual(rpcRequest(method, { confirm: true, amount_sats: 12 }), { amount_sats: 12 }); }
  assert.throws(() => rpcRequest('offline_status'), /Unsupported/);
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
  assert.equal(auth.require(request({ cookie, 'x-session-proof': session.proof, 'x-csrf-token': session.csrf }), true).csrf, session.csrf);
  assert.throws(() => auth.require(request({ cookie, 'x-session-proof': session.proof, origin: 'https://attacker.invalid', 'x-csrf-token': session.csrf }), true), /origin/); assert.throws(() => auth.require(request({ cookie, 'x-session-proof': session.proof }), true), /Refresh/);
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
  const session = await login.json(); const cookie = login.headers.get('set-cookie').split(';')[0]; const headers = { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': session.csrf, 'x-session-proof': session.proof };
  assert.equal((await fetch(`${origin}/api/wallets`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/wallets`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${origin}/api/wallets`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${origin}/api/wallets`, { method: 'POST', headers, body: '{}' })).status, 201); assert.equal(mutations, 1);
});

test('Umbrel bootstrap stores only a private password hash and preserves it across restarts', async t => {
  const dir = await directory(t); const password = '1a'.repeat(32);
  const auth = new Authentication({ dataDir: dir }); await auth.initialize(undefined, password); t.after(() => auth.close());
  const file = path.join(dir, 'auth.json'); const original = await fs.readFile(file, 'utf8');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.equal(original.includes(password), false);
  assert.deepEqual(await fs.readdir(dir), ['auth.json']);
  assert.equal(auth.login(request(), response(), password).authenticated, true);
  const restarted = new Authentication({ dataDir: dir }); await restarted.initialize(undefined, '2b'.repeat(32)); t.after(() => restarted.close());
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(restarted.login(request(), response(), password).authenticated, true);
  assert.throws(() => restarted.login(request(), response(), '2b'.repeat(32)), /Invalid password/);
  for (const invalid of ['', 'a'.repeat(15), 'a'.repeat(513)]) {
    const fresh = new Authentication({ dataDir: await directory(t) });
    await assert.rejects(fresh.initialize(undefined, invalid), /16 to 512/);
  }
  await assert.rejects(new Authentication({ dataDir: dir }).initialize(file, password), /either/);
  await assert.rejects(new Authentication({ dataDir: dir, mode: 'umbrel' }).initialize(undefined, password), /requires password/);
});

test('canonical authorities and explicit origins reject ambiguous or forged inputs', async () => {
  const { canonicalAuthority, canonicalOrigin, allowedHostnames } = await import('./request-security.mjs');
  assert.deepEqual(canonicalAuthority('MY-UMBREL.local.:02114'), { hostname: 'my-umbrel.local', authority: 'my-umbrel.local:2114' });
  assert.equal(canonicalAuthority('[2001:0db8:0000::1]:2114').authority, '[2001:db8::1]:2114');
  assert.equal(canonicalOrigin('https://MY-UMBREL.local:443'), 'https://my-umbrel.local');
  for (const host of ['', 'host:0', 'host:65536', 'host:', 'host:abc', 'user@host', 'host/path', 'host\\path', 'host?x', 'host#x', 'host,other', ' host', 'host\t', '127.1', '0x7f000001', '[::1', '::1', '[fe80::1%25eth0]', 'a'.repeat(64) + '.local']) assert.throws(() => canonicalAuthority(host), /Invalid host/, host);
  for (const origin of [undefined, 'null', 'ftp://host', 'https://host/', 'https://host/path', 'https://host?x', 'https://host#x', 'https://user@host', 'https://host, https://other']) assert.throws(() => canonicalOrigin(origin), /origin/);
  assert.deepEqual([...allowedHostnames([' HOME.local ', '[2001:db8::1]'], 'password')], ['home.local', '[2001:db8::1]']);
  assert.throws(() => allowedHostnames(['*'], 'umbrel'), /requires password/);
  assert.throws(() => allowedHostnames(['home.local:2114'], 'password'), /ports/);
  assert.throws(() => allowedHostnames([], 'password'), /at least one/);
  const auth = new Authentication({ dataDir: '/unused', publicOrigin: 'https://home.local:2114' });
  assert.equal(auth.checkOrigin(request({ host: 'home.local:2114', origin: 'https://home.local:2114' })), 'https://home.local:2114');
  assert.throws(() => auth.checkOrigin(request({ host: 'home.local:2114', origin: 'http://home.local:2114' })), /origin/);
});

test('Umbrel gateway requests work on custom hosts, IPs, onion addresses and HTTPS without trusting forwarding headers', async t => {
  const dir = await directory(t); const password = 'c3'.repeat(32); const auth = new Authentication({ dataDir: dir }); await auth.initialize(undefined, password);
  let mutations = 0; const wallets = { list: () => [{ id: 'wallet' }], create: async () => { mutations++; return {}; } };
  const server = createServer({ auth, wallets, allowedHosts: new Set(['*']) }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { auth.close(); await new Promise(resolve => server.close(resolve)); });
  const call = (route, headers, payload) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: payload === undefined ? 'GET' : 'POST', headers: Object.fromEntries(Object.entries({ 'content-type': 'application/json', ...headers }).filter(([, value]) => value !== undefined)) }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
  const origins = ['http://home-server.local:2114', 'https://home-server.local:2114', 'http://192.168.1.25:2114', 'https://[2001:db8::25]:2114', `http://${'a'.repeat(56)}.onion`];
  for (const origin of origins) {
    const host = new URL(origin).host; const base = { host, origin };
    const loggedIn = await call('/api/login', { ...base, 'x-forwarded-proto': 'attacker', 'x-forwarded-host': 'attacker.invalid' }, { password });
    assert.equal(loggedIn.status, 200, origin); const cookie = loggedIn.headers['set-cookie'][0].split(';')[0];
    assert.equal(loggedIn.headers['set-cookie'][0].includes('; Secure'), origin.startsWith('https:'), origin);
    const headers = { ...base, cookie, 'x-csrf-token': loggedIn.body.csrf, 'x-session-proof': loggedIn.body.proof };
    assert.equal((await call('/api/wallets', { host, cookie, 'x-session-proof': loggedIn.body.proof })).status, 200);
    assert.equal((await call('/api/wallets', headers, {})).status, 201);
    assert.equal((await call('/api/wallets', { ...headers, host: 'different.local:2114', origin: 'http://different.local:2114' })).status, 401);
    assert.equal((await call('/api/wallets', { ...headers, host: 'different.local:2114', origin: 'http://different.local:2114' }, {})).status, 401);
    assert.equal((await call('/api/wallets', { ...headers, origin: origin.replace(/^https?:/, origin.startsWith('https:') ? 'http:' : 'https:') }, {})).status, 403);
    assert.equal((await call('/api/wallets', { ...headers, origin: 'https://attacker.invalid', 'x-forwarded-host': host, 'x-forwarded-proto': new URL(origin).protocol.slice(0, -1) }, {})).status, 403);
    assert.equal((await call('/api/wallets', { ...headers, origin: undefined }, {})).status, 403);
  }
  assert.equal(mutations, origins.length);
  assert.equal((await call('/api/login', { host: 'home.local:2114', origin: 'http://attacker.invalid', 'x-forwarded-host': 'attacker.invalid' }, { password })).status, 403);
  assert.equal((await call('/api/login', { host: 'evil.invalid:2114', origin: 'http://home.local:2114', 'x-forwarded-host': 'home.local:2114' }, { password })).status, 403);
  for (const host of ['host:0', '127.1', 'user@host', 'host/path', 'host,other']) assert.equal((await call('/api/session', { host })).status, 400, host);
  for (const target of ['http://attacker.invalid/api/session', '//attacker.invalid/api/session', '/\\attacker.invalid/api/session']) assert.equal((await call(target, { host: 'home.local:2114' })).status, 400, target);
  const secure = response(); auth.login(request(), secure, password, true); assert.match(secure.headers['Set-Cookie'], /; Secure/);
});

test('a cookie captured by another app cannot recover session proof, read wallets or send a mutation', async t => {
  const auth = new Authentication({ dataDir: await directory(t) }); const password = 'e5'.repeat(32); await auth.initialize(undefined, password);
  let mutations = 0;
  const server = createServer({ auth, wallets: { list: () => [{ id: 'private-wallet' }], create: async () => { mutations++; return {}; } }, allowedHosts: new Set(['127.0.0.1']) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const loggedIn = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  const session = await loggedIn.json(); const cookie = loggedIn.headers.get('set-cookie').split(';')[0]; assert.match(session.proof, /^[A-Za-z0-9_-]{43}$/);
  let captured;
  const otherApp = http.createServer(async (req, res) => {
    captured = req.headers.cookie;
    // Another service has the actual shared-host cookie and can forge both Host
    // and Origin server-side. Even disclose CSRF here to test the independent proof.
    const headers = { cookie: captured, origin, 'content-type': 'application/json', 'x-csrf-token': session.csrf };
    const status = await fetch(`${origin}/api/session`, { headers });
    const wallets = await fetch(`${origin}/api/wallets`, { headers });
    const mutation = await fetch(`${origin}/api/wallets`, { method: 'POST', headers, body: '{}' });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ session: await status.json(), wallets: wallets.status, mutation: mutation.status }));
  });
  await new Promise(resolve => otherApp.listen(0, '127.0.0.1', resolve));
  t.after(async () => { auth.close(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => otherApp.close(resolve))]); });
  const replay = await fetch(`http://127.0.0.1:${otherApp.address().port}/`, { headers: { cookie } });
  assert.equal(captured, cookie); assert.deepEqual(await replay.json(), { session: { authenticated: false, mode: 'password' }, wallets: 401, mutation: 401 });
  const headers = { origin, cookie, 'content-type': 'application/json', 'x-csrf-token': session.csrf, 'x-session-proof': session.proof };
  const retained = await fetch(`${origin}/api/session`, { headers }); const status = await retained.json();
  assert.deepEqual(status, { authenticated: true, mode: 'password', csrf: session.csrf }); assert.equal('proof' in status, false);
  assert.equal((await fetch(`${origin}/api/wallets`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/wallets`, { method: 'POST', headers, body: '{}' })).status, 201); assert.equal(mutations, 1);
  const wrong = { ...headers, 'x-session-proof': 'A'.repeat(43) };
  assert.deepEqual(await (await fetch(`${origin}/api/session`, { headers: wrong })).json(), { authenticated: false, mode: 'password' });
  assert.equal((await fetch(`${origin}/api/logout`, { method: 'POST', headers: wrong, body: '{}' })).status, 401);
  assert.equal((await fetch(`${origin}/api/wallets`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/api/logout`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.deepEqual(await (await fetch(`${origin}/api/session`, { headers })).json(), { authenticated: false, mode: 'password' });
  assert.equal((await fetch(`${origin}/api/wallets`, { headers })).status, 401);
});

test('legacy proxy sessions issue a new proof only after independent proxy authentication', async t => {
  const auth = new Authentication({ dataDir: await directory(t), mode: 'umbrel', proxyHosts: ['proxy'], lookup: async () => [{ address: '10.0.0.2' }] });
  await auth.initialize(); t.after(() => auth.close());
  const out = response(); const created = auth.status(request({}, '10.0.0.2'), out);
  const cookie = out.headers['Set-Cookie'].split(';')[0]; assert.match(created.proof, /^[A-Za-z0-9_-]{43}$/);
  const authenticated = request({ cookie, 'x-session-proof': created.proof }, '10.0.0.2');
  assert.deepEqual(auth.status(authenticated, response()), { authenticated: true, mode: 'umbrel', csrf: created.csrf });
  assert.throws(() => auth.status(request({ cookie }, '10.0.0.3'), response()), /proxy/);
  assert.throws(() => auth.require(request({ cookie }, '10.0.0.2'), false), /Sign in/);
  const renewed = auth.status(request({ cookie }, '10.0.0.2'), response()); assert.notEqual(renewed.proof, created.proof);
  assert.equal(auth.require(authenticated, false).csrf, created.csrf);
});
