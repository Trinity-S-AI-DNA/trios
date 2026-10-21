import XCTest
@testable import TriOSKit

/// Spec: .trinity/specs/internet-calls.md (gHashTag/trios#2053).
final class TriOSCallPolicyTests: XCTestCase {
    // Spec test 1
    func testControllerStatesMapToPhasesAndLabels() {
        let expected: [(String, TriOSCallPhase, String)] = [
            ("Idle", .idle, "Ready"),
            ("Calling", .calling, "Calling..."),
            ("Ringing", .ringing, "Ringing..."),
            ("Connecting", .connecting, "Connecting..."),
            ("Connected", .connected, "Connected"),
            ("Reconnecting", .reconnecting, "Reconnecting..."),
            ("Ended", .ended, "Call ended"),
            ("Failed", .failed, "Call failed")
        ]
        for (raw, phase, label) in expected {
            XCTAssertEqual(TriOSCallPhase(controllerState: raw), phase, raw)
            XCTAssertEqual(phase.label, label, raw)
        }
        XCTAssertEqual(TriOSCallPhase(controllerState: "idle"), .failed, "case-sensitive raw values")
        XCTAssertEqual(TriOSCallPhase(controllerState: ""), .failed)
    }

    // Spec test 2
    func testCallButtonNeedsBindingOriginExactContactAndNoCallInProgress() {
        func enabled(
            bound: Bool = true,
            origin: TriOSCallOrigin = .internetHTTPS,
            source: TriOSCallContactSource = .exactDirectoryLookup,
            contact: String = "user_b",
            own: String = "user_a",
            phase: TriOSCallPhase = .idle
        ) -> Bool {
            TriOSCallPolicy.callButtonEnabled(
                accountBound: bound,
                origin: origin,
                contactSource: source,
                contactUserID: contact,
                ownUserID: own,
                phase: phase
            )
        }
        XCTAssertTrue(enabled())
        XCTAssertTrue(enabled(origin: .localNetworkOnly), "LAN origin is allowed but labelled")
        XCTAssertTrue(enabled(phase: .ended))
        XCTAssertTrue(enabled(phase: .failed))
        XCTAssertFalse(enabled(bound: false))
        XCTAssertFalse(enabled(origin: .notConfigured))
        XCTAssertFalse(enabled(source: .meshNode(123)))
        XCTAssertFalse(enabled(contact: "user_a"), "own account")
        XCTAssertFalse(enabled(contact: ""))
        for phase in [TriOSCallPhase.calling, .ringing, .connecting, .connected, .reconnecting] {
            XCTAssertFalse(enabled(phase: phase), phase.rawValue)
        }
    }

    // Spec test 3
    func testControlsExistOnlyInTheirPhases() {
        XCTAssertTrue(TriOSCallPolicy.incomingActionsEnabled(hasIncomingCall: true, phase: .idle))
        XCTAssertFalse(TriOSCallPolicy.incomingActionsEnabled(hasIncomingCall: false, phase: .idle))
        XCTAssertFalse(TriOSCallPolicy.incomingActionsEnabled(hasIncomingCall: true, phase: .connected))
        let muteable: Set<TriOSCallPhase> = [.connecting, .connected, .reconnecting]
        let hangUp: Set<TriOSCallPhase> = [.calling, .ringing, .connecting, .connected, .reconnecting]
        for phase in TriOSCallPhase.allCases {
            XCTAssertEqual(phase.allowsMute, muteable.contains(phase), phase.rawValue)
            XCTAssertEqual(phase.allowsHangUp, hangUp.contains(phase), phase.rawValue)
        }
        XCTAssertTrue(TriOSCallPolicy.audioRequested)
        XCTAssertFalse(TriOSCallPolicy.videoRequested)
    }

    // Spec test 4
    func testMeshPeerIsNeverCallable() {
        for node in [UInt32(0), 1, 2, 123, UInt32.max] {
            XCTAssertFalse(TriOSCallPolicy.meshPeerIsCallable(node))
        }
    }

    // Spec test 5
    func testOriginClassification() {
        XCTAssertEqual(TriOSCallOrigin.classify(""), .notConfigured)
        XCTAssertEqual(TriOSCallOrigin.classify("not a url"), .notConfigured)
        XCTAssertEqual(TriOSCallOrigin.classify("ftp://calls.example.com"), .notConfigured)
        XCTAssertEqual(TriOSCallOrigin.classify("http://SSDs-MacBook-Pro.local:8080"), .localNetworkOnly)
        XCTAssertEqual(TriOSCallOrigin.classify("http://192.168.1.5:8080"), .localNetworkOnly)
        XCTAssertEqual(TriOSCallOrigin.classify("https://192.168.1.5"), .localNetworkOnly)
        XCTAssertEqual(TriOSCallOrigin.classify("https://localhost:8443"), .localNetworkOnly)
        XCTAssertEqual(TriOSCallOrigin.classify("http://calls.example.com"), .localNetworkOnly,
                       "plain http is never labelled Internet")
        XCTAssertEqual(TriOSCallOrigin.classify("https://calls.example.com"), .internetHTTPS)
        XCTAssertEqual(TriOSCallOrigin.classify("https://[fd00::1]:8443"), .localNetworkOnly)
        XCTAssertEqual(TriOSCallOrigin.classify("https://[fe80::1]"), .localNetworkOnly)
        XCTAssertEqual(TriOSCallOrigin.classify("https://[::1]:8443"), .localNetworkOnly)
        XCTAssertEqual(TriOSCallOrigin.classify("https://[::ffff:192.168.1.5]"), .localNetworkOnly)
        XCTAssertEqual(TriOSCallOrigin.classify("https://[2001:db8::1]"), .internetHTTPS)
        // The label describes configuration, never observed reachability.
        XCTAssertEqual(TriOSCallOrigin.internetHTTPS.label, "HTTPS address, not verified")
        XCTAssertFalse(TriOSCallOrigin.internetHTTPS.label.lowercased().contains("internet"))
    }

    func testIncomingBannerClosesOnlyOnAuthoritativeAbsence() {
        XCTAssertTrue(TriOSCallPolicy.incomingBannerShouldClose(stillPending: false))
        XCTAssertFalse(TriOSCallPolicy.incomingBannerShouldClose(stillPending: true))
    }

    func testEndNoticesAreFixedPerServerStatus() {
        XCTAssertEqual(TriOSCallPolicy.endNotice(serverStatus: "declined"), "Call declined.")
        XCTAssertEqual(TriOSCallPolicy.endNotice(serverStatus: "missed"), "No answer.")
        XCTAssertEqual(TriOSCallPolicy.endNotice(serverStatus: "cancelled"), "Call cancelled.")
        XCTAssertEqual(TriOSCallPolicy.endNotice(serverStatus: "ended"), "The call ended.")
        XCTAssertEqual(TriOSCallPolicy.endNotice(serverStatus: "<anything>"), "The call ended.")
    }

    func testServerAddressValidation() {
        func check(_ text: String) -> Result<String, TriOSServerAddressProblem> {
            TriOSCallPolicy.validateServerAddress(text)
        }
        XCTAssertEqual(check(""), .failure(.empty))
        XCTAssertEqual(check("calls.example.com"), .failure(.notHTTP))
        XCTAssertEqual(check("ftp://calls.example.com"), .failure(.notHTTP))
        XCTAssertEqual(check("https://user:secret@calls.example.com"), .failure(.containsCredentials))
        XCTAssertEqual(check("https://calls.example.com/?token=abc"), .failure(.containsQueryOrFragment))
        XCTAssertEqual(check("https://calls.example.com/#x"), .failure(.containsQueryOrFragment))
        XCTAssertEqual(check("http://calls.example.com"), .failure(.unencryptedPublicHost))
        XCTAssertEqual(check(" https://calls.example.com/ "), .success("https://calls.example.com"))
        XCTAssertEqual(check("HTTPS://calls.example.com/api/"), .success("https://calls.example.com/api"))
        XCTAssertEqual(check("http://SSDs-MacBook-Pro.local:8080"), .success("http://SSDs-MacBook-Pro.local:8080"))
        XCTAssertEqual(check("http://192.168.15.7:8080"), .success("http://192.168.15.7:8080"))
        for problem in [TriOSServerAddressProblem.empty, .notHTTP, .noHost, .containsCredentials,
                        .containsQueryOrFragment, .unencryptedPublicHost] {
            XCTAssertFalse(problem.message.isEmpty)
        }
    }

    func testServerChangeNeverEndsACallSilently() {
        for phase in TriOSCallPhase.allCases {
            XCTAssertEqual(TriOSCallPolicy.serverChangeAllowed(phase: phase), !phase.isInProgress, phase.rawValue)
        }
        XCTAssertFalse(TriOSCallPolicy.serverChangeNeedsConfirmation(current: "", new: "https://a.example"))
        XCTAssertFalse(TriOSCallPolicy.serverChangeNeedsConfirmation(current: "https://a.example", new: "https://a.example"))
        XCTAssertTrue(TriOSCallPolicy.serverChangeNeedsConfirmation(current: "https://a.example", new: "https://b.example"))
    }

    func testErrorTextIsFixed() {
        XCTAssertFalse(TriOSCallPolicy.errorText(for: .failed).isEmpty)
        XCTAssertFalse(TriOSCallPolicy.errorText(for: .failed).contains("http"))
    }
}
