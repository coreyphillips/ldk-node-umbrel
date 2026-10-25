# Qualification record

This file distinguishes executable checks from deployment assumptions. All funded checks use disposable regtest state.

## Completed

- Fourteen manager tests cover authentication, CSRF and Origin checks, Host validation, fail-closed app-proxy DNS, redacted configuration, immutable wallet networks, private files, bounded wallet and RPC counts, out-of-order JSONL replies, uncertain outcomes, and process shutdown.
- The dashboard manager ran against the actual normal-feature native daemon and the explicitly authorized regtest Electrum server. It created a disposable wallet, retrieved native capabilities, balances, channels, peers, payments, events and offline status, created a receive address and unpaid invoice, and preserved the exact native identity through stop/start. No funds were sent in this check.
- Desktop and 390px mobile browser QA passed ten interaction/layout checks against the real native wallet, including pairing QR and receive-address creation, with no JavaScript errors or horizontal overflow. Screenshots were inspected.
- First-run network selection is Mainnet. Liquidity, offline settlement, and Iroh are disabled until enabled by the operator.

## Container checks

Both Linux release images built successfully with Rust 1.90 and pinned Node 24.22.1 base images. The exported architecture was checked explicitly. Intel/AMD runs use Docker Desktop CPU emulation on this ARM64 development machine; no claim of testing physical Intel or Umbrel hardware is made.

Both final images passed all ten checks: architecture, authentication, Mainnet first-run default, native regtest sync, receive address and unpaid invoice creation, pairing QR generation, Iroh addon loading, native process restart, whole-container restart retaining the same native identity, and graceful manager shutdown after Docker termination. `dist/qualification-amd64.json` and `dist/qualification-arm64.json` record the exact results and image IDs.

Both architectures also passed an extended twelve-check run that starts the real Iroh relay and discovery bridge through the dashboard and preserves its endpoint identity through supervised native restart. Those records are `dist/qualification-iroh-amd64.json` and `dist/qualification-iroh-arm64.json`. They exercise bridge lifecycle, not a separate funded relay payment.

The final AMD64 image passed the six-check funded installed-Chicory baseline through the authenticated manager adapter. The final ARM64 image passed the eleven-check paid concurrent offline flow, including the same baseline. Both use the corrected local client bundle. The wallet received 20,000 sats with 19,880 net after the negotiated fee, restored the payment and channel on phone restart, and paid a native primary invoice.

The ARM64 flow also reserved a real 5,000-sat concurrent-v2 voucher, preserved it during ordinary payments in both directions, restarted the container while the phone was stopped, completed the external offline payment, restarted the primary again, and recovered exactly one credit after two phone launches. All final containers exited cleanly. Disposable containers and volumes were removed after qualification.

The adapter only translates administration calls into authenticated dashboard requests. It does not emulate a node or alter Lightning messages. [AMD64 funded evidence](qualification/funded-amd64.json), [ARM64 funded/offline evidence](qualification/funded-arm64.json), and [image provenance](qualification/images.json) record the exact native binary, client bundle, image and archive hashes. The raw fixture hashes the adapter path, so these saved records identify that hash separately from the native daemon hash.

`dist/native-source.sha256` records all 977 source files in the image build context. That snapshot included the then-uncommitted daemon; its native runtime source matches the subsequently saved LDK commit `35b49a99bdff7edbe3c97dd5a605edf6e878ead4`. Image archives remain local and are excluded from Git. The architecture-detecting loader verified both archive checksums and loaded the matching ARM64 image. Local Compose validated directly; the Umbrel manifest validated with a schema-only placeholder for the proxy that Umbrel injects, without starting that integration.

## Scope and limits

This dashboard exposes the local native implementation. Mainnet is selectable, but all funding and interoperability qualification uses disposable regtest funds. A real Umbrel installation and a real ARM64 Umbrel device have not been modified or qualified.

The native protocol qualification is recorded in the adjacent LDK fork. Recovery, offline concurrent voucher retirement, chain fee policy, and deep-reorganization behavior retain the limitations documented there. The matching local client bundle fixes the original phone's initial commitment-fee selection, shared-input fee audit, and reconnect watchdog. Install it as described in [local client compatibility fixes](../../../synonym/ldk-node/docs/chicory-primary.md#local-client-compatibility-fixes) before using this candidate. Native fee admission remains unchanged.

A draining concurrent offline voucher book can retain funds until cooperative settlement or an on-chain timeout. A six-confirmation splice-conflict proof assumes that confirmation history remains authoritative; archival monitor custody does not promise full-balance recovery under arbitrary deeper reorganizations. Back up complete stopped wallet state.
