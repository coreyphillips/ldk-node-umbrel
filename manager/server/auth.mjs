import fs from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { atomicJson, readJson, failure } from './files.mjs';
import { canonicalOrigin, hostOrigin } from './request-security.mjs';

const normalize = ip => String(ip || '').replace(/^::ffff:/, '');
const equal = (left, right) => {
  const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

export class Authentication {
  constructor({ dataDir, mode = 'password', publicOrigin, proxyHosts, now = Date.now, lookup = dns.lookup }) {
    if (!['password', 'umbrel'].includes(mode)) throw new Error('AUTH_MODE must be password or umbrel');
    this.dataDir = dataDir; this.mode = mode; this.publicOrigin = publicOrigin ? canonicalOrigin(publicOrigin) : undefined;
    this.proxyHosts = proxyHosts || ['app_proxy_ldk-node-wallet', 'ldk-node-wallet_app_proxy_1', 'ldk-node-wallet-app_proxy-1'];
    this.now = now; this.lookup = lookup; this.proxies = new Set(); this.sessions = new Map(); this.attempts = new Map();
  }
  async initialize(passwordFile, bootstrapPassword) {
    if (passwordFile && bootstrapPassword !== undefined) throw new Error('Configure either DASHBOARD_PASSWORD_FILE or DASHBOARD_BOOTSTRAP_PASSWORD');
    if (this.mode !== 'password' && bootstrapPassword !== undefined) throw new Error('DASHBOARD_BOOTSTRAP_PASSWORD requires password authentication');
    if (this.mode === 'umbrel') {
      await this.refreshProxies();
      this.timer = setInterval(() => this.refreshProxies(), 30_000); this.timer.unref();
      return;
    }
    this.password = await readJson(path.join(this.dataDir, 'auth.json'), null);
    if (!this.password) {
      let password;
      if (bootstrapPassword !== undefined) {
        password = bootstrapPassword;
      } else if (passwordFile) {
        const stat = await fs.lstat(passwordFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 || (stat.mode & 0o077)) throw new Error('Password file must be private and regular');
        password = (await fs.readFile(passwordFile, 'utf8')).trim();
      } else {
        password = randomBytes(24).toString('base64url');
        await fs.writeFile(path.join(this.dataDir, 'dashboard-password'), `${password}\n`, { mode: 0o600, flag: 'wx' });
        console.error('Dashboard password created in DATA_DIR/dashboard-password');
      }
      if (typeof password !== 'string' || password.length < 16 || password.length > 512) throw new Error('Dashboard password must contain 16 to 512 characters');
      const salt = randomBytes(32).toString('hex');
      this.password = { salt, hash: scryptSync(password, salt, 32).toString('hex') };
      await atomicJson(path.join(this.dataDir, 'auth.json'), this.password);
    }
  }
  async refreshProxies() {
    const next = new Set();
    await Promise.all(this.proxyHosts.map(async hostname => {
      try { for (const record of await this.lookup(hostname, { all: true })) next.add(normalize(record.address)); } catch {}
    }));
    this.proxies = next;
  }
  checkOrigin(request) {
    const origin = canonicalOrigin(request.headers.origin);
    const expected = hostOrigin(request, new URL(origin).protocol);
    if (origin !== expected || (this.publicOrigin && origin !== this.publicOrigin)) throw failure('Request origin is not allowed', 403, 'ORIGIN_REJECTED');
    return origin;
  }
  trustedProxy(request) { return this.proxies.has(normalize(request.socket.remoteAddress)); }
  prune() {
    for (const [key, value] of this.sessions) if (value.expires < this.now()) this.sessions.delete(key);
    for (const [key, value] of this.attempts) if (value.until < this.now()) this.attempts.delete(key);
  }
  create(request, response, secure = false, origin = this.publicOrigin || hostOrigin(request)) {
    this.prune();
    if (this.sessions.size >= 128) throw failure('Too many active dashboard sessions', 429, 'SESSION_LIMIT');
    const token = randomBytes(32).toString('base64url');
    const session = { origin, proof: randomBytes(32).toString('base64url'), csrf: randomBytes(32).toString('base64url'), expires: this.now() + 8 * 3600_000 };
    this.sessions.set(token, session);
    response.setHeader('Set-Cookie', `ldk_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure || origin.startsWith('https:') ? '; Secure' : ''}`);
    return session;
  }
  session(request) {
    this.prune();
    const token = /(?:^|;\s*)ldk_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
    const session = token && this.sessions.get(token);
    if (!session || !equal(request.headers['x-session-proof'], session.proof) || hostOrigin(request, new URL(session.origin).protocol) !== session.origin) return undefined;
    if (request.headers.origin !== undefined && this.checkOrigin(request) !== session.origin) throw failure('Request origin is not allowed', 403, 'ORIGIN_REJECTED');
    return session;
  }
  status(request, response, secure) {
    if (this.mode === 'umbrel' && !this.trustedProxy(request)) throw failure('Umbrel authentication proxy is not available', 403, 'PROXY_REQUIRED');
    const session = this.session(request);
    if (session) return { authenticated: true, mode: this.mode, csrf: session.csrf };
    // Legacy proxy mode authenticates the caller independently of its cookies.
    // A fresh session may be issued here, but an existing proof is never revealed.
    if (this.mode === 'umbrel') {
      const created = this.create(request, response, secure);
      return { authenticated: true, mode: this.mode, csrf: created.csrf, proof: created.proof };
    }
    return { authenticated: false, mode: this.mode };
  }
  login(request, response, supplied, secure) {
    const origin = this.checkOrigin(request); this.prune();
    if (this.mode !== 'password') throw failure('Use Umbrel sign-in', 403);
    const ip = normalize(request.socket.remoteAddress);
    let attempt = this.attempts.get(ip);
    if (!attempt) {
      if (this.attempts.size >= 1024) throw failure('Login temporarily unavailable', 429);
      attempt = { count: 0, until: this.now() + 15 * 60_000 }; this.attempts.set(ip, attempt);
    }
    if (++attempt.count > 10) throw failure('Too many login attempts. Try again in 15 minutes.', 429, 'LOGIN_RATE_LIMIT');
    if (typeof supplied !== 'string' || supplied.length > 512) throw failure('Invalid password', 401, 'INVALID_PASSWORD');
    const hash = scryptSync(supplied, this.password.salt, 32).toString('hex');
    if (!equal(hash, this.password.hash)) throw failure('Invalid password', 401, 'INVALID_PASSWORD');
    this.attempts.delete(ip);
    const session = this.create(request, response, secure, origin);
    return { authenticated: true, mode: this.mode, csrf: session.csrf, proof: session.proof };
  }
  require(request, mutation) {
    if (this.mode === 'umbrel' && !this.trustedProxy(request)) throw failure('Umbrel authentication proxy is required', 403, 'PROXY_REQUIRED');
    const session = this.session(request);
    if (!session) throw failure('Sign in to continue', 401, 'AUTH_REQUIRED');
    if (mutation) {
      if (this.checkOrigin(request) !== session.origin) throw failure('Request origin is not allowed', 403, 'ORIGIN_REJECTED');
      if (!equal(request.headers['x-csrf-token'], session.csrf)) throw failure('Refresh the dashboard and try again', 403, 'CSRF_REJECTED');
    }
    return session;
  }
  logout(request, response) {
    const token = /(?:^|;\s*)ldk_session=([^;]+)/.exec(request.headers.cookie || '')?.[1];
    this.sessions.delete(token);
    response.setHeader('Set-Cookie', 'ldk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  }
  close() { clearInterval(this.timer); }
}
