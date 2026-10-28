# Qualification record

The release records below are historical evidence for their named images. The
current source removes FFOR offline receiving and its dashboard controls. Older
offline-receive results do not qualify the current source. The [current migration
and validation notes](ffor-removal.md) distinguish this local candidate from the
published 0.1.12 image.

This file distinguishes executable checks from deployment assumptions. All funded checks use disposable regtest state.

## Current local candidate after FFOR removal

Both `ldk-node-umbrel:chicory-qualified-arm64` and
`ldk-node-umbrel:chicory-qualified-amd64` passed the complete installed-Chicory
matrix through the authenticated manager and real packaged daemon. Each run
completed all nine scenarios with 107 checks and no cleanup errors.

| Architecture | Funded flow evidence | Unfunded migration | Umbrel and Iroh smoke |
| --- | --- | --- | --- |
| ARM64 | [9 scenarios, 107 checks](qualification/chicory-qualified-arm64-flows.json) | [8 checks](qualification/ffor-removal-features-arm64.json) | [14 checks](qualification/chicory-qualified-arm64-smoke.json) |
| AMD64 | [9 scenarios, 107 checks](qualification/chicory-qualified-amd64-flows.json) | [8 checks](qualification/ffor-removal-features-amd64.json) | [14 checks](qualification/chicory-qualified-amd64-smoke.json) |

The matrix covers initial phone deposits and later JIT growth; fixed and
amountless Lightning receives and an external routed payment; confirmed
splice-in and splice-out; direct funding of existing and new channels;
send-max to Bech32, Bech32m and P2WSH destinations; drain; confirmed-conflict
recovery; and recovery from a primary-held backup followed by a sweep. It checks
exact amounts, fees, pending/completed receipts, Activity uniqueness and state
after phone and primary restarts. The direct-funding receipt remains completed
after later JIT growth. The conflict case restores an unpaid request without a
phantom receive. Instant growth of confirmed channels uses an explicit trusted
peer opt-in, while deposits and direct funding retain confirmation requirements.

The migration checks upgrade fresh unfunded 0.1.12 wallets with both saved
offline-policy booleans, preserve their identities and registry bytes, and
verify removed feature bits and RPCs. They do not migrate actual FFOR custody.
The smoke checks verify Umbrel authentication, native and container restarts,
and Iroh relay/discovery bridge startup with stable identities. They do not
test a funded Iroh payment.

The [source-check record](qualification/chicory-qualified-source-checks.json)
records 292 native library, 8 daemon, 1,255 Lightning, 268 portable, 271 manager,
152 Chicory, 42 wallet-core receive and 9 matrix-runner tests. Nine Lightning
tests are ignored. Public portable types and Chicory typechecking pass; the
portable full-source typecheck retains 19 diagnostics already present in its
base. The [settings browser checks](qualification/chicory-qualified-settings-browser.json)
pass all 18 desktop/mobile checks, including trusted-splice validation and
persistence, with zero browser errors.

The flow records retain exact image identities and installed client/driver
hashes. The [native build manifest](qualification/chicory-qualified-native-inputs.json)
identifies the runtime build snapshot. [Client compatibility](client-compatibility.md)
pins the tested Chicory snapshot, portable engine and patched wallet-core
installation. Source commits made after the runs preserve that tested work;
the recorded earlier revisions and tracked-change flags remain unchanged.

These are local candidate results using disposable regtest funds and a Node
portable client over TCP. AMD64 runs under Docker CPU emulation. No image was
published or deployed, and the community store remains pinned to 0.1.12.
Physical phones, physical Umbrel hardware, mainnet payments and end-to-end
Tor/Iroh payments are not claimed. Follow the
[migration and reproduction guidance](ffor-removal.md) for the tested setup.

## Original native and dashboard qualification

- Fourteen manager tests cover authentication, CSRF and Origin checks, Host validation, fail-closed app-proxy DNS, redacted configuration, immutable wallet networks, private files, bounded wallet and RPC counts, out-of-order JSONL replies, uncertain outcomes, and process shutdown.
- The dashboard manager ran against the actual normal-feature native daemon and the explicitly authorized regtest Electrum server. It created a disposable wallet, retrieved native capabilities, balances, channels, peers, payments, events and offline status, created a receive address and unpaid invoice, and preserved the exact native identity through stop/start. No funds were sent in this check.
- Desktop and 390px mobile browser QA passed ten interaction/layout checks against the real native wallet, including pairing QR and receive-address creation, with no JavaScript errors or horizontal overflow. Screenshots were inspected.
- First-run network selection is Mainnet. Liquidity, offline settlement, and Iroh are disabled until enabled by the operator.

## Container checks

Both Linux release images built successfully with Rust 1.90 and pinned Node 24.22.1 base images. The exported architecture was checked explicitly. Intel/AMD runs use Docker Desktop CPU emulation on this ARM64 development machine; no claim of testing physical Intel or Umbrel hardware is made.

Both original 0.1.0 images passed all ten checks: architecture, authentication, Mainnet first-run default, native regtest sync, receive address and unpaid invoice creation, pairing QR generation, Iroh addon loading, native process restart, whole-container restart retaining the same native identity, and graceful manager shutdown after Docker termination. `dist/qualification-amd64.json` and `dist/qualification-arm64.json` record the exact results and image IDs.

Both architectures also passed an extended twelve-check run that starts the real Iroh relay and discovery bridge through the dashboard and preserves its endpoint identity through supervised native restart. Those records are `dist/qualification-iroh-amd64.json` and `dist/qualification-iroh-arm64.json`. They exercise bridge lifecycle, not a separate funded relay payment.

The original 0.1.0 AMD64 image passed the six-check funded installed-Chicory baseline through the authenticated manager adapter. The original 0.1.0 ARM64 image passed the eleven-check paid concurrent offline flow, including the same baseline. Both use the corrected local client bundle. The wallet received 20,000 sats with 19,880 net after the negotiated fee, restored the payment and channel on phone restart, and paid a native primary invoice.

The ARM64 flow also reserved a real 5,000-sat concurrent-v2 voucher, preserved it during ordinary payments in both directions, restarted the container while the phone was stopped, completed the external offline payment, restarted the primary again, and recovered exactly one credit after two phone launches. All final containers exited cleanly. Disposable containers and volumes were removed after qualification.

The adapter only translates administration calls into authenticated dashboard requests. It does not emulate a node or alter Lightning messages. [AMD64 funded evidence](qualification/funded-amd64.json), [ARM64 funded/offline evidence](qualification/funded-arm64.json), and [image provenance](qualification/images.json) record the exact native binary, client bundle, image and archive hashes. The raw fixture hashes the adapter path, so these saved records identify that hash separately from the native daemon hash.

`dist/native-source.sha256` records all 977 source files in the image build context. That snapshot included the then-uncommitted daemon; its native runtime source matches the subsequently saved LDK commit `35b49a99bdff7edbe3c97dd5a605edf6e878ead4`. The original 0.1.0 archives remain local and are excluded from Git. The public 0.1.1 release adds the current dashboard login, metadata and third-party notices while retaining the same native daemon and Iroh bytes. The architecture-detecting loader verified both archive checksums and loaded the matching ARM64 image. Local Compose validated directly; the Umbrel manifest validated with a schema-only placeholder for the proxy that Umbrel injects, without starting that integration.

## Public release 0.1.1

The public release retains the exact original native daemon, Iroh bridge and Iroh native addon bytes on each architecture. [Release provenance](qualification/release-0.1.1.json) records the original and updated image IDs, native file hashes, exported archive hashes and notice bundle checksum. Its changes are dashboard authentication, public-store packaging and third-party notices.

Nineteen manager tests pass. Nine independent Chrome checks pass, including real capture of the shared-host cookie by a second HTTP app, rejected cookie replay, same-tab reload, fresh-tab sign-in, logout, expired-session cleanup and zero JavaScript errors. The dashboard requires both its HttpOnly cookie and an origin-scoped browser proof; mutations also require CSRF and matching Origin.

Both updated release images pass fourteen container checks using Umbrel's per-install password model and a custom hostname: native regtest sync, empty balance, receive address, unpaid invoice, pairing QR, Iroh loading and real relay/discovery startup, native and container restart, stable node and transport identities, graceful shutdown, and rejection of unauthenticated or cookie-only access. [AMD64 results](qualification/release-0.1.1-amd64.json) and [ARM64 results](qualification/release-0.1.1-arm64.json) record those runs. No funds were sent in these release packaging checks; the funded native results above refer to the unchanged native binaries in their original images.

The [official Umbrel validator](qualification/umbrel-store-lint.json), including public image checks, passes with zero errors. Its two warnings concern the retained no-new-privileges option and the local icon used by this community store. Both registry architectures were pulled with an empty Docker credential configuration, and their native daemon, Iroh files and notice bundle hashes match the qualified release archives. The Compose manifest pins the verified combined index digest. Docker and gateway-request simulation do not constitute a physical Umbrel installation test.

## Public release 0.1.2

This release aligns Electrum setup with Beignet Umbrel: explicit Electrs, plaintext Fulcrum and rbitcoin presets, optional backend environment defaults, and an authenticated connection check that verifies the genesis header before native startup. Saved custom endpoints remain selected. A saved trailing slash is normalized before native launch, preserving wallet identity and node storage without requiring a settings save.

All 32 manager tests pass. Thirteen independent [browser checks](qualification/release-0.1.2-browser.json) cover actual HTTP and Electrum protocol checks, all presets, custom URL preservation, explicit legacy-default repair, same-wallet saving, wrong-network feedback and stale-result suppression. The browser fixture uses disposable protocol servers and no native process.

Both architectures pass fourteen container checks with real native regtest sync and Iroh lifecycle checks: [AMD64](qualification/release-0.1.2-amd64.json) and [ARM64](qualification/release-0.1.2-arm64.json). Each also passes twelve upgrade and preset checks: [AMD64](qualification/release-0.1.2-electrum-upgrade-amd64.json) and [ARM64](qualification/release-0.1.2-electrum-upgrade-arm64.json). Those checks reproduce the old DNS default and trailing-slash startup failures, recover the existing wallet after upgrade, verify DNS, TLS and network diagnostics, and retain native identity through explicit server changes. Their isolated Umbrel preset listeners forward a real regtest Electrs server; they do not claim that fixture is Fulcrum.

Separate checks use an actual plaintext Mainnet Fulcrum server. Both [AMD64](qualification/release-0.1.2-fulcrum-amd64.json) and [ARM64](qualification/release-0.1.2-fulcrum-arm64.json) pass six checks covering the exact optional-backend Compose environment, authenticated network verification, canonical URL persistence, native startup, zero balances, peers and channels, and clean stop. All test wallets are disposable. No user wallet was accessed or funds sent, and test containers, volumes and networks were removed.

[Release provenance](qualification/release-0.1.2.json) records image and archive hashes. The native daemon, Iroh bridge, native addon and notice bundle exactly match 0.1.1 on each architecture. The release changes the dashboard and its configuration, with the original funded interoperability evidence still tied to those unchanged native binaries.

The [official Umbrel validator](qualification/release-0.1.2-umbrel-store-lint.json), including public image checks, reports zero errors and the same two packaging warnings as 0.1.1. Both architectures were pulled anonymously and retain the verified native and notice hashes. The community app pins the combined 0.1.2 image index.

## Public release 0.1.3

The Pair Chicory page previously replaced its entire layout every five seconds and then loaded its pairing details and QR asynchronously. This temporarily collapsed the page. A real Chrome baseline reproduced desktop scrolling from 534 pixels to zero and mobile scrolling from 620 pixels to zero, while also losing Copy button focus and selected URI text.

The fix keeps unchanged pairing content mounted while continuing live checks, prepares changed content before replacing it, and only regenerates the QR when its URI changes. Session, wallet and view checks reject delayed responses after navigation or configuration changes. A prior wallet's RPC responses cannot populate a newly selected wallet, and an old unauthorized response cannot clear a newer login.

Nine independent [async and DOM regression checks](qualification/release-0.1.3-async-review.json) pass against the exact released frontend source. These checks use deferred mocked responses and distinguish DOM identity from real browser layout verification.

Fourteen independent [Chrome checks](qualification/release-0.1.3-browser.json) pass with zero JavaScript errors. Across natural five-second polling, desktop scroll stays at 534 pixels and mobile scroll stays at 620 pixels, with the same Copy focus and selected URI text. Changed Iroh/TCP details, QR updates, stop/start, normal chain-height polling, open forms, navigation, logout and a new login after an old unauthorized response also pass. Browser tests use disposable mocked wallet responses without accessing a user wallet.

Both [AMD64](qualification/release-0.1.3-amd64.json) and [ARM64](qualification/release-0.1.3-arm64.json) images pass six packaging checks: architecture and version, actual manager startup with disposable storage, exact served frontend hash, denial of unauthenticated access, authenticated Fulcrum configuration and an empty wallet registry. [Release provenance](qualification/release-0.1.3.json) records source, image and archive hashes. Native daemon, Iroh and notice hashes remain identical to 0.1.2. The backend and native interoperability results above remain applicable to those unchanged files; no funded or native protocol tests were repeated for this frontend change.

The [official Umbrel validator](qualification/release-0.1.3-umbrel-store-lint.json) passes with public image checks and zero errors, retaining only the two previously documented packaging warnings. Anonymous pulls of both architectures match the exact browser-qualified frontend and original native and notice hashes. The community store pins the verified combined 0.1.3 image index.

## Historical release scope and limits

This section describes the preceding historical release qualification. The
current local candidate's scope is recorded above.

This dashboard exposes the local native implementation. Mainnet is selectable, but all funding and interoperability qualification uses disposable regtest funds. A real Umbrel installation and a real ARM64 Umbrel device have not been modified or qualified.

Extended native and iOS protocol qualification is recorded in the separate local LDK fork. This public repository includes the packaged image qualification records. Recovery, offline concurrent voucher retirement, chain fee policy, and deep-reorganization behavior retain the limitations documented there. The matching local client bundle fixes the original phone's initial commitment-fee selection, shared-input fee audit, and reconnect watchdog. Use the [qualified local client](client-compatibility.md) before testing the measured flows. Native fee admission remains unchanged.

A draining concurrent offline voucher book can retain funds until cooperative settlement or an on-chain timeout. A six-confirmation splice-conflict proof assumes that confirmation history remains authoritative; archival monitor custody does not promise full-balance recovery under arbitrary deeper reorganizations. Back up complete stopped wallet state.

## Public release 0.1.4

The dashboard adds verified 24-word BIP39 recovery phrases for new wallets, private reveal and HTTP-compatible copying, and encrypted full stopped-data backups for both new and legacy wallets. Legacy random binary seeds are never converted or replaced. Full backups include channel databases and journals, and the offline restore tool authenticates the entire archive before writing a new private destination. Starting the restored manager can honor saved autostart settings, so the original must remain retired.

The threat model covers unauthenticated callers, shared-host cookie replay by another Umbrel app, cross-origin requests, malformed recovery files and archives, filesystem links, bounded resource exhaustion, and concurrent wallet startup or shutdown during snapshots. The manager and host owner remain trusted. No new native Rust or cryptographic primitive is implemented. BIP39 uses pinned `@scure/bip39` 2.2.0 and the native daemon's existing 64-byte seed interface. Backup encryption uses Node's AES-256-GCM and asynchronous scrypt with fixed parameters. Mutable secret buffers are cleared, but JavaScript strings cannot guarantee immediate memory erasure. TLS remains a deployment concern on local HTTP installations.

All 57 backend tests pass, including 24 randomized phrase/seed derivation cases checked independently against PBKDF2, malformed and mismatched recovery material, legacy preservation, lifecycle cancellation, API authorization, archive tampering, wrong passphrases, malicious paths, size bounds, restore rollback and randomized binary round trips. Run `npm ci --ignore-scripts && npm test` in `manager/`.

Ten [desktop and mobile browser checks](qualification/release-0.1.4-browser.json) pass with zero JavaScript errors. They verify numbered words, clipboard fallback inside the modal, secret cleanup on close and page exit, automatic expiry, password confirmation, encrypted download with restored channel bytes, and clear legacy-wallet behavior. Reproduce with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core CHROME_PATH=/absolute/path/to/chrome node scripts/recovery-browser-test.cjs`. The recorded run uses Playwright Core 1.48.2 and local Chrome. The expiry scenario accelerates only the 60-second timer.

Both [AMD64](qualification/release-0.1.4-amd64.json) and [ARM64](qualification/release-0.1.4-arm64.json) native regressions pass using isolated disposable Bitcoin Core regtest containers. Each starts a new phrase-backed wallet and a synthetic legacy wallet, verifies native seed consistency, refuses an online backup, exports stopped full state, removes the original manager, restores into a new volume, and checks both native node identities after restart. Reproduce with `node scripts/recovery-container-test.mjs amd64` or `arm64` after loading the matching image. No real wallet data or funds are used.

[Release provenance](qualification/release-0.1.4.json) records the image and archive hashes, every packaged manager source hash, the added MIT dependency notices, and unchanged native daemon and Iroh hashes from 0.1.3. Physical Umbrel hardware testing and live channel migration are not claimed. The existing native protocol qualification applies to the unchanged binaries; this release adds container-level recovery qualification.

The [official Umbrel validator](qualification/release-0.1.4-umbrel-store-lint.json) passes with public image checks and zero errors. The two existing warnings cover the deliberate `no-new-privileges` restriction and community-store icon assets. Anonymous pulls of both architectures match the verified native, frontend and notice hashes. The community store pins the verified 0.1.4 combined image digest.

## 0.1.5 qualification (unpublished draft)

The Umbrel package maps only its own deployment-provided `DEVICE_DOMAIN_NAME` to Docker's host gateway. This lets both the Node connection check and native Rust Electrum client connect through a custom device hostname such as `mint.local`, including after container recreation. No LAN IP is saved and no application DNS proxy or extra network privilege is introduced. Other machines' `.local` names continue to depend on container DNS. [Compose verification](qualification/release-0.1.5-compose.json) checks the shipping manifest with both a custom domain and Umbrel's default name.

Electrum inputs accept `host:port:t` and `host:port:s`, normalized through the existing strict authority validator to `tcp://` and `ssl://` URLs. Bracketed IPv6 remains supported. The host owner and deployment environment remain trusted; server responses remain untrusted and undergo the existing network and protocol checks. TLS retains the original hostname and certificate verification. Malformed suffixes cannot silently change the selected transport. No dependencies, Rust code, keys or cryptographic operations changed.

All 61 manager tests pass, including canonical round trips, malformed shorthand rejection before connecting, TLS verification settings, persisted hostname configuration and native handoff. Both [ARM64](qualification/release-0.1.5-electrum-arm64.json) and [AMD64](qualification/release-0.1.5-electrum-amd64.json) pass nine container checks. Real native wallets sync over `tcp://mint.local:60001` to the existing local Docker regtest server through the host gateway, retain the hostname in saved and native settings, and preserve both identities through stop/start and container recreation. These disposable wallets remain unfunded; no blocks are mined. Reproduce with `node scripts/electrum-container-test.mjs arm64` or `amd64`; `REGTEST_PORT` can select another host-published regtest port. AMD64 runs use local CPU emulation, and these checks do not claim access to the user's physical Umbrel installation.

[Release provenance](qualification/release-0.1.5.json) records archive checksums and verifies every packaged manager file against the tested source. Native daemon and Iroh hashes exactly match 0.1.4. Existing native interoperability evidence remains attached to those unchanged binaries.

## Public release 0.1.6

Pair Chicory now offers each available Iroh, Local network (TCP), and Tor address through a connection selector. The QR, URI, Copy action, transport label, and guidance follow the selection. Selecting Tor leaves Iroh enabled. Choices persist per wallet across polling and navigation within the signed-in session. A removed transport falls back with an explicit notice. Tor still requires an existing v3 onion service mapped to that wallet's native Lightning listener.

The threat model covers stale or reordered pairing and QR responses, selection changes during requests, wallet switches, navigation, logout, and unavailable transports. The authenticated manager remains trusted to supply the node identity and addresses. Selection only changes the display, and QR generation uses the existing protected endpoint. No wallet settings, private keys, cryptography, native code, dependencies, or transport enablement change. QR request revisions and existing session/wallet guards reject outdated results. A failed QR keeps the URI copyable; a failed pairing refresh retains its stale-data warning until a later successful refresh.

All 72 manager tests pass. The 11 new helper tests exhaust all eight transport-availability combinations, preserve exact IPv6, onion, and Iroh addresses, check fallback selection and invalid fields, and verify input immutability. `node --experimental-test-coverage --test server/pairing.test.mjs` in `manager/` reports 100% line, branch, and function coverage for `public/pairing.js`; this does not claim whole-dashboard coverage.

Eighteen [desktop and mobile browser checks](qualification/release-0.1.6-browser.json) pass with zero JavaScript errors. They verify matching QR images and copied URIs, unchanged natural polling, focus and scroll preservation, independent wallet selections, removed and returning options, stale refresh warnings, delayed QR responses, failed QR retries, navigation, and logout. The fixture uses the actual authentication and QR endpoints with synthetic public wallet data. Desktop and 390px mobile screenshots were inspected without overflow. Reproduce with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core CHROME_PATH=/absolute/path/to/chrome node scripts/pairing-browser-test.cjs`; optional `PAIRING_EVIDENCE` and `PAIRING_SCREENSHOTS` paths save results and previews.

Both architectures pass 12 [packaging and container checks](qualification/release-0.1.6.json), including isolated manager startup, authentication and browser-proof enforcement, exact served module hashes and MIME types, QR generation for all transports, Iroh addon loading, and graceful shutdown. All 25 packaged manager files match the tested source. Native daemon, Iroh bridge/addon, and all 1,060 license files match the qualified 0.1.4 image. These checks create no native wallet and send no funds. Existing native interoperability evidence applies to the unchanged binaries; no live Tor connection or physical Umbrel installation is claimed. This release also includes the Electrum changes qualified for the unpublished 0.1.5 draft above.

[Anonymous pulls](qualification/release-0.1.6-public-images.json) of both public architectures match the qualified configuration digests, uncompressed layers, manager source, native binaries, and license bytes. The [official Umbrel validator](qualification/release-0.1.6-umbrel-store-lint.json) passes with zero errors and the same two existing warnings for `no-new-privileges` and community-store icon assets. [Compose validation](qualification/release-0.1.6-compose.json) confirms custom and default device hostnames and all eight Lightning port mappings. The community store pins the verified combined 0.1.6 image digest. The release tag identifies the tested application source; the subsequent store-pin commit records the published digest and deployment verification without changing those application bytes.


## Public release 0.1.7

Settings now includes **Enable Tor connections**. After opt-in, the bundled Tor process creates a persistent v3 onion service for that wallet's native Lightning listener. Pair Chicory shows its Tor URI and QR alongside local TCP and Iroh, with bootstrap progress and actionable failure messages. The previous release only displayed a manually configured onion address. The new behavior follows Beignet's automatic onion provisioning and connection selection while keeping the native daemon's existing outbound routing: this feature provides incoming Tor connections, not outbound SOCKS routing.

The threat model covers malformed or replaced local identity files, incomplete first-start writes, untrusted Tor log text, child-process failures, native restarts during Tor startup, concurrent shutdown and backup, and stale browser requests. The host owner, private wallet parent and bundled Tor executable remain trusted. Tor generates and loads its own Ed25519 keys; the manager reads only file envelopes and public addresses. Existing authentication protects configuration and pairing. No SOCKS or control listener is exposed. Per-wallet keys and guard state remain in the private persistent data directory, while caches are temporary. A recorded onion identity prevents silent replacement, and backup admission waits for preparation and actual process exit. No Rust source or cryptographic primitive changes.

All 123 [manager tests](qualification/release-0.1.7-tests.json) pass. They cover independent opt-in, missing executables, external onion compatibility, delayed and partial identity creation, atomic file replacement during creation, file permissions and links, bounded diagnostics, cancellation, child failures, restart guards, and encrypted backup preservation. Run `npm test` in `manager/`. The focused coverage run reports 100% line and function coverage and 89.94% branch coverage for `server/tor.mjs`; `public/pairing.js` has 100% line, branch and function coverage. This is measured module coverage, not whole-application coverage.

Sixteen [Tor browser checks](qualification/release-0.1.7-tor-browser.json) and eighteen [connection selector checks](qualification/release-0.1.7-browser.json) pass with zero JavaScript errors. They cover desktop and 390px mobile layouts, enabling Tor with Iroh, manual-address compatibility, unavailable binaries, progress and failure notices, matching QR and copied URI, and unchanged scroll, focus and selected text during bootstrap updates. Reproduce with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core CHROME_PATH=/absolute/path/to/chrome node scripts/tor-browser-test.cjs` and `node scripts/pairing-browser-test.cjs` using the same environment.

Both [AMD64](qualification/release-0.1.7-tor-amd64.json) and [ARM64](qualification/release-0.1.7-tor-arm64.json) pass fifteen native/Tor lifecycle checks against disposable, isolated Bitcoin Core at regtest genesis. Real Tor runs with networking disabled for deterministic identity, lifecycle and backup/restore checks; an Iroh subprocess fixture verifies independent lifecycle handling. Both architectures also pass thirteen [packaging checks](qualification/release-0.1.7.json), including exact source hashes, bundled Tor and license notices, authentication and manager shutdown. Native daemon and Iroh binary hashes remain unchanged from 0.1.6. Reproduce with `node scripts/tor-container-test.mjs amd64` or `arm64` after loading the matching archive.

A separate [live ARM64 onion check](qualification/release-0.1.7-tor-live-arm64.json) uses the real managed service and a separate Tor client. Both bootstrap to 100%, and an exact random 32-byte nonce completes a round trip through the onion service. The evidence records the tested image and helper hash. Reproduce with `node scripts/tor-live-smoke.mjs ldk-node-umbrel:0.1.7-arm64 arm64 /absolute/path/result.json`; this optional check requires public Tor connectivity. The fixture creates no wallet, publishes no host ports and cleans up both Tor processes and its container. This verifies onion forwarding, not a funded Lightning payment. AMD64 uses Docker CPU emulation, and no physical Umbrel installation or user wallet was accessed.

[Anonymous pulls](qualification/release-0.1.7-public-images.json) of both public architectures match the qualified runtime configuration, uncompressed layers, manager source, native daemon, Iroh, Tor and notice bytes. The [official Umbrel validator](qualification/release-0.1.7-umbrel-store-lint.json) reports zero errors and the two existing warnings for `no-new-privileges` and community-store icon assets. [Compose validation](qualification/release-0.1.7-compose.json) confirms both custom and default device hostnames and all eight Lightning port mappings. The community store pins the verified 0.1.7 combined image digest. The release tag identifies the tested application source; the following store-pin commit records the published digest and deployment checks without changing application bytes.


## Public release 0.1.8

Settings adds permanent deletion for a stopped wallet. The dialog identifies the selected wallet and network, explains the loss of local wallet and channel state, offers the existing full-backup flow, and requires the exact wallet name plus explicit acknowledgement. Deletion does not send funds or close channels. Dashboard authentication and every other wallet remain in place.

The threat model covers unauthorized or cross-origin DELETE requests, stale confirmation names, concurrent start/update/backup operations, still-exiting native and transport processes, path substitution, interrupted filesystem cleanup, and ambiguous registry persistence failures. The host owner and private data parent remain trusted. A synchronous per-wallet guard and serialized registry mutation prevent lifecycle races. The manager first persists a pending-deletion record that reserves the wallet slot, then removes the selected private directory, then removes the registry entry. A failure keeps the wallet pending and unable to autostart. An explicit confirmed retry completes cleanup; the manager does not silently roll back or start partially deleted data.

No native daemon, Iroh, Tor, dependency, cryptographic primitive or backup format changes are required. Existing backups are independent snapshots and are not deleted by this operation. A recovery phrase alone does not restore current Lightning channel state. Secure erasure from storage media is not claimed.

All 149 [manager tests](qualification/release-0.1.8-tests.json) pass, including 26 deletion tests. They verify authentication, browser proof, Origin, CSRF, JSON and exact-name confirmation; active and detached process guards; concurrent backup and shutdown admission; file/link boundaries; sibling preservation and slot reuse; partial deletion across restart; and failures before and after registry rename/fsync. The atomic JSON writer removes only its own temporary file after failure. Run `npm test` in `manager/`.

Twenty-four [deletion browser checks](qualification/release-0.1.8-delete-browser.json) pass on desktop and 390px mobile layouts with zero JavaScript errors. They cover named confirmation, cancel, backup entry, active-wallet refusal, pending cleanup, last-wallet removal, duplicate submissions, lost responses, rename races, stale polling, navigation and newer-login isolation. The backup preflight rejects pending deletions before stopping any sibling. Desktop and mobile confirmation screenshots were inspected. Reproduce with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core CHROME_PATH=/absolute/path/to/chrome node scripts/delete-browser-test.cjs`.

Both [AMD64](qualification/release-0.1.8-deletion-amd64.json) and [ARM64](qualification/release-0.1.8-deletion-arm64.json) pass ten container scenarios through the shipping authenticated HTTP API and real native wallets against isolated Bitcoin Core at regtest genesis. They verify refusal while running, targeted removal, surviving wallet identity and byte preservation, restart without resurrection, fresh identity on slot reuse, a real permission-denied cleanup failure, persisted pending state without autostart, explicit retry, and encrypted backup restoration containing only the surviving wallet. No blocks are mined or funds sent. Reproduce with `node scripts/deletion-container-test.mjs amd64` or `arm64` after loading the release archive.

Both architectures also pass thirteen [packaging checks](qualification/release-0.1.8.json). Every packaged manager file matches the tested source; native daemon, Iroh, Tor, package versions and notices match qualified 0.1.7. These tests use disposable storage and containers. AMD64 runs under local Docker CPU emulation. Physical Umbrel installation and funded wallet deletion are not claimed.

The existing eighteen [connection selector checks](qualification/release-0.1.8-browser.json) and sixteen [Tor UI checks](qualification/release-0.1.8-tor-browser.json) also pass against the same final frontend hash, with zero browser errors. In total, 58 browser checks pass.

[Anonymous pulls](qualification/release-0.1.8-public-images.json) of both public architectures match the qualified runtime configuration, uncompressed layers, manager source, native daemon, Iroh, Tor and notices. The [official Umbrel validator](qualification/release-0.1.8-umbrel-store-lint.json) reports zero errors and the two existing warnings for the retained `no-new-privileges` restriction and community-store icon assets. [Compose validation](qualification/release-0.1.8-compose.json) confirms the verified image pin, both device hostname cases and all eight Lightning port mappings. The community store pins the verified 0.1.8 combined index. As in 0.1.7, the release tag identifies tested application source, and the following store-pin commit records publication and deployment verification without changing application bytes.

## Public release 0.1.10

This release rebuilds the native daemon from the local `feat/lfbw-wallet-client` source snapshot to permit compatible private client channels to grow beyond their opening capacity. It also exposes bounded native wallet logs and process diagnostics through authenticated copy and download controls. The 0.1.9 automatic balance updates remain included. Existing channels retain their saved limit and require a controlled normal close and reopen with compatible client and provider versions; wallet storage must be preserved.

All 266 manager tests and 24 Linux log tests pass. Desktop and mobile verification passes 10 log checks and 39 automatic-balance checks with zero browser errors. [Log and browser evidence](qualification/native-wallet-logs.json) records the exact frontend hash. Both final release images pass 12 Umbrel-mode startup, authentication, synchronization and persistence checks each: [AMD64](qualification/release-0.1.10-amd64.json) and [ARM64](qualification/release-0.1.10-arm64.json). Both pass eight automatic receive checks across three deposit rounds, receiving 150,000 disposable regtest sats each without explicit sync requests: [AMD64](qualification/release-0.1.10-receive-amd64.json) and [ARM64](qualification/release-0.1.10-receive-arm64.json).

The [funded primary-growth test](qualification/release-0.1.10-primary-growth.json) uses the final ARM64 image, a Beignet sender, and Bitkit's native client engine. A 50,000 sat receive grows the same channel from 40,000 to 110,000 sats and credits 49,850 sats after the 150 sat receive fee. A subsequent 1,000 sat outgoing payment succeeds. Authenticated native logs contain the real splice and settlement records while unauthenticated access returns 401. This test does not exercise Android UI, mainnet funds or physical Umbrel hardware. All temporary test resources were removed.

[Release provenance](qualification/release-0.1.10.json) records both exact images, archive hashes, native binary hashes and packaged source hashes. All 296 files in the [native source manifest](../licenses/native-source-0.1.10.json) match the tested local working tree and build snapshot. The source includes local changes after base commit `b63959d535fd66995b3c89213e102aa4f6d5f327`; the base commit alone does not reproduce the fixed daemon. The native branch remains unpublished. Cargo manifests and lockfiles match the previous native release, with no new third-party dependency notices required. The pinned 0.1.9 base supplies unchanged Iroh, Tor and system libraries. A build-time comparison prevents silently reusing JavaScript dependencies after their metadata changes.

The publication workflow verified the release archive checksums before publishing both architectures. [Anonymous pull verification](qualification/release-0.1.10-public-images.json) confirms that 65 packaged files per architecture match the qualified local archives. The community Compose manifest pins the combined index digest. The [official Umbrel validator](qualification/release-0.1.10-umbrel-store-lint.json) passes with zero errors and the two existing warnings for the retained security option and community icon assets.

## Public release 0.1.11

The native FFOR capability pairs move to 440/441 and 442/443, matching Beignet's feature-bit migration and avoiding Eclair's on-the-fly funding assignments. Both endpoints need the new assignments for offline receive. Former 560-563 advertisements are no longer treated as FFOR. Native wallet custody formats, protocol message encodings and ordinary channels do not change. The native implementation does not implement or advertise async receive service bits 444/445.

The build starts with all 296 files of the exact published 0.1.10 source snapshot, verified against its manifest before applying the feature-bit patch. Only three production files and two regression-test files change. The new source manifest distinguishes this snapshot from the base Git revision. Qualified 0.1.10 Iroh, Tor, system libraries and locked JavaScript dependencies are retained.

All 266 dashboard tests and 14 native FFOR regression tests pass. The new container test performs real encrypted BOLT 8 handshakes using the updated Beignet peer implementation. On each architecture it creates an isolated, unfunded 0.1.10 wallet, observes optional bits 561/563, upgrades the same persisted wallet to 0.1.11, verifies its original identity and new bits 441/443, checks that the legacy and unimplemented async-service bits are absent, creates a regtest address and unpaid invoice, loads the Iroh addon, and disables offline settlement to verify advertisement removal after restart. Reproduce with `BEIGNET_ROOT=/absolute/path/to/beignet node scripts/feature-bits-container-test.mjs amd64` or `arm64`. No existing backend, public peer, user wallet or funds are used. AMD64 runs under local Docker CPU emulation. Physical Umbrel installation and funded offline-payment qualification are not claimed.

[Release provenance](qualification/release-0.1.11.json), [ARM64 wire observations](qualification/release-0.1.11-features-arm64.json), and [AMD64 wire observations](qualification/release-0.1.11-features-amd64.json) identify the exact tested source and images.

[Anonymous pulls](qualification/release-0.1.11-public-images.json) of both published architectures match all 65 checked runtime files from the qualified archives. The [official Umbrel validator](qualification/release-0.1.11-umbrel-store-lint.json) reports zero errors and the same two existing warnings for the retained security restriction and community-store icon asset. [Compose validation](qualification/release-0.1.11-compose.json) confirms custom and default device hostnames and all eight Lightning port mappings. The community app pins the verified 0.1.11 combined index. The release tag identifies tested application source; the subsequent store-pin commit records publication verification without changing runtime bytes.

## Public release 0.1.12

This release rebuilds the primary from the local LDK source with Beignet v3 direct funding (`bgnq`). A compatible payer contributes one confirmed onchain coin directly to a receiving phone's new channel or existing-channel splice. The receiver verifies coin ownership and chain evidence; the payer verifies the exact amount, funding and change outputs, attestations and fee ceiling. Signed obligations and coin reservations survive restart and do not authorize a fallback payment after an uncertain result. Upgrade Bitkit's native client and Android UI together with the primary.

All 288 native library tests, 13 documentation tests and 266 dashboard tests pass. Every native target compiles with the Chicory and UniFFI features. Native sender tests cover shared-input witnesses supplied by Beignet, lower retry fee ceilings, persistence failure, lost receipts and witness replay. Receiver tests cover revocation, old-primary continuation, expired requests, and 130 completed receives with durable secret-free history. The codec also passed 20,000 coverage-instrumented libFuzzer executions and signed-envelope property tests; no complete coverage or exhaustive fault-injection claim is made.

Real Beignet/native interoperability passes in both payment directions for a new 100,000-sat channel and a 40,000-sat splice of the same channel. Beignet's P2WPKH and Taproot ownership proofs are exercised. The final image then serves as the actual primary in both [ARM64 funded checks](qualification/release-0.1.12-direct-funding-arm64.json) and [AMD64 funded checks](qualification/release-0.1.12-direct-funding-amd64.json). Each verifies exact 140,000-sat channel value, no onchain fallback credit, a primary-container restart retaining its identity and channel, sender and receiver restarts, and idempotent retries preserving exactly two payments. The native client driver is the same engine bound into Bitkit; these image tests do not exercise Android UI. Only disposable regtest funds are used, and exact temporary containers and volumes are removed.

Both final images also pass 12 Umbrel-mode startup, authentication, synchronization and persistence checks: [AMD64](qualification/release-0.1.12-amd64.json) and [ARM64](qualification/release-0.1.12-arm64.json). [Release provenance](qualification/release-0.1.12.json) records both image and archive hashes, 68 runtime files per architecture, all 1,065 notice checksums and all 307 native build inputs. The named source snapshot includes local changes beyond Git revision `756b74b3487a032426a7c37e760c1bb6db305344`; the packaged notices retain an earlier ancestor as their base, with the exact source manifest identifying the build. The native branch remains local. The new RustCrypto dependencies have verified pinned source checksums and bundled notices. Iroh, Tor, system libraries and locked JavaScript dependencies remain those of the qualified base.

Reproduce the funded image checks with `python3 scripts/direct-funding-container-test.py arm64 --rpc-url rpc://user:password@127.0.0.1:18443` (or `amd64`), using a disposable regtest chain and the matching local native checkout. AMD64 runs under local CPU emulation. Physical Umbrel hardware and mainnet payments are not claimed.

The [publication workflow](https://github.com/coreyphillips/ldk-node-umbrel/actions/runs/40442931798) verified archive checksums before publishing both platforms. [Anonymous pulls](qualification/release-0.1.12-public-images.json) match the qualified image configurations and all 68 checked runtime files per architecture. Registry serialization changes platform manifest digests without changing those configurations or contents. The store pins combined index `sha256:5e90abb59309d74841c98d7f137f3f3c68dce3d41d614088f8f5acc25216d6bd`. The [official Umbrel validator](qualification/release-0.1.12-umbrel-store-lint.json) reports zero errors and the two existing packaging warnings. [Compose validation](qualification/release-0.1.12-compose.json) checks default/custom hostnames and all eight Lightning ports without starting services. The release tag identifies the tested source; the following store-pin commit records publication verification.
