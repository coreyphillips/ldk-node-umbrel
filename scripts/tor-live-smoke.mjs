#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Disposable network qualification only. The image's real TorProcess publishes
// a private fixture service that accepts one random 32-byte nonce and echoes it.
// A different Tor process connects over SOCKS. No host paths or ports are exposed.
const usage = 'Usage: node scripts/tor-live-smoke.mjs IMAGE arm64|amd64 [EVIDENCE_FILE]';
if (process.argv[2] === '--help') { console.log(usage); process.exit(0); }
const [image, architecture = 'arm64', evidenceFile] = process.argv.slice(2);
assert.match(image || '', /^[A-Za-z0-9][A-Za-z0-9./:@_-]+$/);
assert.ok(['arm64', 'amd64'].includes(architecture), usage);
const evidencePath = path.resolve(evidenceFile || path.join(os.tmpdir(), 'ldk-tor-live-result.json'));
const name = `ldk-tor-live-${randomBytes(5).toString('hex')}`;
const [imageId, platform] = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', image], { encoding: 'utf8', timeout: 10000 }).trim().split(' ');
assert.equal(platform, `linux/${architecture}`, 'Image platform must match the requested qualification architecture');
const source = String.raw`
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { TorProcess } from '/opt/ldk/manager/server/tor.mjs';

process.umask(0o077);
const started = Date.now();
const deadline = started + 300000;
const root = await fs.mkdtemp('/tmp/ldk-tor-live-');
const nonce = randomBytes(32);
const socksPort = 19050;
const sockets = new Set();
let validEchoes = 0; let connections = 0; let clientBootstrap = 0; let clientLog = '';
let clientExited = false; let clientError = null; let attempts = 0; let lastConnectionError = null;
let service; let client; let progress; let reached = false;
const checks = [];
const emit = value => console.log(JSON.stringify(value));
const status = () => ({ elapsed_seconds: Math.round((Date.now() - started) / 1000), service_bootstrap: service?.bootstrap || 0, service_status: service?.status || 'starting', client_bootstrap: clientBootstrap, attempts, last_connection_error: lastConnectionError });

const echo = net.createServer(socket => {
  sockets.add(socket); connections++;
  socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  socket.setTimeout(15000, () => socket.destroy());
  let received = Buffer.alloc(0);
  socket.on('data', chunk => {
    received = Buffer.concat([received, chunk]);
    if (received.length > nonce.length) { socket.destroy(); return; }
    if (received.length === nonce.length) {
      if (!received.equals(nonce)) { socket.destroy(); return; }
      validEchoes++; socket.end(nonce);
    }
  });
});

async function transfer(host, timeout) {
  const socket = net.createConnection({ host: '127.0.0.1', port: socksPort });
  let bytes = Buffer.alloc(0); let pending; let failure;
  const fail = error => { failure ||= error; if (pending) { const waiter = pending; pending = null; waiter.reject(failure); } };
  const pump = () => {
    if (pending && bytes.length >= pending.length) {
      const waiter = pending; pending = null; const value = bytes.subarray(0, waiter.length);
      bytes = bytes.subarray(waiter.length); waiter.resolve(value);
    }
  };
  socket.on('data', chunk => {
    if (bytes.length + chunk.length > 4096) { fail(new Error('Fixture response exceeded bound')); socket.destroy(); return; }
    bytes = Buffer.concat([bytes, chunk]); pump();
  });
  socket.on('error', error => fail(new Error('SOCKS socket: ' + (error.code || 'error'))));
  socket.on('end', () => { if (pending) fail(new Error('SOCKS stream ended before fixture response')); });
  socket.on('close', () => { if (pending) fail(new Error('SOCKS stream closed before fixture response')); });
  const read = length => new Promise((resolve, reject) => { if (failure) { reject(failure); return; } pending = { length, resolve, reject }; pump(); });
  const timer = setTimeout(() => { fail(new Error('SOCKS onion connection timed out')); socket.destroy(); }, timeout);
  try {
    await once(socket, 'connect');
    socket.write(Buffer.from([5, 1, 0])); assert.deepEqual(await read(2), Buffer.from([5, 0]));
    const address = Buffer.from(host, 'ascii'); const port = Buffer.alloc(2); port.writeUInt16BE(9735);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, address.length]), address, port]));
    const reply = await read(4);
    assert.equal(reply[0], 5);
    if (reply[1] !== 0) throw new Error('SOCKS onion reply code ' + reply[1]);
    if (reply[3] === 1) await read(4);
    else if (reply[3] === 4) await read(16);
    else if (reply[3] === 3) await read((await read(1))[0]);
    else throw new Error('Invalid SOCKS address type');
    await read(2); socket.write(nonce);
    assert.deepEqual(await read(nonce.length), nonce);
  } finally { clearTimeout(timer); socket.destroy(); }
}

async function stopClient() {
  if (!client || clientExited) return;
  const stopped = once(client, 'exit').catch(() => {});
  client.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    if (!clientExited) { client.kill('SIGKILL'); await stopped; }
  } finally { clearTimeout(timer); }
}

let result;
try {
  await new Promise((resolve, reject) => { echo.once('error', reject); echo.listen(0, '127.0.0.1', resolve); });
  await fs.mkdir(root + '/client', { mode: 0o700 });
  const clientConfig = root + '/client-torrc'; await fs.writeFile(clientConfig, '', { mode: 0o600 });
  client = spawn('/usr/bin/tor', ['--defaults-torrc', clientConfig, '-f', clientConfig, '--RunAsDaemon', '0', '--SocksPort', '127.0.0.1:' + socksPort, '--ControlPort', '0', '--ControlSocket', '0', '--DataDirectory', root + '/client', '--ClientOnly', '1', '--SafeLogging', '1', '--Log', 'notice stdout'], { stdio: ['ignore', 'pipe', 'pipe'] });
  client.stdout.setEncoding('utf8'); client.stdout.on('data', chunk => {
    clientLog += chunk;
    if (clientLog.length > 131072) clientLog = clientLog.slice(-65536);
    let end;
    while ((end = clientLog.indexOf('\n')) >= 0) {
      const line = clientLog.slice(0, end); clientLog = clientLog.slice(end + 1);
      const match = /\bBootstrapped ([0-9]{1,3})% \(/.exec(line);
      if (match && Number(match[1]) <= 100) clientBootstrap = Math.max(clientBootstrap, Number(match[1]));
    }
  });
  client.stderr.resume(); client.once('exit', () => { clientExited = true; });
  client.once('error', error => { clientError = 'Tor client could not start: ' + (error.code || 'unknown'); });
  service = new TorProcess({ binary: '/usr/bin/tor', directory: root + '/service', port: echo.address().port });
  progress = setInterval(() => emit({ event: 'status', ...status() }), 15000);
  const local = await service.start();
  assert.match(local.address, /^[a-z2-7]{56}\.onion:9735$/);
  checks.push('Real managed TorProcess generated a disposable onion identity and mapped port 9735 to a loopback fixture listener');
  emit({ event: 'onion_created', ...status(), reachable: false });
  const host = local.address.split(':')[0];
  while (Date.now() < deadline) {
    if (service.error || service.closed) throw new Error(service.error || 'Managed Tor exited');
    if (clientError || clientExited) throw new Error(clientError || 'Separate Tor client exited');
    if (service.bootstrap === 100 && clientBootstrap === 100) {
      attempts++;
      try { await transfer(host, Math.max(1, Math.min(20000, deadline - Date.now()))); reached = true; break; }
      catch (error) { lastConnectionError = error.message; }
      await delay(Math.min(5000, Math.max(1, deadline - Date.now())));
    } else await delay(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  if (reached) {
    assert.ok(validEchoes >= 1);
    checks.push('A separate Tor client reached the managed onion service through SOCKS and received the exact random 32-byte fixture nonce');
  }
  result = {
    result: reached ? 'pass' : 'network_limited', ...status(), checks,
    onion_reachable: reached, local_identity_created: true, fixture_bytes: nonce.length,
    valid_echoes: validEchoes, accepted_fixture_connections: connections,
    tor_module_sha256: createHash('sha256').update(await fs.readFile('/opt/ldk/manager/server/tor.mjs')).digest('hex'),
    limitation: reached ? null : 'The bounded five-minute window ended without a verified onion nonce round trip. Bootstrap percentages alone do not establish reachability.',
    user_wallet_accessed: false, funds_sent: false, host_ports_published: false,
  };
} catch (error) {
  result = { result: 'failed', ...status(), checks, onion_reachable: false, error: error.message, user_wallet_accessed: false, funds_sent: false, host_ports_published: false };
} finally {
  clearInterval(progress);
  await Promise.all([service?.stop(), stopClient()]);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => echo.close(resolve));
  await fs.rm(root, { recursive: true, force: true }); nonce.fill(0);
}
result.cleanup_complete = service?.closed !== false && (!client || clientExited);
emit({ event: 'result', ...result });
process.exitCode = result.result === 'pass' ? 0 : result.result === 'network_limited' ? 2 : 1;
`;
let result; let output = ''; let timedOut = false;
const child = spawn('docker', ['run', '--rm', '--name', name, '--platform', `linux/${architecture}`, '--init', '--user', 'node', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777', '--entrypoint', 'node', '-i', image, '--input-type=module', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
// A failed Docker launch may close stdin before consuming the script. Its exit
// status remains authoritative, while cleanup below removes any partial launch.
child.stdin.on('error', error => { if (error.code !== 'EPIPE') process.stderr.write(`Docker input failed: ${error.code || 'unknown'}\n`); });
child.stdin.end(source);
child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
  process.stdout.write(chunk); output += chunk;
  let end;
  while ((end = output.indexOf('\n')) >= 0) {
    const line = output.slice(0, end); output = output.slice(end + 1);
    try { const item = JSON.parse(line); if (item.event === 'result') result = item; } catch {}
  }
});
child.stderr.on('data', chunk => process.stderr.write(chunk));
const timer = setTimeout(() => {
  timedOut = true;
  try { execFileSync('docker', ['rm', '-f', '-v', name], { timeout: 15000, stdio: 'ignore' }); } catch {}
}, 330000);
let code;
try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
finally {
  clearTimeout(timer);
  try { execFileSync('docker', ['rm', '-f', '-v', name], { timeout: 15000, stdio: 'ignore' }); } catch {}
}
const evidence = { image, image_id: imageId, architecture, recorded_at: new Date().toISOString(), ...(result || { result: 'failed', error: timedOut ? 'Host safety deadline expired' : 'Container exited without result', exit_code: code }) };
await fs.mkdir(path.dirname(evidencePath), { recursive: true });
await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
process.exitCode = result?.result === 'pass' && code === 0 && !timedOut ? 0 : code || 1;
