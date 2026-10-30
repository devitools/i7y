# Desktop operations roadmap

## Topology

The desktop connects over SSH to one automation controller. The controller uses
its existing SSH access and Ansible environment to reach managed servers.
The desktop never needs direct SSH access to every inventory server and does not
receive the controller's private keys. This corrects the earlier direct-to-server
executor proposal. No public command API, Kubernetes or permanent desktop HTTP
bridge is required.

The product calls this machine the **automation host**. Its address, SSH user,
public identity and trusted host key are local installation settings, scoped to
the selected backend. Private inventories and organization-specific playbooks stay
outside the product repository.

## Current implementation

### Execution ownership

Ansible owns operation orchestration on managed servers. The Rust controller owns
SSH request validation, authorization, reviewed plans, durable jobs, locks and status;
it invokes a fixed reviewed playbook for each action. It does not become a second
Docker orchestration engine. The desktop sends operation parameters, never shell
commands or managed-server credentials.

For project copy, the playbook coordinates inspection, backup, file copying,
destination provisioning, restoration, WordPress adjustments and health checks.
Small fixed helpers may implement narrowly scoped transformations or filesystem
validation where needed. They must not independently decide which operational
steps to execute. The existing Rust copy workflow is an isolated prototype and test
reference; it is not wired to the controller or a production execution entrypoint.

- Shared Vue/Quasar frontend in the browser and a local Tauri shell.
- Browser-based desktop sign-in with a persisted backend URL.
- Native Rust API transport, isolated by the selected backend.
- A standalone `i7y-core` Rust library under `apps/desktop/core`, independent of Tauri.
- One local automation-host profile per backend, available at `#/desktop/controller`.
- Read-only SSH diagnostics for Linux, architecture, Ansible and Ansible Runner.
- Public-key-only OpenSSH authentication through the configured 1Password agent.
- Strict host-key pinning, no password fallback, no agent forwarding, no local
  SSH configuration inheritance, no interactive terminal and no arbitrary command
  input. Diagnostic output is parsed locally; raw output is not sent to the API.
- Diagnostics never grant execution access. The [desktop MCP and operations service](desktop-mcp.md) requires explicit central grants, local review and controller authorization for supported actions; production enablement still requires a disposable pilot.
- A Rust controller adapter in `apps/automation` accepts versioned copy plan, apply
  and status requests, resolves administrator-owned target mappings, binds review
  to immutable release contents, enforces operator scopes and records durable job
  events from detached workers. No production
  copy recipe is installed or shipped yet.

The diagnostic invokes only a fixed command on the automation controller. It
neither contacts managed servers nor runs playbooks. The existing user SSH config,
server SSH configuration and 1Password settings are never modified.

## Required before remote mutations

1. Validate the native Keychain session implementation and migration on macOS.
   Actual API tokens now stay behind native IPC; other secure-storage adapters remain pending.
2. Validate OpenSSH and 1Password integration on macOS and Windows, including a
   locked agent, denied approval, changed host identity and a dropped connection.
3. Review the existing controller playbooks and define a versioned, restricted
   executor protocol. A typed request identifies the target and operation; the
   controller resolves inventory and recipes. No shell script or arbitrary command
   is accepted from the central API or the desktop UI.
4. Define explicit operation permission per user and target in the central API.
   Inventory editing and general agent API tokens do not grant execution rights.
5. Add append-only operation history, validated transitions, project locks and
   offline resumption on the controller. Use stable operation IDs so reconnecting
   cannot run an already-applied mutation again.
6. Deliver same-server project copy first: infer source from the selected project,
   ask for the new domain, preserve the source, clone files and independent database
   storage, and replace WordPress URLs without corrupting serialized data. Validate
   backups, destination collisions and health in a disposable environment before
   enabling the desktop Actions menu. Image replacement and MySQL upgrades follow.
7. Sign builds and run an explicitly authorized pilot before team rollout.

The first diagnostics currently require a direct route or existing VPN to the
controller. Bastion/proxy configuration is not implemented in this milestone and
is not inherited silently from `~/.ssh/config`. Managed-server connectivity remains
owned by the controller. The native profile requires a previously verified host
public key; automatic host-key discovery is deliberately not a trust mechanism.

## Validation

```sh
cargo test --manifest-path apps/desktop/core/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run typecheck
npm test
npm run build:desktop -- --debug --no-bundle
```

Unit tests cover argument injection, public-key validation, pinned identities,
agent-only SSH options, bounded output, diagnostic parsing, and failure categories.
The macOS OpenSSH option check uses `ssh -G` and does not contact a server. Live
controller and Windows validation are separate acceptance checks; unit tests alone
are not evidence that either environment is ready for production operations.

## References

- [OpenSSH client configuration](https://man.openbsd.org/ssh_config.5)
- [1Password agent and public identities](https://developer.1password.com/docs/ssh/agent/advanced/)
- [1Password SSH client compatibility](https://developer.1password.com/docs/ssh/agent/compatibility/)

## Legacy review and release gates

See [the complete automation review](automation-review.md) for the disposition of
all legacy routines and the first stable release acceptance checklist. The active
objective includes server and container management through the desktop/controller
connection; the copy adapter alone does not satisfy it.

## Deferred workspace inventory validation

Decision recorded on 2026-10-29: defer validation of the association between i7y
workspaces and Ansible inventory groups, including the host preview before running
a workspace action. This is not a prerequisite for the initial connectivity test.
Do not infer that workspace names match inventory group names.

Follow-up:

- Define an explicit association between a workspace and one or more Ansible groups.
- Discover available groups from the inventory on the automation host.
- Preview the resolved hosts and check that the selection matches the workspace
  before executing workspace actions.

This deferral concerns workspace/group association and its host preview. SSH host
verification, parameter validation and explicit host selection still apply; an
unresolved workspace must not fall back to the entire inventory.


## Local SSH identity

The desktop uses the system OpenSSH client and a local identity file selected by path. Its adjacent `.pub` file supplies the public fingerprint. The desktop does not read, store or transmit the private key contents; OpenSSH performs authentication. There is no application integration with 1Password. Scripts that require an external credential manager own that integration. Connection diagnostics accept unsaved settings and do not persist them. Password prompts are disabled; encrypted identities must already be available through the system SSH agent.


## Direct connectivity pilot

The server ping screen invokes the system SSH client to the configured automation host, then runs Ansible directly with a single IPv4 inventory entry. No remote i7y executable is required. The initial managed-host connection uses root and port 10222; this pilot does not yet resolve workspace groups or read the legacy inventory. Both SSH hops retain strict host-key checking and disable agent forwarding. The local diagnostic tests unsaved settings; the ping uses the saved connection profile.
