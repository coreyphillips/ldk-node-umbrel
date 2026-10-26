#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The only coins and blocks used here belong to a new internal-network
// regtest Core. The proxy forwards unmodified traffic to real Electrs; it
// observes protocol activity and can close subscriptions to test reconnects.
const architecture = process.argv[2];
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Usage: node scripts/receive-container-test.mjs amd64|arm64');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const image = `ldk-node-umbrel:${version}-${architecture}`;
const prefix = `ldk-receive-qa-${architecture}-${randomBytes(6).toString('hex')}`;
const network = prefix + '-network'; const core = prefix + '-core';
const electrs = prefix + '-electrs'; const proxy = prefix + '-proxy'; const manager = prefix + '-manager';
const password = randomBytes(24).toString('hex'); const containers = [];
const fixture = await fs.mkdtemp('/private/tmp/ldk-receive-fixture-');
let networkCreated = false;
const checks = []; const rounds = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function docker(args, input) {
  try { return execFileSync('docker', args, { encoding: 'utf8', input, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`Docker ${args[0]} failed (${error.status ?? 'unknown'}): ${String(error.stderr || '').slice(-2400)}`); }
}
function coreRpc(method, ...args) {
  const result = docker(['exec', core, 'bitcoin-cli', '-datadir=/data', '-regtest', '-rpcuser=qualification', `-rpcpassword=${password}`, method, ...args.map(String)]);
  try { return JSON.parse(result); } catch { return result; }
}

const proxyCode = String.raw`
  const net = require('node:net'); const http = require('node:http');
  let next = 0; const connections = new Map(); const events = [];
  function record(value) { events.push({ at: Date.now(), ...value }); if (events.length > 10000) events.shift(); }
  function inspect(connection, direction) {
    let buffer = '';
    return chunk => {
      buffer += chunk.toString(); if (buffer.length > 4 * 1024 * 1024) throw new Error('fixture protocol observation bound');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let parsed; try { parsed = JSON.parse(line); } catch { continue; }
        for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
          if (!value?.method) continue;
          if (direction === 'request') {
            connection.methods[value.method] = (connection.methods[value.method] || 0) + 1;
            if (value.method === 'blockchain.scripthash.subscribe') connection.scripts.add(value.params[0]);
          }
          record({ connection: connection.id, direction, method: value.method, script: value.method.startsWith('blockchain.scripthash.') ? value.params?.[0] : undefined });
        }
      }
    };
  }
  net.createServer(client => {
    const upstream = net.connect(50001, process.env.REAL_ELECTRS);
    const connection = { id: ++next, active: true, methods: {}, scripts: new Set(), client, upstream };
    connections.set(connection.id, connection);
    client.on('data', inspect(connection, 'request')); upstream.on('data', inspect(connection, 'response'));
    client.pipe(upstream); upstream.pipe(client);
    const close = () => { connection.active = false; client.destroy(); upstream.destroy(); };
    client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
  }).listen(50002, '0.0.0.0');
  http.createServer((req, res) => {
    if (req.url === '/drop-watchers' && req.method === 'POST') {
      for (const c of connections.values()) if (c.scripts.size) { c.client.destroy(); c.upstream.destroy(); }
    } else if (req.url !== '/stats' || req.method !== 'GET') { res.writeHead(404); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ now: Date.now(), connections: [...connections.values()].map(({ id, active, methods, scripts }) => ({ id, active, methods, scripts: [...scripts] })), events }));
  }).listen(8080, '0.0.0.0');
`;

const common = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import { createHash } from 'node:crypto';
  import { setTimeout as delay } from 'node:timers/promises';
  import { bech32, bech32m } from '/opt/ldk/manager/node_modules/@scure/base/index.js';
  let raw = ''; for await (const chunk of process.stdin) raw += chunk; const input = JSON.parse(raw); raw = '';
  const origin = 'http://127.0.0.1:3000';
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    assert.ok(i < 120, 'manager startup'); await delay(250);
  }
  const password = (await fs.readFile('/data/dashboard-password', 'utf8')).trim();
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const session = await login.json();
  const headers = { origin, 'content-type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0], 'x-session-proof': session.proof, 'x-csrf-token': session.csrf };
  async function api(route, body, method) {
    const response = await fetch(origin + '/api' + route, { method: method || (body === undefined ? 'GET' : 'POST'), headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(125000) });
    const value = await response.json(); assert.ok(response.ok, route + ': ' + value.error?.code); return value;
  }
  const rpc = (wallet, method) => api('/wallets/' + wallet.id + '/rpc', { method, params: {} });
  const watchFile = wallet => '/data/wallets/' + wallet.id + '/receive-addresses.json';
  const stateFile = '/tmp/receive-qualification.json';
  const readState = async () => JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const save = value => fs.writeFile(stateFile, JSON.stringify(value), { mode: 0o600 });
  const stats = async () => { const response = await fetch('http://' + input.proxy + ':8080/stats'); assert.equal(response.status, 200); return response.json(); };
  const subscriptions = (value, script) => value.connections.filter(c => c.active && c.scripts.includes(script));
  async function waitFor(action, label, milliseconds = 40000) {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) { if (await action()) return; await delay(250); }
    throw new Error(label);
  }
  function scriptHash(address) {
    let decoded; try { decoded = bech32.decode(address); } catch { decoded = bech32m.decode(address); }
    assert.equal(decoded.prefix, 'bcrt'); const version = decoded.words[0]; const program = bech32.fromWords(decoded.words.slice(1));
    return Buffer.from(createHash('sha256').update(Buffer.from([version === 0 ? 0 : 0x50 + version, program.length, ...program])).digest()).reverse().toString('hex');
  }
  async function synchronized(wallet, expected) {
    await waitFor(async () => {
      const info = await api('/wallets/' + wallet.id + '/info');
      return info.latest_onchain_sync !== null && (await api('/wallets/' + wallet.id + '/balance')).onchain_total_sats === expected;
    }, 'initial native synchronization');
  }
`;

const create = common + String.raw`
  assert.equal((await api('/config')).version, input.version);
  assert.equal((await fetch(origin + '/api/wallets')).status, 401);
  const settings = name => ({ name, network: 'regtest', autostart: false, chain_source: { type: 'electrum', url: 'tcp://' + input.proxy + ':50002' } });
  const target = await api('/wallets', settings('Automatic receiver')); const sibling = await api('/wallets', settings('Receive sibling'));
  const startedAt = Date.now();
  for (const wallet of [target, sibling]) await api('/wallets/' + wallet.id + '/start', {});
  const address = (await rpc(target, 'address')).address; const siblingAddress = (await rpc(sibling, 'address')).address;
  const targetScript = scriptHash(address); const siblingScript = scriptHash(siblingAddress);
  for (const [wallet, expectedAddress] of [[target, address], [sibling, siblingAddress]]) {
    const file = watchFile(wallet); const stat = await fs.stat(file); assert.equal(stat.mode & 0o077, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, network: 'regtest', addresses: [expectedAddress] });
    await synchronized(wallet, 0);
  }
  await waitFor(async () => { const value = await stats(); return subscriptions(value, targetScript).length && subscriptions(value, siblingScript).length; }, 'both real Electrum subscriptions');
  const targetNode = (await api('/wallets/' + target.id + '/info')).node_id;
  const siblingNode = (await api('/wallets/' + sibling.id + '/info')).node_id;
  await save({ target, sibling, address, siblingAddress, targetScript, siblingScript, startedAt, targetNode, siblingNode });
  console.log(JSON.stringify({ address, startedAt, checks: ['real Electrs verifies regtest and both real native wallets complete initial synchronization', 'generated receive addresses persist privately and subscribe on separate live wallet watchers'] }));
`;

const observe = common + String.raw`
  const state = await readState(); const { target, sibling, targetScript, siblingScript, startedAt } = state;
  const before = input.before;
  await waitFor(async () => (await api('/wallets/' + target.id + '/balance')).onchain_total_sats === input.expected, 'automatic native balance update without explicit sync', 45000);
  const observedAt = Date.now(); const info = await api('/wallets/' + target.id + '/info');
  const value = await stats();
  const notification = value.events.find(event => event.at >= before && event.direction === 'response' && event.method === 'blockchain.scripthash.subscribe' && event.script === targetScript);
  assert.ok(notification, 'real Electrs delivered receive-address activity');
  const nativeRead = value.events.find(event => event.at >= notification.at && event.direction === 'request' && event.method === 'blockchain.scripthash.get_history');
  assert.ok(nativeRead, 'native wallet queried history after the subscription hint');
  assert.ok(observedAt - startedAt < 65000, 'receive occurred before the native 80-second on-chain interval');
  assert.equal((await api('/wallets/' + sibling.id + '/balance')).onchain_total_sats, 0);
  assert.equal((await api('/wallets/' + sibling.id + '/info')).node_id, state.siblingNode);
  assert.ok(subscriptions(value, siblingScript).length);
  console.log(JSON.stringify({ amount_sats: input.expected, deposit_to_balance_ms: observedAt - before, native_start_to_balance_ms: observedAt - startedAt,
    notification_to_history_read_ms: nativeRead.at - notification.at, latest_onchain_sync: info.latest_onchain_sync, explicit_sync_requests: 0 }));
`;

const reconnect = common + String.raw`
  const state = await readState(); const before = await stats();
  const old = new Set(subscriptions(before, state.targetScript).map(c => c.id));
  assert.ok(old.size); assert.equal((await fetch('http://' + input.proxy + ':8080/drop-watchers', { method: 'POST' })).status, 200);
  await waitFor(async () => subscriptions(await stats(), state.targetScript).some(c => !old.has(c.id)), 'watcher reconnects and resubscribes');
  console.log(JSON.stringify({ checks: ['closing only subscription sockets causes the real Electrum watcher to reconnect and resubscribe'] }));
`;

const restart = common + String.raw`
  const state = await readState(); const startedAt = Date.now();
  for (const wallet of [state.target, state.sibling]) await api('/wallets/' + wallet.id + '/start', {});
  await synchronized(state.target, input.expected); await synchronized(state.sibling, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(watchFile(state.target), 'utf8')).addresses, [state.address]);
  assert.equal((await api('/wallets/' + state.target.id + '/info')).node_id, state.targetNode);
  await waitFor(async () => subscriptions(await stats(), state.targetScript).length, 'persisted address resubscribes after manager restart');
  await save({ ...state, startedAt });
  console.log(JSON.stringify({ address: state.address, startedAt, checks: ['manager restart preserves native identity and restores subscriptions from the private address list without generating an address'] }));
`;

const cleanup = common + String.raw`
  const state = await readState(); const siblingFile = await fs.readFile(watchFile(state.sibling));
  await api('/wallets/' + state.target.id + '/stop', {});
  await waitFor(async () => subscriptions(await stats(), state.targetScript).length === 0, 'stop closes target address subscription');
  assert.ok(subscriptions(await stats(), state.siblingScript).length);
  await api('/wallets/' + state.target.id, { confirmation_name: state.target.name, acknowledge_data_loss: true }, 'DELETE');
  await assert.rejects(fs.stat(watchFile(state.target)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(watchFile(state.sibling)), siblingFile);
  assert.equal((await api('/wallets/' + state.sibling.id + '/info')).node_id, state.siblingNode);
  assert.equal((await api('/wallets/' + state.sibling.id + '/balance')).onchain_total_sats, 0);
  await api('/wallets/' + state.sibling.id + '/stop', {});
  await waitFor(async () => (await stats()).connections.every(c => !c.active || !c.scripts.length), 'all watcher connections close');
  console.log(JSON.stringify({ checks: ['stopping receiver closes only its watcher; the running sibling retains its subscription and identity', 'deleting disposable receiver removes its saved addresses and leaves sibling data unchanged', 'stopping all wallets closes all subscription connections'] }));
`;

function phase(code, extra = {}) {
  return JSON.parse(docker(['exec', '-i', '--user', '1000:1000', manager, 'node', '--input-type=module', '-e', code], JSON.stringify({ version, proxy, ...extra })));
}

try {
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(imageInfo.Architecture, architecture); assert.equal(imageInfo.Config.Labels['org.opencontainers.image.version'], version);
  docker(['network', 'create', '--internal', network]); networkCreated = true;
  containers.push(core);
  docker(['run', '-d', '--name', core, '--network', network, '-e', 'BITCOIN_NETWORK=regtest', 'btcpayserver/bitcoin:26.0', 'bitcoind', '-regtest', '-server', '-txindex=1', '-listen=1', '-bind=0.0.0.0', '-port=18444', '-discover=0', '-dnsseed=0', '-connect=0', '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0', '-rpcport=18443', '-rpcuser=qualification', `-rpcpassword=${password}`, '-fallbackfee=0.00001']);
  let ready = false;
  for (let i = 0; i < 120; i++) { try { const chain = coreRpc('getblockchaininfo'); assert.equal(chain.chain, 'regtest'); assert.equal(chain.blocks, 0); ready = true; break; } catch {} await delay(250); }
  assert.equal(ready, true, 'new isolated Core starts at regtest genesis');
  coreRpc('createwallet', 'receive-qualification'); const miner = coreRpc('getnewaddress'); coreRpc('generatetoaddress', 101, miner);
  assert.equal(coreRpc('getblockcount'), 101);
  const coreInfo = JSON.parse(docker(['inspect', core]))[0]; const coreIp = coreInfo.NetworkSettings.Networks[network].IPAddress;
  await fs.writeFile(path.join(fixture, 'rpc.cookie'), 'qualification:' + password, { mode: 0o600 });
  containers.push(electrs);
  docker(['run', '-d', '--name', electrs, '--network', network, '--user', '0:0', '--security-opt', 'no-new-privileges:true', '--mount', `type=bind,source=${fixture},target=/fixture,readonly`, 'getumbrel/electrs:v0.10.2', '--network=regtest', '--db-dir=/tmp/electrs-index', '--daemon-dir=/tmp', '--cookie-file=/fixture/rpc.cookie', `--daemon-rpc-addr=${coreIp}:18443`, `--daemon-p2p-addr=${coreIp}:18444`, '--electrum-rpc-addr=0.0.0.0:50001', '--wait-duration-secs=1']);
  containers.push(proxy);
  docker(['run', '-d', '--name', proxy, '--network', network, '--init', '--security-opt', 'no-new-privileges:true', '--user', '1000:1000', '-e', `REAL_ELECTRS=${electrs}`, '--entrypoint', 'node', image, '-e', proxyCode]);
  const readyCheck = String.raw`
    const net=require('node:net');
    const socket=net.connect(50002,'127.0.0.1');let buffer='';process.exitCode=1;
    socket.setTimeout(3000,()=>{socket.destroy();process.exitCode=1});
    socket.on('error',()=>{process.exitCode=1});
    socket.on('connect',()=>socket.write(JSON.stringify({id:1,method:'blockchain.headers.subscribe',params:[]})+'\n'));
    socket.on('data',chunk=>{buffer+=chunk;const end=buffer.indexOf('\n');if(end>=0){const value=JSON.parse(buffer.slice(0,end));if(value.result?.height===101)process.exitCode=0;socket.destroy()}});
  `;
  let indexed = false;
  for (let i = 0; i < 120; i++) { try { docker(['exec', proxy, 'node', '-e', readyCheck]); indexed = true; break; } catch {} await delay(500); }
  assert.equal(indexed, true, 'real Electrs indexes 101 disposable regtest blocks');
  checks.push('new internal-only Core and real Electrs index 101 disposable regtest blocks; no existing fixture is used');
  containers.push(manager);
  docker(['run', '-d', '--name', manager, '--platform', `linux/${architecture}`, '--network', network, '--init', '--security-opt', 'no-new-privileges:true', '-e', 'PUBLIC_ORIGIN=http://127.0.0.1:3000', '-e', 'ALLOWED_HOSTS=127.0.0.1', image]);
  const initial = phase(create); checks.push(...initial.checks);
  let before = Date.now(); coreRpc('sendtoaddress', initial.address, '0.001');
  rounds.push({ phase: 'initial', ...phase(observe, { before, expected: 100000 }) });
  checks.push(...phase(reconnect).checks);
  before = Date.now(); coreRpc('sendtoaddress', initial.address, '0.0002');
  rounds.push({ phase: 'subscription-reconnect', ...phase(observe, { before, expected: 120000 }) });
  docker(['restart', '--time', '75', manager]);
  const restored = phase(restart, { expected: 120000 }); checks.push(...restored.checks);
  before = Date.now(); coreRpc('sendtoaddress', restored.address, '0.0003');
  rounds.push({ phase: 'manager-restart', ...phase(observe, { before, expected: 150000 }) });
  checks.push(...phase(cleanup).checks);
  const evidence = { architecture, image, image_id: imageInfo.Id, version, checks, rounds,
    backend: 'real Electrs v0.10.2 and Bitcoin Core 26.0', observation: 'transparent TCP forwarding proxy; no fabricated backend replies',
    funds: 'disposable regtest only', sats_received: 150000, blocks_mined: 101, explicit_sync_requests: 0,
    native_background_onchain_interval_seconds: 80, physical_umbrel: false, date: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'docs/qualification', `release-${version}-receive-${architecture}.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  const result = spawnSync('docker', ['logs', '--tail', '25', proxy], { encoding: 'utf8', timeout: 10000 });
  const diagnostics = (String(result.stdout || '') + String(result.stderr || '')).slice(-3000);
  throw new Error(error.message + (diagnostics ? '\nDisposable proxy diagnostics:\n' + diagnostics : ''));
} finally {
  for (const name of containers.reverse()) { try { docker(['rm', '-fv', name]); } catch {} }
  if (networkCreated) { try { docker(['network', 'rm', network]); } catch {} }
  await fs.rm(fixture, { recursive: true, force: true });
}
