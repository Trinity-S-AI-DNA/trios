import Foundation

/// Outcome of a Z.AI completion probe, derived from the provider's error envelope.
///
/// Z.AI answers `GET /api/paas/v4/models` with HTTP 200 for any key that
/// authenticates, including keys whose account balance is spent. Reporting that
/// as a plain "valid" is misleading: the next completion fails with HTTP 429 and
/// business code 1113. `isBalanceExhausted` carries that distinction.
struct ZAIError: Equatable, Sendable {
    /// Provider business code, e.g. "1113". Distinct from the HTTP status.
    let code: String
    /// Provider-supplied message, verbatim.
    let message: String
    /// True when the account cannot pay for requests.
    let isBalanceExhausted: Bool
    /// True when retrying the identical request cannot succeed.
    let isTerminal: Bool
}

/// Pure, dependency-free parser for Z.AI error payloads. Kept separate from
/// `ModelHealthService` so it can be unit-tested with a single-file `swiftc`
/// invocation, matching `OpenRouterCreditsParser`.
enum ZAIErrorParser {
    /// Business code returned when the account balance or resource package is spent.
    static let insufficientBalanceCode = "1113"
    /// Business codes returned for authentication problems
    /// (https://docs.z.ai/api-reference/api-code, read 2026-10-21).
    static let authFailedCodes: Set<String> = ["1000", "1001", "1002", "1003", "1005"]
    /// HTTP 429 codes that clear on their own: rate limit and overload.
    static let retryableCodes: Set<String> = ["1302", "1305"]
    /// HTTP 429 codes for plan usage limits, expired plans or packages, a
    /// model outside the plan, a fair-use restriction, or a key of another
    /// product type. Retrying the same request, or the same request with
    /// another key, does not lift the provider's limit.
    static let planLimitCodes: Set<String> = [
        "1308", "1309", "1310", "1311", "1313", "1314", "1315",
        "1316", "1317", "1318", "1319", "1320", "1321"
    ]

    static let depletedWarning = """
        This key authenticates, but the Z.AI account balance is exhausted. Every \
        model keeps failing with business code 1113 (Insufficient balance) until \
        the account is topped up.
        """

    /// Parses a Z.AI error body. Returns nil when the payload is not an error
    /// envelope, so callers can treat the response as a success.
    static func parse(_ bodyString: String) -> ZAIError? {
        guard let data = bodyString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = json["error"] as? [String: Any] else {
            return nil
        }

        // Z.AI sends the code as a string; tolerate a number for robustness.
        let code: String
        if let stringCode = error["code"] as? String {
            code = stringCode
        } else if let intCode = error["code"] as? Int {
            code = String(intCode)
        } else {
            code = ""
        }
        let message = error["message"] as? String ?? "Z.AI returned an error."

        let isBalanceExhausted = code == insufficientBalanceCode || mentionsBalance(message)
        // Auth failures and balance exhaustion cannot be fixed by retrying the
        // same request; retrying only multiplies the noise and the latency.
        let isTerminal = isBalanceExhausted
            || authFailedCodes.contains(code)
            || planLimitCodes.contains(code)

        return ZAIError(
            code: code,
            message: message,
            isBalanceExhausted: isBalanceExhausted,
            isTerminal: isTerminal
        )
    }

    /// Text fallback for the case where Z.AI changes the numeric code but keeps
    /// the wording. Both phrases must be matched case-insensitively.
    static func mentionsBalance(_ message: String) -> Bool {
        let lower = message.lowercased()
        return lower.contains("insufficient balance")
            || lower.contains("no resource package")
            || lower.contains("please recharge")
    }

    static func isPlanLimit(_ code: String) -> Bool {
        planLimitCodes.contains(code)
    }

    static let planLimitWarning = """
        This key authenticates, but Z.AI refuses requests under its current plan, \
        package or key type. TriOS does not switch keys or endpoints to get around \
        a provider limit.
        """

    /// A provider code is shown only when it is 3 to 5 ASCII digits. Kept in
    /// this file so the standalone parser tests compile it alone.
    static func safeCode(_ code: String) -> String? {
        guard (3...5).contains(code.count),
              code.allSatisfy({ $0.isASCII && $0.isNumber }) else {
            return nil
        }
        return code
    }

    /// The code as shown to the user: 3 to 5 ASCII digits, otherwise "unknown".
    static func displayCode(_ code: String) -> String {
        safeCode(code) ?? "unknown"
    }

    static func isRetryable(_ code: String) -> Bool {
        retryableCodes.contains(code)
    }

    /// Fixed, secret-free summary: a fixed sentence plus a bounded code, never
    /// the provider's message, which may echo request data such as a key.
    /// Used by key validation and health probes (provider-endpoint-policy.md).
    static func fixedSummary(for error: ZAIError) -> String {
        let code = displayCode(error.code)
        if error.isBalanceExhausted {
            return "Key valid - but the Z.AI balance is exhausted (code \(code))."
        }
        if isPlanLimit(error.code) {
            return "Key valid - but Z.AI refuses it under the current plan, package or key type (code \(code))."
        }
        if authFailedCodes.contains(error.code) {
            return "Z.AI rejected the key (code \(code))."
        }
        if isRetryable(error.code) {
            return "Z.AI is rate limiting or overloaded (code \(code)); try again later."
        }
        return "Z.AI returned an error (code \(code))."
    }

    /// One-line summary suitable for the Models tab key-test result.
    static func summary(for error: ZAIError) -> String {
        if error.isBalanceExhausted {
            return "Key valid - but the Z.AI balance is exhausted (code \(displayCode(error.code)))."
        }
        if isPlanLimit(error.code) {
            return "Key valid - but Z.AI refuses it under the current plan, package or key type (code \(error.code))."
        }
        // A code that is not 3 to 5 digits is dropped rather than reflected.
        guard let code = safeCode(error.code) else {
            return "Z.AI error: \(error.message)"
        }
        return "Z.AI error \(code): \(error.message)"
    }
}
