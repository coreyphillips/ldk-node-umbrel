import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NativeProcess } from './rpc.mjs';
import { atomicJson, privateDir, readJson, failure } from './files.mjs';
import { walletConfig, publicConfig, rpcRequest } from './config.mjs';
import { createRecovery, readRecovery } from './recovery.mjs';
import { createBackup } from './backup.mjs';
import { TorProcess } from './tor.mjs';
import { ReceiveWatcher, MAX_WATCH_ADDRESSES, addressScriptHash } from './receive-watch.mjs';
import { ReceiveSync } from './receive-sync.mjs';
import { nativeDiagnostics, processDiagnostics } from './logs.mjs';

const liveChild = child => Boolean(child?.pid && child.exitCode == null && child.signalCode == null);
const unsafeDeletion = () => failure('Wallet deletion refused an unsafe data path. Check its private directory before retrying.', 409, 'WALLET_PATH_UNSAFE');

// The manager owns these private directories and admits no wallet writers while
// deleting. Refuse links and shared files before handing a registered tree to rm.
async function deletionPath(dataDir, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw unsafeDeletion();
  const parent = path.join(dataDir, 'wallets');
  for (const directory of [dataDir, parent]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw unsafeDeletion();
  }
  let entries = 0;
  async function inspect(file, depth) {
    if (++entries > 100_000 || depth > 64) throw unsafeDeletion();
    const stat = await fs.lstat(file);
    if ((stat.mode & 0o077) || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw unsafeDeletion();
    if (stat.isDirectory()) for (const name of await fs.readdir(file)) await inspect(path.join(file, name), depth + 1);
  }
  const directory = path.join(parent, id);
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafeDeletion();
    await inspect(directory, 0);
  } catch (error) {
    // A previous attempt may already have removed the entire registered tree.
    if (error.code !== 'ENOENT') throw error;
    try { await fs.lstat(directory); throw unsafeDeletion(); } catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
  }
  return directory;
}

export class WalletManager {
  constructor({ dataDir, binary, bridge, torBinary, portBase = 9735, publicPortBase = 19351, processFactory = options => new NativeProcess(options), torFactory = options => new TorProcess(options), receiveWatcherFactory = options => new ReceiveWatcher(options), receiveSyncOptions = {}, electrumCheck, backupFactory = createBackup }) {
    this.dataDir = dataDir; this.binary = binary; this.bridge = bridge; this.portBase = portBase; this.publicPortBase = publicPortBase;
    this.electrumCheck = electrumCheck; this.processFactory = processFactory; this.backupFactory = backupFactory; this.wallets = []; this.runtime = new Map(); this.serial = Promise.resolve(); this.shuttingDown = false; this.backupInProgress = false; this.irohChildren = new Set();
    this.torBinary = torBinary; this.torFactory = torFactory; this.torProcesses = new Set();
    this.deleting = new Set(); this.startupStates = new Map(); this.nativeProcesses = new Map(); this.writerOwners = new WeakMap();
    this.receiveWatcherFactory = receiveWatcherFactory; this.receiveSyncOptions = receiveSyncOptions;
  }
  async initialize() {
    await privateDir(path.join(this.dataDir, 'wallets'));
    this.wallets = await readJson(path.join(this.dataDir, 'wallets.json'), []);
    if (!Array.isArray(this.wallets) || this.wallets.length > 8) throw new Error('Invalid wallet registry');
    const ids = new Set(); const slots = new Set();
    for (const wallet of this.wallets) {
      if (!/^[0-9a-f-]{36}$/.test(wallet.id) || ids.has(wallet.id) || !Number.isInteger(wallet.slot) || wallet.slot < 0 || wallet.slot >= 8 || slots.has(wallet.slot)) throw new Error('Invalid wallet registry');
      if (wallet.deletion_pending !== undefined && typeof wallet.deletion_pending !== 'boolean') throw new Error('Invalid wallet deletion marker');
      ids.add(wallet.id); slots.add(wallet.slot); walletConfig(wallet, undefined, { allowLegacyOffline: true });
    }
  }
  async boot() {
    for (const wallet of this.wallets) if (wallet.autostart && !wallet.deletion_pending && !this.shuttingDown) await this.start(wallet.id).catch(() => {});
  }
  exclusive(action) {
    const task = this.serial.then(action); this.serial = task.catch(() => {}); return task;
  }
  get(id) { const wallet = this.wallets.find(item => item.id === id); if (!wallet) throw failure('Wallet not found', 404, 'NOT_FOUND'); return wallet; }
  directory(id) { this.get(id); return path.join(this.dataDir, 'wallets', id); }
  state(id) { return this.runtime.get(id) || { status: 'stopped', logs: [] }; }
  list() { return this.wallets.map(wallet => ({ ...publicConfig(wallet), recovery_kind: wallet.recovery_kind || 'legacy_seed', deletion_pending: this.deleting.has(wallet.id) || wallet.deletion_pending === true, status: this.deleting.has(wallet.id) || wallet.deletion_pending ? 'deletion_pending' : this.state(wallet.id).status, last_error: this.state(wallet.id).error || null, public_port: this.publicPortBase + wallet.slot, iroh_status: this.state(wallet.id).iroh?.ready ? 'ready' : this.state(wallet.id).iroh?.status || 'stopped', ...this.torDetails(wallet) })); }
  // Report only public onion information, never Tor identity or guard files.
  torDetails(wallet) {
    const state = this.state(wallet.id);
    if (!wallet.tor?.enabled) return { tor_status: wallet.tor_onion_address ? 'external' : 'disabled', tor_bootstrap: 0, tor_error: null, tor_address: wallet.tor_onion_address || null };
    return { tor_status: state.tor?.status || 'stopped', tor_bootstrap: state.tor?.bootstrap || 0, tor_error: state.tor?.error || null, tor_address: state.status === 'running' ? state.tor?.address || null : null };
  }
  requireTor(config, previous) { if (config.tor.enabled && !previous?.tor?.enabled && !this.torBinary) throw failure('Managed Tor is not installed in this dashboard. Update the app or configure an existing onion service.', 503, 'TOR_UNAVAILABLE'); }
  async persist() { await atomicJson(path.join(this.dataDir, 'wallets.json'), this.wallets); }
  requireWritable() { if (this.backupInProgress) throw failure('A backup is in progress. Try again after it finishes.', 409, 'BACKUP_BUSY'); }
  requireAvailable(id) {
    if (this.deleting.has(id) || this.get(id).deletion_pending) throw failure('Wallet deletion is pending. Retry its confirmed deletion to finish cleanup.', 409, 'DELETE_PENDING');
  }
  requireStopped(id) {
    const state = this.state(id);
    const nativeActive = process => !process.closed || liveChild(process.child);
    for (const [process] of this.nativeProcesses) if (!nativeActive(process)) this.nativeProcesses.delete(process);
    if (this.startupStates.has(id) || state.startupInFlight || !['stopped', 'failed'].includes(state.status) ||
      (state.process && nativeActive(state.process)) ||
      (state.tor && (!state.tor.closed || state.tor.startupInFlight)) || liveChild(state.iroh?.child) ||
      [...this.nativeProcesses].some(([process, owner]) => owner === id && nativeActive(process)) ||
      [...this.irohChildren].some(child => this.writerOwners.get(child) === id) ||
      [...this.torProcesses].some(tor => this.writerOwners.get(tor) === id)) {
      throw failure('Stop this wallet and wait for all its processes to exit before deleting it.', 409, 'STOP_REQUIRED');
    }
  }
  /**
   * Delete one confirmed, stopped wallet. A durable registry marker reserves its
   * slot and disables startup before any data is removed. Cleanup is retryable;
   * failures, including an uncertain registry fsync, never imply a rollback.
   */
  async remove(id, input) {
    this.requireWritable();
    if (this.shuttingDown) throw failure('Dashboard is shutting down', 409, 'SHUTTING_DOWN');
    const confirm = wallet => {
      if (!input || input.confirmation_name !== wallet.name || input.acknowledge_data_loss !== true) throw failure('Enter the exact wallet name and acknowledge permanent data loss.', 400, 'CONFIRMATION_REQUIRED');
    };
    confirm(this.get(id));
    if (this.deleting.has(id)) throw failure('Wallet deletion is already in progress.', 409, 'DELETE_PENDING');
    this.requireStopped(id);
    // start() is intentionally not serialized, so publish this guard before the
    // first await and check it at every lifecycle or recovery entry point.
    this.deleting.add(id);
    try {
      return await this.exclusive(async () => {
        this.requireWritable();
        if (this.shuttingDown) throw failure('Dashboard is shutting down', 409, 'SHUTTING_DOWN');
        const wallet = this.get(id); confirm(wallet); this.requireStopped(id);
        await deletionPath(this.dataDir, id);
        const state = this.state(id); state.intentional = true; clearTimeout(state.restartTimer);
        this.wallets = this.wallets.map(item => item.id === id ? { ...item, deletion_pending: true } : item);
        try {
          // Even if atomicJson rejects after rename, keep the pending in-memory
          // record. Nothing is removed until this durable intent write succeeds.
          await this.persist();
          const directory = await deletionPath(this.dataDir, id);
          await fs.rm(directory, { recursive: true, force: true });
          const parent = await fs.open(path.dirname(directory), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
          try { await parent.sync(); } finally { await parent.close(); }
          const next = this.wallets.filter(item => item.id !== id);
          await atomicJson(path.join(this.dataDir, 'wallets.json'), next);
          this.wallets = next; this.runtime.delete(id);
          return { deleted: true, id };
        } catch {
          throw failure('Wallet deletion is incomplete. Its data may be partially removed. Retry deletion to finish cleanup.', 500, 'DELETE_INCOMPLETE');
        }
      });
    } finally { this.deleting.delete(id); }
  }
  async create(input) {
    this.requireWritable();
    const wallet = await this.exclusive(async () => {
      this.requireWritable();
      if (this.wallets.length >= 8) throw failure('This installation supports eight wallets', 409, 'WALLET_LIMIT');
      const config = walletConfig(input);
      this.requireTor(config);
      const slot = Array.from({ length: 8 }, (_, i) => i).find(i => !this.wallets.some(wallet => wallet.slot === i));
      const value = { ...config, id: randomUUID(), slot, created_at: new Date().toISOString(), recovery_kind: 'mnemonic' };
      await createRecovery(path.join(this.dataDir, 'wallets', value.id), value.network);
      const next = [...this.wallets, value]; await atomicJson(path.join(this.dataDir, 'wallets.json'), next); this.wallets = next; return value;
    });
    if (wallet.autostart) this.start(wallet.id).catch(() => {});
    return this.list().find(item => item.id === wallet.id);
  }
  async update(id, input) {
    this.requireWritable(); this.requireAvailable(id);
    return this.exclusive(async () => {
      this.requireWritable(); this.requireAvailable(id);
      const wallet = this.get(id);
      if (!['stopped', 'failed'].includes(this.state(id).status)) throw failure('Stop this wallet before changing its settings', 409, 'STOP_REQUIRED');
      const config = walletConfig(input, wallet); this.requireTor(config, wallet);
      const next = this.wallets.map(item => item.id === id ? { ...item, ...config } : item);
      await atomicJson(path.join(this.dataDir, 'wallets.json'), next); this.wallets = next; return this.list().find(item => item.id === id);
    });
  }
  async start(id) {
    this.requireWritable(); this.requireAvailable(id);
    const wallet = this.get(id); const old = this.state(id);
    if (this.shuttingDown) throw failure('Dashboard is shutting down', 409);
    if (old.startupInFlight || ['starting', 'running', 'stopping'].includes(old.status)) throw failure('Wallet is already active', 409);
    const nativeActive = process => !process.closed || liveChild(process.child);
    if ((old.process && nativeActive(old.process)) || [...this.nativeProcesses].some(([process, owner]) => owner === id && nativeActive(process))) throw failure('Wait for this wallet’s native process to exit before restarting', 409, 'STOP_REQUIRED');
    if (old.tor && (!old.tor.closed || old.tor.startupInFlight)) throw failure('Wait for this wallet’s Tor process to stop before restarting', 409);
    clearTimeout(old.restartTimer);
    const state = { status: 'starting', startupInFlight: true, error: null, attempts: old.attempts || [], logs: old.logs || [], intentional: false };
    this.runtime.set(id, state);
    this.startupStates.set(id, state);
    try {
    // Normalize legacy connection and provider options only for the daemon.
    // The registry and all native custody state remain intact. The native reader
    // rejects unsupported persisted custody rather than silently discarding it.
    const { chain_source, chicory } = walletConfig(wallet, undefined, { allowLegacyOffline: true });
    if (chain_source.type === 'electrum' && this.electrumCheck) await this.electrumCheck({ url: chain_source.url, network: wallet.network });
    if (state.intentional || this.shuttingDown) { state.status = 'stopped'; return { status: 'stopped' }; }
    const directory = this.directory(id);
    // Never let the daemon replace missing seed material for a phrase-backed wallet.
    if (wallet.recovery_kind === 'mnemonic') await readRecovery(directory, 'mnemonic');
    await privateDir(path.join(directory, 'node'));
    if (state.intentional || this.shuttingDown) { state.status = 'stopped'; return { status: 'stopped' }; }
    const configFile = path.join(directory, 'node.json');
    await atomicJson(configFile, {
      network: wallet.network, data_dir: path.join(directory, 'node'), listen_address: `0.0.0.0:${this.portBase + wallet.slot}`,
      alias: wallet.name, chain_source, chicory,
    });
    if (state.intentional || this.shuttingDown) { state.status = 'stopped'; return { status: 'stopped' }; }
    const process = this.processFactory({ binary: this.binary, config: configFile }); state.process = process;
    this.nativeProcesses.set(process, id);
    const settled = () => { if (process.closed && !liveChild(process.child)) this.nativeProcesses.delete(process); };
    process.once('exit', settled);
    process.once('fault', message => { state.noRestart = true; state.error = message; state.status = 'stopping'; this.stopReceiveWatch(state); });
    process.once('exit', () => {
      this.stopReceiveWatch(state);
      state.logs = process.logs || []; state.iroh?.child?.kill('SIGTERM'); state.iroh = null;
      state.status = state.intentional || this.shuttingDown ? 'stopped' : 'failed';
      if (state.status === 'failed') state.error ||= 'Native node stopped unexpectedly. Check logs before retrying an operation.';
      // Stop onion forwarding even when the native process exits first. Do not
      // replace this generation while a Tor writer is still shutting down.
      this.stopTor(state).then(() => {
        if (!state.intentional && !this.shuttingDown && this.runtime.get(id) === state) this.scheduleRestart(wallet, state);
      }).catch(() => { state.error = 'Tor could not stop. Stop this wallet again before restarting or backing up.'; });
    });
      const startup = process.start();
      process.child?.once('exit', settled);
      process.child?.once('error', settled);
      const ready = await startup; state.ready = ready;
      if (state.intentional || this.shuttingDown) { await process.stop(); return { status: 'stopped' }; }
      if (process.closed) throw failure('Native node stopped during startup', 503);
      // A previous generation may still be committing its last address. Read
      // after that serialized writer so a quick restart cannot lose its watch.
      await this.exclusive(() => this.loadReceiveAddresses(wallet, state));
      if (state.intentional || this.shuttingDown) { await process.stop(); return { status: 'stopped' }; }
      if (process.closed) throw failure('Native node stopped during startup', 503);
      if (process.faulted || state.noRestart) throw failure('Native node faulted during startup. Check logs before restarting.', 503, 'NODE_FAULT');
      state.status = 'running';
      this.startReceiveWatch(wallet, state);
      if (wallet.tor?.enabled) this.startTor(wallet, state);
      if (wallet.iroh.enabled) await this.startIroh(wallet, state).catch(() => { state.iroh = { status: 'failed' }; });
      return { status: state.status };
    } catch (error) {
      state.status = state.intentional || this.shuttingDown ? 'stopped' : state.noRestart && !state.process?.closed ? 'stopping' : 'failed';
      state.error = state.status === 'stopped' ? null : state.error || error.message;
      if (state.status === 'failed' && !state.process) this.scheduleRestart(wallet, state);
      throw error;
    } finally { state.startupInFlight = false; if (this.startupStates.get(id) === state) this.startupStates.delete(id); }
  }
  scheduleRestart(wallet, state) {
    state.attempts = state.attempts.filter(time => Date.now() - time < 300_000); state.attempts.push(Date.now());
    if (!this.deleting.has(wallet.id) && !this.wallets.find(item => item.id === wallet.id)?.deletion_pending && !state.noRestart && !state.intentional && !this.shuttingDown && wallet.autostart && state.attempts.length < 5) state.restartTimer = setTimeout(() => this.start(wallet.id).catch(() => {}), Math.min(60_000, 2000 * 2 ** state.attempts.length));
  }
  async stop(id) {
    this.requireWritable(); this.requireAvailable(id);
    this.get(id); const state = this.state(id); state.intentional = true; clearTimeout(state.restartTimer);
    state.status = 'stopping';
    this.stopReceiveWatch(state);
    await this.stopTor(state);
    if (!state.process || state.process.closed) { state.status = 'stopped'; return { status: 'stopped' }; }
    if (state.iroh?.child) {
      const child = state.iroh.child; child.kill('SIGTERM');
      let timer;
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => { timer = setTimeout(resolve, 16_000); })]);
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await state.process.stop(); state.status = 'stopped'; return { status: 'stopped' };
  }
  // Tor bootstrap is independent from native startup and Iroh. Keep every
  // process tracked until its preparation and actual child exit are complete.
  startTor(wallet, state) {
    if (!this.torBinary) { state.tor = { closed: true, status: 'failed', error: 'Managed Tor is not installed. Update the app to enable automatic Tor.' }; return; }
    const tor = this.torFactory({ binary: this.torBinary, directory: path.join(this.directory(wallet.id), 'tor'), port: this.portBase + wallet.slot });
    state.tor = tor; this.torProcesses.add(tor); this.writerOwners.set(tor, wallet.id);
    const settled = () => { if (tor.closed && !tor.startupInFlight) this.torProcesses.delete(tor); };
    tor.once('exit', settled);
    tor.start().catch(() => {}).finally(settled);
  }
  async stopTor(state) { if (state.tor?.stop) await state.tor.stop(); }
  receiveActive(wallet, state) {
    return !this.shuttingDown && !state.intentional && !this.deleting.has(wallet.id) && !wallet.deletion_pending &&
      this.runtime.get(wallet.id) === state && state.status === 'running' && !state.process.closed;
  }
  // Only the native address RPC adds entries. Keep a small private watch list
  // across restart; ordinary native periodic scanning still covers every other
  // wallet address. No watcher result supplies a balance or authorizes a payment.
  async loadReceiveAddresses(wallet, state) {
    state.receiveAddresses = [];
    try {
      const saved = await readJson(path.join(this.directory(wallet.id), 'receive-addresses.json'), null);
      if (saved !== null) {
        if (saved.version !== 1 || saved.network !== wallet.network || !Array.isArray(saved.addresses) || saved.addresses.length > MAX_WATCH_ADDRESSES || new Set(saved.addresses).size !== saved.addresses.length) throw new Error('Invalid receive monitor state');
        for (const address of saved.addresses) addressScriptHash(address, wallet.network);
        state.receiveAddresses = saved.addresses;
      }
    } catch { state.receiveWarning = 'Saved receive monitoring could not be loaded. Native periodic scanning remains active.'; state.receiveStorageInvalid = true; }
  }
  startReceiveWatch(wallet, state) {
    if (!this.receiveActive(wallet, state) || wallet.chain_source.type === 'bitcoind') return;
    try {
      const active = () => this.receiveActive(wallet, state);
      const sync = new ReceiveSync({ ...this.receiveSyncOptions, process: state.process, active });
      state.receiveSync = sync;
      state.receiveWatcher = this.receiveWatcherFactory({ chainSource: wallet.chain_source, network: wallet.network, addresses: state.receiveAddresses, onChange: () => sync.hint() });
      state.receiveWatcher.start();
    } catch { this.stopReceiveWatch(state); state.receiveWarning = 'Fast receive monitoring is unavailable. Native periodic scanning remains active.'; }
  }
  stopReceiveWatch(state) {
    const watcher = state.receiveWatcher; const sync = state.receiveSync;
    state.receiveWatcher = null; state.receiveSync = null;
    // Optional observation must never prevent native shutdown or leave its
    // scheduler active if a transport cleanup unexpectedly fails.
    sync?.close();
    try { watcher?.close(); } catch { state.receiveWarning = 'Receive monitoring could not close cleanly. Native periodic scanning remains active.'; }
  }
  async rememberReceiveAddress(wallet, state, address) {
    try {
      addressScriptHash(address, wallet.network);
      await this.exclusive(async () => {
        if (!this.receiveActive(wallet, state)) return;
        const addresses = [...(state.receiveAddresses || []).filter(item => item !== address), address].slice(-MAX_WATCH_ADDRESSES);
        state.receiveAddresses = addresses;
        state.receiveWatcher?.update(addresses);
        // An invalid cache must not be silently overwritten. In-memory watches
        // still work, while the original file remains available for inspection.
        if (state.receiveStorageInvalid) return;
        await atomicJson(path.join(this.directory(wallet.id), 'receive-addresses.json'), { version: 1, network: wallet.network, addresses });
      });
    } catch { state.receiveWarning = 'Receive monitoring could not be saved. Native periodic scanning remains active.'; }
  }
  async startIroh(wallet, state) {
    if (!this.bridge) throw failure('Iroh bridge is not installed', 503);
    state.iroh = { status: 'starting' };
    const args = [this.bridge, '--identity', path.join(this.directory(wallet.id), 'iroh.key'), '--port', String(this.portBase + wallet.slot), '--node-id', state.ready.node_id];
    if (wallet.iroh.discovery) args.push('--discovery');
    if (wallet.iroh.default_relays) args.push('--default-relays');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.iroh.child = child;
    this.irohChildren.add(child);
    this.writerOwners.set(child, wallet.id);
    child.once('exit', () => this.irohChildren.delete(child));
    child.once('error', () => { if (!child.pid) this.irohChildren.delete(child); });
    await new Promise((resolve, reject) => {
      let buffer = ''; const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Iroh startup timed out')); }, 20_000);
      child.stdout.on('data', data => {
        buffer += data; if (buffer.length > 32_768) { clearTimeout(timer); child.kill('SIGTERM'); reject(new Error('Invalid Iroh response')); return; }
        const line = buffer.indexOf('\n'); if (line < 0) return;
        try {
          const message = JSON.parse(buffer.slice(0, line));
          if (!message.ready || typeof message.uri !== 'string') throw new Error('Invalid Iroh response');
          clearTimeout(timer); Object.assign(state.iroh, { ready: true, status: 'ready', uri: message.uri, endpoint_id: message.endpointId, direct_addresses: message.directAddresses || message.ipAddrs || [] }); resolve();
        } catch (error) { clearTimeout(timer); child.kill('SIGTERM'); reject(error); }
      });
      child.on('error', () => { clearTimeout(timer); reject(new Error('Iroh could not start')); });
      child.on('exit', () => { clearTimeout(timer); if (state.iroh?.child === child) state.iroh = { status: state.intentional ? 'stopped' : 'failed' }; reject(new Error('Iroh stopped')); });
      child.stderr.resume();
    });
  }
  call(id, method, params = {}) {
    const wallet = this.get(id); const state = this.state(id);
    if (state.status !== 'running') throw failure('Start this wallet first', 409, 'NODE_STOPPED');
    const result = state.process.call(method, rpcRequest(method, params));
    if (method === 'address') return result.then(async value => { await this.rememberReceiveAddress(wallet, state, value?.address); return value; });
    return result;
  }
  pairing(id, hostname) {
    const wallet = this.get(id); const state = this.state(id);
    if (state.status !== 'running') throw failure('Start this wallet to pair Chicory', 409);
    const host = wallet.advertised_host || hostname;
    const tcp = `${state.ready.node_id}@${host.includes(':') ? `[${host}]` : host}:${this.publicPortBase + wallet.slot}`;
    const tor = this.torDetails(wallet);
    return { node_id: state.ready.node_id, tcp_uri: tcp, ...tor, tor_managed: wallet.tor?.enabled === true, tor_uri: tor.tor_address ? `${state.ready.node_id}@${tor.tor_address}` : null, iroh_uri: state.iroh?.ready ? state.iroh.uri : null, iroh_status: state.iroh?.status || 'disabled', direct_addresses: state.iroh?.direct_addresses || [], network: wallet.network };
  }
  /** Reveal only this registered wallet's verified phrase through the protected recovery endpoint. */
  async recovery(id) {
    this.requireAvailable(id);
    const wallet = this.get(id);
    return readRecovery(this.directory(id), wallet.recovery_kind);
  }
  /** Freeze lifecycle and registry writes while copying all stopped wallet state. */
  async backup(passphrase) {
    this.requireWritable();
    if (this.deleting.size || this.wallets.some(wallet => wallet.deletion_pending)) throw failure('Finish pending wallet deletions before backing up.', 409, 'DELETE_PENDING');
    this.backupInProgress = true;
    try {
      return await this.exclusive(async () => {
        if (this.shuttingDown) throw failure('Dashboard is shutting down', 409);
        const active = this.wallets.some(wallet => {
          const state = this.state(wallet.id);
          const child = state.process?.child;
          return state.startupInFlight || state.status !== 'stopped' || (state.process && !state.process.closed) ||
            (child && child.pid && child.exitCode === null && child.signalCode === null);
        });
        if (active || this.irohChildren.size || this.torProcesses.size) throw failure('Stop every wallet and wait for its processes to exit before backing up.', 409, 'STOP_REQUIRED');
        return this.backupFactory(this.dataDir, passphrase);
      });
    } finally { this.backupInProgress = false; }
  }
  async logs(id) {
    const wallet = this.get(id); this.requireAvailable(id);
    const secrets = wallet.chain_source.type === 'bitcoind' ? [wallet.chain_source.password] : [];
    const state = this.state(id);
    const native = await nativeDiagnostics(this.dataDir, id, secrets);
    const diagnostics = [...(state.process?.logs || state.logs || [])];
    if (state.receiveWarning) diagnostics.push(`\n${state.receiveWarning}\n`);
    const process = processDiagnostics(diagnostics, secrets);
    return { text: `Native wallet log\n${native.text}\nProcess diagnostics\n${process.text}`, native, process };
  }

  async close() { this.shuttingDown = true; await this.serial; await Promise.all(this.wallets.map(wallet => this.stop(wallet.id).catch(() => {}))); }
}
