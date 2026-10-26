import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { bech32, bech32m } from '@scure/base';
import { ReceiveWatcher, addressScriptHash, MAX_WATCH_ADDRESSES } from './receive-watch.mjs';

const HASH = 'a'.repeat(64);
const NEXT_HASH = 'b'.repeat(64);
const GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const parameters = { bitcoin: [1231006505, 0x1d00ffff, 2083236893], testnet: [1296688602, 0x1d00ffff, 414098458], signet: [1598918400, 0x1e0377ae, 52613770], regtest: [1296688602, 0x207fffff, 2] };
function header(network = 'regtest') {
  const value = Buffer.alloc(80); value.writeUInt32LE(1);
  Buffer.from('3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a', 'hex').copy(value, 36);
  parameters[network].forEach((number, index) => value.writeUInt32LE(number, 68 + index * 4)); return value.toString('hex');
}
const address = (byte = 1, prefix = 'bcrt', version = 0, length = 20, codec = version ? bech32m : bech32) => codec.encode(prefix, [version, ...codec.toWords(Buffer.alloc(length, byte))]);
const ADDRESS = address();
const OTHER = address(2);
const scriptHash = addressScriptHash(ADDRESS, 'regtest');
const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const notification = (value, hash = scriptHash) => ({ jsonrpc: '2.0', method: 'blockchain.scripthash.subscribe', params: [hash, value] });
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await flush(); } assert.fail('Asynchronous fixture did not settle'); }

class Clock {
  time = 0; timers = new Set();
  set = (action, delay) => { const value = { action, at: this.time + delay }; this.timers.add(value); return value; };
  clear = value => this.timers.delete(value);
  now = () => this.time;
  advance(amount) {
    const destination = this.time + amount; let turns = 0;
    while (true) {
      const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
      if (!next || next.at > destination) break;
      assert.ok(++turns < 10_000, 'bounded timer work');
      this.time = next.at; this.timers.delete(next); next.action();
    }
    this.time = destination;
  }
}
class Socket extends EventEmitter {
  sent = []; destroyed = false;
  write(bytes) { this.sent.push(JSON.parse(bytes)); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
  send(value) { this.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
}
function fixture(t, options = {}) {
  const clock = new Clock(); const sockets = []; const hints = []; const statuses = []; const connections = [];
  const connect = value => { connections.push(value); const socket = new Socket(); sockets.push(socket); return socket; };
  const watcher = new ReceiveWatcher({ chainSource: { type: 'electrum', url: 'tcp://node.local:50001' }, network: 'regtest', addresses: [ADDRESS], onChange: (...args) => hints.push(args), onStatus: value => statuses.push(value), connectTcp: connect, connectTls: connect, setTimer: clock.set, clearTimer: clock.clear, now: clock.now, ...options });
  t.after(() => watcher.close());
  return { watcher, clock, sockets, hints, statuses, connections };
}
function handshake(socket, { network = 'regtest', status = null, tls = false } = {}) {
  socket.emit(tls ? 'secureConnect' : 'connect');
  assert.deepEqual(socket.sent.slice(0, 2).map(item => item.method), ['server.version', 'blockchain.block.header']);
  socket.send(response(2, header(network))); socket.send(response(1, ['fixture', '1.4.3']));
  for (const item of socket.sent.filter(item => item.method === 'blockchain.scripthash.subscribe')) socket.send(response(item.id, status));
}
function stats(receiveAddress = ADDRESS, count = 0) {
  const zero = { tx_count: 0, funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0 };
  return { address: receiveAddress, chain_stats: { ...zero }, mempool_stats: { ...zero, tx_count: count, funded_txo_count: count, funded_txo_sum: count * 1000 } };
}
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
function httpFixture(t, handler, options = {}) {
  const calls = [];
  const fixtureResult = fixture(t, { chainSource: { type: 'esplora', url: 'https://node.local/api/' }, fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); }, ...options });
  return { ...fixtureResult, calls };
}

test('SegWit script hashes match independent script construction across networks and witness versions', () => {
  for (const [network, prefix] of [['bitcoin', 'bc'], ['testnet', 'tb'], ['signet', 'tb'], ['regtest', 'bcrt']]) {
    for (const [version, length] of [[0, 20], [0, 32], [1, 32], [2, 2], [16, 40]]) {
      const script = Buffer.concat([Buffer.from([version ? 0x50 + version : 0, length]), Buffer.alloc(length, 37)]);
      const expected = createHash('sha256').update(script).digest().reverse().toString('hex');
      const encoded = address(37, prefix, version, length);
      assert.equal(addressScriptHash(encoded, network), expected);
      assert.equal(addressScriptHash(encoded.toUpperCase(), network), expected);
    }
  }
  assert.equal(MAX_WATCH_ADDRESSES, 16);
});

test('address validation rejects bad checksums, network, version, lengths, padding and mixed case', () => {
  for (const value of [null, {}, '', '1BitcoinAddress', ` ${ADDRESS}`, `${ADDRESS} `, ADDRESS.slice(0, -1) + (ADDRESS.endsWith('q') ? 'p' : 'q'), ADDRESS.slice(0, 4).toUpperCase() + ADDRESS.slice(4), address(1, 'bc'), address(1, 'bcrt', 0, 19), address(1, 'bcrt', 0, 21), address(1, 'bcrt', 1, 1), address(1, 'bcrt', 1, 41), address(1, 'bcrt', 17, 20), address(1, 'bcrt', 0, 20, bech32m), address(1, 'bcrt', 1, 32, bech32), bech32.encode('bcrt', [0, ...bech32.toWords(Buffer.alloc(20)), 1])]) {
    assert.throws(() => addressScriptHash(value, 'regtest'), /Invalid receive watcher configuration/);
  }
  for (const network of ['unknown', '__proto__', 'constructor']) assert.throws(() => addressScriptHash(ADDRESS, network));
});

test('construction and empty address sets are passive, updates are atomic and close is terminal', t => {
  const { watcher, sockets, hints, clock, statuses } = fixture(t, { addresses: [] });
  assert.equal(statuses.length, 0); assert.equal(sockets.length, 0); watcher.start(); assert.equal(sockets.length, 0);
  watcher.update([ADDRESS, ADDRESS.toUpperCase()]); assert.equal(sockets.length, 1);
  assert.throws(() => watcher.update([OTHER, 'invalid'])); assert.equal(watcher.records.size, 1);
  assert.throws(() => watcher.update(Array.from({ length: 17 }, (_, i) => address(i))));
  handshake(sockets[0]); watcher.start(); assert.equal(sockets.length, 1);
  watcher.update([]); assert.equal(sockets[0].destroyed, true); assert.equal(clock.timers.size, 0);
  watcher.close(); watcher.start(); watcher.update([OTHER]); assert.equal(sockets.length, 1); assert.deepEqual(hints, []);
});

test('Bitcoin Core uses no watcher transport', t => {
  const { watcher, sockets, clock } = fixture(t, { chainSource: { type: 'bitcoind', host: 'private', password: 'secret' } });
  watcher.start(); clock.advance(120000); assert.equal(sockets.length, 0); assert.equal(clock.timers.size, 0);
  assert.deepEqual(watcher.status, { status: 'stopped', error: null }); assert.equal(JSON.stringify(watcher.source).includes('secret'), false);
});

test('invalid backend URLs and bounds fail before opening transports', t => {
  for (const chainSource of [{ type: 'esplora', url: 'file:///tmp/state' }, { type: 'esplora', url: 'https://user:secret@host/api' }, { type: 'esplora', url: 'https://host/api?q=secret' }, { type: 'esplora', url: 'https://host/api#secret' }, { type: 'esplora', url: 'https://host/\napi' }, { type: 'electrum', url: 'tcp://user:secret@host:50001' }, { type: 'unknown' }]) assert.throws(() => fixture(t, { chainSource }), error => !error.message.includes('secret'));
  for (const options of [{ requestTimeout: 0 }, { reconnectMin: 3, reconnectMax: 2 }, { pollInterval: Infinity }, { onChange: null }, { network: 'unknown' }]) assert.throws(() => fixture(t, options));
});

test('Electrum sends no script hash until same-socket version and genesis checks both pass', t => {
  for (const network of Object.keys(parameters)) {
    const prefix = network === 'bitcoin' ? 'bc' : network === 'regtest' ? 'bcrt' : 'tb';
    const { watcher, sockets, hints } = fixture(t, { network, addresses: [address(1, prefix)] });
    watcher.start(); const socket = sockets[0]; socket.emit('connect');
    socket.send(response(2, header(network))); assert.equal(socket.sent.length, 2);
    const bytes = JSON.stringify(response(1, ['fixture', '1.4'])) + '\n';
    for (const character of bytes) socket.emit('data', Buffer.from(character));
    assert.equal(socket.sent.length, 3); assert.equal(socket.sent[2].method, 'blockchain.scripthash.subscribe');
    socket.send(response(3, HASH)); assert.deepEqual(hints, [[]]); assert.equal(watcher.status.status, 'watching');
  }
});

test('Electrum changes include null transitions and unchanged reconnects do not repeat hints', t => {
  const { watcher, sockets, hints, clock } = fixture(t); watcher.start(); handshake(sockets[0]);
  sockets[0].send(notification(null)); assert.equal(hints.length, 0);
  sockets[0].send(notification(HASH)); sockets[0].send(notification(HASH)); assert.equal(hints.length, 1);
  sockets[0].destroy(); clock.advance(1000); handshake(sockets[1], { status: HASH }); assert.equal(hints.length, 1);
  sockets[1].send(notification(NEXT_HASH)); sockets[1].send(notification(null)); assert.equal(hints.length, 3);
  watcher.update([ADDRESS, OTHER]); handshake(sockets[2]); assert.equal(hints.length, 3);
  sockets[2].send(notification(HASH, addressScriptHash(OTHER, 'regtest'))); assert.equal(hints.length, 4);
});

test('TLS preserves certificate verification and cannot disclose script hashes before secureConnect', t => {
  const { watcher, sockets, connections } = fixture(t, { chainSource: { type: 'electrum', url: 'ssl://node.local:50002' } });
  watcher.start(); assert.deepEqual(connections[0], { host: 'node.local', port: 50002, servername: 'node.local', rejectUnauthorized: true });
  sockets[0].emit('connect'); assert.equal(sockets[0].sent.length, 0);
  handshake(sockets[0], { tls: true }); assert.equal(watcher.status.status, 'watching');
  const ip = fixture(t, { chainSource: { type: 'electrum', url: 'ssl://[::1]:50002' } }); ip.watcher.start(); assert.equal(ip.connections[0].servername, undefined);
});

test('wrong genesis, malformed handshake and pre-handshake notifications never disclose addresses', async t => {
  for (const value of [response(2, header('bitcoin')), response(2, 'x'.repeat(160)), response(1, ['fixture', '1.5']), response(1, ['fixture', ['1.4']]), response(1, ['x'.repeat(257), '1.4']), response(99, null), [], { id: 1, error: { message: 'private attacker text' } }, notification(HASH)]) await t.test(JSON.stringify(value).slice(0, 55), t => {
    const { watcher, sockets, hints } = fixture(t); watcher.start(); sockets[0].emit('connect'); sockets[0].send(value);
    assert.equal(sockets[0].destroyed, true); assert.equal(sockets[0].sent.length, 2); assert.deepEqual(hints, []);
    assert.equal(watcher.status.error.includes('private'), false);
  });
});

test('malformed, oversized, duplicate and excessive Electrum frames fail closed', async t => {
  for (const attack of [
    socket => socket.emit('data', Buffer.from('not JSON\n')),
    socket => socket.emit('data', Buffer.alloc(4097, 32)),
    socket => socket.emit('data', Buffer.alloc(128 * 1024 + 1, 32)),
    socket => socket.send(response(3, null)),
    socket => socket.send(notification('bad status')),
    socket => socket.send(notification(HASH, 'f'.repeat(64))),
    socket => socket.send({ method: 'blockchain.scripthash.subscribe', params: [scriptHash, HASH, 'extra'] }),
    socket => socket.emit('data', Buffer.from((JSON.stringify(notification(null)) + '\n').repeat(129))),
  ]) await t.test(`attack ${attack.toString().slice(0, 60)}`, t => {
    const { watcher, sockets, hints } = fixture(t); watcher.start(); handshake(sockets[0]); attack(sockets[0]);
    assert.equal(sockets[0].destroyed, true); assert.equal(watcher.status.status, 'retrying'); assert.equal(hints.length, 0);
  });
});

test('request deadlines, keepalive and connection failures use bounded backoff', t => {
  const { watcher, sockets, clock } = fixture(t, { reconnectMin: 100, reconnectMax: 400, requestTimeout: 50, keepaliveInterval: 60 });
  watcher.start(); clock.advance(50); assert.equal(sockets[0].destroyed, true);
  clock.advance(100); assert.equal(sockets.length, 2); sockets[1].emit('error', new Error('private DNS diagnostics'));
  clock.advance(199); assert.equal(sockets.length, 2); clock.advance(1); assert.equal(sockets.length, 3); sockets[2].destroy();
  clock.advance(400); assert.equal(sockets.length, 4); handshake(sockets[3]);
  clock.advance(60); const ping = sockets[3].sent.at(-1); assert.equal(ping.method, 'server.ping'); sockets[3].send(response(ping.id, null));
  clock.advance(60); clock.advance(50); assert.equal(sockets[3].destroyed, true);
  clock.advance(100); assert.equal(sockets.length, 5);
});

test('closing cancels timers and ignores late socket responses, errors and reconnects', t => {
  const { watcher, sockets, clock, hints, statuses } = fixture(t); watcher.start(); handshake(sockets[0]);
  watcher.close(); const count = statuses.length;
  sockets[0].send(notification(HASH)); sockets[0].emit('error', new Error('late')); sockets[0].emit('error', new Error('later'));
  clock.advance(120000); assert.equal(sockets.length, 1); assert.equal(clock.timers.size, 0); assert.equal(hints.length, 0); assert.equal(statuses.length, count);
});

test('status callbacks may close the watcher without leaving a new connection or timer', t => {
  let watcher;
  const result = fixture(t, { onStatus: () => watcher.close() }); watcher = result.watcher;
  watcher.start(); assert.equal(result.sockets.length, 0); assert.equal(result.clock.timers.size, 0);
});

test('Esplora verifies genesis first, polls sequentially and fingerprints both stats sections', async t => {
  let count = 0; let chain = false;
  const { watcher, calls, hints, clock } = httpFixture(t, async url => {
    if (url.endsWith('/block-height/0')) return new Response(GENESIS + '\n');
    const value = stats(url.endsWith(OTHER) ? OTHER : ADDRESS, count);
    if (chain) { value.chain_stats = value.mempool_stats; value.mempool_stats = stats().chain_stats; }
    return json(value);
  }, { addresses: [ADDRESS, OTHER] });
  watcher.start(); await until(() => watcher.status.status === 'watching');
  assert.deepEqual(calls.map(call => call.url), ['https://node.local/api/block-height/0', `https://node.local/api/address/${ADDRESS}`, `https://node.local/api/address/${OTHER}`]);
  assert.equal(hints.length, 0);
  for (const call of calls) { assert.equal(call.init.redirect, 'error'); assert.equal(call.init.method, 'GET'); }
  count = 1; clock.advance(15000); await until(() => hints.length === 2 && watcher.status.status === 'watching');
  clock.advance(15000); await until(() => calls.length === 9 && watcher.status.status === 'watching'); assert.equal(hints.length, 2);
  chain = true; clock.advance(15000); await until(() => hints.length === 4 && watcher.status.status === 'watching');
  count = 0; clock.advance(15000); await until(() => hints.length === 6 && watcher.status.status === 'watching');
});

test('Esplora initial activity hints once and retries retain the fingerprint', async t => {
  let fail = false;
  const { watcher, hints, clock } = httpFixture(t, async url => {
    if (fail) throw new Error('private server diagnostics');
    return url.endsWith('/block-height/0') ? new Response(GENESIS) : json(stats(ADDRESS, 2));
  });
  watcher.start(); await until(() => watcher.status.status === 'watching'); assert.equal(hints.length, 1);
  fail = true; clock.advance(15000); await until(() => watcher.status.status === 'retrying');
  assert.equal(watcher.status.error.includes('private'), false);
  fail = false; clock.advance(1000); await until(() => watcher.status.status === 'watching'); assert.equal(hints.length, 1);
});

test('Esplora rejects wrong network and redirects before disclosing an address', async t => {
  for (const result of [() => new Response('0'.repeat(64)), () => new Response('', { status: 302, headers: { location: 'https://other.invalid' } }), () => Object.defineProperty(new Response(GENESIS), 'redirected', { value: true }), () => Object.defineProperty(new Response(GENESIS), 'url', { value: 'https://other.invalid' })]) await t.test('refused backend', async t => {
    const { watcher, calls, hints } = httpFixture(t, async () => result());
    watcher.start(); await until(() => watcher.status.status === 'retrying');
    assert.equal(calls.length, 1); assert.equal(hints.length, 0);
  });
});

test('Esplora rejects malformed or excessive stats without treating them as balances', async t => {
  const attacks = [
    () => new Response('{'), () => json([]), () => json({ ...stats(), address: OTHER }),
    () => json({ ...stats(), chain_stats: null }),
    () => json({ ...stats(), chain_stats: { ...stats().chain_stats, tx_count: -1 } }),
    () => json({ ...stats(), chain_stats: { ...stats().chain_stats, tx_count: '1' } }),
    () => json({ ...stats(), chain_stats: { ...stats().chain_stats, funded_txo_sum: Number.MAX_SAFE_INTEGER + 1 } }),
    () => new Response('x'.repeat(16 * 1024 + 1)),
    () => new Response('{}', { headers: { 'content-length': '20000' } }),
    () => new Response(Buffer.from([0xff])),
  ];
  for (const attack of attacks) await t.test(`stats ${attack.toString().slice(0, 65)}`, async t => {
    const { watcher, hints } = httpFixture(t, async url => url.endsWith('/block-height/0') ? new Response(GENESIS) : attack());
    watcher.start(); await until(() => watcher.status.status === 'retrying'); assert.equal(hints.length, 0);
  });
});

test('HTTP timeout aborts the request and close cancels a delayed response with no late callback', async t => {
  let held;
  const { watcher, clock, calls, hints } = httpFixture(t, (url, init) => new Promise((resolve, reject) => {
    held = { resolve, init }; init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { requestTimeout: 50 });
  watcher.start(); assert.equal(calls.length, 1); clock.advance(50); await until(() => watcher.status.status === 'retrying'); assert.equal(held.init.signal.aborted, true);
  clock.advance(1000); assert.equal(calls.length, 2); watcher.close(); assert.equal(held.init.signal.aborted, true);
  held.resolve(new Response(GENESIS)); await flush(); clock.advance(120000);
  assert.equal(calls.length, 2); assert.equal(hints.length, 0); assert.equal(clock.timers.size, 0);
});

test('address updates abort an active HTTP poll and wait for it to settle before starting another', async t => {
  let release; let requests = 0; let active = 0; let maximum = 0;
  const { watcher, calls, hints } = httpFixture(t, async url => {
    requests++; active++; maximum = Math.max(maximum, active);
    try {
      if (requests === 1) await new Promise(resolve => { release = resolve; });
      return url.endsWith('/block-height/0') ? new Response(GENESIS) : json(stats(OTHER, 1));
    } finally { active--; }
  });
  watcher.start(); const firstSignal = calls[0].init.signal;
  watcher.update([OTHER]); assert.equal(firstSignal.aborted, true); assert.equal(calls.length, 1);
  release(); await until(() => watcher.status.status === 'watching');
  assert.equal(maximum, 1); assert.equal(hints.length, 1);
  assert.deepEqual(calls.map(call => call.url), ['https://node.local/api/block-height/0', 'https://node.local/api/block-height/0', `https://node.local/api/address/${OTHER}`]);
});

test('synchronous socket failures and consumer callback rejection are contained', async t => {
  const { watcher, clock } = fixture(t, { connectTcp: () => { throw new Error('secret connection details'); } });
  watcher.start(); assert.equal(watcher.status.status, 'retrying'); assert.equal(clock.timers.size, 1); assert.equal(watcher.status.error.includes('secret'), false);
  const callback = fixture(t, { onChange: async () => { throw new Error('consumer failure'); }, onStatus: () => { throw new Error('status failure'); } });
  callback.watcher.start(); handshake(callback.sockets[0], { status: HASH }); await flush(); assert.equal(callback.watcher.status.status, 'watching');
});

test('Esplora status consumers can close after success without leaving a poll timer', async t => {
  const { watcher, clock, calls } = httpFixture(t, async url => url.endsWith('/block-height/0') ? new Response(GENESIS) : json(stats()));
  watcher.onStatus = status => { if (status.status === 'watching') watcher.close(); };
  watcher.start(); await until(() => watcher.closed);
  assert.equal(clock.timers.size, 0); clock.advance(120000); assert.equal(calls.length, 2);
});

test('real Electrum TCP transport handles fragmented replies and subscription notifications', { timeout: 5000 }, async t => {
  const sockets = new Set(); const requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk; let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); requests.push(request.method);
        const result = request.method === 'server.version' ? ['fixture', '1.4'] : request.method === 'blockchain.block.header' ? header() : null;
        const bytes = JSON.stringify(response(request.id, result)) + '\n';
        socket.write(bytes.slice(0, 7)); socket.write(bytes.slice(7));
        if (request.method === 'blockchain.scripthash.subscribe') socket.write(JSON.stringify(notification(HASH)) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let notify; const changed = new Promise(resolve => { notify = resolve; });
  const watcher = new ReceiveWatcher({ chainSource: { type: 'electrum', url: `tcp://127.0.0.1:${server.address().port}` }, network: 'regtest', addresses: [ADDRESS], onChange: notify });
  t.after(async () => { watcher.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  watcher.start(); await changed;
  assert.deepEqual(requests, ['server.version', 'blockchain.block.header', 'blockchain.scripthash.subscribe']);
  assert.equal(watcher.status.status, 'watching');
});

test('real Esplora HTTP transport reads streamed JSON and never follows a redirect', { timeout: 5000 }, async t => {
  let redirected = false; const paths = []; const statsReply = stats(ADDRESS, 1);
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    if (redirected) { response.writeHead(302, { location: '/unexpected-target' }); response.end(); return; }
    if (request.url.endsWith('/block-height/0')) { response.end(GENESIS); return; }
    const bytes = JSON.stringify(statsReply); response.write(bytes.slice(0, 9)); response.end(bytes.slice(9));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const events = []; let first;
  const changed = new Promise(resolve => { first = resolve; });
  const watcher = new ReceiveWatcher({ chainSource: { type: 'esplora', url: `http://127.0.0.1:${server.address().port}/api` }, network: 'regtest', addresses: [ADDRESS], onChange: () => { events.push('change'); first(); }, pollInterval: 10 });
  t.after(async () => { watcher.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  watcher.start(); await changed; redirected = true;
  await new Promise(resolve => {
    watcher.onStatus = status => { if (status.status === 'retrying') resolve(); };
  });
  assert.deepEqual(events, ['change']); assert.equal(paths.some(value => value === '/unexpected-target'), false);
  assert.deepEqual(paths.slice(0, 2), ['/api/block-height/0', `/api/address/${ADDRESS}`]);
});
