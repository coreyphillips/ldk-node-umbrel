# Chicory client compatibility

The public dashboard image includes the native primary protocol implementation. It does not update Chicory on a phone. The qualification runs used Chicory 0.7.4 with reviewed local client corrections. Those source branches remain local and are not published by this dashboard release.

## Feature-bit migration in 0.1.11

Release 0.1.11 advertises optional FFOR bits 441 and 443 and recognizes both required and optional variants of the new 440/441 and 442/443 pairs. It intentionally stops interpreting 560-563 as FFOR because Eclair uses those assignments for different protocols. Upgrade both endpoints before enabling offline receive. No wire-message encoding or stored wallet custody format changes.

The historical phone bundles listed below predate this migration and are not sufficient for offline receive with 0.1.11. Use a phone build containing the matching Beignet feature-bit update or the matching native Bitkit update. Ordinary Lightning connectivity is independent of the FFOR capability. This native implementation does not implement or advertise async receive service bits 444/445.

The 0.1.11 native source starts from the complete, hash-verified 0.1.10 source snapshot and changes only feature advertisement, FFOR peer negotiation and related regression tests. `licenses/native-source-0.1.11.json` identifies every source file used in the release build. The original base Git commit alone does not describe that snapshot.

## Qualified local inputs

- Native runtime source: `35b49a99bdff7edbe3c97dd5a605edf6e878ead4` in the local `chicory-primary-compatibility` LDK branch.
- Portable engine base: `67bc9cf0ba3e55fa1e1d7ad73e360bb04321a62c`.
- Corrected portable engine: `c9acc05f61899468f4eefd71d599d0de0bea9190` in the local `chicory-initial-commitment-fees` branch.
- Installed CommonJS bundle SHA256: `d1a173ff6eec2dabfaf315f81da4fec0e174950e881e2e37dce5b380000822c9`.
- Installed module bundle SHA256: `7b98cf137c21dd1b84f9c27175c13ce844be180ed7da7b883001579b39e94fae`.
- Chicory iOS scene correction: `2830fc7` in the local `chicory-ios-scene-lifecycle` branch.

For the existing development checkouts, run `scripts/chicory-install-local-engine.cjs` from the LDK branch with `--check` and your engine and Chicory paths, then run it without `--check` to install the verified local bundle. Follow that branch's `docs/chicory-ios-testing.md` for the phone build. Dependency reinstallations can replace the local bundle, so recheck it before rebuilding. The installer refuses unknown source or bundle hashes and preserves the original installed bundle.

Other users should wait for compatible client fixes or qualify their own build. An arbitrary App Store or upstream Chicory build is not implied to support every flow measured here.

## Upstream issue references

- [Beignet initial commitment fee selection](https://github.com/coreyphillips/beignet/issues/1873)
- [Beignet shared-input fee audit](https://github.com/coreyphillips/beignet/issues/359)
- [Beignet reconnect watchdog](https://github.com/coreyphillips/beignet/issues/1872)
- [Chicory iOS scene lifecycle](https://github.com/coreyphillips/chicory/issues/73)
- [Chicory dependency integration](https://github.com/coreyphillips/chicory/issues/75)

The Activity display can still show a gross JIT amount where the channel receives the net amount after the negotiated fee. This existing phone accounting issue is tracked in [Chicory issue 74](https://github.com/coreyphillips/chicory/issues/74). The primary retains the actual native balances and negotiated fees.
