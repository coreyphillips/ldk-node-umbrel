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

These presets require the corresponding app to be installed and synced on the same Umbrel. Electrs remains optional, as it does in Beignet. If Umbrel supplies Electrs dependency exports they can seed a default; otherwise choose a preset or enter a server explicitly. Version 0.1.5 maps this Umbrel's own hostname, supplied by Umbrel as `DEVICE_DOMAIN_NAME`, to Docker's host gateway. A custom hostname such as `tcp://mint.local:60401` therefore reaches the published Electrum port on the same server without a fixed LAN IP. This applies to both the connection check and native wallet connections, including reconnects. The server must publish its port on an interface reachable through the host gateway. Other machines' `.local` names still depend on the container's DNS setup; use a reachable DNS name or LAN IP for those machines.

Electrum addresses also accept `mint.local:60401:t` for TCP and `server.example:50002:s` for TLS. These normalize to `tcp://mint.local:60401` and `ssl://server.example:50002` when saved. IPv6 literals require brackets, for example `[2001:db8::1]:50002:s`. TLS continues to verify the original hostname. Existing URLs, wallet identities and network selections are preserved.

The same-host mapping is part of the Umbrel app package and takes effect when the app container is recreated during the update. Standalone Compose installations can add `extra_hosts: ["mint.local:host-gateway"]` for their own host name.

**Test connection** checks the server's actual genesis header against the selected wallet network and shows its height when available. It distinguishes DNS lookup, connection refusal, timeout, TLS and protocol failures. Startup also performs this check while retaining native genesis verification. It never changes the wallet network to fit a server.

For a saved failed wallet, open **Settings > Edit configuration**, select the installed server, test, save and start the same wallet. A running wallet must be stopped before editing. This changes the connection setting while retaining the wallet ID, native identity and channel storage. Version 0.1.2 normalizes a trailing slash before passing an existing Electrum URL to the native client; it does not silently substitute a different host or rewrite the wallet registry on startup.

No chain app is automatically installed. Backend passwords are stored privately on the server and redacted from dashboard reads.

Enable provider funding and offline settlement only after reviewing the configured limits.

## Larger primary payments in 0.1.10

Version 0.1.10 updates the native primary engine so a compatible private client channel can grow when an incoming payment exceeds its original capacity. The primary still needs sufficient spendable on-chain funds and configured funding limits. A successful quote does not itself reserve a settled payment or bypass the configured receive fee.

The Bitkit Primary Regtest version 197 already includes the matching client changes. Update this primary before testing a fresh channel. Channels opened by the older provider retain their saved payment limit after an upgrade. For one of those channels, complete a controlled normal close and reopen with the updated primary and client. Preserve wallet data and current channel state; deleting the wallet or its storage is not an upgrade procedure.

The 50,000 sat qualification used a Beignet sender, the packaged native primary and Bitkit's native client engine on regtest. It grew a 40,000 sat channel to 110,000 sats and credited 49,850 sats after a 150 sat receive fee. The test did not exercise the Android UI or a physical Umbrel installation.

## Read and export wallet logs

Open the selected wallet's **Logs** page for its native file log and process diagnostics. **Refresh** loads the latest snapshot; **Copy logs** and **Download logs** export the displayed snapshot as plain text. The native log remains available when process diagnostics are empty or the wallet is stopped.

The snapshot contains the newest complete records, capped at 256 KiB of native logs plus 64 KiB of process diagnostics. Sensitive values are redacted, and omitted older content is identified. Review the exported text before sharing it. The controls require the existing authenticated wallet session and work over a normal HTTP LAN connection.

## Choose a phone connection

Open **Pair Chicory > Connection method** to choose **Iroh**, **Local network (TCP)**, or **Tor** from the available addresses. The selected method controls the displayed URI and QR code. Copy or scan that address in the client. This choice does not enable or disable a transport, so one client can use Tor while another uses Iroh.

For Tor, stop the wallet and open **Settings > Edit configuration**. Turn on **Enable Tor connections**, save and start the wallet. The app starts its bundled Tor process and creates a private v3 onion service mapped to that wallet's native Lightning listener. No router port forwarding or manually provisioned onion service is required. After the address appears, choose **Tor** in **Pair Chicory** and scan or copy it. Tor may take several minutes to bootstrap and publish the service after startup; an address alone does not prove that an external client can reach it yet.

Managed Tor is optional and disabled by default. A Tor process runs only while a wallet with this option enabled is running. Stopping the wallet stops its Tor process, while preserving the onion identity for the next start. Iroh and local TCP remain enabled independently, so different clients can use different methods at the same time. This feature accepts incoming connections over Tor only. It does not change the routing of outgoing Lightning peer connections or chain-backend requests and does not hide their network address.

Each wallet keeps Tor's persistent DataDirectory, onion keys and guard state under its private `wallets/<id>/tor` directory. The CacheDirectory is temporary. Full dashboard backups retain the persistent Tor state, so restoring a complete backup retains the onion identity. No SOCKS or Tor control port is exposed. Keep Tor keys and backups private, and never run an original wallet and its restored copy simultaneously.

For an existing external onion service, the advanced manual onion address remains available. It must already forward to this wallet's native Lightning listener. Enabling automatic Tor clears the manual address; use one source for the displayed Tor address. The Tor URI can also serve as a fallback for Iroh clients that support it.

For Iroh, enable the transport, public relays and discovery explicitly in wallet Settings. TCP requires the phone to reach the configured host and public Lightning port.

The container pins Debian's `tor` package to `0.4.9.11-0+deb12u1`, available from Bookworm and Bookworm security updates when packaged. It also installs `libevent-2.1-7` and `runit-helper` as required dependencies. Their distribution copyright and license notices remain in `/usr/share/doc/tor/copyright`, `/usr/share/doc/libevent-2.1-7/copyright` and `/usr/share/doc/runit-helper/copyright`; other system dependency notices remain under `/usr/share/doc`.

## Back up and restore

For the dashboard download and phrase controls, see [Recovery phrases and encrypted dashboard backups](#recovery-phrases-and-encrypted-dashboard-backups-014) below.

Stop every wallet and stop the Umbrel app before copying its data directory. Back up the complete app-data `ldk-node-wallet/data` directory, preserving permissions. It contains funds-controlling channel state, RPC credentials, transport identities and dashboard authentication. Store the backup securely. A wallet seed is not a substitute for current Lightning channel state.

For a standalone Compose installation, stop the container and run `./scripts/backup.sh /absolute/path/to/backup.tar.gz` from the package. The script operates on that package's local `data` directory, not Umbrel's managed app-data directory.

To restore, stop the destination app, retain its existing data separately, and restore the complete saved directory before starting the same compatible version. Never run the original and restored copies simultaneously. Confirm the expected node identity and network before operating. The saved password hash remains in effect after a restore, so the original app password is needed.

Do not uninstall the app as a way to restart it or reset its password. Uninstallation can remove funds-controlling state. Preserve a full stopped backup before any migration or repair.

## Automatic receive updates

The dashboard refreshes balances and payment status every five seconds while visible, including when a receive QR is open. Returning to the tab triggers an immediate refresh. A payment must first reach the configured chain backend or Lightning node before the dashboard can show it; a pending on-chain transaction is not a confirmed or necessarily spendable balance.

For a running Electrum wallet, the app subscribes to activity changes for its recently generated receive addresses. For Esplora, it checks those addresses every 15 seconds. Both paths verify the configured Bitcoin network and ask the native wallet to synchronize when activity changes. Requests are coalesced and rate-limited, and the native wallet remains the source of balance and payment data. Bitcoin Core wallets use the native daemon's existing automatic chain and mempool synchronization.

The last 16 SegWit addresses generated by this dashboard are saved privately with each wallet and watched again when it starts. Stopping a wallet stops its watcher, and deleting the wallet removes its saved watch list. This is an accelerator for recent receive requests; native background synchronization still discovers older addresses and changes missed during an outage. The watcher uses the wallet's configured backend, including normal TLS verification for SSL Electrum endpoints, and does not send addresses to a separate public service.

## Delete a wallet

First finish any required fund recovery, including closing channels and withdrawing funds, and save a current **Back up all wallets** download. Verify that you have the file and its password before continuing. Deletion does not close channels, withdraw funds, or move them to another wallet. A recovery phrase alone cannot restore current Lightning channel state.

Stop the wallet you intend to remove. Open its **Settings > Delete wallet** card and choose **Delete wallet**. The confirmation shows the wallet's name and network. Type the exact wallet name, select **I understand this permanently deletes this wallet’s data from this app**, then choose **Permanently delete wallet**. A running or still-stopping wallet cannot be deleted; the app does not stop it automatically for deletion.

Deletion removes only the selected wallet's private directory and registry entry, including its native keys, recovery phrase, channel state, configuration, logs, Iroh identity and Tor onion identity and guard state. Other wallets keep their data and identities. A new wallet can use the released slot and ports, but receives a new wallet ID and seed. Previously downloaded backups remain separate and are not erased. This is filesystem removal, not a guarantee of physical secure erasure.

If cleanup fails after deletion begins, the wallet remains visible as pending deletion and keeps its slot reserved. Starting, editing and recovery-phrase access stay blocked, including after the app restarts. Full backup exports are blocked until pending deletion is resolved. The app never silently resumes deletion on startup. Resolve the reported storage problem, choose **Finish deleting wallet**, then confirm the same name and acknowledgment to retry. Do not treat this state as successful deletion or assume partially removed wallet data can still recover funds.

## Package boundaries

The manager uses no Docker socket and cannot create arbitrary containers. Each wallet is a child process in the app container, with private storage and its own native port. The entrypoint prepares the volume, then runs the manager as UID/GID 1000. Independent manager and wallet locks prevent concurrent use of the same state. Container shutdown allows 75 seconds for native processes to stop.

The app has been tested in Docker on both CPU architectures. A physical Umbrel installation has not yet been tested. If installation fails, retain the app data and report the redacted error with your Umbrel version and CPU architecture.

### Recovery phrases and encrypted dashboard backups (0.1.4)

Open a wallet's **Settings > Recovery & backup**. Wallets created in 0.1.4 have a 24-word English BIP39 phrase. Choose **Recovery phrase > Reveal recovery phrase**, then write the words down in order or use **Copy phrase**. The same prompt appears after creating a wallet. The phrase hides after one minute, when the dialog closes, or when the tab becomes hidden. Clipboard history may retain copied words. There is no additional BIP39 passphrase. The server stores the phrase and its derived seed in private files, and verifies that they match before revealing the words or starting the wallet.

Wallets created before 0.1.4 have a random 64-byte binary seed, not an original mnemonic. The update never changes that seed or invents a replacement phrase. Use a full backup for these wallets. A recovery phrase alone cannot restore current Lightning channels for either kind of wallet.

Choose **Back up all wallets** from Settings or All wallets. Enter and confirm a strong backup password of at least 12 characters, acknowledge that the wallets will stop, then choose **Stop wallets and download backup**. Save the `.ldkbackup` download and its password privately. The password cannot be recovered. Check that the download completed before starting wallets again. Closing or hiding the dialog cancels the browser request; any wallets already stopped stay stopped.

The archive includes all wallet seeds, phrases where available, current channel monitors and databases, SQLite journals, configuration, transport keys, logs and dashboard authentication. Only process lock files are excluded. Each export uses a fresh random salt and IV, scrypt password derivation and AES-256-GCM authenticated encryption. Dashboard sessions, origin checks, browser proof and CSRF validation protect export and reveal routes. Other apps on the same hostname cannot authorize them using a shared cookie alone. The snapshot gate refuses running or still-exiting native, Iroh and Tor processes and blocks starts and configuration writes while reading files. Secret responses are not cached. JavaScript strings cannot promise immediate erasure from process memory.

Dashboard exports support up to 128 MiB of source file data and 10,000 filesystem entries. Larger installations should use the complete stopped-data backup procedure above. Backups are snapshots, not continuous channel recovery. Make a fresh stopped backup before migration and never restore an old snapshot after the original wallet has continued operating.

### Restore an encrypted download offline

Use Node.js 22 or later and the source archive for the matching release. The restore tool uses built-in Node modules and needs no `npm install`:

```sh
node scripts/restore-backup.mjs /absolute/path/wallets.ldkbackup /absolute/path/new-restored-data
```

Enter the backup password at the hidden prompt. For automation, add `--passphrase-file /absolute/path/private-password-file`; that file must be owned by the current user and have mode `0600`. Do not put the password in command arguments or environment variables. The tool authenticates and validates the entire archive before creating the destination, refuses existing destinations, restores private permissions, and starts no processes.

Keep the original installation stopped. Use only its latest snapshot and permanently retire the original copy before starting the restored one. With the destination Umbrel app stopped, preserve its current data elsewhere and install the complete restored directory as its data directory, owned by the app's UID/GID 1000. The archive preserves saved autostart settings, so starting the app may immediately start its wallets. The saved dashboard password hash is also preserved; use the original dashboard password. Confirm the expected wallet network and node identity before operating. Never run both copies.
