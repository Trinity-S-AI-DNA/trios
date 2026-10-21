// Spec: .trinity/specs/internet-calls.md (gHashTag/trios#2053).
// Compiled only with -D TRIOS_CALLS (clade-build with the TRI-NET seam).
#if TRIOS_CALLS
import AppKit
import Combine
import SwiftUI

/// "Calls" segment of the Mesh tab: one-to-one Internet audio calls between
/// TriOS users through the TRI-NET call stack. People appear by nickname and
/// display name only; a mesh node never gets a call button. The model lives
/// for the app session, so leaving this view neither stops receiving nor
/// ends a call.
struct InternetCallsView: View {
    @ObservedObject private var model = InternetCallsModel.shared

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                header
                serverSection
                if model.incoming != nil {
                    card { IncomingCallBanner(model: model) }
                }
                if model.phase.isInProgress || model.phase == .ended || model.phase == .failed {
                    callCard
                }
                if model.identity != nil {
                    if model.accountBound {
                        peopleSection
                    } else {
                        bindingSection
                    }
                }
                if let notice = model.notice {
                    Text(notice)
                        .font(.system(size: 11))
                        .foregroundColor(.grokMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .background(Color.clear)
        .onAppear { model.start() }
        .alert(
            "Switch call server?",
            isPresented: Binding(
                get: { model.pendingServerAddress != nil },
                set: { shown in if !shown { model.cancelServerAddress() } }
            )
        ) {
            Button("Switch", role: .destructive) { model.confirmServerAddress() }
            Button("Cancel", role: .cancel) { model.cancelServerAddress() }
        } message: {
            Text("This Mac's device key will be registered with \(model.pendingServerAddress ?? ""). Your nickname and account link stay with the current server; you claim or link again on the new one.")
        }
    }

    // MARK: Call server

    private var serverSection: some View {
        card {
            VStack(alignment: .leading, spacing: 8) {
                Text("Call server")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.grokText)
                HStack(spacing: 8) {
                    TextField("https://calls.example.com", text: $model.serverAddressInput)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                        .onSubmit { model.proposeServerAddress() }
                        .accessibilityLabel("Call server address")
                    Button("Save") { model.proposeServerAddress() }
                        .disabled(model.serverAddressInput.isEmpty
                                  || model.serverAddressInput == model.serverAddress
                                  || model.phase.isInProgress)
                        .accessibilityLabel("Save the call server address")
                }
                if model.phase.isInProgress {
                    Text("The server can be changed after the current call.")
                        .font(.system(size: 10))
                        .foregroundColor(.grokDim)
                }
            }
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "phone")
                    .foregroundColor(.grokAccent)
                    .accessibilityHidden(true)
                Text("Internet calls")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.grokText)
                Spacer()
                Text(model.origin.label)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(model.origin == .notConfigured ? .orange : .grokMuted)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color.grokSurface))
                    .accessibilityLabel("Call server address: \(model.origin.label)")
            }
            Text(originHint)
                .font(.system(size: 10))
                .foregroundColor(.grokDim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var originHint: String {
        switch model.origin {
        case .notConfigured:
            return "Set the TRI-NET call server address to make calls. Audio only."
        case .localNetworkOnly:
            return "The call server address is local or unencrypted; calls may work only on this network. Audio only."
        case .internetHTTPS:
            return "An HTTPS call server is configured. Whether it, its media server and its relay are reachable from other networks has not been verified. Audio only."
        }
    }

    // MARK: Account binding

    private var bindingSection: some View {
        card {
            VStack(alignment: .leading, spacing: 10) {
                Text("Choose how people find you")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.grokText)
                HStack(spacing: 8) {
                    TextField("New nickname", text: $model.nicknameInput)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                        .accessibilityLabel("New nickname")
                    Button("Claim") { model.claimNickname() }
                        .disabled(model.isWorking || model.origin == .notConfigured || model.nicknameInput.isEmpty)
                        .accessibilityLabel("Claim this nickname")
                }
                Divider().overlay(Color.grokBorder)
                Text("Or join the account you already use on your phone")
                    .font(.system(size: 11))
                    .foregroundColor(.grokMuted)
                HStack(spacing: 8) {
                    TextField("Link code from your phone", text: $model.linkCodeInput)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                        .accessibilityLabel("Link code")
                    Button("Join") { model.joinAccount() }
                        .disabled(model.isWorking || model.origin == .notConfigured || model.linkCodeInput.isEmpty)
                        .accessibilityLabel("Join the account with this link code")
                }
                Text("Nothing is linked automatically: this Mac joins an account only with a nickname you claim or a code you enter.")
                    .font(.system(size: 10))
                    .foregroundColor(.grokDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: People

    private var peopleSection: some View {
        card {
            VStack(alignment: .leading, spacing: 10) {
                if let nickname = model.accountNickname {
                    Text("You are @\(nickname)")
                        .font(.system(size: 11))
                        .foregroundColor(.grokMuted)
                }
                HStack(spacing: 8) {
                    TextField("Exact nickname", text: $model.searchQuery)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                        .onSubmit { model.search() }
                        .accessibilityLabel("Exact nickname to find")
                    Button("Find") { model.search() }
                        .disabled(model.isWorking || model.searchQuery.isEmpty)
                        .accessibilityLabel("Find this nickname")
                }
                ForEach(model.contacts) { contact in
                    contactRow(contact)
                }
            }
        }
    }

    private func contactRow(_ contact: DirectoryContact) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Color.grokElevated.opacity(0.5))
                .frame(width: 28, height: 28)
                .overlay(
                    Text(String(contact.nickname.prefix(1)).uppercased())
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.grokAccent)
                )
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(contact.displayName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.grokText)
                Text("@\(contact.nickname)\(contact.online ? "  online" : "")")
                    .font(.system(size: 10))
                    .foregroundColor(.grokMuted)
            }
            Spacer()
            Button {
                model.call(contact)
            } label: {
                Label("Call", systemImage: "phone.fill")
                    .font(.system(size: 11, weight: .semibold))
            }
            .disabled(!model.canCall(contact))
            .accessibilityLabel("Call @\(contact.nickname)")
        }
        .padding(.vertical, 4)
    }

    // MARK: Active call

    private var callCard: some View {
        card {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.phase.label)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(model.phase == .failed ? .orange : .grokText)
                    if !model.participantName.isEmpty {
                        Text(model.participantName)
                            .font(.system(size: 10))
                            .foregroundColor(.grokMuted)
                    }
                }
                .accessibilityElement(children: .combine)
                Spacer()
                if model.phase.allowsMute {
                    Button {
                        model.toggleMute()
                    } label: {
                        Image(systemName: model.isMuted ? "mic.slash.fill" : "mic.fill")
                    }
                    .accessibilityLabel(model.isMuted ? "Unmute microphone" : "Mute microphone")
                }
                if model.phase.allowsHangUp {
                    Button(role: .destructive) {
                        model.hangUp()
                    } label: {
                        Label("Hang up", systemImage: "phone.down.fill")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .accessibilityLabel("Hang up")
                }
            }
        }
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.grokSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.grokBorder)
            )
    }
}

/// Caller nickname with Answer and Decline; used in the Calls view and in the
/// app-level incoming-call panel.
struct IncomingCallBanner: View {
    @ObservedObject var model: InternetCallsModel

    var body: some View {
        if let call = model.incoming {
            HStack(spacing: 10) {
                Image(systemName: "phone.arrow.down.left")
                    .foregroundColor(.green)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("@\(call.caller) is calling")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.grokText)
                    Text(model.isDeclining ? "Declining..." : "Audio call")
                        .font(.system(size: 10))
                        .foregroundColor(.grokMuted)
                }
                Spacer()
                Button("Decline") { model.decline() }
                    .disabled(model.isDeclining)
                    .accessibilityLabel("Decline the call from @\(call.caller)")
                Button("Answer") { model.answer() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.incomingActionsEnabled)
                    .accessibilityLabel("Answer the call from @\(call.caller)")
            }
        }
    }
}

/// Shows an incoming call in a small floating panel, so it rings whatever tab
/// or window is in front. Hidden as soon as the invitation is answered,
/// declined or no longer pending.
@MainActor
final class IncomingCallPanel {
    static let shared = IncomingCallPanel()

    private var panel: NSPanel?
    private var subscription: AnyCancellable?

    private init() {}

    func start(model: InternetCallsModel) {
        guard subscription == nil else { return }
        subscription = model.$incoming
            .receive(on: RunLoop.main)
            .sink { [weak self] call in
                if call == nil {
                    self?.panel?.orderOut(nil)
                } else {
                    self?.show(model: model)
                }
            }
    }

    private func show(model: InternetCallsModel) {
        if panel == nil {
            let content = IncomingCallBanner(model: model)
                .padding(14)
                .frame(width: 380)
                .background(Color.grokBackground)
            let created = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 380, height: 84),
                styleMask: [.titled, .nonactivatingPanel, .utilityWindow],
                backing: .buffered,
                defer: false
            )
            created.title = "Incoming call"
            created.isFloatingPanel = true
            created.level = .floating
            created.hidesOnDeactivate = false
            created.isReleasedWhenClosed = false
            created.contentView = NSHostingView(rootView: content)
            created.center()
            panel = created
        }
        panel?.orderFrontRegardless()
        NSApp.requestUserAttention(.criticalRequest)
    }
}
#endif
