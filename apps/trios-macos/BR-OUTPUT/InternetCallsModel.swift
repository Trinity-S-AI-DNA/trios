// Spec: .trinity/specs/internet-calls.md (gHashTag/trios#2053).
// Compiled only by clade-build with the TRI-NET seam (-D TRIOS_CALLS).
// Other build paths compile nothing here.
#if TRIOS_CALLS
import Combine
import Foundation

/// App-lifetime state and actions of TriOS Internet calls. Identity,
/// directory, signalling and media are the TRI-NET shared types; this class
/// wires them to the UI and applies `TriOSCallPolicy`.
///
/// - One instance for the app session (`shared`), started at launch: incoming
///   calls are received whatever tab is selected, and leaving the Calls view
///   never stops polling or ends a call.
/// - Internet route only: it never creates the mesh directory (no Bonjour,
///   no UDP signalling).
@MainActor
final class InternetCallsModel: ObservableObject {
    static let shared = InternetCallsModel()

    @Published private(set) var identity: DeviceIdentity?
    @Published private(set) var accountNickname: String?
    @Published private(set) var origin: TriOSCallOrigin = .notConfigured
    @Published private(set) var phase: TriOSCallPhase = .idle
    @Published private(set) var participantName = ""
    @Published private(set) var isMuted = false
    @Published private(set) var incoming: IncomingInternetCall?
    @Published private(set) var isDeclining = false
    @Published private(set) var contacts: [DirectoryContact] = []
    @Published private(set) var isWorking = false
    @Published private(set) var notice: String?
    /// How many times local media was released; one per ended call.
    @Published private(set) var teardownCount = 0
    @Published var nicknameInput = ""
    @Published var linkCodeInput = ""
    @Published var searchQuery = ""
    @Published var serverAddressInput = ""
    /// A validated address waiting for the user's confirmation.
    @Published private(set) var pendingServerAddress: String?

    private var configuration = InternetCallConfiguration.load()
    private var controller: InternetCallController?
    private var account: AccountDeviceController?
    private var subscriptions = Set<AnyCancellable>()
    private var incomingWatch: Task<Void, Never>?
    private var answeredWatch: Task<Void, Never>?
    private var started = false
    /// Bumped on every server change; an async result started for an older
    /// server is dropped before it can change identity, binding or contacts.
    private var serverGeneration = 0
    private var serverTasks: [Task<Void, Never>] = []
    /// Bumped by every call, answer and hang-up; a completion or error of a
    /// superseded attempt never touches the current call.
    private var callAttempt = 0
    /// Set once local media was released for the current call; cleared when
    /// a new call starts, so every end signal tears down exactly once.
    private var tornDown = true

    private init() {}

    var accountBound: Bool { accountNickname != nil }

    /// Idempotent; called at app launch and again by the view.
    func start() {
        guard !started else { return }
        started = true
        configuration = InternetCallConfiguration.load()
        origin = TriOSCallOrigin.classify(configuration.apiBaseURL)
        serverAddressInput = configuration.apiBaseURL
        do {
            let loaded = try DeviceIdentityStore.shared.loadOrCreate(defaultName: Self.defaultDeviceName())
            adopt(loaded)
        } catch {
            started = false
            notice = "This Mac could not create its call identity in the Keychain."
        }
    }

    // MARK: Call server

    var serverAddress: String { configuration.apiBaseURL }

    /// Validates the typed address. A first address is applied at once; a
    /// different one waits for `confirmServerAddress()`, because this Mac's
    /// device key and nickname are sent to whatever server is configured.
    func proposeServerAddress() {
        switch TriOSCallPolicy.validateServerAddress(serverAddressInput) {
        case .failure(let problem):
            notice = problem.message
        case .success(let address):
            guard TriOSCallPolicy.serverChangeAllowed(phase: phase) else {
                notice = "End the current call before changing the call server."
                return
            }
            if TriOSCallPolicy.serverChangeNeedsConfirmation(current: configuration.apiBaseURL, new: address) {
                pendingServerAddress = address
            } else {
                applyServerAddress(address)
            }
        }
    }

    func confirmServerAddress() {
        guard let address = pendingServerAddress else { return }
        pendingServerAddress = nil
        applyServerAddress(address)
    }

    func cancelServerAddress() {
        pendingServerAddress = nil
        serverAddressInput = configuration.apiBaseURL
    }

    /// Stops receiving from the old server, forgets the nickname and account
    /// link that belonged to it, and rebinds the controllers to the new one.
    /// Only the address is saved; the service access token is not written to
    /// settings.
    private func applyServerAddress(_ address: String) {
        guard TriOSCallPolicy.serverChangeAllowed(phase: phase) else {
            notice = "End the current call before changing the call server."
            return
        }
        guard address != configuration.apiBaseURL else { return }
        let hadServer = !configuration.apiBaseURL.isEmpty
        serverGeneration += 1
        serverTasks.forEach { $0.cancel() }
        serverTasks = []
        isWorking = false
        controller?.stopIncomingPolling()
        incomingWatch?.cancel()
        answeredWatch?.cancel()
        incoming = nil
        contacts = []
        UserDefaults.standard.set(address, forKey: "internetAPIBaseURL")
        // Reload instead of copying: the shared loader sends a service access
        // token only to the origin it belongs to (gHashTag/tri-net#415), so
        // the previous server's token never reaches this one, also after a
        // restart.
        configuration = InternetCallConfiguration.load()
        origin = TriOSCallOrigin.classify(configuration.apiBaseURL)
        serverAddressInput = address
        accountNickname = nil
        guard var current = identity else { return }
        if hadServer, current.nickname != nil {
            if let cleared = try? DeviceIdentityStore.shared.setNickname(nil) {
                current = cleared
            }
        }
        adopt(current)
        notice = hadServer
            ? "Call server changed. Claim a nickname or join your account on this server."
            : nil
    }

    // MARK: Account binding

    func claimNickname() {
        guard let identity, origin != .notConfigured else { return }
        let requested = nicknameInput
        let generation = serverGeneration
        run { [configuration] in
            let api = InternetCallAPI(configuration: configuration)
            try await api.register(identity: identity, voipToken: nil)
            let claim = try await api.claimNickname(requested, identity: identity)
            guard claim.claimed else {
                return "That nickname is taken. Try another one."
            }
            // Check and persist on the main actor, where server changes run,
            // so a claim from a replaced server never reaches the Keychain.
            try await MainActor.run {
                guard generation == self.serverGeneration else { throw CancellationError() }
                let updated = try DeviceIdentityStore.shared.setNickname(claim.normalized)
                self.adopt(updated)
            }
            return nil
        }
    }

    /// Joins an existing account with a link code created on a device that is
    /// already in it (for example the phone). Explicit; never inferred.
    func joinAccount() {
        guard let account else { return }
        account.linkCodeInput = linkCodeInput
        account.joinAccount()
        linkCodeInput = ""
    }

    // MARK: People

    func search() {
        guard let identity, accountBound else { return }
        let query = searchQuery
        let generation = serverGeneration
        run { [configuration] in
            let api = InternetCallAPI(configuration: configuration)
            let found = try await api.internetContacts(exactNickname: query, identity: identity)
            try await MainActor.run {
                guard generation == self.serverGeneration else { throw CancellationError() }
                self.contacts = found
            }
            return found.isEmpty ? "Nobody with that exact nickname." : nil
        }
    }

    func canCall(_ contact: DirectoryContact) -> Bool {
        TriOSCallPolicy.callButtonEnabled(
            accountBound: accountBound,
            origin: origin,
            contactSource: .exactDirectoryLookup,
            contactUserID: contact.userID,
            ownUserID: identity?.userID ?? "",
            phase: phase
        )
    }

    // MARK: Outgoing

    func call(_ contact: DirectoryContact) {
        guard canCall(contact), let controller else { return }
        notice = nil
        let attempt = beginAttempt()
        Task {
            do {
                try await controller.start(
                    callee: contact.nickname,
                    audio: TriOSCallPolicy.audioRequested,
                    video: TriOSCallPolicy.videoRequested
                )
            } catch {
                // A superseded attempt (hung up, or replaced by a newer call)
                // must never end the current one.
                guard attempt == self.callAttempt else { return }
                self.teardown(notice: TriOSCallPolicy.errorText(for: .failed))
            }
        }
    }

    private func beginAttempt() -> Int {
        callAttempt += 1
        tornDown = false
        return callAttempt
    }

    // MARK: Incoming

    var incomingActionsEnabled: Bool {
        TriOSCallPolicy.incomingActionsEnabled(hasIncomingCall: incoming != nil, phase: phase) && !isDeclining
    }

    /// The shared poll calls `onIncomingCall` on the main thread and records
    /// the call as reported only when this returns true. A call that cannot be
    /// shown now (another call in progress, or a banner already up) returns
    /// false and is offered again by the next poll.
    func offerIncoming(_ call: IncomingInternetCall) -> Bool {
        guard TriOSCallPolicy.incomingActionsEnabled(hasIncomingCall: true, phase: phase),
              incoming == nil else {
            return false
        }
        incoming = call
        watchIncoming(call.callID)
        return true
    }

    func answer() {
        guard incomingActionsEnabled, let call = incoming, let controller else { return }
        incoming = nil
        incomingWatch?.cancel()
        let attempt = beginAttempt()
        Task {
            do {
                try await controller.join(
                    callID: call.callID,
                    audio: TriOSCallPolicy.audioRequested,
                    video: TriOSCallPolicy.videoRequested
                )
                guard attempt == self.callAttempt else { return }
                self.watchAnsweredCall(call.callID, attempt: attempt)
            } catch {
                guard attempt == self.callAttempt else { return }
                self.teardown(notice: TriOSCallPolicy.errorText(for: .failed))
            }
        }
    }

    /// The banner stays until the server confirms the decline; a failed
    /// request keeps it so the user can try again.
    func decline() {
        guard let call = incoming, let controller, !isDeclining else { return }
        isDeclining = true
        Task {
            do {
                _ = try await controller.decline(callID: call.callID)
                if self.incoming?.callID == call.callID {
                    self.incoming = nil
                    self.incomingWatch?.cancel()
                }
                self.notice = nil
            } catch {
                self.notice = "The decline did not reach the call server. Try again."
            }
            self.isDeclining = false
        }
    }

    // MARK: In call

    func toggleMute() {
        guard phase.allowsMute, let controller else { return }
        controller.setMuted(!isMuted)
    }

    /// Cancels a ringing outgoing call or ends a connected one; TRI-NET's
    /// controller decides which, tells the server and releases the room.
    func hangUp() {
        guard phase.allowsHangUp else { return }
        teardown(notice: nil)
        // Any late completion of the attempt just ended is now stale.
        callAttempt += 1
    }

    // MARK: End signals

    /// Outgoing calls: TRI-NET's status poll reports a changed status.
    func handleCallStatus(_ status: InternetCallStatus) {
        guard status.isTerminal else { return }
        teardown(notice: TriOSCallPolicy.endNotice(serverStatus: status.status))
    }

    /// The remote participant left the LiveKit room.
    func handleRemoteEnded() {
        teardown(notice: TriOSCallPolicy.endNotice(serverStatus: "ended"))
    }

    /// Releases the room and the microphone exactly once per call. The
    /// controller's `disconnect()` also sends the matching end or cancel,
    /// which the call API accepts again after the call already ended.
    func teardown(notice: String?) {
        answeredWatch?.cancel()
        answeredWatch = nil
        if !tornDown {
            tornDown = true
            teardownCount += 1
            controller?.disconnect()
        }
        if let notice { self.notice = notice }
    }

    // MARK: Wiring

    private func adopt(_ newIdentity: DeviceIdentity) {
        identity = newIdentity
        // A device that joined an account by link code may have no nickname of
        // its own; the account snapshot supplies it, so keep the known one.
        accountNickname = newIdentity.nickname ?? accountNickname
        if let controller {
            controller.update(identity: newIdentity, configuration: configuration)
        } else {
            let created = InternetCallController(identity: newIdentity, configuration: configuration)
            created.onIncomingCall = { [weak self] call in
                // Invoked on the main thread by the shared poll.
                MainActor.assumeIsolated { self?.offerIncoming(call) ?? false }
            }
            created.onCallStatus = { [weak self] status in
                MainActor.assumeIsolated { self?.handleCallStatus(status) }
            }
            created.onRemoteEnded = { [weak self] in
                MainActor.assumeIsolated { self?.handleRemoteEnded() }
            }
            created.$state
                .receive(on: RunLoop.main)
                .sink { [weak self] state in
                    guard let self else { return }
                    let next = TriOSCallPhase(controllerState: state.rawValue)
                    self.phase = next
                    // A room that LiveKit closed (for example after the server
                    // deleted it on revocation) still releases local media.
                    if next == .ended || next == .failed {
                        self.teardown(notice: nil)
                    }
                }
                .store(in: &subscriptions)
            created.$participantName
                .receive(on: RunLoop.main)
                .sink { [weak self] name in self?.participantName = name }
                .store(in: &subscriptions)
            created.$isMuted
                .receive(on: RunLoop.main)
                .sink { [weak self] muted in self?.isMuted = muted }
                .store(in: &subscriptions)
            controller = created
        }
        if let account {
            account.update(identity: newIdentity, configuration: configuration)
        } else {
            let created = AccountDeviceController(identity: newIdentity, configuration: configuration)
            created.$nickname
                .receive(on: RunLoop.main)
                .sink { [weak self] nickname in
                    guard let self, let nickname else { return }
                    self.accountNickname = nickname
                    // Linking adopts the account's user ID; reload it.
                    if let reloaded = try? DeviceIdentityStore.shared.loadOrCreate(defaultName: Self.defaultDeviceName()),
                       reloaded != self.identity {
                        self.adopt(reloaded)
                    }
                    self.startReceiving()
                }
                .store(in: &subscriptions)
            created.$statusMessage
                .receive(on: RunLoop.main)
                .sink { [weak self] message in
                    if let message { self?.notice = message }
                }
                .store(in: &subscriptions)
            account = created
            if origin != .notConfigured { created.sync() }
        }
        startReceiving()
    }

    private func startReceiving() {
        guard accountBound, origin != .notConfigured else { return }
        controller?.startIncomingPolling()
    }

    /// Keeps the banner while the server still lists the invitation. A failed
    /// request is transient and keeps it; only an authoritative answer that
    /// the call is no longer pending (answered elsewhere, cancelled, expired)
    /// removes it.
    private func watchIncoming(_ callID: String) {
        incomingWatch?.cancel()
        incomingWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard !Task.isCancelled, let self, let controller = self.controller else { return }
                do {
                    let pending = try await controller.authenticatedIncoming(callID: callID)
                    if TriOSCallPolicy.incomingBannerShouldClose(stillPending: pending != nil),
                       self.incoming?.callID == callID {
                        self.incoming = nil
                        return
                    }
                } catch {
                    continue
                }
            }
        }
    }

    /// The shared status poll runs for outgoing calls only. For an answered
    /// call TriOS polls the status itself, so a remote hangup, a caller cancel
    /// or a revoked device ends the call here without waiting for LiveKit.
    private func watchAnsweredCall(_ callID: String, attempt: Int) {
        answeredWatch?.cancel()
        answeredWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled, let self, let controller = self.controller else { return }
                guard let status = try? await controller.status(callID: callID) else {
                    continue
                }
                guard attempt == self.callAttempt else { return }
                if status.isTerminal {
                    self.handleCallStatus(status)
                    return
                }
            }
        }
    }

    private func run(_ operation: @escaping () async throws -> String?) {
        isWorking = true
        notice = nil
        let generation = serverGeneration
        let task = Task {
            do {
                let message = try await operation()
                guard generation == self.serverGeneration else { return }
                self.notice = message
            } catch {
                guard generation == self.serverGeneration else { return }
                self.notice = TriOSCallPolicy.errorText(for: .failed)
            }
            self.isWorking = false
        }
        serverTasks.append(task)
    }

    private static func defaultDeviceName() -> String {
        let name = Host.current().localizedName ?? ""
        return name.isEmpty ? "TriOS Mac" : name
    }
}
#endif
