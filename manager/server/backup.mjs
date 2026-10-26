import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { failure } from './files.mjs';

// The header is authenticated as GCM additional data. Version 1 accepts only
// the parameters it writes, so untrusted archives cannot choose costly KDFs.
// Node's OpenSSL implementation supplies scrypt and AES-GCM, including tag
// verification. See https://nodejs.org/api/crypto.html and RFC 7914.
const MAGIC = Buffer.from('LDK-NODE-BACKUP', 'ascii');
const PARAMETERS = Buffer.from([1, 1, 16, 8, 1]);
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + PARAMETERS.length + SALT_BYTES + IV_BYTES;
const derive = promisify(scrypt);
let busy = false;

/** Fixed resource bounds for both export and offline restore, before KDF work. */
export const BACKUP_LIMITS = Object.freeze({ dataBytes: 128 * 1024 * 1024, archiveBytes: 256 * 1024 * 1024, entries: 10_000, depth: 32 });

const invalid = () => failure('Invalid or unsupported backup archive', 400, 'BAD_BACKUP');
const tooLarge = () => failure('Backup exceeds the supported size limit. Use the stopped-data backup script for larger installations.', 413, 'BACKUP_TOO_LARGE');
const unsafe = () => failure('Backup refused unsafe or changing files. Stop all writers and check the data directory.', 409, 'UNSAFE_BACKUP_SOURCE');

function passphraseBytes(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) throw failure('Use a backup passphrase of at least 12 characters and at most 1024 UTF-8 bytes', 400, 'BAD_PASSPHRASE');
  const normalized = value.normalize('NFKC');
  if ([...normalized].length < 12 || !normalized.trim() || Buffer.byteLength(normalized) > 1024) throw failure('Use a backup passphrase of at least 12 characters and at most 1024 UTF-8 bytes', 400, 'BAD_PASSPHRASE');
  return Buffer.from(normalized, 'utf8');
}

async function exclusively(action) {
  if (busy) throw failure('Another backup operation is in progress', 409, 'BACKUP_BUSY');
  busy = true;
  try { return await action(); } finally { busy = false; }
}

function excluded(relative) {
  return relative === '.manager.lock' || /^wallets\/[0-9a-f-]{36}\/node\/daemon\.lock$/.test(relative);
}

// Portable path spelling avoids filesystem aliases and ambiguity on restore.
// Native data paths use ASCII names; unexpected names fail closed, never skip.
function validPath(relative) {
  if (typeof relative !== 'string' || relative.length > 1024 || !/^[A-Za-z0-9._/-]+$/.test(relative) || excluded(relative)) return false;
  const pieces = relative.split('/');
  return pieces.length <= BACKUP_LIMITS.depth && pieces.every(piece => piece && piece !== '.' && piece !== '..' && piece.length <= 255 && !piece.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece));
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

// Fixed allocation prevents a concurrently growing file from defeating bounds.
// O_NOFOLLOW covers the final component; callers also reject directory links.
async function readStableFile(file, stat, maximum) {
  if (!stat.isFile() || stat.nlink !== 1) throw unsafe();
  if (stat.size > maximum) throw tooLarge();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(stat, opened)) throw unsafe();
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw unsafe();
      offset += bytesRead;
    }
    if (!sameFile(opened, await handle.stat()) || !sameFile(opened, await fs.lstat(file))) throw unsafe();
    return bytes;
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await handle.close(); }
}

async function snapshot(dataDir) {
  const files = [];
  const aliases = new Set();
  let total = 0;
  async function walk(directory, relative = '') {
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw unsafe();
    for (const name of (await fs.readdir(directory)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const file = path.join(directory, name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw unsafe();
      // Locks encode ownership of live processes, not recovery state. Keep all
      // other files, including SQLite journals, channel monitors, keys and logs.
      if (excluded(child) && stat.isFile()) continue;
      if (!validPath(child)) throw unsafe();
      if (aliases.has(child.toLowerCase())) throw unsafe();
      aliases.add(child.toLowerCase());
      if (files.length >= BACKUP_LIMITS.entries) throw tooLarge();
      if (stat.isDirectory()) {
        files.push({ path: child, type: 'directory' });
        await walk(file, child);
      } else {
        const bytes = await readStableFile(file, stat, BACKUP_LIMITS.dataBytes - total);
        try { total += bytes.length; files.push({ path: child, type: 'file', data: bytes.toString('base64') }); }
        finally { bytes.fill(0); }
      }
    }
    const after = await fs.lstat(directory);
    if (!after.isDirectory() || !sameFile(before, after)) throw unsafe();
  }
  await walk(path.resolve(dataDir));
  return { format: 1, kind: 'ldk-node-umbrel-full-data', createdAt: new Date().toISOString(), files };
}

async function keyFor(passphrase, salt) {
  return derive(passphrase, salt, 32, { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

/**
 * Encrypt a complete stopped data directory, including channel state and keys.
 * The caller must hold the manager lifecycle gate and stop every native node
 * and Iroh or Tor writer before calling. Links, special files and oversized snapshots
 * are refused. No plaintext temporary files or passphrases are written to disk.
 * JavaScript strings are garbage collected and cannot be reliably zeroized.
 */
export async function createBackup(dataDir, passphrase) {
  return exclusively(async () => {
    const secret = passphraseBytes(passphrase);
    let key; let plaintext;
    try {
      const payload = await snapshot(dataDir);
      plaintext = Buffer.from(JSON.stringify(payload));
      if (plaintext.length + HEADER_BYTES + TAG_BYTES > BACKUP_LIMITS.archiveBytes) throw tooLarge();
      const salt = randomBytes(SALT_BYTES); const iv = randomBytes(IV_BYTES);
      const header = Buffer.concat([MAGIC, PARAMETERS, salt, iv]);
      key = await keyFor(secret, salt);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(header);
      return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    } finally { secret.fill(0); key?.fill(0); plaintext?.fill(0); }
  });
}

function validatePayload(payload) {
  if (!payload || payload.format !== 1 || payload.kind !== 'ldk-node-umbrel-full-data' || typeof payload.createdAt !== 'string' || payload.createdAt.length !== 24 || !Number.isFinite(Date.parse(payload.createdAt)) || !Array.isArray(payload.files) || payload.files.length > BACKUP_LIMITS.entries) throw invalid();
  const entries = new Map(); const aliases = new Set();
  let total = 0;
  try {
    for (const entry of payload.files) {
      if (!entry || !validPath(entry.path) || !['file', 'directory'].includes(entry.type)) throw invalid();
      const alias = entry.path.toLowerCase();
      if (aliases.has(alias)) throw invalid();
      aliases.add(alias);
      let bytes;
      if (entry.type === 'file') {
        if (typeof entry.data !== 'string' || entry.data.length % 4 || entry.data.length > 4 * Math.ceil((BACKUP_LIMITS.dataBytes - total) / 3)) throw invalid();
        bytes = Buffer.from(entry.data, 'base64');
        if (bytes.toString('base64') !== entry.data || bytes.length > BACKUP_LIMITS.dataBytes - total) { bytes.fill(0); throw invalid(); }
        total += bytes.length;
      } else if (entry.data !== undefined) throw invalid();
      entries.set(entry.path, { type: entry.type, bytes });
    }
    for (const name of entries.keys()) {
      const pieces = name.split('/'); pieces.pop();
      while (pieces.length) {
        if (entries.get(pieces.join('/'))?.type !== 'directory') throw invalid();
        pieces.pop();
      }
    }
    return { entries, createdAt: payload.createdAt };
  } catch (error) { for (const { bytes } of entries.values()) bytes?.fill(0); throw error; }
}

async function openBackup(archive, passphrase) {
  if (!Buffer.isBuffer(archive) || archive.length < HEADER_BYTES + TAG_BYTES) throw invalid();
  if (archive.length > BACKUP_LIMITS.archiveBytes) throw tooLarge();
  if (!archive.subarray(0, MAGIC.length).equals(MAGIC) || !archive.subarray(MAGIC.length, MAGIC.length + PARAMETERS.length).equals(PARAMETERS)) throw invalid();
  const secret = passphraseBytes(passphrase);
  let key; let plaintext; let unauthenticated;
  try {
    const saltAt = MAGIC.length + PARAMETERS.length;
    const salt = archive.subarray(saltAt, saltAt + SALT_BYTES);
    const iv = archive.subarray(saltAt + SALT_BYTES, HEADER_BYTES);
    key = await keyFor(secret, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(archive.subarray(0, HEADER_BYTES));
    decipher.setAuthTag(archive.subarray(archive.length - TAG_BYTES));
    try {
      unauthenticated = decipher.update(archive.subarray(HEADER_BYTES, archive.length - TAG_BYTES));
      plaintext = Buffer.concat([unauthenticated, decipher.final()]);
    } catch { throw failure('The backup passphrase is incorrect or the archive is damaged', 400, 'BACKUP_AUTH_FAILED'); }
    let payload;
    try { payload = JSON.parse(plaintext.toString('utf8')); } catch { throw invalid(); }
    return validatePayload(payload);
  } finally { secret.fill(0); key?.fill(0); plaintext?.fill(0); unauthenticated?.fill(0); }
}

/** Read a bounded regular archive file without following links or file growth. */
export async function readBackupArchive(filename) {
  return readStableFile(filename, await fs.lstat(filename), BACKUP_LIMITS.archiveBytes);
}

/**
 * Authenticate and restore an archive to a new directory. No process starts.
 * Existing destinations, links, path traversal and file/directory collisions
 * are refused. Files are mode 0600 and directories 0700. The caller must retire
 * the original wallet and use its latest stopped snapshot before starting this
 * restored copy: running duplicate or stale Lightning state can lose funds.
 */
export async function restoreBackup(archive, passphrase, destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw failure('Choose an absolute new restore directory', 400, 'BAD_DESTINATION');
  return exclusively(async () => {
    const { entries, createdAt } = await openBackup(archive, passphrase);
    let created = false; let identity;
    try {
      // A nonrecursive mkdir is the no-overwrite gate, including empty folders
      // and dangling links. The parent must already exist and be user-trusted.
      try { await fs.mkdir(destination, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') throw failure('Restore destination already exists. Choose a new directory.', 409, 'DESTINATION_EXISTS'); throw error; }
      created = true; identity = await fs.lstat(destination);
      const sorted = [...entries].sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b));
      for (const [name, entry] of sorted) {
        const target = path.join(destination, ...name.split('/'));
        if (entry.type === 'directory') await fs.mkdir(target, { mode: 0o700 });
        else {
          const file = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(entry.bytes); await file.sync(); } finally { await file.close(); }
        }
      }
      const directories = sorted.filter(([, entry]) => entry.type === 'directory').map(([name]) => path.join(destination, name));
      for (const directory of [...directories.reverse(), destination, path.dirname(destination)]) {
        const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
      }
      return { fileCount: [...entries.values()].filter(entry => entry.type === 'file').length, createdAt };
    } catch (error) {
      if (created) {
        const current = await fs.lstat(destination).catch(() => null);
        if (current?.isDirectory() && current.dev === identity?.dev && current.ino === identity?.ino) await fs.rm(destination, { recursive: true, force: true });
      }
      throw error;
    } finally { for (const { bytes } of entries.values()) bytes?.fill(0); }
  });
}
