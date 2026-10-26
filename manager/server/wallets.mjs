import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NativeProcess } from './rpc.mjs';
import { atomicJson, privateDir, readJson, failure } from './files.mjs';
import { walletConfig, publicConfig, rpcRequest } from './config.mjs';
import { createRecovery, readRecovery } from './recovery.mjs';
import { createBackup } from './backup.mjs';
import { TorProcess } from './tor.mjs';

export class WalletManager {
  constructor({ dataDir, binary, bridge, torBinary, portBase = 9735, publicPortBase = 19351, processFactory = options => new NativeProcess(options), torFactory = options => new TorProcess(options), electrumCheck, backupFactory = createBackup }) {
    this.dataDir = dataDir; this.binary = binary; this.bridge = bridge; this.portBase = portBase; this.publicPortBase = publicPortBase;
    this.electrumCheck = electrumCheck; this.processFactory = processFactory; this.backupFactory = backupFactory; this.wallets = []; this.runtime = new Map(); this.serial = Promise.resolve(); this.shuttingDown = false; this.backupInProgress = false; this.irohChildren = new Set();
    this.torBinary = torBinary; this.torFactory = torFactory; this.torProcesses = new Set();
  }
  async initialize() {
    await privateDir(path.join(this.dataDir, 'wallets'));
    this.wallets = await readJson(path.join(this.dataDir, 'wallets.json'), []);
    if (!Array.isArray(this.wallets) || this.wallets.length > 8) throw new Error('Invalid wallet registry');
    const ids = new Set(); const slots = new Set();
    for (const wallet of this.wallets) {
      if (!/^[0-9a-f-]{36}$/.test(wallet.id) || ids.has(wallet.id) || !Number.isInteger(wallet.slot) || wallet.slot < 0 || wallet.slot >= 8 || slots.has(wallet.slot)) throw new Error('Invalid wallet registry');
      ids.add(wallet.id); slots.add(wallet.slot); walletConfig(wallet);
    }
  }
  async boot() {
    for (const wallet of this.wallets) if (wallet.autostart && !this.shuttingDown) await this.start(wallet.id).catch(() => {});
  }
  exclusive(action) {
    const task = this.serial.then(action); this.serial = task.catch(() => {}); return task;
  }
  get(id) { const wallet = this.wallets.find(item => item.id === id); if (!wallet) throw failure('Wallet not found', 404, 'NOT_FOUND'); return wallet; }
  directory(id) { this.get(id); return path.join(this.dataDir, 'wallets', id); }
  state(id) { return this.runtime.get(id) || { status: 'stopped', logs: [] }; }
  list() { return this.wallets.map(wallet => ({ ...publicConfig(wallet), recovery_kind: wallet.recovery_kind || 'legacy_seed', status: this.state(wallet.id).status, last_error: this.state(wallet.id).error || null, public_port: this.publicPortBase + wallet.slot, iroh_status: this.state(wallet.id).iroh?.ready ? 'ready' : this.state(wallet.id).iroh?.status || 'stopped', ...this.torDetails(wallet) })); }
  // Report only public onion information, never Tor identity or guard files.
  torDetails(wallet) {
    const state = this.state(wallet.id);
    if (!wallet.tor?.enabled) return { tor_status: wallet.tor_onion_address ? 'external' : 'disabled', tor_bootstrap: 0, tor_error: null, tor_address: wallet.tor_onion_address || null };
    return { tor_status: state.tor?.status || 'stopped', tor_bootstrap: state.tor?.bootstrap || 0, tor_error: state.tor?.error || null, tor_address: state.status === 'running' ? state.tor?.address || null : null };
  }
  requireTor(config, previous) { if (config.tor.enabled && !previous?.tor?.enabled && !this.torBinary) throw failure('Managed Tor is not installed in this dashboard. Update the app or configure an existing onion service.', 503, 'TOR_UNAVAILABLE'); }
  async persist() { await atomicJson(path.join(this.dataDir, 'wallets.json'), this.wallets); }
  requireWritable() { if (this.backupInProgress) throw failure('A backup is in progress. Try again after it finishes.', 409, 'BACKUP_BUSY'); }
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
    this.requireWritable();
    return this.exclusive(async () => {
      this.requireWritable();
      const wallet = this.get(id);
      if (!['stopped', 'failed'].includes(this.state(id).status)) throw failure('Stop this wallet before changing its settings', 409, 'STOP_REQUIRED');
      const config = walletConfig(input, wallet); this.requireTor(config, wallet);
      const next = this.wallets.map(item => item.id === id ? { ...item, ...config } : item);
      await atomicJson(path.join(this.dataDir, 'wallets.json'), next); this.wallets = next; return this.list().find(item => item.id === id);
    });
  }
  async start(id) {
    this.requireWritable();
    const wallet = this.get(id); const old = this.state(id);
    if (this.shuttingDown) throw failure('Dashboard is shutting down', 409);
    if (old.startupInFlight || ['starting', 'running', 'stopping'].includes(old.status)) throw failure('Wallet is already active', 409);
    if (old.tor && (!old.tor.closed || old.tor.startupInFlight)) throw failure('Wait for this wallet’s Tor process to stop before restarting', 409);
    clearTimeout(old.restartTimer);
    const state = { status: 'starting', startupInFlight: true, error: null, attempts: old.attempts || [], logs: old.logs || [], intentional: false };
    this.runtime.set(id, state);
    try {
    // Normalize legacy Electrum URLs before passing them to the native socket
    // client, which treats a trailing slash as part of the address.
    const { chain_source } = walletConfig(wallet);
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
      alias: wallet.name, chain_source, chicory: wallet.chicory,
    });
    if (state.intentional || this.shuttingDown) { state.status = 'stopped'; return { status: 'stopped' }; }
    const process = this.processFactory({ binary: this.binary, config: configFile }); state.process = process;
    process.once('fault', message => { state.noRestart = true; state.error = message; state.status = 'stopping'; });
    process.once('exit', () => {
      state.logs = process.logs || []; state.iroh?.child?.kill('SIGTERM'); state.iroh = null;
      state.status = state.intentional || this.shuttingDown ? 'stopped' : 'failed';
      if (state.status === 'failed') state.error ||= 'Native node stopped unexpectedly. Check logs before retrying an operation.';
      // Stop onion forwarding even when the native process exits first. Do not
      // replace this generation while a Tor writer is still shutting down.
      this.stopTor(state).then(() => {
        if (!state.intentional && !this.shuttingDown && this.runtime.get(id) === state) this.scheduleRestart(wallet, state);
      }).catch(() => { state.error = 'Tor could not stop. Stop this wallet again before restarting or backing up.'; });
    });
      const ready = await process.start(); state.ready = ready;
      if (state.intentional || this.shuttingDown) { await process.stop(); return { status: 'stopped' }; }
      if (process.closed) throw failure('Native node stopped during startup', 503);
      state.status = 'running';
      if (wallet.tor?.enabled) this.startTor(wallet, state);
      if (wallet.iroh.enabled) await this.startIroh(wallet, state).catch(() => { state.iroh = { status: 'failed' }; });
      return { status: state.status };
    } catch (error) {
      state.status = state.intentional || this.shuttingDown ? 'stopped' : 'failed';
      state.error = state.status === 'failed' ? state.error || error.message : null;
      if (state.status === 'failed' && !state.process) this.scheduleRestart(wallet, state);
      throw error;
    } finally { state.startupInFlight = false; }
  }
  scheduleRestart(wallet, state) {
    state.attempts = state.attempts.filter(time => Date.now() - time < 300_000); state.attempts.push(Date.now());
    if (!state.noRestart && !state.intentional && !this.shuttingDown && wallet.autostart && state.attempts.length < 5) state.restartTimer = setTimeout(() => this.start(wallet.id).catch(() => {}), Math.min(60_000, 2000 * 2 ** state.attempts.length));
  }
  async stop(id) {
    this.requireWritable();
    this.get(id); const state = this.state(id); state.intentional = true; clearTimeout(state.restartTimer);
    state.status = 'stopping';
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
    state.tor = tor; this.torProcesses.add(tor);
    const settled = () => { if (tor.closed && !tor.startupInFlight) this.torProcesses.delete(tor); };
    tor.once('exit', settled);
    tor.start().catch(() => {}).finally(settled);
  }
  async stopTor(state) { if (state.tor?.stop) await state.tor.stop(); }
  async startIroh(wallet, state) {
    if (!this.bridge) throw failure('Iroh bridge is not installed', 503);
    state.iroh = { status: 'starting' };
    const args = [this.bridge, '--identity', path.join(this.directory(wallet.id), 'iroh.key'), '--port', String(this.portBase + wallet.slot), '--node-id', state.ready.node_id];
    if (wallet.iroh.discovery) args.push('--discovery');
    if (wallet.iroh.default_relays) args.push('--default-relays');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.iroh.child = child;
    this.irohChildren.add(child);
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
    this.get(id); const state = this.state(id);
    if (state.status !== 'running') throw failure('Start this wallet first', 409, 'NODE_STOPPED');
    return state.process.call(method, rpcRequest(method, params));
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
    const wallet = this.get(id);
    return readRecovery(this.directory(id), wallet.recovery_kind);
  }
  /** Freeze lifecycle and registry writes while copying all stopped wallet state. */
  async backup(passphrase) {
    this.requireWritable();
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
  logs(id) { this.get(id); const state = this.state(id); return (state.process?.logs || state.logs || []).join('').slice(-64 * 1024); }
  async close() { this.shuttingDown = true; await this.serial; await Promise.all(this.wallets.map(wallet => this.stop(wallet.id).catch(() => {}))); }
}
