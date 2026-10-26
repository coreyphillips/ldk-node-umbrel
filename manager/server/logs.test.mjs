import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { Authentication } from './auth.mjs';
import { createServer } from './index.mjs';
import { NATIVE_LOG_LIMIT, PROCESS_LOG_LIMIT, redactDiagnostics } from './logs.mjs';
import { NativeProcess } from './rpc.mjs';
import { WalletManager } from './wallets.mjs';

const config = {
  name: 'Native logs fixture', network: 'regtest', autostart: false,
  chain_source: { type: 'bitcoind', host: 'localhost', port: 18443, user: 'fixture-rpc-user', password: 'fixture-rpc-private-value' },
};
const unknownId = '11111111-1111-4111-8111-111111111111';
const unsafe = { status: 409, code: 'WALLET_LOG_PATH_UNSAFE' };
const publicNodeId = '02' + '12'.repeat(32);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-native-logs-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new WalletManager({ dataDir, binary: '/unused' });
  await manager.initialize();
  const wallet = await manager.create(config);
  const directory = manager.directory(wallet.id);
  const log = path.join(directory, 'node', 'ldk_node.log');
  return { root, dataDir, manager, wallet, directory, log };
}

const writeLog = (file, text) => fs.writeFile(file, text, { mode: 0o600 });

async function httpFixture(t) {
  const value = await fixture(t);
  let now = 1000;
  const auth = new Authentication({ dataDir: value.dataDir, now: () => now });
  const password = 'synthetic-log-dashboard-password';
  await auth.initialize(undefined, password);
  const server = createServer({ auth, wallets: value.manager, allowedHosts: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { auth.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  const headers = {
    cookie: response.headers.get('set-cookie').split(';')[0], origin,
    'x-session-proof': session.proof, 'x-csrf-token': session.csrf, 'content-type': 'application/json',
  };
  const route = `/api/wallets/${value.wallet.id}/logs`;
  const call = (suffix = '', options = {}) => fetch(`${origin}${route}${suffix}`, { headers, ...options });
  return { ...value, auth, server, origin, headers, route, call, expire: () => { now += 8 * 3600_000 + 1; } };
}

function without(headers, name) {
  const copy = { ...headers }; delete copy[name]; return copy;
}

test('native and process logs remain distinct and only include the selected wallet', async t => {
  const { manager, wallet, log } = await fixture(t);
  const sibling = await manager.create({ ...config, name: 'Sibling logs' });
  await writeLog(log, 'selected native event\n');
  await writeLog(path.join(manager.directory(sibling.id), 'node', 'ldk_node.log'), 'sibling native event\n');
  manager.runtime.set(wallet.id, { status: 'running', logs: ['old selected stderr\n'], process: { logs: ['selected process event\n'] } });
  manager.runtime.set(sibling.id, { status: 'running', process: { logs: ['sibling process event\n'] } });

  const result = await manager.logs(wallet.id);

  assert.deepEqual(result.native, { text: 'selected native event\n', available: true, truncated: false });
  assert.deepEqual(result.process, { text: 'selected process event\n', truncated: false });
  assert.match(result.text, /selected native event/);
  assert.match(result.text, /selected process event/);
  assert.equal(JSON.stringify(result).includes('sibling'), false);
  assert.equal(JSON.stringify(result).includes('old selected stderr'), false);
});

test('stopped wallets retain file logs and distinguish missing from empty native logs', async t => {
  const { manager, wallet, log } = await fixture(t);
  const missing = await manager.logs(wallet.id);
  assert.deepEqual(missing.native, { text: '', available: false, truncated: false });
  assert.deepEqual(missing.process, { text: '', truncated: false });

  await writeLog(log, '');
  assert.deepEqual((await manager.logs(wallet.id)).native, { text: '', available: true, truncated: false });
  await writeLog(log, 'previous native startup\n');
  manager.runtime.set(wallet.id, { status: 'stopped', logs: ['previous process exit\n'] });
  const stopped = await manager.logs(wallet.id);
  assert.match(stopped.text, /previous native startup/);
  assert.match(stopped.text, /previous process exit/);

  const restarted = new WalletManager({ dataDir: manager.dataDir, binary: '/unused' });
  await restarted.initialize();
  assert.equal((await restarted.logs(wallet.id)).native.text, 'previous native startup\n');
});

test('unregistered and path-shaped wallet identifiers never read a directory', async t => {
  const { manager, log } = await fixture(t);
  await writeLog(log, 'registered wallet only\n');
  for (const id of [unknownId, '../mnemonic', '../../auth.json', 'node/ldk_node.log']) {
    await assert.rejects(manager.logs(id), { status: 404, code: 'NOT_FOUND' });
  }
});

test('native tails are byte bounded and retain newest complete UTF-8 lines', async t => {
  const { manager, wallet, log } = await fixture(t);
  const line = 'native diagnostic é 🍋 0123456789\n';
  await writeLog(log, 'OLDEST RECORD\n' + line.repeat(Math.ceil(NATIVE_LOG_LIMIT / Buffer.byteLength(line)) + 100) + 'LATEST RECORD\n');

  const result = await manager.logs(wallet.id);

  assert.equal(result.native.available, true);
  assert.equal(result.native.truncated, true);
  assert.ok(Buffer.byteLength(result.native.text) <= NATIVE_LOG_LIMIT);
  assert.ok(result.native.text.endsWith('LATEST RECORD\n'));
  assert.equal(result.native.text.includes('OLDEST RECORD'), false);
  assert.equal(result.native.text.includes('\ufffd'), false);
  assert.ok(result.native.text.split('\n').slice(0, -2).every(value => value + '\n' === line));
});

test('a single oversized native line cannot defeat the tail bound or leak a clipped secret', async t => {
  const { manager, wallet, log } = await fixture(t);
  const secret = 'd5'.repeat(32);
  const finalLine = 'SAFE FINAL RECORD\n';
  // Place the start of the bounded tail inside the secret-bearing first line.
  const oversized = 'before ' + secret + 'x'.repeat(NATIVE_LOG_LIMIT - 32 - finalLine.length) + '\n';
  await writeLog(log, oversized + finalLine);
  const result = await manager.logs(wallet.id);
  assert.equal(result.native.truncated, true);
  assert.equal(result.native.text, finalLine);
  assert.equal(result.text.includes(secret.slice(32)), false);

  await writeLog(log, 'x'.repeat(NATIVE_LOG_LIMIT * 3));
  const withoutNewline = await manager.logs(wallet.id);
  assert.equal(withoutNewline.native.truncated, true);
  assert.equal(withoutNewline.native.text, '');
});

test('incomplete final lines remain hidden until a whole record can be redacted', async t => {
  const { manager, wallet, log } = await fixture(t);
  const secret = '89abcdef01234567'.repeat(4);
  const partial = `payment=${secret.slice(0, 32)}`;
  await writeLog(log, 'complete native event\n' + partial);
  const logs = ['complete process event\n', partial];
  manager.runtime.set(wallet.id, { status: 'stopped', logs });

  const pending = await manager.logs(wallet.id);

  assert.equal(pending.native.text, 'complete native event\n');
  assert.equal(pending.process.text, 'complete process event\n');
  assert.equal(pending.text.includes(secret.slice(0, 32)), false);

  await fs.appendFile(log, secret.slice(32) + '\n');
  logs.push(secret.slice(32) + '\n');
  const complete = await manager.logs(wallet.id);
  assert.match(complete.native.text, /payment=\[redacted\]\n$/);
  assert.match(complete.process.text, /payment=\[redacted\]\n$/);
  assert.equal(complete.text.includes(secret), false);
});

test('process diagnostics are independently bounded and redact secrets across chunks', async t => {
  const { manager, wallet } = await fixture(t);
  const secret = 'b7'.repeat(32);
  const processText = 'old process record\n' + 'process line\n'.repeat(PROCESS_LOG_LIMIT / 4) + `payment=${secret}\nnewest process event\n`;
  const split = processText.indexOf(secret) + 31;
  manager.runtime.set(wallet.id, { status: 'failed', logs: [processText.slice(0, split), processText.slice(split)] });

  const result = await manager.logs(wallet.id);

  assert.equal(result.process.truncated, true);
  assert.ok(Buffer.byteLength(result.process.text) <= PROCESS_LOG_LIMIT);
  assert.equal(result.process.text.includes(secret), false);
  assert.equal(result.process.text.includes('old process record'), false);
  assert.match(result.process.text, /\[redacted\]/);
  assert.ok(result.process.text.endsWith('newest process event\n'));
});

test('native process capture does not expose a secret clipped at its diagnostic chunk limit', async t => {
  const { manager, wallet } = await fixture(t);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { this.emit('exit'); },
  });
  const native = new NativeProcess({ binary: '/unused', config: '/unused', spawnProcess: () => child });
  const ready = native.start();
  child.stdout.write(JSON.stringify({ event: 'ready', node_id: publicNodeId, network: 'regtest' }) + '\n');
  await ready;
  t.after(() => native.finish());
  const secret = '0123456789abcdef'.repeat(4);
  child.stderr.write('x'.repeat(8192 - 32) + secret + '\n');
  child.stderr.write('safe following process event\n');
  manager.runtime.set(wallet.id, { status: 'running', process: native });

  const result = await manager.logs(wallet.id);

  assert.equal(result.process.text.includes(secret.slice(0, 32)), false);
  assert.match(result.process.text, /safe following process event/);
});

test('redaction removes payment secrets, labelled credentials and URL userinfo while retaining public diagnostics', () => {
  const secret = 'aB'.repeat(32);
  const mnemonic = 'abandon '.repeat(23) + 'art';
  const input = [
    `payment=${secret}`,
    'password=fixture-password-value',
    'mnemonic: ' + mnemonic,
    'seed: fixture-seed-value',
    'secret: fixture-secret-value',
    'request https://rpc-user:fixture-url-password@node.example:8332/path failed',
    `peer ${publicNodeId} channel unavailable`,
    '<img src=x onerror="alert(1)">',
    '',
  ].join('\n');

  const output = redactDiagnostics(input);

  for (const value of [secret, mnemonic, 'fixture-password-value', 'fixture-seed-value', 'fixture-secret-value', 'rpc-user', 'fixture-url-password']) {
    assert.equal(output.includes(value), false, value);
  }
  assert.match(output, /\[redacted\]/);
  assert.ok(output.includes(publicNodeId));
  assert.ok(output.includes('channel unavailable'));
  assert.ok(output.includes('<img src=x onerror="alert(1)">'));
});

test('both sources redact the selected chain password without reading seed or configuration files', async t => {
  const { manager, wallet, directory, log } = await fixture(t);
  const secret = config.chain_source.password;
  await writeLog(log, `backend detail ${secret}\nordinary native event\n`);
  manager.runtime.set(wallet.id, { status: 'stopped', logs: [`backend detail ${secret}\nordinary process event\n`] });
  // These unrelated files deliberately contain markers that never belong in logs.
  await fs.writeFile(path.join(directory, 'mnemonic'), 'PRIVATE RECOVERY FILE MARKER', { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'node.json'), '{"password":"PRIVATE CONFIGURATION FILE MARKER"}', { mode: 0o600 });
  const result = await manager.logs(wallet.id);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('PRIVATE RECOVERY FILE MARKER'), false);
  assert.equal(serialized.includes('PRIVATE CONFIGURATION FILE MARKER'), false);
  assert.match(result.native.text, /ordinary native event/);
  assert.match(result.process.text, /ordinary process event/);
});

test('redaction expansion cannot exceed either response text limit', async t => {
  const { manager, wallet, log } = await fixture(t);
  // One-character Core passwords are permitted by the existing configuration.
  manager.get(wallet.id).chain_source.password = 'Q';
  const line = 'QQQQQQQQQQQQQQQQ\n';
  await writeLog(log, line.repeat(Math.floor(NATIVE_LOG_LIMIT / 2 / line.length)));
  manager.runtime.set(wallet.id, { status: 'stopped', logs: [line.repeat(Math.floor(PROCESS_LOG_LIMIT / 2 / line.length))] });

  const result = await manager.logs(wallet.id);

  assert.ok(Buffer.byteLength(result.native.text) <= NATIVE_LOG_LIMIT);
  assert.ok(Buffer.byteLength(result.process.text) <= PROCESS_LOG_LIMIT);
  assert.equal(result.native.truncated, true);
  assert.equal(result.process.truncated, true);
  assert.equal(result.text.includes('Q'), false);
  assert.match(result.native.text, /\[redacted\]/);
  assert.match(result.process.text, /\[redacted\]/);
});

test('file symlinks and hardlinks cannot expose recovery or sibling files', async t => {
  const { manager, wallet, directory, log } = await fixture(t);
  await fs.symlink(path.join(directory, 'mnemonic'), log);
  await assert.rejects(manager.logs(wallet.id), unsafe);
  await fs.unlink(log);
  await fs.link(path.join(directory, 'node', 'keys_seed'), log);
  await assert.rejects(manager.logs(wallet.id), unsafe);
  await fs.unlink(log);

  const sibling = await manager.create({ ...config, name: 'Private sibling' });
  const siblingLog = path.join(manager.directory(sibling.id), 'node', 'ldk_node.log');
  await writeLog(siblingLog, 'SIBLING PRIVATE LOG\n');
  await fs.symlink(siblingLog, log);
  await assert.rejects(manager.logs(wallet.id), unsafe);
});

test('symlinked owned ancestors cannot redirect log reads into another private tree', async t => {
  for (const component of ['node', 'wallet', 'wallets', 'data']) {
    await t.test(component, async t => {
      const { manager, wallet, directory, dataDir, log } = await fixture(t);
      await writeLog(log, 'PRIVATE FILE MUST NOT FOLLOW AN ALIAS\n');
      const target = component === 'node' ? path.join(directory, 'node')
        : component === 'wallet' ? directory : component === 'wallets' ? path.join(dataDir, 'wallets') : dataDir;
      const moved = target + '-original';
      await fs.rename(target, moved);
      await fs.symlink(moved, target);
      await assert.rejects(manager.logs(wallet.id), unsafe);
    });
  }
});

test('nonprivate log files and directories are refused', async t => {
  const { manager, wallet, directory, log } = await fixture(t);
  await writeLog(log, 'private log\n');
  await fs.chmod(log, 0o644);
  await assert.rejects(manager.logs(wallet.id), unsafe);
  await fs.chmod(log, 0o600);
  await fs.chmod(path.join(directory, 'node'), 0o755);
  await assert.rejects(manager.logs(wallet.id), unsafe);
});

test('a log replaced during a tail read is rejected before returning any contents', async t => {
  const { manager, wallet, directory, log } = await fixture(t);
  await writeLog(log, 'original private log\n');
  const originalOpen = fs.open;
  let replaced = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (path.basename(String(args[0])) === 'ldk_node.log') {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        await fs.unlink(log);
        await fs.symlink(path.join(directory, 'mnemonic'), log);
        replaced = true;
        return result;
      };
    }
    return handle;
  };
  try {
    await assert.rejects(manager.logs(wallet.id), unsafe);
    assert.equal(replaced, true);
  } finally { fs.open = originalOpen; }
});

test('directories and FIFOs at the log path fail without a blocking read', { timeout: 5000 }, async t => {
  const { manager, wallet, log } = await fixture(t);
  await fs.mkdir(log, { mode: 0o700 });
  await assert.rejects(manager.logs(wallet.id), unsafe);
  await fs.rmdir(log);
  if (process.platform === 'win32') return;
  await promisify(execFile)('mkfifo', ['-m', '600', log]);
  await assert.rejects(manager.logs(wallet.id), unsafe);
});

test('authenticated log responses are uncached plaintext data and preserve the compatibility text field', async t => {
  const { manager, wallet, log, call } = await httpFixture(t);
  const secret = 'e4'.repeat(32);
  const markup = '<script>globalThis.logInjected = true</script>';
  await writeLog(log, `native ${secret}\n${markup}\n`);
  manager.runtime.set(wallet.id, { status: 'stopped', logs: ['process diagnostic\n'] });
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const result = await response.json();
  assert.equal(typeof result.text, 'string');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.ok(result.native.text.includes(markup));
  assert.match(result.text, /process diagnostic/);
  assert.ok(result.text.includes(result.native.text));
});

test('log API refuses absent, replayed, mismatched and expired sessions without disclosing a marker', async t => {
  const { log, call, headers, expire } = await httpFixture(t);
  const marker = 'AUTHENTICATED LOG CONTENT';
  await writeLog(log, marker + '\n');
  const attempts = [
    [{}, 401],
    [without(headers, 'x-session-proof'), 401],
    [without(headers, 'cookie'), 401],
    [{ ...headers, 'x-session-proof': 'A'.repeat(43) }, 401],
    [{ ...headers, origin: 'https://attacker.invalid' }, 403],
    [{ ...without(headers, 'x-session-proof'), 'x-forwarded-for': '127.0.0.1' }, 401],
  ];
  for (const [requestHeaders, status] of attempts) {
    const response = await call('', { headers: requestHeaders });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.text()).includes(marker), false);
  }
  expire();
  assert.equal((await call()).status, 401);
});

test('log API rejects every query option and unregistered wallet instead of accepting file or limit input', async t => {
  const { log, call, origin, headers, dataDir } = await httpFixture(t);
  await writeLog(log, 'QUERY MUST NOT REVEAL THIS LOG\n');
  for (const suffix of ['?path=../../mnemonic', '?file=keys_seed', '?source=native', '?limit=999999999', '?download=1', '?unknown=']) {
    const response = await call(suffix);
    assert.equal(response.status, 400, suffix);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.equal(text.includes('QUERY MUST NOT REVEAL THIS LOG'), false);
    assert.equal(text.includes(dataDir), false);
  }
  const missing = await fetch(`${origin}/api/wallets/${unknownId}/logs`, { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'NOT_FOUND');
  for (const route of ['/api/wallets/%2e%2e/logs', '/api/wallets/..%2F..%2Fauth.json/logs']) {
    assert.equal((await fetch(origin + route, { headers })).status, 404);
  }
});

test('unsafe log API errors expose no underlying native path or private contents', async t => {
  const { directory, log, call, dataDir } = await httpFixture(t);
  await fs.symlink(path.join(directory, 'mnemonic'), log);
  const response = await call();
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const text = await response.text();
  assert.equal(text.includes(dataDir), false);
  assert.equal(JSON.parse(text).error.code, 'WALLET_LOG_PATH_UNSAFE');
});
