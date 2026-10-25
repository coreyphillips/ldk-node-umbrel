import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import packageMetadata from '../package.json' with { type: 'json' };
import { Authentication } from './auth.mjs';
import { WalletManager } from './wallets.mjs';
import { privateDir, failure } from './files.mjs';
import { READ_METHODS } from './config.mjs';
import { canonicalAuthority, canonicalOrigin, allowedHostnames } from './request-security.mjs';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

async function body(request) {
  let bytes = 0; const chunks = [];
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 64 * 1024) throw failure('Request too large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw failure('Invalid JSON'); }
}
function send(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }

export function createServer({ auth, wallets, publicOrigin, secureCookies = false, allowedHosts }) {
  const hosts = allowedHostnames(allowedHosts || ['localhost', '127.0.0.1', 'umbrel.local'], auth.mode);
  if (publicOrigin) publicOrigin = canonicalOrigin(publicOrigin);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    try {
      const { hostname, authority } = canonicalAuthority(request.headers.host);
      if (!hosts.has('*') && !hosts.has(hostname)) throw failure('Host is not allowed', 403, 'HOST_REJECTED');
      if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.includes('\\')) throw failure('Invalid request target', 400);
      const url = new URL(request.url, publicOrigin || `http://${authority}`);
      if (url.pathname === '/healthz' && request.method === 'GET') return send(response, 200, { ok: true });
      if (url.pathname === '/api/session' && request.method === 'GET') return send(response, 200, auth.status(request, response, secureCookies));
      if (url.pathname === '/api/login' && request.method === 'POST') return send(response, 200, auth.login(request, response, (await body(request)).password, secureCookies));
      if (url.pathname.startsWith('/api/')) {
        const mutation = request.method !== 'GET'; auth.require(request, mutation);
        if (['POST', 'PUT'].includes(request.method) && !String(request.headers['content-type'] || '').startsWith('application/json')) throw failure('JSON request required', 415);
        if (url.pathname === '/api/logout' && request.method === 'POST') { auth.logout(request, response); return send(response, 200, { ok: true }); }
        if (url.pathname === '/api/config' && request.method === 'GET') return send(response, 200, { version: packageMetadata.version, default_network: 'bitcoin', max_wallets: 8, backend: 'native-ldk-node', mainnet_experimental: true, iroh_available: Boolean(wallets.bridge) });
        if (url.pathname === '/api/wallets' && request.method === 'GET') return send(response, 200, wallets.list());
        if (url.pathname === '/api/wallets' && request.method === 'POST') return send(response, 201, await wallets.create(await body(request)));
        const match = /^\/api\/wallets\/([0-9a-f-]{36})(?:\/([a-z_]+))?$/.exec(url.pathname);
        if (match) {
          const [, id, operation] = match;
          if (!operation && request.method === 'PUT') return send(response, 200, await wallets.update(id, await body(request)));
          if (operation === 'start' && request.method === 'POST') return send(response, 200, await wallets.start(id));
          if (operation === 'stop' && request.method === 'POST') return send(response, 200, await wallets.stop(id));
          if (operation === 'pairing' && request.method === 'GET') return send(response, 200, wallets.pairing(id, url.hostname));
          if (operation === 'logs' && request.method === 'GET') return send(response, 200, { text: wallets.logs(id) });
          if (operation === 'qr' && request.method === 'POST') {
            const value = (await body(request)).text;
            if (typeof value !== 'string' || value.length > 4096) throw failure('QR value is too long');
            return send(response, 200, { image: await QRCode.toDataURL(value, { width: 320, margin: 2, errorCorrectionLevel: 'M' }) });
          }
          if (operation === 'rpc' && request.method === 'POST') { const input = await body(request); return send(response, 200, await wallets.call(id, input.method, input.params)); }
          if (READ_METHODS.has(operation) && request.method === 'GET') return send(response, 200, await wallets.call(id, operation));
        }
        throw failure('Route not found', 404, 'NOT_FOUND');
      }
      if (request.method !== 'GET') throw failure('Method not allowed', 405);
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'style.css', 'icon.svg'].includes(name)) throw failure('Not found', 404);
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] }); response.end(await fs.readFile(path.join(PUBLIC, name)));
    } catch (error) {
      if (!response.headersSent) send(response, error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error.status ? error.message : 'The dashboard could not complete this operation' } });
      else response.end();
    }
  });
  server.requestTimeout = 130_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  return server;
}

async function main() {
  process.umask(0o077);
  const dataDir = path.resolve(process.env.DATA_DIR || './data'); await privateDir(dataDir);
  const publicOrigin = process.env.PUBLIC_ORIGIN ? canonicalOrigin(process.env.PUBLIC_ORIGIN) : undefined;
  const auth = new Authentication({ dataDir, mode: process.env.AUTH_MODE || 'password', publicOrigin, proxyHosts: process.env.APP_PROXY_HOST ? [process.env.APP_PROXY_HOST] : undefined });
  let bootstrapPassword = process.env.DASHBOARD_BOOTSTRAP_PASSWORD;
  delete process.env.DASHBOARD_BOOTSTRAP_PASSWORD;
  await auth.initialize(process.env.DASHBOARD_PASSWORD_FILE, bootstrapPassword);
  bootstrapPassword = undefined;
  const wallets = new WalletManager({ dataDir, binary: process.env.LDK_NODE_BIN || '/opt/ldk/bin/ldk-node-daemon', bridge: process.env.IROH_BRIDGE || undefined,
    portBase: Number(process.env.LIGHTNING_PORT_BASE || 9735), publicPortBase: Number(process.env.PUBLIC_PORT_BASE || 19351) });
  await wallets.initialize();
  const allowedHosts = new Set((process.env.ALLOWED_HOSTS || (publicOrigin ? new URL(publicOrigin).hostname : 'localhost,127.0.0.1,umbrel.local')).split(','));
  const server = createServer({ auth, wallets, publicOrigin, allowedHosts, secureCookies: process.env.COOKIE_SECURE === '1' });
  server.listen(Number(process.env.PORT || 3000), process.env.BIND_ADDRESS || '127.0.0.1', () => console.error('LDK dashboard is listening'));
  void wallets.boot();
  const stop = async () => { server.close(); auth.close(); await wallets.close(); console.error('Dashboard shutdown completed'); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
