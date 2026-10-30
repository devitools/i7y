# Mobile release runbook

This is a preparation runbook, checked against the repository and official documentation on 2026-10-29. It does not report a submitted, approved, or published app. The release path is native simulator/emulator development, real APNs/FCM verification in a supported virtual environment, signed production artifacts, then App Store Review and Google Play production. There is no TestFlight testing or beta-distribution stage.

## Current configuration and accounts

| Item | Recorded state |
| --- | --- |
| Expo | Linked to `wilcorrea/i7y`, project `1347e956-5177-4fc2-9138-d81f8fc5c109` |
| Apple account supplied by publisher | `apple@wilcorrea.dev`; active membership and team `6Y2CA8W7JV` verified; App Store distribution signing pending |
| Google account supplied by publisher | `wilcorrea@gmail.com`; Play account type, verification, and production eligibility still need verification |
| Store records | No existing App Store Connect or Google Play records supplied |
| Native identity | `com.devitools.i7y.mobile` on both platforms |
| Callback | `com.devitools.i7y.mobile://auth/callback` |
| Product version | `0.1.0` in `apps/mobile/app.config.ts` |
| Development profile | Internal development client; `ios.simulator: true`; development build variant |
| Simulator profile | Embedded-bundle app, no development launcher; simulator iOS / Android APK; explicit local HTTP rehearsal |
| Production profile | Remote version increments; production build variant; Android app bundle |
| Submission profile | Apple fields empty; Google `track: production`, `releaseStatus: draft` |
| Gateway | Deployed at `https://i7y-push.disk.ninja`; sandbox APNs and production FCM configured; production APNs pending |

Account email addresses are sign-in context, not public support contacts or proof of legal publisher identity. Preserve the linked EAS project and native identifiers. Do not infer a store app ID, Apple team ID, signing certificate, keystore, Firebase project, public hostname, or review account from those email addresses.

## Physical-device acceptance and release gate (2026-10-30)

The publisher confirmed incident opening and resolution notifications on the physical iPhone and Moto G10. Android delivery had a perceived delay before arrival. This validates the installed acceptance builds, not a store-signed binary. The iPhone uses Apple Development signing and sandbox APNs; the Android acceptance APK uses test signing with production FCM. Neither artifact is a store release.

The production gateway preserves both existing registrations. Its current allowlist accepts iOS sandbox and Android production. Add iOS production only after installing an Apple credential permitted for that environment; preserve sandbox support while the acceptance app remains installed.

The release preparation check passed mobile typecheck, lint, 20/20 Expo Doctor checks, and 19 client/push-proof tests after aligning React Native to the SDK 58 required patch `0.88.1`. This dependency change requires fresh native artifacts and acceptance before release. EAS authentication is valid for `wilcorrea/i7y`. Apple authentication in EAS is now valid. The App Store distribution certificate and active profile `5M6R7237S6` were created for team `6Y2CA8W7JV`; the Android upload keystore is managed by EAS. Store builds are in progress: iOS `0.1.0 (1)`, EAS ID `acf498ce-1e0f-4190-bc7f-ada948bbd116`; Android `0.1.0 (2)`, EAS ID `f4325bd5-5428-4d1d-b405-e983b2a68ce6`. Artifact signing and embedded configuration remain unverified until those builds finish. No build has been submitted to either store. The EAS production environment includes the Android client file; the FCM service-account private key remains only at the gateway and private local storage.

## 1. Build the native acceptance apps

Run these from the repository root:

```sh
npm ci
npm run typecheck:mobile
npm run ios:preview --workspace @i7y/mobile
```

Complete iOS acceptance and shut down its simulator before running `npm run android:preview --workspace @i7y/mobile`. These previews embed the JavaScript bundle and open the app directly without Metro or the Expo development launcher. Keep one simulator or emulator active at a time. Use Xcode and its installed simulator runtime for iOS; use Android Studio with a Google Play services emulator image for Android. A browser export, Expo Go session, or mocked notification listener is not the native acceptance artifact. Record the source revision, effective Expo configuration, runtime/OS, native build identity, and test account role in the evidence log.

An EAS simulator build is also available from `apps/mobile`:

```sh
npx eas-cli@latest build --platform ios --profile simulator
npx eas-cli@latest build --platform android --profile simulator
```

These commands consume EAS build resources when executed. The iOS simulator profile is explicitly simulator-only; it is not a physical-device distribution profile. The separate `development` profile remains available for Metro-based debugging. The existing project link is already present, so a new `eas init` is unnecessary. Native build behavior follows the [Expo development-build documentation](https://docs.expo.dev/develop/development-builds/introduction/).

## 2. Establish actual remote delivery

A supported virtual environment is sufficient for this workflow. Expo documents remote-push support on Android emulators with Google Play services and on iOS Simulator with Xcode 14 or later, macOS 13 or later, and iOS 16 or later. A compatible host/runtime, network access, credentials, and a native registration token are still required. Use the current [Expo prerequisites](https://docs.expo.dev/push-notifications/push-notifications-setup/) and [Firebase Android prerequisites](https://firebase.google.com/docs/cloud-messaging/android/get-started).

Complete the following configuration before recording real push as passed:

- Deploy the gateway behind a real HTTPS origin chosen by the publisher; persist its SQLite directory and install its encryption key. No deployment target or public gateway URL is supplied yet.
- Supply the Apple APNs key, key ID, team ID, and matching app capability/entitlements. Development simulator enrollment uses `sandbox`; production store signing uses the matching production configuration. Verify the effective native entitlement, not only an environment variable.
- Create or select the real Firebase project for `com.devitools.i7y.mobile`; supply its Android client file through `GOOGLE_SERVICES_JSON`. Install the FCM service-account secret only on the gateway. Google Play submission service credentials are a separate purpose.
- Configure the gateway app/environment allowlist. Embed its exact origin as `EXPO_PUBLIC_I7Y_PUSH_GATEWAY_URL` when building the app. Configure the server's `I7Y_PUSH_GATEWAY_URL` to the same origin and provide the independent server encryption key.
- Verify simulator-token compatibility without truncation. The gateway accepts even-length hexadecimal APNs tokens up to 1024 characters and preserves their native length. Apple staff notes that simulator APNs tokens can be longer than physical-device tokens. See [Apple's token-length clarification](https://developer.apple.com/forums/thread/750526).

The app proves possession by receiving the gateway registration challenge, confirms its nonce, creates a binding, and sends only that binding's send capability to the authenticated installation. Keep native tokens, management capabilities, service-account files, and APNs keys out of screenshots and routine logs.

| Evidence | What it establishes |
| --- | --- |
| `simctl push`, local notification scheduling, or direct listener injection | Presentation and tap-handling rehearsal only; no APNs/FCM transport evidence |
| Gateway unit tests with fake providers or mock HTTP servers | Protocol, capability, retry, and request-shape behavior; no provider-backed delivery evidence |
| Native registration plus a gateway challenge delivered through APNs/FCM | Provider-backed enrollment for the recorded platform/environment |
| A synthetic server incident delivered through the outbox and gateway | The complete remote notification path, including the bound connection and authorized tap fetch |

Run remote scenarios in the selected simulator/emulator: foreground, background, tap routing, denied permission, token refresh/re-enrollment, same-token reinstall, offline prior server after gateway revocation, organization removal, claim/resolve cancellation, transient failure retry, and stale notification taps. Do not treat provider acceptance as device display or an exactly-once guarantee. Each handoff has a message TTL of at most 60 seconds; same-key gateway retries have a fixed 300-second window and at most five attempts. See [gateway behavior](../apps/push-gateway/README.md).

Record actual results and remaining environment limitations. No real provider-backed result is asserted by this runbook. Production credentials and production delivery must not be labeled verified merely because sandbox delivery or local injection passed.

## 3. Prepare the production artifacts

Before building, freeze the intended version and public configuration, run the relevant repository/backend/gateway checks, and inspect the effective production Expo config:

```sh
cd apps/mobile
I7Y_BUILD_VARIANT=production npx expo config --type public
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest build --platform android --profile production
```

Provide the real embedded gateway origin and the Android Firebase client file through the selected build environment. An empty gateway value leaves push unconfigured. The production profile sets `I7Y_BUILD_VARIANT=production`; current app config disables development transport exceptions and selects production push routing. Verify this in the resolved config and built native artifacts. `EXPO_PUBLIC_` values are visible to users and must contain no secrets.

Signing prerequisites are an eligible Apple Developer team, the matching App ID and push capability, a distribution certificate/provisioning profile, and Android upload-key custody/Play App Signing setup. Validate current Xcode/SDK and Google Play target-API acceptance requirements at submission time. Store signing does not configure the central provider service.

Record the exact EAS build IDs, bundle/package ID, marketing version, iOS build number, Android version code, artifact checksums, signing identity, production configuration, and test evidence. The Android artifact must be an AAB for the store. A simulator archive cannot be submitted as an App Store IPA. Remote auto-increment configuration is not evidence that a particular archive has the expected number.

## 4. Apple: upload, App Review, release

Create the App Store Connect record for the matching bundle ID before submitting. Complete legal agreements, publisher identity, pricing/territories, age rating, privacy declarations, privacy/support URLs, screenshots, export-compliance answers, and private reviewer access. Supply the actual numeric `ascAppId` and authorized submission credentials; `submit.production.ios` currently supplies neither. Use `apple@wilcorrea.dev` only as the account context until the correct team is confirmed.

Upload the exact verified production build using the configured submit flow or an authorized Xcode/Transporter upload. An illustrative command, once credentials and the record exist, is:

```sh
npx eas-cli@latest submit --platform ios --profile production --id <VERIFIED_IOS_EAS_BUILD_ID>
```

EAS upload is not App Review submission. Apple may display the processed binary in the TestFlight area of App Store Connect because the upload/processing pipeline is shared. That does not require inviting beta testers or distributing a TestFlight build. Do not enable automatic TestFlight distribution, add tester groups, run `npx testflight`, or use a TestFlight-specific workflow for this release. Select the processed binary for the App Store version instead. See [Expo iOS submission](https://docs.expo.dev/submit/ios/).

In App Store Connect, verify the selected build and completed metadata, choose the publisher's release timing, click **Add for Review**, inspect the draft submission, then **Submit for Review**. The first action alone does not send the app to Apple. After approval, complete the chosen release action and verify public storefront availability before reporting publication. See [Apple's App Review submission steps](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app/).

## 5. Google: record, eligibility, draft, review, production

Create the Google Play record and verify the developer account, package ownership, app signing, store listing, app access instructions, privacy/Data safety, content rating, ads/target audience declarations, price, and countries. The Google account email alone establishes none of those states.

Check production eligibility before promising a direct production release. For personal developer accounts created after November 13, 2023, Google currently requires a closed test with at least 12 opted-in testers for 14 continuous days, followed by an application for production access. This is a conditional Google requirement, separate from the omitted Apple TestFlight workflow. See [Google's personal-account testing rules](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en).

For this new app, use Play Console for the first upload/release setup when the desired eligible track is clear. Expo's default first-time submission creates an internal-track release; do not assume a bare default submit publishes production. The repository's explicit production profile instead requests a production draft. After the record, eligibility, and least-privilege Play submission service account are established, the configured automated upload is:

```sh
npx eas-cli@latest submit --platform android --profile production --id <VERIFIED_ANDROID_EAS_BUILD_ID>
```

`releaseStatus: draft` does not roll the app out. Inspect the actual package, version code, track, policy tasks, and draft in Play Console; complete review submission and the publisher's production rollout there. Verify public availability separately. Current first-upload, AAB, service-account, and draft behavior is documented in [Expo Android submission](https://docs.expo.dev/submit/android/).

## Remaining release prerequisites

- Real HTTPS gateway and compatible reviewer/demo installation URLs, provider secrets, correct native capabilities, Android Firebase client configuration, and actual remote-push evidence.
- Confirmed Apple/Google memberships, legal identity, agreements, developer verification, signing material, store records, identifiers issued by the stores, and Google production eligibility.
- Published privacy/support pages and their in-app accessibility; publisher confirmation of data retention, deletion, subprocessors, privacy declarations, and export compliance. The current source does not establish final store-policy compliance.
- A working private demo account with an organization and safe synthetic incidents, plus review instructions that require no VPN, employee invitation, personal hardware, or expiring approval from the developer.
- Platform/language screenshots from the actual native UI, age/content questionnaires, complete localized metadata, and the exact production artifact selected for review.
- A publisher decision about account-creation scope: if the app's browser route permits account creation, implement and document the required account-deletion paths before claiming compliance. Browser-based creation is not an exemption under [Apple](https://developer.apple.com/support/offering-account-deletion-in-your-app/) or [Google](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en) guidance.

Use [the listing preparation guide](mobile-store-listing.md) for private reviewer placeholders and the localized policy/support drafts. These documents neither create store records nor attest that any prerequisite is complete.

## Physical iPhone push rehearsal

The `device` EAS profile builds an embedded-bundle, internally distributed app for registered physical iPhones. It uses production HTTPS and APNs routing, without TestFlight. Authenticate with the existing Apple Developer team using `eas device:create`, register the iPhone through the generated website, then configure signing and the APNs provider key. The selected gateway origin is `https://i7y-push.disk.ninja`; it must be deployed with the actual Apple key before recording push as available. `apps/push-gateway/compose.production.yaml` connects the independent gateway to the existing `reverse-proxy` network without publishing its HTTP port. Its private `gateway.env`, persisted data directory and read-only `secrets/apns.p8` are provisioned outside source control. The encryption keys prepared locally remain private under `.local/mobile-push-production/`; preserve them when activating the service. The backend encryption key and gateway URL must be added to the production container environment together. Do not log or commit APNs keys or device-management capabilities.
