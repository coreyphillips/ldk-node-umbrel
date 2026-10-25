# LDK Node for Umbrel

A local dashboard for independent native LDK Node wallets, with Chicory primary support from the adjacent local LDK fork. Mainnet is the initial network selection. The operator must choose and verify a chain backend before a wallet starts. Liquidity provisioning, offline settlement, Iroh relays, and endpoint discovery require explicit configuration.

This package runs the Rust `ldk-node-daemon` directly through private JSONL pipes. It does not load a Beignet node engine. All source and image archives stay local. There is no image registry or automatic update service.

![Native LDK wallet dashboard](docs/screenshots/wallet.png)

## Included

- Up to eight independent native nodes with persistent identities and storage.
- On-chain and Lightning balances, addresses, invoices, payments, channels, peers, splice operations, native events, and offline voucher summaries.
- Chicory primary pairing by TCP URI/QR or an optional separate Iroh byte bridge.
- Password authentication for local Docker Compose, or fail-closed Umbrel app-proxy authentication in the app manifest.
- Private configuration, session cookies, CSRF and Origin validation, bounded RPC queues, explicit uncertain transaction outcomes, and supervised native processes.
- Local `linux/amd64` and `linux/arm64` image build/export scripts, checksummed archives, an Umbrel app manifest, and cold backup instructions.

## Build on your development machine

Requires Python 3 and Docker Desktop or Docker Engine with Buildx and both target platforms available. The native source must include this local Chicory fork and `tools/ldk-node-daemon/Cargo.lock`.

```sh
LDK_SOURCE_DIR=/absolute/path/to/ldk-node ./scripts/build-images.sh
```

The script exports `dist/ldk-node-umbrel-0.1.0-amd64.tar` and `dist/ldk-node-umbrel-0.1.0-arm64.tar` plus `SHA256SUMS`. It never pushes an image. Pinned Docker base digests and Cargo/npm lockfiles constrain the build inputs. Building the native channel engine takes substantially more resources than the dashboard.

## Run locally on your Umbrel

Copy this directory and the appropriate image archive to a directory on your Umbrel. Keep the other architecture archive if you want the checksum file to verify both. Run:

```sh
./scripts/load-local.sh
```

The script detects Intel/AMD or ARM64 and loads the matching local archive. Review `.env`: set `PUBLIC_ORIGIN` to the exact browser origin, such as `http://umbrel.local:2114`, and `ALLOWED_HOSTS` to the hostname or IP you will use. Then start:

```sh
docker compose -f compose.local.yml up -d
```

Open the configured origin. Read the generated password on the Umbrel host with `sudo cat data/dashboard-password`. The password file and complete data directory are private. Do not put them in source control or send them with a bug report.

The dashboard listens on port 2114. Native Lightning ports are 19351 through 19358. Choose a reachable server LAN host in wallet settings before TCP pairing. Use a trusted LAN or a private VPN; if you expose a remote dashboard, place it behind a TLS reverse proxy and set `COOKIE_SECURE=1` and the HTTPS `PUBLIC_ORIGIN`. Do not expose the manager's internal container port separately.

Umbrel documents custom containers through Docker Compose and Portainer in [Running custom Docker containers](https://umbrel.com/support/apps/running-custom-docker-containers). This local flow does not install an app-store tile or alter Umbrel itself. `ldk-node-wallet/` follows the [community app-store template](https://github.com/getumbrel/umbrel-community-app-store) for optional app integration testing. See [Umbrel package details](docs/umbrel.md). No live Umbrel installation is performed by this repository.

## Create and pair a wallet

1. Create a wallet and explicitly choose its Bitcoin network. Mainnet is preselected.
2. Enter your Bitcoin Core RPC, Electrum, or Esplora connection. Credentials stay on the server. Native startup checks the backend genesis hash and refuses a mismatch.
3. Start the wallet. Open Overview and sync before interpreting its balance or chain height.
4. In Settings, enable the Chicory provider only if you want this node to fund client channels. Review both funding caps and fees. Offline settlement has a separate option.
5. Open Pair Chicory. Use the same Bitcoin network on your phone and scan or paste the URI as an external primary.
6. For Iroh phone pairing, explicitly enable Iroh, public relays, and endpoint discovery. An optional pre-existing v3 onion host and port can be entered as a separate same-key Tor fallback URI. The dashboard does not create that onion service. The bridge stores a separate transport identity. It does not hold Lightning keys.

For Umbrel chain apps, use their reachable Docker service or host address. The example `electrs_server_1:50001` is a starting value, not an automatic network connection. Local Compose may need an explicit external Docker network shared with the chain app, or a reachable LAN address. Use `docker network inspect` to verify your actual network before configuring it. Do not copy another node's seed or reuse its active storage.

## Back up and restore

Stop all wallets and the dashboard container first. Run `./scripts/backup.sh /absolute/path/to/backup.tar.gz`. Store the archive securely: it includes funds-controlling state, RPC credentials, transport identities, and dashboard authentication. A seed alone does not restore current Lightning channels.

To restore, stop the destination container, keep its existing data aside, extract the full archive into this package directory, then start the same compatible image. Never run the original and restored copies simultaneously. Confirm the expected identity and network before operating. There is no seed-import or seed-export screen because a partial restore can lose channel state.

## Development and verification

```sh
cd manager
npm ci
npm test
```

Use Node 24 or newer. Set `LDK_NODE_BIN` to a built native daemon, `DATA_DIR` to an unused private directory, and `PUBLIC_ORIGIN` before `npm start`. The manager's tests use disposable files and mocked native processes. Separate qualification also exercises the real native daemon. See [qualification](docs/qualification.md) for what was actually run and what remains limited.

The custom-protocol implementation remains experimental. No claim of universal parity or lossless recovery outside the measured protocol assumptions is made. The native fork's `docs/chicory-primary.md` and `vendor/lightning/LOCAL_PATCH.md` describe protocol behavior and recovery limits. This package does not bypass native fee floors, confirmations, signer checks, or persistence barriers.
