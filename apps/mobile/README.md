# i7y mobile

Expo SDK 58 client for an existing i7y installation. Users add independent server connections at runtime and approve a browser login for each. The incident inbox combines every authorized organization across signed-in connections. Mobile remains focused on incidents, evidence, claims, extensions, and resolution; inventory stays outside the mobile app. English, Brazilian Portuguese, and Ukrainian interface resources are included.

The optional central gateway delivers native APNs/FCM notifications. This app uses `getDevicePushTokenAsync`; it does not send through the Expo Push Service. Native tokens and gateway management capabilities stay between the app and gateway. The installation receives only a revocable send capability. A notification is a hint to fetch authorized live incident data.

## Connections and migration

The native connection manager adds, signs in, renames, selects for settings, and removes server profiles without signing out of other servers. The selected profile affects account and push settings; the inbox always includes all signed-in profiles. Sessions use separate SecureStore keys per stable local profile ID. Each browser login creates a distinct remote connection identity, while token refresh preserves the existing login identity. This lets a different account use the same saved server without reusing another user’s backend device identity or accepting their pending notifications. Signing out invalidates only that connection's clients and private detail cache. Incident navigation carries the local profile, exact remote login, organization, and incident IDs together. Source clients capture and validate that session and generation before dispatch and after response parsing; old links and cached paging buffers reject account replacement. Actions never inherit the settings selection.

On first upgrade, the previous server preference, session, connection ID, and push binding migrate in place. Old secure values are removed after replacement storage is durable, including migration from the intermediate aggregate push store to separate secure records. Cancelling a browser login leaves existing sessions intact. A transient backend failure preserves the login, reports partial inbox results, and can be retried. A 401/403 ends only the affected login.

The client requests `/api/i7y/alerts/v1/inbox` for each backend and uses per-organization incident endpoints only after HTTP 404. The merge buffers source pages and orders by descending `opened_at`, `created`, and ID; identities include connection and organization so overlapping record IDs remain distinct. Refresh retries unavailable sources. Inbox notification polling uses the matching aggregated endpoint with the same 404-only compatibility rule.

Gateway v2 maintains one management credential per gateway/app/environment and individual login/server bindings. Each device and binding is stored in its own SecureStore value with a small nonsecret manifest, so adding profiles does not grow a single Keychain value. Storage reads and mutations share one queue, including exported per-binding saves, so concurrent updates preserve other bindings. A new connection reuses the proven device enrollment, while authenticated native-token rotation preserves other bindings. Existing v1 device credentials and bindings remain usable during migration. Signing out revokes only one binding and dismisses only its presented notifications. Offline revocations remain stored and retry on the next startup or foreground refresh, including after removing the local profile. Notification taps refresh membership and fetch the live incident from the recorded backend before navigation.

The automated suite covers migration, isolated request cancellation, identical IDs on independent origins, ordered multi-source paging, partial failures, 404 compatibility, notification authorization, enrollment reuse, isolated revocation, concurrent enrollment, and authenticated token rotation. Native device rendering and real APNs/FCM delivery still require device verification.

## Project configuration

| Setting | Current value |
| --- | --- |
| Expo account/project | `wilcorrea/i7y` |
| EAS project ID | `1347e956-5177-4fc2-9138-d81f8fc5c109` |
| iOS bundle / Android package | `com.devitools.i7y.mobile` |
| Browser callback | `com.devitools.i7y.mobile://auth/callback` |
| App version | `0.2.0`; EAS remotely manages increasing native build numbers |
| iPad | Supported by the current app config |

`app.config.ts` is the dynamic configuration; `app.json` preserves the linked EAS project ID. Do not initialize a second project. The `development` EAS profile creates an iOS simulator development client or Android internal development build. The `simulator` profile embeds the JavaScript bundle without a development launcher and explicitly enables local-network HTTP for the disposable lab. The `production` profile creates store builds, sets the production push environment, and generates an Android AAB. Google production submission is configured as a draft; Apple submission still needs the app record and credentials.

## Develop

From the repository root:

```sh
npm ci
npm run typecheck:mobile
npm run mobile:dev
```

To build and run a native simulator/emulator client locally:

```sh
npm run mobile:ios
npm run mobile:android
```

Xcode with an installed iOS runtime is needed for iOS; Android Studio and an emulator image are needed for Android. Use a development build rather than Expo Go when verifying the native integration. Native directories are generated locally and ignored by Git.

Configure local build variables in an ignored environment file:

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_I7Y_PUSH_GATEWAY_URL` | Trusted gateway origin embedded in the build, defaulting to `https://push.devi.tools`. Production accepts this canonical origin and the compatible `https://i7y-push.disk.ninja` alias only. An explicitly empty value disables enrollment. This is public configuration, never a credential. |
| `I7Y_BUILD_VARIANT` | `production` selects production APNs and strict transport configuration; EAS profiles supply this value. |
| `GOOGLE_SERVICES_JSON` | Path supplied securely to the Firebase client configuration file for the Android package. Distinct from the gateway FCM service-account secret and Play submission credentials. |

The i7y server URL is entered in the app and is not a build variable. The initial field is empty with `https://inventory.example.com` as its placeholder; only a user-entered, verified URL is saved. The login button verifies the server and opens browser authorization in one flow. Production builds require HTTPS. Development and explicitly selected `simulator` builds also permit local-network HTTP origins for rehearsal. Changes to native plugins, Firebase client files, or the embedded gateway origin require an appropriate rebuild.

## Open directly in the simulator

For a reviewable app that opens without Metro or the Expo development launcher, build the embedded-bundle simulator variant from `apps/mobile`:

```sh
npm run ios:preview
npm run android:preview
```

Run these builds sequentially on memory-constrained machines. They install local simulator/emulator artifacts, not store-signed releases. A simulator build can access the disposable HTTP lab and must never be submitted to the stores. Production builds continue to use the separate `production` profile with HTTPS enforced.

The `development` build requires the Metro server from `npm run start`. Its development-server address is not the user's i7y backend URL. If its loader reports a connection error, either open the running Metro URL or install the preview variant above.

## Verify and release

Use [the release runbook](../../docs/mobile-release.md) for the approved simulator/emulator workflow, real APNs/FCM prerequisites, production signing, and direct store review without TestFlight testing. Simulator injection and local mock providers do not establish remote delivery. Current Expo guidance supports remote push on suitable [simulators and emulators](https://docs.expo.dev/push-notifications/push-notifications-setup/); verify actual native-token registration and provider delivery in the selected environment.

Backend enrollment/outbox behavior is documented in [the mobile API](../../docs/mobile-api.md). Gateway environment variables, capabilities, retention, and provider error classes are in [the gateway README](../push-gateway/README.md). Store preparation and localized drafts are in [the listing guide](../../docs/mobile-store-listing.md).

This README does not establish provider-backed delivery or a store release. Signing, provider-backed tests, reviewer access, published privacy/support pages, and store review remain release prerequisites.
