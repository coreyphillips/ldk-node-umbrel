import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { bech32, bech32m } from '@scure/base';
import { electrumUrl } from './electrum.mjs';

export const MAX_WATCH_ADDRESSES = 16;
const NETWORKS = Object.freeze({
  bitcoin: ['bc', '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'],
  testnet: ['tb', '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'],
  signet: ['tb', '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6'],
  regtest: ['bcrt', '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'],
});
const STATS = ['tx_count', 'funded_txo_count', 'funded_txo_sum', 'spent_txo_count', 'spent_txo_sum'];
const MAX_BODY = 16 * 1024;
const MAX_LINE = 4096;
const MAX_WINDOW_BYTES = 128 * 1024;
const MAX_WINDOW_FRAMES = 128;
const WINDOW_MS = 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Invalid receive watcher configuration');
const protocol = () => new Error('Receive watcher could not validate its configured backend. Native wallet synchronization remains active.');

/** Validate BIP173/BIP350 witness encoding and return Electrum's reversed SHA256 script hash. */
export function addressScriptHash(address, network) {
  if (!Object.hasOwn(NETWORKS, network) || typeof address !== 'string' || address.length > 90) throw invalid();
  let decoded; let modern = false;
  try { decoded = bech32.decode(address); }
  catch { try { decoded = bech32m.decode(address); modern = true; } catch { throw invalid(); } }
  const version = decoded.words[0];
  let program;
  try { program = bech32.fromWords(decoded.words.slice(1)); } catch { throw invalid(); }
  if (decoded.prefix !== NETWORKS[network][0] || !Number.isInteger(version) || version > 16 || program.length < 2 || program.length > 40 ||
    (version === 0 && (modern || ![20, 32].includes(program.length))) || (version !== 0 && !modern)) throw invalid();
  const script = Buffer.concat([Buffer.from([version === 0 ? 0 : 0x50 + version, program.length]), program]);
  return createHash('sha256').update(script).digest().reverse().toString('hex');
}

function sourceConfig(source) {
  if (!object(source)) throw invalid();
  if (source.type === 'bitcoind') return { type: 'bitcoind' };
  if (source.type === 'electrum') return { type: 'electrum', endpoint: electrumUrl(source.url) };
  if (source.type !== 'esplora' || typeof source.url !== 'string' || source.url.length > 2048 || /[\x00-\x20]/.test(source.url)) throw invalid();
  let url;
  try { url = new URL(source.url); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname) throw invalid();
  return { type: 'esplora', base: url.href.replace(/\/+$/, '') };
}

// Protocol data is only a change hint. Never expose its claimed balances or raw
// errors. See https://electrumx.readthedocs.io/en/latest/protocol-methods.html#blockchain-scripthash-subscribe and
// https://github.com/Blockstream/esplora/blob/master/API.md#addresses.
/**
 * Watch bounded native-generated addresses on the wallet's configured backend.
 * The caller owns address authorization and coalesces onChange into native sync.
 * close() is terminal and synchronously invalidates all late transport results.
 */
export class ReceiveWatcher {
  constructor({ chainSource, network, addresses = [], onChange, onStatus = () => {},
    connectTcp = options => net.connect(options), connectTls = options => tls.connect(options), fetch = globalThis.fetch,
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
    pollInterval = 15000, requestTimeout = 5000, reconnectMin = 1000, reconnectMax = 30000, keepaliveInterval = 30000 } = {}) {
    if (!Object.hasOwn(NETWORKS, network) || [onChange, onStatus, connectTcp, connectTls, fetch, setTimer, clearTimer, now].some(value => typeof value !== 'function')) throw invalid();
    for (const value of [pollInterval, requestTimeout, reconnectMin, reconnectMax, keepaliveInterval]) if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw invalid();
    if (reconnectMin > reconnectMax || requestTimeout > 30_000) throw invalid();
    this.source = sourceConfig(chainSource); this.network = network; this.onChange = onChange; this.onStatus = onStatus;
    this.connectTcp = connectTcp; this.connectTls = connectTls; this.fetch = fetch;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.now = now;
    this.pollInterval = pollInterval; this.requestTimeout = requestTimeout; this.reconnectMin = reconnectMin; this.reconnectMax = reconnectMax; this.keepaliveInterval = keepaliveInterval;
    this.records = new Map(); this.timers = new Set(); this.epoch = 0; this.active = false; this.closed = false;
    this.phase = 'stopped'; this.error = null; this.retryDelay = reconnectMin; this.socket = null; this.controller = null; this.polling = false; this.restartPoll = false;
    this.windowStart = this.now(); this.windowBytes = 0; this.windowFrames = 0;
    this.update(addresses);
  }
  get status() { return { status: this.phase, error: this.error }; }
  setStatus(status, error = null) {
    if (this.closed || (status === this.phase && error === this.error)) return;
    this.phase = status; this.error = error;
    try { Promise.resolve(this.onStatus(this.status)).catch(() => {}); } catch {}
  }
  update(addresses) {
    if (!Array.isArray(addresses) || addresses.length > MAX_WATCH_ADDRESSES) throw invalid();
    const records = new Map();
    for (const address of addresses) {
      const hash = addressScriptHash(address, this.network);
      records.set(hash, this.records.get(hash) || { address: address.toLowerCase(), hash, fingerprint: undefined });
    }
    const changed = records.size !== this.records.size || [...records.keys()].some(hash => !this.records.has(hash));
    this.records = records;
    if (changed && this.active && !this.closed) this.restart();
  }
  start() {
    if (this.active || this.closed) return;
    this.active = true; this.restart();
  }
  current(epoch) { return this.active && !this.closed && this.epoch === epoch; }
  timer(action, delay) {
    const timer = this.setTimer(() => { this.timers.delete(timer); action(); }, delay);
    timer?.unref?.(); this.timers.add(timer); return timer;
  }
  cancelTimer(timer) { this.clearTimer(timer); this.timers.delete(timer); }
  disconnect() {
    this.epoch++;
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
    const socket = this.socket; this.socket = null; socket?.destroy();
    this.controller?.abort(); this.controller = null;
  }
  restart() {
    this.disconnect();
    if (!this.records.size || this.source.type === 'bitcoind') { this.restartPoll = false; this.setStatus('stopped'); return; }
    if (this.source.type === 'electrum') this.connect();
    else if (this.polling) this.restartPoll = true;
    else void this.poll();
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.active = false; this.restartPoll = false;
    this.disconnect(); this.phase = 'stopped'; this.error = null;
  }
  changed(record, fingerprint, initialActivity) {
    if (!this.active || this.closed || this.records.get(record.hash) !== record) return;
    const previous = record.fingerprint; record.fingerprint = fingerprint;
    if ((previous === undefined && initialActivity) || (previous !== undefined && previous !== fingerprint)) {
      try { Promise.resolve(this.onChange()).catch(() => {}); } catch {}
    }
  }
  retry(epoch) {
    if (!this.current(epoch)) return;
    this.disconnect(); const next = this.epoch;
    this.setStatus('retrying', protocol().message);
    if (!this.current(next)) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.reconnectMax, delay * 2);
    this.timer(() => { if (this.current(next)) { if (this.source.type === 'electrum') this.connect(); else void this.poll(); } }, delay);
  }
  connect() {
    const epoch = this.epoch; const { endpoint } = this.source;
    if (!this.current(epoch)) return;
    this.setStatus('connecting');
    if (!this.current(epoch)) return;
    let socket; let buffer = ''; let nextId = 1; let version = false; let genesis = false; let subscribed = false;
    const pending = new Map();
    const fail = () => this.retry(epoch);
    const request = (method, params, kind, record) => {
      if (!this.current(epoch)) return;
      const id = nextId++;
      const timer = this.timer(fail, this.requestTimeout);
      pending.set(id, { kind, record, timer });
      try { socket.write(`${JSON.stringify({ id, method, params })}\n`); } catch { fail(); }
    };
    const heartbeat = () => {
      if (!this.current(epoch)) return;
      if (![...pending.values()].some(item => item.kind === 'ping')) request('server.ping', [], 'ping');
      if (this.current(epoch)) this.timer(heartbeat, this.keepaliveInterval);
    };
    const ready = () => {
      if (!version || !genesis || subscribed || !this.current(epoch)) return;
      subscribed = true;
      for (const record of this.records.values()) request('blockchain.scripthash.subscribe', [record.hash], 'subscribe', record);
      if (this.current(epoch)) this.timer(heartbeat, this.keepaliveInterval);
    };
    const status = (record, value) => {
      if (value !== null && (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) throw protocol();
      this.changed(record, value, value !== null);
    };
    const message = value => {
      if (!object(value)) throw protocol();
      if (value.id === undefined || value.id === null) {
        if (!subscribed || value.method !== 'blockchain.scripthash.subscribe' || !Array.isArray(value.params) || value.params.length !== 2) throw protocol();
        const record = this.records.get(value.params[0]);
        if (!record) throw protocol();
        status(record, value.params[1]); return;
      }
      const item = pending.get(value.id);
      if (!item || value.error || !Object.hasOwn(value, 'result')) throw protocol();
      pending.delete(value.id); this.cancelTimer(item.timer);
      if (item.kind === 'version') {
        if (!Array.isArray(value.result) || value.result.length !== 2 || typeof value.result[0] !== 'string' || value.result[0].length > 256 || typeof value.result[1] !== 'string' || !/^1\.4(?:\.[0-9]+)?$/.test(value.result[1])) throw protocol();
        version = true;
      } else if (item.kind === 'genesis') {
        if (typeof value.result !== 'string' || !/^[0-9a-fA-F]{160}$/.test(value.result)) throw protocol();
        const once = createHash('sha256').update(Buffer.from(value.result, 'hex')).digest();
        if (createHash('sha256').update(once).digest().reverse().toString('hex') !== NETWORKS[this.network][1]) throw protocol();
        genesis = true;
      } else if (item.kind === 'subscribe') status(item.record, value.result);
      else if (value.result !== null) throw protocol();
      ready();
      if (this.current(epoch) && subscribed && ![...pending.values()].some(item => item.kind === 'subscribe')) {
        this.retryDelay = this.reconnectMin; this.setStatus('watching');
      }
    };
    try {
      socket = endpoint.tls ? this.connectTls({ host: endpoint.host, port: endpoint.port, servername: net.isIP(endpoint.host) ? undefined : endpoint.host, rejectUnauthorized: true }) : this.connectTcp({ host: endpoint.host, port: endpoint.port });
      this.socket = socket;
      const connectionTimer = this.timer(fail, this.requestTimeout);
      socket.once(endpoint.tls ? 'secureConnect' : 'connect', () => {
        if (!this.current(epoch)) return;
        this.cancelTimer(connectionTimer);
        request('server.version', ['ldk-node-umbrel', '1.4'], 'version');
        request('blockchain.block.header', [0], 'genesis');
      });
      socket.on('data', chunk => {
        if (!this.current(epoch)) return;
        try {
          if (this.now() - this.windowStart >= WINDOW_MS) { this.windowStart = this.now(); this.windowBytes = 0; this.windowFrames = 0; }
          this.windowBytes += chunk.length;
          if (this.windowBytes > MAX_WINDOW_BYTES || chunk.length > MAX_WINDOW_BYTES) throw protocol();
          buffer += chunk.toString('utf8');
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            if (newline > MAX_LINE || ++this.windowFrames > MAX_WINDOW_FRAMES) throw protocol();
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            message(JSON.parse(line));
            if (!this.current(epoch)) return;
          }
          if (buffer.length > MAX_LINE) throw protocol();
        } catch { fail(); }
      });
      socket.on('error', fail); socket.once('close', fail);
    } catch { fail(); }
  }
  async read(url, epoch) {
    const controller = new AbortController(); this.controller = controller;
    const timer = this.timer(() => controller.abort(), this.requestTimeout);
    let reader;
    try {
      const response = await this.fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json, text/plain' } });
      if (!this.current(epoch) || controller.signal.aborted) throw protocol();
      if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !response.body || Number(response.headers.get('content-length')) > MAX_BODY) throw protocol();
      reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (!this.current(epoch) || controller.signal.aborted) throw protocol();
        if (done) break;
        size += value.byteLength; if (size > MAX_BODY) throw protocol();
        chunks.push(Buffer.from(value));
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    } finally {
      this.cancelTimer(timer); controller.abort();
      if (this.controller === controller) this.controller = null;
      if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  async poll() {
    if (this.polling || !this.active || this.closed || !this.records.size) return;
    const epoch = this.epoch; this.polling = true; this.restartPoll = false;
    this.setStatus('connecting');
    try {
      if (!this.current(epoch)) return;
      // Check the configured backend before disclosing any receive address.
      const genesis = await this.read(`${this.source.base}/block-height/0`, epoch);
      if (genesis.trim() !== NETWORKS[this.network][1]) throw protocol();
      for (const record of this.records.values()) {
        if (!this.current(epoch)) return;
        const result = JSON.parse(await this.read(`${this.source.base}/address/${record.address}`, epoch));
        if (!object(result) || result.address !== record.address) throw protocol();
        const values = [];
        for (const section of ['chain_stats', 'mempool_stats']) {
          if (!object(result[section])) throw protocol();
          for (const key of STATS) {
            const value = result[section][key];
            if (!Number.isSafeInteger(value) || value < 0) throw protocol();
            values.push(value);
          }
        }
        if (!this.current(epoch)) return;
        this.changed(record, JSON.stringify(values), result.chain_stats.tx_count > 0 || result.mempool_stats.tx_count > 0);
      }
      if (this.current(epoch)) {
        this.retryDelay = this.reconnectMin; this.setStatus('watching');
        if (this.current(epoch)) this.timer(() => { if (this.current(epoch)) void this.poll(); }, this.pollInterval);
      }
    } catch { this.retry(epoch); }
    finally {
      this.polling = false;
      if (this.restartPoll && this.active && !this.closed && this.records.size) void this.poll();
    }
  }
}
