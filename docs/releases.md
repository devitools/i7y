# Release artifacts

The **Build release artifacts** workflow builds a single main-branch commit into:

- macOS app ZIP and DMG bundles for Apple Silicon and Intel, including the MCP sidecar.
- Web frontend archive.
- Multi-platform backend OCI container archive for Linux amd64 and arm64, plus backend source files.
- Multi-platform push gateway OCI container archive and standalone gateway source files.
- Linux amd64/arm64 agents and the Windows amd64 host agent.
- Build metadata and SHA256SUMS for the release assets.

Run the workflow from `main` with a new `vMAJOR.MINOR.PATCH` tag, or push that tag on a commit already included in `main`. Every job checks out the resolved commit SHA. All components are rebuilt together so a release is a complete, consistent snapshot. The desktop bundle and agent versions follow the release tag.

All tests and builds must succeed before assets are attached to a **draft** GitHub release. Review the assets and generated notes before publishing. Existing published releases cannot be overwritten by this workflow. Rerunning a draft replaces its assets for the same tag and commit. Workflow artifacts remain available for 14 days if another build job fails.

macOS currently uses ad-hoc signing because no Developer ID certificate or notarization credentials are configured in GitHub. These artifacts are suitable for internal testing; they do not provide a notarized public installer. The existing local signing configuration is not uploaded or read by CI. Store distribution and mobile builds use their separate release processes.

The OCI archive can be imported into a container registry with an OCI-aware tool such as `skopeo copy oci-archive:i7y-backend-VERSION.oci.tar docker://REGISTRY/IMAGE:VERSION`. The workflow does not deploy the backend or modify the production database.
