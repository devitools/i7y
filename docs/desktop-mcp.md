# Desktop MCP

The desktop owns the authenticated API session, local approvals and SSH execution.
The bundled `i7y-mcp` executable translates newline-delimited MCP over stdio to a
private local socket. It never receives the backend session token. No HTTP port
or local inventory database is created.

## Enable and configure

On macOS, sign in to the desktop, select an organization, and open **Session menu
> Desktop integrations** (`#/desktop/mcp`). Enable local MCP and copy the generated
configuration into the MCP client's configuration. For Codex this is
`~/.codex/config.toml`. Use the generated absolute path for the actual installation:

```toml
[mcp_servers.i7y]
command = "/Applications/i7y.app/Contents/MacOS/i7y-mcp"
```

Keep the desktop process running. When a connection or action needs approval,
i7y automatically opens a separate foreground authorization window, even when
the main window is hidden. Review the client, signed-in account, organization and
action. For inventory queries, macOS authentication starts automatically as the
window appears: Touch ID itself is the consent, with no preliminary button click.
On macOS 12 and later, the biometric icon is a native `LAAuthenticationView`
inside the compact, undecorated request window. The context remains controlled by
LocalAuthentication; the application never receives biometric data. When embedded
biometrics are unavailable or locked out, the standard device-owner system prompt
remains the fallback. Older macOS versions use the standard prompt. Closing the
request through Cancel or Escape cancels the matching native authentication.
Changes and operations use the same compact, undecorated window, with an action
and target summary. The organization panel expands to show plain-language authorization details and
labeled change fields. The window grows when expanded, bounded by the display
work area. Raw parameters remain available under the optional **Technical details**
section. Only the content scrolls; the title and Cancel/Authorize controls remain
visible.
Choose **Authorize with Touch ID** after review to start native authentication.
The client receives `approval_required` immediately and polls `request_status`.
Closing the authorization window declines that request; it never grants access.
Requests are presented one at a time and dismissed after expiry, revocation,
disconnection, lock or a context change. Failed or cancelled system authentication
leaves access blocked. The header badge links directly to the oldest live request
in **Review requests**. Cancelled and completed requests belong to **History**.

Closing the main window while MCP is enabled hides it and keeps the local service
running. On macOS, click the Dock icon to reopen it. Quit/Command-Q terminates the
process and all connections; this does not install an auto-start login service.

 Client names are self-reported, not verified application identities.
Read access lasts five minutes from successful system authentication, scoped to
that connection. After expiry, the next data request returns `approval_required`
with a new request ID. Polling and repeated requests do not extend the grant.
Revocation, context change, disconnect or system lock ends access earlier. Each mutation requires a separate review and authentication. A badge in the
application header indicates pending requests.

MCP starts disabled. Its native channel accepts only same-user peers. Release
builds additionally require the connector at its bundled path with a valid code
signature from the desktop's signing team. Debug builds use a separate socket
and validate the executable path; they do not assert a release signature.
The connector also verifies the desktop server PID and expected sibling executable
path. Release connections require an Apple-anchored desktop signature with the
expected application identifier and the connector signing team; development
connections use a separate explicit path-only policy. Unsupported server identity
verification fails closed. Socket names also include the executable installation directory. Keychain accounts
are scoped by application identifier, build mode and backend, so review copies can
run without sharing a connection or session with the installed app.

No backend URL, password or API token is needed in the MCP configuration. Backend
connectivity, organization membership and current API permissions still apply.

## Tools

| Area | Tools |
| --- | --- |
| Connection | `connection_status`, `request_status` |
| Inventory | `list_workspaces`, `search_inventory`, `list_servers`, `get_server`, `list_projects`, `get_project`, `list_containers`, `get_container`, `list_images` |
| Telemetry | `get_resource_telemetry` |
| Rules | `list_alert_metrics`, `list_alert_rules`, `get_alert_rule`, `simulate_alert_rule`, `save_alert_rule`, `archive_alert_rule` |
| Incidents | `list_incidents`, `get_incident`, `create_incident`, `claim_incident`, `resolve_incident` |
| Operations | `automation_capabilities`, `inspect_resource`, `plan_operation`, `submit_operation`, `get_operation` |

Tool schemas reject unknown arguments and arbitrary filters, endpoints, commands
and playbooks. List tools accept at most 100 items per page. Image queries require
a workspace login. Inventory responses distinguish observation time from retrieval
time; missing observation timestamps indicate unknown freshness. Source text is
untrusted data. Credentials, environments and raw command logs are not returned.

For rule writes, pass `expected_version` using the rule's `edit_version`; pass zero
only when creating a new key. This is separate from the evaluation `revision`.
All rule edits, including name and cadence changes, advance `edit_version`.
Incidents retain their existing `version` precondition.

Mutations return `approval_required` and a `request_id` immediately. Poll
`request_status` for `executing`, `completed`, `denied`, `expired`, `cancelled`,
`approved`, `failed` or `unknown`. The short `approved` phase records successful
local authentication while central audit is pending; revocation or expiry still
cancels it before dispatch. Pending approval expires after five minutes or the earlier
controller-plan expiry. An approval is bound to the exact request and context.
There is no tool to approve it. After disconnecting or renewing the desktop
context, authorize the new connection and poll the original request ID. Recovery
is scoped to the same backend, organization and signed-in user; pending consent
is never transferred between connections. Backend write receipts are fetched
centrally for another connection. Operational request status includes its
`operation_id`; use `get_operation` to reconcile the durable controller job. A
late transport error cannot overwrite a previously reconciled success. No
mutation is automatically retried. Repeating the same approved backend write with its
request ID returns the stored receipt; changing its payload returns 409.

Manual incident resolution records a workflow decision. It does not establish
that the infrastructure recovered. A positive collector observation can create a
new occurrence under an enabled rule.

## Infrastructure setup

The desktop operations tab and MCP use the same native operation service. Configure
the existing automation-host profile with the pinned host key, public SSH identity
and 1Password agent. Only these six actions are connected:

- `server.inspect`, `server.disk`, `container.list`
- `container.start`, `container.stop`, `container.restart`

The controller's installed release, explicit operator allowlist and
`execution_enabled` switch continue to govern recipe availability. Central grants
are an additional requirement, not a replacement for the controller policy.

Deploy backend hooks and migrations together. An organization administrator can
provision an explicit grant with a human session:

```http
PUT /api/i7y/operations/v1/grants
X-I7y-Organization: ORGANIZATION_ID
Authorization: Bearer HUMAN_SESSION
Content-Type: application/json

{"user":"USER_RECORD_ID","action":"container.restart","target":"CONTAINER_ID","enabled":true}
```

Repeat with `enabled:false` to revoke it. No inventory role automatically grants
operation access. Users must remain organization members, and targets must belong
to that organization.

Provision a controller credential:

```http
POST /api/i7y/operations/v1/controllers
X-I7y-Organization: ORGANIZATION_ID
Authorization: Bearer HUMAN_SESSION
Content-Type: application/json

{"principal":"operator01"}
```

The response returns an ID and a secret once. Install that secret in a root-owned
0600 file on the controller. Set `central_authorization_key_file` in the
administrator-owned controller config to its absolute path. The controller needs
outbound trusted HTTPS access to its configured backend. Credential revocation is
available through trusted backend administration by disabling its controller
record; it must not be exposed to agent tools.

The desktop checks `POST /api/i7y/operations/v1/check` before planning, then obtains
a 60-second, single-use ticket from `/tickets` after review. The controller redeems
it through `/consume`, binding the principal, operation ID, target, action and
reviewed-plan hash. Redemption rechecks current membership and grants. Configuring
central authorization also disables legacy ticketless controller submission.

The controller retains durable jobs, immutable release checks, per-host locks and
replay prevention. Inspect `get_operation` after a transport interruption. Never
retry an ambiguous mutation with a new operation ID. Inspections persist bounded,
structured evidence separately from private command logs. The complete
controller response, including its newline, is bounded to 65,536 bytes. When
inspection evidence is missing, invalid or too large, durable job state remains
available with explicit `inspection_evidence` omission metadata. The SSH layer
rejects oversized frames instead of parsing silently truncated JSON. Future actions remain
subject to their own implementation and acceptance gates.

SSH key use may independently prompt in 1Password. The desktop's system prompt
authorizes the i7y operation; the 1Password prompt authorizes use of an SSH identity.

## Native sessions and platform support

On macOS, backend sessions are persisted in Keychain and kept in native memory.
The frontend receives a nonfunctional session marker carrying expiry metadata,
not the backend credential. Legacy web-storage sessions are validated through
`auth-refresh` before migration, and removed only after successful restoration.
Browser-only authentication remains unchanged. The desktop broker classifies
authentication using decoded segments of the validated endpoint path, including
encoded routes and collection aliases. Authentication response envelopes are
persisted/redacted natively; unexpected session envelopes fail closed before
returning to the renderer. Explicit inventory API-token responses retain their
existing UI contract.

`LocalAuthorizer` and `SecretStore` are platform boundaries. macOS uses
LocalAuthentication with device-owner authentication, including Touch ID and the
system's available fallback methods. Unsupported authorizers fail closed.
Outside macOS, sessions remain in native memory only and require sign-in after
restarting the app. Windows Hello, Windows named-pipe peer verification and secure
session persistence are follow-up adapters; Windows MCP is explicitly disabled until those pass native
validation. No biometric approval is simulated on unsupported systems.

## Build and verification

`npm run desktop:dev` and `npm run build:desktop -- --debug --no-bundle` build the
connector first. Tauri packages it as an external binary. For signed distribution,
configure the signing identity and sign the app and bundled executable together;
there is no signing identity embedded in source. Supply `APPLE_SIGNING_IDENTITY`
from a valid local Apple signing identity when building an app that persists a
Keychain session, including local debug bundles. Keep that identity and bundle ID
stable across updates. For this checkout, an ignored `.local/desktop-signing.json`
file containing `{"identity":"<Apple signing identity>"}` supplies the default to
the desktop build wrapper; `APPLE_SIGNING_IDENTITY` overrides it. No private key
or password belongs in this file. Ad-hoc linker signatures change with each binary and can
trigger repeated Keychain access prompts. Existing items created by an ad-hoc
build may need one system-mediated trust approval or a fresh browser sign-in when
migrating to a signed build. Do not weaken the item ACL or grant all apps access.
The Keychain session prompt is distinct from the five-minute MCP read grant.
Each MCP renewal uses a fresh LocalAuthentication context with biometric reuse
explicitly disabled; the application implements the five-minute grant itself.

```sh
cargo test --manifest-path apps/desktop/mcp/Cargo.toml
cargo test --manifest-path apps/desktop/core/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/automation/Cargo.toml
npm test
npm run typecheck
npm run build:desktop -- --debug --no-bundle
```

The HTTP integration test starts and removes its own disposable Docker backend;
provide a compatible Linux ARM64/AMD64 PocketBase binary for the Docker host:

```sh
I7Y_TEST_POCKETBASE_BINARY=/absolute/path/to/pocketbase python3 tests/desktop-mcp.integration.py
```

Before enabling production recipes, validate actual Touch ID cancellation and
approval, Keychain persistence, lock/reconnect, signed peer identity, the real
1Password SSH connection and a disposable server/container pilot. A local build or
isolated recipe test does not establish production readiness. No production
controller is changed by building or testing the integration.
