import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Authentication } from './auth.mjs';
import { createServer } from './index.mjs';

const WALLET_ID = '11111111-1111-4111-8111-111111111111';
// Public test vector only. No real wallet data is used by these HTTP tests.
const MNEMONIC = `${'abandon '.repeat(23)}art`;
const ARCHIVE = Buffer.from([0x4c, 0x44, 0x4b, 0, 255, 128, 10, 13]);
const PASSWORD = 'synthetic-dashboard-password';
const PASSPHRASE = 'synthetic-backup-passphrase';
const RECOVERY_ROUTE = `/api/wallets/${WALLET_ID}/recovery`;
const BACKUP_ROUTE = '/api/backup/export';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-recovery-http-'));
  let now = 1000;
  const auth = new Authentication({ dataDir, now: () => now });
  await auth.initialize(undefined, PASSWORD);
  const calls = { recovery: [], backup: [] };
  const wallets = {
    list: () => [{ id: WALLET_ID, name: 'Test wallet', recovery_kind: 'mnemonic' }],
    recovery: async id => { calls.recovery.push(id); return { kind: 'mnemonic', mnemonic: MNEMONIC, word_count: 24 }; },
    backup: async passphrase => { calls.backup.push(passphrase); return ARCHIVE; },
  };
  const server = createServer({ auth, wallets, allowedHosts: new Set(['127.0.0.1']) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    auth.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = {
    cookie: login.headers.get('set-cookie').split(';')[0], origin,
    'content-type': 'application/json', 'x-session-proof': session.proof, 'x-csrf-token': session.csrf,
  };
  const call = (route, options = {}) => fetch(`${origin}${route}`, {
    method: 'POST', headers, body: JSON.stringify({ confirm: true, passphrase: PASSPHRASE }), ...options,
  });
  return { calls, call, headers, origin, expire: () => { now += 8 * 3600_000 + 1; } };
}

function without(headers, name) {
  const result = { ...headers }; delete result[name]; return result;
}

async function rejected(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  assert.equal(text.includes(MNEMONIC), false);
  assert.equal(text.includes(PASSPHRASE), false);
  assert.ok(JSON.parse(text).error);
}

test('recovery and backup refuse unauthenticated requests and shared-host cookie replay', async t => {
  const { calls, call, headers } = await fixture(t);
  for (const route of [RECOVERY_ROUTE, BACKUP_ROUTE]) {
    await rejected(await call(route, { headers: { 'content-type': 'application/json' } }), 401);
    await rejected(await call(route, { headers: without(headers, 'x-session-proof') }), 401);
    await rejected(await call(route, { headers: without(headers, 'cookie') }), 401);
    await rejected(await call(route, { headers: { ...headers, 'x-session-proof': 'A'.repeat(43) } }), 401);
    await rejected(await call(route, { headers: { ...without(headers, 'x-session-proof'), 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': '127.0.0.1' } }), 401);
  }
  assert.deepEqual(calls, { recovery: [], backup: [] });
});

test('recovery and backup require same-origin JSON, CSRF and explicit confirmation', async t => {
  const { calls, call, headers } = await fixture(t);
  for (const route of [RECOVERY_ROUTE, BACKUP_ROUTE]) {
    await rejected(await call(route, { headers: without(headers, 'x-csrf-token') }), 403);
    await rejected(await call(route, { headers: { ...headers, 'x-csrf-token': 'wrong-token' } }), 403);
    await rejected(await call(route, { headers: without(headers, 'origin') }), 403);
    await rejected(await call(route, { headers: { ...headers, origin: 'https://attacker.invalid' } }), 403);
    await rejected(await call(route, { headers: { ...headers, 'content-type': 'text/plain' } }), 415);
    await rejected(await call(route, { method: 'GET', body: undefined }), 404);
    for (const input of [{}, { confirm: false }, { confirm: 'true' }, null, [], 'not an object']) {
      await rejected(await call(route, { body: JSON.stringify(input) }), 400);
    }
    await rejected(await call(route, { body: '{' }), 400);
    await rejected(await call(route, { body: JSON.stringify({ confirm: true, padding: 'x'.repeat(65_536) }) }), 413);
  }
  assert.deepEqual(calls, { recovery: [], backup: [] });
});

test('explicit recovery is uncached and normal wallet reads do not reveal the phrase', async t => {
  const { calls, call } = await fixture(t);
  const list = await call('/api/wallets', { method: 'GET', body: undefined });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), [{ id: WALLET_ID, name: 'Test wallet', recovery_kind: 'mnemonic' }]);
  assert.deepEqual(calls, { recovery: [], backup: [] });
  const response = await call(RECOVERY_ROUTE, { body: JSON.stringify({ confirm: true }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { kind: 'mnemonic', mnemonic: MNEMONIC, word_count: 24 });
  assert.deepEqual(calls.recovery, [WALLET_ID]);
  assert.deepEqual(calls.backup, []);
});

test('backup is an uncached binary attachment with no passphrase in response metadata', async t => {
  const { calls, call } = await fixture(t);
  const response = await call(BACKUP_ROUTE);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="[A-Za-z0-9._-]+"$/);
  assert.equal([...response.headers.values()].some(value => value.includes(PASSPHRASE)), false);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), ARCHIVE);
  assert.deepEqual(calls.backup, [PASSPHRASE]);
  assert.deepEqual(calls.recovery, []);
});

test('expired and logged-out sessions cannot reveal recovery material or export backups', async t => {
  const expired = await fixture(t);
  expired.expire();
  for (const route of [RECOVERY_ROUTE, BACKUP_ROUTE]) await rejected(await expired.call(route), 401);
  assert.deepEqual(expired.calls, { recovery: [], backup: [] });

  const loggedOut = await fixture(t);
  const response = await loggedOut.call('/api/logout', { body: '{}' });
  assert.equal(response.status, 200);
  for (const route of [RECOVERY_ROUTE, BACKUP_ROUTE]) await rejected(await loggedOut.call(route), 401);
  assert.deepEqual(loggedOut.calls, { recovery: [], backup: [] });
});
