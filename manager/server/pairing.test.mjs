import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingConnections, selectedPairingConnection } from '../public/pairing.js';

const NODE = `02${'a'.repeat(64)}`;
const URIS = Object.freeze({
  iroh: `${NODE}@iroh:${'b'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`,
  tcp: `${NODE}@[2001:db8::1]:9735`,
  tor: `${NODE}@${'c'.repeat(56)}.onion:9735`,
});
const TYPES = ['iroh', 'tcp', 'tor'];
const LABELS = { iroh: 'Iroh', tcp: 'Local network (TCP)', tor: 'Tor' };

test('managed Tor guidance describes automatic stable addressing while external Tor retains forwarding instructions', () => {
  const managed = pairingConnections({ tor_uri: URIS.tor, tor_managed: true })[0];
  const external = pairingConnections({ tor_uri: URIS.tor, tor_managed: false })[0];
  assert.equal(managed.uri, external.uri);
  assert.match(managed.help, /created automatically/);
  assert.match(managed.help, /Local TCP and Iroh stay available/);
  assert.match(external.help, /separately managed onion service/);
});

for (let mask = 0; mask < 8; mask++) {
  const available = TYPES.filter((type, index) => mask & (1 << index));
  test(`pairing offers exactly the available transports: ${available.join(', ') || 'none'}`, () => {
    const pairing = Object.fromEntries(TYPES.map(type => [`${type}_uri`, available.includes(type) ? URIS[type] : null]));
    const connections = pairingConnections(pairing);
    assert.deepEqual(connections.map(connection => connection.type), available);
    for (const connection of connections) {
      assert.equal(connection.label, LABELS[connection.type]);
      assert.equal(connection.uri, URIS[connection.type]);
      assert.equal(typeof connection.help, 'string');
      assert.ok(connection.help.length > 0);
    }
    assert.equal(selectedPairingConnection(connections), connections[0]);
    for (const preferred of TYPES) {
      const expected = connections.find(connection => connection.type === preferred) || connections[0];
      assert.equal(selectedPairingConnection(connections, preferred), expected);
    }
  });
}

test('missing, empty and non-string addresses do not create a connection option', () => {
  assert.deepEqual(pairingConnections({}), []);
  for (const value of [undefined, null, '', false, true, 0, 1, [], {}, { uri: URIS.tor }]) {
    assert.deepEqual(pairingConnections({ iroh_uri: value, tcp_uri: value, tor_uri: value }), []);
  }
});

test('selection falls back when the requested connection is unavailable or removed', () => {
  const all = pairingConnections({ iroh_uri: URIS.iroh, tcp_uri: URIS.tcp, tor_uri: URIS.tor });
  assert.equal(selectedPairingConnection(all, 'tor').uri, URIS.tor);
  assert.equal(selectedPairingConnection(all, 'tcp').uri, URIS.tcp);
  for (const preferred of [undefined, null, '', 'unknown']) {
    assert.equal(selectedPairingConnection(all, preferred), all[0]);
  }
  const withoutTor = pairingConnections({ iroh_uri: URIS.iroh, tcp_uri: URIS.tcp });
  assert.equal(selectedPairingConnection(withoutTor, 'tor'), withoutTor[0]);
  assert.equal(selectedPairingConnection([], 'tor'), undefined);
});

test('connection selection leaves pairing data and enabled transports unchanged', () => {
  const pairing = Object.freeze({
    iroh_uri: URIS.iroh, tcp_uri: URIS.tcp, tor_uri: URIS.tor,
    node_id: NODE, network: 'bitcoin', iroh_status: 'ready',
  });
  const original = structuredClone(pairing);
  const connections = pairingConnections(pairing);
  connections.forEach(Object.freeze);
  Object.freeze(connections);
  const before = structuredClone(connections);
  for (const type of ['tor', 'tcp', 'iroh', 'tor']) {
    assert.equal(selectedPairingConnection(connections, type).uri, URIS[type]);
  }
  assert.deepEqual(pairing, original);
  assert.deepEqual(connections, before);
  assert.deepEqual(pairingConnections(pairing), connections);
});
