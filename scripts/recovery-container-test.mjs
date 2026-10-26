#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Uses only uniquely named, disposable Docker state. No existing node is contacted.
const architecture = process.argv[2];
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Usage: node scripts/recovery-container-test.mjs amd64|arm64');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const image = `ldk-node-umbrel:${version}-${architecture}`;
const prefix = `ldk-recovery-qa-${architecture}-${randomBytes(6).toString('hex')}`;
const network = `${prefix}-net`; const frontendNetwork = `${prefix}-frontend`; const core = `${prefix}-core`;
const original = `${prefix}-original`; const restored = `${prefix}-restored`;
const originalVolume = `${prefix}-source`; const restoredVolume = `${prefix}-destination`;
const rpcPassword = randomBytes(24).toString('hex');
const dashboardPassword = randomBytes(24).toString('hex');
const backupPassphrase = randomBytes(32).toString('hex');
const checks = [];
let origin; let headers; let archived;

function docker(args, input) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', input, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // execFile errors include complete argv. Do not echo disposable passwords or input.
    throw new Error(`Docker ${args[0]} failed with status ${error.status ?? 'unknown'}`);
  }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(url) {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await delay(250);
  }
  throw new Error('Disposable manager startup timed out');
}
async function login(name) {
  const inspect = JSON.parse(docker(['inspect', name]))[0];
  origin = `http://127.0.0.1:${inspect.NetworkSettings.Ports['3000/tcp'][0].HostPort}`;
  await ready(origin);
  const response = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: dashboardPassword }) });
  assert.equal(response.status, 200, 'disposable dashboard login');
  const session = await response.json();
  headers = { origin, cookie: response.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-session-proof': session.proof, 'x-csrf-token': session.csrf };
}
async function request(route, body, expected = 200) {
  const response = await fetch(`${origin}/api${route}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
  assert.equal(response.status, expected, `status for ${route}`);
  return response.json();
}
function launch(name, volume, restoredData = false) {
  docker(['run', '-d', '--name', name, '--platform', `linux/${architecture}`, '--network', frontendNetwork, '--init', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::3000', '-v', `${volume}:/qa-data`, '-e', `DATA_DIR=${restoredData ? '/qa-data/restored' : '/qa-data'}`,
    '-e', 'ALLOWED_HOSTS=127.0.0.1', '-e', 'AUTH_MODE=password', '-e', `DASHBOARD_BOOTSTRAP_PASSWORD=${dashboardPassword}`, image]);
  docker(['network', 'connect', network, name]);
}
function helper(volume, code, input) {
  return docker(['run', '--rm', '-i', '--platform', `linux/${architecture}`, '--network', 'none', '-v', `${volume}:/qa-data`,
    '--entrypoint', 'node', '--workdir', '/opt/ldk/manager', image, '--input-type=module', '-e', code], JSON.stringify(input));
}
const readInput = "let raw=''; for await (const chunk of process.stdin) raw += chunk; const input=JSON.parse(raw); raw='';";
function verifySeedFiles(volume, directory, phraseId, legacyId, mnemonic, legacyHash) {
  helper(volume, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { createHash, timingSafeEqual } from 'node:crypto';
    import { mnemonicToSeedWebcrypto } from '@scure/bip39';
    ${readInput}
    const seed=await fs.readFile(input.directory+'/wallets/'+input.phraseId+'/node/keys_seed');
    const derived=await mnemonicToSeedWebcrypto(input.mnemonic, '');
    assert.equal(timingSafeEqual(seed, derived), true);
    seed.fill(0); derived.fill(0);
    const legacy=await fs.readFile(input.directory+'/wallets/'+input.legacyId+'/node/keys_seed');
    assert.equal(createHash('sha256').update(legacy).digest('hex'), input.legacyHash); legacy.fill(0);
    await assert.rejects(fs.stat(input.directory+'/wallets/'+input.legacyId+'/mnemonic'), {code:'ENOENT'});
    console.log('seed identities verified');
  `, { directory, phraseId, legacyId, mnemonic, legacyHash });
}

try {
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(imageInfo.Architecture, architecture); assert.equal(imageInfo.Config.Labels['org.opencontainers.image.version'], version);
  checks.push('image architecture and version verified');
  docker(['network', 'create', '--internal', network]);
  docker(['network', 'create', frontendNetwork]);
  docker(['volume', 'create', originalVolume]); docker(['volume', 'create', restoredVolume]);
  docker(['run', '-d', '--name', core, '--network', network, 'bitcoin/bitcoin:28.1', '-regtest', '-server', '-txindex=1', '-listen=0', '-discover=0',
    '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0', '-rpcport=18443', '-rpcuser=qualification', `-rpcpassword=${rpcPassword}`, '-fallbackfee=0.00001']);
  const coreRpc = (...args) => docker(['exec', core, 'bitcoin-cli', '-regtest', '-rpcuser=qualification', `-rpcpassword=${rpcPassword}`, ...args]);
  let coreReady = false;
  for (let i = 0; i < 120; i++) { try { coreRpc('getblockchaininfo'); coreReady = true; break; } catch {} await delay(250); }
  assert.equal(coreReady, true, 'disposable Bitcoin Core startup');
  coreRpc('createwallet', 'qualification'); const miningAddress = coreRpc('getnewaddress'); coreRpc('generatetoaddress', '1', miningAddress);
  checks.push('isolated disposable Bitcoin Core regtest backend');
  launch(original, originalVolume); await login(original);
  assert.equal((await fetch(`${origin}/api/wallets`)).status, 401);
  assert.equal((await request('/config')).version, version);
  checks.push('authenticated manager starts from empty disposable data');
  const chain_source = { type: 'bitcoind', host: core, port: 18443, user: 'qualification', password: rpcPassword };
  const create = name => request('/wallets', { name, network: 'regtest', chain_source, autostart: false }, 201);
  const phraseWallet = await create('Phrase qualification'); const legacyWallet = await create('Legacy qualification');
  let recovery = await request(`/wallets/${phraseWallet.id}/recovery`, { confirm: true });
  assert.equal(recovery.kind, 'mnemonic'); assert.equal(recovery.word_count, 24);
  const mnemonic = recovery.mnemonic; recovery = undefined;
  assert.equal(JSON.stringify(await request('/wallets')).includes(mnemonic), false);
  checks.push('new wallet exposes 24 words only through explicit recovery request');

  // Construct a pre-mnemonic fixture while its manager is stopped and before any
  // native start. This never edits an existing real wallet or funded identity.
  docker(['stop', '--time', '75', original]);
  const legacyHash = helper(originalVolume, `
    import assert from 'node:assert/strict'; import fs from 'node:fs/promises';
    import {randomBytes, createHash} from 'node:crypto'; ${readInput}
    const file='/qa-data/wallets.json'; const registry=JSON.parse(await fs.readFile(file, 'utf8'));
    const wallet=registry.find(value=>value.id===input.id); assert.equal(wallet.recovery_kind, 'mnemonic');
    delete wallet.recovery_kind;
    const seed=randomBytes(64); await fs.writeFile('/qa-data/wallets/'+input.id+'/node/keys_seed', seed, {mode:0o600});
    await fs.unlink('/qa-data/wallets/'+input.id+'/mnemonic');
    await fs.writeFile(file, JSON.stringify(registry), {mode:0o600});
    console.log(createHash('sha256').update(seed).digest('hex')); seed.fill(0);
  `, { id: legacyWallet.id });
  docker(['start', original]); await login(original);
  assert.deepEqual(await request(`/wallets/${legacyWallet.id}/recovery`, { confirm: true }), { kind: 'legacy_seed' });
  assert.equal((await request('/wallets')).find(wallet => wallet.id === legacyWallet.id).recovery_kind, 'legacy_seed');
  verifySeedFiles(originalVolume, '/qa-data', phraseWallet.id, legacyWallet.id, mnemonic, legacyHash);
  checks.push('legacy random seed remains unchanged and is never presented as a mnemonic');
  checks.push('stored new-wallet seed equals BIP39 derivation of displayed words');

  const identities = new Map();
  for (const wallet of [phraseWallet, legacyWallet]) {
    await request(`/wallets/${wallet.id}/start`, {});
    const info = await request(`/wallets/${wallet.id}/info`);
    assert.equal(info.network, 'regtest'); assert.match(info.node_id, /^(02|03)[0-9a-f]{64}$/);
    identities.set(wallet.id, info.node_id);
    const address = await request(`/wallets/${wallet.id}/rpc`, { method: 'address', params: {} }); assert.match(address.address, /^bcrt1/);
    const balance = await request(`/wallets/${wallet.id}/balance`); assert.equal(balance.onchain_total_sats, 0);
  }
  checks.push('real native daemon starts both wallet kinds and creates regtest addresses with zero funds');
  await request('/backup/export', { confirm: true, passphrase: backupPassphrase }, 409);
  checks.push('backup refuses running native wallets');
  for (const wallet of [phraseWallet, legacyWallet]) await request(`/wallets/${wallet.id}/stop`, {});
  const download = await fetch(`${origin}/api/backup/export`, { method: 'POST', headers, body: JSON.stringify({ confirm: true, passphrase: backupPassphrase }), signal: AbortSignal.timeout(150_000) });
  assert.equal(download.status, 200); assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.match(download.headers.get('content-disposition'), /\.ldkbackup/);
  archived = Buffer.from(await download.arrayBuffer()); assert.equal(archived.includes(Buffer.from(mnemonic)), false);
  checks.push('stopped full backup downloads as an uncached authenticated encrypted attachment');
  docker(['stop', '--time', '75', original]); docker(['rm', original]);
  helper(restoredVolume, `
    import {restoreBackup} from '/opt/ldk/manager/server/backup.mjs'; ${readInput}
    const archive=Buffer.from(input.archive, 'base64');
    await restoreBackup(archive, input.passphrase, '/qa-data/restored'); archive.fill(0);
    console.log('offline restore complete');
  `, { archive: archived.toString('base64'), passphrase: backupPassphrase });
  archived.fill(0); archived = undefined;
  verifySeedFiles(restoredVolume, '/qa-data/restored', phraseWallet.id, legacyWallet.id, mnemonic, legacyHash);
  checks.push('offline restore into a separate volume preserves both seed identities and private state');
  launch(restored, restoredVolume, true); await login(restored);
  assert.equal((await request('/wallets')).every(wallet => wallet.status === 'stopped'), true);
  assert.equal((await request(`/wallets/${phraseWallet.id}/recovery`, { confirm: true })).mnemonic, mnemonic);
  assert.deepEqual(await request(`/wallets/${legacyWallet.id}/recovery`, { confirm: true }), { kind: 'legacy_seed' });
  for (const wallet of [phraseWallet, legacyWallet]) {
    await request(`/wallets/${wallet.id}/start`, {});
    assert.equal((await request(`/wallets/${wallet.id}/info`)).node_id, identities.get(wallet.id));
    await request(`/wallets/${wallet.id}/stop`, {});
  }
  checks.push('restored native wallets retain both node identities after original container removal');
  checks.push('restored dashboard retains authentication and explicit phrase recovery');
  const evidence = { architecture, image, image_id: imageInfo.Id, version, checks, network: 'regtest', funds_sent: false,
    native_wallet_created: true, legacy_wallet_fixture: true, physical_umbrel: false, date: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'docs/qualification', `release-${version}-${architecture}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  archived?.fill(0);
  for (const name of [original, restored, core]) { try { docker(['rm', '-f', name]); } catch {} }
  for (const volume of [originalVolume, restoredVolume]) { try { docker(['volume', 'rm', volume]); } catch {} }
  try { docker(['network', 'rm', network]); } catch {}
  try { docker(['network', 'rm', frontendNetwork]); } catch {}
}
