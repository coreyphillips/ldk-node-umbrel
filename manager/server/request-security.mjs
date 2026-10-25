import { isIP } from 'node:net';
import { failure } from './files.mjs';

// Parse authorities before passing them to URL, which otherwise accepts alternate
// numeric IP spellings and normalizes characters that should not appear in Host.
export function canonicalAuthority(value) {
  if (typeof value !== 'string' || !value.length || value.length > 255 || /[^\x21-\x7e]|[/\\@?#%,;]/.test(value)) throw failure('Invalid host', 400, 'HOST_REJECTED');
  let hostname; let port = '';
  if (value.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(value);
    if (!match || isIP(match[1]) !== 6) throw failure('Invalid host', 400, 'HOST_REJECTED');
    hostname = new URL(`http://[${match[1]}]`).hostname; port = match[2] || '';
  } else {
    const match = /^([^:]+)(?::([0-9]+))?$/.exec(value);
    if (!match) throw failure('Invalid host', 400, 'HOST_REJECTED');
    hostname = match[1].toLowerCase(); port = match[2] || '';
    if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
    if (!hostname || hostname.length > 253 || !hostname.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label))) throw failure('Invalid host', 400, 'HOST_REJECTED');
    // URL interprets numeric suffixes and hexadecimal IP literals specially.
    let parsed;
    try { parsed = new URL(`http://${hostname}`); } catch { throw failure('Invalid host', 400, 'HOST_REJECTED'); }
    if (parsed.hostname !== hostname) throw failure('Invalid host', 400, 'HOST_REJECTED');
  }
  if (port && (!Number.isSafeInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) throw failure('Invalid host', 400, 'HOST_REJECTED');
  return { hostname, authority: `${hostname}${port ? `:${Number(port)}` : ''}` };
}

export function canonicalOrigin(value) {
  if (typeof value !== 'string') throw failure('Request origin is not allowed', 403, 'ORIGIN_REJECTED');
  const match = /^(https?):\/\/([^/]+)$/.exec(value);
  if (!match) throw failure('Request origin is not allowed', 403, 'ORIGIN_REJECTED');
  try {
    const { authority } = canonicalAuthority(match[2]);
    return new URL(`${match[1]}://${authority}`).origin;
  } catch { throw failure('Request origin is not allowed', 403, 'ORIGIN_REJECTED'); }
}

export function hostOrigin(request, protocol = 'http:') {
  const { authority } = canonicalAuthority(request.headers.host);
  return new URL(`${protocol}//${authority}`).origin;
}

export function allowedHostnames(values, mode) {
  const result = new Set();
  for (const value of values) {
    const name = value.trim();
    if (name === '*') {
      if (mode !== 'password') throw new Error('Wildcard ALLOWED_HOSTS requires password authentication');
      result.add(name); continue;
    }
    if (!name) throw new Error('ALLOWED_HOSTS must contain non-empty hostnames');
    const parsed = canonicalAuthority(name);
    if (parsed.authority !== parsed.hostname) throw new Error('ALLOWED_HOSTS entries must not contain ports');
    result.add(parsed.hostname);
  }
  if (!result.size) throw new Error('ALLOWED_HOSTS must contain at least one hostname');
  return result;
}
