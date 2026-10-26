import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { BACKUP_LIMITS, createBackup, readBackupArchive, restoreBackup } from './backup.mjs';

const PASSPHRASE = 'a long offline test passphrase';
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const fixture = {
  'auth.json': Buffer.from('{"password_hash":"test-only-hash"}\n'),
  'wallets.json': Buffer.from(JSON.stringify([{ id: ID, autostart: true, name: 'Test wallet' }])),
  [`wallets/${ID}/node/keys_seed`]: Buffer.alloc(64, 0x42),
  [`wallets/${ID}/node/ldk_node_data.sqlite`]: Buffer.from([0, 1, 0, 255, 18, 200]),
  [`wallets/${ID}/node/ldk_node_data.sqlite-wal`]: Buffer.from('test channel update journal'),
  [`wallets/${ID}/node/monitors/monitor`]: Buffer.from('test channel monitor'),
  [`wallets/${ID}/iroh.key`]: Buffer.from('test-only-iroh-key'),
};

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ldk-backup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function source(t) {
  const root = await directory(t); const data = path.join(root, 'data');
  await fs.mkdir(data, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(fixture)) {
    await fs.mkdir(path.dirname(path.join(data, name)), { recursive: true });
    await fs.writeFile(path.join(data, name), bytes, { mode: 0o600 });
  }
  await fs.mkdir(path.join(data, 'empty'));
  await fs.writeFile(path.join(data, '.manager.lock'), 'test lock');
  await fs.writeFile(path.join(data, `wallets/${ID}/node/daemon.lock`), 'test lock');
  return { root, data };
}

// Forged authenticated fixtures exercise parser validation behind GCM. This
// fixed test key and salt never enter production or represent real funds.
const testSalt = Buffer.alloc(16, 0x11);
const testKey = scryptSync(PASSPHRASE, testSalt, 32, { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
function forged(files, overrides = {}) {
  const header = Buffer.concat([Buffer.from('LDK-NODE-BACKUP'), Buffer.from([1, 1, 16, 8, 1]), testSalt, randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', testKey, header.subarray(header.length - 12)); cipher.setAAD(header);
  const payload = { format: 1, kind: 'ldk-node-umbrel-full-data', createdAt: '2026-10-26T00:00:00.000Z', files, ...overrides };
  return Buffer.concat([header, cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
}

test('full backup round trip preserves keys, auth, channels and journals with private restored modes', async t => {
  const { root, data } = await source(t);
  const archive = await createBackup(data, PASSPHRASE);
  const another = await createBackup(data, PASSPHRASE);
  assert.notDeepEqual(archive, another, 'each export uses fresh salt and IV');
  for (const bytes of Object.values(fixture)) if (bytes.length > 16) assert.equal(archive.includes(bytes), false);
  const destination = path.join(root, 'restored');
  const result = await restoreBackup(archive, PASSPHRASE, destination);
  assert.equal(result.fileCount, Object.keys(fixture).length);
  for (const [name, bytes] of Object.entries(fixture)) {
    assert.deepEqual(await fs.readFile(path.join(destination, name)), bytes, name);
    assert.equal((await fs.stat(path.join(destination, name))).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(destination, 'empty'))).mode & 0o777, 0o700);
  await assert.rejects(fs.stat(path.join(destination, '.manager.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(destination, `wallets/${ID}/node/daemon.lock`)), { code: 'ENOENT' });
});

test('passphrases are validated before files are read and normalize consistently', async t => {
  for (const value of [undefined, {}, 'short', ' '.repeat(12), 'x'.repeat(1025), '🍋'.repeat(257)]) await assert.rejects(createBackup('/does-not-exist', value), { code: 'BAD_PASSPHRASE' });
  const { root, data } = await source(t);
  const archive = await createBackup(data, 'Cafe\u0301 private backup passphrase');
  await restoreBackup(archive, 'Caf\u00e9 private backup passphrase', path.join(root, 'restored'));
});

test('wrong passphrases, modified salt, ciphertext and authentication tags write nothing', async t => {
  const { root, data } = await source(t); const archive = await createBackup(data, PASSPHRASE);
  const destination = path.join(root, 'restored');
  await assert.rejects(restoreBackup(archive, 'incorrect but long enough', destination), { code: 'BACKUP_AUTH_FAILED' });
  for (const index of [20, 48, archive.length - 1]) {
    const corrupt = Buffer.from(archive); corrupt[index] ^= 1;
    await assert.rejects(restoreBackup(corrupt, PASSPHRASE, destination), { code: 'BACKUP_AUTH_FAILED' });
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
  for (const invalid of [Buffer.alloc(2), Buffer.from('not an archive'), Buffer.from(archive)]) {
    if (invalid.length === archive.length) invalid[16] = 255;
    await assert.rejects(restoreBackup(invalid, PASSPHRASE, destination), { code: 'BAD_BACKUP' });
  }
});

test('only one export or restore consumes memory and KDF work at a time', async t => {
  const { data } = await source(t);
  const first = createBackup(data, PASSPHRASE);
  await assert.rejects(createBackup(data, PASSPHRASE), { code: 'BACKUP_BUSY' });
  await first;
  await assert.rejects(createBackup(data, 'short'), { code: 'BAD_PASSPHRASE' });
  assert.ok(await createBackup(data, PASSPHRASE), 'a refused operation releases the guard');
});

test('source symlinks, directory links and hard links fail closed', async t => {
  const { root, data } = await source(t);
  const link = path.join(data, 'alias');
  await fs.symlink(path.join(data, 'auth.json'), link);
  await assert.rejects(createBackup(data, PASSPHRASE), { code: 'UNSAFE_BACKUP_SOURCE' });
  await fs.unlink(link); await fs.symlink(path.join(data, 'wallets'), link);
  await assert.rejects(createBackup(data, PASSPHRASE), { code: 'UNSAFE_BACKUP_SOURCE' });
  await fs.unlink(link); await fs.link(path.join(data, 'auth.json'), link);
  await assert.rejects(createBackup(data, PASSPHRASE), { code: 'UNSAFE_BACKUP_SOURCE' });
  await fs.unlink(link);
  const alias = path.join(root, 'alias'); await fs.symlink(data, alias);
  await assert.rejects(createBackup(alias, PASSPHRASE), { code: 'UNSAFE_BACKUP_SOURCE' });
});

test('oversized sparse data and archive files are refused without reading their contents', async t => {
  const { root, data } = await source(t);
  const large = path.join(data, 'large'); const handle = await fs.open(large, 'wx');
  await handle.truncate(BACKUP_LIMITS.dataBytes + 1); await handle.close();
  await assert.rejects(createBackup(data, PASSPHRASE), { code: 'BACKUP_TOO_LARGE' });
  const archive = path.join(root, 'large.ldkbackup'); const out = await fs.open(archive, 'wx');
  await out.truncate(BACKUP_LIMITS.archiveBytes + 1); await out.close();
  await assert.rejects(readBackupArchive(archive), { code: 'BACKUP_TOO_LARGE' });
});

test('authenticated traversal, aliases, malformed bytes and hierarchy conflicts never create the destination', async t => {
  const root = await directory(t); const destination = path.join(root, 'restored');
  const file = name => ({ path: name, type: 'file', data: 'YQ==' });
  const cases = [
    [file('../escape')], [file('/absolute')], [file('C:/file')], [file('a\\b')], [file('a//b')], [file('a/./b')],
    [file('.manager.lock')], [file('trailing.')], [file('NUL.txt')], [file('a'), file('a')], [file('a'), file('A')],
    [file('a'), file('a/b')], [file('missing/parent')], [{ path: 'a', type: 'link', data: 'target' }],
    [{ path: 'a', type: 'directory', data: '' }], [{ ...file('a'), data: '!!!!' }], [{ ...file('a'), data: 'YQ=' }],
    [{ ...file('a'), data: 'YR==' }], [file('a/'.repeat(BACKUP_LIMITS.depth) + 'b')],
  ];
  for (const entries of cases) {
    await assert.rejects(restoreBackup(forged(entries), PASSPHRASE, destination), { code: 'BAD_BACKUP' }, JSON.stringify(entries));
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  }
  await assert.rejects(restoreBackup(forged([], { format: 2 }), PASSPHRASE, destination), { code: 'BAD_BACKUP' });
  await assert.rejects(restoreBackup(forged(Array.from({ length: BACKUP_LIMITS.entries + 1 }, (_, i) => file(`file${i}`))), PASSPHRASE, destination), { code: 'BAD_BACKUP' });
});

test('restore refuses existing directories and symlinks without changing them', async t => {
  const { root, data } = await source(t); const archive = await createBackup(data, PASSPHRASE);
  await assert.rejects(restoreBackup(archive, PASSPHRASE, data), { code: 'DESTINATION_EXISTS' });
  assert.deepEqual(await fs.readFile(path.join(data, 'auth.json')), fixture['auth.json']);
  const empty = path.join(root, 'empty-destination'); await fs.mkdir(empty);
  await assert.rejects(restoreBackup(archive, PASSPHRASE, empty), { code: 'DESTINATION_EXISTS' });
  const link = path.join(root, 'link'); await fs.symlink(data, link);
  await assert.rejects(restoreBackup(archive, PASSPHRASE, link), { code: 'DESTINATION_EXISTS' });
  await assert.rejects(restoreBackup(archive, PASSPHRASE, 'relative'), { code: 'BAD_DESTINATION' });
});

test('a restore write failure removes partial output and permits a clean retry', async t => {
  const { root, data } = await source(t); const archive = await createBackup(data, PASSPHRASE);
  const destination = path.join(root, 'restored');
  const realOpen = fs.open.bind(fs);
  const mocked = t.mock.method(fs, 'open', async (filename, ...args) => {
    if (filename === path.join(destination, 'wallets.json')) throw Object.assign(new Error('Test disk full'), { code: 'ENOSPC' });
    return realOpen(filename, ...args);
  });
  await assert.rejects(restoreBackup(archive, PASSPHRASE, destination), { code: 'ENOSPC' });
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  mocked.mock.restore();
  await restoreBackup(archive, PASSPHRASE, destination);
  assert.deepEqual(await fs.readFile(path.join(destination, 'wallets.json')), fixture['wallets.json']);
});

test('random binary file collections round trip without text conversion or truncation', async t => {
  const root = await directory(t); const data = path.join(root, 'data'); await fs.mkdir(data);
  const values = [0, 1, 2, 3, 255, 4096, 65537].map(length => randomBytes(length));
  for (const [i, value] of values.entries()) await fs.writeFile(path.join(data, `file${i}`), value);
  const archive = await createBackup(data, PASSPHRASE); const destination = path.join(root, 'restored');
  await restoreBackup(archive, PASSPHRASE, destination);
  for (const [i, value] of values.entries()) assert.deepEqual(await fs.readFile(path.join(destination, `file${i}`)), value);
});

test('offline CLI restores with a private passphrase file and refuses public passphrase files', async t => {
  const { root, data } = await source(t); const archive = path.join(root, 'snapshot.ldkbackup');
  await fs.writeFile(archive, await createBackup(data, PASSPHRASE));
  const secret = path.join(root, 'passphrase'); await fs.writeFile(secret, `${PASSPHRASE}\n`, { mode: 0o600 });
  const destination = path.join(root, 'restored');
  const script = fileURLToPath(new URL('../../scripts/restore-backup.mjs', import.meta.url));
  const invoke = target => spawnSync(process.execPath, [script, archive, target, '--passphrase-file', secret], { encoding: 'utf8' });
  const result = invoke(destination);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /No wallet was started/);
  assert.equal((result.stdout + result.stderr).includes(PASSPHRASE), false);
  assert.deepEqual(await fs.readFile(path.join(destination, `wallets/${ID}/node/keys_seed`)), fixture[`wallets/${ID}/node/keys_seed`]);
  await fs.chmod(secret, 0o644);
  const refused = invoke(path.join(root, 'refused'));
  assert.equal(refused.status, 1); assert.match(refused.stderr, /private regular file/);
});
