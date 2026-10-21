# Internet Calls Specification

Issue: https://github.com/gHashTag/trios/issues/2053
Task: INTERNET-CALLS-001
Owner: Mesh / Calls
Depends on: gHashTag/tri-net#415 (PR #416), gHashTag/tri-net#413 (PR #414)

## Purpose

Let a TriOS user on macOS call another TriOS user (Mac or phone) over the
Internet, one to one, with audio in both directions, by reusing the TRI-NET
identity, directory, signalling and LiveKit media stack. TriOS does not get a
second call stack.

## Sources

- TRI-NET shared Swift, compiled into TriOS from the checkout pinned in
  `apps/trios-macos/TRINET_PIN`: `phone/shared/CallIdentity.swift`
  (`DeviceIdentityStore`, `InternetCallConfiguration`),
  `phone/shared/InternetCall.swift` (`InternetCallAPI`,
  `InternetCallController`, `AccountDeviceController`) and
  `phone/shared/NicknameDirectory.swift`
  (`InternetCallAPI.internetContacts(exactNickname:identity:)`).
- Call lifecycle, first-answer-wins, idempotency and server-side cleanup are
  defined by `specs/internet_call.t27` in gHashTag/tri-net and enforced by its
  `services/call-api`; TriOS adds no lifecycle rule of its own.
- LiveKit Swift SDK 2.15.2 (revision 77b5aad0), the version pinned by the
  TRI-NET Xcode projects, built by `apps/trios-macos/packages/TriOSLiveKit`.

## Identity and account binding

- TriOS is its own TRI-NET device: Info.plist sets
  `TRINET_IDENTITY_KEYCHAIN_SERVICE` to `com.browseros.trios.trinet-identity`,
  so it never reads or overwrites the identity of another TRI-NET client on the
  same Mac.
- A user becomes callable only after an explicit binding, one of:
  - claim a free nickname for a new account (3 to 20 characters, the TRI-NET
    nickname policy), or
  - join an existing account with a link code created on a device already in
    that account (for example the phone app).
- Until the binding exists the Calls panel shows only the binding step; no call
  can be started or answered.
- A mesh node ID (`UInt32` in the Mesh chat) is never mapped to an account and
  never gets a call button. No identity is inferred from room membership, a
  shared network, a display name or an IP address.

## Lifetime

- One calls model for the app session (`InternetCallsModel.shared`), started
  in `applicationDidFinishLaunching`. Leaving the Calls segment neither stops
  receiving nor ends a call.
- An incoming call shows in a floating panel (and in the Calls segment) with
  Answer and Decline, whatever tab or window is in front.
- The shared poll records an invitation as delivered only when TriOS accepts
  it synchronously. While another call is in progress or a banner is shown,
  TriOS declines to consume it, and the next poll offers it again.
- The banner stays while the server still lists the invitation. A failed
  request is transient and keeps it; only an authoritative "no longer pending"
  (answered elsewhere, cancelled, expired) closes it.
- Decline keeps the banner until the server confirms; a failed decline says so
  and can be retried.

## Ending a call

- Every end signal releases the LiveKit room and the microphone exactly once
  per call: a terminal status from the shared outgoing status poll, the remote
  participant leaving, LiveKit closing the room, and, for an answered call, a
  terminal status from TriOS's own status poll (remote hangup, caller cancel,
  revocation). Local teardown never waits for the server's DeleteRoom.
- The notice is fixed per server status: declined, no answer, cancelled,
  ended.

## Call server configuration

- The Calls segment has a Call server field. The address must be http(s)
  with a host, without user name, password, query or fragment; plain http is
  accepted only for a local address.
- The first address is applied at once. A different address needs explicit
  confirmation, because this Mac's device key is then registered there.
- The server cannot be changed during a call.
- Changing the server stops receiving, clears the banner and contacts, and
  forgets the nickname and account link of the previous server; the user
  claims or links again. Only the address is saved; the service access token
  is never written to settings.
- The address label describes configuration only (`Not configured`, `Local or
  unencrypted address`, `HTTPS address, not verified`); reachability of the
  call API, LiveKit and TURN from other networks is not claimed until tested.

## Route

- Calls use the Internet route only: the directory API, the call API and
  LiveKit. TriOS starts no Bonjour browse or publish and no UDP mesh call
  signalling for this feature.
- The call API address comes from `InternetCallConfiguration` (the Call
  server field, saved settings, or Info.plist `TRINET_API_BASE_URL`); LiveKit
  URL and token come from the call session. A call over a local address is
  labelled as such and is not evidence of Internet calling.

## People and the call button

- A contact is the result of an exact nickname lookup
  (`internetContacts(exactNickname:)`). People are shown by nickname and
  display name, never by IP address or device ID.
- The call button is enabled only when: the binding exists, an origin is
  configured, the contact came from the exact lookup, the contact is not this
  account, and no call is in progress.
- Calls are audio only (`audio: true, video: false`). Video is out of scope.

## Call states and controls

| Controller state | Label | Controls |
|---|---|---|
| `Idle` | Ready | Call (when allowed) |
| `Calling` (registering) | Calling... | Hang up |
| `Ringing` | Ringing... | Hang up |
| `Connecting` | Connecting... | Mute, Hang up |
| `Connected` | Connected | Mute, Hang up |
| `Reconnecting` | Reconnecting... | Mute, Hang up |
| `Ended` | Call ended | Call again |
| `Failed` | Call failed | Retry |

- Incoming call: banner with the caller's nickname, `Answer` and `Decline`.
  Answer joins the call (`join(callID:audio:true,video:false)`); Decline calls
  `decline(callID:)`. Answering on another device stops the banner here
  (status polling sees the call taken).
- Hang up while ringing cancels; hang up while connected ends.
- Errors show a fixed sentence and a Retry action; no server payload or token
  is shown.
- Every control is a labelled button with an accessibility label; the panel
  fits the existing Mesh tab width.

## Build seam

- The app build is `clade-build` (`rings/RUST-01/clade-build`), the build that
  links SQLCipher and QueenUILib. `xtask build` does not link SQLCipher and is
  not changed here.
- `apps/trios-macos/TRINET_PIN` names the TRI-NET repository, commit and the
  three shared files. `clade-build` requires `TRINET_ROOT` (default: two levels
  above the app root, then `TRI-NET`) at exactly that commit, verified with
  `git rev-parse HEAD`, and fails otherwise.
- `clade-build` builds `packages/TriOSLiveKit` (`swift build --product
  TriOSLiveKit`), compiles the app with `-D TRIOS_CALLS` and that build's
  `Modules` and frameworks on the search paths, links `libTriOSLiveKit.dylib`,
  and copies the dylib and every `.framework` from that build directory into
  `Contents/Frameworks`.
- The two calling files are on the BR-OUTPUT whitelist; without
  `-D TRIOS_CALLS` they compile to nothing and the Mesh tab has no Calls
  segment.
- Info.plist adds `NSMicrophoneUsageDescription` and
  `TRINET_IDENTITY_KEYCHAIN_SERVICE`.
- `Sources/CSQLCipher` is looked up in the app root first (monorepo layout),
  then next to it (old layout).

## Tests

1. Controller state strings map to the phases and labels above; unknown
   strings map to `failed`.
2. The call button is disabled without binding, without an origin, for an
   unresolved or own contact, and during any non-terminal phase; enabled
   otherwise.
3. Answer and Decline exist only with a pending incoming call; Mute and Hang up
   only in the phases listed.
4. A mesh peer never yields a callable contact.
5. Origin classification: empty -> not configured; `.local`, private IPv4,
   loopback, IPv6 ULA/link-local/loopback/mapped-private and plain http ->
   local or unencrypted; other https -> HTTPS address, not verified.
7. Server address validation, confirmation and no change during a call.
8. Seam integration test (CI): the real model and TRI-NET controller against
   a stub server: delivery, redelivery of an unconsumed call, failed decline,
   transient poll errors, authoritative absence, end signals, server change
   with nothing sent to an unconfirmed server.
6. CI builds the app through `clade-build` with the pinned TRI-NET, Queen
   (`gHashTag/trinity` 8e535bc9) and LiveKit packages on a macOS runner,
   checks that `Contents/MacOS/trios` exists, every `@rpath` dependency of the
   executable and embedded binaries resolves inside the bundle, the ad hoc
   signature verifies, and keeps `trios.app` as a downloadable artifact.

## Not covered here

- Live acceptance: Mac -> phone and phone -> Mac on two networks, audible
  two-way audio, accept/decline/cancel/end convergence, reconnect and TURN with
  UDP blocked. It needs a call API, LiveKit and TURN reachable from both
  networks; none has been verified from the configuration available here.
- Background ringing on macOS (the app must be running) and iOS CallKit /
  PushKit (phone app, separate work).
