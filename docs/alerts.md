# Alerts and incidents

The **Alerts** menu configures rules and incoming integrations. The **Incidents** menu lists the problems requiring attention. Rules evaluate existing collector observations; GCP can create incidents directly. This release provides in-app notices while signed in, not email, native push or a mobile application.

## Type rules (v2)

New rules cover every current and future `server` or `container` in the selected organization. Workspaces and individual inventory records no longer define coverage. Each rule/resource pair still has at most one open incident. Supported metrics and severity escalation come from the live metric catalog; this change does not activate container rules or add collector capabilities.

Each rule has `reminder_intervals` in seconds, keyed by the severities the condition can produce. Intervals accept 60–604800 seconds. The UI displays minutes. A new rule starts at 1800 seconds. Confirmation duration is separate: the opening notice follows confirmed entry, while subsequent notices follow the current severity's interval. A severity change keeps the incident ID, evidence, opening time and active claim, invalidates outdated notices and selects the new interval. Cadence-only edits reschedule notices without resetting evaluation. Existing external integrations retain their separate single interval.

Exclusions belong to one rule and use stable inventory IDs. They record a required reason, author and creation time. Adding an exclusion closes its open occurrence with `resource_excluded`, invalidates pending notices and preserves history; it does not report recovery. Other resources and conditions keep their existing evaluation and incidents. Removing an exclusion requires post-inclusion observations and a new confirmation window for that resource. Deleting or transferring a target preserves the organization-wide rule and historical exclusion record. A Docker recreation that reconciles to the same inventory record retains that record's exclusion.

No-communication conditions are evaluated every minute without waiting for a snapshot. `server.no_communication_seconds >= 900` is the migration default, with critical severity and a 1800-second reminder. Existing enrolled servers use their last accepted observation; never-reporting or newly enrolled collectors receive an enrollment grace period. Stale queue replays cannot fabricate current contact. Servers without collector credentials do not generate this incident. Fresh contact can close it as recovered.

Rule management uses `/api/i7y/alerts/v2`: `GET /metrics`, `GET /rules`, `GET /rules/{key}`, `PUT /rules/{key}`, `DELETE /rules/{key}`, and `POST /rules/simulate`. Send `X-I7y-Expected-Revision` with the current `edit_version` for updates/archives or zero for creation. The backend validates organization ownership, compatible types and unique exclusions. Simulation returns coverage counts and paginates included, unknown and excluded results without enforcing confirmation duration. Incident, notice and integration endpoints remain v1.

Example declaration:

```json
{
  "model_version": 2,
  "name": "Memory usage",
  "target_type": "server",
  "condition": {"metric": "host.memory_percent", "operator": "gt", "value": 80, "critical_value": 90},
  "severity": "warning",
  "duration_seconds": 300,
  "reminder_intervals": {"warning": 1800, "critical": 300},
  "enabled": true,
  "exclusions": [{"resource_type": "server", "resource_id": "SERVER_RECORD_ID", "reason": "Accepted saturation"}]
}
```

## Migrating existing rules

Schema migration only adds compatibility fields and private collections. It does not consolidate or activate production rules automatically. Deploy hooks and schema together, verify a protected database backup, and rehearse against a disposable copy before applying the reviewed data migration.

`POST /api/i7y/alerts/v2/migration/preview` accepts `options` and returns a plan hash, source/destination declarations, coverage expansion, exclusions, open incidents and conflicts. Defaults change CPU reminders to 1800/1800 and disk reminders to 1800/300; other metrics preserve their existing interval. The plan adds a no-communication rule if absent. `options.reminder_overrides` can explicitly choose other per-metric severity intervals; `options.exclusions` specifies a metric, resource type, resource ID and reason. `options.no_communication_seconds` controls the new communication threshold.

Conditions, severity, confirmation and enabled state must agree before consolidation. Divergent definitions, overlapping open incidents, destination key collisions and unexplained cadence differences are reported as conflicts. Disabled rules are never silently enabled. Coverage intentionally expands to current and future resources of the selected type in the organization; review the newly included list.

`POST /migration/apply` requires a human editor/admin session, the reviewed `plan_hash` and exact normalized `options`. Rule versions, declarations and inventory relationships are rechecked. The transaction creates consolidated rules, transfers compatible evaluation states and open incidents, applies exclusions, reschedules reminders and archives source rules. Closed historical incidents retain their source-rule links. Open IDs, opening times, evidence and claims remain intact. External API/GCP incidents and integrations are not selected. Notifications are not manufactured by the transfer. Repeating an applied hash returns its durable result rather than applying it again. MCP writes retain native review, exact-context binding and recoverable receipts.

A stale plan returns 409 without partial changes. Before commit, transaction failure rolls back the migration. After commit, rollback needs a compatible release or controlled backup recovery with reconciliation of later observations; re-enabling the old rules alone cannot preserve type-rule exclusions. Keep source rule records and migration mapping for audit.

Legacy v1 rules remain readable during rollout. Their writes are blocked after type rules exist in the organization, and v2 editing of a legacy rule requires migration. This prevents older clients from silently discarding exclusions or severity cadences. The desktop MCP exposes `preview_alert_rule_migration` and reviewed `apply_alert_rule_migration` in addition to the updated rule schema.

## Legacy rule behavior

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

### Type-rule integration verification

Run `tests/type-alerts.integration.py` with `I7Y_TEST_ACCESS` pointing to a disposable loopback backend. It verifies migration, replay, claims, version conflicts, isolation, exclusions and legacy-write guards. For scheduler/contact recovery coverage, copy `tests/fixtures/alerts-clock.pb.js` into that disposable backend's hooks and set `I7Y_TEST_TICK=1`. This fixture permits changing test enrollment time; never package it in a production image or run it on a real backend. Run `npm test`, `npm run typecheck`, `npm run build:web`, and the Rust MCP tests.
