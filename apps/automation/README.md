# Automation controller

`i7y-automation` is a Rust executor on the automation host. It accepts one bounded
JSON request over SSH stdin and returns JSON on stdout. It opens no network port.
The desktop never needs direct SSH access to managed servers.

Ansible remains the operational orchestrator. Rust validates requests and permissions,
binds reviewed plans, owns durable controller jobs and invokes fixed playbooks. Backup,
copying, provisioning, restoration and health checks belong to the playbook workflow;
there will not be a parallel Rust Docker orchestrator.

The current implementation includes operator/target allowlists, release-bound
plans, detached workers, a durable event journal, resource locks, bounded private
logs and status reconciliation. Desktop execution and the production copy recipe
are not enabled yet. Read [the release acceptance](../../docs/automation-review.md)
before installing it.

## Build and tests

```sh
cargo test --manifest-path apps/automation/Cargo.toml
cargo build --release --manifest-path apps/automation/Cargo.toml
node --test tests/automation-catalog.test.js
```

Build for the controller's actual Linux architecture and libc baseline. A macOS
binary cannot run there. The system Ansible/Python/Docker stack is legacy; install
a separate pinned runtime instead of upgrading it implicitly.

## Installation layout and trust boundary

```text
/etc/i7y/automation/
  config.json
  operators/<operator-id>.json
  releases/<release-id>/
    ansible.cfg
    inventory.yml
    targets/<inventory-target-id>.json
    recipes/
  operations/
    plans/
    jobs/<operation-id>/
    locks/
```

The executable, configuration, policies and releases must be administrator-owned
and not writable by SSH operators. Only `operations/` is writable by the executor;
it and its subdirectories must have mode 0700. Plans, journal entries and logs use
0600. Avoid shared filesystem mounts with weak locking or durability semantics.

Configure a distinct restricted SSH identity per operator, using an immutable
forced command such as `/usr/local/bin/i7y-automation --principal operator01`.
Disable forwarding, PTY and user startup files. Never invoke `$SSH_ORIGINAL_COMMAND`.
The operator identity is a server-side command argument, never part of the JSON
request. `--root` selects an installation for local tests or administrator-managed
instances; it must never come from the SSH client or UI.

Do not expose an unrestricted shared root key. An inventory editing role or an
agent API token does not grant operation access. The controller allowlist is an
independent SSH execution permission, bound to one backend and organization. Central
user permission synchronization and OS-backed desktop sessions remain release gates.

Example `config.json` (execution is opt-in):

```json
{"active_release":"release01","ansible_playbook":"/opt/i7y/runtime/bin/ansible-playbook","execution_enabled":false}
```

Example operator policy:

```json
{"backend":"https://inventory.example.com/","organization":"exampleorg","actions":["server.inspect"],"targets":["exampleserver"]}
```

Example server target mapping:

```json
{"host":"web01","kind":"server","backend":"https://inventory.example.com/","organization":"exampleorg"}
```

A project mapping additionally contains `source_domain` and `source_path`. A
container mapping contains its full 64-character `container_id`. Inventory aliases,
paths and runtime IDs are resolved by the controller, never supplied by the UI.
Policies contain explicit target and action IDs, without wildcard host patterns.

## Protocol version 1

Every request includes backend and organization context. A mismatch is denied
before handling the command. Unknown fields, arbitrary commands and unsupported
versions are rejected. The maximum request size is 16 KiB.

```json
{"version":1,"backend":"https://inventory.example.com/","organization":"exampleorg","request":{"command":"capabilities"}}
```

Plan a copy (requires an installed reviewed recipe and explicit operator permission):

```json
{"version":1,"backend":"https://inventory.example.com/","organization":"exampleorg","request":{"command":"plan","operation_id":"copy-example-001","operation":{"action":"project_copy","target":"exampleproject","destination_domain":"copy.example.com"}}}
```

The response contains a resolved plan and its `approval` hash. It includes the
operator, target, parameters, release ID and a digest of the entire release tree,
including inventory, target mappings, configuration and recipe dependencies stored
inside that tree. Symlinks and oversized release trees are rejected. The approval
expires after ten minutes. Repeating the same plan request preserves its identity
and expiry; changing its content requires a new operation ID.

After reviewing, send `request: {"command":"submit","operation_id":"copy-example-001","approval":"<hash>"}`
with the same version/backend/organization envelope. Submission persists the job
before launching a detached worker and returns promptly. A repeated submission
returns the existing job; it cannot launch another worker for that ID. Workers
recheck the active release and operator policy before invoking Ansible.

Use `request: {"command":"status","operation_id":"copy-example-001"}` to observe
`queued`, `running`, `succeeded`, `failed` or `interrupted`. Status access is limited
to the original operator. Status never launches or restarts a worker.

The journal stores immutable, ordered events. Linux worker identity includes boot
ID and process start time, not PID alone. A missing or replaced worker is reported
as interrupted without rewriting history. Unknown process observations are reported separately
and do not imply that a worker exited. Failed/interrupted mutation jobs retain locks
until an administrator inspects remote resources and reconciles them. A queued job
without progress is flagged for reconciliation after thirty seconds. There is no
automatic retry or rollback of a partially applied remote mutation.

The first implementation serializes mutations per host, with an additional destination
domain lock for copies. This prevents different project IDs from bypassing resource
conflicts. Read-only jobs do not reserve mutation resources. Successful jobs release
locks; status flags unfinished lock cleanup.

Ansible receives JSON parameters on stdin, a fixed recipe, explicit inventory and
one resolved host. Host-key checking is enabled. The worker clears inherited
process environment and sets its own Ansible config, PATH and HOME. Preserve the
full immutable release/runtime dependency closure: external mutable plugins,
inventory scripts or roles outside the release are not covered by its digest.

Raw output is drained but retained only up to 512 KiB per stream, in a private
controller log. No raw logs or secrets are returned to the desktop or central API.
Recipes must use `no_log` around credentials and database content. Process success
alone is not a substitute for remote health and backup verification.

## Read-only connectivity action

`server.ping` invokes the fixed `server-ping.yml` playbook using
`ansible.builtin.ping`. The controller resolves the server inventory ID, validates
the operator/backend/organization scope and proves the selection contains exactly
one host before running Ansible. The response contains only the target ID,
`reachable` and its timestamp, bound to the current backend and organization.
Neither Ansible output nor managed-server credentials are returned to the desktop.

Grant `server.ping` explicitly in the operator policy and install its recipe in the
active release. It works with `execution_enabled:false`; it does not enable any
mutating action. A failed module result reports `reachable:false`, while invalid
target scope, inventory selection or observation is rejected. The desktop Servers
table exposes **Actions → Ansible ping** with a dedicated result page and preserved
inventory return URL. The browser does not expose the action.

The default catalog stays disabled until an installation has configured the scoped
operator policy and recipe. Ansible ping checks SSH/module/Python connectivity,
rather than ICMP availability.

## Container lifecycle preflight

The start, stop and restart recipes are packaged but remain disabled in the default
catalog and desktop submission gate. Container mappings require a full immutable
Docker ID. Planning runs the read-only `container-preflight.yml` and records the
observed name, image, state and timestamp in the approved plan. Credentials and
container environment values are not collected.

Apply checks that state again immediately before mutation. Drift, missing
containers, paused/dead states and invalid IDs fail before mutation. Restart is
limited to running containers; start/stop are idempotent for supported states.
The resulting state is checked even if the Docker command exits successfully.
This confirms process state, not application health or data consistency.

Every recipe invocation first uses Ansible `--list-hosts` to prove the inventory
selector resolves exactly one expected host. Empty, multiple-host and ambiguous
selections fail closed. Reserved group selectors are not valid target aliases.
Read-only inspection is bounded to twenty seconds after host-selection validation.

## Copy recipe acceptance contract

Before enabling `project.copy`, the recipe must:

- Inspect Compose, bind mounts and named volumes; reject unsupported layouts and
  storage shared with another project.
- Resolve the destination under an approved root; reject existing paths, database
  names, Compose project names, domains and symlink escapes.
- Create and verify a logical database backup; preserve the source project.
- Copy application files/configuration and provision independent database storage
  and credentials; never recursively replace binary or database files.
- Restore into the new database and use serialization-aware WP-CLI URL replacement.
- Disable scheduled jobs, mail and payment integrations until explicitly reviewed.
- Validate Compose, start destination services and verify health and site URLs.
- Record created resources and preserve backups/failed copies for inspection.

There is no production copy recipe yet. Remote preflight evidence, recovery,
central permissions and the Tauri review/progress screens are still release gates.

### MySQL backup adapter

`recipes/files/mysql-backup.sh` runs inside the approved source database container.
It accepts no arguments and reads the database name and root credential from the
container environment. The password is passed through `MYSQL_PWD`, never a command
argument. Standard output is the SQL backup stream and must go directly to a private
backup file; it must not enter job logs or the API response. Any nonzero exit or
interrupted stream invalidates that file.

The initial adapter supports MySQL 5.7 with nonempty InnoDB-only schemas. It rejects
views, triggers, stored routines, events, MariaDB and other MySQL versions before
dumping. It uses a single transaction and does not stop the source database. Schema
changes must be excluded during backup: transactional dumps do not protect against
concurrent DDL. The orchestration must enforce this operating condition and verify
the completed backup before starting restoration.

The dump omits database creation/selection, allowing restoration into an independent
destination database. The destination provisioning, credential rotation and WordPress
updates still need orchestration; this script alone is not an executable copy action.

`copy_database` persists the stream as a mode-0600 partial file, waits for successful
completion, flushes it and computes its SHA-256 before publishing `database.sql`
without overwriting an existing backup. Restore rechecks the retained file handle,
rejects the source container ID and requires an empty destination schema. Failures
retain partial files for reconciliation. SQL and client errors are not sent to job
output. Timeouts stop the local Docker client; the orchestrator must reconcile the
remote exec before releasing operation locks or retrying.

```sh
python3 tests/mysql-backup.test.py
python3 tests/mysql-backup.integration.py
cargo test --manifest-path apps/automation/Cargo.toml --test copy_database -- --ignored
```

The integration test starts an isolated local MySQL 5.7 container without published
ports, restores binary fixture data into a second database, verifies source
preservation and tests rejection of unsupported schema objects. It removes only its
own disposable container. This does not validate the production installation.
The Rust integration test additionally uses two separate database containers to
exercise private persistence, hash verification, independent restoration and refusal
to restore twice into an already populated destination. It is opt-in because it
requires a local Docker daemon and the MySQL image.

### WordPress destination adapter

`wordpress-configure.sh` and `wordpress-finalize.sh` are destination-only phases.
They require the reviewed tools mounted read-only at `/opt/i7y/tools`, a private
writable operation directory at `/opt/i7y/state`, and the independent destination
database environment. The worker must resolve an immutable destination container ID
and prove it differs from the source before invoking either phase. These scripts are
not exposed as arbitrary commands through SSH or the desktop.

The tools include WP-CLI 2.12.0, pinned by URL and SHA-256 in `runtime-assets.json`.
Each phase verifies the PHAR before using it. WP-CLI runs from the controlled tools
directory with an empty global configuration and a restricted environment; copied
project `wp-cli.yml` files and installed CLI packages are not loaded.

Configuration validation parses constants without executing the copied config.
The initial adapter rejects multisite, custom content/plugin directories, database
drop-in layouts declared through `SUNRISE`, and missing standard database constants.
It moves existing must-use plugins and database/cache drop-ins into the private
operation quarantine before bootstrapping WordPress. It rewrites database constants
to the destination credentials, rotates authentication salts, disables cron,
automatic updates and WordPress HTTP requests, and installs a must-use mail/HTTP
guard. The originals remain in the copied files' backup and operation quarantine.

After restoration, finalization verifies that both site URLs match the selected
source domain and that every table has a primary key. WP-CLI would otherwise skip
tables without a primary key during replacement. It replaces URL authorities in one
serialization-aware pass, preserves GUIDs, normalizes copied site URLs to HTTPS,
disables active plugins and indexing, and removes the copied cron queue. Domains
that merely share a suffix are not replaced; a destination containing the source
name is not repeatedly rewritten. Original database options remain unchanged.

The copy remains a staging installation pending review. Network isolation is still
mandatory while preparing it: WordPress hooks do not block arbitrary PHP sockets or
direct cURL calls. Plugins, outbound integrations and scheduled work must only be
enabled after explicit review. A theme that depends on disabled plugins may require
adjustment before application health checks can pass. The controller pipeline and
desktop review must report that state rather than declaring a public site ready.

The disposable integration test uses WordPress 6.8.3 as a pinned fixture, not as a
recommended production upgrade. Fetch fixture assets into the ignored directory:

```sh
mkdir -p .local/artifacts/wordpress
curl --fail --location https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar --output .local/artifacts/wordpress/wp-cli-2.12.0.phar
curl --fail --location https://wordpress.org/wordpress-6.8.3.tar.gz --output .local/artifacts/wordpress/wordpress-6.8.3.tar.gz
python3 tests/wordpress-copy.integration.py
```

The test checks both asset hashes before execution, creates an internal Docker
network without published ports, verifies serialized values, GUID preservation,
source database preservation, plugin isolation, explicit mail/HTTP guards, and
rejection of modified tools, unsupported configuration and tables without primary
keys. It removes its own containers, network and temporary files.

See the upstream [config command](https://developer.wordpress.org/cli/commands/config/set/)
and [search-replace command](https://developer.wordpress.org/cli/commands/search-replace/)
for the WP-CLI behavior used by this adapter.

### Connected copy preparation

This Rust workflow is an isolated prototype and acceptance-test reference. It is not
connected to the controller or a production execution command. Its validated scripts
and test cases will support the Ansible copy playbook; the playbook, rather than this
prototype, will own operational sequencing and remote execution.

The internal `copy_workflow` library connects review, logical backup, file copying,
credential rotation, Compose replacement and database restoration. Review includes
a safe resource preview, the immutable source database ID, configuration and file
digests, and a ten-minute expiry. Its approval hash binds those values; authorization
still belongs to the controller policy and release-bound operation plan. This
library does not accept desktop requests directly.

Preparation requires a canonical source root, the initial adapter's
`app/docker-compose.yml` layout and a private executor-owned operation directory.
It checks the approved digests before reserving a unique operation ID. Each phase
is persisted before its side effects and each verified result receives a separate
immutable event. Events contain selected digests, byte counts and resource names;
SQL, credentials and the complete Compose configuration stay in private files.

Backup failure prevents file copying. Existing operation directories and copy
destinations are never reused automatically. The copied Compose file is replaced
with the generated independent configuration, owned by the executor with mode
0600; it does not retain source database credentials. A second private copy is
retained in the operation directory. The destination root remains mode 0700 until
the later provisioning/review phases deliberately publish it.

Restoration records its start before executing and can only run once per prepared
operation. Failure retains artifacts and requires reconciliation, including when
the underlying remote Docker exec may have survived a client timeout. No failure
triggers a retry or a second restoration.

The connected workflow passes a real two-container test using its generated
database name and credentials, binary fixture data and independent destination
writes. Process fixtures additionally cover stale review, source changes, backup
failure, journal redaction, private ownership and replay refusal. The remote
provisioner, live container/image/mount checks, WordPress phase connection, final
health checks and desktop review remain required before enabling the action.

## Recipe integration tests

`actions.json` maps every legacy routine to an explicit action. Packaged catalog
entries are disabled by default. Runtime capabilities enable only installed,
implemented recipes explicitly permitted by the operator policy and config.

The read-only and lifecycle recipes use fixed argv. Read-only recipes report no
changes and do not collect
container environment variables. Test the real Ansible modules on Linux:

```sh
docker run --rm \
  -v "$PWD/apps/automation/recipes:/recipes:ro" \
  -v "$PWD/tests/automation-recipes.integration.py:/test.py:ro" \
  python:3.12-slim sh -c \
  'pip install --quiet --root-user-action=ignore ansible-core==2.19.3 && python /test.py'
```

The Docker CLI fixture covers listing, preflight, lifecycle transitions,
idempotence, drift, missing containers and unsuccessful postconditions. This test harness is not evidence that the legacy controller or
all managed hosts support this Ansible version.

Installation inventories, credentials and legacy scripts stay in ignored `.local/`.
