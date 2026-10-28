# i7y

Authenticated infrastructure inventory and telemetry, built with Vue, Quasar, PocketBase and a Go collector.

## Repository

- `apps/web`: Vue/Quasar interface, built with Vite.
- `apps/backend`: PocketBase hooks and database migrations.
- `apps/agent`: Linux and Windows telemetry collectors.
- `apps/desktop`: reserved for Tauri/Rust, sharing the web interface.
- `apps/automation`: reserved for SSH-controlled automation.
- `deploy`: deployment templates for the product.
- `docs`: API and installation documentation.
- `scripts`: generic repository utilities.
- `tests`: cross-application and frontend tests.

## Development

Use Node.js 22 or newer and Docker Compose. From the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build:web
npm start
npm run dev
```

PocketBase serves the application at `http://127.0.0.1:8097`. Vite serves development assets at `http://127.0.0.1:5177` and proxies API requests to PocketBase. The frontend uses TypeScript, including Vue script blocks and Vite configuration. `npm run typecheck` checks the frontend with vue-tsc, and every web build runs that check first. Tests remain JavaScript and use tsx to import the TypeScript modules. PocketBase hooks and migrations remain JavaScript. Type checking is enabled with the existing dynamic API boundaries preserved; strict mode is not enabled yet.

The web workspace owns frontend dependencies; the root npm workspace owns the shared lockfile. Go and Rust keep their own toolchains.

A new database starts without infrastructure inventory. Create the first user through trusted local administration; see [authentication](docs/api-auth.md). The initial organization is named `Initial organization`. Existing databases keep their organization names and memberships.

`VITE_POCKETBASE_URL` can configure the frontend API endpoint at build time; its default is the same origin. The optional backend `INVENTORY_FILE` enables a legacy JSON import and must reference a private, explicitly mounted file. It is not required for normal operation.

## Builds and deployment

```sh
docker compose build
cd apps/agent
go test ./...
./build.sh
```

For the production runtime image, run `npm run build:web` followed by `docker build -f Dockerfile.production -t i7y:VERSION .`. Configure `I7Y_DOMAIN` and `I7Y_VERSION` for `deploy/compose.production.yaml`. Its `data` bind mount is relative to the Compose file; preserve the existing deployment's data mount when upgrading. No deployment is performed by a build.

See [container API](docs/containers-api.md), [telemetry](docs/telemetry.md) and [agent installation](docs/install-agent.en.md).

## Local-only material

Keep credentials, actual inventory, migration rehearsals, deployment records, backups and installation-specific scripts under `.local/`. This directory is ignored by Git and excluded from Docker build contexts. Do not place private material in source, fixtures or documentation. No local-only files are required to build the product.

See [third-party notices](THIRD_PARTY.md).
