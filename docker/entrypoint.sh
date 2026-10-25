#!/bin/sh
set -eu
umask 077
mkdir -p "$DATA_DIR/wallets"
chown -R 1000:1000 "$DATA_DIR"
chmod 700 "$DATA_DIR" "$DATA_DIR/wallets"
exec flock -n -F "$DATA_DIR/.manager.lock" gosu 1000:1000 node /opt/ldk/manager/server/index.mjs
