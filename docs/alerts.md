# Alerts and incidents

The **Alerts** menu configures rules and incoming integrations. The **Incidents** menu lists the problems requiring attention. Rules evaluate existing collector observations; GCP can create incidents directly. This release provides in-app notices while signed in, not email, native push or a mobile application.

## Rules

A rule has a stable key within its organization, a name, severity (`info`, `warning`, `critical`), scope, one condition, minimum duration and reminder interval. Workspace scopes automatically include new matching resources. Server scopes can target the host or its containers. Each rule/resource pair has at most one open incident. Disk rules can select one mount path or `*`; affected disks share one server incident.

Warning host CPU, memory and disk rules using `gt` or `gte` can add a numeric `condition.critical_value` above their base threshold and at most 100. For example, `value: 80`, `critical_value: 90`, and `operator: "gt"` warns above 80%, becomes critical above 90%, and recovers at 80% or below. Severity changes preserve the incident ID, opening time and active claim, advance its version, and record a `severity_changed` event. Missing affected-disk evidence cannot establish recovery or demotion. Rules without this field keep their configured severity.

Enabled rules have no expiration. `duration_seconds: 0` evaluates the first eligible observation without waiting for sustained usage. Discover escalation support through the selected metric's `supports_critical_value` capability; the desktop rejects saving or simulating this extension when that metric lacks support on the backend.

CPU and host-memory rules confirm warning and critical entry independently using `duration_seconds`. With a 300-second duration, usage above 80% must persist for five minutes to open an incident, and usage above 90% must independently persist for five minutes to enter critical severity. A single 95% sample after an established warning does not escalate immediately. Initial usage sustained above 90% for five minutes can open a critical incident directly. Unknown observations or gaps reset pending confirmation; they cannot establish recovery or demotion. A fresh usable reading at 90% or below can demote critical to warning, and a subsequent escalation requires a new confirmation period. Disk rules preserve their existing duration behavior: duration confirms opening, then fresh observations change the severity without a separate upper-band wait.

Host-memory usage is `100 * (memory_total_bytes - memory_available_bytes) / memory_total_bytes`, using the collector's available-memory observation rather than a free-memory-only counter. Zero, missing or inconsistent totals/availability are unknown observations and cannot establish recovery.

Simulation previews the current threshold match and potential severity without confirming duration or saving a rule. Sustained usage is established by accepted collector observations over time; a preview is not evidence that five minutes of saturation have elapsed.

Rules evaluate raw accepted observations, not copied display metrics. Host observations and Docker state can be evaluated on event snapshots; container CPU/memory require a metrics observation. Observations older than 15 minutes, duplicate samples and observations that did not advance reconciliation cannot change incidents. A tolerated future timestamp is capped at reception time. Duration confirmation resets on negative/invalid observations or gaps greater than 10 minutes. Missing metric families in event-only reports do not advance confirmation. Unknown data and disappearing affected disks never establish recovery.

No-communication rules apply to servers with active collector credentials. The grace period begins when the rule is enabled or the collector enrolled, whichever is later. Old queue replays do not establish current communication. The default threshold is 900 seconds; regular collector metrics arrive every 300 seconds.

Changing scope, condition or duration starts a new evaluation revision and closes previous occurrences with an administrative reason. Disabling suspends evaluation and notices while preserving open incidents. Re-enabling waits for fresh observations. Archiving or removing/transferring a target preserves historical evidence and closes its prior bindings administratively.

## Incident workflow

Opening creates an actionable notice immediately. All current organization members can see notices. Recurrence defaults to 900 seconds and accepts 60 through 604800 seconds. The scheduler checks every minute, coalesces pending notices, and emits at most one current reminder after downtime.

Editors and administrators can claim an incident with a future UTC deadline, up to seven days ahead. The claim pauses notices for everyone. Only the active owner may extend it; anyone with editing permission may claim after expiry. Changes use an incident `version`; a stale or competing action returns 409. Recovery closes the incident even during a claim.

Manual resolution of a collector incident does not disable its rule: another eligible positive observation can create a new occurrence. Manual resolution of an external occurrence is final for that external identifier. Repeated GCP notifications cannot reopen it; the source must create a new incident identifier.

## API

All management endpoints use `/api/i7y/alerts/v1` and the selected `X-I7y-Organization`. Send the normal user session or a deliberately scoped API token as `Authorization: Bearer TOKEN`.

| Method and resource | Result |
| --- | --- |
| `GET /metrics` | Metric identifiers, compatible targets, units, comparisons and states. |
| `GET /rules`, `GET /rules/{key}` | Rule listing/detail. |
| `PUT /rules/{key}` | Create or replace a rule declaration, returning 200. |
| `DELETE /rules/{key}` | Archive, returning 204; the key remains reserved. |
| `POST /rules/simulate` | Evaluate the draft against current data without writes or duration confirmation. |
| `GET /incidents`, `GET /incidents/{id}` | Paginated list or detail including audit events. |
| `POST /incidents` | Direct creation, returning 201. Machine callers must provide `Idempotency-Key`. |
| `POST /incidents/{id}/claim` | Claim/extend with `claim_until` and `version`. |
| `POST /incidents/{id}/resolve` | Resolve with `version`. |
| `GET/POST /integrations`, `GET/PATCH/DELETE /integrations/{id}` | Session-only configuration; DELETE disables and revokes. |
| `POST /integrations/{id}/rotate` | Replace the credential and reveal the new secret once. |
| `POST /integrations/{id}/events` | Generic authenticated source ingress. |
| `POST /integrations/{id}/gcp` | Cloud Monitoring source ingress. |
| `GET /notification-events?cursor=0&limit=100` | Current valid notices, next cursor and open count. |

Example rule declaration:

```json
{
  "name": "Disk capacity",
  "scope_type": "server",
  "scope_id": "SERVER_RECORD_ID",
  "condition": {"metric": "host.disk_percent", "operator": "gt", "value": 90, "disk_path": "*"},
  "severity": "warning",
  "duration_seconds": 0,
  "reminder_seconds": 900,
  "enabled": true
}
```

Incident lists accept `status` (default `open`, or `resolved`/`all`), `severity`, `origin`, `resource_type`, `resource_id`, `workspace_id`, `server_id`, `assignee`, `overdue`, `search`, `page` and `perPage` (up to 100). Lists return `items`, `page`, `perPage`, `totalItems` and `totalPages`. Notice cursors are organization-specific positions, not access credentials or delivery acknowledgements. Claim, recovery, disabled sources and membership removal invalidate previously pending notices.

## Permissions and source credentials

Readers can consult; editors and administrators can configure and act. Existing inventory API tokens gain no alert access automatically. New token capabilities are `alerts:read`, `alerts:write`, `incidents:read`, `incidents:create` and `incidents:resolve`. Claims and integration credential management require a human session. Tokens cannot use desktop authentication or mint other credentials.

Integration credentials are separate `i7yh_` secrets, shown once and stored as hashes. They authorize only that integration's source events, not inventory, lists, rules, claims or other sources' incidents. The organization and optional workspace are fixed by the integration, never by the received payload. Rotation preserves source identity. Idempotency keys are scoped to the authenticated producer and operation; reuse with different content returns 409.

For generic ingress, use a bearer integration token and a body such as:

```json
{"external_id":"source-occurrence-123","state":"open","title":"Service unavailable","severity":"critical","resource_name":"example-service","evidence":{"detail":"Health check failed"}}
```

Send `state: "closed"` with the same external ID to resolve. Closed-before-open is remembered without issuing an opening notice. Source IDs are isolated by organization and integration.

## GCP configuration

Create a GCP integration in Alerts, then configure a Cloud Monitoring webhook notification channel using its public HTTPS endpoint. Use Basic authentication: username is the integration ID; password is its generated credential. The receiver supports Cloud Monitoring schema `1.2`, including `incident.incident_id` and `open`/`closed`. Error Reporting schema `1.0` is not accepted. Optional fields may be absent; source summaries are never parsed for identity or state. Rejected payloads do not create incidents. The UI displays the latest accepted receipt.

Source text is escaped; only HTTP(S) links are clickable. No source-provided URL is fetched by ingestion. Payloads are limited to 256 KiB, with additional field/evidence bounds. Configuring an endpoint does not configure or deploy GCP resources automatically.

## Verification

Run `npm test`, `npm run typecheck` and `npm run build:web`. `tests/alerts.integration.py` requires `I7Y_TEST_ACCESS` pointing to a test-only JSON file containing `url` (loopback), `admin_token` and optional fixture metadata. It creates records and must only run against a disposable database. Optional `I7Y_TEST_TICK=1` uses a test-only clock endpoint that must never be installed in production.

Migrations create private collections and add empty token capabilities; no real inventory rule is activated automatically. Preserve the database backup and compatible application version when upgrading. The alert engine shares the existing PocketBase process, so a stopped backend cannot issue notices until service is restored.

Publish the backend hooks and migrations together before using this feature from a newer web or desktop client. Older deployments may return the site HTML for unknown API paths; the client identifies that response and explains that the selected backend needs an update.
