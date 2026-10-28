// Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core package.
// Uses real dashboard authentication and synthetic in-memory wallets only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_NAME = 'Delete fixture A';
const SECOND_NAME = 'Keep fixture B';
const PASSWORD = 'disposable-deletion-browser-password';
const ACKNOWLEDGMENT = 'I understand this permanently deletes this wallet’s data from this app';

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]); }
  finally { clearTimeout(timer); }
}

function fixture() {
  const wallets = [FIRST_ID, SECOND_ID].map((id, index) => ({
    id, name: index ? SECOND_NAME : FIRST_NAME, network: index ? 'signet' : 'regtest', status: 'stopped', recovery_kind: 'legacy_seed',
    chain_source: { type: 'electrum', url: 'tcp://192.0.2.10:50001' }, autostart: false, public_port: 19351 + index,
    chicory: { enabled: false, flat_fee_sat: 100, fee_ppm: 1000, max_client_funding_sats: 200000, max_total_fronted_sats: 1000000 },
    iroh: { enabled: true, discovery: true, default_relays: true }, iroh_status: 'stopped',
    tor: { enabled: true }, tor_status: 'stopped', tor_address: null, tor_bootstrap: 0, tor_error: null,
  }));
  const calls = []; const unexpected = [];
  const error = (message, status, code) => Object.assign(new Error(message), { status, code });
  const state = { wallets, calls, unexpected, behavior: null, listReads: 0 };
  const get = id => wallets.find(wallet => wallet.id === id);
  const remove = id => { const index = wallets.findIndex(wallet => wallet.id === id); assert.ok(index >= 0); wallets.splice(index, 1); return { deleted: true, id }; };
  state.manager = {
    bridge: '/synthetic-iroh', torBinary: '/synthetic-tor',
    list: () => { state.listReads++; return structuredClone(wallets); },
    remove: async (id, input) => {
      calls.push({ id, input: structuredClone(input) });
      const wallet = get(id);
      if (!wallet) throw error('Wallet not found', 404, 'NOT_FOUND');
      if (input.confirmation_name !== wallet.name || input.acknowledge_data_loss !== true) throw error('Enter the exact current wallet name and acknowledge permanent data loss', 400, 'CONFIRMATION_REQUIRED');
      if (wallet.status !== 'stopped' && !wallet.deletion_pending) throw error('Stop the wallet before deleting it', 409, 'STOP_REQUIRED');
      const behavior = state.behavior; state.behavior = null;
      if (behavior) return behavior({ wallet, input, remove: () => remove(id), error });
      return remove(id);
    },
    call: async (id, method) => {
      if (method === 'info') return { node_id: `02${'ab'.repeat(32)}`, capabilities: [], best_block_height: 100 };
      if (method === 'balance') return { onchain_total_sats: 0, onchain_spendable_sats: 0, lightning_total_sats: 0 };
      if (['channels', 'payments', 'peers', 'events'].includes(method)) return [];
      unexpected.push(method); throw error('Unexpected fixture operation', 400, 'UNEXPECTED_OPERATION');
    },
    stop: async () => { unexpected.push('stop'); throw error('Deletion must not stop a wallet automatically', 400, 'UNEXPECTED_STOP'); },
    backup: async () => { unexpected.push('backup'); throw error('This fixture does not export backups', 400, 'UNEXPECTED_BACKUP'); },
  };
  return state;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const { Authentication } = await import(`${root}/manager/server/auth.mjs`);
  const { createServer } = await import(`${root}/manager/server/index.mjs`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-delete-browser-'));
  const auth = new Authentication({ dataDir: directory }); await auth.initialize(undefined, PASSWORD);
  let state = fixture();
  const manager = {
    bridge: '/synthetic-iroh', torBinary: '/synthetic-tor', list: () => state.manager.list(),
    remove: (...args) => state.manager.remove(...args), call: (...args) => state.manager.call(...args),
    stop: (...args) => state.manager.stop(...args), backup: (...args) => state.manager.backup(...args),
  };
  const server = createServer({ auth, wallets: manager, allowedHosts: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser; const checks = []; const errors = []; const releases = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(() => {
        const interval = window.setInterval;
        window.setInterval = (callback, milliseconds, ...args) => {
          const id = interval(callback, milliseconds, ...args);
          if (milliseconds === 5000) window.deletionPollTimer = id;
          return id;
        };
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      let heldList = null;
      await page.route('**/api/wallets', async route => {
        if (route.request().method() !== 'GET' || !heldList) { await route.continue(); return; }
        const held = heldList; heldList = null;
        const response = await route.fetch(); held.started.resolve();
        await held.gate.promise; await route.fulfill({ response }); held.finished.resolve();
      });
      const dialog = () => page.locator('#dialog');
      const name = () => page.getByLabel('Type the wallet name to confirm', { exact: true });
      const acknowledgment = () => page.getByLabel(ACKNOWLEDGMENT, { exact: true });
      const permanent = () => dialog().getByRole('button', { name: 'Permanently delete wallet', exact: true });
      const card = () => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Delete wallet', exact: true }) });
      const login = async () => {
        await page.getByLabel('Dashboard password', { exact: true }).fill(PASSWORD);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await page.getByRole('heading', { name: 'A native home for your Bitcoin.', exact: true }).waitFor();
        await page.evaluate(() => clearInterval(window.deletionPollTimer));
      };
      const showSidebar = async () => {
        if (viewport.width < 760) await waitUntil(async () => await page.locator('.toast').count() === 0, 'Notifications cover mobile navigation');
        if (!await page.getByLabel('Select wallet', { exact: true }).isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      };
      const settings = async () => { await showSidebar(); await page.getByRole('button', { name: /Settings$/ }).click(); await page.getByRole('heading', { name: 'Wallet settings', exact: true }).waitFor(); };
      const fresh = async (prepare = () => {}) => {
        assert.deepEqual(state.unexpected, []); state = fixture(); prepare(state);
        await page.goto(origin);
        await page.locator('form input[type="password"], .wallet-row .name-button').first().waitFor();
        if (await page.getByLabel('Dashboard password', { exact: true }).isVisible()) await login();
        await page.getByRole('button', { name: FIRST_NAME, exact: true }).click();
        await page.evaluate(() => clearInterval(window.deletionPollTimer)); await settings();
      };
      const openDelete = async () => { await card().getByRole('button', { name: 'Delete wallet', exact: true }).click(); await page.getByRole('heading', { name: 'Delete wallet?', exact: true }).waitFor(); };
      const confirm = async (walletName = FIRST_NAME) => { await name().fill(walletName); await acknowledgment().check(); };
      const refresh = async () => { const before = state.listReads; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await waitUntil(() => state.listReads > before, 'Wallet list did not refresh'); };
      const heldDelete = ({ failure = false } = {}) => {
        const started = deferred(); const gate = deferred(); const finished = deferred(); releases.push(gate);
        state.behavior = async ({ wallet, remove, error }) => {
          started.resolve(); await gate.promise;
          try { if (failure) throw error('Synthetic deletion refusal', 409, 'WALLET_PATH_UNSAFE'); return remove(); }
          finally { finished.resolve(); }
        };
        return { started, gate, finished };
      };
      const assertSiblingSelected = async () => {
        await waitUntil(async () => await page.getByLabel('Select wallet', { exact: true }).inputValue() === SECOND_ID, 'Surviving wallet selection was lost');
      };
      const programmaticSibling = async () => {
        // Simulate route navigation while a modal request is outstanding,
        // without pretending the disabled Cancel control aborts deletion.
        await page.getByLabel('Select wallet', { exact: true }).evaluate((select, id) => { select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })); }, SECOND_ID);
      };

      await fresh(); await openDelete();
      assert.match(await dialog().innerText(), /Delete fixture A/); assert.match(await dialog().innerText(), /Regtest/);
      assert.match(await dialog().innerText(), /It does not send or recover funds\./);
      assert.match(await dialog().innerText(), /recovery phrase alone cannot restore Lightning channels/);
      assert.equal(await permanent().isDisabled(), true);
      await name().fill(FIRST_NAME); assert.equal(await permanent().isDisabled(), true);
      await acknowledgment().check(); assert.equal(await permanent().isEnabled(), true);
      for (const wrong of [FIRST_NAME.toLowerCase(), `${FIRST_NAME} `, FIRST_NAME.slice(0, -1)]) {
        await name().fill(wrong); assert.equal(await permanent().isDisabled(), true);
        await dialog().locator('form').dispatchEvent('submit'); assert.equal(state.calls.length, 0);
      }
      await name().fill(FIRST_NAME);
      if (process.env.DELETE_SCREENSHOTS) {
        await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
        await openDelete(); await confirm();
        await fs.mkdir(process.env.DELETE_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.DELETE_SCREENSHOTS, `delete-confirmation-${viewport.width}.png`) });
      }
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
      assert.equal(state.calls.length, 0); assert.equal(state.wallets.length, 2);
      await openDelete(); await dialog().getByRole('button', { name: 'Back up all wallets', exact: true }).click();
      await page.getByRole('heading', { name: 'Back up all wallets', exact: true }).waitFor();
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(state.calls.length, 0);
      checks.push(`${viewport.width}: exact name and acknowledgment are required; cancel is inert and backup opens the existing flow`);

      await fresh(value => { value.wallets[0].status = 'running'; });
      assert.equal(await card().getByRole('button', { name: 'Delete wallet', exact: true }).isDisabled(), true);
      assert.match(await card().innerText(), /Stop this wallet before deleting/); assert.equal(state.calls.length, 0);
      checks.push(`${viewport.width}: running wallet deletion is disabled without an automatic stop`);

      await page.getByRole('button', { name: 'Back up all wallets', exact: true }).first().click();
      await page.getByLabel('Backup password', { exact: true }).fill('synthetic-backup-password');
      await page.getByLabel('Confirm backup password', { exact: true }).fill('synthetic-backup-password');
      await page.getByLabel('I agree to stop all wallets and keep the backup private', { exact: true }).check();
      Object.assign(state.wallets[1], { deletion_pending: true, status: 'deletion_pending' });
      await page.getByRole('button', { name: 'Stop wallets and download backup', exact: true }).click();
      await page.getByText('Finish pending wallet deletion before creating a full backup. No wallets were stopped.', { exact: true }).waitFor();
      assert.deepEqual(state.unexpected, []); assert.equal(state.wallets[0].status, 'running');
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await refresh();
      await page.getByRole('button', { name: 'Back up all wallets', exact: true }).first().click();
      await page.getByText('Finish pending wallet deletion before creating a full backup.', { exact: true }).waitFor();
      assert.equal(await dialog().isVisible(), false); assert.deepEqual(state.unexpected, []);
      checks.push(`${viewport.width}: backup checks pending deletion before stopping any healthy sibling`);

      await fresh(); await openDelete(); await confirm();
      state.behavior = async ({ error }) => { throw error('Synthetic unsafe wallet path', 409, 'WALLET_PATH_UNSAFE'); };
      await permanent().click(); await page.getByText('Deletion was not confirmed: Synthetic unsafe wallet path', { exact: true }).waitFor();
      await waitUntil(async () => await permanent().isEnabled(), 'Failed deletion controls did not recover');
      assert.equal(await name().inputValue(), FIRST_NAME); assert.equal(await acknowledgment().isChecked(), true);
      assert.equal(state.wallets.length, 2); assert.equal(state.calls.length, 1);
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
      checks.push(`${viewport.width}: refused deletion keeps the wallet, confirmation and error without automatic retry`);

      await fresh(); await openDelete(); await confirm();
      state.behavior = async ({ wallet, error }) => { wallet.deletion_pending = true; wallet.status = 'deletion_pending'; throw error('Synthetic incomplete deletion', 500, 'DELETE_INCOMPLETE'); };
      await permanent().click(); await page.getByText('Deletion was not confirmed: Synthetic incomplete deletion', { exact: true }).waitFor();
      await dialog().getByRole('button', { name: 'Finish deleting wallet', exact: true }).waitFor();
      assert.equal(await dialog().getByRole('button', { name: 'Back up all wallets', exact: true }).isVisible(), false);
      assert.match(await dialog().innerText(), /some data may already be removed/);
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await refresh();
      await page.getByRole('heading', { name: 'Deletion pending', exact: true }).waitFor();
      for (const label of ['Start wallet', 'Recovery phrase', 'Back up all wallets', 'Edit configuration']) assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0);
      const sibling = structuredClone(state.wallets[1]);
      await page.getByRole('button', { name: 'Finish deleting wallet', exact: true }).click();
      await confirm(); await dialog().getByRole('button', { name: 'Finish deleting wallet', exact: true }).click();
      await dialog().waitFor({ state: 'hidden' }); await assertSiblingSelected();
      assert.deepEqual(state.wallets, [sibling]); assert.equal(state.calls.length, 2);
      assert.deepEqual(state.calls[1], { id: FIRST_ID, input: { confirmation_name: FIRST_NAME, acknowledge_data_loss: true } });
      checks.push(`${viewport.width}: incomplete deletion permits only explicit completion and preserves the sibling wallet`);

      await settings(); await openDelete(); await confirm(SECOND_NAME); await permanent().click();
      await dialog().waitFor({ state: 'hidden' }); await page.getByRole('heading', { name: 'A native home for your Bitcoin.', exact: true }).waitFor();
      assert.equal(state.wallets.length, 0); assert.equal(await page.getByLabel('Select wallet', { exact: true }).count(), 0);
      checks.push(`${viewport.width}: deleting the last wallet returns to All wallets`);

      await fresh(); await openDelete(); await confirm(); const double = heldDelete();
      await permanent().click(); await bounded(double.started.promise, 'Deletion request did not start');
      assert.equal(await dialog().getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
      assert.equal(await dialog().locator('.dialog-head button').isDisabled(), true);
      await page.keyboard.press('Escape'); assert.equal(await dialog().isVisible(), true);
      await dialog().locator('form').dispatchEvent('submit'); await dialog().locator('form').dispatchEvent('submit');
      assert.equal(state.calls.length, 1);
      double.gate.resolve(); await dialog().waitFor({ state: 'hidden' }); await assertSiblingSelected();
      checks.push(`${viewport.width}: submitted deletion blocks Cancel, close, Escape and duplicate submission`);

      for (const failure of [false, true]) {
        await fresh(); await openDelete(); await confirm(); const stale = heldDelete({ failure });
        await permanent().click(); await bounded(stale.started.promise, 'Navigation deletion request did not start');
        await programmaticSibling(); await assertSiblingSelected();
        assert.match(await dialog().innerText(), /Delete fixture A/); assert.match(await dialog().innerText(), /Regtest/);
        stale.gate.resolve(); await bounded(stale.finished.promise, 'Navigation deletion request did not finish');
        if (failure) {
          await page.getByText('Deletion was not confirmed: Synthetic deletion refusal', { exact: true }).waitFor();
          await waitUntil(async () => await dialog().getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), 'Stale failure stranded dialog controls');
          await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
        }
        await dialog().waitFor({ state: 'hidden' }); await assertSiblingSelected();
        assert.equal(state.wallets.some(wallet => wallet.id === FIRST_ID), failure);
      }
      checks.push(`${viewport.width}: delayed success and failure preserve a newly selected wallet and release the original dialog`);

      await fresh(); await openDelete(); await confirm(); const oldSession = heldDelete();
      await permanent().click(); await bounded(oldSession.started.promise, 'Session deletion request did not start');
      await dialog().evaluate(element => element.close()); await showSidebar();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await login();
      await page.getByRole('button', { name: SECOND_NAME, exact: true }).click(); await assertSiblingSelected();
      const oldResponse = page.waitForResponse(response => response.request().method() === 'DELETE');
      oldSession.gate.resolve(); await bounded(oldSession.finished.promise, 'Old-session deletion did not finish');
      await oldResponse;
      await refresh(); await assertSiblingSelected();
      assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
      assert.equal(await dialog().isVisible(), false); assert.equal(state.wallets.length, 1);
      checks.push(`${viewport.width}: a delayed deletion response cannot change a newer login or its selected wallet`);

      await fresh();
      const lateList = { started: deferred(), gate: deferred(), finished: deferred() }; releases.push(lateList.gate); heldList = lateList;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await bounded(lateList.started.promise, 'Pre-delete list request did not start');
      await openDelete(); await confirm(); await permanent().click();
      await dialog().waitFor({ state: 'hidden' }); await assertSiblingSelected();
      await page.evaluate(id => {
        window.deletedWalletResurrected = false;
        window.deletionObserver = new MutationObserver(records => {
          for (const record of records) for (const node of record.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if ((node.matches('option') && node.value === id) || [...node.querySelectorAll('option')].some(option => option.value === id)) window.deletedWalletResurrected = true;
          }
        });
        window.deletionObserver.observe(document.querySelector('#app'), { subtree: true, childList: true });
      }, FIRST_ID);
      lateList.gate.resolve(); await bounded(lateList.finished.promise, 'Pre-delete list response did not finish');
      await waitUntil(async () => !(await page.getByLabel('Select wallet', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value))).includes(FIRST_ID), 'Deleted wallet reappeared after stale polling');
      await refresh(); await assertSiblingSelected();
      assert.equal(await page.evaluate(() => { window.deletionObserver.disconnect(); return window.deletedWalletResurrected; }), false);
      assert.deepEqual(await page.getByLabel('Select wallet', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value)), ['', SECOND_ID]);
      checks.push(`${viewport.width}: a pre-delete polling response cannot resurrect the removed wallet`);

      await fresh(); await openDelete(); await confirm();
      state.behavior = async ({ remove, error }) => { remove(); throw error('Synthetic lost deletion response', 503, 'RESPONSE_LOST'); };
      await permanent().click();
      await page.getByText('This wallet is no longer listed.', { exact: false }).waitFor();
      assert.equal(await permanent().isDisabled(), true); assert.equal(state.calls.length, 1);
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await refresh();
      assert.equal(state.wallets.length, 1); assert.equal(state.wallets[0].id, SECOND_ID);
      checks.push(`${viewport.width}: a lost response reconciles the list and does not retry deletion automatically`);

      await fresh(); await openDelete(); await confirm(); state.wallets[0].name = 'Renamed fixture';
      await permanent().click(); await page.getByText('Enter the exact current wallet name', { exact: false }).waitFor();
      assert.match(await dialog().innerText(), /Delete fixture A/); assert.equal(state.wallets.length, 2);
      assert.deepEqual(state.calls[0].input, { confirmation_name: FIRST_NAME, acknowledge_data_loss: true });
      await dialog().getByRole('button', { name: 'Cancel', exact: true }).click();
      checks.push(`${viewport.width}: a renamed target keeps the captured identity and server rejection prevents deletion`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(state.unexpected, []); await context.close();
    }
    assert.deepEqual(errors, []);
    const evidence = {
      checks, browser_errors: errors, real_wallets_deleted: false, funds_sent: false, physical_umbrel: false,
      frontend_sha256: createHash('sha256').update(await fs.readFile(path.join(root, 'manager/public/app.js'))).digest('hex'),
    };
    if (process.env.DELETE_EVIDENCE) await fs.writeFile(process.env.DELETE_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    for (const gate of releases) gate.resolve();
    await browser?.close(); auth.close(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  process.stdout.write('', () => process.exit(process.exitCode || 0));
});
