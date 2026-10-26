import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { failure } from './files.mjs';

export const NATIVE_LOG_LIMIT = 256 * 1024;
export const PROCESS_LOG_LIMIT = 64 * 1024;
const unsafe = () => failure('Native logs are unavailable because this wallet has an unsafe log path.', 409, 'WALLET_LOG_PATH_UNSAFE');
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077);
const privateFile = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077);

export function redactDiagnostics(value, secrets = []) {
  let text = String(value).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const secret of secrets) if (secret) {
    text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
  }
  return text.replace(/\b[0-9a-f]{64}\b/gi, '[redacted]')
    .replace(/\b(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]{90,}/g, '[redacted]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, '$1[redacted]@')
    .replace(/\b(password|passphrase|mnemonic|(?:keys[_ -]?)?seed|secret(?:[_ -]?key)?|private[_ -]?key|authorization|api[_ -]?key)\s*["']?\s*[:=]\s*[^\n]*/gi, '$1=[redacted]');
}

function completeTail(buffer, truncated) {
  // Never expose a secret suffix or partial UTF-8 character cut at the limit.
  if (truncated) {
    const newline = buffer.indexOf(10);
    buffer = newline < 0 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
  }
  // A writer can be halfway through appending a secret when we take a snapshot.
  // Wait for the terminating newline before showing that record.
  buffer = buffer.subarray(0, buffer.lastIndexOf(10) + 1);
  return buffer.toString('utf8');
}

export function processDiagnostics(chunks, secrets = []) {
  const buffer = Buffer.from(chunks.join(''), 'utf8');
  const truncated = buffer.length > PROCESS_LOG_LIMIT;
  return redactedTail(buffer.subarray(-PROCESS_LOG_LIMIT), PROCESS_LOG_LIMIT, truncated, secrets);
}

function redactedTail(buffer, limit, truncated, secrets) {
  const redacted = Buffer.from(redactDiagnostics(completeTail(buffer, truncated), secrets));
  const expanded = redacted.length > limit;
  return { text: completeTail(redacted.subarray(-limit), expanded), truncated: truncated || expanded };
}

/** Read only the native default log, never a caller-supplied path or the wallet keys/config. */
export async function nativeDiagnostics(dataDir, id, secrets = []) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw unsafe();
  const directories = [path.resolve(dataDir)];
  for (const part of ['wallets', id, 'node']) directories.push(path.join(directories.at(-1), part));
  const snapshots = [];
  const directoryHandles = [];
  let handle;
  try {
    for (const directory of directories) {
      const stat = await fs.lstat(directory);
      if (!privateDirectory(stat)) throw unsafe();
      snapshots.push(stat);
      // Production runs on Linux. Anchor child opens to already-verified
      // directory descriptors so concurrent renames cannot redirect a read.
      if (process.platform === 'linux') {
        const parent = directoryHandles.at(-1);
        const location = parent ? `/proc/self/fd/${parent.fd}/${path.basename(directory)}` : directory;
        const opened = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        directoryHandles.push(opened);
        if (!privateDirectory(await opened.stat()) || !sameFile(stat, await opened.stat())) throw unsafe();
      }
    }
    const file = path.join(directories.at(-1), 'ldk_node.log');
    const readPath = directoryHandles.length ? `/proc/self/fd/${directoryHandles.at(-1).fd}/ldk_node.log` : file;
    const before = await fs.lstat(readPath);
    if (!privateFile(before)) throw unsafe();
    handle = await fs.open(readPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!privateFile(opened) || !sameFile(before, opened)) throw unsafe();
    const verifyPath = async () => {
      for (let index = 0; index < directories.length; index++) {
        const stat = await fs.lstat(directories[index]);
        if (!privateDirectory(stat) || !sameFile(stat, snapshots[index])) throw unsafe();
      }
      const current = await fs.lstat(file);
      if (!privateFile(current) || !sameFile(current, opened)) throw unsafe();
    };
    // Identity checks on the open file and each private ancestor prevent a path
    // replacement from turning this fixed wallet log into another wallet's file.
    await verifyPath();
    const truncated = opened.size > NATIVE_LOG_LIMIT;
    const length = Math.min(opened.size, NATIVE_LOG_LIMIT);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, opened.size - length));
    await verifyPath();
    return { ...redactedTail(buffer.subarray(0, bytesRead), NATIVE_LOG_LIMIT, truncated, secrets), available: true };
  } catch (error) {
    if (error.code === 'ENOENT' && !handle) return { text: '', available: false, truncated: false };
    if (error.code === 'WALLET_LOG_PATH_UNSAFE') throw error;
    // Filesystem messages can contain private server paths. Keep them out of API errors.
    throw failure('Native logs could not be read. Refresh the page and try again.', 503, 'WALLET_LOG_UNAVAILABLE');
  } finally {
    await handle?.close();
    await Promise.all(directoryHandles.map(directory => directory.close()));
  }
}
