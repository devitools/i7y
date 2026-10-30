# Project repositories

Project records can store the source repository URL, deployment branch, and the path of the deployment template relative to that repository. These fields describe the source code used for deployments; the server's deployment Git remote is a separate concern.

`version_control_status` is `unknown`, `versioned`, or `unversioned`. Existing projects and newly discovered projects start as `unknown`. An empty repository URL does not imply that a project is unversioned. A project explicitly marked as unversioned cannot retain repository details.

Organization readers can view these fields. Existing project editing permissions control writes. Repository links accept HTTP or HTTPS URLs without credentials, query parameters, or fragments. Deployment templates must use relative paths without parent traversal.

The project inventory view includes these fields in its payload and searches the repository URL, branch, and template. Inventory exports include the same metadata. Agent snapshots continue to update operational inventory without changing the manually maintained repository fields.

Validation: `npm test`, `npm run build:web`, and `tests/project-repositories.integration.py` against a disposable loopback PocketBase instance configured through `I7Y_TEST_URL` and `I7Y_TEST_ACCESS`.
