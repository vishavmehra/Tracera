FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production dependencies of the server and contracts workspaces only; the web app, the extension,
# and the dev tooling stay out of the image. Manifests first so a source-only change reuses the layer.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --omit=dev --ignore-scripts --workspace @tracera/server --workspace @tracera/contracts \
	&& npm cache clean --force

COPY apps/server apps/server
COPY packages/contracts packages/contracts
COPY scripts/start.ts scripts/preflight.ts scripts/bench-setup.ts scripts/
# Demo repositories (TRACERA_DEMO_REPOS): the fixture sources and the manifest that builds their history.
COPY fixtures fixtures
COPY eval/bench-shop/manifest.json eval/bench-shop/manifest.json
# Pinned certificate authority for a Supabase database (sslrootcert=/app/certs/...).
COPY certs certs
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/tracera-entrypoint

ENV NODE_ENV=production \
	TRACERA_API_HOST=0.0.0.0 \
	TRACERA_API_PORT=10000

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
	CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.TRACERA_API_PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Starts as root only so the entrypoint can fix ownership of the data directory; it then runs the
# supervisor as the node user.
ENTRYPOINT ["/usr/local/bin/tracera-entrypoint"]
CMD ["node", "scripts/start.ts"]
