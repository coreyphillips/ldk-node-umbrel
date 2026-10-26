import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeProcess } from './rpc.mjs';

function fixture(t, options = {}) {
  const writes = [];
  const native = new NativeProcess({ binary: '/unused', config: '/unused', timeout: 1000, ...options });
  native.child = { stdin: { write(line, callback) { writes.push(JSON.parse(line)); callback?.(); } }, kill() {} };
  t.after(() => native.finish());
  const reply = (request, result = {}, error) => native.consume(`${JSON.stringify({ id: request.id, result, error })}\n`);
  return { native, writes, reply };
}

test('manual and automatic sync callers share one native request and one outcome', async t => {
  const { native, writes, reply } = fixture(t);
  const events = []; native.on('sync_started', () => events.push('start')); native.on('sync_settled', () => events.push('settled'));
  const first = native.call('sync'); const duplicate = native.call('sync');
  assert.equal(duplicate, first); assert.equal(writes.length, 1); assert.equal(native.pending.size, 1);
  reply(writes[0], { synchronized: true });
  assert.deepEqual(await first, { synchronized: true }); assert.deepEqual(await duplicate, { synchronized: true });
  assert.equal(native.syncPending, null); assert.deepEqual(events, ['start', 'settled']);
  const next = native.call('sync'); assert.equal(writes.length, 2); reply(writes[1]); await next;
});

test('a timed out sync retains admission until its actual late response', async t => {
  const { native, writes, reply } = fixture(t, { timeout: 10 });
  const first = native.call('sync'); await assert.rejects(first, { code: 'OUTCOME_UNKNOWN' });
  assert.equal(native.pending.size, 1); assert.equal(native.call('sync'), first); assert.equal(writes.length, 1);
  const balance = native.call('balance'); reply(writes[1], { total: 42 }); assert.deepEqual(await balance, { total: 42 });
  reply(writes[0]); assert.equal(native.syncPending, null); assert.equal(native.pending.size, 0);
  const second = native.call('sync'); assert.equal(writes.length, 3); reply(writes[2]); await second;
});

test('a native sync error releases its slot and keeps its safe error outcome', async t => {
  const { native, writes, reply } = fixture(t);
  const first = native.call('sync'); const rejected = assert.rejects(first, { code: 'CHAIN_UNAVAILABLE' });
  reply(writes[0], undefined, { message: 'Chain unavailable', code: 'CHAIN_UNAVAILABLE' }); await rejected;
  assert.equal(native.syncPending, null); const second = native.call('sync'); reply(writes[1]); await second;
});

for (const synchronous of [false, true]) test(`uncertain ${synchronous ? 'thrown' : 'callback'} writes cannot admit another sync`, async t => {
  const { native, writes } = fixture(t);
  native.child.stdin.write = (line, callback) => { writes.push(JSON.parse(line)); if (synchronous) throw new Error('stream failed'); callback(new Error('stream failed')); };
  const first = native.call('sync'); await assert.rejects(first, { code: 'OUTCOME_UNKNOWN' });
  assert.equal(native.call('sync'), first); assert.equal(writes.length, 1); assert.equal(native.pending.size, 1);
  native.finish(); assert.equal(native.syncPending, null); assert.equal(native.pending.size, 0);
  await assert.rejects(native.call('sync'), { code: 'NODE_STOPPED' });
});

test('ordinary read timeouts release their slots while sync still counts against the request cap', async t => {
  const { native, writes, reply } = fixture(t, { timeout: 15 });
  const sync = native.call('sync'); const syncFailure = assert.rejects(sync, { code: 'OUTCOME_UNKNOWN' });
  const reads = Array.from({ length: 31 }, () => native.call('balance').catch(error => error.code));
  await assert.rejects(native.call('balance'), { code: 'NODE_BUSY' }); assert.equal(native.call('sync'), sync);
  assert.equal(writes.length, 32); assert.deepEqual(new Set(await Promise.all(reads)), new Set(['OUTCOME_UNKNOWN'])); await syncFailure;
  assert.equal(native.pending.size, 1); reply(writes[0]); assert.equal(native.pending.size, 0);
});

test('native exit rejects the shared sync once and clears its retained slot', async t => {
  const { native } = fixture(t); let exits = 0; native.on('exit', () => exits++);
  const first = native.call('sync'); const rejected = assert.rejects(first, { code: 'OUTCOME_UNKNOWN' });
  native.finish(); native.finish(); await rejected;
  assert.equal(exits, 1); assert.equal(native.syncPending, null); assert.equal(native.pending.size, 0);
});
