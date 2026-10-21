import Foundation

// Integration test of the TriOS calling seam (.trinity/specs/internet-calls.md,
// gHashTag/trios#2053): the real InternetCallsModel and TRI-NET's
// InternetCallController/InternetCallAPI against a stub call server served by
// a global URLProtocol. Built by .github/workflows/trios-calls-seam.yml with
// -D TRIOS_CALLS, the pinned TRI-NET shared files and TriOSLiveKit. No real
// network, no LiveKit room.

final class CallServerStub: URLProtocol {
    struct State {
        var incoming: [String] = []
        var failIncoming = 0
        var failDecline = 0
        var hosts: [String] = []
        var paths: [String] = []
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

    override func startLoading() {
        let path = request.url?.path ?? ""
        let host = request.url?.host ?? ""
        var status = 200
        var body = Data()
        Self.update { state in
            state.hosts.append(host)
            state.paths.append(path)
            switch path {
            case "/v1/devices/register":
                status = 204
            case "/v1/account":
                body = Data(#"{"account_id":"seam-account","nickname":"seam_tester","devices":[]}"#.utf8)
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
                if path.hasPrefix("/v1/calls/"), path.hasSuffix("/decline") {
                    let callID = path.split(separator: "/")[2]
                    if state.failDecline > 0 {
                        state.failDecline -= 1
                        status = 500
                    } else {
                        state.incoming.removeAll { $0 == callID }
                        body = Self.status(callID: String(callID), status: "declined")
                    }
                } else if path.hasPrefix("/v1/calls/"), path.hasSuffix("/status") {
                    body = Self.status(callID: String(path.split(separator: "/")[2]), status: "ringing")
                } else {
                    status = 404
                }
            }
        }
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "https://stub.invalid")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func status(callID: String, status: String) -> Data {
        Data(#"{"call_id":"\#(callID)","call_uuid":"00000000-0000-4000-8000-000000000001","status":"\#(status)","role":"callee","target_status":"\#(status)","answered_here":false,"created_at":1,"answered_at":null,"ended_at":null}"#.utf8)
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

    static func run() async {
        URLProtocol.registerClass(CallServerStub.self)
        UserDefaults.standard.set("https://calls.example.test", forKey: "internetAPIBaseURL")
        do {
            _ = try DeviceIdentityStore.shared.loadOrCreate(defaultName: "seam-test")
            _ = try DeviceIdentityStore.shared.setNickname("seam_tester")
        } catch {
            check(false, "identity in the Keychain: \(error.localizedDescription)")
            return
        }
        let model = InternetCallsModel.shared
        model.start()
        check(model.accountBound, "bound account starts receiving")
        check(model.origin == .internetHTTPS, "https origin is labelled as a configured HTTPS address")

        // 1. An incoming call is offered and shown.
        CallServerStub.update { $0.incoming = ["A"] }
        check(await wait(seconds: 10) { model.incoming?.callID == "A" }, "incoming A presented by the shared poll")

        // 2. A second call while the banner is up is not consumed, and is
        //    delivered later. A failed decline keeps the banner.
        CallServerStub.update { $0.incoming = ["A", "B"]; $0.failDecline = 1 }
        try? await Task.sleep(nanoseconds: 4_000_000_000)
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
        try? await Task.sleep(nanoseconds: 7_000_000_000)
        check(model.incoming?.callID == "B", "503 from the call server keeps the banner")
        CallServerStub.update { $0.incoming = []; $0.failIncoming = 0 }
        check(await wait(seconds: 10) { model.incoming == nil }, "the banner closes once B is no longer pending")

        // 4. End signals release media once and leave a fixed notice.
        let declined = try? JSONDecoder().decode(
            InternetCallStatus.self,
            from: Data(#"{"call_id":"C","call_uuid":"u","status":"declined","role":"caller","target_status":null,"answered_here":false,"created_at":1,"answered_at":null,"ended_at":2}"#.utf8)
        )
        if let declined {
            model.handleCallStatus(declined)
            check(model.notice == "Call declined.", "terminal status from the shared poll ends the call")
        } else {
            check(false, "status fixture decodes")
        }
        model.handleRemoteEnded()
        model.handleRemoteEnded()
        check(model.notice == "The call ended.", "remote departure ends the call; repeated signals are harmless")

        // 5. Server change: validated, confirmed, nothing sent before.
        model.serverAddressInput = "http://calls.example.com"
        model.proposeServerAddress()
        check(model.pendingServerAddress == nil && model.notice == TriOSServerAddressProblem.unencryptedPublicHost.message,
              "plain http to a public host is refused")
        model.serverAddressInput = "https://other.example.test"
        model.proposeServerAddress()
        check(model.pendingServerAddress == "https://other.example.test", "a different server waits for confirmation")
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        check(!CallServerStub.read { $0.hosts.contains("other.example.test") },
              "nothing is sent to an unconfirmed server")
        model.confirmServerAddress()
        check(!model.accountBound, "the nickname of the previous server is not reused")
        check(UserDefaults.standard.string(forKey: "internetAPIBaseURL") == "https://other.example.test",
              "only the address is saved")
        check(model.incoming == nil && model.contacts.isEmpty, "state of the previous server is cleared")
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
        // The shared incoming poll uses a RunLoop timer.
        RunLoop.main.run()
    }
}
