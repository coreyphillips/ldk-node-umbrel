// Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core package.
// Exercises dashboard controls using synthetic wallets and Tor lifecycle events.
// No Tor process, Lightning node, real wallet or remote service is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const QRCode = require('../manager/node_modules/qrcode');

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const PASSWORD = 'disposable-tor-browser-password';
const LEGACY_ONION = `${'a'.repeat(56)}.onion:9735`;
const GENERATED_ONION = `${'b'.repeat(56)}.onion:9735`;

async function waitUntil(predicate, message) {
  const end = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function fixtures(walletConfig) {
  const initial = walletConfig({
    name: 'Tor fixture', network: 'regtest', autostart: false,
    chain_source: { type: 'electrum', url: 'tcp://192.0.2.10:50001' },
    advertised_host: '192.0.2.20', tor: { enabled: false }, tor_onion_address: LEGACY_ONION,
    chicory: { enabled: true, flat_fee_sat: 250, fee_ppm: 2250, max_client_funding_sats: 300000, max_total_fronted_sats: 1500000 },
    iroh: { enabled: true, discovery: true, default_relays: true },
  });
  const wallets = [{
    ...initial, id: FIRST_ID, recovery_kind: 'legacy_seed', status: 'stopped', public_port: 19351,
    iroh_status: 'stopped', tor_status: 'external', tor_bootstrap: 0, tor_error: null, tor_address: LEGACY_ONION,
  }];
  const updates = []; const creates = []; let pairingReads = 0;
  const get = id => { const wallet = wallets.find(item => item.id === id); assert.ok(wallet, `Unknown fixture wallet ${id}`); return wallet; };
  const state = (wallet, status, bootstrap = 0, address = '', error = null) => Object.assign(wallet, { tor_status: status, tor_bootstrap: bootstrap, tor_address: address, tor_error: error });
  const manager = {
    bridge: '/synthetic-iroh-bridge', torBinary: '/synthetic-tor',
    list: () => structuredClone(wallets),
    create: async input => {
      creates.push(structuredClone(input));
      const wallet = { ...walletConfig(input), id: SECOND_ID, recovery_kind: 'legacy_seed', status: 'stopped', public_port: 19352, iroh_status: 'stopped' };
      state(wallet, wallet.tor.enabled ? 'stopped' : wallet.tor_onion_address ? 'external' : 'disabled');
      wallets.push(wallet); return structuredClone(wallet);
    },
    update: async (id, input) => {
      updates.push({ id, input: structuredClone(input) });
      const wallet = get(id); assert.equal(wallet.status, 'stopped');
      Object.assign(wallet, walletConfig(input, wallet));
      state(wallet, wallet.tor.enabled ? 'stopped' : wallet.tor_onion_address ? 'external' : 'disabled', 0, wallet.tor_onion_address || '');
      return structuredClone(wallet);
    },
    start: async id => {
      const wallet = get(id); wallet.status = 'running'; wallet.iroh_status = wallet.iroh.enabled ? 'ready' : 'disabled';
      if (wallet.tor.enabled) state(wallet, 'starting');
      return structuredClone(wallet);
    },
    stop: async id => {
      const wallet = get(id); wallet.status = 'stopped'; wallet.iroh_status = 'stopped';
      if (wallet.tor.enabled) state(wallet, 'stopped');
      return structuredClone(wallet);
    },
    pairing: id => {
      pairingReads++;
      const wallet = get(id); const node = `02${(id === FIRST_ID ? 'ab' : 'cd').repeat(32)}`;
      const onion = wallet.tor.enabled ? wallet.tor_address : wallet.tor_onion_address;
      return {
        node_id: node, network: wallet.network, tcp_uri: `${node}@${wallet.advertised_host || '192.0.2.20'}:${wallet.public_port}`,
        iroh_uri: wallet.iroh.enabled ? `iroh://${'c'.repeat(64)}?node_id=${node}` : null,
        iroh_status: wallet.iroh_status, direct_addresses: [], tor_uri: onion ? `${node}@${onion}` : null,
        tor_managed: wallet.tor.enabled, tor_status: wallet.tor_status, tor_bootstrap: wallet.tor_bootstrap,
        tor_error: wallet.tor_error, tor_address: wallet.tor_address,
      };
    },
    call: async (id, method) => {
      if (method === 'info') return { node_id: `02${(id === FIRST_ID ? 'ab' : 'cd').repeat(32)}`, best_block_height: 100, capabilities: [] };
      if (method === 'balance') return { onchain_total_sats: 0, onchain_spendable_sats: 0, lightning_total_sats: 0 };
      if (['channels', 'payments', 'peers', 'events'].includes(method)) return [];
      throw new Error(`Unexpected fixture RPC: ${method}`);
    },
  };
  return { initial, wallets, updates, creates, manager, get, setTor: (...args) => state(get(FIRST_ID), ...args), reads: () => pairingReads };
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const { Authentication } = await import(`${root}/manager/server/auth.mjs`);
  const { createServer } = await import(`${root}/manager/server/index.mjs`);
  const { walletConfig } = await import(`${root}/manager/server/config.mjs`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-tor-browser-'));
  const auth = new Authentication({ dataDir: directory }); await auth.initialize(undefined, PASSWORD);
  let fixture = fixtures(walletConfig);
  const manager = {
    get bridge() { return fixture.manager.bridge; }, get torBinary() { return fixture.manager.torBinary; },
    list: () => fixture.manager.list(), create: (...args) => fixture.manager.create(...args),
    update: (...args) => fixture.manager.update(...args), start: (...args) => fixture.manager.start(...args),
    stop: (...args) => fixture.manager.stop(...args), pairing: (...args) => fixture.manager.pairing(...args),
    call: (...args) => fixture.manager.call(...args),
  };
  const server = createServer({ auth, wallets: manager, allowedHosts: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser; const checks = []; const errors = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      fixture = fixtures(walletConfig);
      const context = await browser.newContext({ viewport }); const page = await context.newPage();
      page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      const showSidebar = async () => {
        if (viewport.width < 760) await waitUntil(async () => await page.locator('.toast').count() === 0, 'Notifications still cover mobile navigation');
        if (!await page.getByLabel('Select wallet').isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      };
      const navigate = async name => { await showSidebar(); await page.getByRole('button', { name: new RegExp(`${name}$`) }).click(); };
      const edit = async () => {
        await navigate('Settings'); await page.getByRole('button', { name: 'Edit configuration', exact: true }).click();
        await page.getByRole('heading', { name: 'Edit wallet', exact: true }).waitFor();
      };
      const save = async () => {
        const count = fixture.updates.length;
        await page.getByRole('button', { name: 'Save settings', exact: true }).click();
        await waitUntil(() => fixture.updates.length > count, 'Settings were not saved');
        await page.locator('#dialog').waitFor({ state: 'hidden' });
        return fixture.updates.at(-1).input;
      };
      const tor = () => page.getByLabel('Enable Tor connections', { exact: true });
      const external = () => page.getByLabel('Existing Tor onion address (optional)', { exact: true });
      const iroh = () => page.getByLabel('Enable Iroh phone link', { exact: true });
      const assertIrohEnabled = async () => {
        for (const label of ['Enable Iroh phone link', 'Allow public Iroh relays', 'Allow n0 endpoint discovery']) assert.equal(await page.getByLabel(label, { exact: true }).isChecked(), true);
      };
      const screenshot = async label => {
        if (!process.env.TOR_SCREENSHOTS) return;
        await fs.mkdir(process.env.TOR_SCREENSHOTS, { recursive: true });
        await waitUntil(async () => await page.locator('.toast').count() === 0, 'Notifications did not expire before screenshot');
        if (label === 'settings') await tor().scrollIntoViewIfNeeded(); else await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(process.env.TOR_SCREENSHOTS, `tor-${label}-${viewport.width}.png`), fullPage: true });
      };
      const select = () => page.getByLabel('Connection method', { exact: true });
      const card = () => page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Connect Chicory to this primary', exact: true }) });
      const verifyQR = async mode => {
        const pairing = fixture.manager.pairing(FIRST_ID); const uri = pairing[`${mode}_uri`];
        const expected = await QRCode.toDataURL(uri, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
        await waitUntil(async () => await card().locator('img.qr').getAttribute('src') === expected, 'QR did not match selected connection');
        await card().locator('img.qr').evaluate(image => image.decode());
        assert.equal(await select().inputValue(), mode);
        assert.equal(await card().locator('.copy-value code').first().textContent(), uri);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      };
      const refresh = async ({ preserveFocus = false } = {}) => {
        const before = fixture.reads();
        const control = page.getByRole('button', { name: 'Refresh', exact: true });
        if (preserveFocus) await control.dispatchEvent('click'); else await control.click();
        await waitUntil(() => fixture.reads() > before, 'Pairing refresh did not reach the fixture');
      };
      const torOptions = async () => select().locator('option').evaluateAll(options => options.map(option => option.value));
      const notices = () => page.locator('.notice').allTextContents().then(values => values.join(' '));

      await page.goto(origin); await page.getByLabel('Dashboard password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: fixture.get(FIRST_ID).name, exact: true }).click();
      await edit();
      const trustedPeers = () => page.getByLabel('Trusted wallets for instant channel growth (optional)', { exact: true });
      const trustedPeer = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
      assert.equal(await trustedPeers().inputValue(), '');
      assert.match(await page.locator('#dialog').textContent(), /spend the old channel funding and cause this primary to lose funds/);
      await trustedPeers().fill('02' + 'ff'.repeat(32));
      await page.getByRole('button', { name: 'Save settings', exact: true }).click();
      await waitUntil(async () => (await page.locator('.form-error').textContent()).includes('Invalid trusted splice peer'), 'Invalid key was not rejected');
      assert.deepEqual(fixture.get(FIRST_ID).chicory.trusted_splice_peer_pubkeys, []);
      await trustedPeers().fill(trustedPeer.toUpperCase());
      await save(); await edit();
      assert.equal(await trustedPeers().inputValue(), trustedPeer);
      await trustedPeers().fill(''); await save(); await edit();
      assert.deepEqual(fixture.get(FIRST_ID).chicory.trusted_splice_peer_pubkeys, []);
      checks.push(`${viewport.width}: instant splice trust defaults off, rejects invalid keys, persists explicit keys and can be cleared`);
      assert.equal(await tor().isChecked(), false); assert.equal(await tor().isEnabled(), true);
      assert.equal(await external().inputValue(), LEGACY_ONION); await assertIrohEnabled();
      await tor().check(); assert.equal(await external().isVisible(), false); await assertIrohEnabled();
      await screenshot('settings');
      const enabled = await save();
      assert.deepEqual(enabled.tor, { enabled: true }); assert.equal(enabled.tor_onion_address, '');
      for (const field of ['name', 'network', 'chain_source', 'advertised_host', 'autostart', 'chicory', 'iroh']) assert.deepEqual(enabled[field], fixture.initial[field], `Enabling Tor changed ${field}`);
      checks.push(`${viewport.width}: enabling managed Tor clears legacy address and preserves Iroh, chain, provider and startup settings`);

      await edit(); assert.equal(await tor().isChecked(), true); assert.equal(await external().isVisible(), false); await assertIrohEnabled();
      await tor().uncheck(); assert.equal(await external().isVisible(), true);
      await external().fill(LEGACY_ONION); const disabled = await save();
      assert.deepEqual(disabled.tor, { enabled: false }); assert.equal(disabled.tor_onion_address, LEGACY_ONION);
      assert.deepEqual(disabled.iroh, fixture.initial.iroh);
      await edit(); assert.equal(await tor().isChecked(), false); assert.equal(await external().inputValue(), LEGACY_ONION);
      await tor().check(); await save();
      checks.push(`${viewport.width}: saved Tor state reloads and disabling restores external onion configuration independently of Iroh`);

      await showSidebar(); await page.getByRole('button', { name: '+ New wallet', exact: true }).click();
      await page.getByLabel('Wallet name', { exact: true }).fill('Created Tor fixture');
      await page.getByLabel('Bitcoin network', { exact: true }).selectOption('regtest');
      await page.getByLabel('Electrum URL', { exact: true }).fill('tcp://192.0.2.10:50001');
      assert.equal(await tor().isChecked(), false); assert.equal(await iroh().isChecked(), false);
      await tor().check(); await iroh().check();
      await page.getByLabel('Allow public Iroh relays', { exact: true }).check();
      await page.getByLabel('Allow n0 endpoint discovery', { exact: true }).check();
      await page.getByLabel('Start automatically with the dashboard', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Create wallet', exact: true }).click();
      await waitUntil(() => fixture.creates.length === 1, 'Create wallet did not reach the fixture');
      assert.deepEqual(fixture.creates[0].tor, { enabled: true }); assert.equal(fixture.creates[0].tor_onion_address, '');
      assert.deepEqual(fixture.creates[0].iroh, fixture.initial.iroh);
      await page.getByRole('heading', { name: 'Recovery phrase', exact: true }).waitFor();
      await page.locator('#dialog .dialog-head button').click();
      checks.push(`${viewport.width}: new-wallet form can enable Tor and Iroh together with independent defaults`);

      fixture.manager.torBinary = undefined;
      await page.reload(); await page.getByRole('button', { name: fixture.get(FIRST_ID).name, exact: true }).click(); await edit();
      assert.equal(await tor().isEnabled(), true); assert.equal(await tor().isChecked(), true);
      assert.match(await page.locator('#dialog').innerText(), /Tor[^\n]*(?:unavailable|not available|not installed|missing)|(?:unavailable|not available|not installed|missing)[^\n]*Tor/i);
      await page.getByLabel('Wallet name', { exact: true }).fill('Managed Tor fixture');
      const absent = await save(); assert.deepEqual(absent.tor, { enabled: true });
      assert.deepEqual(absent.iroh, fixture.initial.iroh);
      await showSidebar(); await page.getByRole('button', { name: '+ New wallet', exact: true }).click();
      assert.equal(await tor().isDisabled(), true); assert.equal(await tor().isChecked(), false);
      assert.match(await page.locator('#dialog').innerText(), /Tor[^\n]*(?:unavailable|not available|not installed|missing)|(?:unavailable|not available|not installed|missing)[^\n]*Tor/i);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      fixture.manager.torBinary = '/synthetic-tor';
      await page.reload(); await page.getByRole('button', { name: fixture.get(FIRST_ID).name, exact: true }).click();
      checks.push(`${viewport.width}: missing Tor binary blocks new activation with an explanation and preserves existing saved preferences`);

      await page.getByRole('button', { name: 'Start wallet', exact: true }).click();
      await navigate('Pair Chicory'); await select().waitFor(); await verifyQR('iroh');
      assert.deepEqual(await torOptions(), ['iroh', 'tcp']);
      await waitUntil(async () => /Tor[^\n]*starting|starting[^\n]*Tor/i.test(await notices()), 'Tor startup status was not shown');
      fixture.setTor('bootstrapping', 45); await refresh();
      await waitUntil(async () => /45\s*%/.test(await notices()), 'Tor bootstrap progress was not shown');
      assert.deepEqual(await torOptions(), ['iroh', 'tcp']); await verifyQR('iroh');
      checks.push(`${viewport.width}: managed Tor startup and bootstrap progress remain visible while Iroh pairing stays usable`);

      fixture.setTor('failed', 45, '', 'Synthetic Tor bootstrap timeout'); await refresh();
      await page.getByText('Synthetic Tor bootstrap timeout', { exact: false }).waitFor();
      assert.deepEqual(await torOptions(), ['iroh', 'tcp']);
      await select().selectOption('tcp'); await verifyQR('tcp');
      fixture.setTor('bootstrapping', 85); await refresh();
      await waitUntil(async () => /85\s*%/.test(await notices()), 'Tor recovery progress was not shown');
      await page.getByText('Synthetic Tor bootstrap timeout', { exact: false }).waitFor({ state: 'detached' });
      await verifyQR('tcp');
      checks.push(`${viewport.width}: failed Tor reports its error and recovery preserves the chosen working transport`);

      fixture.setTor('ready', 100, GENERATED_ONION); await refresh();
      await waitUntil(async () => (await torOptions()).includes('tor'), 'Generated Tor address did not become selectable');
      await verifyQR('tcp');
      const updateCount = fixture.updates.length; const torConfig = structuredClone(fixture.get(FIRST_ID).tor); const irohConfig = structuredClone(fixture.get(FIRST_ID).iroh);
      for (const mode of ['tor', 'iroh', 'tcp', 'tor']) { await select().selectOption(mode); await verifyQR(mode); }
      assert.equal(fixture.updates.length, updateCount); assert.deepEqual(fixture.get(FIRST_ID).tor, torConfig); assert.deepEqual(fixture.get(FIRST_ID).iroh, irohConfig);
      assert.equal(fixture.get(FIRST_ID).status, 'running'); assert.equal(fixture.get(FIRST_ID).iroh_status, 'ready');
      assert.match(await card().locator('.connection-help').innerText(), /Tor-capable client/i);
      checks.push(`${viewport.width}: generated Tor URI becomes scannable alongside Iroh and local TCP without changing transport settings`);

      fixture.setTor('bootstrapping', 10, GENERATED_ONION); await refresh(); await verifyQR('tor');
      await waitUntil(async () => /10\s*%/.test(await notices()), 'Tor progress did not change to 10%');
      await card().getByRole('button', { name: 'Copy', exact: true }).first().focus();
      await page.evaluate(() => {
        window.torPollQR = document.querySelector('img.qr');
        window.torPollURI = document.querySelector('.copy-value code');
        window.torPollFocus = document.activeElement;
        const range = document.createRange(); range.selectNodeContents(window.torPollURI);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        window.torPollSelection = selection.toString();
        window.scrollTo(0, 220); window.torPollScroll = scrollY;
      });
      for (const [status, percent] of [['bootstrapping', 60], ['ready', 100]]) {
        fixture.setTor(status, percent, GENERATED_ONION);
        // Dispatch the refresh without moving pointer focus, matching the
        // interaction state present when a background refresh arrives.
        await refresh({ preserveFocus: true });
        await waitUntil(async () => status === 'ready' ? /Connected to Tor/.test(await notices()) : /60\s*%/.test(await notices()), 'Tor lifecycle notice did not update');
        await verifyQR('tor');
        assert.deepEqual(await page.evaluate(() => ({
          qr: document.querySelector('img.qr') === window.torPollQR,
          uri: document.querySelector('.copy-value code') === window.torPollURI,
          focus: document.activeElement === window.torPollFocus,
          selected: window.getSelection().toString() === window.torPollSelection,
          scroll: scrollY === window.torPollScroll,
        })), { qr: true, uri: true, focus: true, selected: true, scroll: true });
      }
      checks.push(`${viewport.width}: Tor bootstrap and ready updates preserve mounted QR, URI selection, focus and scroll`);
      await page.evaluate(() => window.getSelection().removeAllRanges());
      await screenshot('pairing');
      await context.close();
    }
    assert.deepEqual(errors, []);
    const evidence = {
      checks, browser_errors: errors, funds_sent: false, physical_umbrel: false, actual_tor_process: false,
      frontend_sha256: createHash('sha256').update(await fs.readFile(path.join(root, 'manager/public/app.js'))).digest('hex'),
      pairing_sha256: createHash('sha256').update(await fs.readFile(path.join(root, 'manager/public/pairing.js'))).digest('hex'),
    };
    if (process.env.TOR_EVIDENCE) await fs.writeFile(process.env.TOR_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await browser?.close(); auth.close(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  // Some Playwright/Chrome combinations retain an internal pipe after the
  // awaited browser and server cleanup. Flush the report before this CLI exits.
  process.stdout.write('', () => process.exit(process.exitCode || 0));
});
