# Qualification record

This file distinguishes executable checks from deployment assumptions. It will be updated after image qualification.

## Completed

- Fourteen manager tests cover authentication, CSRF and Origin checks, Host validation, fail-closed app-proxy DNS, redacted configuration, immutable wallet networks, private files, bounded wallet and RPC counts, out-of-order JSONL replies, uncertain outcomes, and process shutdown.
- The dashboard manager ran against the actual normal-feature native daemon and the explicitly authorized regtest Electrum server. It created a disposable wallet, retrieved native capabilities, balances, channels, peers, payments, events and offline status, created a receive address and unpaid invoice, and preserved the exact native identity through stop/start. No funds were sent in this check.
- Desktop and 390px mobile browser QA passed ten interaction/layout checks against the real native wallet, including pairing QR and receive-address creation, with no JavaScript errors or horizontal overflow. Screenshots were inspected.
- First-run network selection is Mainnet. Liquidity, offline settlement, and Iroh are disabled until enabled by the operator.

## Container checks

Both Linux release images built successfully with Rust 1.90 and pinned Node 24.22.1 base images. The exported architecture was checked explicitly. Intel/AMD runs use Docker Desktop CPU emulation on this ARM64 development machine; no claim of testing physical Intel or Umbrel hardware is made.

Both images passed authenticated native regtest sync, receive address and unpaid invoice creation, pairing QR generation, Iroh addon loading, native process restart, and whole-container restart retaining the same native identity. A final signal-forwarding check validates graceful manager shutdown. `dist/qualification-amd64.json` and `dist/qualification-arm64.json` record the exact results and image IDs.

The ARM64 image also passed the six-check funded installed-Chicory baseline through an authenticated manager adapter. It received 20,000 sats with 19,880 net after the negotiated fee, restored the payment and channel on phone restart, and paid a native primary invoice. The adapter does not emulate a node or alter protocol messages. Additional funded and offline qualification is recorded below when complete.

## Scope and limits

This dashboard exposes the local native implementation. Mainnet is selectable, but all funding and interoperability qualification uses disposable regtest funds. A real Umbrel installation and a real ARM64 Umbrel device have not been modified or qualified.

The native protocol qualification is recorded in the adjacent LDK fork. Recovery, offline concurrent voucher retirement, chain fee policy, and deep-reorganization behavior retain the limitations documented there. In particular, a phone's fixed anchor commitment fee can be refused by a higher Electrum-derived native minimum; the dashboard does not weaken that minimum.

A draining concurrent offline voucher book can retain funds until cooperative settlement or an on-chain timeout. A six-confirmation splice-conflict proof assumes that confirmation history remains authoritative; archival monitor custody does not promise full-balance recovery under arbitrary deeper reorganizations. Back up complete stopped wallet state.
