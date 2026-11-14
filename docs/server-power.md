# Manual VM power and encrypted boot

An incident's **View server** action opens the server telemetry page. **Power and
disk** offers **Start server**, **Shut down server**, **Check SNEL status** and the provider
console. The server inventory action menu reaches the same page. These actions are
operator initiated; no no-communication trigger or unattended vault access is added.

This is a fixed desktop action in `apps/automation/desktop/actions.json`, alongside
the existing SSH/Ansible actions. Power control uses the SNEL User API because the
guest's ordinary SSH and Ansible are unavailable before its encrypted root mounts.
The initial native adapter supports macOS with Python 3, OpenSSH and 1Password CLI.
It uses the signed desktop's current backend, organization and user session.

## Configuration

Install the backend migration and hooks with the matching web and desktop release.
An administrator links a credential reference in **Edit server**. The workspace
has an independent reference to its provider login item. References use a generic
versioned shape; the `vault` field identifies the secret manager:

```json
{"version":2,"vault":"1password","account":"Disk Ninja","item":"SNEL VPN VPS Server"}
```

`options.vault` optionally selects a vault inside the 1Password
adapter. It preserves the meaning of the old unversioned `vault` field. For example,
`{"vault":"Infrastructure","item":"VPN"}` normalizes to
`{"version":2,"vault":"1password","account":"","item":"VPN","options":{"vault":"Infrastructure"}}`.
Only explicit version 2 is canonical; an unversioned reference remains legacy even
if its physical vault was named `1password`. Unknown versions are rejected. Reading
or validating an existing record never rewrites it. Editing can save its equivalent
canonical reference without changing its identity.

The reference stores metadata, not passwords, tokens or private keys. Manager IDs
are generic; 1Password is the currently implemented adapter. Unknown managers fail
with `vault_unsupported` before executable discovery, provider access or any CLI.
The Python adapter lives in `i7y_vault.py` and the desktop embeds that module in its
isolated runner, so it does not depend on the working directory or temporary files.
Accounts, items and adapter options are resolved independently for server/workspace.
An empty legacy account uses the adapter's default account.
An explicit sign-in address or ID is passed unchanged to `op --account`, without
listing accounts first or falling back to a different account. Friendly display
names still require verified, unambiguous account discovery before reading an item.

In **Power and disk → Credential configuration**, choose **Load configuration**.
The desktop reads text and URL fields from the linked server item locally using
`op item get --fields type=STRING,type=URL` and saves only validated VM and boot
metadata. Keep configuration values in text/URL fields; concealed and OTP fields
are not part of this read. The item supports these custom field labels (case insensitive):

| 1Password field | Purpose |
| --- | --- |
| `SNEL service ID` / `service_id` | Numeric provider service identifier, stored as a text field. A URL field such as `SNEL service URL` containing `https://my.snel.com/clientarea/services/cloudvps/<id>/` can supply this instead. |
| `SNEL VM ID` / `vm_id` | Numeric VM identifier inside that service, stored as a text field. |
| `IP address` / `ip_address` / `IP` | Optional check against the inventory server IP. A mismatch stops import. |
| `Boot SSH port` / `boot_port` | Optional, default `2222`. |
| `Verified boot SSH public key` / `boot_host_key` | Optional pinned boot endpoint identity; requires the LUKS UUID. |
| `LUKS disk UUID` / `luks_uuid` | Optional encrypted disk identity; requires the boot public key. |
| `Disk Encryption Password` | Read only during the existing unlock step, never returned by configuration import. Labels are case insensitive. |

Missing, conflicting or invalid identifiers stop import. The script does not guess
which VM belongs to a server. Provider passwords and MFA are read from the workspace
item during an operator-requested operation. Other item fields and secrets are not
returned to the frontend or stored in operation history.

The import preserves the existing backend/user/organization/device-lock checks and
requires administrator permission. A revision and a binding to the current inventory
references prevent a delayed import from saving against a changed target. Changing
the server IP, workspace or either credential reference requires loading the
configuration again. Existing manual mappings are retained for history but must be
loaded from 1Password before use in this release. After changing VM metadata in 1Password, load the configuration again. Running or unknown operations
continue to block configuration changes.

To unlock remotely, first prepare and validate a restricted SSH endpoint in the
VM's initramfs. The [preparation script](boot-unlock-preparation.md) can build an
isolated candidate for supported CentOS/RHEL 7 servers without changing active boot.
Record the verified boot host public key, boot SSH port and exact
LUKS UUID in the linked 1Password item, then load the configuration. The endpoint accepts only `status` and `unlock`: `status` lists active
systemd password requests, and `unlock` queries their passwords. It must expose the
disk UUID in the authenticated password request. Grant the selected local SSH
identity access to that endpoint. The operator may choose the configured automation
host as a jump host; both SSH host identities are pinned and agent forwarding is off.

The earlier Turboclick proof of concept installed an alternate image and used a
one-time GRUB entry. It did not make that entry the default and did not enroll the
VPN VM. Do not assume either machine is prepared for later encrypted boots. Kernel
updates must preserve and revalidate the boot SSH endpoint and verified identity.
No boot image, firewall, authorized key or default boot entry is changed by this UI.

Without the boot key and UUID, **Start server** can power on through SNEL and explicitly
reports that console disk unlock is required. It cannot deliver a password through
the public SNEL User API: its documented operations cover VM state and power, not
console keystrokes.

## Execution and recovery

Editors and administrators can initiate actions; only administrators change provider
or boot mappings. A current human session is required. Each request persists a
target-bound operation before dispatch, and the same request ID never runs twice.
User, organization, device lock and backend changes stop local execution. Server
mapping changes are blocked while a mutation is running or its outcome is unknown.
The lock belongs to the SNEL service/VM pair, so recreating an inventory record
cannot bypass an uncertain operation. Explicit console reconciliation records its
operator without changing the original request identity.

The provider-account password and current TOTP are obtained locally through `op`.
The disk password is fetched only after two authenticated boot status checks match
the configured disk. It is sent once over pinned SSH, after that same UUID appears
in the remote password prompt. Rejected passwords are not retried. Provider tokens,
passwords and raw subprocess output remain in process memory; only allowlisted
progress/result codes reach the UI and history. Temporary SSH configuration contains
public host keys and identity paths, has private permissions and is removed afterward.

**Start server** requests power on only if SNEL reports the VM off. An already running VM
is not shut down or rebooted. **Shut down server** requests graceful `shutdown` and waits
for SNEL to report power off; it never invokes force-stop or reset. An uncertain API
mutation is not retried. Another mutation remains blocked until an administrator
inspects the provider console and explicitly reconciles the operation. Reconciliation
does not assert infrastructure recovery.

**Check SNEL status** reports the current power observation separately from a previous
startup result. With remote unlock configured, it also queries the pinned boot endpoint
to detect a locked disk, without reading or sending the disk password. Power on alone
does not confirm operating-system readiness. Each result displays its own observation
time; a later inspection cannot refresh the timestamp of an earlier startup success.
A fresh observation remains visible even if an older start result is uncertain.
An administrator can choose **Retry start** after checking the console. Its confirmation
reconciles the previous attempt before creating a new request, which checks provider
power and the disk prompt again. Running requests cannot be retried. A failed
reconciliation or a changed session prevents dispatch.

The desktop waits up to three minutes for boot SSH and up to three minutes for the
interactive unlock exchange, within its overall nine-minute operation limit.
A disconnect before any password was sent reports unavailable boot access; it does
not imply an uncertain password submission. A timeout after sending a password
still requires explicit reconciliation before another attempt.

Ending the unlock SSH session only advances the operation to **Awaiting agent**.
Recovery requires a newly accepted telemetry observation after the operation began.
Older replayed samples cannot establish recovery. Existing incident evaluation owns
incident resolution when communication returns; the power button never manually
closes an incident or asserts application health.

## Validation

```sh
python3 tests/server-power.test.py
I7Y_TEST_POCKETBASE=/path/to/linux/pocketbase python3 tests/server-power.integration.py
npm test
npm run typecheck
npm run build:web
node --import tsx apps/desktop/scripts/prepare-mcp.ts
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml server_power::tests
```

The integration suite starts its own loopback-only Docker backend and removes that
fixture on completion. It checks organization isolation, reader/editor permissions,
concurrent mutations, stale mapping versions, replayed request IDs, uncertain outcomes
and recovery through fresh agent delivery. Provider/boot tests use controlled adapters;
they do not power-cycle production VMs or retrieve production passwords.

References: [SNEL User API](https://my.snel.com/userapi#vps-106),
[1Password CLI](https://developer.1password.com/docs/cli/).
