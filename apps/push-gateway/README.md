# i7y central push gateway

Standalone Go service that owns native APNs/FCM credentials and device tokens. Self-hosted i7y servers receive only a revocable capability for one binding. The server owns its durable event outbox; this gateway performs a synchronous, bounded provider handoff and keeps hash-only delivery receipts.

## Run

Use Go 1.25 or later for local development:

```sh
go test -race ./...
go vet ./...
go build -o /tmp/i7y-push-gateway .
```

The container build pins Go 1.27.3 and needs no C compiler. From this directory:

```sh
cp .env.example .env
openssl rand -base64 32
```

Set `GATEWAY_ENCRYPTION_KEY` to that generated value. Keep it in your secret store and preserve it across restarts. Mount your actual provider credentials read-only under `/run/secrets`, set their file paths in `.env`, and set `GATEWAY_SECRETS_DIRECTORY` in your shell or Compose `.env` to that existing host directory. No provider credentials are included.

```sh
docker compose up --build -d
curl --fail http://127.0.0.1:8080/healthz
```

Terminate HTTPS at your reverse proxy. Keep the service port private and disable request-body, Authorization-header, and provider-URL logging at that proxy. The application logs only startup/fatal operational messages, never tokens, request bodies, provider response bodies, or receipts. Plain HTTP is intended for the private proxy hop only. No service has been deployed by these files.

| Variable | Meaning |
| --- | --- |
| `GATEWAY_ENCRYPTION_KEY` | Required base64 32-byte AES-GCM key. A startup check rejects a different key for an existing store. |
| `GATEWAY_ALLOWED_APPS` | Required comma-separated exact `platform:app_id:environment` triples. Example file permits the iOS development bundle and Android package `com.devitools.i7y.mobile`. Add the iOS `production` triple only when distributing a production-signed build. |
| `GATEWAY_DB_PATH` | SQLite file; default `/data/gateway.db`. Persist the whole containing directory, including WAL files. |
| `GATEWAY_LISTEN` | Default `:8080`. |
| `GATEWAY_TRUSTED_PROXY_CIDRS` | Optional comma-separated proxy CIDRs. Only these peers may supply `X-Forwarded-For`; the nearest untrusted address is the client. Your proxy must append or overwrite the header. By default forwarding headers are ignored. |
| `APNS_PRIVATE_KEY_FILE` | Path to an Apple PKCS#8 P-256 `.p8` signing key. |
| `APNS_KEY_ID`, `APNS_TEAM_ID` | Apple signing key identifier and team identifier. |
| `APNS_PRODUCTION_PRIVATE_KEY_FILE`, `APNS_PRODUCTION_KEY_ID`, `APNS_PRODUCTION_TEAM_ID` | Optional dedicated production APNs signer. Production devices use this signer when configured; sandbox devices retain the existing `APNS_*` signer. JWT caches remain separate. |
| `FCM_SERVICE_ACCOUNT_FILE` | Path to Google service-account JSON containing an RSA PKCS#8 key, project ID, and client email. The account needs FCM send permission in that project. |

Every allowlisted platform must have its provider configured. One Apple team and one Firebase project are supported per gateway process. Android development and release builds use the Firebase project configured in the app; the environment field is an ownership namespace, not a separate FCM host. The FCM request restricts delivery to the allowlisted package name. Provider endpoints are fixed in production code; callers cannot select a provider URL.

Run exactly one gateway instance per database on a local filesystem. A process lock prevents concurrent owners; SQLite transactions and a process mutex serialize enrollment, rebinding, revocation, and provider handoffs. This initial design favors revocation correctness over high throughput. At most 32 HTTP handlers are admitted, with a 12-second request deadline and an 8-second provider deadline; saturated requests receive 503. Do not place SQLite on network storage. Graceful shutdown allows up to 15 seconds for active requests.

## Device enrollment

1. The app obtains the native device token, then starts enrollment:

```http
POST /v1/registrations
Content-Type: application/json

{"platform":"ios","token":"<native APNs token>","environment":"sandbox","app_id":"com.devitools.i7y.mobile"}
```

Android uses `platform: "android"` and `environment: "production"` with its native FCM token. The token is never sent to an i7y server. Only exact configured application/environment triples are accepted. APNs tokens must be even-length hexadecimal strings of at most 1024 characters; their opaque native length is preserved, including longer simulator tokens; Android tokens must be 20–4096 bytes.

2. A single innocuous challenge alert is handed to the provider. The 201 response is `{"registration_id":"…","expires_at":"…"}`. Challenge notification data is:

```json
{"kind":"registration_challenge","registration_id":"…","nonce":"…"}
```

The nonce appears only in the push, never the start response. The app must only confirm a challenge matching enrollment initiated by its current session. Buffer foreground challenge delivery if it arrives before the HTTP start response. Enrollment expires after five minutes and has at most five proof attempts. Starts are limited to 10 per source IP and 3 per destination in each fixed ten-minute bucket; proof requests are limited to 30 per IP and 8 per registration. Unknown/expired proof failures are generic. These limits require correctly configured trusted proxies when HTTPS terminates upstream.

3. Complete possession proof:

```http
POST /v1/registrations/<registration_id>/confirm
Content-Type: application/json

{"nonce":"<nonce received on this device>"}
```

The 200 response is `{"device_id":"…","management_token":"…"}`. Store the management capability in the platform secure store. Each successful proof atomically rotates management authority, revokes every earlier send binding for the same provider/application/environment/native-token destination, and consumes all outstanding proofs for that destination. This also handles reinstallations that lost local IDs. A registration awaiting proof cannot create a send capability.

Token rotation uses full re-enrollment followed by binding creation. When the OS issues a different native token, revoke the previous binding using its stored management capability first when available. If a reinstall receives a different token and loses its old capability, the gateway cannot cryptographically associate it with the prior token; provider invalidation and the 60-second message TTL limit that old destination. Same-token re-enrollment always revokes previous authority.

## Bind and revoke

```http
POST /v1/bindings
Authorization: Bearer <management_token>
Content-Type: application/json

{"device_id":"…","connection_id":"…","server_instance_id":"…"}
```

The 201 response is `{"binding_id":"…","send_token":"…"}`. Binding creation atomically replaces every earlier binding for this device. The app sends only this binding ID and send capability to its authenticated i7y connection. Never give the server the management capability or raw native token. `connection_id` and `server_instance_id` are identifiers, not network addresses or destinations.

```http
DELETE /v1/bindings/<binding_id>
Authorization: Bearer <management_token>
```

A successful revocation returns 204. It works while the previous i7y server is offline. Old server sends and retries are rejected after revocation commits. A provider handoff already in progress completes before revocation commits and may still arrive during its remaining TTL.

## Send an incident summary

```http
POST /v1/bindings/<binding_id>/notifications
Authorization: Bearer <send_token>
Idempotency-Key: <stable event delivery ID>
Content-Type: application/json

{"event_id":"event-1","incident_id":"incident-1","organization_id":"org-1","title":"CPU threshold exceeded","resource":"api-1","severity":"critical","ttl":60}
```

Only these fields are accepted. `connection_id` is injected from the authorized binding. Identifiers and the idempotency key must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Title and resource are plain single-line UTF-8, at most 120 and 180 bytes. Severity accepts `critical`, `high`, `medium`, `low`, `info`, `warning`, or `error`. TTL must be 1–60 seconds. Request bodies are capped at 4096 bytes; provider payloads are also capped at 4096 bytes. Include only public summaries: never evidence, credentials, or detailed incident bodies. The gateway cannot determine whether otherwise valid prose is sensitive, so callers must enforce that content boundary.

| HTTP | Response | Server behavior |
| --- | --- | --- |
| 202 | `{"status":"accepted","code":"provider_accepted"}` | Provider accepted the handoff. This is not a device delivery receipt. Complete the server outbox entry. |
| 503 | `{"status":"retryable","code":"provider_unavailable"}` | Retry the same binding, key, and payload after `Retry-After: 5`, within the fixed 300-second receipt retry window. |
| 503 | `{"status":"retryable","code":"handoff_unknown"}` or `handoff_pending` | Delivery may already have been handed off. Same-key retry may duplicate an alert after a network failure or process crash. |
| 422 | `{"status":"permanent_failure","code":"invalid_token"}` | Provider invalidated the native token. The gateway also revokes all destination bindings. Require device re-enrollment. |
| 422 | `{"status":"permanent_failure","code":"provider_rejected"}` | Permanent provider rejection. Do not retry this delivery. |
| 422 | `{"status":"permanent_failure","code":"expired_or_exhausted"}` | The fixed 300-second receipt retry window elapsed or five provider attempts were consumed. Do not retry this delivery. Earlier ambiguous attempts might have reached the device. |
| 401 | `{"error":"unauthorized"}` | Invalid, cross-device, or revoked capability. Disable the local sender binding. |
| 409 | `{"error":"idempotency_conflict"}` | The same binding/key was used with a different canonical payload. |
| 400 | `{"error":"invalid_notification"}` or another validation error | Fix the request; do not retry it unchanged. |

Other 503 responses include `gateway_busy` or `request_expired` under `error`. The backend must treat all 503 responses and network failures as retryable under its own durable policy. Provider credential/configuration failures are retryable within the same bounded attempt/receipt-window budget so an operator can fix configuration without invalidating device tokens.

The canonical decoded notification JSON, before binding data is injected, determines the payload hash. Each binding/key hash has durable `pending`, `retryable`, `accepted`, or `permanent_failure` state. The gateway commits a 15-second attempt lease before handoff, remembers accepted/permanent outcomes, and never retries in a background queue. A repeat accepted request returns the remembered result. Retries have a five-second delay and are permitted for up to 300 seconds from the first attempt, with at most five provider attempts. This receipt retry deadline is fixed and never extends. Each actual provider handoff gets its own requested message TTL, capped at 60 seconds from that handoff; provider authorization time consumes that short TTL. The independent receipt window allows a backend minute cron to retry a transient failure without extending any individual message's provider lifetime. There is no exactly-once promise across a provider handoff followed by a crash before receipt commit. The server must reuse the same event key and payload for retries.

APNs uses a native alert, HTTP/2, ES256 provider JWT, a short expiration, and a 64-character SHA-256 collapse identifier scoped to connection/organization/incident. FCM uses HTTP v1, service-account OAuth, native notification plus navigation data, Android channel `incidents`, and an incident-scoped display tag. Android display replacement does not guarantee one queued message per incident; FCM controls offline collapsible-message storage. The app must create the `incidents` channel and fetch authorized live incident details after a tap. Notification data is a navigation hint, never authorization.

## Storage and verification

Native tokens use AES-256-GCM with random nonces and destination-bound additional data. Destination lookup uses a SHA-256 hash of provider/application/environment/native token; management and send capabilities and challenge nonces are stored as SHA-256 hashes. Raw tokens, capability values, and notification payload bodies never enter receipt rows. Receipt rows contain only binding ID, idempotency/payload hashes, state/code, attempt count, and timestamps. Seven-day receipt retention is enforced on registration/send activity and by a five-minute janitor; expired proofs and old rate buckets are pruned alongside it. Backups need the same retention policy. Deleting a live SQLite row does not guarantee forensic erasure of old pages or backups.

Tests use fake providers or local mock HTTP servers only. They cover proof replay/expiry, rate/attempt bounds, cross-device capabilities, reinstall rebinding, offline previous senders, handoff/revocation serialization, concurrent deduplication and collisions, retry/restart/expiry behavior, ciphertext/capability storage, APNs HTTP/2/JWT/header shape, FCM OAuth/JWT/cache/native payload shape, and provider error classes. They require no Apple or Firebase account. Real-device delivery, signing entitlements, Firebase project setup, and proxy/deployment configuration remain operator integration work.

Provider references: [APNs HTTP/2 and token authentication](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html), [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [Google service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account), and [FCM collapse behavior](https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types).
