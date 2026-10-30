# Automation review and stable-release acceptance

## Scope and evidence

Reviewed all 55 tracked files in the legacy automation repository, including all
13 operational playbooks, 13 launch wrappers, three generated role skeletons,
inventory generation, installation and CI/deployment scripts. Inventory and output
JSON were reviewed as private installation data, not copied into product fixtures.
The remote branch has a newer inventory, but identical tracked automation code.

The live controller working tree differs substantially from its Git revision.
A read-only snapshot of its playbooks and utilities was compared by content with
the local repository: operational source files match; additional retry files and
an obsolete test inventory exist only on the controller. Never use `git reset`,
`git clean`, a forced deployment or a replacement inventory to reconcile it.
Installation-specific revisions, hashes and snapshots are retained in ignored
`.local/diskninja/ansible-review/`.

The controller currently reports Ansible 2.9.1, Python 3.6.8, Docker 19.03.5,
Git 1.8.3.1 and glibc 2.17. Those are compatibility facts, not a supported baseline
for the new executor. A separate, pinned runtime must be validated there without
upgrading the existing controller stack in place. A macOS Rust build does not
prove Linux/glibc compatibility. Managed-host Python versions also need discovery
before selecting the Ansible runtime.

## Complete operational disposition

| Legacy task | Finding | Product action and disposition |
| --- | --- | --- |
| `info/server` | Gathers broad facts and prints uptime; no structured contract | `server.inspect`: fixed read-only commands, structured result |
| `info/df` | Uses shell for a fixed command; reports changed on a read | `server.disk`: command argv, unchanged result |
| `info/projects` | Delegates to an unversioned global CLI; output unstructured | `project.list`: replace with approved-root discovery and structured metadata |
| `maintenance/amazon-update` | Stops Docker, updates every package, cannot guarantee restart on failure | `host.update-amazon`: disabled until OS detection, maintenance review, backup and recovery exist |
| `maintenance/centos-update` | Same fleet-wide service interruption and failure hazard | `host.update`: disabled; controlled package plan, explicit restart scope |
| `maintenance/tevun-pull` | Root CLI with unknown scope and mutable image tags | `proxy.pull`: require inspected Compose model and pinned image plan |
| `maintenance/tevun-update` | Pulls mutable Git branch and image tags; stops proxy; no verified rollback | `proxy.update`: rewrite as versioned, health-checked proxy update |
| `setup/bashrc` | Repeated append duplicates aliases/prompts; quoting fragile; touches root profile | `host.shell-configure`: optional idempotent managed block, explicit account |
| `setup/docker` | Full package update; assumes CentOS; unverified latest downloads; lost cross-task shell variable | `host.docker-install`: supported OS matrix, pinned packages/plugin, no unrelated upgrade |
| `setup/mc` | Unversioned amd64 download without checksum; repeated PATH append | `host.storage-client-install`: architecture detection, version/checksum pin and managed PATH |
| `setup/ssh` | Appends SSH settings; assumes eth0/SELinux/firewalld; no sshd validation or reconnect/rollback | `host.ssh-configure`: high-risk action, disabled until two-connection recovery test |
| `setup/tevun` | Unpinned clone and privileged CLI setup; no capability or rollback contract | `host.proxy-install`: explicit supported version, inspected effects, idempotent provisioning |
| `setup/timezone` | Hard-coded timezone; moves current link and can fail on repeat | `host.timezone-configure`: validated parameter and idempotent module |

All 13 shell wrappers inherit an arbitrary Ansible host-pattern parameter, have no
typed action contract, and generally leave path expansions unquoted. They are not
used by the new executor. Missing arguments must never imply all hosts. The new
controller resolves one inventory host from an administrator-owned mapping.

The three role directories are scaffolding around standalone playbooks, not
usable roles: default/handler/variable files are empty; metadata and README files
are templates; tests reference a nonexistent `ping` role. Those tests provide no
validation of any operational routine. Keep the legacy layout intact until its
replacements pass acceptance; new recipes live in `apps/automation/recipes`.

## Other tracked files

- `util/generate/inventory.php`: writes INI from unchecked values, accepts arbitrary
  connection configuration and returns success for invalid input. Replace with a
  validated adapter from inventory IDs to controller-owned SSH mappings. The UI
  must not supply host patterns, private-key paths or connection plugin names.
- `util/generate/inventory.sh`: runs mutable `php:latest` with a broad repository
  mount. Replace with a deterministic inventory export; no PHP runtime required.
- `util/install.sh`: replaces the global Ansible inventory and `/usr/bin` symlinks.
  New installation must use its own config/inventory and a versioned executor path.
- `.gitlab-ci.yml`: disables host-key validation, rebuilds Git metadata and force
  pushes a deployment branch. Replace with pinned host identities, validation and
  atomic release activation; never run it against the current dirty controller.
- `repositories/*.sh`: installation-specific forced Git pushes, plus a
  credential-like literal in a comment. Exclude from the product and have the
  owner verify whether that historical credential needs revocation.
- `inventory.json`, `output.json`, `tevun`: real infrastructure and output records,
  not generic code. Keep private. Do not import the historical output as truth.
- Root `.gitignore`: ignores generated inventory but not all infrastructure data.
  No legacy repository history is imported into the generic product.

## Actions architecture

`apps/automation/actions.json` is the explicit action catalog. An action has a
stable ID, target kind, permission class, recipe and readiness state. A catalog
entry is not execution permission. All entries remain disabled until their
end-to-end acceptance passes. Every legacy operational task has a mapped action;
new container lifecycle and project-copy actions use the same boundary.

The desktop sends typed requests through pinned, agent-only SSH to the controller.
The controller resolves inventory and executes reviewed recipes. No browser action
can execute commands, no generic shell is exposed, and no controller private key
is sent to the desktop or central API. Restricted SSH credentials are scoped to a
principal and allowed backend/organization/target, not shared unrestricted root.

The executor now persists reviewed plans and immutable job events, launches detached
workers, validates operator/backend/organization/target allowlists and prevents
operation replay. Plans include the full local release tree digest and expire after
ten minutes. Mutating jobs serialize per host and reserve copy destinations. Linux workers
are identified by boot ID and process start time. An unreadable process observation
is marked unknown, not stopped; no status request restarts a job.

These mechanisms pass disposable process-level tests, including killing a worker,
request-process exit, denied cross-organization access, revoked permission and
changed inventory. They are not yet validated through the actual desktop/Tools
connection. Live container preflight is now recorded in reviewed plans and rechecked by
lifecycle recipes. Project-copy preflight, central user permission synchronization,
OS-backed desktop sessions and the copy recipe still remain. Recipe success must
include backup and health verification; a process exit alone is not sufficient.

## First stable version acceptance

The copy preparation library now creates independent Compose service names, database
credentials and storage references while pinning the observed source images. Its
initial adapter supports a two-service WordPress/MySQL layout with project-owned
bind mounts and a local database volume. Unsupported layouts are rejected.

The file-copy library verifies a content and metadata manifest, copies hidden files
and empty directories, preserves ownership, permissions and timestamps, and checks
the source again before reporting success. Existing destinations, symlinks, special
files and destinations inside the source are rejected. Incomplete destinations stay
private for reconciliation. This does not copy live database files or activate the
destination. Logical database backup/restore, WordPress replacement and destination
health checks remain required before exposing project copy as executable.

Validation: all 22 automation tests pass on macOS and Linux, and Clippy passes with
warnings denied. These are isolated library and protocol tests, not a production
project-copy pilot.

The MySQL 5.7 logical backup adapter has also passed a real disposable database
restore test, including binary data and independent destination writes. Unit tests
cover credential handling, client failures and unsupported schema rejection. The
backup stream now has private persistence and hash verification in the Rust library.
A second real test uses separate source and destination database containers and
checks refusal to restore into a populated destination. Connection to controller jobs,
destination provisioning and health verification remain open. Destination-only
WordPress configuration and serialization-aware replacement now pass a real
WordPress/MySQL integration test, including source preservation, GUIDs, serialized
options, quarantined must-use plugins/drop-ins and mail/HTTP guards. These phases
are not yet connected to the remote job pipeline or desktop execution.

The connected preparation workflow now binds review to file/configuration hashes
and expiry, records each phase durably, creates the independent files/configuration
and runs database restoration once. Its real integration test initializes the
destination with the generated database credentials and verifies source preservation.
This is an isolated prototype, not a complete remote copy action. Operational
sequencing must be implemented in Ansible. Rust remains responsible for controller
authorization, plans, durable jobs and invocation of fixed playbooks; the copy
prototype is test evidence to reuse, not a parallel Docker execution architecture.

- [x] Review every tracked legacy file and compare actual controller source.
- [x] Map every operational playbook to an explicit action and risk disposition.
- [ ] Pin and test an isolated Linux controller runtime, leaving the legacy runtime intact.
- [ ] Implement controller allowlists, principal permissions and inventory ID mapping.
- [ ] Persist native sessions in the OS credential store and restrict execution IPC.
- [x] Implement capabilities, plan, submit and status with controller-side allowlists.
- [x] Include observed container preflight evidence in the reviewed plan (isolated tests).
- [ ] Include observed project-copy preflight evidence and verify both on the actual controller.
- [x] Persist jobs before launch; detach workers and prevent replay/concurrent conflicts in local process tests.
- [ ] Validate the same lifecycle through the real SSH connection and controller runtime.
- [ ] Complete read-only server, disk, project and container actions end to end.
- [x] Implement and test container start, stop and restart recipes with preflight, drift detection and postconditions.
- [ ] Connect lifecycle review/confirmation and execution in the desktop.
- [ ] Implement same-server copy with independent files, DB and volumes; verify backups,
      serialized WordPress replacement, destination health and source preservation.
- [x] Validate the destination WordPress adapter with real databases and serialized fixtures.
- [ ] Expose Tauri-only Actions with dedicated review/progress routes and preserved return URL.
- [ ] Validate denials, host-key changes, expired sessions, interrupted jobs, collisions,
      secret redaction and partial failure using disposable servers/projects.
- [ ] Run an explicitly scoped pilot through the actual desktop/controller connection.
- [ ] Document installation, recovery, compatibility and the tested supported action set.

Remaining setup and maintenance actions stay visible as planned capabilities only
until their own acceptance tests pass. Stability does not require executing unsafe
legacy routines unchanged. Each routine must retain its intended outcome while
replacing the unsafe implementation.
