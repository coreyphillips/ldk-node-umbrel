// Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core package.
// Uses synthetic public connection details and disposable dashboard authentication.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const QRCode = require('../manager/node_modules/qrcode');

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'disposable-pairing-browser-password';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixtures() {
  const wallets = [FIRST_ID, SECOND_ID].map((id, index) => ({
    id, name: `Pairing fixture ${index + 1}`, network: 'regtest', status: 'running',
    chain_source: { type: 'electrum', url: 'tcp://127.0.0.1:50001' },
    chicory: { enabled: false, offline_enabled: false, flat_fee_sat: 100, fee_ppm: 1000, max_client_funding_sats: 200000, max_total_fronted_sats: 1000000 },
    iroh: { enabled: true, discovery: true, default_relays: true },
    iroh_status: 'ready', autostart: false, public_port: 19351 + index,
  }));
  const pairing = new Map(wallets.map((wallet, index) => {
    const node = `02${(index ? 'cd' : 'ab').repeat(32)}`;
    return [wallet.id, {
      node_id: node, network: 'regtest', tcp_uri: `${node}@192.0.2.${index + 1}:${wallet.public_port}`,
      tor_uri: `${node}@${(index ? 'b' : 'a').repeat(56)}.onion:9735`,
      iroh_uri: `iroh://${(index ? 'b' : 'a').repeat(64)}?node_id=${node}`,
      iroh_status: 'ready', direct_addresses: [],
    }];
  }));
  const reads = new Map();
  const manager = {
    bridge: '/synthetic-bridge', list: () => structuredClone(wallets),
    pairing: id => { reads.set(id, (reads.get(id) || 0) + 1); return structuredClone(pairing.get(id)); },
    call: async (id, method) => {
      if (method === 'info') return { node_id: pairing.get(id).node_id, best_block_height: 100, capabilities: [] };
      if (method === 'balance') return { onchain_total_sats: 0, onchain_spendable_sats: 0, lightning_total_sats: 0 };
      if (method === 'offline_status') return { epochs: [] };
      if (['channels', 'payments', 'peers', 'events'].includes(method)) return [];
      throw new Error(`Unexpected fixture RPC: ${method}`);
    },
  };
  return { wallets, pairing, reads, manager };
}

async function waitUntil(predicate, message) {
  const end = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000); })]); }
  finally { clearTimeout(timer); }
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const { Authentication } = await import(`${root}/manager/server/auth.mjs`);
  const { createServer } = await import(`${root}/manager/server/index.mjs`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-pairing-browser-'));
  const auth = new Authentication({ dataDir: directory }); await auth.initialize(undefined, PASSWORD);
  let fixture = fixtures();
  // Indirection allows each viewport to start with the same isolated fixture.
  const manager = {
    bridge: '/synthetic-bridge', list: () => fixture.manager.list(),
    pairing: (...args) => fixture.manager.pairing(...args), call: (...args) => fixture.manager.call(...args),
  };
  const server = createServer({ auth, wallets: manager, allowedHosts: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser; const checks = []; const errors = []; const heldResponses = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      fixture = fixtures();
      const context = await browser.newContext({ viewport });
      await context.addInitScript(() => {
        const interval = window.setInterval;
        window.setInterval = (callback, milliseconds, ...args) => {
          const id = interval(callback, milliseconds, ...args);
          if (milliseconds === 5000) window.pairingPollTimer = id;
          return id;
        };
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      const requests = []; const qrRequests = []; const rules = new Map(); let pairingFailure = false;
      page.on('request', request => { if (request.method() !== 'GET') requests.push(new URL(request.url()).pathname); });
      await page.route('**/api/wallets/*/pairing', async route => {
        if (pairingFailure) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic pairing failure' } }) });
        else await route.continue();
      });
      await page.route('**/api/wallets/*/qr', async route => {
        const uri = route.request().postDataJSON().text; qrRequests.push(uri);
        const rule = rules.get(uri);
        if (rule) rules.delete(uri);
        if (rule?.fail) {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Synthetic QR failure' } }) });
          return;
        }
        const response = await route.fetch();
        if (rule?.gate) { rule.started.resolve(); await rule.gate.promise; }
        await route.fulfill({ response });
        rule?.finished?.resolve();
      });
      const hold = uri => {
        const rule = { gate: deferred(), started: deferred(), finished: deferred() };
        rules.set(uri, rule); heldResponses.push(rule.gate); return rule;
      };
      const card = () => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Connect Chicory to this primary', exact: true }) });
      const select = () => page.getByLabel('Connection method', { exact: true });
      const showSidebar = async () => {
        if (!await page.getByLabel('Select wallet').isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      };
      const navigate = async name => {
        await showSidebar(); await page.getByRole('button', { name: new RegExp(`${name}$`) }).click();
      };
      const openWallet = async id => {
        await showSidebar(); await page.getByLabel('Select wallet').selectOption(id); await navigate('Pair Chicory');
        await select().waitFor();
      };
      const waitURI = async uri => {
        await waitUntil(async () => await card().locator('.copy-value code').first().textContent() === uri, 'Selected URI did not update');
      };
      const verify = async (id, transport, { copy = true } = {}) => {
        const uri = fixture.pairing.get(id)[`${transport}_uri`];
        await waitURI(uri);
        const expected = await QRCode.toDataURL(uri, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
        await waitUntil(async () => await card().locator('img.qr').getAttribute('src') === expected, 'Selected QR did not match its URI');
        assert.equal(await select().inputValue(), transport);
        const labels = { iroh: 'Iroh', tcp: 'Local network (TCP)', tor: 'Tor' };
        assert.equal(await card().locator('dt').filter({ hasText: /^Transport$/ }).evaluate(node => node.nextElementSibling.textContent), labels[transport]);
        await card().locator('img.qr').evaluate(image => image.decode());
        assert.equal(await card().locator('img.qr').evaluate(image => image.complete && image.naturalWidth > 0), true);
        assert.match(await card().locator('.connection-help').textContent(), { iroh: /Iroh relay/, tcp: /reachable from your client/, tor: /Tor-capable client/ }[transport]);
        if (copy) {
          await card().getByRole('button', { name: 'Copy', exact: true }).first().click();
          assert.equal(await page.evaluate(() => window.pairingCopied), uri);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      };
      const refresh = async () => {
        const before = fixture.reads.get(FIRST_ID) || 0;
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await waitUntil(() => (fixture.reads.get(FIRST_ID) || 0) > before, 'Pairing refresh did not reach the fixture');
      };
      await page.goto(origin); await page.getByLabel('Dashboard password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'Pairing fixture 1', exact: true }).click();
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        document.execCommand = command => { window.pairingCopied = document.querySelector('.clipboard-helper')?.value; return command === 'copy'; };
      });
      await navigate('Pair Chicory'); await select().waitFor();
      assert.deepEqual(await select().locator('option').evaluateAll(options => options.map(option => option.value)), ['iroh', 'tcp', 'tor']);
      await verify(FIRST_ID, 'iroh');
      for (const mode of ['tor', 'tcp', 'iroh', 'tor']) { await select().selectOption(mode); await verify(FIRST_ID, mode); }
      checks.push(`${viewport.width}: all available transports have matching QR, URI, Copy and label without overflow`);
      if (process.env.PAIRING_SCREENSHOTS) {
        await fs.mkdir(process.env.PAIRING_SCREENSHOTS, { recursive: true });
        await waitUntil(async () => await page.locator('.toast').count() === 0, 'Copy notifications did not expire before screenshot');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(process.env.PAIRING_SCREENSHOTS, `pairing-${viewport.width}.png`), fullPage: true });
      }

      // A natural five-second poll must leave controls and the rendered QR mounted.
      await select().focus();
      await page.evaluate(() => {
        window.pairingQRNode = document.querySelector('.qr');
        window.pairingFocusedNode = document.activeElement;
        window.scrollTo(0, 220); window.pairingScroll = scrollY;
      });
      const beforePoll = fixture.reads.get(FIRST_ID); const beforeQR = qrRequests.length;
      await waitUntil(() => fixture.reads.get(FIRST_ID) > beforePoll, 'Natural pairing poll did not occur');
      await verify(FIRST_ID, 'tor', { copy: false });
      assert.equal(qrRequests.length, beforeQR);
      assert.deepEqual(await page.evaluate(() => ({ qr: document.querySelector('.qr') === window.pairingQRNode, focus: document.activeElement === window.pairingFocusedNode, scroll: scrollY === window.pairingScroll })), { qr: true, focus: true, scroll: true });
      checks.push(`${viewport.width}: natural polling preserves Tor selection, QR identity, focus and scroll`);
      // Remaining race scenarios explicitly refresh, so a timer cannot silently
      // retry a deliberately failed request before its recovery is inspected.
      await page.evaluate(() => clearInterval(window.pairingPollTimer));

      fixture.wallets[1].name = 'Renamed second fixture'; await refresh(); await verify(FIRST_ID, 'tor');
      await openWallet(SECOND_ID); await verify(SECOND_ID, 'iroh');
      await select().selectOption('tcp'); await verify(SECOND_ID, 'tcp');
      await openWallet(FIRST_ID); await verify(FIRST_ID, 'tor');
      await openWallet(SECOND_ID); await verify(SECOND_ID, 'tcp');
      await openWallet(FIRST_ID); await verify(FIRST_ID, 'tor');
      checks.push(`${viewport.width}: selections survive full render and remain independent for each wallet`);

      const first = fixture.pairing.get(FIRST_ID); const oldTor = first.tor_uri;
      first.tor_uri = null; await refresh(); await verify(FIRST_ID, 'iroh');
      assert.deepEqual(await select().locator('option').evaluateAll(options => options.map(option => option.value)), ['iroh', 'tcp']);
      assert.match(await page.locator('.notice').allTextContents().then(values => values.join(' ')), /unavailable|no longer available/i);
      first.iroh_uri = null; first.iroh_status = 'starting'; await refresh(); await verify(FIRST_ID, 'tcp');
      assert.deepEqual(await select().locator('option').evaluateAll(options => options.map(option => option.value)), ['tcp']);
      first.tor_uri = oldTor; first.iroh_uri = `iroh://${'c'.repeat(64)}?node_id=${first.node_id}`; first.iroh_status = 'ready';
      await refresh(); await verify(FIRST_ID, 'tcp');
      assert.deepEqual(await select().locator('option').evaluateAll(options => options.map(option => option.value)), ['iroh', 'tcp', 'tor']);
      checks.push(`${viewport.width}: unavailable transports disappear with an explicit fallback and returning options preserve choice`);

      pairingFailure = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      const staleWarning = page.getByText('The displayed connection details may be outdated.', { exact: false });
      await staleWarning.waitFor();
      await select().selectOption('tor'); await verify(FIRST_ID, 'tor');
      assert.equal(await staleWarning.isVisible(), true);
      pairingFailure = false; await refresh();
      await staleWarning.waitFor({ state: 'detached' });
      await select().selectOption('tcp'); await verify(FIRST_ID, 'tcp');
      checks.push(`${viewport.width}: local selection preserves stale-data warning until a successful refresh`);

      first.tor_uri = `${first.node_id}@${'d'.repeat(56)}.onion:9735`; await refresh();
      const delayed = hold(first.tor_uri);
      await select().selectOption('tor'); await bounded(delayed.started.promise, 'Delayed QR request did not start');
      await waitURI(first.tor_uri);
      assert.equal(await card().locator('img.qr').count(), 0);
      assert.equal(await card().locator('.qr-loading').count(), 1);
      await select().selectOption('iroh'); await verify(FIRST_ID, 'iroh');
      delayed.gate.resolve(); await bounded(delayed.finished.promise, 'Delayed QR response did not finish');
      await verify(FIRST_ID, 'iroh');
      checks.push(`${viewport.width}: rapid transport changes discard a delayed QR for the previous selection`);

      first.tor_uri = `${first.node_id}@${'e'.repeat(56)}.onion:9735`; await refresh();
      rules.set(first.tor_uri, { fail: true });
      await select().selectOption('tor'); await waitURI(first.tor_uri);
      await page.getByText('Synthetic QR failure', { exact: false }).waitFor();
      assert.equal(await card().locator('img.qr').count(), 0);
      await card().getByRole('button', { name: 'Copy', exact: true }).first().click();
      assert.equal(await page.evaluate(() => window.pairingCopied), first.tor_uri);
      await card().getByRole('button', { name: /retry/i }).click(); await verify(FIRST_ID, 'tor');
      checks.push(`${viewport.width}: QR failure preserves Copy and retry creates the selected QR`);

      first.tcp_uri = `${first.node_id}@192.0.2.55:19351`; await refresh();
      const navigation = hold(first.tcp_uri);
      await select().selectOption('tcp'); await bounded(navigation.started.promise, 'Navigation QR request did not start');
      await navigate('Overview'); navigation.gate.resolve(); await bounded(navigation.finished.promise, 'Navigation QR response did not finish');
      assert.equal(await page.locator('.qr').count(), 0);
      await navigate('Pair Chicory'); await verify(FIRST_ID, 'tcp');
      checks.push(`${viewport.width}: late QR cannot recreate pairing after navigation`);

      first.tor_uri = `${first.node_id}@${'f'.repeat(56)}.onion:9735`; await refresh();
      const logout = hold(first.tor_uri);
      await select().selectOption('tor'); await bounded(logout.started.promise, 'Logout QR request did not start');
      await showSidebar(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      logout.gate.resolve(); await bounded(logout.finished.promise, 'Logout QR response did not finish');
      assert.equal(await page.locator('.qr').count(), 0);
      assert.equal(await page.getByLabel('Connection method', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => sessionStorage.length), 0);
      assert.ok(requests.every(route => ['/api/login', '/api/logout'].includes(route) || /^\/api\/wallets\/[^/]+\/qr$/.test(route)), `Unexpected mutation: ${requests.join(', ')}`);
      checks.push(`${viewport.width}: logout rejects stale QR and selectors never mutate wallet configuration`);
      await context.close();
    }
    assert.deepEqual(errors, []);
    const evidence = {
      checks, browser_errors: errors, funds_sent: false, physical_umbrel: false,
      frontend_sha256: createHash('sha256').update(await fs.readFile(path.join(root, 'manager/public/app.js'))).digest('hex'),
    };
    if (process.env.PAIRING_EVIDENCE) await fs.writeFile(process.env.PAIRING_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    for (const gate of heldResponses) gate.resolve();
    await browser?.close(); auth.close();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  // Exit only after awaited cleanup, preserving failures and flushing results.
  process.stdout.write('', () => process.exit(process.exitCode || 0));
});
