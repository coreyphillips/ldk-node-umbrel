import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { generateMnemonic, mnemonicToSeedWebcrypto, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { failure } from './files.mjs';

async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// New wallet files never replace existing state, including after a partial failure.
async function writeNew(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function checkDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Unsafe recovery directory');
}

async function readPrivate(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || (stat.mode & 0o077)) throw new Error('Unsafe recovery file');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit || bytesRead !== stat.size) { bytes.fill(0); throw new Error('Invalid recovery file'); }
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/**
 * Initialize only a new wallet directory with a 24-word English BIP39 mnemonic.
 * The caller must serialize registry creation and provide a private parent. This
 * refuses existing paths, persists all identity files before registration, and
 * never derives replacement words for an existing seed. See BIP-0039 and
 * https://github.com/paulmillr/scure-bip39 for the reviewed derivation API.
 */
export async function createRecovery(directory, network) {
  if (!['bitcoin', 'testnet', 'signet', 'regtest'].includes(network)) throw new Error('Invalid recovery network');
  await checkDirectory(path.dirname(directory));
  await fs.mkdir(directory, { mode: 0o700 });
  const node = path.join(directory, 'node');
  await fs.mkdir(node, { mode: 0o700 });
  let mnemonic = generateMnemonic(wordlist, 256);
  const seed = await mnemonicToSeedWebcrypto(mnemonic, '');
  try {
    await writeNew(path.join(node, 'keys_seed'), seed);
    // The native daemon checks this binding before opening any preexisting store.
    await writeNew(path.join(node, 'daemon-network.json'), `${JSON.stringify({ version: 1, network })}\n`);
    await writeNew(path.join(directory, 'mnemonic'), `${mnemonic}\n`);
    await syncDirectory(node);
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
  } finally { seed.fill(0); mnemonic = ''; }
}

/**
 * Reveal an existing phrase only after verifying it derives this wallet's seed.
 * Call only behind session, origin, CSRF and explicit confirmation checks. The
 * result is secret and must never be logged or included in routine wallet reads.
 * Legacy wallets return metadata only, since a random seed has no BIP39 inverse.
 */
export async function readRecovery(directory, kind) {
  let mnemonicBytes; let seed; let derived;
  try {
    await checkDirectory(path.dirname(directory));
    await checkDirectory(directory);
    try { mnemonicBytes = await readPrivate(path.join(directory, 'mnemonic'), 512); }
    catch (error) {
      if (error.code === 'ENOENT' && kind !== 'mnemonic') return { kind: 'legacy_seed' };
      throw error;
    }
    const mnemonic = mnemonicBytes.toString('utf8').trim();
    if (mnemonic.split(' ').length !== 24 || !validateMnemonic(mnemonic, wordlist)) throw new Error('Invalid recovery phrase');
    await checkDirectory(path.join(directory, 'node'));
    seed = await readPrivate(path.join(directory, 'node', 'keys_seed'), 64);
    derived = await mnemonicToSeedWebcrypto(mnemonic, '');
    if (seed.length !== derived.length || !timingSafeEqual(seed, derived)) throw new Error('Recovery identity mismatch');
    return { kind: 'mnemonic', mnemonic, word_count: 24 };
  } catch {
    throw failure('Recovery phrase is unavailable or does not match this wallet. Preserve a full backup before repairing its files.', 409, 'RECOVERY_UNAVAILABLE');
  } finally { mnemonicBytes?.fill(0); seed?.fill(0); derived?.fill(0); }
}
