# Container API

The API manages i7y inventory records. These operations do not create, start, stop or remove containers on Docker hosts.

## Authentication

Sign in through the `users` collection, as described in the [authentication guide](api-auth.md). Reads and writes require a valid user session or agent API token.

```sh
curl http://localhost:8097/api/collections/users/auth-with-password \
  -H 'Content-Type: application/json' \
  -d '{"identity":"user@example.com","password":"YOUR_PASSWORD"}'
```

Copy the response's `token` into the `I7Y_TOKEN` environment variable for your terminal session. Never store tokens in source code.

## Find a project

A container belongs to an existing project, identified by its record ID.

```sh
curl --get http://localhost:8097/api/collections/projects/records \
  -H "Authorization: Bearer $I7Y_TOKEN" \
  --data-urlencode 'filter=name="example-app"' \
  --data-urlencode 'expand=server.workspace'
```

Paginated responses contain `page`, `perPage`, `totalItems`, `totalPages` and `items`. Use the matching item's `id` as `PROJECT_ID` below.

## Create

```sh
curl http://localhost:8097/api/collections/containers/records \
  -H "Authorization: Bearer $I7Y_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"project":"PROJECT_ID","name":"example-app.web","image":"nginx:1.27","sort_order":0}'
```

Success returns HTTP 200 and the created record, including `id`. `project` is a required relation. Supply `name` and `image` to identify the container and image version. `sort_order` is an optional sorting number. Names and images are metadata; the API does not verify that an image exists in a registry.

## List and filter

```sh
curl --get http://localhost:8097/api/collections/containers/records \
  -H "Authorization: Bearer $I7Y_TOKEN" \
  --data-urlencode 'page=1' \
  --data-urlencode 'perPage=50' \
  --data-urlencode 'filter=project="PROJECT_ID"' \
  --data-urlencode 'sort=sort_order,name' \
  --data-urlencode 'expand=project.server.workspace'
```

Use `filter=image="nginx:1.27"` for an exact image match. Expanded relations appear under `expand`; original relation IDs remain unchanged.

## Read a container

```sh
curl 'http://localhost:8097/api/collections/containers/records/CONTAINER_ID?expand=project.server.workspace' \
  -H "Authorization: Bearer $I7Y_TOKEN"
```

## Update an image, name or project

Send only the fields to update. Changing `project` moves the inventory record to another project.

```sh
curl -X PATCH http://localhost:8097/api/collections/containers/records/CONTAINER_ID \
  -H "Authorization: Bearer $I7Y_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"image":"nginx:1.28","name":"example-app.web"}'
```

Success returns HTTP 200 and the updated record.

## Delete

```sh
curl -X DELETE http://localhost:8097/api/collections/containers/records/CONTAINER_ID \
  -H "Authorization: Bearer $I7Y_TOKEN"
```

Success returns HTTP 204 without a response body. Inventory deletion is permanent. Deleting the parent project, server or workspace also deletes its containers through cascading relations.

## Errors

Error responses contain JSON with `status`, `message` and, for validation failures, field-level errors in `data`. Invalid relations or unauthorized creation can return 400. Missing records or unauthorized updates/deletions can return 404; that status alone does not distinguish a missing record from insufficient permissions.

Refresh a valid session using `POST /api/collections/users/auth-refresh` with `Authorization: Bearer TOKEN`. Sign in again after the session expires.

## Frontend TypeScript client

The shared frontend client uses the current interface session:

```ts
import { management } from './api'

const result = await management.list('containers', {
  page: 1,
  perPage: 50,
  filter: `project="${projectId}"`,
})
const container = await management.create('containers', {
  project: projectId,
  name: 'example-app.web',
  image: 'nginx:1.27',
})
await management.update('containers', container.id, { image: 'nginx:1.28' })
await management.remove('containers', container.id)
```

Normal restarts preserve database changes. Legacy inventory import is optional and requires explicit backend configuration.

## Password-free agent access

Create an agent token through **API tokens** in i7y. Use `Authorization: Bearer TOKEN` instead of sharing user credentials. The [authentication guide](api-auth.md) covers permissions, expiration, revocation and examples.
