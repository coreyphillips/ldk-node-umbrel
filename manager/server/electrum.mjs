import net from 'node:net';
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { failure } from './files.mjs';
import { canonicalAuthority } from './request-security.mjs';

const GENESIS_NETWORKS = new Map([
  ['000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', 'bitcoin'],
  ['000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', 'testnet'],
  ['00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043', 'testnet4'],
  ['00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6', 'signet'],
  ['0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206', 'regtest'],
]);
const NETWORK_LABELS = { bitcoin: 'Mainnet', testnet: 'Testnet', testnet4: 'Testnet 4', signet: 'Signet', regtest: 'Regtest' };
const MAX_BYTES = 64 * 1024;
const MAX_FRAMES = 16;
export const ELECTRUM_PRESETS = Object.freeze([
  Object.freeze({ id: 'electrs', label: 'Umbrel Electrs', url: 'tcp://10.21.21.10:50001' }),
  Object.freeze({ id: 'fulcrum', label: 'Umbrel Fulcrum', url: 'tcp://10.21.21.200:50002' }),
  Object.freeze({ id: 'rbitcoin', label: 'rbitcoin', url: 'tcp://beignet-rbitcoin_node_1:50001' }),
]);

export function electrumUrl(value) {
  const invalid = () => failure('Use an Electrum URL with a host and port, such as tcp://10.21.21.10:50001 or ssl://your-server:50002', 400, 'ELECTRUM_URL');
  if (typeof value !== 'string' || value.length > 2048) throw invalid();
  const match = /^(tcp|ssl):\/\/([^/?#]+)\/?$/.exec(value.trim());
  if (!match) throw invalid();
  let parsed;
  try { parsed = canonicalAuthority(match[2]); } catch { throw invalid(); }
  if (parsed.authority === parsed.hostname) throw invalid();
  const port = Number(parsed.authority.slice(parsed.hostname.length + 1));
  return { url: `${match[1]}://${parsed.authority}`, host: parsed.hostname.replace(/^\[|\]$/g, ''), port, tls: match[1] === 'ssl' };
}

export function electrumSettings(environment = process.env) {
  const host = environment.DEFAULT_ELECTRUM_HOST;
  const port = environment.DEFAULT_ELECTRUM_PORT;
  const encryption = environment.DEFAULT_ELECTRUM_TLS;
  if (host === undefined || host === '') return { electrum_presets: ELECTRUM_PRESETS, default_electrum_url: '' };
  if (typeof host !== 'string' || !host || typeof port !== 'string' || !/^[0-9]+$/.test(port) || !['true', 'false', '1', '0', '', undefined].includes(encryption)) throw new Error('Invalid default Electrum environment configuration');
  let endpoint;
  try { endpoint = electrumUrl(`${encryption === 'true' || encryption === '1' ? 'ssl' : 'tcp'}://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`); }
  catch { throw new Error('Invalid default Electrum environment configuration'); }
  return { electrum_presets: ELECTRUM_PRESETS, default_electrum_url: endpoint.url };
}

function protocolError() { return failure('The server did not return valid Electrum data. Check the host, port and TCP or TLS setting.', 502, 'ELECTRUM_PROTOCOL'); }
function connectionError(error, endpoint, connected, secured) {
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) return failure('The Electrum host could not be resolved. Names ending in .local may not resolve inside a container. Use the Electrs or Fulcrum preset for this Umbrel, or the server LAN IP for another device.', 502, 'ELECTRUM_DNS');
  if (error.code === 'ECONNREFUSED') return failure('The Electrum connection was refused. Check that the selected server app is installed, running and listening on this port.', 502, 'ELECTRUM_REFUSED');
  if (error.code === 'ETIMEDOUT') return timeoutError();
  if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(error.code || '') || (endpoint.tls && connected && !secured)) return failure('The Electrum TLS connection could not be verified. Check the certificate, host name and TLS port. Umbrel Electrs and Fulcrum use the plaintext TCP presets.', 502, 'ELECTRUM_TLS');
  return failure('The Electrum server could not be reached. Check the server app, address, port and network connection.', 502, 'ELECTRUM_CONNECT');
}
function timeoutError() { return failure('The Electrum server did not respond in time. Check that the server is running and synced, and that its address and TCP or TLS port are correct.', 504, 'ELECTRUM_TIMEOUT'); }

// One socket, three fixed read requests, a total byte bound and a wall-clock
// deadline. No wallet keys, addresses or transaction information are sent.
export function createElectrumChecker({ timeoutMs = 5000, maxConcurrent = 4, connectTcp = options => net.connect(options), connectTls = options => tls.connect(options) } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error('Invalid Electrum probe limits');
  let active = 0;
  return async function checkElectrum(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !['bitcoin', 'testnet', 'signet', 'regtest'].includes(input.network)) throw failure('Choose a supported Bitcoin network', 400, 'ELECTRUM_NETWORK');
    const endpoint = electrumUrl(input.url);
    if (active >= maxConcurrent) throw failure('Electrum checks are busy. Try again shortly.', 429, 'ELECTRUM_BUSY');
    active++;
    try {
      return await new Promise((resolve, reject) => {
        let socket; let timer; let done = false; let connected = false; let secured = !endpoint.tls;
        let bytes = 0; let frames = 0; let buffer = ''; let versionReady = false; let networkReady = false; let height;
        const pending = new Set([1, 2, 3]);
        const result = () => ({ url: endpoint.url, network: input.network, ...(height === undefined ? {} : { height }) });
        const finish = (error) => {
          if (done) return;
          done = true; clearTimeout(timer); socket?.destroy();
          if (error) reject(error); else resolve(result());
        };
        const incomplete = () => {
          if (versionReady && networkReady) finish();
          else finish(timeoutError());
        };
        timer = setTimeout(incomplete, timeoutMs);
        try {
          socket = endpoint.tls
            ? connectTls({ host: endpoint.host, port: endpoint.port, servername: net.isIP(endpoint.host) ? undefined : endpoint.host, rejectUnauthorized: true })
            : connectTcp({ host: endpoint.host, port: endpoint.port });
        } catch (error) { finish(connectionError(error, endpoint, connected, secured)); return; }
        socket.once('connect', () => { connected = true; });
        socket.once(endpoint.tls ? 'secureConnect' : 'connect', () => {
          secured = true;
          socket.write(`${JSON.stringify({ id: 1, method: 'server.version', params: ['ldk-node-umbrel', '1.4'] })}\n`);
          socket.write(`${JSON.stringify({ id: 2, method: 'blockchain.block.header', params: [0] })}\n`);
          socket.write(`${JSON.stringify({ id: 3, method: 'blockchain.headers.subscribe', params: [] })}\n`);
        });
        socket.on('data', chunk => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > MAX_BYTES) return finish(protocolError());
          buffer += chunk.toString('utf8');
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (++frames > MAX_FRAMES) return finish(protocolError());
            let message;
            try { message = JSON.parse(line); } catch { return finish(protocolError()); }
            if (!message || typeof message !== 'object' || Array.isArray(message)) return finish(protocolError());
            if (message.id === undefined && message.method === 'blockchain.headers.subscribe') continue;
            if (!pending.delete(message.id)) return finish(protocolError());
            if (message.id === 1) {
              if (message.error || !Array.isArray(message.result) || message.result.length !== 2 || typeof message.result[0] !== 'string' || typeof message.result[1] !== 'string' || !/^1\.4(?:\.[0-9]+)?$/.test(message.result[1])) return finish(protocolError());
              versionReady = true;
            } else if (message.id === 2) {
              if (message.error || typeof message.result !== 'string' || !/^[0-9a-fA-F]{160}$/.test(message.result)) return finish(protocolError());
              const once = createHash('sha256').update(Buffer.from(message.result, 'hex')).digest();
              const genesis = createHash('sha256').update(once).digest().reverse().toString('hex');
              const actual = GENESIS_NETWORKS.get(genesis);
              if (actual !== input.network) return finish(failure(`The Electrum server serves ${NETWORK_LABELS[actual] || 'an unknown Bitcoin network'}, but this wallet uses ${NETWORK_LABELS[input.network]}. Select a server for the wallet network.`, 409, 'ELECTRUM_WRONG_NETWORK'));
              networkReady = true;
            } else if (!message.error) {
              if (!message.result || !Number.isSafeInteger(message.result.height) || message.result.height < 0) return finish(protocolError());
              height = message.result.height;
            }
          }
          if (!pending.size) finish();
        });
        socket.once('error', error => finish(connectionError(error, endpoint, connected, secured)));
        socket.once('close', () => {
          if (done) return;
          if (versionReady && networkReady) finish();
          else if (endpoint.tls && connected && !secured) finish(connectionError({}, endpoint, connected, secured));
          else finish(protocolError());
        });
      });
    } finally { active--; }
  };
}
