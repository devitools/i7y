# Ansible actions

This is the direct SSH action implementation. The desktop connects to the configured
Ansible host and invokes a fixed catalog playbook there. No i7y service or executable
is installed on that host. The Rust controller outside this directory is a previous
prototype and is not required by these actions.

`actions.yml` is the declarative catalog. Paths are relative to this release.
Installation inventories and SSH configuration are outside the release. Inventory
must define `i7y_targets` explicitly; an empty selection must fail before execution.
The caller supplies a private JSON parameter file, never a shell command.

A release contains the playbooks, helpers and pinned WordPress scripts. Deploy it to
a new directory named by its content digest. Validate before switching the configured
release path; retain the previous directory for rollback. Never pull into an active
release or overwrite the legacy Ansible repository.

Project copy inspects internally, then executes from a single Copy project button.
The initial inspection expires after ten minutes; a started operation can resume
using its original identifier. The first adapter supports running two-container
WordPress / MySQL 5.7 projects on one host. Database data mounts support Compose
short and long named-volume syntax. Unsupported layouts fail before copying files.

The source remains running. Backups use a consistent InnoDB transaction or a global
read lock when MEMORY tables are present. The locked dump is limited to 30 seconds,
and its dedicated MySQL session must terminate before the backup can finish. A
confirmed timeout releases its attempt for retry. If cleanup or the remote outcome
cannot be confirmed, the pending marker remains and requires reconciliation. Files
and database writes are not captured as one atomic application snapshot. Live
WordPress content may change after inspection; project configuration, including
Compose, `.env` and `wp-config.php`, must still match the approved configuration.
The existing Compose service definitions,
proxy network, plugins and theme settings are preserved. The destination is tested
on an internal bridge with an isolated gateway and no published ports before it is
connected to the proxy. This requires Docker Engine 28 or newer; incompatible
network configurations stop the copy. Independent credentials live in the copied
project's private `.env`. The action does not configure DNS. Backups use the local
Docker Unix socket through Engine API v1.48 and record their exact exec identity;
unrelated healthchecks and exec sessions do not block a confirmed safe retry.

Completed backup, preparation, configuration, restoration and URL replacement steps
are checkpointed. Resume reuses them. An incomplete restore may restart only the
new destination database from the verified backup. A host-side file lock prevents
concurrent execution of the same operation. Each attempt also reserves a durable
managed-host marker. A lost connection cannot bypass it; retries wait for the prior
attempt to finish or a known safe failure to release it. An uncertain interrupted
attempt stays blocked for reconciliation. The desktop makes up to three additional
attempts, 30 seconds apart, for transient errors while it remains open. Do not
delete operation state manually.

The playbook has a four-hour controller budget, and the desktop SSH connection
allows two additional minutes for staging and the final response. A timeout with
an uncertain managed-host outcome retains the reservation. Confirmed staging and
preparation failures before file copying release only their own attempt marker.
A durable controller receipt distinguishes a remote execution from a connection
that failed before dispatch. Completed operations recover interrupted cleanup only
when the retained marker belongs to the attempt recorded in `completed.json`.

The system Ansible 2.9.1 installation remains a legacy compatibility path. Select a
supported ansible-core version only after controller and managed Python compatibility
has been checked. Keep the new runtime separate; do not upgrade the system Python or
replace global Ansible executables as part of a project copy.


## Runtime and validation

The new validation baseline is pinned in `requirements.txt` to ansible-core 2.20.11.
It needs Python 3.12 or newer on the control host and Python 3.9 or newer for normal
modules on managed hosts. The observed Tools Python 3.6.8 cannot host that runtime.
Prepare a separate supported Python/runtime environment before switching the Tools
connection to it. This repository does not silently install or upgrade that runtime.
The direct pilot still invokes the existing `/usr/bin/ansible-playbook` on Tools;
passing local 2.20 tests does not establish support for every legacy managed host.

Run the contract and isolation checks:

```sh
python3 tests/project-copy.test.py
python3 tests/project-copy-backup.test.py
.local/artifacts/ansible-runtime/bin/python tests/project-copy.integration.py
```

The integration test uses disposable Docker containers, a pinned WordPress fixture
and independent MySQL volumes. It does not connect to the automation host or managed
servers. It verifies the complete playbook, serialized URL changes, source preservation,
independent secrets and replay rejection. Tests may download the pinned WP-CLI artifact.

The desktop embeds the exact release files. On a preview, it stages that release under
`~/.local/share/i7y/ansible/<content-digest>` on the automation host using SSH stdin.
It invokes Ansible directly, using private JSON inventory and parameter files. It opens
no HTTP endpoint. Execution is bound to the reviewed release, backend, organization,
SSH profile, destination confirmation and operation ID. Each execution can start once.
Operation artifacts remain private on the managed server under
`/var/tmp/i7y-project-copy/<operation-id>`. A failed or interrupted copy retains its
lock and artifacts for inspection and can be resumed using the same operation ID;
automatic cleanup is deliberately absent.


## Missing managed-host Python

The copy playbook discovers a supported interpreter with a raw SSH command before
staging files. It checks `/usr/bin/python3`, `/usr/local/bin/python3` and
`/opt/i7y/python/bin/python3`. The legacy control runtime requires Python 3.6+ for
the helper; the new ansible-core baseline requires Python 3.9+ for managed modules.
A missing interpreter stops the preview with a specific compatibility message.

`playbooks/prepare-python.yml` is a separate administrator-reviewed preparation,
not an automatic copy phase and not an action in the desktop catalog. It installs
only the version and SHA-256 pinned in `runtime/python.json`, into a new
`/opt/i7y/python` directory on Linux x86_64. It refuses an existing destination,
verifies imports before activation, and does not replace the system Python,
Ansible, Docker, SSH settings or application containers. Review and authorize
that host change separately before running it against a managed server.
