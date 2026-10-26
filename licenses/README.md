# Third-party notices and source availability

This bundle accompanies the LDK Node Umbrel runtime images. The dashboard manager has its own MIT license. The root LDK licenses are retained separately in the image. These records preserve third-party licenses and copyright notices for the native LDK daemon and the optional Iroh native addon.

`package-manifest.json` lists each selected Rust package version, declared license, upstream repository, available source revision, published source archive URL and SHA-256, and copied notice files. Registry source archive hashes were verified against the corresponding locked Cargo dependency checksum. Local modified LDK packages are identified separately by the qualified native runtime commit; they are not represented as unchanged published crates.

The manifest covers the union of normal and build dependency graphs resolved for both x86_64-unknown-linux-gnu and aarch64-unknown-linux-gnu. Development-only and other-platform dependencies are excluded. Build-time notices are conservatively retained, so an entry is not a claim that every listed package is linked into the final executable.

The Iroh graph uses the exact source revision reported by npm for @number0/iroh 1.1.0 and both installed GNU Linux architecture packages. Package integrity values and the source archive hash appear in `iroh/`. The Iroh packages omit license files from their npm tarballs; the original MIT and Apache texts from that exact source revision are included here.

`beignet-ffor/LICENSE-BEIGNET` is the unmodified MIT notice for the Beignet-derived FFOR code, copyright 2023 Synonym. It is additional to the LDK licenses.

Where an upstream crate omits repository license text, the manifest records the pinned repository license retrieval or a canonical SPDX license text matching the published declaration. The original available source copyright comments and declared package authors remain associated with each entry. Standard alternative-license expressions continue to offer their stated choices.

The Node runtime, Debian base packages and dashboard npm dependencies retain their license notices in their usual installed locations. The base image package copyright notices are under /usr/share/doc. Dashboard npm notices remain alongside their packages in /opt/ldk/manager/node_modules.

The new BIP39 dependencies are pinned in the manager lockfile. Their MIT notices and npm source integrity records are also copied under `manager/` in this bundle.

## MPL source availability

The unmodified Source Code Form for every MPL-2.0 package in the selected dependency graphs is included in `sources/` as its exact original published .crate archive. These are gzip-compressed tar archives and can be extracted with tar. The full MPL license is present with the corresponding package notices. Recipients may obtain, use, modify and redistribute these source files under MPL-2.0. No additional restriction is imposed on that source by the dashboard license or image delivery.

- attohttpc 0.30.1: `sources/attohttpc-0.30.1.crate`. Upstream source: https://static.crates.io/crates/attohttpc/attohttpc-0.30.1.crate. SHA-256: `16e2cdb6d5ed835199484bb92bb8b3edd526effe995c61732580439c1a67e2e9`.
- webpki-roots 0.25.4: `sources/webpki-roots-0.25.4.crate`. Upstream source: https://static.crates.io/crates/webpki-roots/webpki-roots-0.25.4.crate. SHA-256: `5f20c57d8d7db6d3b86154206ae5d8fba62dd39573114de97c2cb0578251f8e1`.

All files in this bundle are identified by SHA-256 in SHA256SUMS. That checksum file does not list itself.
