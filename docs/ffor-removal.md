# Native primary compatibility after FFOR removal

The current source removes FFOR offline receiving from the dashboard and pairs
with a native daemon that no longer implements the protocol. Its supported
primary paths still include ordinary Lightning payments, JIT receive, confirmed
direct funding, peer backup recovery and TCP, Tor and Iroh connections. Each path
requires its own current qualification; a historical pass is not a current pass.

## Primary reserve requirement

Phone-funded channels still require the primary to hold its default 25,000-sat
on-chain anchor reserve per channel. Before accepting another anchor channel,
the native node requires that amount to be available above the reserves already
retained for its existing channels. It rejects a first incoming phone-funded
channel when the primary has no reserve available. The reserve stays in the
primary's on-chain wallet for emergency channel-closing transactions; the phone
can supply all of the channel's funding without spending this reserve. JIT
liquidity advances and routing capacity have their own funding requirements.

## Instant growth of confirmed channels

A channel first funded onchain or by direct funding keeps its confirmation
policy. Waiting six blocks while holding an incoming Lightning payment cannot
provide prompt JIT growth. To allow instant growth for a wallet you control and
trust, stop the primary and open **Settings > Edit configuration > Trusted
wallets for instant channel growth**. Enter that wallet's compressed Lightning
public key, save and restart. The `chicory.trusted_splice_peer_pubkeys` list is
empty by default; pairing never adds a wallet automatically.

This is an explicit financial trust decision. Until the splice confirms, the
wallet can spend the old channel funding and invalidate the new funding after
receiving a payment. The primary can lose the forwarded funds. Owning the added
inputs does not eliminate this old-funding risk. Only the listed wallet's
primary-initiated positive splice, funded entirely by the primary, qualifies.
The native transaction checks reject hidden peer inputs before signing. Direct
funding and phone-initiated deposits retain their confirmation requirements.

The phone also has to explicitly trust its configured primary and use the
compatible portable engine. Each side records permission for the individual
candidate; the channel's general confirmation policy is unchanged. Removing a
wallet from the primary list prevents future fast-path attempts but does not
revoke an already authorized attempt, including one still negotiating. Unlisted wallets can use confirmed funding
and ordinary Lightning within available capacity, but oversized incoming
payments can expire while a confirmed channel grows and may need a new payment.

## Existing wallets

Old dashboard registries contain `chicory.offline_enabled`, including `false`
when the feature was never enabled. The current manager accepts either saved
boolean and omits the removed field only when generating `node.json` for the
native daemon. It does not rewrite the registry during initialization or startup,
replace keys, remove channel state, or clear native monitors. Other provider
limits and fees, the selected network and backend remain unchanged.

An enabled setting alone does not prove that a wallet ever held offline custody.
The native reader remains responsible for rejecting actual unsupported persisted
FFOR state. Do not delete state or change a seed to bypass that rejection. Keep a
full stopped backup and use the compatible prior version with the same latest
state to resolve existing obligations before attempting a controlled migration.
Do not run both versions against the same wallet or restore an old channel
snapshot after newer activity. A successful ordinary-wallet upgrade does not
qualify migration of a wallet with FFOR custody.

New create or update requests that enable offline receiving return
`OFFLINE_RECEIVE_REMOVED`. Supported settings omit the old field. The dashboard
no longer polls or exposes `offline_status`, and both its read route and RPC path
reject that removed operation. Its offline page and enablement control are gone.

## Local candidate versus published package

The community-store Compose file remains pinned to the published 0.1.12 image.
The source changes are not live in that release. `docker/Dockerfile.release`
builds the native daemon from its named `native` context, then retains the
qualified base's Iroh, Tor, system libraries and JavaScript dependencies. The
base image does not supply the newly built daemon. Do not reuse a release tag or
rewrite release provenance when evaluating a local candidate.

The fixture adapter, native direct-funding wrapper, basic container smoke test
and feature migration test accept
`LDK_CONTAINER_IMAGE` for an explicitly selected local image. The feature test
also accepts `LDK_PREVIOUS_IMAGE`, defaulting to the matching 0.1.12 architecture.
It uses two fresh wallets on an isolated regtest chain at genesis, with no funds
or channels, to check both legacy boolean settings through the real manager and
native daemon. It checks preserved identities and registry bytes, removed wire
capabilities and RPCs, and ordinary address and unpaid-invoice creation. It does
not test existing FFOR custody or physical Umbrel hardware.

```sh
cd manager
npm test
cd ..
LDK_CONTAINER_IMAGE=ldk-node-umbrel:chicory-qualified-arm64 \
BEIGNET_ROOT=/absolute/path/to/beignet \
node scripts/feature-bits-container-test.mjs arm64
```

Funded Chicory fixtures require exclusive use of a disposable regtest chain.
The reusable [matrix runner](../scripts/chicory-flow-container-test.py) exercises
the authenticated manager and packaged native daemon through
`scripts/fixture-primary.cjs`. It takes an existing local image and explicit
source and backend paths; it does not load, build or publish images. The native
fixture checks for regtest before funding. Its Bitcoin CLI uses RPC port 43782
and the native fixture's fixed test credentials inside the specified container.
The externally reachable primary RPC and Electrum ports can differ.

```sh
python3 scripts/chicory-flow-container-test.py \
  --image ldk-node-umbrel:chicory-qualified-arm64 \
  --architecture arm64 \
  --native-source /absolute/path/to/ldk-node \
  --chicory-source /absolute/path/to/chicory \
  --beignet-source /absolute/path/to/beignet \
  --bitcoin-container disposable-regtest-core \
  --primary-chain-url "$PRIMARY_REGTEST_URL" \
  --electrum-url tcp://127.0.0.1:50001
```

Use the installed Chicory dependencies and a built Beignet payer checkout. Set
`PRIMARY_REGTEST_URL` to the fixture's authenticated RPC URL or its Electrum URL.
The runner clears inherited scenario and transport overrides. It runs these nine
scenarios sequentially and stops at the first failure:

- `initial-deposit-growth`: first deposit, explicit trusted-wallet opt-in,
  JIT growth without mining, and restarts.
- `baseline-growth-splices`: fixed and amountless receives, an external Lightning
  recipient, JIT growth and splice-out.
- `direct-funding`: existing-home and first-channel deposits, pending receipts
  across restarts, receive completion, and later explicitly trusted JIT growth
  without mining.
- `send-max-bech32`, `send-max-bech32m`, `send-max-p2wsh`: exact reviewed destinations.
- `drain`: completion after restarts and exclusion of later receipts.
- `conflict`: recovery of usable prior funding after a confirmed conflict.
- `recovery-sweep`: restore and sweep of the primary's current commitment.

Repeat `--scenario NAME` to run a subset. The default runs all nine. A subset can
pass its selected scenarios but is explicitly marked as an incomplete matrix.
The optional `--output-dir` must name a new directory. Otherwise, the runner
creates a private temporary directory and prints its location. Each scenario
has a sanitized log, native fixture JSON and result JSON. `summary.json` records
the selected scenarios, completed results and cleanup result. Failed logs remain
available. Cleanup runs once when the suite ends and touches only the recorded
fixture containers and their corresponding named data volumes.

Evidence includes the actual local image SHA-256 identity, source revisions and
tracked-change flags, runner and driver hashes, the adapter hash, and hashes of
the installed portable-engine distribution, wallet-core source files and both
package manifests. Input changes during a run fail that scenario. Per-scenario
success requires a zero exit status, native regtest success, matching installed
client hashes and each scenario's required completion checks. These records
describe a local candidate, not qualification of the published release or
physical Umbrel hardware. Authentication values are removed from saved evidence
and logs. The adapter no longer requests offline receiving.

## Recorded candidate checks

Both local candidates passed the complete nine-scenario funded matrix with
107 checks each: [ARM64](qualification/chicory-qualified-arm64-flows.json) and
[AMD64](qualification/chicory-qualified-amd64-flows.json). This covers initial
phone-funded channels, ordinary and JIT Lightning receives, payments to an
external recipient, channel growth and splice-out, direct funding, all three
send-max destinations, drain, confirmed conflict recovery and recovery sweep.
The records include pending and completed receipt checks, exact balances and
Activity rows, and phone/primary restarts. Instant growth of a confirmed channel
uses the explicit trust configuration described above.

Both matrices used the portable engine at `2cdab260ed36dc053278fb48326130ed7f654b77`
and the patched wallet-core snapshot documented in
[client compatibility](client-compatibility.md). Their installed client, adapter
and driver hashes agree, and all nine recorded fixture containers and volumes
were removed after each suite. These are local Docker/regtest results, including
AMD64 under CPU emulation. Published 0.1.12 and physical Umbrel hardware remain
outside this candidate qualification.

The final candidates `ldk-node-umbrel:chicory-qualified-arm64` and
`ldk-node-umbrel:chicory-qualified-amd64` each passed the eight unfunded upgrade
checks against the corresponding published 0.1.12 image. Both legacy settings preserved
their native identities and unchanged registry bytes, and real encrypted BOLT 8
handshakes confirmed the removed features were absent. The record includes the
exact image identities and observations in the
[ARM64 record](qualification/ffor-removal-features-arm64.json) and
[AMD64 record](qualification/ffor-removal-features-amd64.json).
The disposable containers, volume and networks were removed after the run.

Both final images passed 14 unfunded packaged-manager checks each, including
Umbrel app-password authentication, hostname/session binding, native and container
restarts, and real Iroh relay/discovery bridge startup with stable identities.
The [ARM64 smoke record](qualification/chicory-qualified-arm64-smoke.json) and
[AMD64 smoke record](qualification/chicory-qualified-amd64-smoke.json) identify
the images and keep the physical-hardware and published-release claims false.
This checks Iroh bridge startup, not an end-to-end Iroh payment.

The manager suite passed 271 tests. Pairing, Tor-settings with trusted-splice
controls, balance and deletion browser regressions passed 18, 18, 39 and 24
checks respectively at desktop and mobile sizes with zero browser errors. Those browser checks use
synthetic wallet data and do not qualify payments or Tor network reachability.
The [source-check record](qualification/chicory-qualified-source-checks.json)
records the native, portable, wallet-core, Chicory and manager checks, and the
[settings-browser record](qualification/chicory-qualified-settings-browser.json)
includes the explicit trust controls.
The direct-funding wrapper's candidate selection and
evidence fields were checked separately with synthetic process stubs; this is
not a funded protocol result.

The matrix runner's nine offline tests check scenario isolation, evidence
validation, credential redaction, source hashes, regtest gating and owned-resource
cleanup. Run them without Docker or chain access:

```sh
python3 -m unittest discover -s scripts -p 'test_chicory_flow_runner.py' -v
```
