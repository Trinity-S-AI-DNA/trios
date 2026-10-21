import Foundation

// Spec: .trinity/specs/internet-calls.md (gHashTag/trios#2053).
// Pure and dependency-free: no TRI-NET or LiveKit types, so TriOSKit and the
// standalone tests compile it alone. The call lifecycle itself belongs to
// TRI-NET (`specs/internet_call.t27`); this file only decides what TriOS
// shows and allows.

/// What the Calls panel shows for the TRI-NET controller state.
enum TriOSCallPhase: String, CaseIterable, Equatable, Sendable {
    case idle
    case calling
    case ringing
    case connecting
    case connected
    case reconnecting
    case ended
    case failed

    /// Maps `InternetCallState.rawValue` from the TRI-NET shared code
    /// ("Idle", "Calling", "Ringing", ...). Unknown values are `failed`.
    init(controllerState: String) {
        switch controllerState {
        case "Idle": self = .idle
        case "Calling": self = .calling
        case "Ringing": self = .ringing
        case "Connecting": self = .connecting
        case "Connected": self = .connected
        case "Reconnecting": self = .reconnecting
        case "Ended": self = .ended
        default: self = .failed
        }
    }

    var label: String {
        switch self {
        case .idle: return "Ready"
        case .calling: return "Calling..."
        case .ringing: return "Ringing..."
        case .connecting: return "Connecting..."
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting..."
        case .ended: return "Call ended"
        case .failed: return "Call failed"
        }
    }

    /// A call is in progress until it ends or fails.
    var isInProgress: Bool {
        switch self {
        case .calling, .ringing, .connecting, .connected, .reconnecting: return true
        case .idle, .ended, .failed: return false
        }
    }

    var allowsMute: Bool {
        self == .connecting || self == .connected || self == .reconnecting
    }

    var allowsHangUp: Bool { isInProgress }
}

/// Which kind of call API address is configured. This describes the
/// configuration only: it never claims the address was reached, that it is
/// public, or that LiveKit or TURN behind it work.
enum TriOSCallOrigin: Equatable, Sendable {
    case notConfigured
    case localNetworkOnly
    case internetHTTPS

    var label: String {
        switch self {
        case .notConfigured: return "Not configured"
        case .localNetworkOnly: return "Local or unencrypted address"
        case .internetHTTPS: return "HTTPS address, not verified"
        }
    }

    static func classify(_ apiBaseURL: String) -> TriOSCallOrigin {
        let trimmed = apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host?.lowercased(),
              !host.isEmpty else {
            return .notConfigured
        }
        if scheme == "https" && !isLocalHost(host) {
            return .internetHTTPS
        }
        return .localNetworkOnly
    }

    static func isLocalHost(_ host: String) -> Bool {
        if host == "localhost" || host == "0.0.0.0" || host.hasSuffix(".local") || host.hasSuffix(".lan") {
            return true
        }
        if host.contains(":") {
            let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
            if bare.hasPrefix("::ffff:") {
                return isLocalHost(String(bare.dropFirst("::ffff:".count)))
            }
            return bare == "::1" || bare == "::" || bare.hasPrefix("fc") || bare.hasPrefix("fd")
                || bare.hasPrefix("fe80:")
        }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false).compactMap { UInt8($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 100 && (64...127).contains(octets[1]))
    }
}

/// Where a candidate callee came from. Only an exact directory lookup is a
/// TRI-NET account; a mesh node is never one.
enum TriOSCallContactSource: Equatable, Sendable {
    case exactDirectoryLookup
    case meshNode(UInt32)
}

/// Why a typed call server address cannot be saved.
enum TriOSServerAddressProblem: Equatable, Sendable {
    case empty
    case notHTTP
    case noHost
    case containsCredentials
    case containsQueryOrFragment
    case unencryptedPublicHost

    var message: String {
        switch self {
        case .empty: return "Enter the call server address."
        case .notHTTP: return "Use an https:// address."
        case .noHost: return "The address has no host name."
        case .containsCredentials: return "Do not put a user name or password in the address."
        case .containsQueryOrFragment: return "Remove the ?query or #fragment from the address."
        case .unencryptedPublicHost: return "Use https:// for a server outside the local network."
        }
    }
}

enum TriOSCallPolicy {
    /// Validates a call server base URL typed by the user. https is required
    /// for anything that is not a local address; credentials, queries and
    /// fragments are refused so nothing secret is stored in settings.
    static func validateServerAddress(_ text: String) -> Result<String, TriOSServerAddressProblem> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure(.empty) }
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            return .failure(.notHTTP)
        }
        guard let host = components.host, !host.isEmpty else { return .failure(.noHost) }
        if components.user != nil || components.password != nil {
            return .failure(.containsCredentials)
        }
        if components.query != nil || components.fragment != nil {
            return .failure(.containsQueryOrFragment)
        }
        if scheme == "http" && !TriOSCallOrigin.isLocalHost(host.lowercased()) {
            return .failure(.unencryptedPublicHost)
        }
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        var normalized = components
        normalized.scheme = scheme
        normalized.path = path
        return .success(normalized.string ?? trimmed)
    }

    /// Changing the server is refused during a call so it never ends one
    /// silently; a different server needs an explicit confirmation because
    /// this Mac's device key and nickname are then sent to it.
    static func serverChangeAllowed(phase: TriOSCallPhase) -> Bool {
        !phase.isInProgress
    }

    static func serverChangeNeedsConfirmation(current: String, new: String) -> Bool {
        !current.isEmpty && current != new
    }

    /// The call button on a contact.
    static func callButtonEnabled(
        accountBound: Bool,
        origin: TriOSCallOrigin,
        contactSource: TriOSCallContactSource,
        contactUserID: String,
        ownUserID: String,
        phase: TriOSCallPhase
    ) -> Bool {
        guard accountBound, origin != .notConfigured else { return false }
        guard case .exactDirectoryLookup = contactSource else { return false }
        guard !contactUserID.isEmpty, contactUserID != ownUserID else { return false }
        return !phase.isInProgress
    }

    /// Answer and Decline exist only for a pending incoming call while no
    /// other call is in progress on this device.
    static func incomingActionsEnabled(hasIncomingCall: Bool, phase: TriOSCallPhase) -> Bool {
        hasIncomingCall && !phase.isInProgress
    }

    /// A mesh peer never yields a callable contact: no account is inferred
    /// from a node ID, a shared network or a display name.
    static func meshPeerIsCallable(_ nodeID: UInt32) -> Bool {
        false
    }

    /// TriOS calls are audio only and use the Internet route.
    static let audioRequested = true
    static let videoRequested = false

    /// The incoming banner closes only on an authoritative answer that the
    /// invitation is no longer pending; a failed request keeps it.
    static func incomingBannerShouldClose(stillPending: Bool) -> Bool {
        !stillPending
    }

    /// Fixed text for a call that ended with a server status.
    static func endNotice(serverStatus: String) -> String {
        switch serverStatus {
        case "declined": return "Call declined."
        case "missed": return "No answer."
        case "cancelled": return "Call cancelled."
        default: return "The call ended."
        }
    }

    /// Fixed, secret-free error text; server payloads are never shown.
    static func errorText(for phase: TriOSCallPhase) -> String {
        switch phase {
        case .failed: return "The call could not be completed. Check the call server and try again."
        default: return "Something went wrong. Try again."
        }
    }
}
