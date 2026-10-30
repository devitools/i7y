# i7y public site

Static site for `i7y.devi.tools`. English is served at `/`, `/support/`, and `/privacy/`; Brazilian Portuguese is served under `/pt/`. Product illustrations use synthetic accounts, server names, and telemetry.

Preview from the repository root:

```sh
python3 -m http.server 8765 --directory apps/site
```

## GitHub Actions deployment

The site deploy workflow publishes a standalone snapshot to a dedicated Tevun Git remote; it does not deploy the i7y backend or push gateway. The Tevun project and `i7y.devi.tools` DNS record must exist before enabling deployment. The snapshot uses the server's existing `reverse-proxy` network.

Configure the following on the `devitools/i7y` repository:

- Secret `DEPLOY_SITE_REMOTE`: SSH URL of the dedicated disposable Tevun Git repository.
- Secret `DEPLOY_SERVER_PRIVATE_KEY`: deploy key authorized for that repository.
- Variable `DEPLOY_KNOWN_HOSTS`: independently verified SSH host-key entries for the Git remote.

The workflow force-pushes the `main` branch of this dedicated deployment remote. Never point it at the source repository or a remote containing other work. A successful Git push only confirms receipt: Tevun's post-receive hook and the site's HTTPS response must also be checked to confirm deployment.
