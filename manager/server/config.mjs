import { failure } from './files.mjs';
import { electrumUrl } from './electrum.mjs';

export const NETWORKS = ['regtest', 'signet', 'testnet', 'bitcoin'];
export const METHODS = new Set(['info', 'balance', 'channels', 'payments', 'peers', 'address', 'invoice', 'pay', 'send_onchain', 'connect', 'disconnect', 'open', 'close', 'sync', 'offline_status', 'splice_in', 'splice_out', 'events', 'estimate_onchain']);
export const READ_METHODS = new Set(['info', 'balance', 'channels', 'payments', 'peers', 'offline_status', 'events']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = (value, minimum, maximum, name) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure(`Invalid ${name}`);
  return value;
};
const text = (value, maximum, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f]/.test(value)) throw failure(`Invalid ${name}`);
  return value.trim();
};

export function walletConfig(input, previous) {
  if (!object(input)) throw failure('Invalid wallet configuration');
  const name = text(input.name, 32, 'wallet name');
  if (Buffer.byteLength(name) > 32) throw failure('Wallet name must fit in 32 UTF-8 bytes');
  const network = input.network || 'bitcoin';
  if (!NETWORKS.includes(network)) throw failure('Unsupported Bitcoin network');
  if (previous && network !== previous.network) throw failure('A wallet network cannot be changed');
  const chain = input.chain_source;
  if (!object(chain)) throw failure('Choose a chain source');
  let chain_source;
  if (chain.type === 'bitcoind') {
    const host = text(chain.host, 253, 'Bitcoin Core host');
    if (/[\s/\\@?#]/.test(host)) throw failure('Enter a host name or IP address without a URL');
    const password = chain.password === '' && previous?.chain_source.type === 'bitcoind' ? previous.chain_source.password : chain.password;
    if (typeof password !== 'string' || !password.length || password.length > 512) throw failure('Invalid Bitcoin Core password');
    chain_source = { type: 'bitcoind', host, port: number(chain.port, 1, 65535, 'RPC port'), user: text(chain.user, 128, 'RPC user'), password };
  } else if (chain.type === 'electrum' || chain.type === 'esplora') {
    const url = text(chain.url, 2048, 'chain URL');
    if (chain.type === 'electrum') {
      chain_source = { type: 'electrum', url: electrumUrl(url).url };
    } else {
      let parsed; try { parsed = new URL(url); } catch { throw failure('Enter a complete chain URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search || !parsed.hostname) throw failure('Unsupported chain URL');
      chain_source = { type: 'esplora', url };
    }
  } else throw failure('Unsupported chain source');
  const policy = input.chicory || {};
  const chicory = {
    enabled: policy.enabled === true,
    offline_enabled: policy.offline_enabled === true,
    flat_fee_sat: number(policy.flat_fee_sat ?? 100, 0, 100_000, 'flat fee'),
    fee_ppm: number(policy.fee_ppm ?? 1000, 0, 1_000_000, 'proportional fee'),
    max_client_funding_sats: number(policy.max_client_funding_sats ?? 200_000, 10_000, 100_000_000, 'client funding cap'),
    max_total_fronted_sats: number(policy.max_total_fronted_sats ?? 1_000_000, 10_000, 2_100_000_000_000_000, 'total funding cap'),
  };
  if (chicory.max_total_fronted_sats < chicory.max_client_funding_sats) throw failure('Total funding cap must cover the client cap');
  if (chicory.offline_enabled && !chicory.enabled) throw failure('Enable the Chicory provider before offline settlement');
  const iroh = { enabled: input.iroh?.enabled === true, discovery: input.iroh?.discovery === true, default_relays: input.iroh?.default_relays === true };
  if (iroh.enabled && (!iroh.discovery || !iroh.default_relays)) throw failure('Iroh phone pairing requires endpoint discovery and relay consent');
  const advertised_host = input.advertised_host ? text(input.advertised_host, 253, 'advertised host') : '';
  if (advertised_host && /[\s/\\@?#]/.test(advertised_host)) throw failure('Enter a host name or IP address for pairing');
  const tor_onion_address = input.tor_onion_address ? text(input.tor_onion_address, 80, 'Tor onion address') : '';
  if (tor_onion_address) {
    const match = /^([a-z2-7]{56}\.onion):([0-9]{1,5})$/.exec(tor_onion_address);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw failure('Use a v3 onion host and port mapped to this native wallet');
  }
  return { name, network, chain_source, chicory, iroh, advertised_host, tor_onion_address, autostart: input.autostart !== false };
}

export function publicConfig(value) {
  const copy = structuredClone(value);
  if (copy.chain_source.type === 'bitcoind') { copy.chain_source.password = ''; copy.chain_source.password_configured = Boolean(value.chain_source.password); }
  return copy;
}

export function rpcRequest(method, params = {}) {
  if (!METHODS.has(method) || !object(params)) throw failure('Unsupported native method');
  if (Buffer.byteLength(JSON.stringify(params)) > 32 * 1024) throw failure('Request is too large', 413);
  if (['pay', 'send_onchain', 'open', 'close', 'splice_in', 'splice_out'].includes(method) && params.confirm !== true) throw failure('Confirm this operation first');
  const result = { ...params }; delete result.confirm;
  return result;
}
