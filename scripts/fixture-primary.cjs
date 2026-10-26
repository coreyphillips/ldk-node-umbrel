#!/usr/bin/env node
'use strict';
// Test adapter only. It translates the existing disposable Chicory fixture
// protocol into authenticated dashboard calls backed by the real container.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const [directory, portText, sourceText] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory) || !/^\d+$/.test(portText || '')) throw new Error('Fixture directory and TCP port required');
const architecture = process.env.LDK_CONTAINER_ARCH || (process.arch === 'arm64' ? 'arm64' : 'amd64');
if (!['arm64', 'amd64'].includes(architecture)) throw new Error('Unsupported architecture');
const source = new URL(sourceText); if (!['rpc:', 'tcp:', 'ssl:'].includes(source.protocol)) throw new Error('Fixture requires an explicit regtest chain source');
const host = ['127.0.0.1', 'localhost'].includes(source.hostname) ? 'host.docker.internal' : source.hostname;
const chain_source = source.protocol === 'rpc:' ? { type: 'bitcoind', host, port: Number(source.port), user: decodeURIComponent(source.username), password: decodeURIComponent(source.password) } : { type: 'electrum', url: `${source.protocol}//${host}:${source.port}` };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let saved, origin, headers, stopping = false;
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function request(route, body, method) {
  const response = await fetch(origin + route, { method: method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || 'Dashboard request failed'); return value;
}
const walletRoute = operation => `/api/wallets/${saved.wallet_id}/${operation}`;
const rpc = (method, params = {}) => request(walletRoute('rpc'), { method, params });
async function stop() { if (stopping) return; stopping = true; try { if (headers && saved?.wallet_id) await request(walletRoute('stop'), {}); } finally { if (saved) { try { docker('stop', '--time', '75', saved.container); } catch {} } } }
async function handle(input) {
  switch (input.method) {
    case 'sync': await rpc('sync'); return true;
    case 'balance': { const b = await rpc('balance'); return { onchainSats: b.onchain_total_sats, spendableOnchainSats: b.onchain_spendable_sats, lightningSats: b.lightning_total_sats }; }
    case 'channels': return (await rpc('channels')).map(c => ({ channelId: c.channel_id, counterpartyNodeId: c.counterparty_node_id, isChannelReady: c.is_channel_ready, isUsable: c.is_usable, inboundCapacityMsat: c.inbound_capacity_msat, outboundCapacityMsat: c.outbound_capacity_msat, valueSats: c.value_sats, fundingTxid: c.funding_txo?.split(':')[0] || null, fundingOutputIndex: c.funding_txo ? Number(c.funding_txo.split(':')[1]) : null }));
    case 'invoice': return { bolt11: (await rpc('invoice', { amount_msat: input.amountSats * 1000, description: input.description || 'Regtest qualification', expiry_secs: 3600 })).invoice };
    case 'pay': return { paymentId: (await rpc('pay', { invoice: input.bolt11, confirm: true })).id };
    case 'open': return { userChannelId: (await rpc('open', { node_id: input.nodeId, address: input.address, amount_sats: input.amountSats, confirm: true })).user_channel_id };
    case 'splice_in': case 'force_close': { const channel = (await rpc('channels')).find(c => c.channel_id === input.channelId); if (!channel) throw new Error('Unknown native channel'); await rpc(input.method === 'force_close' ? 'close' : 'splice_in', { channel_id: channel.channel_id, counterparty_node_id: channel.counterparty_node_id, ...(input.method === 'force_close' ? { force: true } : { amount_sats: input.amountSats }), confirm: true }); return true; }
    case 'events': return (await rpc('events')).map(event => JSON.stringify(event));
    case 'stop': await stop(); return true;
    default: throw new Error('Unsupported fixture operation');
  }
}
(async () => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'dashboard-container.json');
  if (fs.existsSync(file)) { saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.port !== Number(portText) || saved.architecture !== architecture) throw new Error('Fixture container identity changed'); docker('start', saved.container); }
  else {
    const suffix = crypto.createHash('sha256').update(directory).digest('hex').slice(0, 14); const name = `ldk-umbrel-funded-${suffix}`;
    saved = { container: name, volume: name + '-data', port: Number(portText), http_port: await freePort(), architecture };
    docker('volume', 'create', saved.volume);
    docker('run', '-d', '--name', name, '--platform', `linux/${architecture}`, '--init', '--security-opt', 'no-new-privileges:true', '--add-host', 'host.docker.internal:host-gateway', '-p', `127.0.0.1:${saved.http_port}:3000`, '-p', `127.0.0.1:${saved.port}:9735`, '-v', `${saved.volume}:/data`, '-e', `PUBLIC_ORIGIN=http://127.0.0.1:${saved.http_port}`, '-e', 'ALLOWED_HOSTS=127.0.0.1', `ldk-node-umbrel:0.1.8-${architecture}`);
    fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    if (process.env.LDK_CONTAINER_RESOURCE_LOG) fs.appendFileSync(process.env.LDK_CONTAINER_RESOURCE_LOG, JSON.stringify(saved) + '\n', { mode: 0o600 });
  }
  origin = `http://127.0.0.1:${saved.http_port}`;
  let healthy = false; for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/healthz')).ok) { healthy = true; break; } } catch {} await delay(300); } if (!healthy) throw new Error('Container startup failed');
  const password = docker('exec', saved.container, 'cat', '/data/dashboard-password');
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) }); if (!login.ok) throw new Error('Container sign-in failed');
  const session = await login.json(); headers = { origin, cookie: login.headers.get('set-cookie').split(';')[0], 'x-csrf-token': session.csrf, 'x-session-proof': session.proof, 'content-type': 'application/json' };
  if (!saved.wallet_id) {
    const wallet = await request('/api/wallets', { name: 'Funded regtest qualification', network: 'regtest', chain_source, autostart: false, chicory: { enabled: true, offline_enabled: true, flat_fee_sat: 100, fee_ppm: 1000, max_client_funding_sats: 500000, max_total_fronted_sats: 2000000 } }); saved.wallet_id = wallet.id; fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  }
  await request(walletRoute('start'), {}); const info = await rpc('info'); if (info.network !== 'regtest') throw new Error('Refusing funded qualification outside regtest');
  const address = await rpc('address'); emit({ ready: true, nodeId: info.node_id, uri: `${info.node_id}@127.0.0.1:${saved.port}`, address: address.address });
  const lines = readline.createInterface({ input: process.stdin }); let serial = Promise.resolve();
  lines.on('line', line => { serial = serial.then(async () => { let input; try { input = JSON.parse(line); const result = await handle(input); emit({ id: input.id, result }); if (input.method === 'stop') process.exit(0); } catch (error) { emit({ id: input?.id, error: error.message }); } }); });
  process.once('SIGTERM', () => stop().finally(() => process.exit(0))); process.once('SIGINT', () => stop().finally(() => process.exit(0)));
})().catch(async error => { process.stderr.write(error.message + '\n'); await stop(); process.exit(1); });
