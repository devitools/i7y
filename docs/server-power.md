# Manual VM power and encrypted boot

An incident's **View server** action opens the server telemetry page. **Power and
disk** offers **Start VM**, **Shut down VM**, **Check SNEL status** and the provider
console. The server inventory action menu reaches the same page. These actions are
operator initiated; no no-communication trigger or unattended vault access is added.

This is a fixed desktop action in `apps/automation/desktop/actions.json`, alongside
the existing SSH/Ansible actions. Power control uses the SNEL User API because the
guest's ordinary SSH and Ansible are unavailable before its encrypted root mounts.
The initial native adapter supports macOS with Python 3, OpenSSH and 1Password CLI.
It uses the signed desktop's current backend, organization and user session.

## Configuration

Install the backend migration and hooks with the matching web and desktop release.
An organization administrator maps each VPS to its numeric SNEL service and VM IDs
in **Power and disk → Settings**. Verify those identifiers in the provider console;
the provider API currently has no published response schema for individual VM data.
The workspace must identify SNEL and link to its provider-account 1Password item.
The server's inventory credential must link to the VM item with a field named
`Disk Encryption Password`. Only these inventory references are used. Passwords
are neither requested by the frontend nor stored in backend records or operation
history.

To unlock remotely, first prepare and validate a restricted SSH endpoint in the
VM's initramfs. Configure the verified boot host public key, boot SSH port and exact
LUKS UUID. The endpoint accepts only `status` and `unlock`: `status` lists active
systemd password requests, and `unlock` queries their passwords. It must expose the
disk UUID in the authenticated password request. Grant the selected local SSH
identity access to that endpoint. The operator may choose the configured automation
host as a jump host; both SSH host identities are pinned and agent forwarding is off.

The earlier Turboclick proof of concept installed an alternate image and used a
one-time GRUB entry. It did not make that entry the default and did not enroll the
VPN VM. Do not assume either machine is prepared for later encrypted boots. Kernel
updates must preserve and revalidate the boot SSH endpoint and verified identity.
No boot image, firewall, authorized key or default boot entry is changed by this UI.

Without the boot key and UUID, **Start VM** can power on through SNEL and explicitly
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

**Start VM** requests power on only if SNEL reports the VM off. An already running VM
is not shut down or rebooted. **Shut down VM** requests graceful `shutdown` and waits
for SNEL to report power off; it never invokes force-stop or reset. An uncertain API
mutation is not retried. Another mutation remains blocked until an administrator
inspects the provider console and explicitly reconciles the operation. Reconciliation
does not assert infrastructure recovery.

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
