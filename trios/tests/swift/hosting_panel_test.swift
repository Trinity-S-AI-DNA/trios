// hosting_panel_test.swift -- the Hosting section's glue against the hosting
// card (gHashTag/trios#1756). Run with `make hosting-test`, which compiles this
// file with BR-OUTPUT/HostingAgentProcess.swift,
// BR-OUTPUT/HostingPanelModel.swift and the card's generated C.
//
// The card's own rules are tested in the card (t27c test-report, and the C
// test runner `make hosting-card` runs). What is tested here is that the glue
// hands the card the right values: the agent's real lines, the Queen's real
// JSON shapes, a real child process started, read, signalled and reaped.

import Foundation
import T27HostingPanel

@main
struct HostingPanelTests {
    static var failures = 0
    static var suites: [String] = []

    @MainActor
    static func main() async {
        agentLinesMoveTheState()
        ledgerIsTalliedForThisHostOnly()
        statementVerdicts()
        await queenReadsOnlyTheCardsURLs()
        await anUnpinnedAgentNeverStarts()
        await processLifecycle()
        await stopBlockingKillsAnAgentThatIgnoresSigterm()
        for suite in suites {
            UserDefaults.standard.removePersistentDomain(forName: suite)
            // cfprefsd leaves the emptied plist behind; a test leaves nothing
            try? FileManager.default.removeItem(atPath: "\(NSHomeDirectory())/Library/Preferences/\(suite).plist")
        }
        if failures > 0 {
            FileHandle.standardError.write(Data("FAIL: \(failures) hosting panel check(s)\n".utf8))
            exit(1)
        }
        print("All hosting panel tests passed.")
    }

    static func expect(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
        if !condition() {
            failures += 1
            FileHandle.standardError.write(Data("FAIL (line \(line)): \(message)\n".utf8))
        }
    }

    @MainActor
    static func model(
        fetch: @escaping (URL) async throws -> Data = { _ in throw URLError(.notConnectedToInternet) },
        install: @escaping (URL) async throws -> Void = { _ in throw HostingAgentError.notInstalled }
    ) -> HostingPanelModel {
        let suite = "hosting-panel-test-\(getpid())-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        suites.append(suite)
        let binary = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("hosting-test-\(UUID().uuidString)/trios-host")
        return HostingPanelModel(binary: binary, defaults: defaults, fetch: fetch, install: install)
    }

    // The agent's lines, as hosting-agent.ts and trios-host.ts print them.
    @MainActor
    static func agentLinesMoveTheState() {
        let m = model()
        m.receive(line: "read key 57c4f5d613622106")
        expect(m.hostId == "57c4f5d613622106", "the key line names the host")
        m.receive(line: "zig 0.16.0 /x/zig")
        m.receive(line: "sandbox sandbox-exec: planted job ran (exit 1); connected false, wrote outside its directory false; isolation job-dir-only")
        expect(m.state == UInt8(ST_OFF), "lines do not start an agent the toggle did not")
        // the toggle starts a run; the agent's own start is a task that has not run yet, so the
        // lines below are what move the card's state
        m.setOn(true)
        expect(m.state == UInt8(ST_STARTING), "toggle on: starting")
        m.receive(line: "2026-10-11T08:01:02.345Z registered 57c4f5d613622106 incarnation 7 tier owner slots 2 isolation job-dir-only")
        expect(m.state == UInt8(ST_REGISTERED), "registered line: registered")
        expect(m.incarnation == "7", "incarnation read by position")
        expect(m.grantedTier == "owner", "tier as the Queen reports it")
        expect(m.grantedSlots == "2", "slots as the Queen grants them")
        expect(m.isolation == "job-dir-only", "isolation as the Queen reports it")
        m.receive(line: "2026-10-11T08:01:09.000Z receipt l_2da310f85655fcb0: ok, job agreed")
        m.receive(line: "2026-10-11T08:01:19.000Z receipt l_3e9fbbc4283fc205: ok, job pending")
        m.receive(line: "2026-10-11T08:01:29.000Z receipt l_90b0e196ffe12a9a: late, job agreed")
        expect(m.state == UInt8(ST_BEATING), "a receipt: beating")
        expect(m.jobBuckets == [1, 1, 1, 0], "agreed, pending, refused, unresolved: \(m.jobBuckets)")
        m.receive(line: "2026-10-11T08:02:00.000Z tick: TypeError: fetch failed")
        expect(m.state == UInt8(ST_LAPSED), "a tick failure after registration: lapsed")
        expect(m.lastFailure.contains("fetch failed"), "the failure is kept")
        m.receive(line: "2026-10-11T08:02:05.000Z registered 57c4f5d613622106 incarnation 8 tier owner slots 2 isolation job-dir-only")
        expect(m.state == UInt8(ST_REGISTERED), "a new registration ends the lapse")
        expect(m.incarnation == "8", "the new incarnation")
        m.receive(line: "2026-10-11T08:02:05.000Z registered short")
        expect(m.incarnation == "8", "a short registered line moves no value")
        m.childExited(status: 1)
        expect(m.state == UInt8(ST_EXITED), "the agent died while on: exited")
        expect(m.exitStatus == 1, "its exit status is kept")
    }

    // GET /hosting/ledger, the shape production serves.
    static let ledgerJSON = """
    {"unit":"mTRI","off_chain":true,"transferable":false,"token_value_claimed":false,
     "settlement":{"enabled":false,"threshold_mtri":1000,"chain_of_record":"ton"},
     "sybil":{"on":true,"canary_permille":100,"probation_jobs":10},
     "hosts":[
      {"host":"40ab49ee13569e82","tier":"owner","balance_mtri":48,"credited_jobs":48,"strikes":0,"slashes":0,"agreed":48,"probation":false,"attested":false,"epoch_cap_mtri":null,"suspended":false,"settlement_due":false},
      {"host":"57c4f5d613622106","tier":"owner","balance_mtri":3,"credited_jobs":4,"strikes":1,"slashes":1,"agreed":4,"probation":true,"attested":false,"epoch_cap_mtri":null,"suspended":false,"settlement_due":false}],
     "rows":[
      {"seq":1,"host":"57c4f5d613622106","job":"j_1","kind":"credit","fee_kind":"executor_fee","mtri":1,"epoch":0,"receipt":"l_1","source":"hosting","at":"2026-10-10T21:49:57.454Z"},
      {"seq":2,"host":"40ab49ee13569e82","job":"j_1","kind":"credit","fee_kind":"verifier_fee","mtri":1,"epoch":0,"receipt":"l_2","source":"hosting","at":"2026-10-10T21:49:57.461Z"},
      {"seq":3,"host":"57c4f5d613622106","job":"j_2","kind":"credit","fee_kind":"executor_fee","mtri":1,"epoch":1,"receipt":"l_3","source":"hosting","at":"2026-10-11T01:00:00.000Z"},
      {"seq":4,"host":"57c4f5d613622106","job":"j_3","kind":"credit","fee_kind":"verifier_fee","mtri":1,"epoch":1,"receipt":"l_4","source":"hosting","at":"2026-10-11T02:00:00.000Z"},
      {"seq":5,"host":"57c4f5d613622106","job":"j_4","kind":"credit","fee_kind":"verifier_fee","mtri":1,"epoch":1,"receipt":"l_5","source":"hosting","at":"2026-10-11T03:00:00.000Z"},
      {"seq":6,"host":"57c4f5d613622106","job":"j_5","kind":"slash","fee_kind":"slash","mtri":1,"epoch":1,"receipt":null,"source":"hosting","at":"2026-10-11T04:00:00.000Z"}]}
    """

    @MainActor
    static func ledgerIsTalliedForThisHostOnly() {
        let m = model()
        m.receive(line: "made key 57c4f5d613622106")
        guard let ledger = try? JSONDecoder().decode(HostingLedger.self, from: Data(ledgerJSON.utf8)) else {
            expect(false, "the production ledger shape decodes")
            return
        }
        // 2026-10-11T12:00:00Z: epoch 1
        m.apply(ledger: ledger, at: Date(timeIntervalSince1970: 1_791_590_400 + 86_400 + 43_200))
        expect(m.todayEpoch == 1, "today is epoch 1")
        expect(m.ledgerRow?.balance_mtri == 3, "this host's row, not the first one")
        // shown kinds: executor_fee, verifier_fee, provider_fee, slash
        expect(m.kindWord(0) == "executor_fee" && m.kindWord(3) == "slash", "the card names the kinds")
        expect(m.kindTotals == [2, 2, 0, 1], "totals by kind for this host: \(m.kindTotals)")
        expect(m.kindToday == [1, 2, 0, 1], "today's by kind: \(m.kindToday)")
        expect(m.probationJobs == 10, "probation threshold as the ledger reports it")
        expect(m.disclaimerHolds, "the ledger agrees with the disclaimer")
        expect(m.badgeShows, "the badge shows for a host the ledger lists")
        let open = ledgerJSON.replacingOccurrences(of: "\"settlement\":{\"enabled\":false", with: "\"settlement\":{\"enabled\":true")
        if let opened = try? JSONDecoder().decode(HostingLedger.self, from: Data(open.utf8)) {
            m.apply(ledger: opened, at: Date())
            expect(!m.disclaimerHolds, "an open settlement withdraws the disclaimer")
        } else {
            expect(false, "the opened ledger decodes")
        }
        let stranger = model()
        stranger.receive(line: "read key ffffffffffffffff")
        stranger.apply(ledger: ledger, at: Date())
        expect(stranger.ledgerRow == nil && stranger.kindTotals == [0, 0, 0, 0], "a host the ledger lacks earns nothing here")
        expect(!stranger.badgeShows, "and has no badge")
    }

    @MainActor
    static func statementVerdicts() {
        let m = model()
        let two = #"{"host":"57c4f5d613622106","queen_key":"1d90","checks":[{"code":0},{"code":0}]}"#
        m.apply(statement: .init(ran: true, exitCode: 0, output: two), anySigned: true, at: Date())
        expect(m.statementVerdict == UInt8(SV_VERIFIED), "exit 0 with two leaves: verified")
        m.apply(statement: .init(ran: true, exitCode: 1, output: two), anySigned: true, at: Date())
        expect(m.statementVerdict == UInt8(SV_NOT_VERIFIED), "exit 1 with leaves: not verified")
        let none = #"{"host":"57c4f5d613622106","queen_key":"1d90","checks":[]}"#
        m.apply(statement: .init(ran: true, exitCode: 1, output: none), anySigned: true, at: Date())
        expect(m.statementVerdict == UInt8(SV_NO_LEAF), "no leaf is not 'not verified'")
        m.apply(statement: .init(ran: true, exitCode: 1, output: "404 no such epoch"), anySigned: true, at: Date())
        expect(m.statementVerdict == UInt8(SV_NOT_CHECKED), "no JSON: not checked")
        expect(m.verdictWord == "not checked", "the card's word")
    }

    @MainActor
    static func queenReadsOnlyTheCardsURLs() async {
        var asked: [String] = []
        let m = model(fetch: { url in
            asked.append(url.absoluteString)
            return Data(ledgerJSON.utf8)
        })
        await m.refreshLedger()
        expect(asked == [QUEEN_URL + LEDGER_PATH], "the ledger is read at the card's address: \(asked)")
        expect(m.ledgerAt != nil && m.ledgerError.isEmpty, "and applied")
    }

    @MainActor
    static func anUnpinnedAgentNeverStarts() async {
        var installs = 0
        let m = model(install: { binary in
            installs += 1
            // a binary that is not the pinned agent, where the pinned one should be
            try FileManager.default.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("#!/bin/sh\necho registered\n".utf8).write(to: binary)
        })
        m.setOn(true)
        for _ in 0..<100 where m.state == UInt8(ST_STARTING) {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        expect(installs == 1, "an absent agent is fetched once")
        expect(m.state == UInt8(ST_EXITED), "an agent that is not the pin never starts: \(m.stateWord)")
        expect(m.note.contains("refused"), "and the refusal is said: \(m.note)")
        m.setOn(false)
        expect(m.state == UInt8(ST_OFF), "off again")
        try? FileManager.default.removeItem(at: m.binary.deletingLastPathComponent())
    }

    static func processLifecycle() async {
        var lines: [String] = []
        var exit: Int32?
        let script = "echo 'read key 57c4f5d613622106'; printf 'zig 0.16.0\\nno newline at the end'; trap 'exit 0' TERM; while :; do sleep 0.05; done"
        let process = HostingAgentProcess(
            binary: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", script],
            environment: HostingAgentPlace(binary: URL(fileURLWithPath: "/bin/sh"), home: "/tmp/hosting-home").environment,
            onLine: { lines.append($0) },
            onExit: { exit = $0 }
        )
        do { try process.start() } catch {
            expect(false, "a child starts: \(error)")
            return
        }
        for _ in 0..<100 where lines.count < 2 { try? await Task.sleep(nanoseconds: 20_000_000) }
        expect(lines.prefix(2) == ["read key 57c4f5d613622106", "zig 0.16.0"], "lines arrive whole: \(lines)")
        expect(process.isRunning, "the child runs while the toggle is on")
        process.terminate()
        for _ in 0..<150 where exit == nil { try? await Task.sleep(nanoseconds: 20_000_000) }
        expect(exit == 0, "SIGTERM ends it cleanly: \(String(describing: exit))")
        expect(lines.last == "no newline at the end", "the last partial line is kept: \(lines)")
        expect(!process.isRunning, "and it is reaped")
        let env = HostingAgentPlace(binary: URL(fileURLWithPath: "/bin/sh"), home: "/tmp/hosting-home").environment
        expect(env["TRIOS_HOST_HOME"] == "/tmp/hosting-home", "the child gets its home")
        expect(Set(env.keys).isSubset(of: ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "TRIOS_HOST_HOME"]),
               "and no other variable of the app's: \(env.keys.sorted())")
    }

    static func stopBlockingKillsAnAgentThatIgnoresSigterm() async {
        var exit: Int32?
        let process = HostingAgentProcess(
            binary: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "trap '' TERM; while :; do sleep 0.05; done"],
            environment: ["PATH": "/usr/bin:/bin"],
            onLine: { _ in },
            onExit: { exit = $0 }
        )
        do { try process.start() } catch {
            expect(false, "a child starts: \(error)")
            return
        }
        try? await Task.sleep(nanoseconds: 200_000_000)
        let started = Date()
        process.stopBlocking(graceSeconds: 1)
        let took = Date().timeIntervalSince(started)
        expect(!process.isRunning, "a child that ignores SIGTERM is killed")
        expect(took >= 0.9 && took < 4, "after the grace, not before: \(took) s")
        for _ in 0..<50 where exit == nil { try? await Task.sleep(nanoseconds: 20_000_000) }
        expect(exit != nil, "and its end is reported")
    }
}
