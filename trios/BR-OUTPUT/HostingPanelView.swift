// HostingPanelView.swift -- the Hosting section, the card "What we use / what
// you earn", and the balance badge (gHashTag/trios#1756).
//
// VIEWS ONLY. Every value on these views comes from HostingPanelModel, which
// takes it from its source - the agent's lines, the OS, the Queen's public
// ledger, `trios-host statement` - through the hosting card,
// gHashTag/t27 specs/hosting/panel.t27. The words the card owns (states,
// buckets, kinds, verdicts, the disclaimer) are the card's, not this file's.

import SwiftUI
import T27HostingPanel

extension HostingPanelModel {
    /// The app's one hosting model; the agent lives under the variant's data directory.
    static let shared = HostingPanelModel(
        binary: URL(fileURLWithPath: ProjectPaths.hostingAgentBinary(tag: AGENT_TAG)),
        defaults: .standard
    )
}

/// The Hosting segment of the Mesh petal (the Queen's "DePIN NODE" petal).
struct HostingTabView: View {
    @ObservedObject var model: HostingPanelModel = .shared

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                HostingSectionCard(model: model)
                HostingEarningsCard(model: model)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .background(Color.clear)
        .task { await model.refreshAll() }
    }
}

// MARK: - Shared pieces

private struct HostingCardFrame<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(TriosType.font(12, weight: .semibold))
                    .foregroundColor(.grokText)
                Text(title)
                    .font(TriosType.font(13, weight: .semibold))
                    .foregroundColor(.grokText)
                Spacer()
            }
            content()
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.grokSurface))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.grokBorder, lineWidth: 1))
    }
}

private struct HostingRow: View {
    let label: String
    let value: String
    var tone: Color = .grokText

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(TriosType.font(11))
                .foregroundColor(.grokMuted)
                .frame(width: 128, alignment: .leading)
            Text(value.isEmpty ? "-" : value)
                .font(TriosType.font(11, design: .monospaced))
                .foregroundColor(tone)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct HostingSubhead: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(TriosType.font(9, weight: .bold))
            .foregroundColor(.grokDim)
            .padding(.top, 4)
    }
}

private func hostingClock(_ date: Date?) -> String {
    guard let date else { return "" }
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter.string(from: date)
}

private func hostingDuration(seconds: UInt64) -> String {
    let h = seconds / 3600
    let m = (seconds % 3600) / 60
    let s = seconds % 60
    return String(format: "%02llu:%02llu:%02llu", h, m, s)
}

private func hostingTone(_ state: UInt8) -> Color {
    switch Int32(state) {
    case ST_BEATING, ST_REGISTERED: return .green
    case ST_LAPSED, ST_EXITED: return .orange
    case ST_STARTING, ST_STOPPING: return .yellow
    default: return .grokMuted
    }
}

// MARK: - The Hosting section

struct HostingSectionCard: View {
    @ObservedObject var model: HostingPanelModel

    var body: some View {
        HostingCardFrame(title: "Hosting", systemImage: "server.rack") {
            Toggle(isOn: Binding(get: { model.wantsOn }, set: { model.setOn($0) })) {
                Text("Lend this Mac to the Queen")
                    .font(TriosType.font(12, weight: .medium))
                    .foregroundColor(.grokText)
            }
            .toggleStyle(.switch)
            .disabled(model.state == UInt8(ST_STOPPING))
            .accessibilityIdentifier("hosting-toggle")

            HStack(spacing: 12) {
                Stepper(value: $model.slotsWanted, in: 1...UInt32(SLOTS_MAX_OWNER)) {
                    Text("Slots \(model.slotsOffered)")
                        .font(TriosType.font(11))
                        .foregroundColor(.grokText)
                }
                .help("Jobs at once. The Queen grants at most what the tier allows.")
                Picker("Tier claim", selection: $model.tierClaim) {
                    ForEach(0..<UInt8(TIERS), id: \.self) { tier in
                        Text(model.tierWord(tier)).tag(tier)
                    }
                }
                .frame(maxWidth: 170)
                .help("A claim: the Queen grants at most what its allowlist names for this key.")
            }
            .disabled(model.childRuns)

            TextField("~/\(AGENT_DIR)", text: $model.home)
                .textFieldStyle(.roundedBorder)
                .font(TriosType.font(11, design: .monospaced))
                .disabled(model.childRuns)
                .help("TRIOS_HOST_HOME: the agent's key directory. Empty is the agent's own default.")

            HostingSubhead(text: "This host")
            HostingRow(label: "Host id", value: model.hostId)
            HostingRow(label: "Key file", value: keyFileText, tone: model.keyFilePrivate == false ? .orange : .grokText)
            HostingRow(label: "Tier (Queen)", value: model.grantedTier)
            HostingRow(label: "Slots (Queen)", value: model.grantedSlots)
            HostingRow(label: "Isolation (Queen)", value: model.isolation)

            HostingSubhead(text: "Live status")
            HostingRow(label: "State", value: model.stateWord, tone: hostingTone(model.state))
            HostingRow(label: "Registered", value: registeredText)
            HostingRow(label: "Last beat", value: beatText)
            HostingRow(label: "Job running now", value: jobText)
            if !model.lastFailure.isEmpty {
                HostingRow(label: "Last failure", value: "\(hostingClock(model.lastFailureAt)) \(model.lastFailure)", tone: .orange)
            }
            if let status = model.exitStatus, !model.childRuns {
                HostingRow(label: "Agent exit", value: String(status))
            }
            if !model.note.isEmpty {
                HostingRow(label: "Agent", value: model.note)
            }
            if !model.recentLines.isEmpty {
                DisclosureGroup("Agent output") {
                    Text(model.recentLines.suffix(12).joined(separator: "\n"))
                        .font(TriosType.font(10, design: .monospaced))
                        .foregroundColor(.grokMuted)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(TriosType.font(11))
                .foregroundColor(.grokMuted)
            }
        }
        .accessibilityIdentifier("hosting-section")
    }

    private var keyFileText: String {
        guard let mode = model.place.keyFileMode else { return "none yet: \(model.place.keyFile)" }
        let bits = String(mode & 0o777, radix: 8)
        let words = model.keyFilePrivate == true ? "private" : "readable by others"
        return "mode 0\(bits), \(words) (never read by this app)"
    }

    private var registeredText: String {
        guard model.isRegistered else { return model.stateWord }
        return "incarnation \(model.incarnation) at \(hostingClock(model.registeredAt))"
    }

    private var beatText: String {
        let period = "every \(NODE_HEARTBEAT_SECONDS) s, not printed by \(AGENT_TAG)"
        guard model.isRegistered, let confirmed = model.lastConfirmAt else { return period }
        let ago = Int(model.now.timeIntervalSince(confirmed))
        return "\(period); last confirmation \(hostingClock(confirmed)) (\(ago) s ago)"
    }

    private var jobText: String {
        guard model.childRuns else { return "" }
        if !model.runningSpecs.isEmpty { return model.runningSpecs.joined(separator: ", ") }
        if model.runningJobs > 0 { return "\(model.runningJobs) process(es), spec not on the command line" }
        return "none"
    }
}

// MARK: - What we use / what you earn

struct HostingEarningsCard: View {
    @ObservedObject var model: HostingPanelModel

    var body: some View {
        HostingCardFrame(title: "What we use / what you earn", systemImage: "chart.bar.doc.horizontal") {
            HostingSubhead(text: "What we use")
            HostingRow(label: "Slots lent", value: model.grantedSlots.isEmpty ? "" : "\(model.grantedSlots) (granted by the Queen)")
            HostingRow(label: "Jobs this session", value: bucketsText)
            HostingRow(label: "Jobs credited", value: creditedText)
            HostingRow(label: "CPU time", value: cpuText)
            HostingRow(label: "Online", value: model.isRegistered ? hostingDuration(seconds: model.onlineSeconds) : "")
            HostingRow(label: "Isolation", value: model.isolation)

            HostingSubhead(text: "What you earn (\(UNIT_WORD), off-chain)")
            ForEach(0..<Int(SHOWN_KIND_COUNT), id: \.self) { index in
                HostingRow(label: model.kindWord(index), value: kindText(index))
            }
            HostingRow(label: "Balance", value: model.ledgerRow.map { "\($0.balance_mtri) \(UNIT_WORD)" } ?? "")
            HostingRow(label: "Probation", value: probationText)
            HostingRow(label: "Strikes / slashes", value: model.ledgerRow.map { "\($0.strikes) / \($0.slashes)\($0.suspended ? ", suspended" : "")" } ?? "")
            HostingRow(label: "Signed statement", value: statementText, tone: statementTone)

            Divider().overlay(Color.grokBorder)
            Text(model.disclaimerHolds ? DISCLAIMER : "The Queen's ledger no longer matches this panel's disclaimer; the figures are shown as the ledger reports them.")
                .font(TriosType.font(11, weight: .medium))
                .foregroundColor(model.disclaimerHolds ? .grokText : .orange)
                .accessibilityIdentifier("hosting-disclaimer")
            Text(sourceText)
                .font(TriosType.font(9))
                .foregroundColor(.grokDim)
        }
        .accessibilityIdentifier("hosting-earnings")
    }

    private var bucketsText: String {
        (0..<Int(JOB_BUCKETS)).map { "\(model.jobBuckets[$0]) \(model.bucketWord($0))" }.joined(separator: ", ")
    }

    private var creditedText: String {
        guard let row = model.ledgerRow else { return model.hostId.isEmpty ? "no host id yet" : "not in the ledger yet" }
        return "\(row.credited_jobs) credited, \(row.agreed) agreed (ledger, all time)"
    }

    private var cpuText: String {
        guard model.childRuns || model.cpuMillis > 0 else { return "" }
        return String(format: "%.1f s (the agent and its finished jobs)", Double(model.cpuMillis) / 1000)
    }

    private func kindText(_ index: Int) -> String {
        guard model.ledgerRow != nil else { return "" }
        return "\(model.kindToday[index]) today (epoch \(model.todayEpoch)), \(model.kindTotals[index]) total"
    }

    private var probationText: String {
        guard let row = model.ledgerRow else { return "" }
        let need = model.probationJobs.map { " of \($0)" } ?? ""
        return row.probation ? "yes: \(row.agreed)\(need) agreeing jobs so far" : "no"
    }

    private var statementText: String {
        let epoch = model.statementEpoch.map { "epoch \($0): " } ?? ""
        let when = model.statementAt.map { ", checked \(hostingClock($0))" } ?? ""
        return "\(epoch)\(model.verdictWord)\(when)"
    }

    private var statementTone: Color {
        switch Int32(model.statementVerdict) {
        case SV_VERIFIED: return .green
        case SV_NOT_VERIFIED: return .orange
        default: return .grokText
        }
    }

    private var sourceText: String {
        if !model.ledgerError.isEmpty { return "\(QUEEN_URL)\(LEDGER_PATH): \(model.ledgerError)" }
        guard let at = model.ledgerAt else { return "\(QUEEN_URL)\(LEDGER_PATH): not read yet" }
        return "\(QUEEN_URL)\(LEDGER_PATH) at \(hostingClock(at)); statement checked by \(AGENT_TAG) against the Queen key \(QUEEN_KEY.prefix(8))..."
    }
}

// MARK: - The badge

/// The panel's title-bar badge: this host's balance, as the ledger reports it. `open` is the
/// host's navigation to the Hosting section (the Queen's petal API lives in QueenUILib, which
/// this file does not import, so the library build can compile it).
struct HostingBalanceBadge: View {
    @ObservedObject var model: HostingPanelModel = .shared
    let open: () -> Void

    var body: some View {
        if model.badgeShows, let row = model.ledgerRow {
            Button(action: open) {
                HStack(spacing: 4) {
                    Circle()
                        .fill(hostingTone(model.state))
                        .frame(width: 6, height: 6)
                    Text("\(row.balance_mtri) \(UNIT_WORD)")
                        .font(TriosType.font(10, weight: .semibold, design: .monospaced))
                        .foregroundColor(.grokText)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.grokElevated))
            }
            .buttonStyle(.plain)
            .help("Hosting: \(model.stateWord). \(DISCLAIMER)")
            .accessibilityIdentifier("hosting-badge")
        }
    }
}
