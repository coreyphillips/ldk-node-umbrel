import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ReceiveSync } from './receive-sync.mjs';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Event ordering matches NativeProcess: admission precedes sync_started, and
// the actual reply clears admission and emits sync_settled before resolving.
// Client timeout rejects the shared promise without releasing that admission.
class ProcessFixture extends EventEmitter {
  constructor(clock) { super(); this.clock = clock; this.syncPending = null; this.starts = []; }
  call(method) {
    assert.equal(method, 'sync');
    if (this.syncPending) return this.syncPending.promise;
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.syncPending = { promise, resolve, reject };
    this.starts.push(this.clock.now()); this.emit('sync_started'); return promise;
  }
  timeout() { assert.ok(this.syncPending); this.syncPending.reject(new Error('client timeout')); }
  reply(error) {
    const pending = this.syncPending; assert.ok(pending); this.syncPending = null; this.emit('sync_settled');
    if (error) pending.reject(error); else pending.resolve({ synced: true });
  }
}

function clockFixture() {
  let now = 0; let next = 0; const timers = new Map();
  return {
    now: () => now,
    setTimer(action, delay) {
      assert.ok(Number.isFinite(delay) && delay >= 0);
      const timer = { id: ++next, unref() {} }; timers.set(timer, { at: now + delay, action }); return timer;
    },
    clearTimer: timer => timers.delete(timer),
    count: () => timers.size,
    async advance(milliseconds) {
      const end = now + milliseconds; await flush(); let count = 0;
      for (;;) {
        const entry = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0].id - b[0].id)[0];
        if (!entry) break;
        assert.ok(++count < 1000, 'timer progress remains bounded');
        timers.delete(entry[0]); now = entry[1].at; entry[1].action(); await flush();
      }
      now = end; await flush();
    },
  };
}

function fixture(t, options = {}) {
  const clock = clockFixture(); const process = new ProcessFixture(clock); let active = true;
  const watcher = new ReceiveSync({ process, active: () => active, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options });
  t.after(() => watcher.close());
  return { clock, process, watcher, deactivate: () => { active = false; } };
}

test('a burst of hints admits one sync and one pending refresh', async t => {
  const { clock, process, watcher } = fixture(t);
  for (let i = 0; i < 100; i++) watcher.hint();
  assert.equal(clock.count(), 1); await clock.advance(0); assert.deepEqual(process.starts, [0]);
  for (let i = 0; i < 100; i++) watcher.hint();
  assert.equal(clock.count(), 0); await clock.advance(1000); process.reply(); await flush();
  assert.equal(clock.count(), 1); await clock.advance(13999); assert.deepEqual(process.starts, [0]);
  await clock.advance(1); assert.deepEqual(process.starts, [0, 15000]);
  process.reply(); await clock.advance(60000); assert.deepEqual(process.starts, [0, 15000]);
});

test('a quiet successful sync schedules no periodic native work', async t => {
  const { clock, process, watcher } = fixture(t);
  watcher.hint(); await clock.advance(0); process.reply(); await clock.advance(300000);
  assert.deepEqual(process.starts, [0]); assert.equal(clock.count(), 0);
});

test('a long sync leaves the completion drain interval before a queued hint', async t => {
  const { clock, process, watcher } = fixture(t);
  watcher.hint(); await clock.advance(0); watcher.hint(); await clock.advance(20000); process.reply();
  await clock.advance(1999); assert.deepEqual(process.starts, [0]);
  await clock.advance(1); assert.deepEqual(process.starts, [0, 22000]); process.reply();
});

test('manual synchronization holds the same admission and supplies rate-spacing events', async t => {
  const { clock, process, watcher } = fixture(t);
  const manual = process.call('sync'); watcher.hint(); watcher.hint();
  assert.equal(clock.count(), 0); await clock.advance(1000); process.reply(); await manual;
  await clock.advance(13999); assert.deepEqual(process.starts, [0]);
  await clock.advance(1); assert.deepEqual(process.starts, [0, 15000]);
  const joined = process.call('sync'); assert.equal(joined, process.syncPending.promise);
  process.reply(); await joined;
});

test('manual sync starting during an automatic timer cannot admit overlapping work', async t => {
  const { clock, process, watcher } = fixture(t);
  watcher.hint(); await clock.advance(0); process.reply(); watcher.hint();
  await clock.advance(1000); const manual = process.call('sync');
  await clock.advance(14000); assert.deepEqual(process.starts, [0, 1000]); assert.equal(clock.count(), 0);
  process.reply(); await manual; await clock.advance(1999); assert.deepEqual(process.starts, [0, 1000]);
  await clock.advance(1); assert.deepEqual(process.starts, [0, 1000, 17000]); process.reply();
});

test('attaching to an existing native sync lease conservatively retains start spacing', async t => {
  const clock = clockFixture(); const process = new ProcessFixture(clock); const manual = process.call('sync');
  const watcher = new ReceiveSync({ process, active: () => true, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  t.after(() => watcher.close()); watcher.hint(); await clock.advance(1000); process.reply(); await manual;
  await clock.advance(13999); assert.deepEqual(process.starts, [0]);
  await clock.advance(1); assert.deepEqual(process.starts, [0, 15000]); process.reply();
});

test('a rejected client timeout retains admission until the actual native reply', async t => {
  const { clock, process, watcher } = fixture(t);
  watcher.hint(); await clock.advance(0); const lease = process.syncPending;
  process.timeout(); await flush(); assert.equal(process.syncPending, lease);
  assert.equal(process.call('sync'), lease.promise); await assert.rejects(lease.promise, /client timeout/);
  watcher.hint(); await clock.advance(60000); assert.deepEqual(process.starts, [0]); assert.equal(clock.count(), 0);
  process.reply(); await clock.advance(1999); assert.deepEqual(process.starts, [0]);
  await clock.advance(1); assert.deepEqual(process.starts, [0, 62000]); process.reply();
});

test('a native error backs off and stops after two retries without a fresh hint', async t => {
  const { clock, process, watcher } = fixture(t);
  watcher.hint(); await clock.advance(0); process.reply(new Error('backend unavailable'));
  await clock.advance(29999); assert.deepEqual(process.starts, [0]);
  await clock.advance(1); assert.deepEqual(process.starts, [0, 30000]); process.reply(new Error('backend unavailable'));
  await clock.advance(30000); assert.deepEqual(process.starts, [0, 30000, 60000]); process.reply(new Error('backend unavailable'));
  await clock.advance(300000); assert.deepEqual(process.starts, [0, 30000, 60000]); assert.equal(clock.count(), 0);
  watcher.hint(); await clock.advance(0); assert.deepEqual(process.starts, [0, 30000, 60000, 360000]); process.reply();
});

test('error backoff survives a timer scheduled by sync_settled before promise rejection', async t => {
  const { clock, process, watcher } = fixture(t);
  watcher.hint(); await clock.advance(0); watcher.hint(); process.reply(new Error('backend unavailable'));
  assert.equal(clock.count(), 1); await clock.advance(15000); assert.deepEqual(process.starts, [0]);
  await clock.advance(14999); assert.deepEqual(process.starts, [0]);
  await clock.advance(1); assert.deepEqual(process.starts, [0, 30000]); process.reply();
});

test('closing before admission clears the timer and detaches native listeners', async t => {
  const { clock, process, watcher } = fixture(t);
  watcher.hint(); watcher.close(); watcher.close(); watcher.hint();
  assert.equal(clock.count(), 0); assert.equal(process.listenerCount('sync_started'), 0); assert.equal(process.listenerCount('sync_settled'), 0);
  await clock.advance(300000); assert.deepEqual(process.starts, []);
});

test('closing during native work prevents late failures or replies from restarting work', async t => {
  const { clock, process, watcher } = fixture(t);
  watcher.hint(); await clock.advance(0); watcher.hint(); watcher.close(); process.timeout(); await flush(); process.reply();
  await clock.advance(300000); assert.deepEqual(process.starts, [0]); assert.equal(clock.count(), 0);
});

test('runtime invalidation suppresses queued work and later hints', async t => {
  const { clock, process, watcher, deactivate } = fixture(t);
  watcher.hint(); deactivate(); await clock.advance(0); watcher.hint(); await clock.advance(300000);
  assert.deepEqual(process.starts, []); assert.equal(clock.count(), 0);
});

test('runtime invalidation while a sync fails prevents retry admission', async t => {
  const { clock, process, watcher, deactivate } = fixture(t);
  watcher.hint(); await clock.advance(0); deactivate(); process.reply(new Error('backend unavailable'));
  await clock.advance(300000); assert.deepEqual(process.starts, [0]); assert.equal(clock.count(), 0);
});
