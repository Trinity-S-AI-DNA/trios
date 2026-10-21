import AppKit
import Foundation

// Integration test of the TriOS calling seam (.trinity/specs/internet-calls.md,
// gHashTag/trios#2053): the real InternetCallsModel, IncomingCallPanel and
// TRI-NET's InternetCallController/AccountDeviceController/InternetCallAPI
// against a stub call server served by a global URLProtocol, with delayed
// responses where a race matters. Built by .github/workflows/
// trios-calls-seam.yml with -D TRIOS_CALLS, the pinned TRI-NET shared files
// and TriOSLiveKit. No real call server and no LiveKit server: these checks
// cover state, requests and teardown, not audio.

final class CallServerStub: URLProtocol {
    struct Seen: Equatable {
        let host: String
        let method: String
        let path: String
        let authorization: String?
    }

    struct State {
        var incoming: [String] = []
        var failIncoming = 0
        var failDecline = 0
        var delays: [String: Double] = [:]   // "host path" -> seconds
        var seen: [Seen] = []
    }

    private static let lock = NSLock()
    private static var state = State()

    static func update(_ change: (inout State) -> Void) {
        lock.lock(); defer { lock.unlock() }
        change(&state)
    }

    static func read<T>(_ value: (State) -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return value(state)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    private static func body(of request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    override func startLoading() {
        let url = request.url ?? URL(string: "https://stub.invalid")!
        let path = url.path
        let host = url.host ?? ""
        let method = request.httpMethod ?? "GET"
        let json = Self.body(of: request)
        var status = 200
        var body = Data()
        var delay = 0.0
        Self.update { state in
            state.seen.append(Seen(host: host, method: method, path: path,
                                   authorization: request.value(forHTTPHeaderField: "Authorization")))
            delay = state.delays["\(host) \(path)"] ?? 0
            switch path {
            case "/v1/devices/register":
                status = 204
            case "/v1/account":
                let nickname = host == "calls.example.test" ? #""seam_tester""# : "null"
                body = Data(#"{"account_id":"seam-account","nickname":\#(nickname),"devices":[]}"#.utf8)
            case "/v1/account/link":
                body = Data(#"{"account_id":"stale-account","nickname":"stale","devices":[]}"#.utf8)
            case "/v1/directory/nicknames/claim":
                let nickname = json["nickname"] as? String ?? "x"
                body = Data(#"{"claimed":true,"normalized":"\#(nickname)","reason":null,"suggestions":[]}"#.utf8)
            case "/v1/directory/search":
                let query = json["query"] as? String ?? "x"
                body = Data(#"{"results":[{"user_id":"u-\#(query)","device_id":"d-\#(query)","nickname":"\#(query)","display_name":"\#(query)","key_fingerprint":"fp","online":true}]}"#.utf8)
            case "/v1/calls":
                let callee = json["callee"] as? String ?? "x"
                body = Data(#"{"call_id":"C-\#(callee)","room_id":"R-\#(callee)","livekit_url":"wss://livekit.invalid","token":"t","media_key":null}"#.utf8)
            case "/v1/calls/incoming":
                if state.failIncoming > 0 {
                    state.failIncoming -= 1
                    status = 503
                } else {
                    let calls = state.incoming.map {
                        #"{"call_id":"\#($0)","caller":"caller_\#($0.lowercased())","audio":true,"video":false,"created_at":1}"#
                    }
                    body = Data(#"{"calls":[\#(calls.joined(separator: ","))]}"#.utf8)
                }
            default:
                let parts = path.split(separator: "/")
                let callID = parts.count > 2 ? String(parts[2]) : ""
                if path.hasSuffix("/decline") {
                    if state.failDecline > 0 {
                        state.failDecline -= 1
                        status = 500
                    } else {
                        state.incoming.removeAll { $0 == callID }
                        body = Self.status(callID: callID, status: "declined")
                    }
                } else if path.hasSuffix("/cancel") {
                    status = 204
                } else if path.hasSuffix("/end") {
                    body = Self.status(callID: callID, status: "ended")
                } else if path.hasSuffix("/status") {
                    body = Self.status(callID: callID, status: "ringing")
                } else {
                    status = 404
                }
            }
        }
        let respond = { [weak self] in
            guard let self else { return }
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: body)
            self.client?.urlProtocolDidFinishLoading(self)
        }
        if delay > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: respond)
        } else {
            respond()
        }
    }

    override func stopLoading() {}

    static func status(callID: String, status: String) -> Data {
        Data(#"{"call_id":"\#(callID)","call_uuid":"00000000-0000-4000-8000-000000000001","status":"\#(status)","role":"callee","target_status":"\#(status)","answered_here":false,"created_at":1,"answered_at":null,"ended_at":null}"#.utf8)
    }

    static func requests(host: String, pathSuffix: String = "") -> [Seen] {
        read { $0.seen.filter { $0.host == host && $0.path.hasSuffix(pathSuffix) } }
    }
}

@MainActor
enum Seam {
    static var failures = 0

    static func check(_ condition: Bool, _ label: String) {
        print("\(condition ? "PASS" : "FAIL") \(label)")
        if !condition { failures += 1 }
    }

    static func wait(seconds: Double, until condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        return condition()
    }

    static func sleep(_ seconds: Double) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    static func contact(_ nickname: String) -> DirectoryContact {
        DirectoryContact(userID: "u-\(nickname)", deviceID: "d-\(nickname)", nickname: nickname,
                         displayName: nickname, keyFingerprint: "fp", source: .internet,
                         online: true, meshAddress: nil, meshPort: nil)
    }

    static func switchServer(_ model: InternetCallsModel, to address: String) async {
        model.serverAddressInput = address
        model.proposeServerAddress()
        check(model.pendingServerAddress == address, "switch to \(address) waits for confirmation")
        await sleep(0.5)
        let host = URL(string: address)?.host ?? ""
        check(CallServerStub.requests(host: host).isEmpty, "nothing sent to \(host) before confirmation")
        model.confirmServerAddress()
    }

    static func run() async {
        URLProtocol.registerClass(CallServerStub.self)
        let defaults = UserDefaults.standard
        defaults.set("https://calls.example.test", forKey: "internetAPIBaseURL")
        // Fake service token bound to the first server only (not a real secret).
        defaults.set("seam-token-origin-1", forKey: "serviceAccessToken")
        defaults.set("https://calls.example.test", forKey: "serviceAccessTokenOrigin")
        do {
            _ = try DeviceIdentityStore.shared.loadOrCreate(defaultName: "seam-test")
            _ = try DeviceIdentityStore.shared.setNickname("seam_tester")
        } catch {
            check(false, "identity in the Keychain: \(error.localizedDescription)")
            return
        }
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let model = InternetCallsModel.shared
        model.start()
        IncomingCallPanel.shared.start(model: model)
        check(model.accountBound, "bound account starts receiving")
        check(model.origin == .internetHTTPS, "https address is labelled as configured, not verified")
        check(await wait(seconds: 10) { !CallServerStub.requests(host: "calls.example.test").isEmpty },
              "requests reach the first server")
        check(CallServerStub.requests(host: "calls.example.test").allSatisfy { $0.authorization == "Bearer seam-token-origin-1" },
              "the first server's token goes to the first server")

        // 1. An incoming call is offered, shown in the Calls model and in the
        //    app-level panel (visible outside the Calls tab).
        CallServerStub.update { $0.incoming = ["A"] }
        check(await wait(seconds: 10) { model.incoming?.callID == "A" }, "incoming A presented by the shared poll")
        check(await wait(seconds: 3) { IncomingCallPanel.shared.isShowing }, "incoming panel is on screen")

        // 2. A second call while the banner is up is not consumed and is
        //    delivered later; a failed decline keeps the banner.
        CallServerStub.update { $0.incoming = ["A", "B"]; $0.failDecline = 1 }
        await sleep(4)
        check(model.incoming?.callID == "A", "B is not shown over A")
        model.decline()
        check(await wait(seconds: 5) { !model.isDeclining }, "decline attempt finished")
        check(model.incoming?.callID == "A", "a failed decline keeps the banner")
        check(model.notice?.contains("did not reach") == true, "a failed decline says so")
        model.decline()
        check(await wait(seconds: 10) { model.incoming?.callID == "B" },
              "after A is declined, the unconsumed B is offered again and shown")

        // 3. Transient errors keep the banner; authoritative absence closes it.
        CallServerStub.update { $0.failIncoming = 3 }
        await sleep(7)
        check(model.incoming?.callID == "B", "503 from the call server keeps the banner")
        CallServerStub.update { $0.incoming = []; $0.failIncoming = 0 }
        check(await wait(seconds: 10) { model.incoming == nil }, "the banner closes once B is no longer pending")
        check(await wait(seconds: 3) { !IncomingCallPanel.shared.isShowing }, "the incoming panel closes too")

        // 4. Active teardown happens exactly once. The stub's LiveKit URL does
        //    not resolve, so the connect fails after the call was created.
        var base = model.teardownCount
        model.call(contact("fast"))
        check(await wait(seconds: 30) { model.teardownCount == base + 1 && !model.phase.isInProgress },
              "a failed connect of the current call releases media once")
        check(await wait(seconds: 5) { !CallServerStub.requests(host: "calls.example.test", pathSuffix: "/C-fast/cancel").isEmpty },
              "the call server is told to cancel the failed call")
        model.handleRemoteEnded()
        if let ended = try? JSONDecoder().decode(InternetCallStatus.self, from: CallServerStub.status(callID: "C-fast", status: "ended")) {
            model.handleCallStatus(ended)
        }
        check(model.teardownCount == base + 1, "later end signals do not release twice")

        // 5. A delayed completion of call A never ends the newer call B.
        CallServerStub.update {
            $0.delays["calls.example.test /v1/calls"] = 4
        }
        base = model.teardownCount
        model.call(contact("slowa"))
        check(await wait(seconds: 3) { model.phase.isInProgress }, "call A is in progress")
        model.hangUp()
        check(model.teardownCount == base + 1, "hang-up of A releases once")
        CallServerStub.update { $0.delays["calls.example.test /v1/calls"] = 9 }
        await sleep(0.3)
        model.call(contact("slowb"))
        check(await wait(seconds: 3) { model.phase.isInProgress }, "call B is in progress")
        await sleep(6)
        check(model.teardownCount == base + 1, "A's late completion did not tear down B")
        check(model.phase.isInProgress, "B is still in progress after A completed")
        check(model.notice == nil, "A's late failure shows no error on B")
        check(!CallServerStub.requests(host: "calls.example.test", pathSuffix: "/C-slowa/cancel").isEmpty,
              "superseded A is cancelled on the server")
        model.hangUp()
        check(model.teardownCount == base + 2, "hang-up of B releases once")
        CallServerStub.update { $0.delays = [:] }
        await sleep(10)

        // 6. Server change: validation, confirmation, no token or late result
        //    from the previous server.
        model.serverAddressInput = "http://calls.example.com"
        model.proposeServerAddress()
        check(model.pendingServerAddress == nil && model.notice == TriOSServerAddressProblem.unencryptedPublicHost.message,
              "plain http to a public host is refused")

        CallServerStub.update { $0.delays["calls.example.test /v1/directory/nicknames/claim"] = 3 }
        model.nicknameInput = "late_old_claim"
        model.claimNickname()
        await sleep(0.5)
        await switchServer(model, to: "https://other.example.test")
        await sleep(4)
        check(!model.accountBound, "a late claim from the old server does not bind the new one")
        let afterLateClaim = try? DeviceIdentityStore.shared.loadOrCreate(defaultName: "seam-test")
        check(afterLateClaim != nil && afterLateClaim?.nickname == nil,
              "a late claim from the old server is not saved in the Keychain")

        model.nicknameInput = "fresh_nick"
        model.claimNickname()
        check(await wait(seconds: 5) { model.accountBound }, "claiming on the new server binds it")
        check(!CallServerStub.requests(host: "other.example.test").isEmpty
              && CallServerStub.requests(host: "other.example.test").allSatisfy { $0.authorization == nil },
              "the first server's token is never sent to the second")
        check(InternetCallConfiguration.load().accessToken.isEmpty,
              "after a restart the token still does not apply to the second server")
        check(defaults.string(forKey: "internetAPIBaseURL") == "https://other.example.test", "only the address is saved")

        CallServerStub.update { $0.delays["other.example.test /v1/directory/search"] = 3 }
        model.searchQuery = "late_contact"
        model.search()
        await sleep(0.5)
        await switchServer(model, to: "https://third.example.test")
        await sleep(4)
        check(model.contacts.isEmpty, "a late search result of the old server is dropped")

        CallServerStub.update { $0.delays["third.example.test /v1/account/link"] = 3 }
        model.linkCodeInput = "abcdef"
        model.joinAccount()
        await sleep(0.5)
        await switchServer(model, to: "https://fourth.example.test")
        await sleep(4)
        let userID = (try? DeviceIdentityStore.shared.loadOrCreate(defaultName: "seam-test").userID) ?? ""
        check(userID != "stale-account", "a late account link of the old server is not adopted")
        check(!model.accountBound, "the new server starts unbound")
    }
}

@main
struct InternetCallsSeamTest {
    static func main() {
        Task { @MainActor in
            await Seam.run()
            print(Seam.failures == 0 ? "All seam checks passed." : "\(Seam.failures) seam check(s) failed.")
            exit(Seam.failures == 0 ? 0 : 1)
        }
        // The shared incoming poll uses a RunLoop timer; AppKit needs the run loop too.
        RunLoop.main.run()
    }
}
