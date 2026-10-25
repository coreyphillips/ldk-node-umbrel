import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { failure } from './files.mjs';

export class NativeProcess extends EventEmitter {
  constructor({ binary, config, timeout = 60_000, spawnProcess = spawn }) {
    super(); this.binary = binary; this.config = config; this.timeout = timeout; this.spawnProcess = spawnProcess;
    this.faulted = false; this.readySeen = false;
    this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.logs = []; this.closed = false;
  }
  async start() {
    if (this.child) throw failure('Node is already running');
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.child?.kill('SIGTERM'); reject(failure('Node startup timed out', 504, 'START_TIMEOUT')); }, 120_000);
      this.once('ready', value => { clearTimeout(timer); resolve(value); });
      this.once('exit', () => { clearTimeout(timer); reject(failure('Native node exited during startup. Check logs.', 503, 'START_FAILED')); });
    });
    this.child = this.spawnProcess(this.binary, ['--config', this.config], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, RUST_BACKTRACE: '0' } });
    this.child.stdin.on('error', () => this.finish());
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(chunk));
    this.child.stderr.on('data', chunk => {
      // Native diagnostics may name payments, so logs are authenticated and bounded.
      this.logs.push(chunk.slice(0, 8192).replace(/\b(?:[0-9a-f]{64})\b/gi, '[redacted]'));
      if (this.logs.length > 200) this.logs.shift();
    });
    this.child.on('error', () => this.finish()); this.child.on('exit', () => this.finish());
    return ready;
  }
  consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) { this.fault('Native output exceeded its bounded protocol limit'); return; }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { this.fault('Native output was not valid JSON'); return; }
      if (message.event === 'error') {
        this.fault(message.code === 'event_persistence_failed' ? 'Native event-history persistence failed. Inspect the node storage before restarting.' : 'Native node reported a fatal error. Inspect its diagnostics before restarting.'); return;
      }
      if (message.event === 'ready') {
        if (this.readySeen) { this.fault('Native node sent a duplicate ready event'); return; }
        if (!/^(02|03)[0-9a-f]{64}$/.test(message.node_id || '') || !['bitcoin', 'testnet', 'signet', 'regtest'].includes(message.network)) { this.fault('Native node returned an invalid identity'); return; }
        this.readySeen = true; this.emit('ready', message);
      }
      else if (message.id !== undefined) {
        const pending = this.pending.get(message.id); if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(failure(String(message.error.message || 'Native operation failed').slice(0, 512), 400, message.error.code || 'NATIVE_ERROR'));
        else pending.resolve(message.result);
      }
    }
  }
  fault(message) {
    if (this.faulted || this.closed) return;
    this.faulted = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(message + ' Check activity before retrying.', 503, 'OUTCOME_UNKNOWN')); }
    this.pending.clear(); this.emit('fault', message);
    this.child?.kill('SIGTERM'); this.faultTimer = setTimeout(() => this.child?.kill('SIGKILL'), 5000); this.faultTimer.unref();
  }
  call(method, params = {}) {
    if (this.faulted) return Promise.reject(failure('Native node is faulted. Inspect storage and diagnostics before restarting.', 503, 'NODE_FAULT'));

    if (!this.child || this.closed) return Promise.reject(failure('Start this wallet first', 409, 'NODE_STOPPED'));
    if (this.pending.size >= 32) return Promise.reject(failure('Node is busy. Try again shortly.', 429, 'NODE_BUSY'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('Native operation timed out. Check activity before retrying any payment.', 504, 'OUTCOME_UNKNOWN'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error) { const item = this.pending.get(id); this.pending.delete(id); clearTimeout(timer); item?.reject(failure('Node connection closed. Check activity before retrying.', 503, 'OUTCOME_UNKNOWN')); }
      });
    });
  }
  finish() {
    if (this.closed) return; this.closed = true; clearTimeout(this.faultTimer);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure('Node exited. Check activity before retrying.', 503, 'OUTCOME_UNKNOWN')); }
    this.pending.clear(); this.emit('exit');
  }
  async stop() {
    if (!this.child || this.closed) return;
    const exit = new Promise(resolve => this.once('exit', resolve));
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 15_000);
    const force = setTimeout(() => this.child.kill('SIGKILL'), 45_000);
    this.call('stop').catch(() => {});
    try { await exit; } finally { clearTimeout(timer); clearTimeout(force); }
  }
}
