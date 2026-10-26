// Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core package.
// Uses only disposable wallets, fake channel bytes and a temporary data directory.
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
  const { restoreBackup } = await import(`${root}/manager/server/backup.mjs`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-recovery-browser-'));
  const data = path.join(directory, 'data'); await fs.mkdir(data, { mode: 0o700 });
  const password = 'disposable-browser-login-password'; const backupPassword = 'disposable-backup-password';
  const auth = new Authentication({ dataDir: data }); await auth.initialize(undefined, password);
  const wallets = new WalletManager({ dataDir: data, binary: '/unused' }); await wallets.initialize();
  const config = { name: 'Recovery fixture', network: 'regtest', autostart: false, chain_source: { type: 'electrum', url: 'tcp://127.0.0.1:50001' } };
  const wallet = await wallets.create(config);
  const legacy = await wallets.create({ ...config, name: 'Legacy fixture' });
  // Simulate a pre-mnemonic installation without changing any live wallet.
  await fs.unlink(path.join(wallets.directory(legacy.id), 'mnemonic'));
  delete wallets.get(legacy.id).recovery_kind; await wallets.persist();
  await fs.writeFile(path.join(wallets.directory(wallet.id), 'node', 'fixture-channel-state'), 'disposable-channel-state', { mode: 0o600 });
  const server = createServer({ auth, wallets, allowedHosts: ['127.0.0.1'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser; const checks = []; const errors = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, acceptDownloads: true }); const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin); await page.getByLabel('Dashboard password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'Recovery fixture', exact: true }).click();
      if (viewport.width < 760) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('button', { name: /Settings$/ }).click();
      await page.getByRole('button', { name: 'Recovery phrase', exact: true }).click();
      assert.equal(await page.locator('.recovery-words').count(), 0);
      await page.getByRole('button', { name: 'Reveal recovery phrase' }).click();
      await page.locator('.recovery-words li').last().waitFor();
      assert.equal(await page.locator('.recovery-words li').count(), 24);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      // Exercise the HTTP clipboard fallback and ensure the hidden helper is removed.
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); document.execCommand = action => { window.copyWordCount = document.querySelector('.clipboard-helper').value.split(' ').length; return action === 'copy'; }; });
      await page.getByRole('button', { name: 'Copy phrase', exact: true }).click();
      assert.equal(await page.evaluate(() => window.copyWordCount), 24); assert.equal(await page.locator('.clipboard-helper').count(), 0);
      assert.equal(await page.evaluate(() => Object.keys(sessionStorage).length), 1);
      await page.getByRole('button', { name: 'I have saved it' }).click();
      await page.waitForFunction(() => !document.querySelector('#dialog').open && !document.querySelector('.recovery-words'));
      checks.push(`${viewport.width}: numbered phrase, clipboard fallback, mobile fit and close cleanup`);
      await page.getByRole('button', { name: 'Recovery phrase', exact: true }).click();
      await page.getByRole('button', { name: 'Reveal recovery phrase' }).click(); await page.locator('.recovery-words').waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      assert.equal(await page.locator('.recovery-words').count(), 0);
      checks.push(`${viewport.width}: page exit clears displayed phrase`);
      await page.getByRole('button', { name: 'Recovery phrase', exact: true }).click();
      await page.evaluate(() => { window.originalTimeout = window.setTimeout; window.setTimeout = (fn, ms, ...args) => window.originalTimeout(fn, ms === 60000 ? 100 : ms, ...args); });
      await page.getByRole('button', { name: 'Reveal recovery phrase' }).click();
      await page.locator('#dialog').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('.recovery-words').count(), 0);
      await page.evaluate(() => { window.setTimeout = window.originalTimeout; });
      checks.push(`${viewport.width}: automatic expiry removes phrase and closes dialog`);
      await page.getByRole('button', { name: 'Back up all wallets', exact: true }).click();
      await page.getByLabel('Backup password', { exact: true }).fill(backupPassword);
      await page.getByLabel('Confirm backup password', { exact: true }).fill('a-different-backup-password');
      await page.getByLabel('I agree to stop all wallets and keep the backup private').check();
      await page.getByRole('button', { name: 'Stop wallets and download backup' }).click();
      await page.getByText('Backup passwords do not match', { exact: true }).waitFor();
      await page.getByLabel('Confirm backup password', { exact: true }).fill(backupPassword);
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Stop wallets and download backup' }).click();
      const download = await downloadEvent; const archive = await fs.readFile(await download.path());
      const restored = path.join(directory, `restored-${viewport.width}`); await restoreBackup(archive, backupPassword, restored);
      assert.equal(await fs.readFile(path.join(restored, 'wallets', wallet.id, 'node', 'fixture-channel-state'), 'utf8'), 'disposable-channel-state');
      assert.equal(archive.includes(Buffer.from('disposable-channel-state')), false);
      assert.ok(wallets.list().every(wallet => wallet.status === 'stopped'));
      await page.waitForFunction(() => !document.querySelector('#dialog').open && !document.querySelector('#field-backup_password'));
      checks.push(`${viewport.width}: password confirmation, encrypted download, full channel-state restore, secret field cleanup`);
      if (viewport.width < 760) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByLabel('Select wallet').selectOption(legacy.id);
      if (viewport.width < 760) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('button', { name: /Settings$/ }).click();
      await page.getByRole('button', { name: 'Recovery phrase', exact: true }).click();
      await page.getByText('This existing wallet uses a binary seed.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Reveal recovery phrase' }).count(), 0);
      checks.push(`${viewport.width}: legacy wallet preserves identity and explains full backup`);
      await context.close();
    }
    assert.deepEqual(errors, []);
    const evidence = { version: '0.1.4', checks, browser_errors: errors, funds_sent: false, physical_umbrel: false, frontend_sha256: createHash('sha256').update(await fs.readFile(path.join(root, 'manager/public/app.js'))).digest('hex') };
    if (process.env.RECOVERY_EVIDENCE) await fs.writeFile(process.env.RECOVERY_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally { await browser?.close(); auth.close(); await wallets.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
