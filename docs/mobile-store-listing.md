# Mobile store listing preparation

This is an unpublished release worksheet. The product identity is `i7y`, bundle/package `com.devitools.i7y.mobile`, version `0.1.0`. App Store Connect record `6828724152` exists in preparation; public support contact is `i7y@devi.tools`. Public policy/support URLs, review access, Google Play record, and release approval remain pending. The account emails in [the release runbook](mobile-release.md) are not proposed public contact details.

Brazilian Portuguese product copy, private review-note templates, and public privacy/support drafts are in [the Portuguese locale resource](locales/pt-BR/mobile-store-listing.md). Keep localized prose there so canonical repository documentation remains English. All bracketed placeholders require real publisher-provided values before use in a store or public page.

## Metadata worksheet

| Field | Preparation |
| --- | --- |
| Display name | `i7y`; publisher may choose the localized incident subtitle from the locale resource |
| Primary language | Publisher to confirm; Brazilian Portuguese copy is prepared |
| Category | Productivity is a proposed fit, not a submitted selection |
| Price and territories | Publisher decision; no pricing or country selection is assumed |
| Legal publisher / copyright | `[LEGAL_PUBLISHER_NAME]`, `[COPYRIGHT_YEAR]`; confirm authority to use the brand |
| Privacy policy | `[PUBLIC_PRIVACY_POLICY_URL]`; public, accessible, accurate, and accessible from the app as required |
| Support | `[PUBLIC_SUPPORT_URL]`, `i7y@devi.tools` (publisher-authorized public email) |
| Account/data deletion resource | `[PUBLIC_DELETION_URL]` if applicable; determine account-creation scope first |
| Store app IDs | App Store Connect `6828724152`; Google Play record pending |
| Review contact | `[PRIVATE_REVIEW_CONTACT]`; enter in each store's private review area |

The listing should describe a companion for an existing i7y installation. Server URL selection is runtime configuration. A user needs an existing authorized server account and organization access. Login approval occurs in that server's browser flow; there is no universal i7y account promised by the native client. Incident actions depend on organization role. Optional push requires a configured central gateway, native notification permission, and successful possession proof. Avoid promising guaranteed delivery, emergency monitoring, offline incident mutation, or support for an arbitrary monitoring product.

## Private reviewer access package

Create a dedicated Internet-accessible HTTPS demo installation with safe synthetic data. Supply the real values privately in App Review Information and Google Play App access; never commit demo passwords, user session tokens, gateway capabilities, APNs keys, or service-account files. No VPN, local-network-only hostname, personal invitation, paid signup, or employee confirmation should be required to reproduce the documented path.

Required private handoff fields:

- `[REVIEW_SERVER_HTTPS_ORIGIN]`, with no path, credentials, query, or fragment.
- `[REVIEW_USERNAME]` and `[REVIEW_PASSWORD]`, delivered only through the store's private reviewer fields or another publisher-approved private channel.
- `[REVIEW_ORGANIZATION_NAME]` and the account's role. Use an editor/admin role for claim/extend/resolve and optionally a separate reader account for permission checks.
- `[REVIEW_INCIDENT_NAMES]`, with open, claimed, overdue, and resolved examples containing synthetic evidence only.
- `[REVIEW_CONTACT]`, availability period, and instructions for resetting the demonstration incidents.
- `[REMOTE_PUSH_REVIEW_STATUS]`, stating whether the embedded gateway, installed build, permissions, provider setup, and safe test incident actually support remote delivery.

Reviewer path: open the app, enter the supplied server origin, verify it, choose browser login, sign in on that server, compare the app/browser request code, approve, and return through the registered callback. Select the supplied organization, open a synthetic incident, inspect its evidence/history, claim it with a bounded deadline, extend it, and resolve a separate disposable incident. For push, use the notification control in Settings only when the submitted artifact and real services are configured; explain an unavailable state accurately instead of supplying a fictional gateway URL. The localized template contains these instructions for adaptation.

## Screenshot and evidence plan

Capture the actual native UI with synthetic data. Keep store screenshots separate from internal delivery evidence. Remove private server origins, user emails, tokens, evidence, and unrelated OS notifications. Do not turn a local injection screenshot into a claim of APNs/FCM delivery.

| Capture | Content and evidence purpose |
| --- | --- |
| Connect | Runtime server URL and browser approval explanation; substitute a real publisher-controlled demo origin before publication |
| Incident list | Organization, severity/status filters, open and claimed synthetic incidents |
| Incident detail | Safe evidence/history and role-authorized claim/deadline controls |
| Response | Claimed/overdue/resolved state with consistent server state |
| Settings | Current connection, organization role, and the actual notification state |
| Internal push evidence | Platform/environment, timestamp, synthetic event ID, provider acceptance, receipt, on-screen arrival, and authorized tap fetch; secrets redacted |

Apple's current table requires at least one screenshot for an iPhone with Dynamic Island (medium display), plus the 13-inch iPad set because `supportsTablet` is true. Accepted portrait examples are 1179 x 2556 or 1206 x 2622 for that iPhone group and 2064 x 2752 or 2048 x 2732 for iPad. Upload actual images without alpha, with at most ten per device size, and confirm the live console's current device requirements before submission. See [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).

For Google Play, prepare at least two genuine screenshots; the publication plan should include phone and supported tablet presentation. Phone captures at 1080 x 1920 provide a useful four-image set. The source specifies JPEG or 24-bit PNG without alpha, dimensions from 320 to 3840 pixels, and a longest side no more than twice the shortest. Prepare the separate 512 x 512 store icon and 1024 x 500 feature graphic, respecting the current console's format/size rules. See [Google preview assets](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en).

## Conditional privacy declarations

This is a source-informed draft inventory, not an attested App Privacy or Data safety submission. Review the exact production binary, dependencies, SDK manifests, browser flow, server deployment, gateway hosting/logging, vendor agreements, and public policy before selecting answers. Native client code has no configured advertising/analytics product, but dependency inspection alone does not establish the behavior of every built SDK, hosting service, or publisher deployment.

| Data flow visible in the implementation | Draft declaration question |
| --- | --- |
| Browser login on the selected installation; native token exchange returns account ID, email/name, and session token | Evaluate contact information, user IDs, authentication data, account management, and linkage to identity. Password entry stays on the selected server's browser origin. |
| Server origin, installation identity, connection ID, organization selection | Evaluate user/device identifiers and configuration; some preferences remain on the device, while connection identifiers are transmitted. |
| Incident details, evidence, claim/resolve actions, and server audit history | Evaluate user content and app interactions. Server evidence can contain personal information depending on operator content. |
| Native token, app/platform/environment, management capability at the gateway; send capability at the installation | Evaluate device/other identifiers for optional notification functionality; encryption at rest does not remove collection disclosure. |
| Minimal public push summary, opaque incident/organization/connection/event IDs, severity | Evaluate content/identifiers sent through the gateway and Apple/Google transport. Never describe the push path as containing no data. |
| Server/gateway/provider access and operational logs, network addresses, support submissions | Confirm actual collected diagnostics, identifiers, log retention, support content, and all processors before declaring them. |

Apple requires developers to account for integrated partners and distinguish collection, identity linkage, and tracking. A functionality-only purpose still needs consideration. Do not select **Data Not Collected** simply because the app is self-hosted or because a token is encrypted. See [Apple App Privacy guidance](https://developer.apple.com/app-store/app-privacy-details/).

Google Data safety covers relevant off-device transmissions and third-party SDK behavior. Assess required versus optional collection, functionality/account-management purposes, identity linkage, retention/deletion, transport encryption, and whether each recipient qualifies for a sharing exemption. Do not automatically declare either sharing or no sharing without examining the actual relationships. See [Google Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en).

Publisher confirmations still needed: legal identity and controller/operator roles; processor list; server/gateway locations and cross-border handling; production logging and crash reporting; advertising/tracking status; final retention/deletion policy; support and privacy contacts; rights-handling process; and any account-creation/deletion flow. The current app has sign-out and notification revocation, which do not delete the server account. If the browser experience allows account creation, resolve the [Apple](https://developer.apple.com/support/offering-account-deletion-in-your-app/) and [Google](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en) deletion requirements before submission.

The policy drafts deliberately leave these facts unresolved. Publishing them unchanged, with placeholders or unsupported retention promises, would not complete release preparation.
