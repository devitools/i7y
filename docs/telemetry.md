# Telemetry

The Go agent observes Docker and Linux host resources and sends a full snapshot immediately on startup and every 300 seconds. It also listens to the Docker Engine container event stream over the Unix socket. Lifecycle and health changes trigger a lightweight reconciliation after a two-second debounce; unrelated exec events are ignored. Reconnecting the stream always triggers reconciliation, recovering missed events even when the Docker event buffer no longer contains them. Events received during a full collection are reconciled immediately after it finishes. Full container metrics use at most eight concurrent requests; event reconciliations skip those requests and preserve existing metrics only for the same running Docker container ID. Normal delivery retry backoff still applies while the API is unavailable. It never executes Compose files or changes application containers. Docker socket access is privileged; restrict the agent binary and configuration accordingly.

Project paths use the directory of the Compose configuration file recorded by Docker; its filename and directory name do not need to follow a fixed convention. Compose working-directory metadata is the next fallback. Without those metadata, bind mounts are matched to the nearest unambiguous registered or discovered project directory. Containers using only named volumes inherit a verified path from another container with the same Compose project only when that group identifies one physical project directory. Named-volume storage paths are never treated as application directories. No manually added labels are required.

## Build and install

Use Go 1.27.3 (the module pins this toolchain):

```sh
cd apps/agent
go test -race ./...
./build.sh
```

Artifacts are Linux amd64 and arm64 executables plus `dist/SHA256SUMS`. No Go runtime or libc installation is needed on the target. Verify the artifact checksum before installation. The pilot must confirm compatibility with the target kernel and Docker API.

Create an agent credential in the Telemetry page after choosing a registered server. Creating another credential rotates the previous one immediately. Each secret only reads its own server's discovery configuration and submits snapshots for that server; it cannot access the management API. The backend retains its SHA-256 hash only.

Example configuration (replace the fictional URL and credential):

```json
{
  "url": "https://inventory.example.com",
  "token": "i7ya_REPLACE_WITH_SERVER_CREDENTIAL",
  "roots": ["/usr/share/tevun/projects", "/usr/share/tevun"],
  "docker_socket": "/var/run/docker.sock",
  "state_dir": "/var/lib/i7y-agent"
}
```

Save with mode 0600 and install as root:

```sh
apps/agent/deploy/install.sh apps/agent/dist/i7y-agent-linux-amd64 /secure/config.json apps/agent/deploy/i7y-agent.service
systemctl status i7y-agent
journalctl -u i7y-agent
```

The dedicated user needs read and traversal permissions on configured project paths. Docker group membership grants Docker access; no application directories need write permission. Configure physical discovery roots verified with `readlink -e` on the server. The agent resolves symlinks before reporting project paths and deduplicates equivalent paths. Existing project IDs are retained as discovery keys so the backend updates the path without creating another project or changing container associations. Container associations already registered are preserved when the canonical Compose directory is inside that project, including an `app` subdirectory. New containers use the nearest unambiguous registered parent; infrastructure directories containing an entire discovery root do not absorb unrelated projects. Project paths identify the directory containing the Compose file. Filesystem discovery uses the directory of each Compose file it finds and stops below that directory to avoid nested templates. A newly discovered directory is reported only when a Docker container references it; existing registered projects are retained. An existing parent path is updated only when a single Compose directory is found beneath it; multiple directories are not guessed. Infrastructure Compose directories retain their actual location. Registered infrastructure roots are treated as individual projects.

`i7y-agent -diagnose` checks API authentication and Docker without submitting data. `-once` collects and sends once, returning a failure if delivery fails. Both accept `-config PATH`; configuration secrets never belong in command arguments. The queue is limited to 288 snapshots/24 hours. Retries back off from 10 seconds to five minutes and retain snapshot IDs, preventing duplicate history. Only one process per state directory can run.

For upgrades, verify the checksum, atomically replace the binary and restart the service. Preserve the previous binary for rollback. Uninstall with `apps/agent/deploy/uninstall.sh`; configuration and queued data are preserved for explicit removal by the operator.

## Protocol

- `GET /api/i7y/telemetry/v1/config`: bearer agent credential; registered project paths and container-to-project hints for its server.
- `POST /api/i7y/telemetry/v1/snapshots`: bearer agent credential; protocol version 1, `sample_id`, `observed_at`, `agent_version`, `host`, `docker_complete`, `discovery_complete`, `projects`, `containers`, `errors`. Maximum body size: 4 MiB. A server ID in the body never controls attribution.
- `GET/POST /api/i7y/agents` and `DELETE /api/i7y/agents/{id}`: authenticated user session; list metadata, create/rotate and revoke credentials.
- `GET /api/collections/telemetry_samples/records`: authenticated user session; standard PocketBase pagination/filtering by server and observation time.

Each successful observation updates the inventory container’s `image` from Docker’s configured image reference and stores the running image ID in telemetry. After recreating a container with a new image, wait for the next collection (up to five minutes); a separate management API PATCH is unnecessary on hosts running the agent. The current state lives in `telemetry`/`last_seen` on inventory records. Historical snapshots live in `telemetry_samples`, indexed by server/time and server/sample ID. Repeated snapshots are acknowledged without duplication; late observations never replace newer current state. A daily cleanup removes observations older than 30 days. Regular management API tokens do not gain access to telemetry or agent credential management.

Compose one-off containers (`com.docker.compose.oneoff=true`) and containers explicitly labeled `i7y.ignore=true` are excluded from discovery. Compose recreation names are normalized only when the prefix matches that container's own short Docker ID and Compose project/service labels are present. If the replacement already has the canonical name, only the replacement is reported. Registered container IDs and project associations are preserved. The image catalog counts current usage and excludes missing/removed records.

The container list shows state and excludes `missing`/removed records by default, with a Show removed containers toggle. Filtering occurs on the server before pagination. Visible container and image-usage pages refresh every ten seconds. Removed records retain their identity and history; a container recreated with the same name updates the existing record.

A full successful Docker listing can mark missing containers; an inspection/listing failure cannot. Project absence also requires successful filesystem discovery. Ambiguous matches are reported instead of moving or merging existing records. Provider status remains separate. The UI marks observations older than 15 minutes as no communication, displaying the last known condition. A running container without a healthcheck does not prove the application responds over HTTP.

CPU is sampled usage; container CPU can exceed 100% on multicore hosts. Memory excludes reclaimable inactive file cache when Docker reports it. Null metrics mean unavailable. Filesystem metrics cover distinct local `/dev` filesystems. Environment variables, application logs, file contents and credentials are not collected.

## Deployment and recovery

Build the production image, including the frontend, then transfer it privately to the host:

```sh
docker build --platform linux/amd64 -t i7y:VERSION .
```

`deploy/compose.production.yaml` supports Compose 1.24 and the existing external `reverse-proxy` network. Set `I7Y_DOMAIN` in the deployment host's private `.env`. The app binds its direct port to loopback. Install `deploy/proxy-vhost.conf` as the domain-specific nginx-proxy vhost include and validate nginx before reloading. Administrative APIs and the admin UI are blocked at the public proxy; use an SSH tunnel to loopback for maintenance.

Migrate the existing data directory using a consistent backup or while the source process is stopped. Preserve IDs, user hashes, token hashes, storage and initialization markers. Never run inventory sync during migration. Validate counts and relationships, then make the new instance authoritative. Keep the source stopped to avoid diverging writes.


Before migrations, take a consistent backup and retain the previously loaded image ID. For rollback stop the new app, preserve its data separately, restore the pre-migration data directory and run the previous image. Do not run older application code against an upgraded database without restoring the compatible backup.

## Servers without Docker

Set `"mode": "host"` in the agent configuration to collect CPU, memory, uptime, load and each local disk every five minutes. Docker remains the default mode. Host mode does not connect to Docker, scan project directories, listen for Docker events or change inventory records. Its reports explicitly identify the mode so missing Docker is not treated as a collection failure.

Install with the host service unit, which does not require the Docker group:

```sh
apps/agent/deploy/install.sh apps/agent/dist/i7y-agent-linux-amd64 /secure/config.json apps/agent/deploy/i7y-agent-host.service host
```

Use the server's dedicated agent credential and HTTPS endpoint as usual. Service monitoring is not included in this mode.

## Windows host collector

`apps/agent/cmd/i7y-host-windows` builds a Windows amd64 collector using native Windows APIs. It collects CPU, physical memory, uptime and fixed local disks without Docker, PowerShell at collection time or changes to applications. It uses the same host-only protocol, dedicated credential and 24-hour delivery queue as the Linux host mode.

The reviewed installer is `apps/agent/deploy/install-host-windows.ps1`. It requires elevation for installation and registers a five-minute task plus a startup trigger. The collector runs as the built-in Local Service account, not as the interactive user or SYSTEM. Directory ACLs keep the executable and configuration writable only by administrators and SYSTEM; Local Service can write only its queue directory. It does not change execution policy, WinRM access, firewall rules or OS credentials. Existing tasks/directories cause installation to stop for reconciliation.


Host reports include `host.operating_system` with family, distribution/product name, version, kernel/build and agent architecture. Linux reads os-release as data without executing it, and reads the kernel release from procfs. Windows reads product metadata from the local machine registry and the actual kernel version from RtlGetVersion. Older reports without these fields remain supported.

Windows session presence is limited to `host.rdp_session_active` (true, false, or null when unknown) and the existing `observed_at` timestamp. The collector queries session connection state and protocol only, never username, client address, session timestamps, applications or event logs. Session IDs used internally by the Windows API are not serialized. Disconnected sessions and local console sessions do not count as active RDP. A five-minute observation is not an exact login time or proof of human activity.

### Last RDP access

Windows agent 0.1.11 adds `host.last_rdp_access_at`: the UTC timestamp of the latest remote login or reconnection found in the `Microsoft-Windows-TerminalServices-LocalSessionManager/Operational` channel (events 21/25, excluding local addresses). The query times out after eight seconds and does not transmit usernames or client addresses. Unavailable logs, missing events or insufficient permissions produce `null`; they do not mean the VM has never been accessed.

The list shows complete days since that event, or an active session when the current collection confirms an RDP connection. Stale telemetry does not confirm an absence of access. Older agents show unknown information until upgraded. The count depends on Windows event retention and does not measure application usage.
