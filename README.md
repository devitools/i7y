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

Install [Volta](https://volta.sh) and Docker Compose. Node and npm versions are pinned in the root `package.json`; Volta selects them automatically when you run commands in this repository.

```sh
npm ci
docker compose up -d
npm run dev
```

Compose starts **only PocketBase**, available at `http://127.0.0.1:8097`. It mounts the backend hooks and migrations read-only, watches hooks for local development and keeps the database and cached PocketBase binary in named volumes. First startup downloads and verifies PocketBase 0.40.4. Subsequent startups reuse the cached binary. No frontend, Node installation or application image build runs in Compose.

Vite runs directly on the host at `http://127.0.0.1:5177`, with hot reload and an API proxy to PocketBase. Open this URL to use the frontend. PocketBase's loopback port also exposes its administrative UI for trusted local setup. The web workspace uses the same Volta versions as the root.

```sh
npm test
npm run typecheck
npm run build:web
npm run backend:logs
npm run backend:down
```

`npm start` and `npm stop` are aliases for starting and stopping the local backend. `docker compose down` preserves data; do not add `--volumes` unless you intend to delete the local database.

The frontend uses TypeScript, including Vue script blocks and Vite configuration. Every web build runs vue-tsc first. Tests remain JavaScript and use tsx to import TypeScript modules. PocketBase hooks and migrations remain JavaScript. Type checking preserves existing dynamic API boundaries; strict mode is not enabled yet.

The web workspace owns frontend dependencies; the root npm workspace owns the shared lockfile. Go and Rust keep their own toolchains. A new database starts without infrastructure inventory. See [authentication](docs/api-auth.md) to create the first user through trusted local administration. Existing database contents are preserved.

`VITE_POCKETBASE_URL` configures the frontend API endpoint at build time and defaults to the same origin. The development proxy targets port 8097. If you override `INVENTORY_PORT`, also configure `VITE_POCKETBASE_URL` for that backend. The optional backend `INVENTORY_FILE` enables an explicitly mounted private legacy import; normal operation does not require it.

## Production image

The single root `Dockerfile` builds the frontend in a Node stage, then copies static assets, hooks and migrations into a PocketBase runtime image. Node and npm are not included in the runtime. PocketBase is downloaded and checksum-verified during the image build, with amd64 and arm64 support; startup requires no downloads.

```sh
docker build -t i7y:VERSION .
```

A single `.dockerignore` allowlists required sources and excludes `.local/`, dependencies, generated builds and private files. A prior host frontend build is not required.

Configure `I7Y_DOMAIN` and `I7Y_VERSION` for `deploy/compose.production.yaml`. This production template uses the built image and an external reverse proxy; it is separate from the local development Compose. Its `data` bind mount is relative to the Compose file, so preserve the existing deployment's data mount when upgrading. Building an image does not deploy it.

## Collector

```sh
cd apps/agent
go test ./...
./build.sh
```

See [container API](docs/containers-api.md), [telemetry](docs/telemetry.md) and [agent installation](docs/install-agent.en.md).

## Local-only material

Keep credentials, actual inventory, migration rehearsals, deployment records, backups and installation-specific scripts under `.local/`. This directory is ignored by Git and excluded from Docker build contexts. Do not place private material in source, fixtures or documentation. No local-only files are required to build the product.

See [third-party notices](THIRD_PARTY.md).
