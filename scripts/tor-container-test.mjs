#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every container and network belongs to this invocation. The real native daemon
// uses an isolated regtest Core; Tor networking is disabled. No blocks are mined.
const architecture = process.argv[2];
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Usage: node scripts/tor-container-test.mjs amd64|arm64');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const image = `ldk-node-umbrel:${version}-${architecture}`;
const prefix = `ldk-tor-qa-${architecture}-${randomBytes(6).toString('hex')}`;
const network = `${prefix}-network`; const core = `${prefix}-core`;
const manager = `${prefix}-manager`; const helper = `${prefix}-helper`;
const rpcPassword = randomBytes(24).toString('hex');
const checks = [];
let networkCreated = false;
const containers = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function docker(args, input) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8', input, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    // Never print argv or stdin, which carry disposable credentials and fixtures.
    throw new Error(`Docker ${args[0]} failed (${error.status ?? 'unknown'}): ${String(error.stderr || '').slice(-2000)}`);
  }
}

const shippingCheck = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import { createHash } from 'node:crypto';
  import { setTimeout as delay } from 'node:timers/promises';
  const origin = 'http://127.0.0.1:3000'; let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(origin + '/healthz')).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.equal(ready, true);
  assert.equal((await fetch(origin + '/api/wallets')).status, 401);
  const password = (await fs.readFile('/data/dashboard-password', 'utf8')).trim();
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = { origin, cookie: login.headers.get('set-cookie').split(';')[0], 'x-session-proof': session.proof, 'x-csrf-token': session.csrf };
  const config = await (await fetch(origin + '/api/config', { headers })).json();
  assert.equal(config.tor_available, true);
  assert.deepEqual(await (await fetch(origin + '/api/wallets', { headers })).json(), []);
  for (const name of ['app.js', 'pairing.js', 'style.css']) {
    const response = await fetch(origin + '/' + name); assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(await fs.readFile('/opt/ldk/manager/public/' + name)).digest('hex'));
    if (name.endsWith('.js')) assert.match(response.headers.get('content-type'), /^text\/javascript/);
    if (name === 'app.js') assert.match(bytes.toString(), /Enable Tor connections/);
  }
  for (const pid of (await fs.readdir('/proc')).filter(name => /^[0-9]+$/.test(name))) {
    try { assert.notEqual((await fs.readFile('/proc/' + pid + '/comm', 'utf8')).trim(), 'tor'); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  console.log(JSON.stringify({ version: config.version, checks: ['shipping manager advertises bundled Tor after authenticated login', 'served UI exposes Enable Tor connections with exact packaged asset bytes', 'empty default installation runs no Tor process'] }));
`;

const bridgeFixture = String.raw`
    const fs = require('node:fs'); const crypto = require('node:crypto');
    const arg = name => process.argv[process.argv.indexOf(name) + 1];
    const file = arg('--identity'); let key;
    try { key = fs.readFileSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; key = crypto.randomBytes(32); fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' }); }
    const endpointId = crypto.createHash('sha256').update(key).digest('hex');
    console.log(JSON.stringify({ ready: true, uri: arg('--node-id') + '@iroh:' + endpointId, endpointId }));
    setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0));
`;

const lifecycleCheck = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import path from 'node:path';
  import { spawn } from 'node:child_process';
  import { setTimeout as delay } from 'node:timers/promises';
  import { WalletManager } from '/opt/ldk/manager/server/wallets.mjs';
  import { TorProcess } from '/opt/ldk/manager/server/tor.mjs';
  import { restoreBackup } from '/opt/ldk/manager/server/backup.mjs';
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw); raw = '';
  const root = await fs.mkdtemp('/tmp/ldk-tor-lifecycle-');
  const source = path.join(root, 'source'); await fs.mkdir(source, { mode: 0o700 });
  const destination = path.join(root, 'restored');
  const bridge = path.join(root, 'iroh-fixture.cjs');
  // Only the Iroh network boundary is a fixture. This is a real child process
  // using WalletManager's unchanged startup, identity file and shutdown paths.
  await fs.writeFile(bridge, input.bridge, { mode: 0o600 });
  const tors = []; const managers = []; const checks = [];
  function createManager(dataDir) {
    const manager = new WalletManager({ dataDir, binary: '/opt/ldk/bin/ldk-node-daemon', bridge, torBinary: '/usr/bin/tor',
      torFactory: options => {
        const tor = new TorProcess({ ...options, spawnProcess: (binary, args, options) => spawn(binary, [...args, '--DisableNetwork', '1'], options) });
        tors.push(tor); return tor;
      } });
    managers.push(manager); return manager;
  }
  async function waitFor(check, message, milliseconds = 20000) {
    const end = performance.now() + milliseconds;
    while (performance.now() < end) { if (await check()) return; await delay(25); }
    throw new Error(message);
  }
  async function waitOnion(manager, id) {
    await waitFor(() => {
      const state = manager.state(id);
      if (state.tor?.error) throw new Error(state.tor.error);
      return Boolean(manager.pairing(id, 'umbrel.local').tor_uri);
    }, 'managed Tor did not produce a private onion identity');
    return manager.pairing(id, 'umbrel.local');
  }
  const settings = { name: 'Tor lifecycle', network: 'regtest', chain_source: { type: 'bitcoind', host: input.core, port: 18443, user: 'qualification', password: input.password }, autostart: false };
  const enabled = { ...settings, tor: { enabled: true }, iroh: { enabled: true, discovery: true, default_relays: true } };
  let paused; let archive;
  try {
    const manager = createManager(source); await manager.initialize();
    const wallet = await manager.create(settings); const id = wallet.id;
    const directory = manager.directory(id);
    await manager.start(id);
    assert.equal(manager.state(id).status, 'running'); assert.equal(manager.torProcesses.size, 0); assert.equal(tors.length, 0);
    assert.equal(manager.pairing(id, 'umbrel.local').tor_status, 'disabled');
    const nodeId = (await manager.call(id, 'info')).node_id;
    assert.match(nodeId, /^(02|03)[0-9a-f]{64}$/);
    assert.equal((await manager.call(id, 'balance')).onchain_total_sats, 0);
    await manager.stop(id);
    checks.push('real native regtest wallet starts with zero funds and Tor disabled by default');

    await manager.update(id, enabled); await manager.start(id);
    let pairing = await waitOnion(manager, id);
    assert.equal(pairing.node_id, nodeId); assert.equal(pairing.tor_status, 'bootstrapping');
    assert.match(pairing.tor_uri, new RegExp('^' + nodeId + '@[a-z2-7]{56}\\.onion:9735$'));
    assert.equal(pairing.tcp_uri, nodeId + '@umbrel.local:19351');
    assert.match(pairing.iroh_uri, new RegExp('^' + nodeId + '@iroh:[0-9a-f]{64}$'));
    const onionUri = pairing.tor_uri; const irohUri = pairing.iroh_uri;
    const tor = manager.state(id).tor;
    const secretPath = path.join(directory, 'tor/onion/hs_ed25519_secret_key');
    const secret = await fs.readFile(secretPath);
    assert.equal((await fs.stat(secretPath)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.dirname(secretPath))).mode & 0o077, 0);
    assert.equal(secret.length, 96); assert.ok(tor.cacheDirectory);
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      const ports = (await fs.readFile(file, 'utf8')).trim().split('\n').slice(1).filter(line => line.trim().split(/\s+/)[3] === '0A').map(line => parseInt(line.trim().split(/\s+/)[1].split(':')[1], 16));
      for (const port of [9050, 9051, 29051]) assert.equal(ports.includes(port), false);
    }
    checks.push('real Tor creates private v3 keys while native TCP and the Iroh fixture stay available');
    checks.push('Tor remains bootstrapping with network disabled and exposes no SOCKS or control listeners');
    await assert.rejects(manager.backup('disposable backup passphrase'), { code: 'STOP_REQUIRED' });

    // Pause only this disposable child to make the stop/backup boundary
    // deterministic, then resume so its pending SIGTERM can finish normally.
    paused = tor.child; paused.kill('SIGSTOP');
    await waitFor(async () => /^State:\s+T/m.test(await fs.readFile('/proc/' + paused.pid + '/status', 'utf8')), 'Tor child did not pause');
    const stop = manager.stop(id); await delay(50);
    assert.equal(manager.state(id).status, 'stopping'); assert.equal(tor.closed, false);
    await assert.rejects(manager.backup('disposable backup passphrase'), { code: 'STOP_REQUIRED' });
    await assert.rejects(manager.start(id), /already active/);
    paused.kill('SIGCONT'); paused = null; await stop;
    await waitFor(() => manager.torProcesses.size === 0 && manager.irohChildren.size === 0, 'child process tracking did not clear');
    assert.equal(tor.closed, true); assert.equal(tor.cacheDirectory, null);
    checks.push('backup and restart remain blocked until a real paused Tor child exits and cache cleanup completes');

    await manager.start(id); pairing = await waitOnion(manager, id);
    assert.equal(pairing.tor_uri, onionUri); assert.equal(pairing.iroh_uri, irohUri); assert.equal(pairing.node_id, nodeId);
    assert.deepEqual(await fs.readFile(secretPath), secret);
    checks.push('normal stop/start preserves native, onion and Iroh fixture identities');
    const failedTor = manager.state(id).tor; failedTor.child.kill('SIGKILL');
    await waitFor(() => failedTor.closed, 'killed Tor child did not settle');
    pairing = manager.pairing(id, 'umbrel.local');
    assert.equal(pairing.tor_uri, null); assert.equal(pairing.tor_status, 'failed');
    assert.equal(pairing.iroh_uri, irohUri); assert.equal(manager.state(id).status, 'running');
    assert.equal((await manager.call(id, 'info')).node_id, nodeId);
    await manager.stop(id);
    checks.push('unexpected real Tor exit clears the onion without stopping native or Iroh connections');

    await manager.start(id); await waitOnion(manager, id);
    const nativeState = manager.state(id); nativeState.process.child.kill('SIGTERM');
    await waitFor(() => nativeState.process.closed && nativeState.tor.closed && manager.torProcesses.size === 0 && manager.irohChildren.size === 0, 'native exit did not close transport children');
    assert.equal(nativeState.status, 'failed'); assert.equal(nativeState.tor.address, null);
    await assert.rejects(manager.backup('disposable backup passphrase'), { code: 'STOP_REQUIRED' });
    await manager.stop(id);
    checks.push('unexpected native exit stops real Tor and the Iroh child before explicit stopped-state backup admission');

    const count = tors.length;
    await manager.update(id, { ...enabled, tor: { enabled: false } }); await manager.start(id);
    assert.equal(tors.length, count); assert.equal(manager.torProcesses.size, 0);
    assert.equal(manager.pairing(id, 'umbrel.local').tor_uri, null);
    assert.deepEqual(await fs.readFile(secretPath), secret);
    await manager.stop(id); await manager.update(id, enabled); await manager.start(id);
    assert.equal((await waitOnion(manager, id)).tor_uri, onionUri); await manager.stop(id);
    checks.push('disabling Tor launches no Tor process and retains its identity for later re-enablement');

    const files = ['node/keys_seed', 'iroh.key', 'tor/onion/hs_ed25519_secret_key', 'tor/onion/hs_ed25519_public_key', 'tor/onion/hostname', 'tor/identity.json', 'tor/data/state'];
    const saved = new Map(); for (const name of files) saved.set(name, await fs.readFile(path.join(directory, name)));
    assert.ok(saved.get('tor/data/state').length > 0);
    archive = await manager.backup('disposable backup passphrase');
    assert.equal(archive.includes(secret), false);
    await manager.close(); await fs.rm(source, { recursive: true, force: true });
    await restoreBackup(archive, 'disposable backup passphrase', destination); archive.fill(0); archive = null;
    for (const [name, bytes] of saved) {
      const file = path.join(destination, 'wallets', id, name);
      assert.deepEqual(await fs.readFile(file), bytes); assert.equal((await fs.stat(file)).mode & 0o077, 0);
    }
    checks.push('encrypted full backup restores native keys, onion keys and complete Tor state byte-for-byte after source removal');
    const restored = createManager(destination); await restored.initialize(); await restored.start(id);
    const restoredPairing = await waitOnion(restored, id);
    assert.equal(restoredPairing.node_id, nodeId); assert.equal(restoredPairing.tor_uri, onionUri); assert.equal(restoredPairing.iroh_uri, irohUri);
    assert.equal((await restored.call(id, 'balance')).onchain_total_sats, 0); await restored.stop(id);
    assert.equal(restored.torProcesses.size, 0);
    checks.push('restored real native node and Tor retain their identities with zero funds');
    console.log(JSON.stringify({ checks, native_wallet_created: true, iroh_network_boundary: 'subprocess fixture', tor_network: 'disabled', entry_guard_selection_tested: false, live_onion_reachability_tested: false }));
  } finally {
    paused?.kill('SIGCONT'); archive?.fill(0);
    await Promise.all(managers.map(manager => manager.close()));
    await Promise.all(tors.map(tor => tor.stop()));
    await fs.rm(root, { recursive: true, force: true });
  }
`;

try {
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(imageInfo.Architecture, architecture);
  assert.equal(imageInfo.Config.Labels['org.opencontainers.image.version'], version);
  checks.push('candidate release architecture and version verified');
  containers.push(manager);
  docker(['run', '-d', '--name', manager, '--platform', `linux/${architecture}`, '--network', 'none', '--init', '--security-opt', 'no-new-privileges:true', '-e', 'PUBLIC_ORIGIN=http://127.0.0.1:3000', '-e', 'ALLOWED_HOSTS=127.0.0.1', image]);
  const shipping = JSON.parse(docker(['exec', '--user', '1000:1000', manager, 'node', '--input-type=module', '-e', shippingCheck]));
  assert.equal(shipping.version, version); checks.push(...shipping.checks);
  docker(['network', 'create', '--internal', network]); networkCreated = true;
  containers.push(core);
  docker(['run', '-d', '--name', core, '--network', network, 'bitcoin/bitcoin:28.1', '-regtest', '-server', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-connect=0', '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0', '-rpcport=18443', '-rpcuser=qualification', `-rpcpassword=${rpcPassword}`, '-fallbackfee=0.00001']);
  let coreReady = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const chain = JSON.parse(docker(['exec', core, 'bitcoin-cli', '-regtest', '-rpcuser=qualification', `-rpcpassword=${rpcPassword}`, 'getblockchaininfo'])); assert.equal(chain.blocks, 0); coreReady = true; break; } catch {}
    await delay(250);
  }
  assert.equal(coreReady, true, 'isolated regtest Core startup'); checks.push('disposable internal-only Bitcoin Core starts at genesis without mining');
  containers.push(helper);
  docker(['run', '-d', '--name', helper, '--platform', `linux/${architecture}`, '--network', network, '--init', '--security-opt', 'no-new-privileges:true', '--user', '1000:1000', '--entrypoint', 'sleep', image, '900']);
  const lifecycle = JSON.parse(docker(['exec', '-i', '--user', '1000:1000', helper, 'node', '--input-type=module', '-e', lifecycleCheck], JSON.stringify({ core, password: rpcPassword, bridge: bridgeFixture })));
  checks.push(...lifecycle.checks);
  const evidence = { architecture, image, image_id: imageInfo.Id, version, ...lifecycle, checks,
    funds_sent: false, blocks_mined: false, physical_umbrel: false, date: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'docs/qualification', `release-${version}-tor-${architecture}.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const name of containers.reverse()) { try { docker(['rm', '-fv', name]); } catch {} }
  if (networkCreated) { try { docker(['network', 'rm', network]); } catch {} }
}
