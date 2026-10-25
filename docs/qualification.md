# Qualification record

This file distinguishes executable checks from deployment assumptions. All funded checks use disposable regtest state.

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

## Scope and limits

This dashboard exposes the local native implementation. Mainnet is selectable, but all funding and interoperability qualification uses disposable regtest funds. A real Umbrel installation and a real ARM64 Umbrel device have not been modified or qualified.

Extended native and iOS protocol qualification is recorded in the separate local LDK fork. This public repository includes the packaged image qualification records. Recovery, offline concurrent voucher retirement, chain fee policy, and deep-reorganization behavior retain the limitations documented there. The matching local client bundle fixes the original phone's initial commitment-fee selection, shared-input fee audit, and reconnect watchdog. Use the [qualified local client](client-compatibility.md) before testing the measured flows. Native fee admission remains unchanged.

A draining concurrent offline voucher book can retain funds until cooperative settlement or an on-chain timeout. A six-confirmation splice-conflict proof assumes that confirmation history remains authoritative; archival monitor custody does not promise full-balance recovery under arbitrary deeper reorganizations. Back up complete stopped wallet state.
