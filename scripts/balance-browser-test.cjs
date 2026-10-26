// Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core package.
// Real HTTP authentication and QR generation, synthetic balances and payments.
// No native node, wallet, funds or remote service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const QRCode = require('../manager/node_modules/qrcode');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'disposable-balance-browser-password';
const ADDRESS = 'bcrt1qdisposablefixtureaddressnotusedforfunds';
const INVOICE = 'lnbcrt1syntheticinvoicewithoutrealpayment';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check, message, limit = 15000) { const end = Date.now() + limit; while (!await check()) { if (Date.now() > end) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); } }
function fixture() {
  return {
    wallets: [A, B].map((id, index) => ({ id, name: 'Balance fixture ' + (index + 1), network: 'regtest', status: 'running', recovery_kind: 'legacy_seed', chain_source: { type: 'electrum' }, autostart: false, chicory: { enabled: false, offline_enabled: false, max_total_fronted_sats: 1000000 }, iroh: { enabled: false }, tor: { enabled: false } })),
    balances: { [A]: { onchain_total_sats: 0, onchain_spendable_sats: 0, lightning_total_sats: 0 }, [B]: { onchain_total_sats: 9000, onchain_spendable_sats: 9000, lightning_total_sats: 0 } },
    calls: [], reads: {}, concurrent: {}, maximum: {}, holds: new Map(), failures: new Map(), listReads: 0,
    payments: [{ id: 'historical', direction: 'inbound', status: 'succeeded', kind: 'onchain', amount_msat: 1000000, updated_at: 1 }],
  };
}
(async () => {
  const root = path.resolve(__dirname, '..');
  const { Authentication } = await import(path.join(root, 'manager/server/auth.mjs'));
  const { createServer } = await import(path.join(root, 'manager/server/index.mjs'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-balance-browser-'));
  const auth = new Authentication({ dataDir: directory }); await auth.initialize(undefined, PASSWORD);
  let state = fixture(); const gates = [];
  const hold = (method, id = A) => { const gate = { started: deferred(), release: deferred(), finished: deferred() }; state.holds.set(`${id}/${method}`, gate); gates.push(gate.release); return gate; };
  const manager = {
    list: () => { state.listReads++; return structuredClone(state.wallets); },
    call: async (id, method, params) => {
      const current = state; const key = `${id}/${method}`;
      current.calls.push({ id, method, params }); current.reads[key] = (current.reads[key] || 0) + 1;
      current.concurrent[key] = (current.concurrent[key] || 0) + 1; current.maximum[key] = Math.max(current.maximum[key] || 0, current.concurrent[key]);
      const waiting = current.holds.get(key); current.holds.delete(key);
      const failure = current.failures.get(key);
      let result;
      if (method === 'info') result = { node_id: '02' + 'ab'.repeat(32), best_block_height: 100, capabilities: ['address', 'invoice'] };
      else if (method === 'balance') result = structuredClone(current.balances[id]);
      else if (method === 'address') result = { address: ADDRESS };
      else if (method === 'invoice') result = { invoice: INVOICE };
      else if (method === 'payments') result = structuredClone(current.payments);
      else if (method === 'offline_status') result = { epochs: [] };
      else if (['channels', 'peers', 'events'].includes(method)) result = [];
      else throw new Error(`Unexpected fixture RPC: ${method}`);
      try { if (waiting) { waiting.started.resolve(); await waiting.release.promise; } if (failure) throw Object.assign(new Error(failure), { status: 503, code: 'FIXTURE_UNAVAILABLE' }); return result; }
      finally { current.concurrent[key]--; waiting?.finished.resolve(); }
    },
  };
  const server = createServer({ auth, wallets: manager, allowedHosts: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser; const checks = []; const errors = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(() => {
        const interval = window.setInterval;
        const timeout = window.setTimeout; window.fixtureNativeDeadlines = [];
        window.setTimeout = (fn, ms, ...args) => { if (ms === 65000) window.fixtureNativeDeadlines.push({ ms, expire: () => fn(...args) }); return timeout(fn, ms, ...args); };
        window.setInterval = (fn, ms, ...args) => { const id = interval(fn, ms, ...args); if (ms === 5000) window.balancePoll = { id, fn }; return id; };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.fixtureCopied = value; } } });
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      let qrFailure = false; let qrHeld = null; let balanceHttpHeld = null; const qrRequests = [];
      await page.route('**/api/wallets/*/balance', async route => {
        if (!balanceHttpHeld) { await route.continue(); return; }
        const waiting = balanceHttpHeld; balanceHttpHeld = null; waiting.started.resolve(); await waiting.release.promise;
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic old session expiry' } }) }); waiting.finished.resolve();
      });
      await page.route('**/api/wallets/*/qr', async route => {
        qrRequests.push({ url: route.request().url(), text: route.request().postDataJSON().text });
        if (qrFailure) { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic QR outage' } }) }); return; }
        if (qrHeld) { const waiting = qrHeld; qrHeld = null; const response = await route.fetch(); waiting.started.resolve(); await waiting.release.promise; await route.fulfill({ response }); waiting.finished.resolve(); return; }
        await route.continue();
      });
      const value = () => page.locator('.stat').first().locator('.value').innerText();
      const dialog = () => page.locator('#dialog');
      const reads = (method = 'balance', id = A) => state.reads[`${id}/${method}`] || 0;
      const poll = () => page.evaluate(() => window.balancePoll.fn());
      const pauseTimer = () => page.evaluate(() => clearInterval(window.balancePoll.id));
      const settle = () => until(() => Object.values(state.concurrent).every(count => count === 0), 'Fixture reads did not settle');
      const login = async () => { await page.getByLabel('Dashboard password', { exact: true }).fill(PASSWORD); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('heading', { name: 'A native home for your Bitcoin.', exact: true }).waitFor(); };
      const fresh = async () => {
        for (const gate of gates) gate.resolve(); qrHeld = null; qrFailure = false; state = fixture();
        await page.goto(origin); await page.locator('form input[type="password"], .wallet-row .name-button').first().waitFor();
        if (await page.getByLabel('Dashboard password', { exact: true }).isVisible()) await login();
        await page.getByRole('button', { name: 'Balance fixture 1', exact: true }).click();
        await until(async () => (await value()).startsWith('0'), 'Initial balance missing'); await settle(); await pauseTimer();
      };
      const openReceive = async (rail = 'onchain') => {
        await page.getByRole('button', { name: 'Receive', exact: true }).click();
        await page.getByLabel('Payment network', { exact: true }).selectOption(rail);
        if (rail === 'lightning') await page.getByLabel('Amount (sats)', { exact: true }).fill('321');
      };
      const createReceive = async (rail = 'onchain') => {
        await openReceive(rail); await page.getByRole('button', { name: 'Create request', exact: true }).click();
        await page.getByRole('heading', { name: rail === 'onchain' ? 'Your Bitcoin address' : 'Your Lightning invoice', exact: true }).waitFor();
        await dialog().locator('img.qr').evaluate(image => image.decode()); await settle();
      };
      const choose = async id => page.getByLabel('Select wallet', { exact: true }).evaluate((select, id) => { select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); }, id);
      const recordStable = async () => {
        await dialog().locator('button').filter({ hasText: /^Copy$/ }).focus();
        await dialog().locator('.copy-value code').evaluate(code => {
          window.balanceQr = document.querySelector('#dialog img.qr'); window.balanceCode = code;
          const range = document.createRange(); range.selectNodeContents(code); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          window.balanceSelected = selection.toString(); window.balanceFocus = document.activeElement;
          document.querySelector('#dialog').scrollTop = 40; window.balanceScroll = document.querySelector('#dialog').scrollTop;
        });
      };
      const assertStable = async () => assert.deepEqual(await page.evaluate(() => ({ qr: window.balanceQr === document.querySelector('#dialog img.qr'), code: window.balanceCode === document.querySelector('#dialog .copy-value code'), selection: getSelection().toString() === window.balanceSelected, focus: document.activeElement === window.balanceFocus, scroll: document.querySelector('#dialog').scrollTop === window.balanceScroll })), { qr: true, code: true, selection: true, focus: true, scroll: true });

      await fresh(); await createReceive(); await recordStable();
      assert.equal(await dialog().locator('.receive-change').innerText(), '');
      assert.match(await dialog().innerText(), /do not confirm payment of this request/);
      state.balances[A].onchain_total_sats = 23456; state.balances[A].onchain_spendable_sats = 23000;
      const beforeNatural = reads(); const listsBefore = state.listReads;
      await page.evaluate(() => { window.balancePoll.id = setInterval(window.balancePoll.fn, 5000); });
      await until(async () => (await value()).startsWith('23,456'), 'Natural receive polling did not apply incoming balance', 8000);
      await pauseTimer(); assert.ok(reads() > beforeNatural); assert.ok(state.listReads > listsBefore);
      await until(async () => (await dialog().locator('.receive-balance').innerText()).includes('23,456'), 'Receive balance missing');
      assert.match(await dialog().locator('.receive-change').innerText(), /Wallet balance changed/); await assertStable();
      assert.equal(reads('address'), 1); assert.equal(reads('invoice'), 0);
      assert.equal(await dialog().locator('img.qr').getAttribute('src'), await QRCode.toDataURL(ADDRESS, { width: 320, margin: 2, errorCorrectionLevel: 'M' }));
      await dialog().getByRole('button', { name: 'Copy', exact: true }).click(); assert.equal(await page.evaluate(() => window.fixtureCopied), ADDRESS);
      if (process.env.BALANCE_SCREENSHOTS) { await fs.mkdir(process.env.BALANCE_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.BALANCE_SCREENSHOTS, `receive-balance-${viewport.width}.png`) }); }
      checks.push(`${viewport.width}: natural five-second polling applies incoming on-chain balance through the receive modal with stable QR, focus, selection and scroll`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#dialog').scrollWidth <= document.querySelector('#dialog').clientWidth), true);
      checks.push(`${viewport.width}: historical incoming payment does not mark this request paid; QR and Copy match the generated request without overflow`);

      const slow = hold('payments'); state.balances[A].onchain_total_sats = 34567; await poll(); await slow.started.promise;
      await until(async () => (await value()).startsWith('34,567'), 'Secondary RPC blocked balance');
      const slowReadCount = reads('payments'); state.balances[A].onchain_total_sats = 45678;
      await poll(); await until(async () => (await value()).startsWith('45,678'), 'Next balance poll blocked behind activity');
      assert.equal(reads('payments'), slowReadCount); assert.equal(state.maximum[`${A}/payments`], 1);
      slow.release.resolve(); await settle();
      checks.push(`${viewport.width}: a held payments read does not delay fresh balances or overlap the same resource`);

      state.failures.set(`${A}/balance`, 'Synthetic balance outage'); await poll();
      await until(async () => (await dialog().locator('.receive-status').innerText()).includes('may be outdated'), 'Stale balance status missing');
      assert.match(await value(), /^45,678/); assert.equal(reads('address'), 1);
      state.failures.delete(`${A}/balance`); state.balances[A].onchain_total_sats = 56789; await poll();
      await until(async () => (await value()).startsWith('56,789'), 'Balance retry failed');
      assert.equal((await dialog().locator('.receive-status').innerText()).includes('outdated'), false);
      checks.push(`${viewport.width}: transient balance failure retains last good sats and clears stale status after a successful retry`);

      const resumeBefore = reads(); state.balances[A].onchain_total_sats = 67890; await recordStable();
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.fixtureVisibility }); window.fixtureVisibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
      assert.match(await dialog().locator('.receive-status').innerText(), /paused/); assert.equal(await dialog().isVisible(), true);
      await poll(); assert.equal(reads(), resumeBefore);
      await page.evaluate(() => { window.fixtureVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
      await until(async () => (await value()).startsWith('67,890'), 'Resume events did not refresh'); await settle(); await page.waitForTimeout(150);
      assert.equal(reads(), resumeBefore + 1); await assertStable();
      checks.push(`${viewport.width}: backgrounding preserves the public request and visible, focus and online resume as one immediate refresh`);

      state.wallets[0].status = 'stopped'; await poll();
      await until(async () => (await dialog().locator('.receive-status').innerText()).includes('Wallet stopped'), 'Stopped status missing');
      const stoppedReads = reads(); await poll(); assert.equal(reads(), stoppedReads);
      state.wallets[0].status = 'running'; state.balances[A].onchain_total_sats = 78901; await poll();
      await until(async () => (await dialog().locator('.receive-balance').innerText()).includes('78,901'), 'Restart did not resume balance');
      assert.equal(reads('address'), 1); await assertStable();
      checks.push(`${viewport.width}: stopping pauses reads and restarting resumes the same public request without generating another address`);

      await dialog().getByRole('button', { name: 'Done', exact: true }).click(); await settle();
      await createReceive('lightning'); assert.equal(reads('invoice'), 1);
      assert.deepEqual(state.calls.find(call => call.method === 'invoice').params, { amount_msat: 321000, description: 'Wallet receive', expiry_secs: 3600 });
      assert.equal(await dialog().locator('img.qr').getAttribute('src'), await QRCode.toDataURL(INVOICE, { width: 320, margin: 2, errorCorrectionLevel: 'M' }));
      state.balances[A].lightning_total_sats = 321; await poll(); await until(async () => (await dialog().locator('.receive-balance').innerText()).includes('Lightning wallet balance: 321'), 'Lightning balance not applied');
      assert.equal(reads('invoice'), 1); assert.match(await dialog().innerText(), /do not confirm payment/);
      checks.push(`${viewport.width}: Lightning receives update the wallet balance without recreating or claiming payment of the invoice`);

      await fresh(); qrFailure = true; await openReceive(); await page.getByRole('button', { name: 'Create request', exact: true }).click();
      await dialog().getByRole('button', { name: 'Retry QR code', exact: true }).waitFor();
      assert.equal(await dialog().locator('.copy-value code').innerText(), ADDRESS); await dialog().getByRole('button', { name: 'Copy', exact: true }).click(); assert.equal(await page.evaluate(() => window.fixtureCopied), ADDRESS);
      qrFailure = false; await dialog().getByRole('button', { name: 'Retry QR code', exact: true }).click(); await dialog().locator('img.qr').evaluate(image => image.decode()); assert.equal(reads('address'), 1);
      checks.push(`${viewport.width}: QR errors preserve the request and Copy; QR retry never generates another address`);

      for (const rail of ['onchain', 'lightning']) {
        await fresh(); const method = rail === 'onchain' ? 'address' : 'invoice'; const late = hold(method); await openReceive(rail);
        await page.getByRole('button', { name: 'Create request', exact: true }).click(); await late.started.promise;
        await dialog().locator('form').dispatchEvent('submit'); assert.equal(reads(method), 1);
        const qrBefore = qrRequests.length; await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await choose(B);
        late.release.resolve(); await late.finished.promise; await settle(); await page.waitForTimeout(100);
        assert.equal(await dialog().isVisible(), false); assert.equal(qrRequests.length, qrBefore); assert.equal(await page.getByLabel('Select wallet', { exact: true }).inputValue(), B);
      }
      checks.push(`${viewport.width}: delayed address and invoice replies after Cancel and wallet navigation cannot reopen the modal or issue a QR request`);

      await fresh(); qrHeld = { started: deferred(), release: deferred(), finished: deferred() }; const lateQr = qrHeld; gates.push(lateQr.release);
      await openReceive(); await page.getByRole('button', { name: 'Create request', exact: true }).click(); await lateQr.started.promise;
      assert.ok(qrRequests.at(-1).url.includes(`/wallets/${A}/qr`)); await dialog().getByRole('button', { name: 'Done', exact: true }).click(); await openReceive('lightning');
      lateQr.release.resolve(); await lateQr.finished.promise; assert.equal(await page.getByRole('heading', { name: 'Receive Bitcoin', exact: true }).isVisible(), true); assert.equal(await dialog().locator('img.qr').count(), 0);
      checks.push(`${viewport.width}: delayed QR results keep their captured wallet and cannot replace a newer receive form`);

      await fresh(); const oldBalance = hold('balance'); state.balances[A].onchain_total_sats = 999999; await poll(); await oldBalance.started.promise;
      await choose(B); await until(async () => (await value()).startsWith('9,000'), 'Sibling balance missing'); oldBalance.release.resolve(); await oldBalance.finished.promise; await page.waitForTimeout(100); assert.match(await value(), /^9,000/);
      checks.push(`${viewport.width}: a delayed balance response cannot overwrite a newly selected wallet`);

      await fresh(); const oldSession = hold('address'); await openReceive(); await page.getByRole('button', { name: 'Create request', exact: true }).click(); await oldSession.started.promise;
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true, includeHidden: true }).evaluate(control => control.click()); await login();
      await page.getByRole('button', { name: 'Balance fixture 2', exact: true }).click(); const oldSessionQr = qrRequests.length;
      oldSession.release.resolve(); await oldSession.finished.promise; await page.waitForTimeout(100);
      assert.equal(await dialog().isVisible(), false); assert.equal(qrRequests.length, oldSessionQr); assert.equal(await page.getByLabel('Select wallet', { exact: true }).inputValue(), B);
      checks.push(`${viewport.width}: a prior-session receive response cannot alter a newer login`);

      await fresh(); await openReceive(); await page.getByLabel('Description', { exact: true }).fill('Keep this draft'); await page.getByLabel('Amount (sats)', { exact: true }).fill('100');
      const formNode = await dialog().locator('form').elementHandle(); state.balances[A].onchain_total_sats = 42; await poll(); await until(async () => (await value()).startsWith('42'), 'Form-open balance not applied');
      assert.equal(await formNode.evaluate(node => node === document.querySelector('#dialog form')), true); assert.equal(await page.getByLabel('Description', { exact: true }).inputValue(), 'Keep this draft'); assert.equal(reads('address'), 0);
      checks.push(`${viewport.width}: polling during a receive draft preserves the mounted form and entered values`);

      await fresh(); await openReceive(); state.wallets[0].status = 'stopped'; await poll(); await dialog().waitFor({ state: 'hidden' });
      state.wallets[0].status = 'running'; await poll(); await page.getByRole('button', { name: 'Receive', exact: true }).waitFor(); await createReceive(); assert.equal(reads('address'), 1);
      checks.push(`${viewport.width}: a lifecycle change closes the old receive draft and a fresh form works after restart`);

      if (viewport.width === 1440) {
        await fresh(); await createReceive(); await page.evaluate(() => { window.fixtureNativeDeadlines = []; });
        const slowBalance = hold('balance'); const before = reads(); await poll(); await slowBalance.started.promise;
        await until(async () => (await dialog().locator('.receive-status').innerText()).includes('Waiting for the current balance read'), 'Long balance read never showed delayed status', 20000);
        for (let i = 0; i < 3; i++) await poll();
        assert.equal(reads(), before + 1); assert.equal(state.maximum[`${A}/balance`], 1); assert.match(await value(), /^0/);
        // Exercise the exact configured deadline callback after verifying the
        // real 15-second stale threshold, without a 65-second test sleep.
        assert.equal(await page.evaluate(() => window.fixtureNativeDeadlines[0].ms), 65000);
        await page.evaluate(() => window.fixtureNativeDeadlines[0].expire());
        await until(async () => (await dialog().locator('.receive-status').innerText()).includes('connection timed out'), 'Native read deadline did not release the fetch');
        slowBalance.release.resolve(); await slowBalance.finished.promise; await page.waitForTimeout(50);
        state.balances[A].onchain_total_sats = 77; await poll(); await until(async () => (await value()).startsWith('77'), 'Polling did not recover after bounded read');
        checks.push('1440: a real 15-second delayed balance retains its last value without overlapping reads; the configured 65-second deadline releases the request and permits recovery');
      }

      await fresh(); state.failures.set(`${A}/invoice`, 'Synthetic invoice outage'); await openReceive('lightning');
      await page.getByRole('button', { name: 'Create request', exact: true }).click(); await dialog().locator('.form-error').filter({ hasText: 'Synthetic invoice outage' }).waitFor();
      assert.equal(await page.getByLabel('Amount (sats)', { exact: true }).inputValue(), '321'); assert.equal(reads('invoice'), 1);
      state.failures.delete(`${A}/invoice`); await page.getByRole('button', { name: 'Create request', exact: true }).click(); await page.getByRole('heading', { name: 'Your Lightning invoice', exact: true }).waitFor(); assert.equal(reads('invoice'), 2);
      checks.push(`${viewport.width}: invoice creation failure preserves entered fields and requires an explicit retry`);

      await fresh(); state.balances[A].onchain_total_sats = '9007199254740993'; await poll(); await until(async () => (await value()).startsWith('9,007,199,254,740,993'), 'Exact integer balance was lost');
      state.balances[A].onchain_total_sats = 'invalid'; await poll(); await until(async () => (await page.locator('.balance-status').innerText()).includes('invalid balance'), 'Invalid balance status missing');
      assert.match(await value(), /^9,007,199,254,740,993/);
      checks.push(`${viewport.width}: large integer balances stay exact and malformed balances preserve the last good value`);

      await fresh(); await createReceive(); const stoppedLate = hold('balance'); state.balances[A].onchain_total_sats = 999999; await poll(); await stoppedLate.started.promise;
      state.wallets[0].status = 'stopped'; await poll(); await until(async () => (await dialog().locator('.receive-status').innerText()).includes('Wallet stopped'), 'Stop did not invalidate old read');
      stoppedLate.release.resolve(); await stoppedLate.finished.promise; await page.waitForTimeout(100); assert.equal((await dialog().locator('.receive-balance').innerText()).includes('999,999'), false);
      state.wallets[0].status = 'running'; state.balances[A].onchain_total_sats = 123; await poll(); await until(async () => (await dialog().locator('.receive-balance').innerText()).includes('123 sats'), 'Restart failed after old response');
      state.wallets[0].status = 'deletion_pending'; state.wallets[0].deletion_pending = true; await poll(); await dialog().waitFor({ state: 'hidden' });
      checks.push(`${viewport.width}: stop discards an older balance response and pending deletion closes its receive view`);

      await fresh(); balanceHttpHeld = { started: deferred(), release: deferred(), finished: deferred() }; const expired = balanceHttpHeld; gates.push(expired.release); await poll(); await expired.started.promise;
      await page.getByRole('button', { name: 'Sign out', exact: true, includeHidden: true }).evaluate(control => control.click()); await login();
      await page.getByRole('button', { name: 'Balance fixture 2', exact: true }).click(); await until(async () => (await value()).startsWith('9,000'), 'New session balance missing');
      expired.release.resolve(); await expired.finished.promise; await page.waitForTimeout(100);
      assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).count(), 0); assert.match(await value(), /^9,000/);
      checks.push(`${viewport.width}: a delayed 401 from an old balance session cannot sign out a newer session`);

      await fresh(); const deletionRace = hold('balance'); state.balances[A].onchain_total_sats = 888888; await poll(); await deletionRace.started.promise;
      state.wallets[0].deletion_pending = true; state.wallets[0].status = 'deletion_pending'; await poll(); await page.getByRole('heading', { name: 'Deletion pending', exact: true }).waitFor();
      deletionRace.release.resolve(); await deletionRace.finished.promise; await page.waitForTimeout(100); assert.equal(await page.locator('[data-balance]').count(), 0);
      assert.equal(state.calls.some(call => call.method === 'sync'), false);
      assert.ok(Object.values(state.maximum).every(count => count <= 1));
      checks.push(`${viewport.width}: pending deletion invalidates in-flight balance data and no polling path calls sync`);
      await context.close();
    }
    assert.deepEqual(errors, []);
    const evidence = { timing_checks: { polling_interval_ms: 5000, observed_stale_delay_ms: 15000, native_deadline_ms: 65000, deadline_method: 'Invoked the recorded 65-second callback after observing the real 15-second stale threshold' }, checks, browser_errors: errors, real_wallet_accessed: false, funds_sent: false, physical_umbrel: false, frontend_sha256: createHash('sha256').update(await fs.readFile(path.join(root, 'manager/public/app.js'))).digest('hex') };
    if (process.env.BALANCE_EVIDENCE) await fs.writeFile(process.env.BALANCE_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence, null, 2));
  } finally {
    for (const gate of gates) gate.resolve(); await browser?.close(); auth.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => process.stdout.write('', () => process.exit(process.exitCode || 0)));
