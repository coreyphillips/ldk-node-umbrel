import { pairingConnections, selectedPairingConnection } from './pairing.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
// Cookies are shared across ports. This second secret stays in browser storage
// scoped to this exact origin, so another Umbrel app cannot replay our cookie.
const sessionProofKey = 'ldk-dashboard-session-proof';
let sessionProof = '';
try { sessionProof = sessionStorage.getItem(sessionProofKey) || ''; } catch {}
if (!/^[A-Za-z0-9_-]{43}$/.test(sessionProof)) sessionProof = '';
function rememberSessionProof(proof) {
  sessionProof = typeof proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof) ? proof : '';
  try { if (sessionProof) sessionStorage.setItem(sessionProofKey, sessionProof); else sessionStorage.removeItem(sessionProofKey); } catch {}
}
function acceptSession(session) {
  if (session.proof) rememberSessionProof(session.proof);
  if (!session.authenticated) rememberSessionProof('');
  const { proof, ...publicSession } = session;
  state.session = publicSession;
}
function clearSession() { clearSensitiveDialog(); rememberSessionProof(''); state.session = null; state.wallets = []; state.selected = null; state.data = {}; pairingView = null; pairingSelections.clear(); refreshQueued = false; if (dialog.open) dialog.close(); }
const state = { session: null, wallets: [], selected: null, view: 'overview', data: {}, config: {}, polling: false };
let pairingView = null;
const pairingSelections = new Map();
let refreshQueued = false;
let walletRevision = 0;
let sensitiveCleanup = null;
const networks = { bitcoin: 'Mainnet', regtest: 'Regtest', signet: 'Signet', testnet: 'Testnet' };
const integer = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
};
const fmt = value => integer(value)?.toLocaleString('en-US') ?? '...';
const sats = value => integer(value) === null ? '...' : (integer(value) / 1000n).toLocaleString('en-US');
const short = value => value ? `${String(value).slice(0, 10)}…${String(value).slice(-6)}` : 'Unavailable';
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const add = (parent, ...children) => { parent.append(...children.filter(Boolean)); return parent; };
const button = (text, action, className = '') => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node; };
const active = () => state.wallets.find(wallet => wallet.id === state.selected);
const available = method => state.data.info?.capabilities?.includes(method);

async function api(route, options = {}) {
  const requestSession = state.session;
  const { binary = false, ...requestOptions } = options;
  const response = await fetch(`/api${route}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.session?.csrf || '', 'X-Session-Proof': sessionProof }, ...requestOptions, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = response.ok && binary ? await response.blob() : await response.json();
  if (!response.ok) {
    if (response.status === 401 && route !== '/login' && state.session === requestSession) { clearSession(); login(); }
    throw new Error(data.error?.message || 'Request failed');
  }
  return data;
}
const rpc = (method, params = {}) => api(`/wallets/${state.selected}/rpc`, { method: 'POST', body: { method, params } });
function toast(message, error = false) { const node = el('div', `toast${error ? ' error' : ''}`, message); document.querySelector('#toasts').append(node); setTimeout(() => node.remove(), 7000); }
async function run(action, message) { try { const result = await action(); if (message) toast(message); await refresh(); return result; } catch (error) { toast(error.message, true); } }
function badge(text, color = '') { const node = el('span', `badge ${color}`); return add(node, el('span', 'dot'), document.createTextNode(text)); }
function walletBadge(wallet) { return wallet.deletion_pending ? badge('Deletion pending', 'red') : badge(wallet.status, wallet.status === 'running' ? 'green' : wallet.status === 'failed' ? 'red' : wallet.status === 'starting' ? 'amber' : ''); }
function brand() { const logo = el('img'); logo.src = '/icon.svg'; logo.alt = ''; return add(el('div', 'brand'), logo, add(el('div'), document.createTextNode('LDK Node'), el('small', '', 'Your Bitcoin. Your node.'))); }
function notice(message, error = false) { return el('div', `notice${error ? ' error' : ''}`, message); }
async function copy(value) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(String(value));
    else {
      const area = el('textarea'); area.value = String(value); area.setAttribute('readonly', ''); area.className = 'clipboard-helper'; (dialog.open ? dialog : document.body).append(area); area.select();
      try { if (!document.execCommand('copy')) throw new Error('Clipboard unavailable'); } finally { area.remove(); }
    }
    toast('Copied');
  } catch { toast('Select and copy the value manually', true); }
}
function copyValue(value) { return add(el('div', 'copy-value'), el('code', '', value), button('Copy', () => copy(value), 'small')); }
function stat(label, value, foot) { return add(el('div', 'stat'), el('div', 'caption', label), add(el('div', 'value'), document.createTextNode(value), el('span', 'unit', 'sats')), el('div', 'foot', foot)); }
function card(title, child, actions) { const node = el('section', 'card'); add(node, add(el('div', 'card-head'), el('h2', '', title), actions)); if (child) node.append(child); return node; }
function empty(title, description, action) { return add(el('div', 'empty'), el('h3', '', title), el('p', '', description), action); }
function detail(rows) { const node = el('dl', 'detail-list'); for (const [label, value] of rows) add(node, el('dt', '', label), el('dd', '', value)); return node; }
function table(headers, rows) { const node = el('table'); const heading = el('tr'); for (const header of headers) heading.append(el('th', '', header)); node.append(add(el('thead'), heading)); const body = el('tbody'); for (const row of rows) { const tr = el('tr'); for (const value of row) tr.append(value instanceof Node ? add(el('td'), value) : el('td', '', value)); body.append(tr); } node.append(body); return add(el('div', 'table-wrap'), node); }
function modal(title) { clearSensitiveDialog(); dialog.replaceChildren(); add(dialog, add(el('div', 'dialog-head'), el('h2', '', title), button('×', () => dialog.close(), 'ghost icon'))); const body = el('div', 'dialog-body'); dialog.append(body); if (!dialog.open) dialog.showModal(); return body; }
function field(form, name, label, { type = 'text', value = '', options, help, required = false, min, max, wide = false } = {}) {
  const box = el('div', `field${wide ? ' wide' : ''}`); const id = `field-${name}`;
  const control = el(type === 'textarea' ? 'textarea' : options ? 'select' : 'input'); control.id = id; control.name = name;
  if (options) for (const [value, label] of options) { const option = el('option', '', label); option.value = value; control.append(option); }
  else if (type !== 'textarea') control.type = type;
  if (type === 'checkbox') control.checked = value === true; else control.value = options && value === '' ? options[0][0] : value;
  if (required) control.required = true; if (min !== undefined) control.min = min; if (max !== undefined) control.max = max;
  const text = el('label', '', label); text.htmlFor = id;
  if (type === 'checkbox') { text.className = 'check'; text.prepend(control); box.append(text); } else add(box, text, control);
  if (help) box.append(el('small', '', help)); form.append(box); return control;
}
function submit(form, text, action) {
  const error = el('div', 'form-error'); error.role = 'alert';
  const control = el('button', 'primary', text); control.type = 'submit';
  add(form, error, add(el('div', 'dialog-actions'), button('Cancel', () => dialog.close()), control));
  form.addEventListener('submit', async event => { event.preventDefault(); error.textContent = ''; control.disabled = true; try { await action(new FormData(form)); } catch (err) { error.textContent = err.message; } finally { control.disabled = false; } });
}
function numeric(data, key, scale = 1) { const value = Number(data.get(key)) * scale; if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Enter a positive whole amount'); return value; }

async function login(message) {
  const screen = el('div', 'login'); const panel = el('div', 'login-card'); add(panel, brand(), el('h1', '', 'Welcome home.'), el('p', '', 'Sign in to manage your native Bitcoin and Lightning nodes.'));
  if (message) panel.append(notice(message, true));
  const form = el('form'); const password = field(form, 'password', 'Dashboard password', { type: 'password', required: true }); password.autocomplete = 'current-password';
  const error = el('div', 'form-error'); error.role = 'alert'; const enter = el('button', 'primary', 'Sign in'); enter.type = 'submit'; add(form, error, enter);
  form.addEventListener('submit', async event => { event.preventDefault(); enter.disabled = true; try { acceptSession(await api('/login', { method: 'POST', body: { password: password.value } })); password.value = ''; await start(); } catch (err) { error.textContent = err.message; } finally { enter.disabled = false; } });
  add(panel, form, el('small', '', 'On Umbrel, use the App Password shown for LDK Node. For a local installation, read data/dashboard-password on your server. A new tab may ask you to sign in again.')); add(screen, panel); app.replaceChildren(screen);
}

async function start() { state.config = await api('/config'); await refresh(); }
async function refresh() {
  if (!state.session?.authenticated) return;
  if (state.polling) { refreshQueued = true; return; }
  state.polling = true;
  const session = state.session;
  const revision = walletRevision;
  try {
    const wallets = await api('/wallets');
    if (state.session !== session) return;
    if (walletRevision !== revision) { refreshQueued = true; return; }
    state.wallets = wallets;
    if (state.selected && !active()) state.selected = null;
    const walletId = state.selected;
    if (active()?.status === 'running') {
      const methods = ['info', 'balance', 'channels', 'payments', 'peers', 'offline_status', 'events'];
      const responses = await Promise.allSettled(methods.map(method => api(`/wallets/${walletId}/${method}`)));
      if (state.session !== session) return;
      if (walletRevision !== revision) { refreshQueued = true; return; }
      if (state.selected !== walletId) { refreshQueued = true; return; }
      for (let i = 0; i < methods.length; i++) state.data[methods[i]] = responses[i].status === 'fulfilled' ? responses[i].value : null;
      state.data.error = responses.find(value => value.status === 'rejected')?.reason?.message;
    } else state.data = {};
    if (state.session?.authenticated && !dialog.open) render();
  } catch (error) { if (state.session === session) toast(error.message, true); }
  finally {
    state.polling = false;
    if (refreshQueued) { refreshQueued = false; refresh(); }
  }
}
function navigate(view, id = state.selected) { state.view = view; state.selected = id; state.data = {}; render(); refresh(); }
function pairingRenderKey() {
  // Tor progress updates its notice without remounting the selected QR or URI.
  const wallets = state.wallets.map(({ tor_status, tor_bootstrap, tor_error, tor_address, ...wallet }) => wallet);
  return active() && state.view === 'pairing' ? JSON.stringify([state.selected, wallets, state.data.error || null]) : null;
}
function render() {
  const wallet = active();
  const pairingKey = pairingRenderKey();
  // Polling keeps the mounted pairing controls, QR and selection intact. Only
  // visible wallet state or changed connection details need new content.
  if (pairingKey && pairingView?.key === pairingKey && pairingView.root.isConnected) { updatePairing(pairingView, wallet); return; }
  pairingView = null;
  const layout = el('div', 'layout'); const sidebar = el('aside', 'sidebar'); add(sidebar, brand());
  add(sidebar, add(el('div', 'nav'), button('◫   All wallets', () => navigate('overview', null), !wallet ? 'active' : '')));
  if (state.wallets.length) {
    sidebar.append(el('div', 'nav-label', 'Workspace'));
    const select = el('select', 'wallet-switch'); select.setAttribute('aria-label', 'Select wallet');
    const placeholder = el('option', '', 'Choose a wallet'); placeholder.value = ''; select.append(placeholder);
    for (const item of state.wallets) { const option = el('option', '', item.name); option.value = item.id; select.append(option); }
    select.value = state.selected || ''; select.addEventListener('change', () => navigate('overview', select.value || null)); sidebar.append(select);
  }
  if (wallet) {
    sidebar.append(el('div', 'nav-label', 'Manage wallet'));
    const nav = el('nav', 'nav');
    for (const [view, symbol, label] of [['overview','◈','Overview'],['channels','⇄','Channels & peers'],['activity','↗','Activity'],['pairing','▦','Pair Chicory'],['offline','☾','Offline receive'],['settings','⚙','Settings'],['logs','≡','Logs']]) {
      const control = button('', () => navigate(view), state.view === view ? 'active' : ''); add(control, el('span', 'symbol', symbol), document.createTextNode(label)); nav.append(control);
    }
    sidebar.append(nav);
  }
  add(sidebar, add(el('div', 'sidebar-bottom'), el('p', '', 'Native LDK Node\nLocal, self-custodial infrastructure.'), button('+ New wallet', () => walletForm(), 'small'), button('Sign out', () => run(async () => { try { await api('/logout', { method: 'POST', body: {} }); } finally { clearSession(); login(); } }), 'small ghost')));
  const main = el('main', 'main'); const menu = button('☰', () => sidebar.classList.toggle('open'), 'ghost mobile-menu'); menu.setAttribute('aria-label', 'Open navigation');
  add(main, add(el('header', 'topbar'), add(el('div', 'actions'), menu, el('span', 'crumb', wallet ? `Wallets / ${wallet.name}` : 'Your workspace')), add(el('div', 'top-actions'), badge('Local installation', 'green'), button('Refresh', () => refresh(), 'small'))));
  const content = el('div', 'content');
  if (!wallet) renderWallets(content); else {
    const titles = { overview: wallet.name, channels: 'Channels & peers', activity: 'Activity', pairing: 'Pair Chicory', offline: 'Offline receive', settings: 'Wallet settings', logs: 'Node logs' };
    const actions = add(el('div', 'actions'), walletBadge(wallet));
    if (wallet.status === 'running') add(actions, button('Receive', receive, 'primary'), button('Send', send));
    else if (!wallet.deletion_pending && !['starting','stopping'].includes(wallet.status)) actions.append(button('Start wallet', () => run(() => api(`/wallets/${wallet.id}/start`, { method: 'POST', body: {} }), 'Wallet started'), 'primary'));
    add(content, add(el('div', 'page-head'), add(el('div'), el('div', 'eyebrow', networks[wallet.network]), el('h1', '', titles[state.view]), el('p', '', state.view === 'overview' ? 'A clear view of your Bitcoin and Lightning balance.' : 'Manage your native LDK node.')), actions));
    if (wallet.last_error) content.append(notice(wallet.last_error, true));
    if (state.data.error) content.append(notice(state.data.error, true));
    if (wallet.deletion_pending) renderDeletion(content, wallet);
    else if (state.view === 'pairing') renderPairing(content, wallet, pairingKey);
    else ({ overview: renderOverview, channels: renderChannels, activity: renderActivity, offline: renderOffline, settings: renderSettings, logs: renderLogs }[state.view] || renderOverview)(content, wallet);
  }
  add(main, content); add(layout, sidebar, main); app.replaceChildren(layout);
}
function renderWallets(content) {
  const hero = el('section', 'hero'); const bolt = el('img', 'bolt'); bolt.src = '/icon.svg'; bolt.alt = '';
  add(hero, el('div', 'eyebrow', 'Self-custodial by design'), el('h1', '', 'A native home for your Bitcoin.'), el('p', '', 'Run independent LDK nodes, pair Chicory, and keep your wallet infrastructure on your own Umbrel.'), button('+ Create wallet', () => walletForm(), 'primary'), bolt); content.append(hero);
  const rows = el('div');
  for (const wallet of state.wallets) {
    const name = button(wallet.name, () => navigate('overview', wallet.id), 'name-button');
    add(rows, add(el('div', 'wallet-row'), el('div', 'wallet-icon', 'ϟ'), add(el('div', 'grow'), add(el('h3'), name), el('p', '', `${networks[wallet.network]} · ${wallet.chain_source.type} · Native LDK`)), add(el('div', 'actions'), walletBadge(wallet), button('Open', () => navigate('overview', wallet.id), 'small'))));
  }
  if (!state.wallets.length) rows.append(empty('Your first node starts here', 'Choose your Bitcoin network and chain source. Every wallet has its own native identity and private storage.'));
  content.append(card('Your wallets', rows, badge(`${state.wallets.length} of 8`)));
  add(content, add(el('div', 'grid'), card('Made for your own infrastructure', el('p', '', 'Use your Umbrel Bitcoin Core, Electrum, or Esplora server. Configure Chicory liquidity and offline settlement for each wallet.')), card('Keep the whole wallet safe', add(el('div'), el('p', '', 'Download an encrypted backup of all wallets, including current Lightning channel state. Wallets remain stopped after the backup.'), button('Back up all wallets', backupAll)))));
}
function renderOverview(content, wallet) {
  const balance = state.data.balance || {}; const channels = state.data.channels || [];
  add(content, add(el('div', 'stats'), stat('On-chain balance', fmt(balance.onchain_total_sats), `${fmt(balance.onchain_spendable_sats)} sats available to spend`), stat('Lightning balance', fmt(balance.lightning_total_sats), `${channels.filter(channel => channel.is_usable).length} usable channels`), stat('Chicory funding limit', fmt(wallet.chicory.max_total_fronted_sats), wallet.chicory.enabled ? 'Liquidity provider enabled' : 'Liquidity provider disabled')));
  const info = state.data.info || {};
  const summary = detail([['Node status', wallet.status], ['Network', networks[wallet.network]], ['Chain height', fmt(info.best_block_height)], ['Node ID', info.node_id || 'Start wallet to load identity'], ['Chain source', wallet.chain_source.type], ['Native peers', String(state.data.peers?.length ?? '...')]]);
  const phone = add(el('div'), el('p', '', 'Use this native node as your Chicory primary. Share its Lightning address or enable the optional Iroh phone link.'), button('Pair your phone', () => navigate('pairing'), 'primary'));
  add(content, add(el('div', 'grid'), card('Node overview', summary), card('Your phone. Your primary.', phone)));
  renderActivity(content, wallet, true);
}
function renderActivity(content, wallet, compact = false) {
  const payments = state.data.payments || [];
  const rows = (compact ? payments.slice(0, 5) : payments).map(payment => [payment.direction || payment.kind || 'Payment', sats(payment.amount_msat), payment.status || 'Unknown', (payment.updated_at || payment.created_at) ? new Date(typeof (payment.updated_at || payment.created_at) === 'number' ? (payment.updated_at || payment.created_at) * 1000 : (payment.updated_at || payment.created_at)).toLocaleString() : '', short(payment.id)]);
  if (!compact && state.data.events?.length) content.append(card('Native events', table(['Time', 'Event'], state.data.events.slice().reverse().slice(0, 100).map(event => [event.timestamp ? new Date(event.timestamp * 1000).toLocaleString() : '', event.kind || event.event || JSON.stringify(event)]))));
  content.append(card(compact ? 'Recent activity' : 'Payments', rows.length ? table(['Direction','Amount (sats)','Status','Updated','Payment ID'], rows) : empty(wallet.status === 'running' ? 'No payments yet' : 'Wallet is stopped', wallet.status === 'running' ? 'Incoming and outgoing payments will appear here.' : 'Start this wallet to load its activity.')));
}
function renderChannels(content, wallet) {
  const channels = state.data.channels || []; const rows = channels.map(channel => [short(channel.counterparty_node_id), fmt(channel.value_sats), sats(channel.outbound_capacity_msat), sats(channel.inbound_capacity_msat), badge(channel.is_usable ? 'Usable' : channel.is_channel_ready ? 'Disconnected' : 'Pending', channel.is_usable ? 'green' : 'amber'), button('Manage', () => channelForm(channel), 'small')]);
  content.append(card('Lightning channels', rows.length ? table(['Peer','Capacity (sats)','Outbound','Inbound','State',''], rows) : empty('No channels to show', 'Fund your on-chain wallet and open a channel, or enable the Chicory provider for automatic requests.'), available('open') ? button('Open channel', () => openChannel(), 'small primary') : null));
  const peers = state.data.peers || [];
  content.append(card('Peers', peers.length ? table(['Node','Address','Connection',''], peers.map(peer => [short(peer.node_id), peer.address || '', badge(peer.is_connected ? 'Connected' : 'Disconnected', peer.is_connected ? 'green' : ''), button('Disconnect', () => run(() => rpc('disconnect', { node_id: peer.node_id }), 'Peer disconnected'), 'small')])) : empty('No connected peers', 'Connect to a Lightning node using its public key and address.'), available('connect') ? button('Connect peer', connectPeer, 'small') : null));
}
function renderPairing(content, wallet, key) {
  const root = el('div'); content.append(root);
  const body = el('div'); root.append(card('Connect Chicory to this primary', body));
  const view = { root, key, walletId: wallet.id, session: state.session, signature: null, qrUri: null, qrImage: null, qrRequest: 0, qrLoading: false, loading: false, error: null };
  pairingView = view;
  if (wallet.status !== 'running') { body.append(empty('Start this wallet first', 'Pairing uses the live node identity.')); return; }
  body.append(el('p', '', 'Loading connection details...'));
  updatePairing(view, wallet);
}
function currentPairing(view) {
  return pairingView === view && state.session === view.session && state.session?.authenticated && state.view === 'pairing' && state.selected === view.walletId && active()?.status === 'running' && view.key === pairingRenderKey();
}
function torStatus(value) {
  const labels = { disabled: 'Disabled', external: 'Existing onion service', stopped: 'Stopped', starting: 'Starting Tor', bootstrapping: `Connecting to Tor (${value.tor_bootstrap || 0}%)`, ready: 'Connected to Tor', failed: 'Tor unavailable' };
  return labels[value.tor_status] || 'Disabled';
}
function torNotice(value) {
  if (value.tor_managed || value.tor?.enabled) {
    if (value.tor_status === 'failed') return notice(`${torStatus(value)}. ${value.tor_error || 'Stop and start the wallet to retry.'} Local TCP and Iroh remain available.`, true);
    if (value.tor_status === 'stopped') return notice('Tor is enabled. Start the wallet to create its onion address.');
    return notice(`${torStatus(value)}. ${value.tor_address ? 'Your onion address is available. It can take a few minutes to become reachable.' : 'Your onion address will appear automatically.'} This enables incoming Tor connections; outgoing node connections keep their existing routing.`);
  }
  if (value.tor_status === 'external' || value.tor_onion_address) return notice('Using an existing onion service. It must forward to this wallet’s native Lightning port.');
  return notice('To connect a client over Tor, stop the wallet and choose Settings > Edit configuration > Enable Tor connections, then start it again. Local TCP and Iroh can stay enabled.');
}
function updateTorNotice(view) {
  const pairing = view.pairing;
  const signature = JSON.stringify([pairing.tor_managed, pairing.tor_status, pairing.tor_bootstrap, pairing.tor_error, pairing.tor_address]);
  if (signature === view.torSignature) return;
  view.torNoticeRoot.replaceChildren(torNotice(pairing)); view.torSignature = signature;
}
function pairingQr(image, label) {
  const qr = el('img', 'qr'); qr.src = image; qr.alt = `${label} connection QR code`; return qr;
}
// A selection replaces the old QR immediately. Request revisions prevent a late
// response for another transport from being shown beside the current URI.
async function updatePairingQr(view) {
  if (!currentPairing(view) || !view.connection || view.qrLoading || (view.qrUri === view.connection.uri && view.qrImage)) return;
  const { uri, label } = view.connection; const request = ++view.qrRequest;
  view.qrLoading = true;
  const pending = el('div', 'qr qr-loading', 'Loading QR code...'); pending.role = 'status'; view.qrSlot.replaceChildren(pending);
  try {
    const { image } = await api(`/wallets/${view.walletId}/qr`, { method: 'POST', body: { text: uri } });
    if (!currentPairing(view) || view.qrRequest !== request) return;
    view.qrSlot.replaceChildren(pairingQr(image, label));
    Object.assign(view, { qrUri: uri, qrImage: image });
  } catch (error) {
    if (!currentPairing(view) || view.qrRequest !== request) return;
    const failed = add(el('div', 'qr qr-loading'), el('p', '', `Unable to load QR code: ${error.message} Copy the connection URI or retry.`), button('Retry QR code', () => updatePairingQr(view)));
    failed.role = 'status'; view.qrSlot.replaceChildren(failed);
  } finally { if (view.qrRequest === request) view.qrLoading = false; }
}
function showPairingConnection(view) {
  const pairing = view.pairing; const connections = pairingConnections(pairing);
  const preferred = pairingSelections.get(view.walletId);
  const connection = selectedPairingConnection(connections, preferred);
  // Invalidate requests before replacing their destination, including when an
  // address disappears or changes during a background refresh.
  view.qrRequest++; view.qrLoading = false; view.connection = connection;
  const replacement = el('div'); const body = el('div'); replacement.append(card('Connect Chicory to this primary', body));
  view.torNoticeRoot = el('div', 'tor-connection-status'); view.torSignature = null;
  replacement.append(view.torNoticeRoot); updateTorNotice(view);
  if (connection) {
    pairingSelections.set(view.walletId, connection.type);
    const selector = field(body, 'connection_method', 'Connection method', { value: connection.type, options: connections.map(item => [item.type, item.label]), help: 'Choose the address to scan or copy for this client. Enabled connections stay available.' });
    selector.addEventListener('change', () => {
      if (!currentPairing(view)) return;
      pairingSelections.set(view.walletId, selector.value); showPairingConnection(view);
      view.root.querySelector('[name="connection_method"]').focus({ preventScroll: true });
    });
    if (preferred && preferred !== connection.type) {
      const label = { iroh: 'Iroh', tcp: 'Local network (TCP)', tor: 'Tor' }[preferred];
      body.append(notice(`${label} is no longer available. Showing ${connection.label}.`));
    }
    view.qrSlot = el('div', 'pairing-qr');
    if (view.qrUri === connection.uri && view.qrImage) view.qrSlot.append(pairingQr(view.qrImage, connection.label));
    else view.qrSlot.append(el('div', 'qr qr-loading', 'Loading QR code...'));
    add(body, view.qrSlot, copyValue(connection.uri), el('p', 'connection-help', connection.help));
    add(body, el('hr', 'divider'), detail([['Network', networks[pairing.network]], ['Transport', connection.label], ['Node ID', pairing.node_id]]));
    const steps = el('ol', 'instructions'); for (const step of ['Open Chicory on the same Bitcoin network.', 'Choose an external primary and scan this QR code or paste the connection URI.', 'Fund this node if you enable liquidity provisioning, then complete pairing in Chicory.']) steps.append(el('li', '', step)); body.append(steps);
    if (pairing.tor_uri && connection.type !== 'tor') replacement.append(card('Optional Tor fallback', add(el('div'), copyValue(pairing.tor_uri), el('p', '', 'Paste this separately into Chicory’s Tor fallback field, or choose Tor above to scan it as the primary connection.'))));
  } else body.append(empty('No connection addresses available', 'Connection details will update when an address becomes available.'));
  // A local selection cannot make a failed pairing refresh current again.
  if (view.error) replacement.append(view.error);
  const scroll = { left: window.scrollX, top: window.scrollY, behavior: 'instant' };
  view.root.replaceChildren(...replacement.childNodes);
  window.scrollTo(scroll);
  updatePairingQr(view);
}
async function updatePairing(view, wallet) {
  if (view.loading || !currentPairing(view)) return;
  view.loading = true;
  try {
    const pairing = await api(`/wallets/${wallet.id}/pairing`);
    if (!currentPairing(view)) return;
    const signature = JSON.stringify([pairing.network, pairing.node_id, pairing.iroh_uri, pairing.tcp_uri, pairing.tor_uri, pairing.tor_managed]);
    view.pairing = pairing;
    if (signature === view.signature) { view.error?.remove(); view.error = null; updateTorNotice(view); updatePairingQr(view); return; }
    view.error?.remove(); view.error = null;
    Object.assign(view, { signature, pairing });
    showPairingConnection(view);
  } catch (error) {
    if (!currentPairing(view)) return;
    if (!view.error) { view.error = notice('', true); view.root.append(view.error); }
    view.error.textContent = view.signature ? `Unable to refresh pairing: ${error.message} The displayed connection details may be outdated.` : error.message;
  } finally { view.loading = false; }
}
function renderOffline(content, wallet) {
  const status = state.data.offline_status || {}; const epochs = status.epochs || [];
  content.append(card('Offline settlement', add(el('div'), badge(wallet.chicory.offline_enabled ? 'Enabled' : 'Disabled', wallet.chicory.offline_enabled ? 'green' : ''), el('p', '', 'Chicory can reserve native channel vouchers and receive through this online node while the phone is offline. Native monitor persistence protects settlement and recovery.'), button('Configure provider', () => navigate('settings')))));
  if (epochs.length) content.append(card('Voucher books', table(['Channel','Phase','Slots','Reserved (sats)','Settling','Settled'], epochs.map(epoch => [short(epoch.channel_id), epoch.phase, String(epoch.slot_count), sats(epoch.reserved_msat), String(epoch.settling_count), String(epoch.settled_count)]))));
  else content.append(card('Voucher books', empty('No active books', 'Reservations appear after a paired Chicory wallet enables offline receiving.')));
  content.append(notice('A draining concurrent voucher book can require a force close and an on-chain timeout before it retires. Keep this node online and back up its complete data directory.'));
}
function renderSettings(content, wallet) {
  const summary = detail([['Wallet', wallet.name], ['Network', networks[wallet.network]], ['Chain backend', wallet.chain_source.type], ['Autostart', wallet.autostart ? 'Enabled' : 'Disabled'], ['Chicory provider', wallet.chicory.enabled ? 'Enabled' : 'Disabled'], ['Offline settlement', wallet.chicory.offline_enabled ? 'Enabled' : 'Disabled'], ['Iroh', wallet.iroh.enabled ? 'Enabled' : 'Disabled'], ['Flat fee', `${fmt(wallet.chicory.flat_fee_sat)} sats`], ['Proportional fee', `${fmt(wallet.chicory.fee_ppm)} ppm`], ['Client funding cap', `${fmt(wallet.chicory.max_client_funding_sats)} sats`]]);
  content.append(card('Configuration', summary, button('Edit configuration', () => walletForm(wallet), 'small')));
  const tor = add(el('div'), detail([['Tor connections', torStatus(wallet)], ['Onion address', wallet.tor_address || 'Not available yet']]), el('hr', 'divider'), torNotice(wallet));
  content.append(card('Tor connections', tor));
  content.append(card('Recovery & backup', add(el('div'), el('p', '', wallet.recovery_kind === 'mnemonic' ? 'Save your 24-word recovery phrase somewhere private. Make a full backup to preserve Lightning channel state as well.' : 'This wallet was created with a binary seed and has no recovery phrase. An encrypted full backup preserves its existing seed, identity and channel state.'), add(el('div', 'actions'), button('Recovery phrase', () => recoveryPhrase(wallet)), button('Back up all wallets', backupAll)))));
  content.append(card('Node lifecycle', add(el('div'), el('p', '', 'Stop the wallet before changing settings or making a full backup. Restart preserves its native identity and channel state.'), add(el('div', 'actions'), button('Sync now', () => run(() => rpc('sync'), 'Synchronization completed')), button('Stop wallet', () => confirmAction('Stop this wallet?', 'Payments and offline settlement need this node online. You can start it again from the dashboard.', () => api(`/wallets/${wallet.id}/stop`, { method: 'POST', body: {} })), 'danger')))));
  renderDeletion(content, wallet);
  content.append(notice('This local build is experimental. The qualification report in the package records supported paths and remaining interoperability limits, including the installed wallet commitment fee policy.'));
}

function renderDeletion(content, wallet) {
  const pending = wallet.deletion_pending === true;
  const remove = button(pending ? 'Finish deleting wallet' : 'Delete wallet', () => deleteWallet(wallet), 'danger');
  remove.disabled = !pending && wallet.status !== 'stopped';
  const description = pending
    ? 'Deletion has started and some wallet data may already be gone. This wallet cannot run or provide a new recovery backup. Confirm again to finish removing its remaining data.'
    : 'Permanently remove this wallet and its identity, channel state, configuration, Tor identity and Iroh identity from this app. This does not send or recover funds.';
  const body = add(el('div'), notice(description, true));
  if (pending) body.append(detail([['Wallet', wallet.name], ['Network', networks[wallet.network]]]));
  else add(body, el('p', '', 'Save a full backup first to preserve wallet data. A recovery phrase alone cannot restore Lightning channels.'), wallet.status !== 'stopped' ? el('p', '', 'Stop this wallet before deleting it. Deletion does not stop a running wallet automatically.') : null);
  const actions = add(el('div', 'actions'), !pending ? button('Back up all wallets', backupAll) : null, remove);
  body.append(actions); content.append(card(pending ? 'Deletion pending' : 'Delete wallet', body));
}

// The dialog captures its target, while the server enforces stopped state and
// exact confirmation. A submitted deletion continues even if navigation occurs.
function deleteWallet(wallet) {
  if (!wallet.deletion_pending && wallet.status !== 'stopped') { toast('Stop this wallet before deleting it.', true); return; }
  const body = modal(wallet.deletion_pending ? 'Finish deleting wallet?' : 'Delete wallet?');
  const session = state.session; const form = el('form');
  let pending = false; let deletionPending = wallet.deletion_pending === true; let missing = false;
  const currentSession = () => state.session === session && state.session?.authenticated;
  const sameDialog = () => currentSession() && dialog.open && body.isConnected;
  const current = () => sameDialog() && state.selected === wallet.id;
  const warning = notice('', true);
  const backup = button('Back up all wallets', backupAll);
  add(body, detail([['Wallet', wallet.name], ['Network', networks[wallet.network]]]), el('hr', 'divider'), warning, backup);
  const name = field(form, 'confirmation_name', 'Type the wallet name to confirm', { required: true, help: `Enter exactly: ${wallet.name}` });
  name.autocomplete = 'off'; name.spellcheck = false;
  const acknowledge = field(form, 'acknowledge_data_loss', 'I understand this permanently deletes this wallet’s data from this app', { type: 'checkbox', required: true });
  const error = el('div', 'form-error'); error.role = 'alert';
  const cancel = button('Cancel', () => dialog.close());
  const remove = el('button', 'danger'); remove.type = 'submit';
  const close = dialog.querySelector('.dialog-head button');
  const update = () => {
    warning.textContent = deletionPending
      ? 'Deletion is pending and some data may already be removed. A new backup or recovery phrase cannot restore that missing data. Confirm again to finish deleting this wallet.'
      : 'This permanently removes this wallet’s identity, channel state, configuration, Tor identity and Iroh identity from this app. It does not send or recover funds. Save a full backup first; a recovery phrase alone cannot restore Lightning channels.';
    backup.hidden = deletionPending || missing; backup.disabled = pending;
    name.disabled = pending || missing; acknowledge.disabled = pending || missing;
    cancel.disabled = pending; close.disabled = pending;
    remove.textContent = pending ? 'Deleting wallet...' : deletionPending ? 'Finish deleting wallet' : 'Permanently delete wallet';
    remove.disabled = pending || missing || !current() || name.value !== wallet.name || !acknowledge.checked;
  };
  const escape = event => { if (pending && body.isConnected) event.preventDefault(); };
  dialog.addEventListener('cancel', escape);
  dialog.addEventListener('close', () => dialog.removeEventListener('cancel', escape), { once: true });
  name.addEventListener('input', update); acknowledge.addEventListener('change', update);
  add(form, error, add(el('div', 'dialog-actions'), cancel, remove)); body.append(form); update();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || missing || !current()) return;
    error.textContent = '';
    if (name.value !== wallet.name || !acknowledge.checked) { error.textContent = 'Enter the exact wallet name and acknowledge permanent data loss.'; return; }
    pending = true; update();
    try {
      const result = await api(`/wallets/${wallet.id}`, { method: 'DELETE', body: { confirmation_name: name.value, acknowledge_data_loss: true } });
      if (!currentSession()) return;
      if (result.deleted !== true || result.id !== wallet.id) throw new Error('The dashboard did not confirm which wallet was deleted.');
      // Invalidate every earlier list/RPC read before removing the target so a
      // delayed poll cannot resurrect it after the server confirms deletion.
      walletRevision++;
      state.wallets = state.wallets.filter(item => item.id !== wallet.id); pairingSelections.delete(wallet.id);
      if (current()) {
        state.selected = state.wallets[0]?.id || null; state.view = 'overview'; state.data = {};
        dialog.close(); render(); toast('Wallet deleted.');
      } else {
        if (sameDialog()) dialog.close();
        if (state.selected === wallet.id) { state.selected = null; state.view = 'overview'; state.data = {}; }
        if (!dialog.open) render();
      }
      await refresh();
    } catch (failure) {
      if (!sameDialog()) return;
      error.textContent = `Deletion was not confirmed: ${failure.message}`;
      // Reconcile a lost or failed response without retrying the destructive
      // operation. Pending records only offer explicit deletion completion.
      try {
        const wallets = await api('/wallets');
        if (!sameDialog()) return;
        walletRevision++; state.wallets = wallets;
        const remaining = wallets.find(item => item.id === wallet.id);
        deletionPending = remaining?.deletion_pending === true; missing = !remaining;
        if (missing) error.textContent += ' This wallet is no longer listed. Close this dialog to view the remaining wallets.';
      } catch { if (sameDialog()) error.textContent += ' The wallet list could not be refreshed. Check it before retrying.'; }
    } finally { pending = false; if (sameDialog()) update(); }
  });
}

// Sensitive values live only in an open dialog, never in dashboard state or storage.
// Closing, replacing or hiding the dialog also invalidates any pending response.
function clearSensitiveDialog() { const cleanup = sensitiveCleanup; sensitiveCleanup = null; cleanup?.(); }
function recoveryPhrase(wallet) {
  const body = modal('Recovery phrase'); const session = state.session;
  const controller = new AbortController(); let phrase = ''; let timer;
  sensitiveCleanup = () => { controller.abort(); clearTimeout(timer); phrase = ''; body.replaceChildren(); };
  if (wallet.recovery_kind !== 'mnemonic') {
    add(body, notice('This existing wallet uses a binary seed. No mnemonic phrase was generated, and creating one now would change the wallet identity.'), el('p', '', 'Use an encrypted full backup to preserve this wallet. Your existing funds and keys stay unchanged.'), button('Back up all wallets', backupAll, 'primary'));
    return;
  }
  add(body, notice('Anyone with this phrase can spend your Bitcoin. Keep it private. A phrase alone cannot restore current Lightning channels; save an encrypted full backup too.'), el('p', '', `Reveal the 24-word phrase for ${wallet.name}. It is hidden again after one minute, when you close this dialog, or when you leave this tab.`));
  const reveal = button('Reveal recovery phrase', async () => {
    reveal.disabled = true; error.textContent = '';
    try {
      const result = await api(`/wallets/${wallet.id}/recovery`, { method: 'POST', body: { confirm: true }, signal: controller.signal });
      if (controller.signal.aborted || state.session !== session || !dialog.open || !body.isConnected) return;
      if (result.kind !== 'mnemonic' || typeof result.mnemonic !== 'string' || result.mnemonic.split(' ').length !== 24) throw new Error('Recovery phrase is unavailable. Make a full backup instead.');
      phrase = result.mnemonic; result.mnemonic = '';
      const words = el('ol', 'recovery-words'); words.setAttribute('aria-label', 'Recovery phrase words');
      for (const word of phrase.split(' ')) words.append(el('li', '', word));
      body.replaceChildren(notice('Write these words down in order and store them privately. Clipboard history and other apps may retain a copied phrase. This phrase does not replace a full Lightning backup.'), words, add(el('div', 'actions'), button('Copy phrase', () => copy(phrase)), button('I have saved it', () => { clearSensitiveDialog(); dialog.close(); }, 'primary')));
      timer = setTimeout(() => { clearSensitiveDialog(); dialog.close(); }, 60_000);
    } catch (failure) { if (!controller.signal.aborted) { error.textContent = failure.message; reveal.disabled = false; } }
  }, 'primary');
  const error = el('div', 'form-error'); error.role = 'alert'; add(body, error, reveal);
}

function backupAll() {
  if (state.wallets.some(wallet => wallet.deletion_pending)) { toast('Finish pending wallet deletion before creating a full backup.', true); return; }
  const body = modal('Back up all wallets'); const session = state.session;
  const controller = new AbortController(); const form = el('form');
  add(body, notice('This stops every wallet and pauses payments and offline settlement. Wallets stay stopped after download. Start them again when your backup is stored safely.'), el('p', '', 'The encrypted backup contains every wallet, its keys and current channel state, connection credentials and dashboard sign-in. Keep both the file and its password safe. The password cannot be recovered.'));
  const password = field(form, 'backup_password', 'Backup password', { type: 'password', required: true, help: 'At least 12 characters. Use a strong, unique password.' });
  const confirmation = field(form, 'backup_confirmation', 'Confirm backup password', { type: 'password', required: true });
  for (const control of [password, confirmation]) { control.minLength = 12; control.maxLength = 512; control.autocomplete = 'new-password'; }
  const consent = field(form, 'backup_consent', 'I agree to stop all wallets and keep the backup private', { type: 'checkbox', required: true });
  sensitiveCleanup = () => { controller.abort(); password.value = ''; confirmation.value = ''; body.replaceChildren(); };
  submit(form, 'Stop wallets and download backup', async () => {
    if (!consent.checked) throw new Error('Confirm that all wallets can stop');
    if (password.value.length < 12) throw new Error('Use at least 12 characters for the backup password');
    if (password.value !== confirmation.value) throw new Error('Backup passwords do not match');
    const wallets = await api('/wallets', { signal: controller.signal });
    // Check every wallet before stopping any sibling. A pending deletion can
    // contain partial data and cannot participate in a valid full backup.
    if (wallets.some(wallet => wallet.deletion_pending)) throw new Error('Finish pending wallet deletion before creating a full backup. No wallets were stopped.');
    for (const wallet of wallets) {
      if (controller.signal.aborted) return;
      await api(`/wallets/${wallet.id}/stop`, { method: 'POST', body: {}, signal: controller.signal });
    }
    if (controller.signal.aborted) return;
    const download = api('/backup/export', { method: 'POST', body: { confirm: true, passphrase: password.value }, binary: true, signal: controller.signal });
    password.value = ''; confirmation.value = '';
    const archive = await download;
    if (controller.signal.aborted || state.session !== session || !dialog.open || !body.isConnected) return;
    const url = URL.createObjectURL(archive); const link = el('a');
    link.href = url; link.download = `ldk-node-backup-${new Date().toISOString().slice(0, 10)}.ldkbackup`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    clearSensitiveDialog(); dialog.close(); toast('Backup download started. Wallets are stopped.'); await refresh();
  });
  add(body, form, el('p', '', 'Restore offline with the restore-backup script included in the release. Restore the complete state with the app stopped and never run two copies of the same wallet.'));
}
async function renderLogs(content, wallet) { const pre = el('pre', 'log', 'Loading recent process diagnostics...'); content.append(card('Recent native diagnostics', pre)); try { pre.textContent = (await api(`/wallets/${wallet.id}/logs`)).text || 'No recent process diagnostics. Native file logs remain in this wallet data directory.'; } catch (error) { pre.textContent = error.message; } }

function walletForm(wallet) {
  if (wallet && !['stopped', 'failed'].includes(wallet.status)) { toast('Stop the wallet before editing settings', true); return; }
  const body = modal(wallet ? 'Edit wallet' : 'Create a native wallet');
  body.append(el('p', '', 'Each wallet runs an independent native LDK node. Chain credentials stay on your server.'));
  const form = el('form'); const grid = el('div', 'form-grid'); form.append(grid);
  field(grid, 'name', 'Wallet name', { value: wallet?.name || '', required: true });
  const network = field(grid, 'network', 'Bitcoin network', { value: wallet?.network || 'bitcoin', options: Object.entries(networks) }); if (wallet) network.disabled = true;
  const source = field(grid, 'source', 'Chain source', { value: wallet?.chain_source.type || 'electrum', options: [['electrum','Electrum'],['bitcoind','Bitcoin Core RPC'],['esplora','Esplora']] });
  field(grid, 'advertised_host', 'Server LAN host', { value: wallet?.advertised_host || '', help: 'For TCP pairing, such as 192.168.1.20 or umbrel.local.' });
  const chainFields = el('div'); form.append(chainFields);
  const renderSource = () => {
    chainFields.replaceChildren();
    if (source.value === 'bitcoind') {
      const fields = el('div', 'form-grid'); chainFields.append(fields);
      field(fields, 'host', 'RPC host', { value: wallet?.chain_source.host || 'bitcoin_bitcoind_1', required: true });
      field(fields, 'port', 'RPC port', { type: 'number', value: wallet?.chain_source.port || (network.value === 'regtest' ? 18443 : network.value === 'signet' ? 38332 : network.value === 'testnet' ? 18332 : 8332), min: 1, max: 65535, required: true });
      field(fields, 'user', 'RPC username', { value: wallet?.chain_source.user || '', required: true });
      field(fields, 'password', 'RPC password', { type: 'password', help: wallet?.chain_source.password_configured ? 'Leave blank to keep the saved password.' : undefined, required: !wallet?.chain_source.password_configured });
    } else if (source.value === 'electrum') {
      const presets = state.config.electrum_presets || [];
      const initial = wallet?.chain_source.type === 'electrum' ? wallet.chain_source.url : state.config.default_electrum_url || '';
      const preset = field(chainFields, 'electrum_preset', 'Electrum server', { value: presets.find(item => item.url === initial)?.id || 'custom', options: [['custom', 'Custom server'], ...presets.map(item => [item.id, item.label])], help: 'Local presets connect to an app installed on this same Umbrel. For another machine, enter its LAN IP or reachable hostname.' });
      const url = field(chainFields, 'url', 'Electrum URL', { value: initial, required: true, help: 'Use tcp://host:port or host:port:t for TCP; ssl://host:port or host:port:s for TLS. The hostname of this Umbrel is supported. Umbrel Electrs and Fulcrum presets use TCP.' });
      const result = el('div'); result.setAttribute('aria-live', 'polite');
      let revision = 0; const clearResult = () => { revision++; result.replaceChildren(); };
      network.addEventListener('change', clearResult);
      const selectPreset = value => { preset.value = value.id; url.value = value.url; clearResult(); };
      preset.addEventListener('change', () => { const chosen = presets.find(item => item.id === preset.value); if (chosen) selectPreset(chosen); });
      url.addEventListener('input', () => { preset.value = presets.find(item => item.url === url.value.trim())?.id || 'custom'; clearResult(); });
      if (/^tcp:\/\/electrs_server_1:50001\/?$/.test(initial)) {
        const electrs = presets.find(item => item.id === 'electrs');
        const legacy = notice("This older default is not Umbrel's Electrs address. Choose the installed server below, then save the settings for this existing wallet.");
        if (electrs) legacy.append(button('Use Umbrel Electrs', () => selectPreset(electrs), 'small'));
        chainFields.append(legacy);
      }
      const testConnection = button('Test connection', async () => {
        const testedRevision = revision; testConnection.disabled = true; result.replaceChildren(notice('Checking the Electrum connection and Bitcoin network...'));
        try {
          const checked = await api('/electrum/check', { method: 'POST', body: { url: url.value.trim(), network: network.value } });
          if (testedRevision !== revision) return;
          result.replaceChildren(notice(`Connected to ${networks[checked.network] || checked.network}. Network verified${Number.isSafeInteger(checked.height) ? `; server height ${checked.height.toLocaleString('en-US')}` : ''}.`));
        } catch (error) { if (testedRevision === revision) result.replaceChildren(notice(error.message, true)); }
        finally { testConnection.disabled = false; }
      }, 'small');
      add(chainFields, testConnection, result);
    } else field(chainFields, 'url', 'Esplora URL', { value: wallet?.chain_source.type === 'esplora' ? wallet.chain_source.url : '', required: true, help: 'An HTTP or HTTPS Esplora base URL on the selected network.' });
  }; source.addEventListener('change', renderSource); renderSource();
  add(form, el('hr', 'divider'), el('h3', '', 'Chicory provider'));
  field(form, 'provider', 'Fund eligible Chicory channels automatically', { type: 'checkbox', value: wallet?.chicory.enabled || false, help: 'Uses this wallet balance within the caps below.' });
  field(form, 'offline', 'Settle offline receive reservations', { type: 'checkbox', value: wallet?.chicory.offline_enabled || false });
  const fees = el('div', 'form-grid'); form.append(fees);
  field(fees, 'flat', 'Flat fee (sats)', { type: 'number', min: 0, max: 100000, value: wallet?.chicory.flat_fee_sat ?? 100 });
  field(fees, 'ppm', 'Fee rate (ppm)', { type: 'number', min: 0, max: 1000000, value: wallet?.chicory.fee_ppm ?? 1000 });
  field(fees, 'clientcap', 'Per-client funding cap (sats)', { type: 'number', min: 10000, max: 100000000, value: wallet?.chicory.max_client_funding_sats ?? 200000 });
  field(fees, 'totalcap', 'Total funding cap (sats)', { type: 'number', min: 10000, value: wallet?.chicory.max_total_fronted_sats ?? 1000000 });
  add(form, el('hr', 'divider'), el('h3', '', 'Phone transport & startup'));
  const tor = field(form, 'tor', 'Enable Tor connections', { type: 'checkbox', value: wallet?.tor?.enabled || false, help: 'Automatically creates a persistent onion address for this wallet. Local TCP and Iroh stay available. Applies to incoming connections only.' });
  if (!state.config.tor_available) {
    tor.disabled = !wallet?.tor?.enabled;
    form.append(notice('Managed Tor is not installed in this dashboard. Update the app to use automatic Tor, or provide an existing onion service below.'));
  }
  const externalTor = el('div'); form.append(externalTor);
  const onion = field(externalTor, 'tor_onion_address', 'Existing Tor onion address (optional)', { value: wallet?.tor_onion_address || '', help: 'Advanced: use a separately managed v3-onion-host.onion:port. Leave automatic Tor off when using this.' });
  const toggleTor = () => { externalTor.hidden = tor.checked; onion.disabled = tor.checked; };
  tor.addEventListener('change', toggleTor); toggleTor();
  field(form, 'iroh', 'Enable Iroh phone link', { type: 'checkbox', value: wallet?.iroh.enabled || false, help: 'Phone pairing requires both relay and discovery options below.' });
  field(form, 'relay', 'Allow public Iroh relays', { type: 'checkbox', value: wallet?.iroh.default_relays || false, help: 'Contacts the n0 relay service. Your network address may be visible to the relay and peer.' });
  field(form, 'discovery', 'Allow n0 endpoint discovery', { type: 'checkbox', value: wallet?.iroh.discovery || false });
  field(form, 'autostart', 'Start automatically with the dashboard', { type: 'checkbox', value: wallet?.autostart ?? true });
  submit(form, wallet ? 'Save settings' : 'Create wallet', async data => {
    const chain_source = data.get('source') === 'bitcoind' ? { type: 'bitcoind', host: data.get('host'), port: Number(data.get('port')), user: data.get('user'), password: data.get('password') } : { type: data.get('source'), url: data.get('url') };
    const config = { name: data.get('name'), network: wallet?.network || data.get('network'), chain_source, advertised_host: data.get('advertised_host'), tor: { enabled: tor.checked }, tor_onion_address: tor.checked ? '' : data.get('tor_onion_address'), autostart: data.has('autostart'), chicory: { enabled: data.has('provider'), offline_enabled: data.has('offline'), flat_fee_sat: Number(data.get('flat')), fee_ppm: Number(data.get('ppm')), max_client_funding_sats: Number(data.get('clientcap')), max_total_fronted_sats: Number(data.get('totalcap')) }, iroh: { enabled: data.has('iroh'), discovery: data.has('discovery'), default_relays: data.has('relay') } };
    const result = await api(wallet ? `/wallets/${wallet.id}` : '/wallets', { method: wallet ? 'PUT' : 'POST', body: config });
    dialog.close(); state.selected = result.id; state.view = 'overview'; toast(wallet ? 'Configuration saved. Start the wallet when ready.' : 'Wallet created'); await refresh();
    if (!wallet && active()?.id === result.id && state.session?.authenticated) recoveryPhrase(active());
  }); body.append(form);
}
function confirmAction(title, description, action) { const body = modal(title); body.append(el('p', '', description)); const form = el('form'); submit(form, 'Confirm', async () => { await action(); dialog.close(); toast('Operation accepted'); await refresh(); }); body.append(form); }
function receive() {
  const body = modal('Receive Bitcoin'); const form = el('form');
  const type = field(form, 'type', 'Payment network', { options: [['onchain','On-chain Bitcoin'],['lightning','Lightning invoice']] });
  const amount = field(form, 'amount', 'Amount (sats)', { type: 'number', min: 1, value: '', help: 'Required for a Lightning invoice. Leave blank for an on-chain address.' });
  field(form, 'description', 'Description', { value: 'Wallet receive' });
  submit(form, 'Create request', async data => {
    const result = type.value === 'onchain' ? await rpc('address') : await rpc('invoice', { amount_msat: numeric(data, 'amount', 1000), description: data.get('description'), expiry_secs: 3600 });
    const value = result.invoice || result.address || result.bolt11 || String(result);
    const { image } = await api(`/wallets/${state.selected}/qr`, { method: 'POST', body: { text: value } });
    const output = modal(type.value === 'onchain' ? 'Your Bitcoin address' : 'Your Lightning invoice'); const qr = el('img', 'qr'); qr.src = image; qr.alt = 'Payment request QR code'; add(output, qr, copyValue(value), el('p', '', 'Use this request only on the wallet network. Payment status appears in Activity.'));
  }); body.append(form);
}
function sent(result) {
  dialog.close();
  if (result.broadcast === 'rejected' || result.broadcast === 'unknown') toast('Broadcast outcome is ' + result.broadcast + '. Check Activity and the transaction before retrying. Transaction: ' + result.txid, true);
  else toast('Payment submitted. Follow its final status in Activity.');
  state.view = 'activity'; return refresh();
}
function send() {
  const body = modal('Send a payment'); const form = el('form');
  const kind = field(form, 'type', 'Payment network', { options: [['lightning','Lightning invoice'],['onchain','On-chain Bitcoin']] });
  field(form, 'destination', 'Invoice or Bitcoin address', { type: 'textarea', required: true });
  field(form, 'amount', 'Amount (sats)', { type: 'number', min: 1, help: 'Required for an on-chain address or an amountless invoice. For a fixed invoice, leave blank.' });
  const all = field(form, 'send_all', 'Send available on-chain balance', { type: 'checkbox', help: 'Keeps the native reserves required by active Lightning channels.' });
  all.closest('.field').hidden = true; kind.addEventListener('change', () => { all.closest('.field').hidden = kind.value !== 'onchain'; });
  const confirm = field(form, 'confirm', 'I reviewed the destination and amount', { type: 'checkbox', required: true });
  submit(form, 'Review payment', async data => {
    if (!confirm.checked) throw new Error('Confirm the destination and amount');
    const destination = data.get('destination').trim();
    if (data.get('type') === 'onchain') {
      const params = { address: destination, ...(data.has('send_all') ? { send_all: true } : { amount_sats: numeric(data, 'amount') }) };
      const estimate = await rpc('estimate_onchain', params);
      const review = modal('Confirm on-chain payment');
      add(review, detail([['Destination', destination], ['Amount', params.send_all ? 'Available balance after fees and native channel reserves' : fmt(params.amount_sats) + ' sats'], ['Estimated fee', fmt(estimate.fee_sats) + ' sats']]), el('p', '', 'The fee can change before submission. An uncertain broadcast must be checked before you retry.'));
      const finalForm = el('form'); submit(finalForm, 'Send Bitcoin', async () => sent(await rpc('send_onchain', { ...params, confirm: true }))); review.append(finalForm);
    } else await sent(await rpc('pay', { invoice: destination, ...(data.get('amount') ? { amount_msat: numeric(data, 'amount', 1000) } : {}), confirm: true }));
  }); body.append(form);
}
function connectPeer() {
  const body = modal('Connect a peer'); const form = el('form'); field(form, 'node_id', 'Node public key', { required: true }); field(form, 'address', 'Host and port', { required: true, help: 'Example: 192.168.1.30:9735' });
  submit(form, 'Connect', async data => { await rpc('connect', { node_id: data.get('node_id').trim(), address: data.get('address').trim() }); dialog.close(); await refresh(); }); body.append(form);
}
function openChannel() {
  const body = modal('Open a channel'); const form = el('form'); field(form, 'node_id', 'Node public key', { required: true }); field(form, 'address', 'Host and port', { required: true }); field(form, 'amount', 'Channel amount (sats)', { type: 'number', required: true, min: 10000 }); field(form, 'confirm', 'I approve funding this channel', { type: 'checkbox', required: true });
  submit(form, 'Fund channel', async data => { await rpc('open', { node_id: data.get('node_id').trim(), address: data.get('address').trim(), amount_sats: numeric(data, 'amount'), confirm: data.has('confirm') }); dialog.close(); toast('Channel funding requested'); await refresh(); }); body.append(form);
}
function channelForm(channel) {
  const body = modal('Manage channel'); add(body, detail([['Channel', channel.channel_id], ['Peer', channel.counterparty_node_id], ['Capacity', `${fmt(channel.value_sats)} sats`]]), el('hr', 'divider'));
  const form = el('form'); const choices = [['close','Cooperative close']]; if (available('splice_in')) choices.unshift(['splice_in','Add funds with a splice']); if (available('splice_out')) choices.unshift(['splice_out','Withdraw funds with a splice']); choices.push(['force','Force close']);
  field(form, 'operation', 'Operation', { options: choices }); field(form, 'amount', 'Splice amount (sats)', { type: 'number', min: 1, help: 'Used only for a splice.' }); field(form, 'address', 'Splice withdrawal address', { help: 'Required only when withdrawing.' });
  field(form, 'confirm', 'I approve this channel operation', { type: 'checkbox', required: true, help: 'A force close requires on-chain confirmation and can delay access to funds.' });
  submit(form, 'Submit operation', async data => {
    const operation = data.get('operation'); const common = { channel_id: channel.channel_id, counterparty_node_id: channel.counterparty_node_id, confirm: data.has('confirm') };
    await rpc(operation === 'force' ? 'close' : operation, { ...common, ...(operation === 'close' || operation === 'force' ? { force: operation === 'force' } : { amount_sats: numeric(data, 'amount'), ...(operation === 'splice_out' ? { address: data.get('address').trim() } : {}) }) });
    dialog.close(); toast('Channel operation submitted'); await refresh();
  }); body.append(form);
}

dialog.addEventListener('close', () => { if (!dialog.open) { clearSensitiveDialog(); dialog.replaceChildren(); refresh(); } });
dialog.addEventListener('cancel', () => clearSensitiveDialog());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && sensitiveCleanup) { clearSensitiveDialog(); dialog.close(); } });
window.addEventListener('pagehide', () => { if (sensitiveCleanup) { clearSensitiveDialog(); dialog.close(); } });
try { acceptSession(await api('/session')); if (state.session.authenticated) await start(); else login(); } catch (error) { login(error.message); }
setInterval(() => { if (document.visibilityState === 'visible' && !dialog.open) refresh(); }, 5000);
