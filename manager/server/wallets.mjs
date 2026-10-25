import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NativeProcess } from './rpc.mjs';
import { atomicJson, privateDir, readJson, failure } from './files.mjs';
import { walletConfig, publicConfig, rpcRequest } from './config.mjs';

export class WalletManager {
  constructor({ dataDir, binary, bridge, portBase = 9735, publicPortBase = 19351, processFactory = options => new NativeProcess(options) }) {
    this.dataDir = dataDir; this.binary = binary; this.bridge = bridge; this.portBase = portBase; this.publicPortBase = publicPortBase;
    this.processFactory = processFactory; this.wallets = []; this.runtime = new Map(); this.serial = Promise.resolve(); this.shuttingDown = false;
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
  list() { return this.wallets.map(wallet => ({ ...publicConfig(wallet), status: this.state(wallet.id).status, last_error: this.state(wallet.id).error || null, public_port: this.publicPortBase + wallet.slot, iroh_status: this.state(wallet.id).iroh?.ready ? 'ready' : this.state(wallet.id).iroh?.status || 'stopped' })); }
  async persist() { await atomicJson(path.join(this.dataDir, 'wallets.json'), this.wallets); }
  async create(input) {
    const wallet = await this.exclusive(async () => {
      if (this.wallets.length >= 8) throw failure('This installation supports eight wallets', 409, 'WALLET_LIMIT');
      const config = walletConfig(input);
      const slot = Array.from({ length: 8 }, (_, i) => i).find(i => !this.wallets.some(wallet => wallet.slot === i));
      const value = { ...config, id: randomUUID(), slot, created_at: new Date().toISOString() };
      await privateDir(path.join(this.dataDir, 'wallets', value.id));
      const next = [...this.wallets, value]; await atomicJson(path.join(this.dataDir, 'wallets.json'), next); this.wallets = next; return value;
    });
    if (wallet.autostart) this.start(wallet.id).catch(() => {});
    return this.list().find(item => item.id === wallet.id);
  }
  async update(id, input) {
    return this.exclusive(async () => {
      const wallet = this.get(id);
      if (!['stopped', 'failed'].includes(this.state(id).status)) throw failure('Stop this wallet before changing its settings', 409, 'STOP_REQUIRED');
      const next = this.wallets.map(item => item.id === id ? { ...item, ...walletConfig(input, wallet) } : item);
      await atomicJson(path.join(this.dataDir, 'wallets.json'), next); this.wallets = next; return this.list().find(item => item.id === id);
    });
  }
  async start(id) {
    const wallet = this.get(id); const old = this.state(id);
    if (this.shuttingDown) throw failure('Dashboard is shutting down', 409);
    if (['starting', 'running', 'stopping'].includes(old.status)) throw failure('Wallet is already active', 409);
    clearTimeout(old.restartTimer);
    const state = { status: 'starting', error: null, attempts: old.attempts || [], logs: old.logs || [], intentional: false };
    this.runtime.set(id, state);
    try {
    const directory = this.directory(id);
    await privateDir(path.join(directory, 'node'));
    const configFile = path.join(directory, 'node.json');
    await atomicJson(configFile, {
      network: wallet.network, data_dir: path.join(directory, 'node'), listen_address: `0.0.0.0:${this.portBase + wallet.slot}`,
      alias: wallet.name, chain_source: wallet.chain_source, chicory: wallet.chicory,
    });
    const process = this.processFactory({ binary: this.binary, config: configFile }); state.process = process;
    process.once('fault', message => { state.noRestart = true; state.error = message; state.status = 'stopping'; });
    process.once('exit', () => {
      state.logs = process.logs || []; state.iroh?.child?.kill('SIGTERM'); state.iroh = null;
      if (state.intentional || this.shuttingDown) { state.status = 'stopped'; return; }
      state.status = 'failed'; state.error ||= 'Native node stopped unexpectedly. Check logs before retrying an operation.';
      state.attempts = state.attempts.filter(time => Date.now() - time < 300_000); state.attempts.push(Date.now());
      if (!state.noRestart && wallet.autostart && state.attempts.length < 5) state.restartTimer = setTimeout(() => this.start(id).catch(() => {}), Math.min(60_000, 2000 * 2 ** state.attempts.length));
    });
      const ready = await process.start(); state.ready = ready;
      if (state.intentional || this.shuttingDown) { await process.stop(); return { status: 'stopped' }; }
      state.status = 'running';
      if (wallet.iroh.enabled) await this.startIroh(wallet, state).catch(() => { state.iroh = { status: 'failed' }; });
      return { status: state.status };
    } catch (error) {
      state.status = state.intentional || this.shuttingDown ? 'stopped' : 'failed';
      state.error = state.status === 'failed' ? state.error || error.message : null; throw error;
    }
  }
  async stop(id) {
    this.get(id); const state = this.state(id); state.intentional = true; clearTimeout(state.restartTimer);
    if (!state.process || state.process.closed) { state.status = 'stopped'; return { status: 'stopped' }; }
    state.status = 'stopping';
    if (state.iroh?.child) {
      const child = state.iroh.child; child.kill('SIGTERM');
      let timer;
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => { timer = setTimeout(resolve, 16_000); })]);
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await state.process.stop(); state.status = 'stopped'; return { status: 'stopped' };
  }
  async startIroh(wallet, state) {
    if (!this.bridge) throw failure('Iroh bridge is not installed', 503);
    state.iroh = { status: 'starting' };
    const args = [this.bridge, '--identity', path.join(this.directory(wallet.id), 'iroh.key'), '--port', String(this.portBase + wallet.slot), '--node-id', state.ready.node_id];
    if (wallet.iroh.discovery) args.push('--discovery');
    if (wallet.iroh.default_relays) args.push('--default-relays');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.iroh.child = child;
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
    return { node_id: state.ready.node_id, tcp_uri: tcp, tor_uri: wallet.tor_onion_address ? `${state.ready.node_id}@${wallet.tor_onion_address}` : null, iroh_uri: state.iroh?.ready ? state.iroh.uri : null, iroh_status: state.iroh?.status || 'disabled', direct_addresses: state.iroh?.direct_addresses || [], network: wallet.network };
  }
  logs(id) { this.get(id); const state = this.state(id); return (state.process?.logs || state.logs || []).join('').slice(-64 * 1024); }
  async close() { this.shuttingDown = true; await Promise.all(this.wallets.map(wallet => this.stop(wallet.id).catch(() => {}))); }
}
