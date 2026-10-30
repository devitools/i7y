# Disposable mobile simulator lab

`scripts/mobile-lab.py` starts two local PocketBase 0.40.4 installations, A and B, for testing the native client's server selection, browser consent, organization access, incident queue and actions. Each has a new database and installation identity. Fixtures contain synthetic data only. The script never reads an existing database or connects to an existing backend.

Run commands from the repository root. Docker, installed npm dependencies and a Linux PocketBase 0.40.4 binary for amd64 or arm64 are required. The binary may be reused from an earlier disposable test; only the executable is copied. Do not supply a database directory.

```sh
I7Y_TEST_POCKETBASE_BINARY=/absolute/path/to/linux/pocketbase python3 scripts/mobile-lab.py start
python3 scripts/mobile-lab.py status
```

Alternatively, pass `--pocketbase-binary /absolute/path/to/linux/pocketbase`. The script checks the binary format, architecture and version, builds the production web interface once with `VITE_POCKETBASE_URL=/`, and mounts that same build into both containers. Each installation therefore serves its own backend and browser interface from one origin. Hooks and migrations are copied into the lab at startup; stop and restart to test newer source changes.

The script chooses free host ports and publishes them only on `127.0.0.1`. Its output reports both URLs and the credential-file path without printing passwords or session tokens. Container names begin with `i7y-mobile-lab-` and carry a run-specific ownership label. No production Compose service or existing database is used. Email delivery is disabled inside the lab.

## Native app build

Install the embedded-bundle `simulator` variant using `npm run ios:preview` or `npm run android:preview` from `apps/mobile`. The app then opens its own login screen without Metro or the Expo development launcher. Run native builds one at a time on memory-constrained hosts. The simulator variant permits only local/private HTTP origins for this lab; store builds enforce HTTPS.

Keep only one simulator or emulator running during acceptance. Complete the iOS session and shut down its simulator before starting Android, or complete Android first and then switch to iOS. Do not start the other platform while waiting for a user's browser sign-in.

Use the printed `127.0.0.1` URL on iOS Simulator. Android Emulator reaches the host through `10.0.2.2`: retain the printed port, for example `http://10.0.2.2:<port>`. This address belongs in the i7y login field. No backend address is hardcoded into the app.

After a host restart, existing lab containers and databases can be resumed with `docker start <container-A> <container-B>` using the exact names from `status`. Recheck `status` afterward. Do not run `stop` unless intentionally discarding the current fixtures and credentials.

## Production connection acceptance

Enter the publisher-selected HTTPS installation in the native Backend URL field. The field starts empty and retains `https://inventory.example.com` as its generic placeholder; a production address is a saved user preference, not a bundled default.

Before signing in, verify that `/api/i7y/mobile/v1/info` returns JSON with a stable installation identity and the `browser_login` and `incidents` capabilities. An HTTP 200 response containing the web application's HTML is an unsupported server, not a successful discovery. The app explains that the server needs mobile support while preserving the entered URL for retry.

The app opens `/mobile-auth.html#/mobile-authorize` on that same origin. This dedicated browser entry reuses the web login and account confirmation. The user enters production credentials directly in the browser, compares the request code, authorizes the app, and returns through its registered callback. Do not put credentials in a test report. After return, verify authorized organizations, incident reading and session persistence. Test claim, extension and resolution against disposable fixtures unless a specific production incident action has been authorized.

Keep production login acceptance separate from provider-backed push acceptance. A server that advertises only `browser_login` and `incidents` supports consultation and incident handling but has no configured remote push path.

## Fixtures and credentials

All generated state is under the ignored root `.local/mobile-lab/` directory. `access.json` has mode `0600`; it contains the URLs, generated account passwords, fixture IDs, installation IDs, container names and startup verification results. The directory has mode `0700`. Keep this file local and remove it with the teardown command when testing ends.

Both installations have separate accounts:

| Account | Organization role | Access |
| --- | --- | --- |
| `admin-a@mobile-lab.example.test`, `admin-b@mobile-lab.example.test` | Administrator | Primary and Secondary organizations in their own installation. |
| `operator-a@mobile-lab.example.test`, `operator-b@mobile-lab.example.test` | Editor | Both organizations; can claim and resolve incidents. |
| `viewer-a@mobile-lab.example.test`, `viewer-b@mobile-lab.example.test` | Reader | Primary organization only; cannot claim or resolve. |

Passwords are generated independently for each account. The credential file also contains separate test-only PocketBase superuser accounts for fixture administration. The named administrator users are organization administrators, not global superusers.

Each installation starts with an open critical incident in Primary and an open warning incident in Secondary. Names, user IDs, organization IDs and initial incident IDs are deterministic fixtures. Evidence explicitly identifies itself as synthetic. Open incidents have one-minute reminder intervals and appear in the in-app notification queue. Startup also creates and resolves a separate synthetic incident to verify the action endpoints, so resolved history contains that verification occurrence.

Startup checks production HTML serving, protocol discovery, password login, mobile consent/exchange, proof replay rejection, incident listing, operator claim/resolve, viewer action rejection and the notification queue. A and B must expose different `instance_id` values. These checks do not replace a native browser callback or simulator run.

Native push is intentionally unconfigured in this lab. `/info` advertises `browser_login` and `incidents`; no APNs, FCM or gateway credentials are needed. Simulator testing can verify the in-app queue and the unconfigured-push state. Provider registration, real notification delivery and native permissions need a separately configured device/gateway test.

## Simulator walkthrough

Use a development build configured for local HTTP. On the iOS simulator, use the exact A/B loopback URLs printed by `status`. Android emulators normally reach the host through `10.0.2.2`; use that hostname with the printed port if the emulator forwards host loopback. The browser flow must use an origin reachable from both the app and its system browser. Physical devices cannot reach these loopback-only published ports through the host's LAN address.

1. Connect to A and sign in with its operator account in the system browser. Confirm that the displayed code matches the native app before authorizing.
2. Inspect the Primary critical incident, its synthetic evidence and audit history. Claim it with a future deadline, refresh, then resolve it. Reminders should pause during the claim and stop after resolution.
3. Switch organizations and confirm that the Secondary warning incident belongs to the same installation. The login connection should remain unchanged.
4. Sign out and sign in as the viewer. Verify read access and unavailable editing actions. The viewer must not gain Secondary organization access.
5. Switch to B. The browser must authenticate to B, and A's session, organizations, cached incidents and notification connection must not appear there.
6. Sign out while an authorization or push setup is pending where the UI permits it. A completed stale response must not restore the old session. Native push remains unavailable unless separately configured.

After resolving the fixtures, stop and start the lab to create a fresh set. A new run chooses new ports, passwords and installation identities. Do not reuse an old credential file or saved app connection after resetting the lab.

## Stop and remove

```sh
python3 scripts/mobile-lab.py stop
```

This removes only containers whose run labels match the saved lab manifest, then deletes both disposable databases, generated credentials, copied hooks, binary and built web assets under `.local/mobile-lab/`. It does not remove Docker images, npm dependencies, source files or other `.local` directories. Docker must be available for teardown. `start` is idempotent while both recorded installations are healthy; an incomplete run requires `stop` before starting again.

For setup failures, inspect `.local/mobile-lab/web-build.log`. Container names are available through `status` or the private manifest. Avoid publishing full container configuration or the credential file because they belong only to this synthetic test workflow.
