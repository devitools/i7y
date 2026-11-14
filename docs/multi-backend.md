# Connections and the incident inbox

Desktop and mobile keep independent connections to i7y installations. Each profile has a stable local ID, verified backend address, installation identity, display name, and its own user session. One account is supported per installation profile. Existing single-connection preferences and secure credentials migrate on upgrade.

Inventory and alert configuration remain scoped to the selected organization. The incident inbox combines authorized organizations from every connected installation. Opening an incident or responding to a notification uses its original connection and organization; it does not implicitly change inventory or MCP context. Identical record IDs from different installations remain separate records.

Adding a connection preserves existing sessions. Signing out clears that connection's session and push binding. Removing a profile also removes its preferences; failed offline revocations remain queued for retry. Transient failures do not sign out other connections. The inbox identifies unavailable sources and retains results from healthy ones.

## Backend inbox API

These routes require a human user session. Organization-scoped API tokens cannot widen their access through the inbox. The current inventory `X-I7y-Organization` header does not restrict the central inbox; use the optional `organization` query parameter to select an authorized organization.

| Method and path | Result |
| --- | --- |
| `GET /api/i7y/alerts/v1/inbox` | Existing incident page envelope, across authorized organizations. |
| `GET /api/i7y/alerts/v1/inbox/notification-events` | Existing notice envelope with a cursor and combined open count. |

Incident lists accept the existing incident filters and pagination parameters. Every row includes `organization`, `organization_name`, and `organization_role`. Ordering is descending `opened_at`, `created`, then `id`. Notifications include the same organization metadata. Each response reads authorization, rows and cursors from one database snapshot. Clients isolate route identities, queries and cursors by connection and user session, and merge source pages without discarding buffered rows.

Desktop discovery and mobile info advertise the `inbox` capability. New clients can fall back to organization-scoped v1 routes when an inbox route returns 404. Mutations continue through existing organization-scoped routes and keep their version checks.

## Moving an external integration

`POST /api/i7y/alerts/v1/integrations/{id}/transfer/preview` accepts `destination_organization` and returns a `plan_hash`, history counts, preserved incident IDs, and inventory links that will be cleared. `POST /api/i7y/alerts/v1/integrations/{id}/transfer` requires the destination and that exact hash. Both require administration of source and destination organizations and the source organization header.

Application is transactional and replayable. The integration ID, credential, endpoint, incident IDs, evidence, and history remain available in the destination organization. Source inventory links are cleared without moving inventory. Active claims remain only when their owner has destination access. Pending deliveries in the previous context are cancelled and migration is audited. A changed source requires a new preview.

An exact previously accepted idempotent source request can still be replayed with its original organization/workspace fields and organization header. Its stored payload hash and committed transfer history must match. New generic events that explicitly supply organization or workspace context must use the destination context after transfer. Cloud Monitoring events normally omit those optional binding fields, so their source endpoint and configuration stay unchanged.

## Push gateway transition

`push.devi.tools` is the canonical shared gateway. Application/provider profiles and the generic v2 API are documented in [the gateway guide](../apps/push-gateway/README.md). The gateway stores device registrations and bounded sending capabilities; installation user sessions remain with their own backends and clients.

Published mobile clients use their embedded legacy gateway address. Keep that HTTPS address and the v1 API working directly while those versions remain supported. It can proxy to the canonical service using [the legacy proxy configuration](../deploy/push-legacy-proxy.conf). Clients reject HTTP redirects. The [compatibility Compose file](../deploy/compose.push-legacy.yaml) replaces the previous gateway service in its existing Compose project, preserving its public hostname while forwarding to the canonical writer.

Preserve the gateway database and encryption key together. Stop the previous writer before taking the final consistent copy and starting the replacement writer. Keep the compatibility host pointing to the same store rather than running two independent gateway databases. Provider identities and existing device capabilities must survive the transition.

Existing installations retain `I7Y_PUSH_GATEWAY_URL` as their legacy advertised/sending origin during transition. Add the canonical address to comma-separated `I7Y_PUSH_GATEWAY_URLS`; mobile discovery exposes the validated list as `push_gateway_urls` without changing `push_gateway_url`. New installations can use the canonical origin directly. Backends advertise only HTTPS origins; additional origins do not enable push without a valid encryption key and primary gateway configuration.

## Independent installation

[The instance Compose file](../deploy/compose.instance.yaml) attaches a fresh backend to the existing reverse-proxy network without publishing its database or application port. Supply `I7Y_IMAGE` and `I7Y_DOMAIN` through the deployment environment and keep runtime secrets in a private `backend.env`. Use a separate persistent `data` directory and newly generated backend keys for each installation. Bootstrap its first administrator and provision collector credentials through the existing installation flow.

Desktop MCP transport stays local to the installed app. Its transport credential is separate from backend sessions; authorization and reviewed operations remain bound to an explicit backend, organization and user.
