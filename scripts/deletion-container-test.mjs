#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// All wallets, containers and the internal-only Bitcoin Core belong to this
// invocation. No blocks are mined, no funds are used and no host ports open.
const architecture = process.argv[2];
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Usage: node scripts/deletion-container-test.mjs amd64|arm64');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const image = `ldk-node-umbrel:${version}-${architecture}`;
const prefix = `ldk-deletion-qa-${architecture}-${randomBytes(6).toString('hex')}`;
const network = `${prefix}-network`; const core = `${prefix}-core`; const manager = `${prefix}-manager`;
const rpcPassword = randomBytes(24).toString('hex');
const containers = []; const checks = [];
let networkCreated = false;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function docker(args, input) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', input, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // Disposable credentials and private test snapshots never appear in errors.
    throw new Error(`Docker ${args[0]} failed (${error.status ?? 'unknown'}): ${String(error.stderr || '').slice(-2000)}`);
  }
}

const common = String.raw`
  import assert from 'node:assert/strict';
  import fs from 'node:fs/promises';
  import path from 'node:path';
  import { createHash, randomBytes } from 'node:crypto';
  import { setTimeout as delay } from 'node:timers/promises';
  import { restoreBackup } from '/opt/ldk/manager/server/backup.mjs';
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw); raw = '';
  const origin = 'http://127.0.0.1:3000'; const checks = [];
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(origin + '/healthz')).ok) break; } catch {}
    assert.ok(attempt < 120, 'shipping manager becomes healthy'); await delay(250);
  }
  const password = (await fs.readFile('/data/dashboard-password', 'utf8')).trim();
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const session = await login.json();
  const headers = { origin, cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-session-proof': session.proof, 'x-csrf-token': session.csrf };
  async function request(route, method = 'GET', body, expected = 200, code, customHeaders = headers) {
    const response = await fetch(origin + '/api' + route, { method, headers: customHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, expected, method + ' ' + route + ': ' + (value.error?.code || response.status));
    if (code) assert.equal(value.error?.code, code); return value;
  }
  const list = () => request('/wallets');
  const settings = name => ({ name, network: 'regtest', autostart: false, chain_source: { type: 'bitcoind', host: input.core, port: 18443, user: 'qualification', password: input.password } });
  const confirm = wallet => ({ confirmation_name: wallet.name, acknowledge_data_loss: true });
  const route = wallet => '/wallets/' + wallet.id;
  const directory = wallet => '/data/wallets/' + wallet.id;
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  async function tree(directory, skipLocks = false) {
    const result = {};
    async function walk(at, relative = '') {
      for (const name of (await fs.readdir(at)).sort()) {
        const child = relative ? relative + '/' + name : name;
        if (skipLocks && child === 'node/daemon.lock') continue;
        const target = path.join(at, name); const stat = await fs.lstat(target);
        assert.equal(stat.isSymbolicLink(), false);
        if (stat.isDirectory()) { result[child + '/'] = 'directory'; await walk(target, child); }
        else { assert.equal(stat.isFile(), true); result[child] = sha(await fs.readFile(target)); }
      }
    }
    await walk(directory); return result;
  }
  async function identity(wallet) {
    return { seed: sha(await fs.readFile(path.join(directory(wallet), 'node/keys_seed'))), mnemonic: sha(await fs.readFile(path.join(directory(wallet), 'mnemonic'))) };
  }
  const statePath = '/tmp/deletion-qualification-state.json';
  async function save(value) { await fs.writeFile(statePath, JSON.stringify(value), { mode: 0o600 }); }
  const readState = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
`;

const firstPhase = common + String.raw`
  const config = await request('/config'); assert.equal(config.version, input.version); assert.equal(config.tor_available, true);
  const asset = await fetch(origin + '/app.js'); const source = await asset.text();
  assert.equal(sha(source), sha(await fs.readFile('/opt/ldk/manager/public/app.js')));
  assert.match(source, /Permanently delete wallet/); assert.deepEqual(await list(), []);
  checks.push('shipping manager version, bundled Tor availability and exact served deletion UI verified');
  const target = await request('/wallets', 'POST', settings('Deletion target'), 201);
  const sibling = await request('/wallets', 'POST', settings('Preserved sibling'), 201);
  await request(route(target) + '/start', 'POST', {}); await request(route(sibling) + '/start', 'POST', {});
  const targetNode = (await request(route(target) + '/info')).node_id;
  const siblingNode = (await request(route(sibling) + '/info')).node_id;
  assert.notEqual(targetNode, siblingNode);
  for (const wallet of [target, sibling]) assert.equal((await request(route(wallet) + '/balance')).onchain_total_sats, 0);
  await request(route(target), 'DELETE', confirm(target), 409, 'STOP_REQUIRED');
  assert.equal((await list()).length, 2);
  checks.push('two real native regtest wallets start with distinct identities and zero funds; active deletion is refused');
  await request(route(target) + '/stop', 'POST', {});
  const original = await tree(directory(target)); const siblingIdentity = await identity(sibling);
  await request(route(target), 'DELETE', confirm(target), 401, undefined, { origin, 'content-type': 'application/json' });
  await request(route(target), 'DELETE', confirm(target), 401, undefined, { origin, cookie: headers.cookie, 'content-type': 'application/json' });
  const noCsrf = { ...headers }; delete noCsrf['x-csrf-token'];
  await request(route(target), 'DELETE', confirm(target), 403, 'CSRF_REJECTED', noCsrf);
  await request(route(target), 'DELETE', confirm(target), 403, 'ORIGIN_REJECTED', { ...headers, origin: 'http://other.invalid' });
  await request(route(target), 'DELETE', confirm(target), 415, undefined, { ...headers, 'content-type': 'text/plain' });
  await request(route(target), 'DELETE', { ...confirm(target), confirmation_name: target.name.toLowerCase() }, 400, 'CONFIRMATION_REQUIRED');
  await request(route(target), 'DELETE', { confirmation_name: target.name }, 400, 'CONFIRMATION_REQUIRED');
  assert.deepEqual(await tree(directory(target)), original); assert.equal((await list()).length, 2);
  checks.push('anonymous, cookie-only, wrong-origin, missing-CSRF, non-JSON and incomplete confirmations leave target data intact');
  assert.deepEqual(await request(route(target), 'DELETE', confirm(target)), { deleted: true, id: target.id });
  await assert.rejects(fs.stat(directory(target)), { code: 'ENOENT' });
  assert.deepEqual((await list()).map(wallet => wallet.id), [sibling.id]);
  assert.equal((await request(route(sibling) + '/info')).node_id, siblingNode);
  assert.deepEqual(await identity(sibling), siblingIdentity);
  assert.equal((await list())[0].status, 'running');
  await request(route(target), 'DELETE', confirm(target), 404, 'NOT_FOUND');
  checks.push('confirmed deletion removes only the stopped target while its running sibling retains identity and data');
  await save({ target, targetNode, sibling, siblingNode, siblingIdentity, targetIdentity: { seed: original['node/keys_seed'] } });
  console.log(JSON.stringify({ checks }));
`;

const secondPhase = common + String.raw`
  const state = await readState(); const { target, sibling, siblingNode, siblingIdentity } = state;
  assert.deepEqual((await list()).map(wallet => wallet.id), [sibling.id]);
  await assert.rejects(fs.stat(directory(target)), { code: 'ENOENT' });
  await request(route(sibling) + '/start', 'POST', {});
  assert.equal((await request(route(sibling) + '/info')).node_id, siblingNode);
  assert.deepEqual(await identity(sibling), siblingIdentity);
  await request(route(sibling) + '/stop', 'POST', {});
  checks.push('manager restart does not resurrect the deleted wallet and the surviving native node keeps its identity');
  const stableSibling = await tree(directory(sibling));
  const replacement = await request('/wallets', 'POST', settings('Replacement'), 201);
  assert.equal(replacement.public_port, target.public_port); assert.notEqual(replacement.id, target.id);
  assert.notEqual((await identity(replacement)).seed, state.targetIdentity.seed);
  await request(route(replacement) + '/start', 'POST', {});
  const replacementNode = (await request(route(replacement) + '/info')).node_id;
  assert.notEqual(replacementNode, siblingNode); assert.notEqual(replacementNode, state.targetNode);
  assert.equal((await request(route(replacement) + '/balance')).onchain_total_sats, 0);
  await request(route(replacement) + '/stop', 'POST', {});
  await request(route(replacement), 'DELETE', confirm(replacement));
  assert.deepEqual(await tree(directory(sibling)), stableSibling);
  checks.push('released slot and ports are reused with a fresh UUID, seed and native identity; sibling files remain byte-identical');
  const pending = await request('/wallets', 'POST', settings('Interrupted deletion'), 201);
  await request(route(pending), 'PUT', { ...settings(pending.name), autostart: true });
  // Private but nonwritable parent permits validation and durable intent, then
  // prevents removing the selected directory entry. Only this test volume changes.
  await fs.chmod('/data/wallets', 0o500);
  try { await request(route(pending), 'DELETE', confirm(pending), 500, 'DELETE_INCOMPLETE'); }
  finally { await fs.chmod('/data/wallets', 0o700); }
  const marked = (await list()).find(wallet => wallet.id === pending.id);
  assert.equal(marked.deletion_pending, true); assert.equal(marked.status, 'deletion_pending');
  assert.equal(marked.public_port, pending.public_port);
  for (const [suffix, method, body] of [['/start', 'POST', {}], ['', 'PUT', settings(pending.name)], ['/recovery', 'POST', { confirm: true }]]) {
    await request(route(pending) + suffix, method, body, 409, 'DELETE_PENDING');
  }
  await request('/backup/export', 'POST', { confirm: true, passphrase: 'disposable backup passphrase' }, 409, 'DELETE_PENDING');
  assert.deepEqual(await tree(directory(sibling)), stableSibling);
  await save({ ...state, pending, stableSibling, pendingTree: await tree(directory(pending)) });
  checks.push('real filesystem cleanup failure leaves a durable pending record, reserves its slot and blocks start, editing, recovery and backup');
  console.log(JSON.stringify({ checks }));
`;

const thirdPhase = common + String.raw`
  const { sibling, siblingNode, siblingIdentity, pending, stableSibling, pendingTree } = await readState();
  const marked = (await list()).find(wallet => wallet.id === pending.id);
  assert.equal(marked.deletion_pending, true); assert.equal(marked.status, 'deletion_pending'); assert.equal(marked.autostart, true);
  assert.deepEqual(await tree(directory(pending)), pendingTree);
  for (const pid of (await fs.readdir('/proc')).filter(name => /^[0-9]+$/.test(name))) {
    try { assert.equal((await fs.readFile('/proc/' + pid + '/cmdline', 'utf8')).includes(directory(pending) + '/node.json'), false); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  await request(route(pending) + '/start', 'POST', {}, 409, 'DELETE_PENDING');
  const slotProbe = await request('/wallets', 'POST', settings('Reserved slot check'), 201);
  assert.notEqual(slotProbe.public_port, pending.public_port);
  await request(route(slotProbe), 'DELETE', confirm(slotProbe));
  assert.deepEqual(await request(route(pending), 'DELETE', confirm(pending)), { deleted: true, id: pending.id });
  await assert.rejects(fs.stat(directory(pending)), { code: 'ENOENT' });
  assert.deepEqual((await list()).map(wallet => wallet.id), [sibling.id]);
  assert.deepEqual(await tree(directory(sibling)), stableSibling);
  checks.push('pending deletion survives restart without autostart or automatic cleanup; explicit confirmation completes retry and preserves sibling bytes');
  const passphrase = randomBytes(24).toString('hex');
  const response = await fetch(origin + '/api/backup/export', { method: 'POST', headers, body: JSON.stringify({ confirm: true, passphrase }) });
  assert.equal(response.status, 200); const archive = Buffer.from(await response.arrayBuffer());
  const restoreRoot = await fs.mkdtemp('/tmp/deletion-backup-'); const restored = path.join(restoreRoot, 'restored');
  try {
    await restoreBackup(archive, passphrase, restored);
    const registry = JSON.parse(await fs.readFile(path.join(restored, 'wallets.json'), 'utf8'));
    assert.deepEqual(registry.map(wallet => wallet.id), [sibling.id]);
    assert.deepEqual(await fs.readdir(path.join(restored, 'wallets')), [sibling.id]);
    assert.deepEqual(await tree(path.join(restored, 'wallets', sibling.id), true), await tree(directory(sibling), true));
  } finally { archive.fill(0); await fs.rm(restoreRoot, { recursive: true, force: true }); }
  await request(route(sibling) + '/start', 'POST', {});
  assert.equal((await request(route(sibling) + '/info')).node_id, siblingNode);
  assert.deepEqual(await identity(sibling), siblingIdentity);
  assert.equal((await request(route(sibling) + '/balance')).onchain_total_sats, 0);
  await request(route(sibling) + '/stop', 'POST', {});
  checks.push('authenticated full backup restores only the surviving wallet with matching data; its native node restarts with the original identity');
  await fs.unlink(statePath); console.log(JSON.stringify({ checks }));
`;

try {
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(imageInfo.Architecture, architecture); assert.equal(imageInfo.Config.Labels['org.opencontainers.image.version'], version);
  docker(['network', 'create', '--internal', network]); networkCreated = true;
  containers.push(core);
  docker(['run', '-d', '--name', core, '--network', network, 'bitcoin/bitcoin:28.1', '-regtest', '-server', '-txindex=1', '-listen=0', '-discover=0', '-dnsseed=0', '-connect=0', '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0', '-rpcport=18443', '-rpcuser=qualification', `-rpcpassword=${rpcPassword}`, '-fallbackfee=0.00001']);
  let coreReady = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const chain = JSON.parse(docker(['exec', core, 'bitcoin-cli', '-regtest', '-rpcuser=qualification', `-rpcpassword=${rpcPassword}`, 'getblockchaininfo'])); assert.equal(chain.blocks, 0); coreReady = true; break; } catch {}
    await delay(250);
  }
  assert.equal(coreReady, true, 'isolated regtest Core startup');
  checks.push('disposable internal-only Bitcoin Core starts at genesis without mining');
  containers.push(manager);
  docker(['run', '-d', '--name', manager, '--platform', `linux/${architecture}`, '--network', network, '--init', '--security-opt', 'no-new-privileges:true', '-e', 'PUBLIC_ORIGIN=http://127.0.0.1:3000', '-e', 'ALLOWED_HOSTS=127.0.0.1', image]);
  for (const [index, code] of [firstPhase, secondPhase, thirdPhase].entries()) {
    if (index) docker(['restart', '--time', '75', manager]);
    const result = JSON.parse(docker(['exec', '-i', '--user', '1000:1000', manager, 'node', '--input-type=module', '-e', code], JSON.stringify({ version, core, password: rpcPassword })));
    checks.push(...result.checks);
  }
  const evidence = { architecture, image, image_id: imageInfo.Id, version, checks, native_wallets: 'real shipping daemon',
    deletion_transport_children: 'disabled', funds_sent: false, blocks_mined: false, physical_umbrel: false, date: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'docs/qualification', `release-${version}-deletion-${architecture}.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const name of containers.reverse()) { try { docker(['rm', '-fv', name]); } catch {} }
  if (networkCreated) { try { docker(['network', 'rm', network]); } catch {} }
}
