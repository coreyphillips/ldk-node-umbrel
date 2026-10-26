import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { atomicJson, failure } from './files.mjs';

const HOSTNAME = /^[a-z2-7]{56}\.onion\n?$/;
const MAX_LINE = 8192;
const keyFiles = [
  ['hs_ed25519_secret_key', 96, '== ed25519v1-secret: type0 =='],
  ['hs_ed25519_public_key', 64, '== ed25519v1-public: type0 =='],
];
const failed = (message, code = 'TOR_START_FAILED') => Object.assign(failure(message, 503, code), { torSafe: true });
const unsafe = () => failed('Tor identity or state files are unsafe or incomplete. Restore the original files before enabling Tor.', 'TOR_IDENTITY_UNSAFE');

async function privateDirectory(directory, create = false) {
  if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw unsafe();
}

// The manager owns a private parent and serializes writers. Refuse links and
// permissive state before handing paths to Tor, which opens its own files.
async function privateTree(directory, budget = { remaining: 512 }, depth = 0) {
  if (depth > 8) throw unsafe();
  await privateDirectory(directory);
  for (const name of await fs.readdir(directory)) {
    if (--budget.remaining < 0) throw unsafe();
    const file = path.join(directory, name); const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || (stat.mode & 0o077)) throw unsafe();
    if (stat.isDirectory()) await privateTree(file, budget, depth + 1);
    else if (!stat.isFile() || stat.nlink !== 1) throw unsafe();
  }
}

async function readPrivate(file, maximum, prefixOnly = false, allowChanging = false) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (error.code === 'ELOOP') throw unsafe();
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || (stat.mode & 0o077)) throw unsafe();
    if (stat.nlink !== 1) {
      // Atomic creation may replace a file after open() but before fstat().
      // Discard that old inode; only a later read of the current path can count.
      if (allowChanging && stat.nlink === 0) return { bytes: Buffer.alloc(0), size: stat.size, changing: true };
      throw unsafe();
    }
    const buffer = Buffer.alloc(prefixOnly ? 32 : maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (!after.isFile() || after.nlink > 1 || after.size > maximum || (after.mode & 0o077)) throw unsafe();
    const changing = after.nlink !== 1 || bytesRead !== Math.min(stat.size, buffer.length) || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs;
    if (changing && !allowChanging) throw unsafe();
    return { bytes: buffer.subarray(0, bytesRead), size: stat.size, changing };
  } finally { await handle.close(); }
}

// Validate the file envelope only. Tor owns Ed25519 generation and key loading;
// secret scalars are never loaded into the manager or exposed through its API.
async function identity(directory, creating = false) {
  let missing = 0; let address;
  for (const [name, size, header] of keyFiles) {
    try {
      const value = await readPrivate(path.join(directory, name), size, true, creating);
      const expected = Buffer.alloc(32); expected.write(header, 'ascii');
      if (value.changing || value.size !== size || !value.bytes.equals(expected)) {
        if (creating) missing++;
        else throw unsafe();
      }
    } catch (error) { if (error.code === 'ENOENT') missing++; else throw error; }
  }
  try {
    const { bytes, changing } = await readPrivate(path.join(directory, 'hostname'), 63, false, creating);
    const hostname = bytes.toString('utf8');
    if (changing || !HOSTNAME.test(hostname)) {
      if (creating) missing++;
      else throw unsafe();
    } else address = `${hostname.trimEnd()}:9735`;
  } catch (error) { if (error.code === 'ENOENT') missing++; else throw error; }
  return { missing, address: missing ? null : address };
}

/**
 * Supervise one inbound v3 onion service for a wallet's local Lightning port.
 * The caller must exclusively own the private wallet parent and wait for stop()
 * before backups. Tor keeps keys and guard state under directory; caches are
 * temporary. No SOCKS or control listener is exposed. See the Tor manual:
 * https://manpages.debian.org/bookworm/tor/torrc.5.en.html
 */
export class TorProcess extends EventEmitter {
  constructor({ binary, directory, port, spawnProcess = spawn, startupTimeout = 15000, stopTimeout = 10000, pollInterval = 200 }) {
    super();
    if (typeof binary !== 'string' || !binary || !path.isAbsolute(directory) || !Number.isInteger(port) || port < 1 || port > 65535) throw failed('Invalid Tor process configuration');
    for (const value of [startupTimeout, stopTimeout, pollInterval]) if (!Number.isFinite(value) || value <= 0) throw failed('Invalid Tor process timeout');
    Object.assign(this, { binary, directory, port, spawnProcess, startupTimeout, stopTimeout, pollInterval });
    this.child = null; this.closed = true; this.startupInFlight = false;
    this.status = 'stopped'; this.error = null; this.address = null; this.bootstrap = 0;
    this.started = false; this.stopping = false; this.childLive = false; this.finishing = false;
    this.cacheDirectory = null; this.logBuffer = ''; this.wake = null; this.killTimer = null;
    this.completion = new Promise(resolve => { this.complete = resolve; });
  }

  /** Resolve after local onion creation, without waiting for Tor network bootstrap. */
  async start() {
    if (this.started || this.stopping) throw failed('Tor process cannot be started again');
    this.started = true; this.closed = false; this.startupInFlight = true; this.status = 'starting';
    try {
      await this.prepare(); this.checkActive();
      const torrc = path.join(this.cacheDirectory, 'torrc');
      const args = ['--defaults-torrc', torrc, '-f', torrc, '--RunAsDaemon', '0', '--SocksPort', '0', '--ControlPort', '0', '--ControlSocket', '0',
        '--DataDirectory', path.join(this.directory, 'data'), '--CacheDirectory', this.cacheDirectory,
        '--HiddenServiceDir', path.join(this.directory, 'onion'), '--HiddenServiceVersion', '3',
        '--HiddenServicePort', `9735 127.0.0.1:${this.port}`, '--SafeLogging', '1', '--Log', 'notice stdout'];
      this.child = this.spawnProcess(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.childLive = true; this.status = 'bootstrapping';
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', chunk => this.consume(chunk));
      // Only the configured stdout log carries bootstrap records. Drain stderr
      // separately so its fragments cannot join an unfinished stdout record.
      this.child.stderr.resume();
      this.child.on('error', () => {
        this.fail('Tor could not start. Check the bundled executable and storage permissions.');
        // Failed spawn has no process to wait for and does not emit exit.
        if (!this.child.pid) { this.childLive = false; this.wake?.(); void this.finish(); }
      });
      this.child.once('exit', () => {
        this.childLive = false; this.address = null; clearTimeout(this.killTimer); this.killTimer = null;
        if (!this.stopping) this.fail('Tor stopped unexpectedly. Restart this wallet to try again.');
        this.wake?.(); void this.finish();
      });
      const deadline = performance.now() + this.startupTimeout;
      while (true) {
        this.checkActive();
        const current = await identity(path.join(this.directory, 'onion'), this.creatingIdentity);
        this.checkActive();
        if (!current.missing) {
          if (this.expectedAddress && this.expectedAddress !== current.address) throw unsafe();
          if (!this.expectedAddress) await atomicJson(path.join(this.directory, 'identity.json'), { address: current.address });
          this.checkActive();
          this.address = current.address; this.status = this.bootstrap === 100 ? 'ready' : 'bootstrapping';
          return { address: this.address, bootstrap: this.bootstrap };
        }
        if (performance.now() >= deadline) throw failed('Tor did not create its onion identity in time. Restart this wallet to try again.');
        await this.pause(Math.min(this.pollInterval, Math.max(1, deadline - performance.now())));
      }
    } catch (error) {
      if (!this.stopping) this.fail(error.torSafe ? error.message : 'Tor could not prepare its private storage or start its process.');
      throw this.stopping ? failed('Tor startup was stopped.', 'TOR_STOPPED') : failed(this.error, error.torSafe ? error.code : 'TOR_START_FAILED');
    } finally {
      this.startupInFlight = false; await this.finish();
    }
  }

  async prepare() {
    await privateDirectory(path.dirname(this.directory)); this.checkActive();
    await privateDirectory(this.directory, true); this.checkActive();
    await privateTree(this.directory); this.checkActive();
    await privateDirectory(path.join(this.directory, 'data'), true); this.checkActive();
    await privateDirectory(path.join(this.directory, 'onion'), true); this.checkActive();
    const current = await identity(path.join(this.directory, 'onion')); this.checkActive();
    try {
      const { bytes } = await readPrivate(path.join(this.directory, 'identity.json'), 256);
      const stored = JSON.parse(bytes.toString('utf8'));
      if (!stored || typeof stored.address !== 'string' || !/^[a-z2-7]{56}\.onion:9735$/.test(stored.address)) throw unsafe();
      this.expectedAddress = stored.address;
    } catch (error) { if (error.code !== 'ENOENT') throw unsafe(); }
    if ((current.missing !== 0 && current.missing !== 3) || (this.expectedAddress && current.address !== this.expectedAddress)) throw unsafe();
    // A new Tor process may expose files between open() and its final write.
    // Only its first bounded creation attempt may wait through partial data.
    this.creatingIdentity = current.missing === 3 && !this.expectedAddress;
    // A complete identity from an interrupted first start is retained as-is.
    if (current.address && !this.expectedAddress) {
      await atomicJson(path.join(this.directory, 'identity.json'), { address: current.address });
      this.expectedAddress = current.address;
    }
    this.checkActive();
    this.cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-tor-cache-'));
    this.checkActive();
    await fs.writeFile(path.join(this.cacheDirectory, 'torrc'), '', { mode: 0o600, flag: 'wx' });
    this.checkActive();
  }

  checkActive() {
    if (this.stopping) throw failed('Tor startup was stopped.', 'TOR_STOPPED');
    if (this.error) throw failed(this.error);
  }

  // Keep only a bounded unfinished line. Raw logs, including paths and onion
  // identities, never enter dashboard state or errors.
  consume(chunk) {
    if (this.stopping || this.error) return;
    const text = String(chunk);
    if (Buffer.byteLength(text) > 65536) { this.fail('Tor diagnostic output exceeded its bounded limit.'); return; }
    this.logBuffer += text;
    let end;
    while ((end = this.logBuffer.indexOf('\n')) >= 0) {
      if (end > MAX_LINE) { this.fail('Tor diagnostic output exceeded its bounded limit.'); return; }
      const line = this.logBuffer.slice(0, end); this.logBuffer = this.logBuffer.slice(end + 1);
      const match = /\bBootstrapped ([0-9]{1,3})% \(/.exec(line);
      if (match && Number(match[1]) <= 100) {
        this.bootstrap = Math.max(this.bootstrap, Number(match[1]));
        if (this.address && this.bootstrap === 100) this.status = 'ready';
      }
    }
    if (this.logBuffer.length > MAX_LINE) this.fail('Tor diagnostic output exceeded its bounded limit.');
  }

  pause(milliseconds) {
    return new Promise(resolve => {
      const timer = setTimeout(done, milliseconds);
      function done() { clearTimeout(timer); resolve(); }
      this.wake = done;
    }).finally(() => { this.wake = null; });
  }

  fail(message) {
    if (this.stopping) return;
    this.error ||= message; this.status = 'failed'; this.address = null; this.logBuffer = '';
    this.wake?.(); this.terminate();
  }

  terminate() {
    if (!this.childLive || this.killTimer) return;
    this.killTimer = setTimeout(() => { this.killTimer = null; if (this.childLive) this.signal('SIGKILL'); }, this.stopTimeout);
    this.signal('SIGTERM');
  }

  signal(signal) {
    try { this.child.kill(signal); }
    catch {
      // A failed signal does not prove exit. Retain ownership until the child
      // exits, including if a later explicit stop retries termination.
      this.error ||= 'Tor could not be stopped. Check the process before restarting or backing up.';
      this.status = 'failed'; this.address = null;
    }
  }

  // Completion includes preparation and cache deletion, not just a child exit.
  // This keeps backup admission closed while any startup writer remains active.
  async finish() {
    if (this.finishing || this.startupInFlight || this.childLive) return;
    this.finishing = true; clearTimeout(this.killTimer); this.killTimer = null;
    try { if (this.cacheDirectory) await fs.rm(this.cacheDirectory, { recursive: true, force: true }); }
    catch { this.error ||= 'Tor stopped, but its temporary cache could not be removed.'; }
    this.cacheDirectory = null; this.address = null; this.logBuffer = ''; this.closed = true;
    if (this.stopping) this.status = 'stopped';
    this.complete(); this.emit('exit');
  }

  /** Cancel startup, terminate the child, and resolve only once all writers exit. */
  async stop() {
    this.stopping = true; this.address = null; this.wake?.(); this.terminate();
    await this.finish(); await this.completion;
  }
}
