// Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core package.
// All wallet files and log content are disposable test fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

(async () => {
  const root = path.resolve(__dirname, '..');
  const { Authentication } = await import(`${root}/manager/server/auth.mjs`);
  const { WalletManager } = await import(`${root}/manager/server/wallets.mjs`);
  const { createServer } = await import(`${root}/manager/server/index.mjs`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-log-browser-'));
  const auth = new Authentication({ dataDir: directory });
  const password = 'disposable-logs-browser-password';
  await auth.initialize(undefined, password);
  const wallets = new WalletManager({ dataDir: directory, binary: '/unused' }); await wallets.initialize();
  const config = { name: 'Logs fixture', network: 'regtest', autostart: false, chain_source: { type: 'electrum', url: 'tcp://127.0.0.1:50001' } };
  const wallet = await wallets.create(config);
  const empty = await wallets.create({ ...config, name: 'Empty fixture' });
  const logPath = path.join(wallets.directory(wallet.id), 'node/ldk_node.log');
  const secret = 'a'.repeat(64);
  const nativeText = `INFO Test native forwarding\nWARN payment_hash=${secret}\n<script>window.logInjected = true</script>\n`;
  await fs.writeFile(logPath, nativeText, { mode: 0o600 });
  wallets.runtime.set(wallet.id, { status: 'stopped', logs: ['INFO Test process diagnostic\n'] });
  const server = createServer({ auth, wallets, allowedHosts: ['127.0.0.1', 'wallet-logs.test'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://wallet-logs.test:${server.address().port}`;
  let browser; const checks = []; const errors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-proxy-server', '--host-resolver-rules=MAP wallet-logs.test 127.0.0.1'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await fs.writeFile(logPath, nativeText, { mode: 0o600 });
      const context = await browser.newContext({ viewport, acceptDownloads: true }); const page = await context.newPage();
      page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
      const sidebar = async () => { if (!await page.getByLabel('Select wallet').isVisible()) await page.getByRole('button', { name: 'Open navigation' }).click(); };
      const logs = async () => { await sidebar(); await page.getByRole('button', { name: /Logs$/ }).click(); };
      await page.goto(origin);
      await page.getByLabel('Dashboard password').fill(password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'Logs fixture', exact: true }).click(); await logs();
      await page.getByText('Latest log snapshot loaded.', { exact: true }).waitFor();
      const expected = (await wallets.logs(wallet.id)).text;
      assert.equal(await page.locator('pre.log').first().textContent(), (await wallets.logs(wallet.id)).native.text);
      assert.equal(await page.locator('pre.log').last().textContent(), 'INFO Test process diagnostic\n');
      assert.equal(await page.evaluate(() => window.logInjected), undefined);
      assert.equal(await page.locator('body').textContent().then(value => value.includes(secret)), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      checks.push(`${viewport.width}: native and process logs, literal HTML, redaction and mobile fit`);

      // A non-localhost HTTP origin has no Clipboard API. Exercise the real
      // document.execCommand fallback, observing its copy event without replacing it.
      assert.equal(await page.evaluate(() => window.isSecureContext), false);
      assert.equal(await page.evaluate(() => navigator.clipboard === undefined), true);
      await page.evaluate(() => document.addEventListener('copy', () => { window.copiedLogText = document.querySelector('.clipboard-helper')?.value; }));
      await page.getByRole('button', { name: 'Copy logs', exact: true }).click();
      await page.getByText('Copied', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.copiedLogText), expected);
      assert.equal(await page.locator('.clipboard-helper').count(), 0);
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download logs', exact: true }).click();
      const download = await downloadEvent;
      assert.match(download.suggestedFilename(), /^ldk-node-[0-9a-f-]{36}-logs-[A-Za-z0-9.-]+\.txt$/);
      assert.equal(await fs.readFile(await download.path(), 'utf8'), expected);
      checks.push(`${viewport.width}: real HTTP clipboard fallback and matching plain-text download`);

      await page.evaluate(() => { window.savedLog = document.querySelector('pre.log'); });
      const backgroundPoll = page.waitForResponse(response => new URL(response.url()).pathname === '/api/wallets');
      await backgroundPoll;
      assert.equal(await page.evaluate(() => window.savedLog === document.querySelector('pre.log')), true);
      await fs.appendFile(logPath, 'INFO New native log after snapshot\n');
      assert.equal(await page.locator('pre.log').first().textContent().then(value => value.includes('after snapshot')), false);
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByText('INFO New native log after snapshot', { exact: false }).waitFor();
      checks.push(`${viewport.width}: background polling preserves snapshot and explicit Refresh loads new logs`);

      if (process.env.LOGS_SCREENSHOTS) {
        await fs.mkdir(process.env.LOGS_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.LOGS_SCREENSHOTS, `logs-${viewport.width}.png`), fullPage: true });
      }
      await sidebar(); await page.getByLabel('Select wallet').selectOption(empty.id); await logs();
      await page.getByText('No native log yet. Start this wallet to create it.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Copy logs', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Download logs', exact: true }).isDisabled(), true);
      assert.equal(await page.locator('body').textContent().then(value => value.includes('Test native forwarding')), false);
      checks.push(`${viewport.width}: switching wallets clears previous logs and disables empty exports`);

      await sidebar(); await page.getByLabel('Select wallet').selectOption(wallet.id);
      let release; const gate = new Promise(resolve => { release = resolve; });
      let requested; const started = new Promise(resolve => { requested = resolve; });
      await page.route(`**/api/wallets/${wallet.id}/logs`, async route => {
        const body = JSON.stringify(await wallets.logs(wallet.id)); requested(); await gate;
        await route.fulfill({ status: 200, contentType: 'application/json', body });
      });
      await logs(); await started;
      assert.equal(await page.getByRole('button', { name: 'Copy logs', exact: true }).isDisabled(), true);
      await sidebar(); await page.getByLabel('Select wallet').selectOption(empty.id); await logs();
      release();
      await page.getByText('No native log yet. Start this wallet to create it.', { exact: true }).waitFor();
      assert.equal(await page.locator('body').textContent().then(value => value.includes('Test native forwarding')), false);
      assert.equal(await page.getByRole('button', { name: 'Download logs', exact: true }).isDisabled(), true);
      checks.push(`${viewport.width}: late log responses cannot populate another wallet`);
      await context.close();
    }
    assert.deepEqual(errors, []);
    const evidence = { checks, browser_errors: errors, funds_sent: false, physical_umbrel: false, frontend_sha256: createHash('sha256').update(await fs.readFile(path.join(root, 'manager/public/app.js'))).digest('hex') };
    if (process.env.LOGS_EVIDENCE) await fs.writeFile(process.env.LOGS_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await browser?.close(); auth.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
