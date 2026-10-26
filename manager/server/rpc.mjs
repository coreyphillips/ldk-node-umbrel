import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { failure } from './files.mjs';
import { redactDiagnostics } from './logs.mjs';

export class NativeProcess extends EventEmitter {
  constructor({ binary, config, timeout = 60_000, spawnProcess = spawn }) {
    super(); this.binary = binary; this.config = config; this.timeout = timeout; this.spawnProcess = spawnProcess;
    this.faulted = false; this.readySeen = false;
    this.pending = new Map(); this.nextId = 1; this.buffer = ''; this.logs = []; this.closed = false;
    this.syncPending = null;
    this.diagnosticBuffer = ''; this.diagnosticDiscarding = false;
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
    this.child.stderr.on('data', chunk => this.consumeDiagnostics(chunk));
    this.child.on('error', () => this.finish()); this.child.on('exit', () => this.finish());
    return ready;
  }
  consumeDiagnostics(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset);
      const part = chunk.slice(offset, newline < 0 ? chunk.length : newline);
      if (!this.diagnosticDiscarding) {
        if (Buffer.byteLength(this.diagnosticBuffer) + Buffer.byteLength(part) > 8192) {
          this.diagnosticBuffer = ''; this.diagnosticDiscarding = true;
        } else this.diagnosticBuffer += part;
      }
      if (newline < 0) break;
      // Redact only complete lines. Cutting arbitrary chunks can leak the
      // unrecognizable prefix or suffix of a secret at a capture boundary.
      this.logs.push(this.diagnosticDiscarding ? '[Oversized diagnostic line omitted.]\n' : redactDiagnostics(this.diagnosticBuffer + '\n'));
      if (this.logs.length > 200) this.logs.shift();
      this.diagnosticBuffer = ''; this.diagnosticDiscarding = false;
      offset = newline + 1;
    }
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
        if (this.syncPending?.id === message.id) { this.syncPending = null; this.emit('sync_settled'); }
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
    // A timeout does not cancel work in the daemon's serial request loop. Keep
    // the sync slot until its actual response or process exit, including for
    // manual requests, so automatic hints cannot queue duplicate native scans.
    if (method === 'sync' && this.syncPending) return this.syncPending.promise;
    if (this.pending.size >= 32) return Promise.reject(failure('Node is busy. Try again shortly.', 429, 'NODE_BUSY'));
    const id = this.nextId++;
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      if (method !== 'sync') this.pending.delete(id);
      reject(failure('Native operation timed out. Check activity before retrying any payment.', 504, 'OUTCOME_UNKNOWN'));
    }, this.timeout);
    this.pending.set(id, { resolve, reject, timer });
    if (method === 'sync') { this.syncPending = { id, promise }; this.emit('sync_started'); }
    const written = error => {
      if (error) {
        const item = this.pending.get(id); clearTimeout(timer);
        // A stream error cannot establish that a partially written sync request
        // was never executed. Preserve its slot until reply/exit as above.
        if (method !== 'sync') this.pending.delete(id);
        item?.reject(failure('Node connection closed. Check activity before retrying.', 503, 'OUTCOME_UNKNOWN'));
      }
    };
    try { this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, written); }
    catch (error) { written(error); }
    return promise;
  }
  finish() {
    if (this.closed) return; this.closed = true; clearTimeout(this.faultTimer);
    this.diagnosticBuffer = ''; this.diagnosticDiscarding = false;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure('Node exited. Check activity before retrying.', 503, 'OUTCOME_UNKNOWN')); }
    this.pending.clear(); this.syncPending = null; this.emit('exit');
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
