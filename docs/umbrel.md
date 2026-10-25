# Umbrel package details

`ldk-node-wallet/umbrel-app.yml` and `docker-compose.yml` use the community app structure. The app ID is `ldk-node-wallet`; its manager listens internally on 3000 and the app proxy exposes the dashboard on 2114. The package has no registry image or public store URL.

The local Compose flow in the main README is the tested installation entry point. It uses a generated password and can run beside existing Umbrel apps. It does not automatically appear in the Umbrel app launcher. Do not add an invented store URL to Umbrel.

For an Umbrel app-manifest integration test, first load the exported archive, using `scripts/load-local.sh`. The loader tags the host architecture as `ldk-node-umbrel:0.1.0`, which the app compose file uses. `pull_policy: never` prevents fetching an unrelated registry image. Use your Umbrel version's supported local app-development workflow, with this directory as source. The standard app proxy must remain in front of the manager.

Umbrel authentication is based on the socket source of the actual app proxy, resolved from the app-scoped container names. It denies requests while DNS is unavailable. Forwarded headers do not grant access. Manager port 3000 must not be published in this mode. The app's network must allow the proxy's DNS name to resolve; configure `APP_PROXY_HOST` if your Umbrel version uses a different exact container name. Configure `ALLOWED_HOSTS` for the hostname actually sent by the proxy.

The package uses no Docker socket and cannot create arbitrary containers. Each wallet is a child process inside the manager container with a private storage directory and distinct native TCP port. The manager runs as UID/GID1000 after the entrypoint prepares the owned volume. Its process lock prevents a second manager from using the same volume; the native daemon independently locks each wallet.

The manifests use [Umbrel's community app-store structure](https://github.com/getumbrel/umbrel-community-app-store). The local Compose alternative follows [Umbrel's custom-container guidance](https://umbrel.com/support/apps/running-custom-docker-containers). No live Umbrel host was modified during development.
