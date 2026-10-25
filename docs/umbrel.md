# Umbrel installation and operation

## Community store

Add `https://github.com/coreyphillips/ldk-node-umbrel` in **App Store > three-dot menu > Community App Stores**, then open the LDK Node store and install the app. This follows [Umbrel's community store instructions](https://umbrel.com/support/apps/how-to-add-a-community-app-store).

The store ID is `ldk-node`; the app ID is `ldk-node-wallet`. The published image supports `linux/amd64` and `linux/arm64`. The Compose manifest pins the combined image index digest so both platforms receive the reviewed release. Umbrel keeps the app's private data in its app-data directory, mounted at `/data` in the manager.

The dashboard uses port 2114. Wallet Lightning listeners use host ports 19351 through 19358. The internal manager port 3000 is not published directly by the community package. Umbrel's gateway authentication remains enabled. The manager also requires the per-install app password shown by Umbrel, with no username. Its first run saves a salted password hash; restarting does not replace an existing password.

Current Umbrel gateways preserve the browser's Host and may terminate HTTPS. Password mode accepts a validated hostname, IPv4, IPv6 or onion authority and requires the login Origin to match it. Sessions and mutation CSRF checks bind that origin. A separate browser proof lives in origin-scoped session storage and is required with the cookie for every authenticated request. This prevents another app on the same hostname from authorizing requests using a received cookie. A same-tab reload retains sign-in; a fresh tab can require sign-in again. Forwarded headers do not grant authentication. The community manifest enables flexible hostnames explicitly, so custom device names and IP access do not require editing the app. A standalone deployment should use explicit `PUBLIC_ORIGIN` and `ALLOWED_HOSTS`.

## Configure a chain backend

Mainnet is preselected. Select regtest, signet or testnet only if both your backend and phone use that network. The native daemon verifies the backend genesis hash and refuses a mismatch.

Choose a reachable Bitcoin Core RPC, Electrum or Esplora endpoint. Electrum offers the same local presets as Beignet:

| Installed app on this Umbrel | URL | Transport |
| --- | --- | --- |
| Electrs | `tcp://10.21.21.10:50001` | TCP, SSL disabled |
| Fulcrum | `tcp://10.21.21.200:50002` | TCP, SSL disabled |
| rbitcoin | `tcp://beignet-rbitcoin_node_1:50001` | TCP, SSL disabled |

Fulcrum's internal port 50002 uses plaintext TCP on Umbrel. Do not select TLS merely because the port is 50002. The address `electrs_server_1` offered by version 0.1.1 was incorrect; choose the Electrs preset to repair an existing wallet that saved it.

These presets require the corresponding app to be installed and synced on the same Umbrel. Electrs remains optional, as it does in Beignet. If Umbrel supplies Electrs dependency exports they can seed a default; otherwise choose a preset or enter a server explicitly. A `.local` name may resolve on your computer but fail inside a Linux container. Use an internal preset for the same Umbrel, or a reachable LAN IP/hostname for a server on another machine.

**Test connection** checks the server's actual genesis header against the selected wallet network and shows its height when available. It distinguishes DNS lookup, connection refusal, timeout, TLS and protocol failures. Startup also performs this check while retaining native genesis verification. It never changes the wallet network to fit a server.

For a saved failed wallet, open **Settings > Edit configuration**, select the installed server, test, save and start the same wallet. A running wallet must be stopped before editing. This changes the connection setting while retaining the wallet ID, native identity and channel storage. Version 0.1.2 normalizes a trailing slash before passing an existing Electrum URL to the native client; it does not silently substitute a different host or rewrite the wallet registry on startup.

No chain app is automatically installed. Backend passwords are stored privately on the server and redacted from dashboard reads.

Enable provider funding and offline settlement only after reviewing the configured limits. For Iroh phone pairing, enable the transport, public relays and discovery explicitly. TCP pairing requires the phone to reach the displayed host and Lightning port.

## Back up and restore

Stop every wallet and stop the Umbrel app before copying its data directory. Back up the complete app-data `ldk-node-wallet/data` directory, preserving permissions. It contains funds-controlling channel state, RPC credentials, transport identities and dashboard authentication. Store the backup securely. A wallet seed is not a substitute for current Lightning channel state.

For a standalone Compose installation, stop the container and run `./scripts/backup.sh /absolute/path/to/backup.tar.gz` from the package. The script operates on that package's local `data` directory, not Umbrel's managed app-data directory.

To restore, stop the destination app, retain its existing data separately, and restore the complete saved directory before starting the same compatible version. Never run the original and restored copies simultaneously. Confirm the expected node identity and network before operating. The saved password hash remains in effect after a restore, so the original app password is needed.

Do not uninstall the app as a way to restart it or reset its password. Uninstallation can remove funds-controlling state. Preserve a full stopped backup before any migration or repair.

## Package boundaries

The manager uses no Docker socket and cannot create arbitrary containers. Each wallet is a child process in the app container, with private storage and its own native port. The entrypoint prepares the volume, then runs the manager as UID/GID 1000. Independent manager and wallet locks prevent concurrent use of the same state. Container shutdown allows 75 seconds for native processes to stop.

The app has been tested in Docker on both CPU architectures. A physical Umbrel installation has not yet been tested. If installation fails, retain the app data and report the redacted error with your Umbrel version and CPU architecture.
