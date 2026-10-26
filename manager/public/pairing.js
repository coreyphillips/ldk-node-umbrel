/** List usable pairing addresses without changing the node's enabled transports. */
export function pairingConnections(pairing) {
  return [
    { type: 'iroh', label: 'Iroh', uri: pairing.iroh_uri, help: 'Connect using the Iroh relay and endpoint discovery services you enabled.' },
    { type: 'tcp', label: 'Local network (TCP)', uri: pairing.tcp_uri, help: 'This address must be reachable from your client. For a local Docker installation, use the server LAN address in Settings.' },
    { type: 'tor', label: 'Tor', uri: pairing.tor_uri, help: pairing.tor_managed ? 'Use a Tor-capable client. This wallet’s onion address is created automatically and stays the same after restart. The onion service may take a few minutes to become reachable. Local TCP and Iroh stay available.' : 'Use a Tor-capable client. Your separately managed onion service must forward to this wallet’s native Lightning port.' },
  ].filter(connection => typeof connection.uri === 'string' && connection.uri.length > 0);
}

/** Preserve the chosen transport while available, otherwise use the first address. */
export function selectedPairingConnection(connections, preferred) {
  return connections.find(connection => connection.type === preferred) || connections[0];
}
