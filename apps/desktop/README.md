# Desktop

The macOS/Windows Tauri application uses the same Vue/Quasar frontend as the browser. The native shell loads a loopback Vite server during development and embeds a separate `apps/web/dist-desktop` build when compiled. It never loads the public website as its application UI.

## Local development

Install Rust, platform prerequisites and the root npm dependencies (`npm ci`). On macOS, install Xcode command line tools; on Windows, install the Microsoft C++ build tools and WebView2 runtime. Node and npm are managed by the repository's Volta configuration.

From the repository root:

```sh
npm run desktop:dev
```

This starts the shared frontend at `http://127.0.0.1:5178` and opens the native window. Enter the URL of your i7y installation on the sign-in screen. The desktop checks browser-authentication support before saving the address in `backend-url.txt` inside the operating system's application configuration directory. The address is restored on later launches and can be edited after signing out. No installation-specific URL is embedded in the distributable.

Remote servers must use HTTPS with a trusted certificate. HTTP is supported only for loopback addresses. Credentials, query parameters and fragments are rejected. Subpath installations are supported when the backend and web interface share that prefix.

API requests use the native Rust HTTP client in both development and packaged builds. The client limits requests to the selected backend's API path, permits only supported HTTP methods and headers, validates TLS, and does not follow redirects. This avoids desktop-specific CORS settings or wildcard remote origins in the webview CSP. Authentication is bound to the selected backend; changing it clears the previous session and cached organization/inventory state. Only the backend address is stored in the native settings file.

The macOS title bar is transparent and follows the interface theme while retaining native window controls. Native capabilities cover window appearance, backend settings, API transport and opening the fixed browser-authorization path. There are no arbitrary shell, filesystem or credential-manager operations. The native MCP and operations service adds locally reviewed access to fixed controller actions. See [desktop MCP](../../docs/desktop-mcp.md) for tools, authorization, configuration and deployment prerequisites.

## Build

```sh
npm run build:desktop -- --debug --no-bundle
```

The launcher forwards Tauri CLI arguments and builds the shared interface, native executable and bundled MCP connector. Desktop assets are separate from the web build and ignored by Git. Bundling is enabled; signed distribution requires an installation-specific signing identity. Changing the backend never requires rebuilding the application.

## Browser authentication

The desktop uses the system browser for sign-in, including password-manager filling.
The configured backend must serve the matching web build and the desktop authorization
routes from `apps/backend/hooks/desktop.pb.js`, with its migration applied first.
Existing installations without these routes display an availability message.

The app generates a random request and a private verifier in memory. The browser
receives only the request and its SHA-256 challenge. After signing in, the user
must confirm the account and compare the eight-character request code with the app.
The backend stores hashes, the approving user and a two-minute expiry. The app polls
the HTTPS exchange endpoint with its verifier. Consumption is transactional and
single-use; the session is returned in the response body, never in a URL.
The app stops waiting after five minutes. Consumed grants remain temporarily to
reject duplicate approval, and a scheduled job removes old grants.

This flow does not open an inbound port or register a custom URL scheme. The native
browser command only opens the configured backend origin and a fixed authorization
path. Native commands are available only to the local application window; remote
pages do not receive native capabilities. Configure normal API rate limits on the backend, including the desktop endpoints. Native requests do not require a webview origin to be added to backend CORS settings.

Run the optional backend integration test against an isolated backend by setting
`I7Y_TEST_BACKEND_URL` and `I7Y_TEST_ADMIN_TOKEN` before `npm test`. It creates and
removes a fictional test user; never run it against production.

## Automation controller diagnostics

Open **Automation host** in the session dropdown. The route has its own page at
`#/desktop/controller`. Configure the controller host, SSH port/user, 1Password
agent endpoint, your public identity and a host public key verified through a
trusted channel. Saving does not connect. **Test saved connection** performs only
a read-only diagnostic and may prompt for authorization in 1Password.

Profiles stay in the OS application configuration directory under
`controllers/<backend-hash>/profile.json`; no SSH private key is stored there.
Transient public identity and known-host files are private and removed after the
check. Host-key mismatches stop the connection. There is no automatic trust prompt,
password fallback, agent forwarding or inherited SSH config.

`apps/desktop/core` contains the reusable Rust SSH library. It is independent of
Tauri and can later be reused by a CLI or the controller protocol. Actual server
changes are disabled until the security and operation-history milestones in the
[roadmap](../../docs/desktop-operations.md) are complete.
