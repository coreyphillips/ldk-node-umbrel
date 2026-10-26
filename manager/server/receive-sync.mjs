/**
 * Convert untrusted address-change hints into bounded authoritative native syncs.
 * One scheduler belongs to one running process generation. NativeProcess retains
 * sync admission across RPC timeouts until an actual response or process exit.
 */
export class ReceiveSync {
  constructor({ process, active, interval = 15000, settleDelay = 2000, retryDelay = 30000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { process, active, interval, settleDelay, retryDelay, now, setTimer, clearTimer });
    this.dirty = false; this.closed = false; this.timer = null; this.lastStart = process.syncPending ? this.now() : -Infinity; this.lastFinish = -Infinity;
    this.notBefore = -Infinity; this.retries = 0;
    this.started = () => { this.lastStart = this.now(); };
    this.settled = () => { this.lastFinish = this.now(); this.schedule(); };
    process.on('sync_started', this.started); process.on('sync_settled', this.settled);
  }
  hint() {
    if (this.closed || !this.active()) return;
    this.dirty = true; this.retries = 0; this.schedule();
  }
  schedule() {
    if (this.closed || !this.active() || !this.dirty || this.timer !== null || this.process.syncPending) return;
    const delay = Math.max(0, this.lastStart + this.interval - this.now(), this.lastFinish + this.settleDelay - this.now(), this.notBefore - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.closed || !this.active() || !this.dirty || this.process.syncPending) return;
      if (Math.max(this.lastStart + this.interval, this.lastFinish + this.settleDelay, this.notBefore) > this.now()) { this.schedule(); return; }
      this.dirty = false; this.lastStart = this.now();
      this.process.call('sync', {}).catch(() => {
        // A short bounded retry covers transient backend failures. Native
        // periodic scanning remains the fallback after these attempts.
        if (!this.closed && this.active() && this.retries++ < 2) {
          this.dirty = true; this.notBefore = this.now() + this.retryDelay;
        }
      }).finally(() => this.schedule());
    }, delay);
    this.timer?.unref?.();
  }
  close() {
    this.closed = true; this.dirty = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.process.off('sync_started', this.started); this.process.off('sync_settled', this.settled);
  }
}
