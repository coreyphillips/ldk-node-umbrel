#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Real encrypted Lightning handshakes against disposable released containers.
// No user wallet, public peer, existing backend or funds are used.
const architecture = process.argv[2];
assert.ok(['amd64', 'arm64'].includes(architecture), 'Usage: BEIGNET_ROOT=/path/to/beignet node scripts/feature-bits-container-test.mjs amd64|arm64');
assert.ok(process.env.BEIGNET_ROOT, 'Set BEIGNET_ROOT to the updated Beignet source checkout');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (await fs.readFile(path.join(root, 'VERSION'), 'utf8')).trim();
const beignet = path.resolve(process.env.BEIGNET_ROOT);
const require = createRequire(path.join(beignet, 'package.json'));
require('ts-node').register({ project: path.join(beignet, 'tsconfig.json'), transpileOnly: true });
const { Peer } = require(path.join(beignet, 'src/lightning/transport/peer.ts'));
const { Feature, implementedFeatures } = require(path.join(beignet, 'src/lightning/features/flags.ts'));
assert.equal(Feature.OPTION_FF_RECEIVE, 440);
assert.equal(Feature.OPTION_FF_CONCURRENT, 442);
assert.equal(Feature.ASYNC_RECEIVE_SERVICE, 444);
const prefix = `ldk-features-${architecture}-${randomBytes(6).toString('hex')}`;
const network = `${prefix}-internal`, frontend = `${prefix}-frontend`;
const core = `${prefix}-core`, manager = `${prefix}-manager`, volume = `${prefix}-data`;
const rpcPassword = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
const checks = [], observations = [];
let origin, headers, lightningPort;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(args) {
  try { return execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`Docker ${args[0]} failed with status ${error.status ?? 'unknown'}`); }
}
async function wait(check, description) {
  for (let i = 0; i < 120; i++) { try { const value = await check(); if (value) return value; } catch {} await delay(250); }
  throw new Error(`Timed out: ${description}`);
}
async function launch(image) {
  docker(['run', '-d', '--name', manager, '--platform', `linux/${architecture}`, '--network', frontend, '--init', '--security-opt', 'no-new-privileges:true',
    '-p', '127.0.0.1::3000', '-p', '127.0.0.1::9735', '-v', `${volume}:/data`, '-e', 'ALLOWED_HOSTS=127.0.0.1', '-e', 'AUTH_MODE=password',
    '-e', `DASHBOARD_BOOTSTRAP_PASSWORD=${password}`, image]);
  docker(['network', 'connect', network, manager]);
  const ports = JSON.parse(docker(['inspect', manager]))[0].NetworkSettings.Ports;
  origin = `http://127.0.0.1:${ports['3000/tcp'][0].HostPort}`;
  lightningPort = Number(ports['9735/tcp'][0].HostPort);
  await wait(async () => (await fetch(`${origin}/healthz`)).ok, 'manager health');
  const response = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200);
  const session = await response.json();
  headers = { origin, cookie: response.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-session-proof': session.proof, 'x-csrf-token': session.csrf };
}
async function api(route, body, method) {
  const response = await fetch(`${origin}/api${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const value = await response.json(); assert.ok(response.ok, `API ${route}: ${JSON.stringify(value)}`); return value;
}
async function running(id) {
  return wait(async () => { const wallet = (await api('/wallets')).find(w => w.id === id); return wallet?.status === 'running' ? wallet : null; }, 'native wallet startup');
}
async function inspectFeatures(nodeId, expected, phase) {
  const peer = new Peer({ localPrivateKey: randomBytes(32), remotePublicKey: Buffer.from(nodeId, 'hex'), host: '127.0.0.1', port: lightningPort, localFeatures: implementedFeatures() });
  let peerError;
  peer.on('error', error => { peerError = error; });
  try {
    await peer.connect();
    const features = peer.getRemoteInit().features;
    for (const bit of [440, 441, 442, 443, 444, 445, 560, 561, 562, 563]) assert.equal(features.hasBit(bit), expected.includes(bit), `${phase} feature ${bit}`);
    await delay(250); assert.equal(peer.getState(), 'ready'); assert.equal(peerError, undefined);
    observations.push({ phase, features: features.listSetBits() });
  } finally { peer.disconnect(); }
}
try {
  const image = `ldk-node-umbrel:${version}-${architecture}`;
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(imageInfo.Architecture, architecture); assert.equal(imageInfo.Config.Labels['org.opencontainers.image.version'], version);
  docker(['network', 'create', '--internal', network]); docker(['network', 'create', frontend]); docker(['volume', 'create', volume]);
  docker(['run', '-d', '--name', core, '--network', network, 'bitcoin/bitcoin:28.1', '-regtest', '-server', '-listen=0', '-discover=0', '-rpcbind=0.0.0.0', '-rpcallowip=0.0.0.0/0', '-rpcport=18443', '-rpcuser=qualification', `-rpcpassword=${rpcPassword}`, '-fallbackfee=0.00001']);
  await wait(() => docker(['exec', core, 'bitcoin-cli', '-regtest', '-rpcuser=qualification', `-rpcpassword=${rpcPassword}`, 'getblockchaininfo']), 'isolated regtest Core');
  await launch(`ldk-node-umbrel:0.1.10-${architecture}`);
  const wallet = await api('/wallets', { name: 'Feature migration', network: 'regtest', chain_source: { type: 'bitcoind', host: core, port: 18443, user: 'qualification', password: rpcPassword }, chicory: { enabled: true, offline_enabled: true }, autostart: true });
  await running(wallet.id);
  const previous = await api(`/wallets/${wallet.id}/info`);
  await inspectFeatures(previous.node_id, [561, 563], '0.1.10 enabled');
  checks.push('previous release advertises the legacy optional FFOR bits');
  docker(['stop', '--time', '75', manager]); docker(['rm', manager]);
  await launch(image); await running(wallet.id);
  const current = await api(`/wallets/${wallet.id}/info`);
  assert.equal(current.node_id, previous.node_id); assert.equal((await api('/config')).version, version);
  checks.push('in-place image upgrade preserves the native wallet identity and autostart');
  await inspectFeatures(current.node_id, [441, 443], 'updated enabled');
  checks.push('encrypted Lightning init advertises only new FFOR pairs and no unimplemented async service');
  const balance = await api(`/wallets/${wallet.id}/balance`); assert.equal(balance.onchain_total_sats, 0);
  const address = await api(`/wallets/${wallet.id}/rpc`, { method: 'address', params: {} }); assert.ok(address.address.startsWith('bcrt1'));
  const invoice = await api(`/wallets/${wallet.id}/rpc`, { method: 'invoice', params: { amount_msat: 1000000, description: 'Feature qualification', expiry_secs: 60 } }); assert.ok(invoice.invoice.startsWith('lnbcrt'));
  checks.push('updated native wallet returns an unfunded balance, regtest address and unpaid invoice');
  docker(['exec', manager, 'node', '-e', "require('/opt/ldk/iroh/node_modules/@number0/iroh/index.js')"]);
  checks.push('qualified Iroh native addon loads');
  await api(`/wallets/${wallet.id}/stop`, {});
  const saved = (await api('/wallets')).find(w => w.id === wallet.id);
  await api(`/wallets/${wallet.id}`, { ...saved, chicory: { ...saved.chicory, offline_enabled: false } }, 'PUT');
  await api(`/wallets/${wallet.id}/start`, {}); await running(wallet.id);
  await inspectFeatures(current.node_id, [], 'updated disabled');
  checks.push('disabling offline settlement removes both feature advertisements after restart');
  const files = ['src/lightning/features/flags.ts', 'src/lightning/transport/peer.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async p => [p, createHash('sha256').update(await fs.readFile(path.join(beignet, p))).digest('hex')])));
  const record = { version, architecture, image_id: imageInfo.Id, recorded_at: new Date().toISOString(), checks, observations, beignet_source_sha256: sourceHashes, network: 'isolated regtest at genesis', funds_sent: false, physical_umbrel: false };
  await fs.writeFile(path.join(root, 'docs/qualification', `release-${version}-features-${architecture}.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record));
} finally {
  for (const name of [manager, core]) { try { docker(['rm', '-f', name]); } catch {} }
  try { docker(['volume', 'rm', volume]); } catch {}
  for (const name of [frontend, network]) { try { docker(['network', 'rm', name]); } catch {} }
}
