# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM rust:1.90-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f AS native-build
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu gcc-x86-64-linux-gnu libc6-dev-arm64-cross libc6-dev-amd64-cross && rm -rf /var/lib/apt/lists/*
RUN rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
COPY --from=native / /source/
WORKDIR /source/tools/ldk-node-daemon
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_x86_64_unknown_linux_gnu=x86_64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CARGO_BUILD_JOBS=2
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/source/tools/ldk-node-daemon/target \
    case "$TARGETARCH" in amd64) native_target=x86_64-unknown-linux-gnu ;; arm64) native_target=aarch64-unknown-linux-gnu ;; *) exit 1 ;; esac && \
    cargo build --locked --release --target "$native_target" && \
    install -Dm755 "target/$native_target/release/ldk-node-daemon" /out/ldk-node-daemon

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates gosu util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/ldk/manager
COPY manager/package.json manager/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY iroh/package.json iroh/package-lock.json /opt/ldk/iroh/
WORKDIR /opt/ldk/iroh
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=native /tools/chicory-iroh/bridge.cjs ./bridge.cjs
COPY --from=native /LICENSE* /opt/ldk/licenses/
COPY --from=native-build /out/ldk-node-daemon /opt/ldk/bin/ldk-node-daemon
COPY manager/server /opt/ldk/manager/server/
COPY manager/public /opt/ldk/manager/public/
COPY LICENSE /opt/ldk/manager/LICENSE
COPY licenses/ /opt/ldk/licenses/third-party/
LABEL org.opencontainers.image.source="https://github.com/coreyphillips/ldk-node-umbrel" \
      org.opencontainers.image.title="LDK Node for Umbrel" \
      org.opencontainers.image.version="0.1.2"
COPY docker/entrypoint.sh /usr/local/bin/ldk-entrypoint
RUN chmod 755 /usr/local/bin/ldk-entrypoint
ENV NODE_ENV=production DATA_DIR=/data BIND_ADDRESS=0.0.0.0 PORT=3000 \
    LDK_NODE_BIN=/opt/ldk/bin/ldk-node-daemon IROH_BRIDGE=/opt/ldk/iroh/bridge.cjs
EXPOSE 3000 9735-9742
VOLUME ["/data"]
WORKDIR /opt/ldk/manager
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/ldk-entrypoint"]
