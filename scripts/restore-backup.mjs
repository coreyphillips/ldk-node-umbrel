#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { readBackupArchive, restoreBackup } from '../manager/server/backup.mjs';

// A private file supports automation without putting a passphrase in process
// arguments or environment variables. A single trailing line ending is ignored.
async function fromPrivateFile(filename) {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.alloc(1027);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1026 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Passphrase file must be a private regular file owned by the current user, at most 1026 bytes');
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1026 || bytesRead !== stat.size) throw new Error('Passphrase file changed while reading');
    return buffer.subarray(0, bytesRead).toString('utf8').replace(/\r?\n$/, '');
  } finally { buffer.fill(0); await file.close(); }
}

async function promptPassphrase() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Use an interactive terminal or --passphrase-file with a private file');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const prompt = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write('Backup passphrase (hidden): ');
  try {
    return await new Promise((resolve, reject) => {
      prompt.once('SIGINT', () => reject(new Error('Restore cancelled')));
      prompt.once('close', () => reject(new Error('Restore cancelled')));
      prompt.question('', resolve);
    });
  } finally { prompt.close(); process.stderr.write('\n'); }
}

/** Restore an authenticated snapshot offline. Never starts or replaces a wallet. */
export async function main(args = process.argv.slice(2)) {
  if (![2, 4].includes(args.length) || (args.length === 4 && args[2] !== '--passphrase-file')) throw new Error('Usage: node scripts/restore-backup.mjs ARCHIVE NEW_DIRECTORY [--passphrase-file PRIVATE_FILE]');
  const [filename, destination] = args;
  const passphrase = args.length === 4 ? await fromPrivateFile(args[3]) : await promptPassphrase();
  const archive = await readBackupArchive(path.resolve(filename));
  const result = await restoreBackup(archive, passphrase, path.resolve(destination));
  process.stdout.write(`Restored ${result.fileCount} private files from ${result.createdAt}. No wallet was started.\n`);
  process.stdout.write('Keep the original node stopped. Only start this copy if this is the latest snapshot and the original will never run again.\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Restore failed: ${error.message}\n`); process.exitCode = 1; });
}
