# Install the i7y daemon on a server

This guide installs `i7y-agent` on a Linux server with Docker and systemd. The agent starts at boot, collects data immediately, then every five minutes. It keeps container state and images in use up to date in i7y, with telemetry history.

The agent also follows Docker events through the local socket. Creation, start, stop, removal and health changes trigger a lightweight reconciliation with a two-second debounce. Reconnection reconciles state to recover missed events. Full metrics collection continues every five minutes; events received during that collection are processed afterward. The container list hides removed records by default; enable Show removed containers to inspect them. An open list refreshes automatically every ten seconds.

Installation does not restart or change application containers. Administrative access is required to create the agent user and service. Access to the Docker socket is privileged; use a binary from a trusted source and protect the configuration.

The addresses, users and credentials below are fictional examples. Replace them with the values for your environment.

## 1. Prepare the files

On the machine containing the i7y source code, open `apps/agent`. With Go installed, build the binaries and checksums:

```sh
go test -race ./...
./build.sh
```

The module pins the toolchain version. The build produces:

- `dist/i7y-agent-linux-amd64`: 64-bit Intel/AMD servers.
- `dist/i7y-agent-linux-arm64`: 64-bit ARM servers.
- `dist/SHA256SUMS`: checksums for both binaries.

The target server does not need Go, Node or Python to run the agent. If you already have binaries from a trusted source, you can skip the build.

## 2. Check the target server

Connect through SSH using the correct port and identity. Verify the host key against a trusted source before accepting an unknown server.

```sh
ssh -p 22 operator@server.example.com
uname -m
systemctl --version
docker version
getent group docker
```

Choose the binary based on `uname -m`:

| Result | Binary |
| --- | --- |
| `x86_64` | `i7y-agent-linux-amd64` |
| `aarch64` or `arm64` | `i7y-agent-linux-arm64` |

Also confirm that the server can reach i7y over HTTPS:

```sh
curl --fail --show-error https://inventory.example.com/api/health
```

The API should return HTTP 200. Resolve DNS or certificate problems before installing; do not disable TLS verification.

This installer assumes Docker uses the local socket `/var/run/docker.sock` and the `docker` group exists. Otherwise, adapt the service to your environment before continuing.

## 3. Create the credential in i7y

1. Sign in to i7y with your user.
2. Register the server in the correct workspace if it does not exist yet.
3. Open **Telemetry** and expand **Agent settings**.
4. Select the server by its registered name and check its IP on the **Servers** screen.
5. Click **Create credential** and confirm.
6. Copy the displayed secret. It starts with `i7ya_` and is shown only when created.

Use a different credential for each server. It is bound to the selected record and only allows reading configuration and sending telemetry for that server. It is not the general API management token. In these examples, replace `https://inventory.example.com` with the URL of your own installation.

If an agent is already installed, plan the configuration update before rotating its credential: creating another credential for the same server immediately invalidates the previous one.

## 4. Copy the files

On the server, prepare a private temporary directory:

```sh
install -d -m 0700 "$HOME/i7y-install"
```

On the build machine, inside `apps/agent`, copy the files. This example uses `amd64`:

```sh
scp -P 22 \
  dist/i7y-agent-linux-amd64 \
  dist/SHA256SUMS \
  deploy/install.sh \
  deploy/i7y-agent.service \
  operator@server.example.com:~/i7y-install/
```

If necessary, add `-i /path/to/key` to the SSH and SCP commands. Do not copy the private key to the server.

On the server, verify the checksum of the received binary:

```sh
cd "$HOME/i7y-install"
awk '$2 == "i7y-agent-linux-amd64" { print }' SHA256SUMS > selected.sha256
test -s selected.sha256
sha256sum -c selected.sha256
chmod 0755 i7y-agent-linux-amd64
./i7y-agent-linux-amd64 -version
```

The checksum should return `OK`. For ARM, replace `amd64` with `arm64` in the commands.

## 5. Create the private configuration

On the server, create the file with restricted permissions and open it in an editor:

```sh
cd "$HOME/i7y-install"
install -m 0600 /dev/null config.json
vi config.json
```

Fill in the file, replacing the URL and token with the actual values:

```json
{
  "url": "https://inventory.example.com",
  "token": "i7ya_PASTE_THIS_SERVER_CREDENTIAL",
  "docker_socket": "/var/run/docker.sock",
  "state_dir": "/var/lib/i7y-agent",
  "roots": ["/usr/share/tevun/projects", "/usr/share/tevun"]
}
```

`roots` defines where the agent searches for projects. Use physical paths confirmed with `readlink -e /projects` and `readlink -e /usr/share/tevun`, adapting the example to your server; nonexistent directories are ignored. The agent user must be able to read and traverse these directories. Do not grant write access to application files for collection.

The agent also receives paths for registered projects from i7y. It resolves symlinks, sends and stores physical paths in the inventory, and recognizes the Compose directory within an existing project, preserving the association when unambiguous.

Do not put the credential in commands, terminal history, repositories, screenshots or support tickets. Do not run `cat config.json` in sessions with shared output.

## 6. Install and start the service

On the server:

```sh
cd "$HOME/i7y-install"
sudo sh install.sh \
  ./i7y-agent-linux-amd64 \
  ./config.json \
  ./i7y-agent.service
```

If the SSH user is not in `sudoers`, use existing authorized administrative access. For example, become root with `su -` and run the same installer without `sudo`, using absolute paths to the preparation directory. You do not need to grant sudo to the SSH user to install the agent.

The installer creates:

| Location | Purpose |
| --- | --- |
| `/usr/local/bin/i7y-agent` | Executable |
| `/etc/i7y-agent/config.json` | Configuration and credential, mode `0600` |
| `/etc/systemd/system/i7y-agent.service` | systemd service |
| `/var/lib/i7y-agent` | Persistent queue and process lock |

It creates the `i7y-agent` system user, enables the service at boot and starts it. The systemd configuration gives the service access to the `docker` group.

## 7. Verify the installation

Check the service:

```sh
systemctl is-enabled i7y-agent
systemctl is-active i7y-agent
sudo journalctl -u i7y-agent -n 30 --no-pager
```

The expected results are `enabled` and `active`. After collection, logs should show messages such as:

```text
collected 12 containers; errors=0
queue delivered
```

The first collection may take time depending on the number of containers. The agent collects immediately on startup; you do not need to wait five minutes for it to begin.

To test authentication and Docker access without sending another sample:

```sh
sudo -u i7y-agent -g docker \
  /usr/local/bin/i7y-agent \
  -config /etc/i7y-agent/config.json \
  -diagnose
```

The diagnostic should report `API and Docker available`. The `-g docker` option reproduces the group access provided to the service by systemd.

In i7y, open **Telemetry**, select the server and click **Refresh**. Confirm:

- A recent agent version and last contact.
- A container list consistent with `docker ps -a`.
- Images matching the references configured in the actual containers.
- Metrics and history populated, without unexpected collection errors.

After changing an image and recreating a container on the server, the next collection automatically updates the inventory's `image` field. Downloading an image with `docker pull` alone does not change the image of an existing container.

After verification, remove the temporary copy of the credential:

```sh
rm -i "$HOME/i7y-install/config.json"
```

The configuration used by the service remains at `/etc/i7y-agent/config.json`.

## 8. Update the agent

Build or obtain the new binary and verify its checksum. You do not need to create another credential or reinstall containers.

With the new binary already on the server:

```sh
sudo cp -p /usr/local/bin/i7y-agent /usr/local/bin/i7y-agent.previous
sudo install -m 0755 ./i7y-agent-linux-amd64 /usr/local/bin/i7y-agent.next
sudo mv /usr/local/bin/i7y-agent.next /usr/local/bin/i7y-agent
sudo systemctl restart i7y-agent
/usr/local/bin/i7y-agent -version
sudo journalctl -u i7y-agent -n 15 --no-pager
```

Replacing by rename avoids overwriting a running executable. Configuration and queue are preserved. Confirm the new version in the next i7y sample.

To restore the previous binary:

```sh
sudo install -m 0755 /usr/local/bin/i7y-agent.previous /usr/local/bin/i7y-agent.next
sudo mv /usr/local/bin/i7y-agent.next /usr/local/bin/i7y-agent
sudo systemctl restart i7y-agent
```

## 9. Troubleshoot common problems

| Symptom | Check |
| --- | --- |
| `configuration must have mode 0600` | Check permissions with `sudo stat /etc/i7y-agent/config.json`. |
| `API HTTP 401` | Check that the credential belongs to this server and has not been revoked or rotated. |
| `API HTTP 403` | Check proxy and Cloudflare rules for the telemetry endpoint. |
| `API connection failed` | Check DNS, HTTPS connectivity, certificate and configured URL. |
| `Docker unavailable` | Check that Docker is running, the socket is configured and the service has access to the `docker` group. |
| `project path inaccessible` | Check directory read and traversal permissions for `i7y-agent`. |
| `another agent is running` | Another process is using the same queue; use the instance managed by systemd. |
| Ambiguous project or association | Review inventory paths and associations; the agent preserves existing records instead of silently moving containers. |
| No communication in the dashboard | Check the service and logs; the dashboard indicates no contact after 15 minutes. |

During a network failure, the agent keeps a local queue of up to 24 hours/288 samples and retries with backoff. The backend recognizes repeated samples to avoid duplicate history.

If `/projects` is a symlink to a directory under `/home`, inspect the entire path with `namei -l /projects`. A home directory with mode `0700` blocks access even if the destination is readable. If needed, grant only traversal to the agent user on the ancestor directory, for example `sudo setfacl -m u:i7y-agent:--x /home/operator`. This does not allow listing that directory; project directories must still allow the read access required for discovery. Restart only `i7y-agent` and confirm the next delivery.

## 10. Stop or remove

To stop temporarily:

```sh
sudo systemctl stop i7y-agent
```

To start again:

```sh
sudo systemctl start i7y-agent
```

To remove the service and binary, use `apps/agent/deploy/uninstall.sh` from the source code:

```sh
sudo sh uninstall.sh
```

The script preserves configuration and queue. Revoke the credential in telemetry if the server permanently stops sending data. Removing the agent does not delete inventory projects or containers and does not affect actual containers.
