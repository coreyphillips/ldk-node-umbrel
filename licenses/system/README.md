# Runtime base notices and sources

The runtime uses the pinned official Docker Node 24.22.1 Debian 12 bookworm slim image identified in `node-source.json`. The final image also installs ca-certificates, gosu and util-linux with Debian apt.

`debian-packages.json` inventories the actual binary and corresponding source package versions installed in each qualified architecture image. Binary rebuild suffixes are distinguished from source versions. Each entry provides the exact-version Debian Snapshot source-download page and the Debian Sources browser. The Snapshot page exposes the original upstream tarball, Debian patch archive and .dsc source description for that version. These collectively form the corresponding Debian source package.

On a Debian system with the matching source repositories enabled, an exact source can also be retrieved with `apt-get source source-package=source-version`, using the recorded values. Use Debian Snapshot for versions no longer available in the current apt repository. The source packages retain their build instructions and packaging files. The installed copyright files describe each component's applicable license and upstream copyright notices.

`usr/share/doc/` contains copies of the runtime's installed Debian copyright files, including the gosu and util-linux notices. The originals remain at the same paths inside the image. This bundle uses the ARM64 image copies because corresponding source versions agree across the two package inventories; the architecture-specific binary versions remain recorded.

`usr/local/LICENSE` is the original Node runtime license and its bundled dependency attributions. It remains at /usr/local/LICENSE inside the runtime image. `node-source.json` links the exact official Node source archive and records its SHA-256 from the official release checksum list. The official Node Docker packaging is maintained at https://github.com/nodejs/docker-node.

These source references concern unmodified upstream Node and Debian components. They do not claim that the local modified LDK fork has been published. The notices for Rust packages and their exact MPL source archives are in the parent directory.
