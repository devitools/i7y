# Server observation ownership

Ordinary inventory API requests can edit server identity, relationships and
credential references. They cannot change `status`, `inventory_known` or
`sort_order`: request hooks reject values that differ from the existing record.
Creating a server without these fields preserves schema defaults (empty provider
status, false inventory confirmation, zero ordering). Submitting unchanged legacy
values remains compatible with clients that send a complete record.

The guard applies to user sessions, including organization/global administrators,
and user-bound API tokens. PocketBase superuser database maintenance is outside
that product boundary and retains its existing access.

The hooks run on collection create/update requests, not on internal record saves.
Collector/import routes using `app.save` continue to own observation writes. An
agent observation can confirm `inventory_known` after complete Docker discovery.
Agent connectivity alone does not assert a provider contract status such as ACTIVE.
No migration clears old observations or removes their schema fields. Human project
creation must not issue a separate inventory-confirmation PATCH against its server.
