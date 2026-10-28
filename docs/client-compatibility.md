# Chicory client compatibility

Updating the Umbrel primary does not update Chicory on a phone. The published
0.1.12 dashboard image and the current candidate use different native and client
inputs. Use the matching source revisions and image identities in the
[qualification records](qualification.md); an arbitrary App Store or upstream
Chicory build is not covered by those results.

## Current candidate sources

The candidate sources are available on these Git branches. They are separate
from the image pinned by the published Umbrel community-store package.

| Component | Repository and branch |
| --- | --- |
| Native primary | [ldk-node: feat/lfbw-wallet-client](https://github.com/coreyphillips/ldk-node/tree/feat/lfbw-wallet-client) |
| Umbrel dashboard | [ldk-node-umbrel: fix/chicory-primary-flows](https://github.com/coreyphillips/ldk-node-umbrel/tree/fix/chicory-primary-flows) |
| Chicory phone | [chicory: fix/primary-receive-capabilities](https://github.com/coreyphillips/chicory/tree/fix/primary-receive-capabilities) |
| Portable engine | [beignet-portable-engine: fix/chicory-primary-flows](https://github.com/coreyphillips/beignet-portable-engine/tree/fix/chicory-primary-flows) |

The tested phone snapshot is committed as
[`a2086e9710e7d333a13506a42643fa59fb3e03a9`](https://github.com/coreyphillips/chicory/commit/a2086e9710e7d333a13506a42643fa59fb3e03a9).
The native runtime is committed as
[`437ee29947f96c486cf01a74bf941539b49d3b79`](https://github.com/coreyphillips/ldk-node/commit/437ee29947f96c486cf01a74bf941539b49d3b79).
The qualification records retain the original working-tree revisions and exact
file hashes observed during the runs.

The current native primary and dashboard no longer provide FFOR offline
receiving. Saved legacy configuration is accepted without forwarding its removed
option to the daemon. Actual persisted FFOR custody remains subject to the native
reader's rejection and is never erased to permit startup. Follow the
[migration guidance](ffor-removal.md) for existing wallets.

Instant growth of a confirmed channel requires the operator's explicit
`trusted_splice_peer_pubkeys` setting. Its default is an empty list. Pairing does
not add a phone to this list. Trust allows use of unconfirmed replacement funding
and exposes the primary to loss if that peer spends the old funding instead.
Operators should only list peers they control and trust. The separate default
25,000-sat on-chain anchor reserve per channel still applies, including channels
funded by the phone.

## Fresh Chicory dependency installation

Chicory 0.7.4 on the candidate branch pins its engine and wallet client in
`package.json` and `package-lock.json`:

| Dependency | Exact Git revision |
| --- | --- |
| `@beignet/portable-engine` | [`2cdab260ed36dc053278fb48326130ed7f654b77`](https://github.com/coreyphillips/beignet-portable-engine/commit/2cdab260ed36dc053278fb48326130ed7f654b77) |
| `@beignet/wallet-core` | [`f1cae26eda6c9b3b8c8e21220b2f42eaaff8661d`](https://github.com/coreyphillips/beignet-wallet-core/commit/f1cae26eda6c9b3b8c8e21220b2f42eaaff8661d) |

For a fresh checkout, use Node 22.11 or later and install the lockfile:

```sh
git clone --branch fix/primary-receive-capabilities https://github.com/coreyphillips/chicory.git
cd chicory
git checkout a2086e9710e7d333a13506a42643fa59fb3e03a9
npm ci
```

The Git dependency installation builds the portable distribution and installs
wallet-core from the pinned sources. Chicory's postinstall applies its committed
`patches/@beignet+wallet-core+0.1.0.patch`; that patch is part of the tested input.
A manual copy into `node_modules` is not
part of this candidate's installation procedure. Follow Chicory's platform build
instructions after installation. Keep the lockfile and source revisions with
test evidence; the matrix runner records the installed distribution and
wallet-core file hashes.

The tested installed client files have these SHA-256 fingerprints:

| File | SHA-256 |
| --- | --- |
| `dist/portable.cjs` | `50f3c1dd032b4268cbf0ab89908a278942743aaad6f9fac9d416cf6e9b59a8c1` |
| `dist/portable.mjs` | `78fdb087d031fb2f2dc7efcfe44d60b7805a3e0405f1e9fcad9664e9dafb5221` |
| Installed `@beignet/wallet-core/src/index.js` after the patch | `5b824d7209fb45daa8fecf2597b6b0b81959e3e50f76f03ee5b9b29aa67e7010` |

The current client fixes include durable direct-funding receive receipts and
Activity rows, receipt preservation after later funding changes, and net JIT
receive accounting. A 20,000-sat receive with a 120-sat provider fee records
19,880 sats received and a separate known 120-sat fee. The earlier gross-amount
Activity limitation described in [Chicory issue 74](https://github.com/coreyphillips/chicory/issues/74)
does not describe these corrected client inputs.

Each new JIT authorization binds the invoice's exact payment hash, so unused
requests left by direct funding cannot capture a later equal, smaller or
multipart Lightning receive.

Both local images, `ldk-node-umbrel:chicory-qualified-arm64` and
`ldk-node-umbrel:chicory-qualified-amd64`, passed all nine funded scenarios with
107 checks per architecture using these client inputs. The
[ARM64 flow record](qualification/chicory-qualified-arm64-flows.json) and
[AMD64 flow record](qualification/chicory-qualified-amd64-flows.json) preserve
the exact images, installed file hashes and restart results. Both images also
passed eight unfunded migration checks and 14 Umbrel/Iroh smoke checks each.

These results qualify the recorded local candidate combination. The community
store remains pinned to published 0.1.12, and no replacement image was published
or deployed. The Node portable matrix uses disposable regtest funds over TCP;
it does not qualify a physical phone, physical Umbrel hardware, mainnet payments
or end-to-end payments over Tor or Iroh. A different release branch or newer
dependency pin requires its own validation.

## Historical published 0.1.12 release

The published 0.1.12 images include the older FFOR feature assignments and native
Beignet v3 direct-funding support (`bgnq`). Those images do not contain the current
FFOR removal or later primary compatibility corrections.

That release's direct-funding qualification used the then-current local Bitkit
native engine and Beignet sender and receiver on disposable regtest funds. A
compatible payer supplied a verified confirmed coin, an explicit amount and a
fee ceiling to open or grow the receiving phone's channel. Direct funding did not
use the primary's JIT liquidity-advance fee. The native source snapshot for that
release is recorded in [native-source-0.1.12.json](../licenses/native-source-0.1.12.json).
It is historical build provenance, not the current candidate's source manifest.

Bitkit still requires a matching Android build and native AAR for its phone UI
and payer implementation. Ordinary Lightning and Bitcoin-address payment options
remain available in compatible combined invoices.

## Earlier Chicory qualification inputs

These values identify earlier local qualification runs and do not replace the
current Git pins above:

- Native source: `35b49a99bdff7edbe3c97dd5a605edf6e878ead4`, then on
  `chicory-primary-compatibility`.
- Portable engine base: `67bc9cf0ba3e55fa1e1d7ad73e360bb04321a62c`.
- Corrected portable engine: `c9acc05f61899468f4eefd71d599d0de0bea9190`, then on
  `chicory-initial-commitment-fees`.
- Installed CommonJS SHA-256: `d1a173ff6eec2dabfaf315f81da4fec0e174950e881e2e37dce5b380000822c9`.
- Installed module SHA-256: `7b98cf137c21dd1b84f9c27175c13ce844be180ed7da7b883001579b39e94fae`.
- Chicory iOS scene correction: `2830fc7`, then on `chicory-ios-scene-lifecycle`.

Those runs used a verified manual bundle installation procedure. Current
candidate installations use the committed Git dependencies instead.

## Historical feature-bit migration in 0.1.11

Release 0.1.11 advertised optional FFOR bits 441 and 443 and recognized the
440/441 and 442/443 pairs. It stopped interpreting 560-563 as FFOR because Eclair
uses those assignments for other protocols. That release required matching
feature assignments at both endpoints. It did not advertise async receive
service bits 444/445. The earlier phone bundles above predate that migration.
The current candidate removes the FFOR capability entirely.

The 0.1.11 build used the complete 0.1.10 source snapshot with feature
advertisement, negotiation and regression-test changes.
[native-source-0.1.11.json](../licenses/native-source-0.1.11.json) identifies its
build inputs; its original base Git commit alone does not describe that snapshot.

## Historical issue references

- [Beignet initial commitment fee selection](https://github.com/coreyphillips/beignet/issues/1873)
- [Beignet shared-input fee audit](https://github.com/coreyphillips/beignet/issues/359)
- [Beignet reconnect watchdog](https://github.com/coreyphillips/beignet/issues/1872)
- [Chicory iOS scene lifecycle](https://github.com/coreyphillips/chicory/issues/73)
- [Chicory dependency integration](https://github.com/coreyphillips/chicory/issues/75)
