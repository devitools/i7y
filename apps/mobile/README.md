# i7y mobile

Expo SDK 58 client for an existing i7y installation. Users enter their server URL at runtime, approve a one-time browser login on that server, select an organization, inspect incidents and evidence, and claim, extend, or resolve incidents when their role permits. English, Brazilian Portuguese, and Ukrainian interface resources are included.

The optional central gateway delivers native APNs/FCM notifications. This app uses `getDevicePushTokenAsync`; it does not send through the Expo Push Service. Native tokens and gateway management capabilities stay between the app and gateway. The installation receives only a revocable send capability. A notification is a hint to fetch authorized live incident data.

## Project configuration

| Setting | Current value |
| --- | --- |
| Expo account/project | `wilcorrea/i7y` |
| EAS project ID | `1347e956-5177-4fc2-9138-d81f8fc5c109` |
| iOS bundle / Android package | `com.devitools.i7y.mobile` |
| Browser callback | `com.devitools.i7y.mobile://auth/callback` |
| App version | `0.1.0`; EAS remotely manages increasing native build numbers |
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

Configure local build variables in an ignored environment file. The example gateway hostname is illustrative and has not been deployed:

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_I7Y_PUSH_GATEWAY_URL` | Exact trusted gateway origin embedded in the build; leave empty when push is unavailable. It must match the connected installation's advertised gateway origin. This is public configuration, never a credential. |
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

The gateway has not been deployed, provider credentials are absent, and no store records or approved releases are established by this README. Signing, provider-backed tests, reviewer access, published privacy/support pages, and store review remain release prerequisites.
