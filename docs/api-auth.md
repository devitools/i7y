# API authentication and tokens

## User sessions

Sign in with the email and password of a `users` record. PocketBase returns a session token used by frontend management requests. Access depends on organization memberships and the `admin`, `editor` and `reader` roles. Agent tokens are also limited to one organization. See [organizations](organizations.md) for context, invitation and permission contracts.

The internal PocketBase administrative collection is reserved for maintenance and is not used for i7y login. The initial migration copies existing administrative accounts into `users`, preserving password hashes without requiring the original passwords.

## Agent access

Sign in to i7y and choose **API tokens → Create API token**. Set:

- **Name:** identifies the agent or task.
- **Permission:** read only, or read and write (including deletion).
- **Expiration:** 1–365 days; the default is 30 days.

The secret starts with `i7y_` and is displayed only once after creation. Give the agent this token and the i7y URL. Do not share your email/password or browser session token. Revoke a lost key and create another one.

Example agent instruction:

> Use the i7y API at http://localhost:8097. The token is in I7Y_TOKEN. Send Authorization: Bearer followed by the token. Read records at /api/collections/containers/records. Never print the secret or save it in project files.

`localhost` refers to the machine running the agent. A remote agent needs a URL it can reach; the default Docker setup publishes the backend only on the local machine.

```sh
curl --get http://localhost:8097/api/collections/containers/records \
  -H "Authorization: Bearer $I7Y_TOKEN" \
  --data-urlencode 'expand=project.server.workspace' \
  --data-urlencode 'perPage=50'
```

A read/write token can also use `POST`, `PATCH` and `DELETE` on the four inventory resources. These operations do not start or stop actual containers.

## Access boundaries

| Credential | Access |
| --- | --- |
| User session token | Inventory, own profile and own API token management |
| Read-only agent token | GET records from the four inventory resources |
| Read/write agent token | GET, POST, PATCH and DELETE inventory records |

Agent tokens cannot access users, settings, authentication, session refresh, token creation, batch operations or realtime. Permissions apply to inventory workspaces in the token's organization. The `Authorization` header accepts the token with or without `Bearer`; clients should use `Bearer`.

Inventory is private. Every query and mutation requires a valid user session or agent token. Unauthenticated record requests return HTTP 401. The frontend redirects protected routes to login and resumes the requested link after authentication. Login does not load inventory records or display private navigation.

## Expiration and revocation

The server checks the token hash and expiration on every request. It never stores the secret as plain text. Token lists expose only metadata such as name, prefix, permission and expiration.

Choose **API tokens → Revoke** to review and confirm a key revocation on its own route. The key stops working on subsequent requests; your session and other keys remain valid. Deleting a user cascades to their keys. Changing a password does not replace key revocation.

Create a new token after expiration. Agents cannot renew their tokens or issue additional keys. Each user may hold up to 100 keys; revoke unused keys.

## Key management API

These endpoints require a `users` session token obtained through login. Agent tokens cannot call them.

| Method and path | Behavior |
| --- | --- |
| `GET /api/i7y/tokens` | List metadata for your own keys |
| `POST /api/i7y/tokens` | Create a key and return its secret once |
| `DELETE /api/i7y/tokens/ID` | Revoke one of your keys |

```sh
curl http://localhost:8097/api/i7y/tokens \
  -H "Authorization: Bearer $I7Y_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"Review agent","scope":"read","days":30}'
```

Creation returns HTTP 201 with `id`, `label`, `prefix`, `scope`, `expires_at`, `created` and `token`. Lists never expose `token` or its hash. An agent can call `GET /api/i7y/token` to inspect its own name, permission and expiration without access to other keys. Revocation returns HTTP 204. Invalid, expired or revoked agent tokens return 401; out-of-scope requests return 403.

## Development validation

`tests/api-tokens.integration.py` checks permissions, route boundaries, revocation, expiration and user isolation against a disposable backend. Set `I7Y_TEST_URL`, `I7Y_TEST_EMAIL` and `I7Y_TEST_PASSWORD`; the test environment needs a user and a superuser with those same test credentials. The script creates and deletes test records. Run it only against disposable data, never against a working inventory.

## First access to an empty installation

Create a maintenance superuser on a trusted local installation:

```sh
read -r -s I7Y_BOOTSTRAP_PASSWORD
export I7Y_BOOTSTRAP_PASSWORD
docker compose exec -e I7Y_BOOTSTRAP_PASSWORD pocketbase sh -c '/pb/bin/0.40.4/pocketbase superuser upsert admin@example.test "$I7Y_BOOTSTRAP_PASSWORD" --dir=/pb/pb_data'
unset I7Y_BOOTSTRAP_PASSWORD
```

Replace the example email. Open `http://127.0.0.1:8097/_/` locally and sign in with the maintenance account. Create the human user in `users` with an email, password and `global_admin=true`. Add an `admin` membership linking that user to the initial organization in `organization_memberships`. Sign in to i7y using the human user. The maintenance superuser is not an i7y login account and must remain restricted to local administration.

For remote servers, use an SSH tunnel to the loopback port. Do not expose the administrative interface publicly or store installation passwords/data in the repository.
