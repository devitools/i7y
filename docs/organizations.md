# Organizations

Users access inventory through organization memberships with `admin`, `editor` or `reader` roles. Send `X-I7y-Organization` to select a context; API tokens are restricted to their organization. Global administrators can manage organizations across contexts.

The initial organization is created by the backend schema migration with the generic name `Initial organization`. Existing organization names are preserved. Installation-specific migrations and activation records are not distributed with the product.

Organization management uses authenticated routes under `/api/i7y/organizations`; inspect `apps/backend/hooks/organizations.pb.js` for the supported operations and validation.
