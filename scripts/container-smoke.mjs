#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const architecture = process.argv[2];
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Usage: node scripts/container-smoke.mjs amd64|arm64');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = `ldk-node-umbrel:0.1.9-${architecture}`;
const suffix = `${architecture}-${process.pid}`; const name = `ldk-dashboard-qa-${suffix}`; const volume = `${name}-data`;
const port = architecture === 'amd64' ? 21095 : 21096; const origin = `http://127.0.0.1:${port}`;
const umbrelMode = process.env.LDK_TEST_UMBREL === '1';
const browserOrigin = umbrelMode ? 'http://my-umbrel.local:2114' : origin;
const browserHost = new URL(browserOrigin).host;
const bootstrapPassword = `umbrel-qualification-${architecture}-${process.pid}-only`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const checks = []; let headers;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Node fetch ignores an overridden Host header. Use HTTP directly to exercise
// the exact browser authority that Umbrel's gateway forwards to the manager.
function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method || 'GET', headers: options.headers, signal: options.signal || AbortSignal.timeout(90_000) }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: { get(name) { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; } },
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject); request.end(options.body);
  });
}
async function request(route, body, method) {
  const response = await httpFetch(origin + route, { method: method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  const value = await response.json(); if (!response.ok) throw new Error(`${route}: ${value.error?.code || response.status}: ${value.error?.message || 'failed'}`); return value;
}
async function ready() { for (let i = 0; i < 100; i++) { try { if ((await httpFetch(origin + '/healthz')).ok) return; } catch {} await delay(300); } throw new Error('Container HTTP startup timed out'); }
async function login() {
  const password = umbrelMode ? bootstrapPassword : docker('exec', name, 'cat', '/data/dashboard-password');
  const response = await httpFetch(origin + '/api/login', { method: 'POST', headers: { origin: browserOrigin, host: browserHost, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!response.ok) throw new Error(`Container authentication failed: ${response.status} ${JSON.stringify(await response.json())}`); const session = await response.json();
  headers = { origin: browserOrigin, host: browserHost, cookie: response.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json', 'x-csrf-token': session.csrf, 'x-session-proof': session.proof };
}
async function running(id) { for (let i = 0; i < 120; i++) { const wallet = (await request('/api/wallets')).find(w => w.id === id); if (wallet.status === 'running') return wallet; if (wallet.status === 'failed') { const logs = await request(`/api/wallets/${id}/logs`); throw new Error(wallet.last_error + ': ' + logs.text.slice(-1600)); } await delay(500); } throw new Error('Native wallet startup timed out'); }
try {
  docker('load', '--input', path.join(root, 'dist', `ldk-node-umbrel-0.1.9-${architecture}.tar`));
  const inspect = JSON.parse(docker('image', 'inspect', image))[0]; if (inspect.Architecture !== architecture) throw new Error('Image architecture mismatch'); checks.push('image architecture verified');
  const chainHost = process.env.REGTEST_HOST || 'mint.local'; const chainPort = Number(process.env.REGTEST_PORT || 60401);
  const chainIp = (await dns.lookup(chainHost, { family: 4 })).address;
  docker('volume', 'create', volume);
  const authEnvironment = umbrelMode ? ['-e', 'AUTH_MODE=password', '-e', 'ALLOWED_HOSTS=*', '-e', `DASHBOARD_BOOTSTRAP_PASSWORD=${bootstrapPassword}`] : ['-e', `PUBLIC_ORIGIN=${origin}`, '-e', 'ALLOWED_HOSTS=127.0.0.1'];
  docker('run', '-d', '--name', name, '--platform', `linux/${architecture}`, '--init', '--security-opt', 'no-new-privileges:true', '-p', `127.0.0.1:${port}:3000`, '-v', `${volume}:/data`, ...authEnvironment, image);
  await ready(); if ((await httpFetch(origin + '/api/wallets')).status !== 401) throw new Error('Unauthenticated wallet access'); checks.push('unauthenticated access denied');
  await login();
  const cookieOnlyHeaders = { ...headers }; delete cookieOnlyHeaders['x-session-proof'];
  const cookieOnlySession = await (await httpFetch(origin + '/api/session', { headers: cookieOnlyHeaders })).json();
  if (cookieOnlySession.authenticated || cookieOnlySession.csrf || cookieOnlySession.proof) throw new Error('Cookie-only session leaked authorization');
  if ((await httpFetch(origin + '/api/wallets', { headers: cookieOnlyHeaders })).status !== 401) throw new Error('Cookie-only wallet access permitted');
  checks.push('shared-host cookie replay cannot authorize dashboard access');
  if (umbrelMode) {
    docker('exec', name, 'test', '!', '-e', '/data/dashboard-password');
    const authFile = JSON.parse(docker('exec', name, 'cat', '/data/auth.json'));
    if (!authFile.hash || JSON.stringify(authFile).includes(bootstrapPassword)) throw new Error('Unsafe bootstrap password storage');
    if ((await httpFetch(origin + '/api/wallets', { headers: { ...headers, host: 'another-umbrel.local:2114' } })).status !== 401) throw new Error('Session accepted on another hostname');
    checks.push('Umbrel app password, custom hostname and session binding');
  }
  const defaults = await request('/api/config'); if (defaults.default_network !== 'bitcoin') throw new Error('Mainnet default missing'); checks.push('mainnet first-run default');
  const wallet = await request('/api/wallets', { name: `${architecture} qualification`, network: 'regtest', chain_source: { type: 'electrum', url: `tcp://${chainIp}:${chainPort}` }, autostart: true }); await running(wallet.id);
  const rpc = (method, params = {}) => request(`/api/wallets/${wallet.id}/rpc`, { method, params });
  await rpc('sync'); const first = await request(`/api/wallets/${wallet.id}/info`); if (first.network !== 'regtest' || !first.best_block_height) throw new Error('Native chain sync failed'); checks.push('native regtest sync');
  const balance = await request(`/api/wallets/${wallet.id}/balance`); if (balance.onchain_total_sats !== 0) throw new Error('Disposable wallet unexpectedly funded');
  const address = await rpc('address'); if (!address.address.startsWith('bcrt1')) throw new Error('Wrong receive network'); const invoice = await rpc('invoice', { amount_msat: 1000000, description: 'Image qualification only', expiry_secs: 60 }); if (!invoice.invoice.startsWith('lnbcrt')) throw new Error('Wrong invoice network'); checks.push('native address and unpaid invoice');
  const pairing = await request(`/api/wallets/${wallet.id}/pairing`); if (!pairing.tcp_uri.startsWith(first.node_id + '@')) throw new Error('Pairing identity mismatch'); const qr = await request(`/api/wallets/${wallet.id}/qr`, { text: pairing.tcp_uri }); if (!qr.image.startsWith('data:image/png;base64,')) throw new Error('QR failed'); checks.push('authenticated pairing and QR');
  docker('exec', name, 'node', '-e', "require('/opt/ldk/iroh/node_modules/@number0/iroh/index.js'); console.log('addon loaded')"); checks.push('native Iroh addon loads');
  await request(`/api/wallets/${wallet.id}/stop`, {}); await request(`/api/wallets/${wallet.id}/start`, {}); if ((await request(`/api/wallets/${wallet.id}/info`)).node_id !== first.node_id) throw new Error('Native identity changed'); checks.push('native stop/start retains identity');
  docker('restart', '--time', '75', name); await ready(); await login(); await running(wallet.id); if ((await request(`/api/wallets/${wallet.id}/info`)).node_id !== first.node_id) throw new Error('Container restart changed identity'); checks.push('container restart autostarts same native identity');
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  if (!(logs.stdout + logs.stderr).includes('Dashboard shutdown completed')) throw new Error('Container did not shut down its manager gracefully'); checks.push('Docker termination reaches graceful native shutdown');
  if (process.env.LDK_TEST_IROH === '1') {
    await request(`/api/wallets/${wallet.id}/stop`, {});
    const current = (await request('/api/wallets')).find(value => value.id === wallet.id);
    await request(`/api/wallets/${wallet.id}`, { ...current, iroh: { enabled: true, discovery: true, default_relays: true } }, 'PUT');
    await request(`/api/wallets/${wallet.id}/start`, {});
    const firstIroh = await request(`/api/wallets/${wallet.id}/pairing`);
    if (firstIroh.iroh_status !== 'ready' || !firstIroh.iroh_uri?.startsWith(first.node_id + '@iroh:')) throw new Error('Native Iroh bridge did not start');
    checks.push('dashboard starts real Iroh relay and discovery bridge');
    await request(`/api/wallets/${wallet.id}/stop`, {}); await request(`/api/wallets/${wallet.id}/start`, {});
    const nextIroh = await request(`/api/wallets/${wallet.id}/pairing`);
    if (nextIroh.iroh_uri?.split('?')[0] !== firstIroh.iroh_uri.split('?')[0]) throw new Error('Iroh transport identity changed');
    checks.push('native and Iroh identities survive supervised restart');
  }
  const evidence = { architecture, authentication: umbrelMode ? 'Umbrel app password' : 'local generated password', image_id: inspect.Id, checks, network: 'regtest', funds_sent: false, physical_umbrel: false, date: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'dist', `qualification-${umbrelMode ? 'umbrel-' : ''}${process.env.LDK_TEST_IROH === '1' ? 'iroh-' : ''}${architecture}.json`), JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence));
} finally {
  try { docker('rm', '-f', name); } catch {}
  try { docker('volume', 'rm', volume); } catch {}
}
