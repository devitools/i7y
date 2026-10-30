# Mobile API

The native incident client connects directly to a configured i7y installation. The installation keeps authentication, organization membership, incident evidence and credentials. The optional gateway receives only a per-device sending capability and a minimal notification payload.

All mobile endpoints are under `/api/i7y/mobile/v1` and return `Cache-Control: no-store`. Deploy the hooks and migration together. The API requires PocketBase 0.40.4.

| Endpoint | Authentication | Response |
| --- | --- | --- |
| `GET /info` | Public | `instance_id`, `protocol_version: 1`, `capabilities`, optional `push_gateway_url`. |
| `POST /auth/authorize` | User session | Accept a browser consent request; 204. |
| `POST /auth/exchange` | Public proof | 202 while pending, or a standard PocketBase authentication response. |
| `GET /devices` | User session | Own bindings as `{items: [...]}`. |
| `POST /devices` | User session | Create/update one login binding; 200. |
| `DELETE /devices/{id}` | Owning user session | Revoke binding and cancel pending deliveries; 204. |

API tokens, collector credentials, integration credentials and superuser tokens cannot authorize browser login or manage mobile devices. Device operations do not select an organization. Delivery uses the authenticated user's current organization access. All four mobile collections are private to the backend and trusted PocketBase administration.

## Installation and consent

The migration creates a random, durable `instance_id` in `mobile_installation`. It remains stable across restarts and backups. A cloned backup retains the same identity; treat it as the same installation, or deliberately provision a new database for a separate installation.

`GET /info` always advertises `browser_login` and `incidents`. It advertises `push` and `push_gateway_url` only when both gateway and encryption settings are valid. Missing push configuration does not prevent incident reading or browser login.

The web build includes `mobile-auth.html`, a dedicated login and consent entry. The client opens `/mobile-auth.html#/mobile-authorize` with the request, challenge and installation ID in the fragment. This entry can be deployed with its referenced hashed assets without replacing the existing web application's `index.html`. It reuses the same browser login and consent components.

The client generates a random 32-byte request and a separate random 32-byte verifier, encoding both as 64 lowercase hexadecimal characters. Browser consent submits:

```json
{"request":"64_LOWERCASE_HEX_CHARACTERS","challenge":"SHA256_OF_VERIFIER_AS_LOWERCASE_HEX","instance_id":"INSTALLATION_ID"}
```

The authenticated browser posts this object to `/auth/authorize`. The verifier stays in the native client. After the browser returns through the registered callback, the client calls `/auth/exchange` with `{request, verifier, instance_id}`. The callback carries only the request identifier, never a session token. Cancellation skips exchange. The audience is fixed to `mobile`; requests explicitly naming another audience are rejected. Mobile and desktop authorization records are separate. The backend stores a hash of the request, the verifier's hash, the approving user, the installation identity and a two-minute expiry. Exchange consumes the authorization inside a database transaction; concurrent exchanges produce only one success. Incorrect proofs do not consume it.

A successful exchange uses PocketBase's normal authentication response and rules, including its MFA and login-alert handling:

```json
{"token":"SESSION_TOKEN","record":{"id":"USER_ID"},"meta":{"instance_id":"INSTALLATION_ID"}}
```

Check `meta.instance_id` before persisting the session. An unapproved exchange returns `202` with `{pending: true, instance_id}`. Expired, consumed or incorrect proofs return 400. The client asks the user to start again if authorization remains pending after callback. The backend removes old authorization records after one day. The current native client fails closed if PocketBase requires an additional MFA challenge; native MFA continuation is not implemented.

## Device capabilities

Obtain a binding and a device-specific `send_token` from the configured gateway after its native push registration proof succeeds. Register it with `/devices`:

```json
{"connection_id":"c00de123-1234-4123-8123-c00de1234567","binding_id":"OPAQUE_GATEWAY_BINDING_ID","send_token":"DEVICE_SENDING_CAPABILITY"}
```

`connection_id` is a random UUID stable for that login, independent of organization selection. The gateway binding fixes that connection and the installation identity. A binding ID accepts 16 through 128 URL-safe alphanumeric, underscore or hyphen characters. A sending capability accepts 24 through 512 URL-safe alphanumeric, underscore, dot or hyphen characters.

The endpoint returns `{id, connection_id, binding_id, active, created}`. It returns no sending capability. Listing returns the same metadata and is limited to the current user. Reusing another user's connection returns 404. Reusing an existing binding for another connection returns 409. A user may have at most 20 active bindings. Re-registering the same active binding preserves its starting notification sequence; replacing or reactivating a binding starts at the latest sequence. Historical notices are not replayed when a binding is first registered.

Configure these environment variables on the installation:

- `I7Y_PUSH_GATEWAY_URL`: a fixed HTTPS origin without credentials, paths, query or fragment.
- `I7Y_MOBILE_ENCRYPTION_KEY`: a random, 32-character printable ASCII AES key, stored as a deployment secret.

Capabilities are encrypted using PocketBase's AES-256-GCM helper before storage. Preserve the key across restarts and backups. Changing the key requires re-registering existing device bindings. A missing or malformed configuration makes registration fail with 503 and suspends outbox work. The gateway service credentials belong only to the gateway; never configure them on an installation.

`I7Y_MOBILE_TEST_MODE=1` additionally permits an HTTP loopback origin with an explicit port for disposable tests. Never enable this setting in production.

## Durable delivery

A successful notification creation hook queues a unique notification/device entry after save success. A minute cron also scans notification sequences per device and catches up at most 200 records per device per tick, covering missed hook propagation. Queue insertion has a unique database constraint. Each entry stores its complete safe public payload once, including severity, and every retry sends the exact saved body and idempotency key. Later incident edits do not alter that body; dispatch still revalidates the current notice, source, generation, claim and access. Ingestion performs no gateway requests. Dispatch processes at most 100 due entries per tick, claims a durable 30-second lease, and sends outside the transaction with a ten-second timeout.

Queue creation and dispatch check device activation, current installation identity, current user and organization membership, notification validity, incident status, schedule generation, claims, rule activation/revision, integration activation and any newer notice for that incident. Invalidated or superseded entries are cancelled. Claims and source changes therefore invalidate pending delivery. A delivery already handed to a provider cannot be recalled.

The outbound request is `POST /v1/bindings/{id}/notifications` with `Authorization: Bearer SEND_TOKEN` and an `Idempotency-Key` derived from the notification and device IDs. Its body is:

```json
{"event_id":"NOTICE_DEVICE_ID","incident_id":"INCIDENT_ID","organization_id":"ORGANIZATION_ID","title":"Infrastructure incident","resource":"INCIDENT_ID","severity":"critical","ttl":60}
```

Titles are fixed generic labels by origin: `Infrastructure incident`, `External incident` or `Cloud monitoring incident`. Resource text is the opaque incident ID. Incident titles, resource names, evidence, hostnames, source summaries and links are never copied into push payloads. Open the incident in the authenticated app to inspect those details. The gateway injects its bound `connection_id`; installations cannot supply one in delivery requests.

Successful gateway responses mark `accepted`. Invalid tokens or revoked/missing bindings mark `invalid` and deactivate the device. Other permanent failures mark `permanent_failure`. Network errors, 408, 429 and 5xx responses retry with exponential backoff beginning at 15 seconds, capped at one hour, for at most eight attempts. The gateway bounds its receipt retry window separately from the maximum 60-second TTL of each provider handoff. Durable receipts suppress repeated handoffs after an acknowledged success. A timeout or crash during an uncertain provider handoff may cause duplicate delivery when retried; provider collapse identifiers reduce visible repetition but do not guarantee exactly-once delivery. Terminal outbox records are removed after 30 days, at most 200 per cron tick. Accepted means provider handoff, not guaranteed display on a device.

## Verification

Run `node --test tests/mobile-backend.test.js` for pure validation, eligibility, projection and response handling checks.

`tests/mobile.integration.py` creates and removes its own temporary database and Docker container. Set `I7Y_TEST_POCKETBASE_BINARY` to a Linux PocketBase 0.40.4 binary and run `python3 tests/mobile.integration.py`. Docker must be available; the test uses `alpine:3.22` and a loopback-only published port. It copies hooks into a temporary directory and adds test-only routes there. It never attaches test routes to the real backend. The integration exercises single-use proof races, audience isolation, server binding, session restrictions, device ownership, encrypted delivery, no historical replay, revoked membership and stale/claimed notice cancellation.
