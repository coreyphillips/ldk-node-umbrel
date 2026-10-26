/** List usable pairing addresses without changing the node's enabled transports. */
export function pairingConnections(pairing) {
  return [
    { type: 'iroh', label: 'Iroh', uri: pairing.iroh_uri, help: 'Connect using the Iroh relay and endpoint discovery services you enabled.' },
    { type: 'tcp', label: 'Local network (TCP)', uri: pairing.tcp_uri, help: 'This address must be reachable from your client. For a local Docker installation, use the server LAN address in Settings.' },
    { type: 'tor', label: 'Tor', uri: pairing.tor_uri, help: 'Use a Tor-capable client. Your onion service must forward to this wallet’s native Lightning port. This dashboard does not create or verify an onion service.' },
  ].filter(connection => typeof connection.uri === 'string' && connection.uri.length > 0);
}

/** Preserve the chosen transport while available, otherwise use the first address. */
export function selectedPairingConnection(connections, preferred) {
  return connections.find(connection => connection.type === preferred) || connections[0];
}
