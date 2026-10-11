// HostingPanelModel.swift -- the state behind the Hosting section and its card
// "What we use / what you earn" (gHashTag/trios#1756).
//
// THIN GLUE. The hosting card, gHashTag/t27 specs/hosting/panel.t27 (imported
// as T27HostingPanel), decides everything shown here: the agent's state
// (next_state), what each of its lines means (first_word_at, line_event and
// the *_AT positions), the jobs buckets (bucket_count_after), the per-kind
// tally of the ledger (kind_total_after), today's epoch, the latest signed
// epoch, the statement verdict, whether the disclaimer may be shown, and
// whether the badge shows. This file holds the values, reads the Queen and
// the agent, and passes each value to the card.
//
// EVERY NUMBER HAS A SOURCE. The agent's lines (registration, receipts,
// failures), the OS (CPU time, child processes), the Queen's public ledger
// (balance, kinds, strikes, slashes, probation) and `trios-host statement`
// (the verdict). Nothing here is estimated, and nothing is shown before its
// source answered.

import Combine
import Foundation
import T27HostingPanel

/// GET /hosting/ledger: the fields the panel reads.
struct HostingLedger: Decodable {
    struct Settlement: Decodable {
        let enabled: Bool
    }

    struct Sybil: Decodable {
        let on: Bool?
        let probation_jobs: UInt32?
    }

    struct Host: Decodable, Equatable {
        let host: String
        let tier: String
        let balance_mtri: UInt64
        let credited_jobs: UInt64
        let strikes: UInt32
        let slashes: UInt32
        let agreed: UInt64
        let probation: Bool
        let suspended: Bool
    }

    struct Row: Decodable {
        let host: String
        let kind: String
        let fee_kind: String?
        let mtri: UInt64
        let epoch: UInt64
    }

    let unit: String
    let off_chain: Bool
    let transferable: Bool
    let token_value_claimed: Bool
    let settlement: Settlement
    let sybil: Sybil?
    let hosts: [Host]
    let rows: [Row]
}

/// GET /hosting/ledger/epochs: the listing the latest signed epoch is read from.
struct HostingEpochs: Decodable {
    struct Epoch: Decodable {
        let epoch: UInt64
        let signature: String?
    }

    let signed: Bool
    let epochs: [Epoch]
}

/// `trios-host statement`'s JSON: one check per leaf of this host.
struct HostingStatementOutput: Decodable {
    struct Check: Decodable {}
    let checks: [Check]
}

@MainActor
final class HostingPanelModel: ObservableObject {
    // MARK: Settings (the user's; kept in UserDefaults)

    @Published private(set) var wantsOn: Bool
    @Published var slotsWanted: UInt32 { didSet { defaults.set(Int(slotsWanted), forKey: Keys.slots) } }
    @Published var tierClaim: UInt8 { didSet { defaults.set(Int(tierClaim), forKey: Keys.tier) } }
    @Published var home: String { didSet { defaults.set(home, forKey: Keys.home) } }

    // MARK: The agent (from its own lines and the OS)

    @Published private(set) var state = UInt8(ST_OFF)
    @Published private(set) var hostId = ""
    @Published private(set) var incarnation = ""
    @Published private(set) var grantedTier = ""
    @Published private(set) var grantedSlots = ""
    @Published private(set) var isolation = ""
    @Published private(set) var registeredAt: Date?
    @Published private(set) var lastConfirmAt: Date?
    @Published private(set) var lastFailure = ""
    @Published private(set) var lastFailureAt: Date?
    @Published private(set) var jobBuckets = [UInt32](repeating: 0, count: Int(JOB_BUCKETS))
    @Published private(set) var cpuMillis: UInt64 = 0
    @Published private(set) var runningJobs = 0
    @Published private(set) var runningSpecs: [String] = []
    @Published private(set) var exitStatus: Int32?
    @Published private(set) var note = ""
    @Published private(set) var recentLines: [String] = []
    @Published private(set) var now = Date()

    // MARK: The ledger (GET /hosting/ledger)

    @Published private(set) var ledgerRow: HostingLedger.Host?
    @Published private(set) var kindTotals = [UInt64](repeating: 0, count: Int(SHOWN_KIND_COUNT))
    @Published private(set) var kindToday = [UInt64](repeating: 0, count: Int(SHOWN_KIND_COUNT))
    @Published private(set) var todayEpoch: UInt64 = 0
    @Published private(set) var probationJobs: UInt32?
    @Published private(set) var disclaimerHolds = false
    @Published private(set) var ledgerAt: Date?
    @Published private(set) var ledgerError = ""

    // MARK: The statement (GET /hosting/ledger/epochs, then `trios-host statement`)

    @Published private(set) var statementEpoch: UInt64?
    @Published private(set) var statementVerdict = UInt8(SV_NOT_CHECKED)
    @Published private(set) var statementAt: Date?

    /// Bumped when something asks the panel to show the Hosting section.
    @Published private(set) var focusRequest = 0

    let binary: URL
    private let defaults: UserDefaults
    private let fetch: (URL) async throws -> Data
    private let install: (URL) async throws -> Void
    private var agent: HostingAgentProcess?
    private var killTimer: Timer?
    private var clock: Timer?
    private var ledgerClock: Timer?
    private var statementClock: Timer?
    /// The most agent lines the section keeps to show.
    private let recentLineRoom = 40

    private enum Keys {
        static let on = "trios.hosting.on"
        static let slots = "trios.hosting.slots"
        static let tier = "trios.hosting.tier"
        static let home = "trios.hosting.home"
    }

    init(
        binary: URL,
        defaults: UserDefaults,
        fetch: @escaping (URL) async throws -> Data = { try await URLSession.shared.data(from: $0).0 },
        install: @escaping (URL) async throws -> Void = { try await HostingAgentInstaller.install(to: $0) }
    ) {
        self.binary = binary
        self.defaults = defaults
        self.fetch = fetch
        self.install = install
        wantsOn = defaults.bool(forKey: Keys.on)
        let storedTier = defaults.object(forKey: Keys.tier) as? Int ?? Int(TIER_PUBLIC)
        tierClaim = UInt8(clamping: storedTier)
        let storedSlots = defaults.object(forKey: Keys.slots) as? Int ?? 1
        slotsWanted = UInt32(clamping: storedSlots)
        home = defaults.string(forKey: Keys.home) ?? ""
    }

    var place: HostingAgentPlace { HostingAgentPlace(binary: binary, home: home) }

    // MARK: Card readings the views show

    var stateWord: String { hostingCardText(state_word(state)) }
    var isRegistered: Bool { registered(state) }
    var childRuns: Bool { child_runs(state) }
    var slotsOffered: UInt32 { slots_offered(tierClaim, slotsWanted) }
    var verdictWord: String { hostingCardText(verdict_word(statementVerdict)) }
    var badgeShows: Bool { badge_visible(!hostId.isEmpty, ledgerRow != nil) }
    var onlineSeconds: UInt64 {
        online_seconds(state, unix(registeredAt), unix(now))
    }

    var keyFilePrivate: Bool? {
        place.keyFileMode.map { key_file_private($0) }
    }

    func bucketWord(_ bucket: Int) -> String { hostingCardText(bucket_word(UInt8(bucket))) }
    func kindWord(_ index: Int) -> String { hostingCardText(kind_word(shown_kind(UInt32(index)))) }
    func tierWord(_ tier: UInt8) -> String { hostingCardText(tier_word(tier)) }

    // MARK: The toggle

    func setOn(_ on: Bool) {
        wantsOn = on
        defaults.set(on, forKey: Keys.on)
        apply(UInt8(on ? EVENT_TOGGLE_ON : EVENT_TOGGLE_OFF))
    }

    /// The pid of the agent this app started, beside its binary: an app killed without its quit
    /// (SIGKILL, a crash) leaves its agent running, and the next launch must find it.
    private var pidFile: URL { binary.deletingLastPathComponent().appendingPathComponent("agent.pid") }

    /// At launch the state is off, and the card's child_runs says no agent runs while off: an agent
    /// a killed app left behind - the pid file names it, and it runs this binary - is stopped.
    func stopLeftover() {
        guard !child_runs(state), agent == nil,
              let text = try? String(contentsOf: pidFile, encoding: .utf8),
              let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)),
              HostingAgentProbe.executablePath(of: pid) == binary.path else { return }
        kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(TimeInterval(STOP_GRACE_SECONDS))
        while HostingAgentProbe.executablePath(of: pid) != nil && Date() < deadline { usleep(50_000) }
        if HostingAgentProbe.executablePath(of: pid) != nil { kill(pid, SIGKILL) }
        try? FileManager.default.removeItem(at: pidFile)
        note = "stopped an agent a previous run left behind (pid \(pid))"
    }

    /// At launch: an agent left behind is stopped, the toggle the user left on is on again, and
    /// the clocks run.
    func resumeIfWanted() {
        stopLeftover()
        startClocks()
        if wantsOn { apply(UInt8(EVENT_TOGGLE_ON)) }
        Task { await refreshAll() }
    }

    /// Ask the panel to show the Hosting section.
    func requestFocus() { focusRequest += 1 }

    /// On quit: the agent stops before the app does. The toggle keeps its value.
    func stopForQuit() {
        guard let running = agent else { return }
        running.stopBlocking(graceSeconds: UInt32(STOP_GRACE_SECONDS))
        try? FileManager.default.removeItem(at: pidFile)
        agent = nil
    }

    private func apply(_ event: UInt8, quiet: UInt32 = 0) {
        let before = state
        state = next_state(state, event, quiet)
        guard state != before else { return }
        if state == UInt8(ST_STARTING) { launch() }
        if state == UInt8(ST_STOPPING) { stop() }
    }

    private func launch() {
        exitStatus = nil
        registeredAt = nil
        lastConfirmAt = nil
        lastFailure = ""
        lastFailureAt = nil
        incarnation = ""
        grantedTier = ""
        grantedSlots = ""
        isolation = ""
        jobBuckets = [UInt32](repeating: 0, count: Int(JOB_BUCKETS))
        cpuMillis = 0
        Task { await startAgent() }
    }

    private func startAgent() async {
        if !HostingAgentInstaller.installedIsKept(binary) {
            note = "downloading \(AGENT_TAG)"
            do {
                try await install(binary)
            } catch {
                note = String(describing: error)
                childExited(status: -1)
                return
            }
        }
        // the toggle may have gone off while the agent downloaded
        guard state == UInt8(ST_STARTING) else { return }
        guard HostingAgentInstaller.installedIsKept(binary) else {
            note = "refused: \(binary.path) is not the pinned \(AGENT_TAG)"
            childExited(status: -1)
            return
        }
        let arguments = [
            "join",
            "--queen", QUEEN_URL,
            "--slots", String(slotsOffered),
            "--tier", tierWord(tierClaim),
        ]
        let process = HostingAgentProcess(
            binary: binary,
            arguments: arguments,
            environment: place.environment,
            onLine: { [weak self] line in self?.receive(line: line) },
            onExit: { [weak self] status in self?.childExited(status: status) }
        )
        do {
            try process.start()
            agent = process
            try? String(process.pid).write(to: pidFile, atomically: true, encoding: .utf8)
            note = "\(AGENT_TAG) pid \(process.pid)"
        } catch {
            note = String(describing: error)
            childExited(status: -1)
        }
    }

    private func stop() {
        guard let agent else {
            childExited(status: 0)
            return
        }
        agent.terminate()
        killTimer?.invalidate()
        killTimer = Timer.scheduledTimer(withTimeInterval: TimeInterval(STOP_GRACE_SECONDS), repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, let running = self.agent, running.isRunning else { return }
                kill(running.pid, SIGKILL)
            }
        }
    }

    // MARK: The agent's lines and its end

    /// One line of the agent's output, read by the card's positions.
    func receive(line: String) {
        recentLines.append(line)
        if recentLines.count > recentLineRoom { recentLines.removeFirst(recentLines.count - recentLineRoom) }
        let words = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard let word0 = words.first else { return }
        let at = Int(first_word_at(word0))
        guard words.count > at else { return }
        let first = words[at]
        let second = words.count > at + 1 ? words[at + 1] : ""
        if names_key(first, second), words.count > at + Int(KEY_ID_AT) {
            hostId = words[at + Int(KEY_ID_AT)]
        }
        let event = line_event(first)
        let stamp = Date()
        switch Int32(event) {
        case EVENT_REGISTERED where words.count >= at + Int(REG_WORDS):
            hostId = words[at + Int(REG_HOST_AT)]
            incarnation = words[at + Int(REG_INCARNATION_AT)]
            grantedTier = words[at + Int(REG_TIER_AT)]
            grantedSlots = words[at + Int(REG_SLOTS_AT)]
            isolation = words[at + Int(REG_ISOLATION_AT)]
            if registeredAt == nil {
                registeredAt = stamp
                // the agent is installed and its key read: the reads that need them run now,
                // not at the next tick of their clocks
                Task { await refreshLedger(); await refreshStatement() }
            }
            lastConfirmAt = stamp
        case EVENT_RECEIPT where words.count >= at + Int(RECEIPT_WORDS):
            let code = receipt_code_of_word(words[at + Int(RECEIPT_CODE_AT)])
            let verdict = job_verdict_of_word(words[at + Int(RECEIPT_VERDICT_AT)])
            for bucket in 0..<Int(JOB_BUCKETS) {
                jobBuckets[bucket] = bucket_count_after(jobBuckets[bucket], UInt8(bucket), code, verdict)
            }
            lastConfirmAt = stamp
        case EVENT_FAILURE:
            lastFailure = line
            lastFailureAt = stamp
        default:
            break
        }
        apply(event)
    }

    /// The agent's process ended (or never started: -1).
    func childExited(status: Int32) {
        exitStatus = status
        if agent != nil { try? FileManager.default.removeItem(at: pidFile) }
        agent = nil
        killTimer?.invalidate()
        killTimer = nil
        runningJobs = 0
        runningSpecs = []
        apply(UInt8(EVENT_CHILD_EXIT))
    }

    // MARK: Clocks

    private func startClocks() {
        guard clock == nil else { return }
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        ledgerClock = Timer.scheduledTimer(withTimeInterval: TimeInterval(LEDGER_POLL_SECONDS), repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshLedger() }
        }
        statementClock = Timer.scheduledTimer(withTimeInterval: TimeInterval(STATEMENT_POLL_SECONDS), repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refreshStatement() }
        }
    }

    /// Once a second: the quiet clock, the agent's CPU time and the jobs it runs now.
    func tick() {
        now = Date()
        if let confirmed = lastConfirmAt {
            let quiet = UInt32(clamping: Int(now.timeIntervalSince(confirmed)))
            apply(UInt8(EVENT_QUIET), quiet: quiet)
        }
        guard let agent, agent.isRunning else { return }
        if let millis = HostingAgentProbe.cpuMillis(pid: agent.pid) { cpuMillis = millis }
        let running = HostingAgentProbe.runningSpecs(of: agent.pid)
        runningJobs = running.jobs
        runningSpecs = running.specs
    }

    // MARK: The Queen's reads

    func refreshAll() async {
        await refreshHostId()
        await refreshLedger()
        await refreshStatement()
    }

    /// While the agent is off, its id comes from `trios-host key`, and only when the key file is
    /// there already: the app never makes a key by asking for one.
    func refreshHostId() async {
        guard hostId.isEmpty, place.keyFileExists, HostingAgentInstaller.installedIsKept(binary) else { return }
        let outcome = await HostingAgentCommand.run(place, ["key"], seconds: 30)
        for line in outcome.output.split(separator: "\n") {
            let words = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            if words.count > Int(KEY_ID_AT), names_host_id(words[0], words[1]) {
                hostId = words[Int(KEY_ID_AT)]
            }
        }
    }

    private func read<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let address = QUEEN_URL + path
        guard fetch_allowed(address), let url = URL(string: address) else {
            throw HostingAgentError.urlRefused(address)
        }
        return try JSONDecoder().decode(T.self, from: try await fetch(url))
    }

    func refreshLedger() async {
        do {
            let ledger = try await read(LEDGER_PATH, as: HostingLedger.self)
            apply(ledger: ledger, at: Date())
        } catch {
            ledgerError = String(describing: error)
        }
    }

    /// Every value of the earnings card from one ledger, each through the card.
    func apply(ledger: HostingLedger, at moment: Date) {
        let me = hostId
        ledgerRow = ledger.hosts.first { same_word($0.host, me) }
        let today = today_epoch(unix(moment))
        todayEpoch = today
        var totals = [UInt64](repeating: 0, count: Int(SHOWN_KIND_COUNT))
        var todays = [UInt64](repeating: 0, count: Int(SHOWN_KIND_COUNT))
        for index in 0..<Int(SHOWN_KIND_COUNT) {
            let kind = shown_kind(UInt32(index))
            for row in ledger.rows {
                let fee = row.fee_kind ?? ""
                totals[index] = kind_total_after(totals[index], row.host, me, fee, row.mtri, kind, row.epoch, false, 0)
                todays[index] = kind_total_after(todays[index], row.host, me, fee, row.mtri, kind, row.epoch, true, today)
            }
        }
        kindTotals = totals
        kindToday = todays
        probationJobs = ledger.sybil?.probation_jobs
        disclaimerHolds = disclaimer_true(
            ledger.off_chain, ledger.transferable, ledger.settlement.enabled, ledger.token_value_claimed
        )
        ledgerAt = moment
        ledgerError = ""
    }

    func refreshStatement() async {
        let listing: HostingEpochs
        do {
            listing = try await read(EPOCHS_PATH, as: HostingEpochs.self)
        } catch {
            statementVerdict = statement_verdict(false, false, 0, 0)
            return
        }
        var have = false
        var latest: UInt64 = 0
        for epoch in listing.epochs {
            let signed = epoch_signed(listing.signed, epoch.signature ?? "")
            latest = latest_signed_after(have, latest, epoch.epoch, signed)
            have = have || signed
        }
        statementEpoch = have ? latest : nil
        guard have, place.keyFileExists, HostingAgentInstaller.installedIsKept(binary) else {
            statementVerdict = statement_verdict(have, false, 0, 0)
            return
        }
        let outcome = await HostingAgentCommand.run(
            place,
            ["statement", "--queen", QUEEN_URL, "--epoch", String(latest), "--queen-key", QUEEN_KEY],
            seconds: 60
        )
        apply(statement: outcome, anySigned: have, at: Date())
    }

    /// The verdict from one `trios-host statement` run, through the card.
    func apply(statement outcome: HostingAgentCommand.Outcome, anySigned: Bool, at moment: Date) {
        let parsed = outcome.ran
            ? try? JSONDecoder().decode(HostingStatementOutput.self, from: Data(outcome.output.utf8))
            : nil
        statementVerdict = statement_verdict(
            anySigned,
            parsed != nil,
            UInt32(bitPattern: outcome.exitCode),
            UInt32(clamping: parsed?.checks.count ?? 0)
        )
        statementAt = moment
    }

    private func unix(_ date: Date?) -> UInt64 {
        guard let date else { return 0 }
        return UInt64(max(0, date.timeIntervalSince1970))
    }
}
