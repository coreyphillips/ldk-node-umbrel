import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { TorProcess } from './tor.mjs';

const HOST = `${'a'.repeat(56)}.onion`;
const ADDRESS = `${HOST}:9735`;
const header = kind => { const value = Buffer.alloc(32); value.write(`== ed25519v1-${kind}: type0 ==`, 'ascii'); return value; };
const SECRET = Buffer.concat([header('secret'), Buffer.alloc(64, 7)]);
const PUBLIC = Buffer.concat([header('public'), Buffer.alloc(32, 9)]);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-tor-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'tor');
}
async function createIdentity(root, hostname = HOST) {
  const onion = path.join(root, 'onion'); await fs.mkdir(onion, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of [['hs_ed25519_secret_key', SECRET], ['hs_ed25519_public_key', PUBLIC], ['hostname', `${hostname}\n`]]) {
    const temporary = path.join(onion, `${name}.tmp`);
    await fs.writeFile(temporary, bytes, { mode: 0o600 }); await fs.rename(temporary, path.join(onion, name));
  }
}
class Child extends EventEmitter {
  constructor({ ignoreTerm = false } = {}) {
    super(); this.pid = 12345; this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.exitCode = null; this.signalCode = null; this.signals = []; this.ignoreTerm = ignoreTerm;
  }
  kill(signal) {
    this.signals.push(signal);
    if (!this.ignoreTerm || signal === 'SIGKILL') this.exit(null, signal);
    return true;
  }
  exit(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code; this.signalCode = signal;
    this.emit('exit', code, signal); this.stdout.end(); this.stderr.end(); this.emit('close', code, signal);
  }
}
async function fixture(t, { populate = true, child = new Child(), ...options } = {}) {
  const root = options.directory || await directory(t); let invocation;
  const started = deferred();
  const tor = new TorProcess({ binary: '/test/tor', directory: root, port: 9736, startupTimeout: 500, stopTimeout: 20, pollInterval: 5,
    spawnProcess: (binary, args, spawnOptions) => {
      invocation = { binary, args, spawnOptions }; started.resolve();
      if (populate) createIdentity(root).catch(error => child.emit('error', error));
      return child;
    }, ...options });
  t.after(() => tor.stop());
  return { tor, child, root, started: started.promise, invocation: () => invocation };
}
test('local identity is available before bootstrap; arguments keep Tor inbound-only and state private', async t => {
  const { tor, child, root, invocation } = await fixture(t);
  let exits = 0; tor.on('exit', () => { exits++; assert.equal(tor.startupInFlight, false); assert.equal(tor.childLive, false); });
  assert.deepEqual(await tor.start(), { address: ADDRESS, bootstrap: 0 });
  assert.equal(tor.status, 'bootstrapping'); assert.equal(tor.closed, false);
  const { args, spawnOptions } = invocation(); const arg = name => args[args.indexOf(name) + 1];
  assert.equal(arg('--SocksPort'), '0'); assert.equal(arg('--ControlPort'), '0'); assert.equal(arg('--ControlSocket'), '0');
  assert.equal(arg('--HiddenServiceVersion'), '3'); assert.equal(arg('--HiddenServicePort'), '9735 127.0.0.1:9736');
  assert.equal(arg('--DataDirectory'), path.join(root, 'data')); assert.equal(arg('--HiddenServiceDir'), path.join(root, 'onion'));
  assert.equal(spawnOptions.shell, undefined); assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(arg('--CacheDirectory').startsWith(root), false);
  assert.equal(await fs.readFile(arg('-f'), 'utf8'), ''); assert.equal(arg('-f'), arg('--defaults-torrc'));
  assert.equal((await fs.stat(arg('-f'))).mode & 0o077, 0);
  for (const name of ['', 'data', 'onion']) assert.equal((await fs.stat(path.join(root, name))).mode & 0o077, 0);
  const marker = JSON.parse(await fs.readFile(path.join(root, 'identity.json'), 'utf8')); assert.deepEqual(marker, { address: ADDRESS });
  const cache = tor.cacheDirectory;
  child.stdout.write('[notice] Bootstrapped 9'); child.stderr.write('private diagnostic fragments\n'); child.stdout.write('5% (circuit_create): Still connecting\n');
  assert.equal(tor.bootstrap, 95); assert.equal(tor.status, 'bootstrapping');
  child.stdout.write('[notice] Bootstrapped 100% (done): Done\n');
  assert.equal(tor.bootstrap, 100); assert.equal(tor.status, 'ready');
  child.stdout.write('[notice] Bootstrapped 10% (conn): Old line\nBootstrapped 101% (invalid): ignored\n');
  assert.equal(tor.bootstrap, 100);
  await tor.stop(); await tor.stop();
  assert.equal(tor.status, 'stopped'); assert.equal(tor.closed, true); assert.equal(tor.address, null); assert.equal(exits, 1);
  await assert.rejects(fs.stat(cache), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(root, 'onion', 'hs_ed25519_secret_key')), SECRET);
});

test('stop before preparation finishes prevents spawning and waits for all preparation', async t => {
  const { tor, invocation } = await fixture(t); let exits = 0; tor.on('exit', () => { exits++; });
  const preparation = tor.prepare.bind(tor); const gate = deferred(); const prepared = deferred();
  tor.prepare = async () => { await preparation(); prepared.resolve(); await gate.promise; };
  const starting = tor.start(); const rejection = assert.rejects(starting, { code: 'TOR_STOPPED' });
  await prepared.promise; const cache = tor.cacheDirectory;
  let stopped = false; const stopping = tor.stop().then(() => { stopped = true; });
  await delay(10); assert.equal(stopped, false); assert.equal(tor.closed, false); assert.equal(tor.startupInFlight, true); assert.equal(exits, 0);
  gate.resolve(); await rejection; await stopping;
  assert.equal(invocation(), undefined); assert.equal(tor.closed, true); assert.equal(exits, 1);
  await assert.rejects(fs.stat(cache), { code: 'ENOENT' });
});

test('immediate cancellation and stop before start never spawn a process', async t => {
  const first = await fixture(t); const starting = first.tor.start();
  const rejection = assert.rejects(starting, { code: 'TOR_STOPPED' }); await first.tor.stop(); await rejection;
  assert.equal(first.invocation(), undefined); assert.equal(first.tor.closed, true);
  const second = await fixture(t); await second.tor.stop(); await assert.rejects(second.tor.start(), /cannot be started again/);
  assert.equal(second.invocation(), undefined);
});

test('stop during hostname polling rejects startup and clears the address', async t => {
  const { tor, child, started } = await fixture(t, { populate: false });
  const starting = tor.start(); const rejected = assert.rejects(starting, { code: 'TOR_STOPPED' }); await started;
  await tor.stop(); await rejected;
  assert.equal(tor.closed, true); assert.equal(tor.startupInFlight, false); assert.equal(tor.address, null);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('hostname and both identity files must exist before startup resolves', async t => {
  const { tor, child, root, started } = await fixture(t, { populate: false });
  let resolved = false; const starting = tor.start().then(value => { resolved = true; return value; }); await started;
  await fs.writeFile(path.join(root, 'onion', 'hs_ed25519_secret_key'), SECRET, { mode: 0o600 });
  await delay(20); assert.equal(resolved, false); assert.equal(tor.address, null);
  child.stdout.write('Bootstrapped 100% (done): Done\n');
  await createIdentity(root); assert.deepEqual(await starting, { address: ADDRESS, bootstrap: 100 });
  assert.equal(tor.status, 'ready');
});

test('first startup waits through partial Tor writes without accepting incomplete identities', async t => {
  const { tor, root, started } = await fixture(t, { populate: false });
  let resolved = false; const starting = tor.start().then(value => { resolved = true; return value; }); await started;
  const onion = path.join(root, 'onion');
  await fs.writeFile(path.join(onion, 'hs_ed25519_secret_key'), SECRET.subarray(0, 12), { mode: 0o600 });
  await fs.writeFile(path.join(onion, 'hs_ed25519_public_key'), Buffer.alloc(64), { mode: 0o600 });
  await fs.writeFile(path.join(onion, 'hostname'), HOST.slice(0, 20), { mode: 0o600 });
  await delay(25); assert.equal(resolved, false); assert.equal(tor.address, null); assert.equal(tor.status, 'bootstrapping');
  await createIdentity(root); await starting; assert.equal(tor.address, ADDRESS);
});

test('first startup retries an inode replaced after opening an identity file', async t => {
  const { tor, root, started } = await fixture(t, { populate: false });
  const file = path.join(root, 'onion', 'hs_ed25519_secret_key');
  const opened = deferred(); const replaced = deferred(); const originalOpen = fs.open.bind(fs);
  let intercepted = false; let observedLinks;
  t.after(() => replaced.resolve());
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file && !intercepted) {
      intercepted = true; opened.resolve(); await replaced.promise;
      observedLinks = (await handle.stat()).nlink;
    }
    return handle;
  });
  const result = tor.start().then(value => ({ value }), error => ({ error })); await started;
  await fs.writeFile(file, SECRET, { mode: 0o600 });
  await opened.promise; await createIdentity(root); replaced.resolve();
  const outcome = await result;
  assert.equal(observedLinks, 0, 'atomic replacement unlinks the inode held by the reader');
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.value, { address: ADDRESS, bootstrap: 0 });
  assert.equal(tor.address, ADDRESS);
});

test('an established identity replaced during preparation is refused before spawning', async t => {
  const root = await directory(t); await createIdentity(root);
  await fs.writeFile(path.join(root, 'identity.json'), JSON.stringify({ address: ADDRESS }), { mode: 0o600 });
  const file = path.join(root, 'onion', 'hs_ed25519_secret_key');
  const originalOpen = fs.open.bind(fs); let replaced = false; let observedLinks;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file && !replaced) {
      replaced = true; await createIdentity(root); observedLinks = (await handle.stat()).nlink;
    }
    return handle;
  });
  const { tor, invocation } = await fixture(t, { directory: root, populate: false });
  await assert.rejects(tor.start(), { code: 'TOR_IDENTITY_UNSAFE' });
  assert.equal(observedLinks, 0); assert.equal(invocation(), undefined); assert.equal(tor.closed, true);
});

test('first startup still rejects links and permissive files during identity creation', async t => {
  for (const mode of ['link', 'hardlink', 'public']) await t.test(mode, async t => {
    const { tor, root, started } = await fixture(t, { populate: false });
    const starting = tor.start(); const rejected = assert.rejects(starting, /unsafe or incomplete/); await started;
    const file = path.join(root, 'onion', 'hs_ed25519_secret_key');
    if (mode === 'link') await fs.symlink('/tmp/untrusted-tor-key', file);
    else if (mode === 'hardlink') { await fs.writeFile(file, SECRET, { mode: 0o600 }); await fs.link(file, `${file}.link`); }
    else await fs.writeFile(file, SECRET.subarray(0, 12), { mode: 0o644 });
    await rejected; await tor.completion; assert.equal(tor.closed, true); assert.equal(tor.address, null);
  });
});

test('missing executable and synchronous spawn failures produce safe errors and close completely', async t => {
  const root = await directory(t);
  const tor = new TorProcess({ binary: path.join(root, 'nonexistent'), directory: root, port: 9735 }); t.after(() => tor.stop());
  await assert.rejects(tor.start(), /Tor could not start/); await tor.completion;
  assert.equal(tor.status, 'failed'); assert.equal(tor.closed, true); assert.equal(tor.address, null); assert.equal(tor.error.includes(root), false);
  const other = await fixture(t, { spawnProcess: () => { throw new Error('private-secret-path'); } });
  await assert.rejects(other.tor.start(), /Tor could not prepare/);
  assert.equal(other.tor.closed, true); assert.equal(other.tor.error.includes('private-secret-path'), false);
});

test('early process exit cannot leave startup or a stale onion address active', async t => {
  const child = new Child(); const { tor } = await fixture(t, { populate: false, child,
    spawnProcess: () => { queueMicrotask(() => child.exit(1)); return child; } });
  await assert.rejects(tor.start(), /Tor stopped unexpectedly/); await tor.completion;
  assert.equal(tor.closed, true); assert.equal(tor.startupInFlight, false); assert.equal(tor.address, null); assert.equal(tor.status, 'failed');
});

test('startup timeout terminates and escalates without claiming the child has exited', async t => {
  const child = new Child({ ignoreTerm: true });
  const { tor } = await fixture(t, { child, populate: false, startupTimeout: 25, stopTimeout: 40 });
  await assert.rejects(tor.start(), /did not create its onion identity in time/);
  assert.equal(tor.closed, false); assert.equal(tor.childLive, true); assert.deepEqual(child.signals, ['SIGTERM']);
  await tor.completion; assert.equal(tor.closed, true); assert.equal(tor.status, 'failed');
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('stop completion and temporary cleanup wait for actual child exit', async t => {
  const child = new Child({ ignoreTerm: true }); const { tor } = await fixture(t, { child, stopTimeout: 200 });
  await tor.start(); const cache = tor.cacheDirectory; let exits = 0; tor.on('exit', () => { exits++; });
  let stopped = false; const stopping = tor.stop().then(() => { stopped = true; });
  await delay(10); assert.equal(stopped, false); assert.equal(tor.closed, false); await fs.stat(cache); assert.equal(exits, 0);
  child.exit(0); await stopping; assert.equal(tor.closed, true); assert.equal(exits, 1);
  await assert.rejects(fs.stat(cache), { code: 'ENOENT' }); assert.deepEqual(child.signals, ['SIGTERM']);
});

test('a failed termination signal keeps the child supervised until escalation exits', async t => {
  const child = new Child({ ignoreTerm: true }); const originalKill = child.kill.bind(child);
  child.kill = signal => { if (signal === 'SIGTERM') { child.signals.push(signal); throw new Error('private-process-details'); } return originalKill(signal); };
  const { tor } = await fixture(t, { child, stopTimeout: 30 }); await tor.start();
  const stopping = tor.stop(); await delay(5);
  assert.equal(tor.closed, false); assert.equal(tor.childLive, true); assert.equal(tor.address, null);
  assert.match(tor.error, /could not be stopped/); assert.equal(tor.error.includes('private-process-details'), false);
  await stopping; assert.equal(tor.closed, true); assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('private persisted identity and guard state survive restart with a fresh cache', async t => {
  const root = await directory(t); const first = await fixture(t, { directory: root }); await first.tor.start();
  await fs.writeFile(path.join(root, 'data', 'state'), 'persistent-entry-guard-fixture', { mode: 0o600 });
  const firstCache = first.tor.cacheDirectory; await first.tor.stop();
  const second = await fixture(t, { directory: root, populate: false }); await second.tor.start();
  assert.equal(second.tor.address, ADDRESS); assert.notEqual(second.tor.cacheDirectory, firstCache);
  assert.equal(await fs.readFile(path.join(root, 'data', 'state'), 'utf8'), 'persistent-entry-guard-fixture');
  assert.deepEqual(await fs.readFile(path.join(root, 'onion', 'hs_ed25519_secret_key')), SECRET);
});

test('a complete identity from an interrupted first startup is adopted without replacing keys', async t => {
  const root = await directory(t); await createIdentity(root);
  const files = ['hs_ed25519_secret_key', 'hs_ed25519_public_key', 'hostname'];
  const original = await Promise.all(files.map(name => fs.readFile(path.join(root, 'onion', name))));
  await assert.rejects(fs.stat(path.join(root, 'identity.json')), { code: 'ENOENT' });
  const { tor } = await fixture(t, { directory: root, populate: false });
  assert.deepEqual(await tor.start(), { address: ADDRESS, bootstrap: 0 });
  assert.equal(tor.creatingIdentity, false);
  const marker = path.join(root, 'identity.json');
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), { address: ADDRESS });
  assert.equal((await fs.stat(marker)).mode & 0o077, 0);
  assert.deepEqual(await Promise.all(files.map(name => fs.readFile(path.join(root, 'onion', name)))), original);
});

test('partial, corrupt and unsafe persisted identities are refused before Tor can replace them', async t => {
  const changes = {
    'missing secret': root => fs.unlink(path.join(root, 'onion', 'hs_ed25519_secret_key')),
    'bad secret size': root => fs.writeFile(path.join(root, 'onion', 'hs_ed25519_secret_key'), 'short'),
    'bad secret header': root => fs.writeFile(path.join(root, 'onion', 'hs_ed25519_secret_key'), Buffer.alloc(96)),
    'bad public header': root => fs.writeFile(path.join(root, 'onion', 'hs_ed25519_public_key'), Buffer.alloc(64)),
    'bad hostname': root => fs.writeFile(path.join(root, 'onion', 'hostname'), 'not-an-onion\n'),
    'non-ASCII hostname': root => fs.writeFile(path.join(root, 'onion', 'hostname'), Buffer.from(`${HOST}\n`).map(byte => byte | 128)),
    'public secret': root => fs.chmod(path.join(root, 'onion', 'hs_ed25519_secret_key'), 0o644),
    'public directory': root => fs.chmod(path.join(root, 'onion'), 0o755),
    'linked hostname': async root => { const file = path.join(root, 'onion', 'hostname'); await fs.rename(file, `${file}.original`); await fs.symlink(`${file}.original`, file); },
    'hardlinked key': root => fs.link(path.join(root, 'onion', 'hs_ed25519_secret_key'), path.join(root, 'onion', 'key-copy')),
    'linked state': root => fs.symlink('/tmp', path.join(root, 'untrusted-state')),
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const root = await directory(t); await createIdentity(root); await change(root);
    const { tor, invocation } = await fixture(t, { directory: root, populate: false });
    await assert.rejects(tor.start(), /unsafe or incomplete/);
    assert.equal(invocation(), undefined); assert.equal(tor.closed, true); assert.equal(tor.address, null);
  });
});

test('an established marker refuses missing identities, altered onion names and corrupt markers', async t => {
  for (const mode of ['missing', 'renamed', 'marker']) await t.test(mode, async t => {
    const root = await directory(t); const initial = await fixture(t, { directory: root }); await initial.tor.start(); await initial.tor.stop();
    if (mode === 'missing') await fs.rm(path.join(root, 'onion'), { recursive: true });
    else if (mode === 'renamed') await fs.writeFile(path.join(root, 'onion', 'hostname'), `${'b'.repeat(56)}.onion\n`);
    else await fs.writeFile(path.join(root, 'identity.json'), '{}');
    const { tor, invocation } = await fixture(t, { directory: root, populate: false }); await assert.rejects(tor.start(), /unsafe or incomplete/);
    assert.equal(invocation(), undefined); assert.equal(tor.closed, true);
  });
});

test('oversized diagnostic chunks and unfinished lines fail closed without exposing output', async t => {
  for (const output of ['sensitive-value'.repeat(700), 'x'.repeat(65537), `${'x'.repeat(8193)}\n`]) await t.test(`bounded ${output.length} bytes`, async t => {
    const { tor, child } = await fixture(t); await tor.start();
    child.stdout.write(output); await tor.completion;
    assert.equal(tor.status, 'failed'); assert.equal(tor.address, null); assert.equal(tor.closed, true);
    assert.equal(tor.logBuffer, ''); assert.equal(tor.error.includes('sensitive-value'), false);
  });
});

test('later child failure removes a ready onion and cancels further progress', async t => {
  const { tor, child } = await fixture(t); await tor.start(); child.stdout.write('Bootstrapped 100% (done): Done\n');
  assert.equal(tor.status, 'ready'); child.exit(1); await tor.completion;
  assert.equal(tor.address, null); assert.equal(tor.status, 'failed');
  tor.consume('Bootstrapped 100% (done): late\n'); assert.equal(tor.status, 'failed');
});

test('invalid generated hostname fails startup and stops the process', async t => {
  const { tor, root, child, started } = await fixture(t, { populate: false, startupTimeout: 30 });
  const starting = tor.start(); const rejected = assert.rejects(starting, /did not create its onion identity in time/); await started;
  await createIdentity(root, 'example.com'); await rejected; await tor.completion;
  assert.equal(tor.address, null); assert.equal(tor.closed, true); assert.deepEqual(child.signals, ['SIGTERM']);
});

test('a second start is rejected while the first child remains supervised', async t => {
  const { tor, child } = await fixture(t); await tor.start();
  await assert.rejects(tor.start(), /cannot be started again/); assert.equal(tor.child, child); assert.equal(tor.closed, false);
});
