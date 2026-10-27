#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The existing local regtest server is queried read-only. Every wallet and
// Docker volume created here is disposable; no mining or funding is performed.
const architecture = process.argv[2];
if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Usage: node scripts/electrum-container-test.mjs amd64|arm64');
const port = Number(process.env.REGTEST_PORT || 60001);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('REGTEST_PORT must be a TCP port');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '0.1.12';
const image = `ldk-node-umbrel:${version}-${architecture}`;
const name = `ldk-electrum-qa-${architecture}-${randomBytes(6).toString('hex')}`;
const volume = `${name}-data`;
const url = `tcp://mint.local:${port}`;
const checks = [];
let containerCreated = false; let volumeCreated = false;

function docker(args, input) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8', input, timeout: 360_000, maxBuffer: 1024 * 1024,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    // Never include complete argv, authentication data or input in diagnostics.
    throw new Error(`Docker ${args[0]} failed with status ${error.status ?? 'unknown'}: ${String(error.stderr || '').slice(-2000)}`);
  }
}

function launch() {
  // Docker can create a container before reporting a failed start.
  containerCreated = true;
  docker(['run', '-d', '--name', name, '--platform', `linux/${architecture}`, '--init',
    '--security-opt', 'no-new-privileges:true', '--add-host', 'mint.local:host-gateway',
    '--mount', `type=volume,source=${volume},target=/data`,
    '-e', 'AUTH_MODE=password', '-e', 'PUBLIC_ORIGIN=http://127.0.0.1:3000',
    '-e', 'ALLOWED_HOSTS=127.0.0.1', image]);
}

// Run through the real API without exposing the dashboard or its credentials
// outside this disposable container. Each invocation obtains a fresh session.
function exercise(phase, wallets = []) {
  const input = { phase, wallets, url, shorthand: `mint.local:${port}:t`, version };
  const code = `
    import assert from 'node:assert/strict';
    import dns from 'node:dns/promises';
    import fs from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const input = JSON.parse(process.argv[1]);
    const origin = 'http://127.0.0.1:3000';
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        if ((await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; }
      } catch {}
      await delay(250);
    }
    assert.equal(ready, true, 'disposable dashboard starts');
    assert.equal((await fetch(origin + '/api/wallets')).status, 401);
    let password = (await fs.readFile('/data/dashboard-password', 'utf8')).trim();
    const login = await fetch(origin + '/api/login', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(5000),
    });
    password = undefined;
    assert.equal(login.status, 200, 'disposable dashboard authentication');
    const session = await login.json();
    const headers = { origin, 'content-type': 'application/json', cookie: login.headers.get('set-cookie').split(';')[0],
      'x-session-proof': session.proof, 'x-csrf-token': session.csrf };
    async function request(route, body, expected = 200, method) {
      const response = await fetch(origin + '/api' + route, {
        method: method || (body === undefined ? 'GET' : 'POST'), headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150_000),
      });
      const value = await response.json();
      assert.equal(response.status, expected, route + ': ' + (value.error?.code || response.status));
      return value;
    }
    assert.equal((await request('/config')).version, input.version);
    const hosts = await fs.readFile('/etc/hosts', 'utf8');
    const mapped = hosts.split('\\n').map(line => line.trim().split(/\\s+/)).filter(fields => fields.slice(1).includes('mint.local')).map(fields => fields[0]);
    assert.ok(mapped.length > 0, 'Docker supplies the same-server hostname mapping');
    const resolved = await dns.lookup('mint.local', { all: true });
    assert.ok(resolved.length > 0);
    assert.ok(resolved.every(record => mapped.includes(record.address)), 'system lookup uses the host-gateway mapping');
    for (const endpoint of [input.url, input.shorthand]) {
      const result = await request('/electrum/check', { url: endpoint, network: 'regtest' });
      assert.equal(result.url, input.url); assert.equal(result.network, 'regtest');
      assert.ok(Number.isSafeInteger(result.height) && result.height >= 0);
    }
    // Confirm the endpoint is regtest before creating any native wallet state.
    const fixtures = [];
    if (input.phase === 'initial') {
      assert.deepEqual(await request('/wallets'), []);
      for (const endpoint of [input.url, input.shorthand]) {
        const wallet = await request('/wallets', { name: endpoint === input.url ? 'Hostname URL' : 'Hostname shorthand', network: 'regtest',
          chain_source: { type: 'electrum', url: endpoint }, autostart: false }, 201);
        assert.equal(wallet.status, 'stopped'); assert.equal(wallet.chain_source.url, input.url);
        fixtures.push({ id: wallet.id });
      }
    } else {
      const existing = await request('/wallets');
      assert.equal(existing.length, input.wallets.length);
      for (const saved of input.wallets) {
        const wallet = existing.find(value => value.id === saved.id);
        assert.equal(wallet.status, 'stopped'); assert.equal(wallet.chain_source.url, input.url);
        fixtures.push(saved);
      }
    }
    async function verifyFiles(id) {
      const registry = JSON.parse(await fs.readFile('/data/wallets.json', 'utf8'));
      assert.equal(registry.find(wallet => wallet.id === id).chain_source.url, input.url);
      const config = JSON.parse(await fs.readFile('/data/wallets/' + id + '/node.json', 'utf8'));
      assert.deepEqual(config.chain_source, { type: 'electrum', url: input.url });
      assert.equal(config.network, 'regtest');
    }
    const results = [];
    for (const fixture of fixtures) {
      assert.equal((await request('/wallets/' + fixture.id + '/start', {})).status, 'running');
      await request('/wallets/' + fixture.id + '/rpc', { method: 'sync', params: {} });
      const info = await request('/wallets/' + fixture.id + '/info');
      assert.equal(info.network, 'regtest'); assert.match(info.node_id, /^(02|03)[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(info.best_block_height) && info.best_block_height >= 0);
      if (fixture.node_id) assert.equal(info.node_id, fixture.node_id, 'cold restart preserves native identity');
      const balance = await request('/wallets/' + fixture.id + '/balance');
      assert.equal(balance.onchain_total_sats, 0, 'fixture remains unfunded');
      await verifyFiles(fixture.id);
      await request('/wallets/' + fixture.id + '/stop', {});
      if (input.phase === 'initial') {
        assert.equal((await request('/wallets/' + fixture.id + '/start', {})).status, 'running');
        assert.equal((await request('/wallets/' + fixture.id + '/info')).node_id, info.node_id, 'stop/start preserves native identity');
        await verifyFiles(fixture.id);
        await request('/wallets/' + fixture.id + '/stop', {});
      }
      results.push({ id: fixture.id, node_id: info.node_id, height: info.best_block_height });
    }
    assert.ok((await request('/wallets')).every(wallet => wallet.status === 'stopped'));
    console.log(JSON.stringify({ phase: input.phase, resolved, wallets: results }));
  `;
  return JSON.parse(docker(['exec', '-i', '--user', '1000:1000', name, 'node', '--input-type=module', '-e', code, JSON.stringify(input)]));
}

try {
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(imageInfo.Architecture, architecture);
  assert.equal(imageInfo.Config.Labels['org.opencontainers.image.version'], version);
  checks.push('release image architecture and version verified');
  docker(['volume', 'create', volume]); volumeCreated = true;
  launch();
  const initial = exercise('initial');
  checks.push('container system resolver uses same-server host-gateway mapping');
  checks.push('authenticated connection checks accept hostname URL and TCP shorthand and verify regtest');
  checks.push('new stopped wallets store the canonical hostname URL for both input formats');
  checks.push('native daemon starts and syncs unfunded regtest wallets through hostname');
  checks.push('wallet registry and native configuration preserve hostname');
  checks.push('native stop/start preserves both identities');
  docker(['stop', '--time', '75', name]);
  docker(['rm', name]); containerCreated = false;
  launch();
  const restarted = exercise('recreated', initial.wallets);
  checks.push('container recreation restores hostname resolution and authenticated checks');
  checks.push('cold native restart retains both identities and syncs through hostname');
  const evidence = { architecture, image, image_id: imageInfo.Id, version, checks, network: 'regtest',
    endpoint: url, funds_sent: false, blocks_mined: false, physical_umbrel: false,
    native_wallets_created: initial.wallets.length, initial_heights: initial.wallets.map(wallet => wallet.height),
    restarted_heights: restarted.wallets.map(wallet => wallet.height), date: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'docs/qualification', `release-${version}-electrum-${architecture}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  // Cleanup is limited to names created with this invocation's random suffix.
  if (containerCreated) { try { docker(['rm', '-f', name]); } catch {} }
  if (volumeCreated) { try { docker(['volume', 'rm', volume]); } catch {} }
}
