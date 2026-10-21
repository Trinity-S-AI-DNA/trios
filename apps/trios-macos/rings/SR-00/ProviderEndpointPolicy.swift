import Foundation

// Spec: .trinity/specs/provider-endpoint-policy.md (gHashTag/trios#2051).
// Pure and dependency-free so it can be tested with a single-file `swiftc`
// invocation as well as from TriOSKitTests.

/// Which Z.AI endpoint a base URL addresses.
enum ZAIEndpointKind: Equatable, Sendable {
    /// General API, `/api/paas/v4`: Standard keys, account balance.
    case general
    /// GLM Coding Plan, `/api/coding/...`: limited by Z.ai to its listed tools.
    case codingPlan
    /// Not a Z.AI host.
    case other

    static let zaiHosts: Set<String> = ["api.z.ai", "open.bigmodel.cn"]

    static func classify(_ baseURL: String) -> ZAIEndpointKind {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              let host = components.host?.lowercased(),
              zaiHosts.contains(host) else {
            return .other
        }
        var path = components.path.lowercased()
        while path.hasSuffix("/") { path.removeLast() }
        if path.contains("/coding/") || path.hasSuffix("/coding") {
            return .codingPlan
        }
        if path == "/api/paas/v4" {
            return .general
        }
        return .other
    }
}

enum ProviderEndpointPolicy {
    /// Fixed, secret-free refusal shown wherever TriOS declines to send.
    static let codingPlanBlockReason = """
        TriOS does not send requests to the Z.AI Coding Plan endpoint: Z.ai \
        limits the Coding Plan to its listed coding tools. This configuration \
        and its keys are kept unchanged and are never moved to another \
        endpoint automatically. To use Z.AI here, add a Standard API key under \
        "Z.AI API".
        """

    /// Non-nil when TriOS must not send anything for this pair. The decision
    /// rests on the route, not on the Keychain bucket: a legacy `zai`
    /// configuration that already targets the general API keeps working,
    /// because the bucket name does not prove the key is a Coding Plan key.
    /// A route on a Coding Plan host is refused for every provider and is
    /// never rewritten to the general host, where a Compatible key is billed
    /// to the account balance.
    static func usageBlockReason(provider: ModelProvider, baseURL: String) -> String? {
        if ZAIEndpointKind.classify(baseURL) == .codingPlan {
            return codingPlanBlockReason
        }
        return nil
    }

    static func isUsable(provider: ModelProvider, baseURL: String) -> Bool {
        usageBlockReason(provider: provider, baseURL: baseURL) == nil
    }

    /// Model-id fragments that name hosted NVIDIA families which do not serve
    /// chat completions (embeddings, retrieval, safety, reward, parsing, vision
    /// encoders, detectors).
    static let nonChatModelFragments = [
        "embed", "rerank", "retriever", "safety", "guard",
        "reward", "parse", "clip", "detector", "deplot"
    ]

    static func isChatModelID(_ id: String) -> Bool {
        let lower = id.lowercased()
        return !nonChatModelFragments.contains { lower.contains($0) }
    }

    static func chatModels(from ids: [String]) -> [String] {
        Array(Set(ids.filter { !$0.isEmpty && isChatModelID($0) })).sorted()
    }
}

/// Result of reading one non-streaming chat completion probe.
enum CompletionProbeOutcome: Equatable, Sendable {
    /// 2xx, JSON object, no `error` object, and `choices[0]` is an object
    /// carrying a `message` object.
    case healthy
    /// The provider answered with an error envelope, possibly inside a 2xx.
    case providerError(status: Int, code: String?)
    /// Anything else: empty, non-JSON, or a 2xx without choices. Never healthy.
    case unexpectedResponse(status: Int)

    var isHealthy: Bool { self == .healthy }
}

enum CompletionProbeClassifier {
    static func classify(status: Int, body: Data) -> CompletionProbeOutcome {
        let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        if let object, let error = object["error"] {
            return .providerError(status: status, code: errorCode(error))
        }
        guard (200...299).contains(status) else {
            return .providerError(status: status, code: nil)
        }
        // `[null]`, `[{}]` or a choice without a message object is not a completion.
        guard let object,
              let choices = object["choices"] as? [Any],
              let first = choices.first as? [String: Any],
              first["message"] is [String: Any] else {
            return .unexpectedResponse(status: status)
        }
        return .healthy
    }

    /// Accepts `{"error":{"code":"1113"}}` or a numeric code. Anything that is
    /// not a short decimal code is dropped, so arbitrary upstream text never
    /// reaches a user-visible diagnostic through this field.
    private static func errorCode(_ error: Any) -> String? {
        guard let dictionary = error as? [String: Any] else { return nil }
        if let code = dictionary["code"] as? String { return safeProviderCode(code) }
        if let code = dictionary["code"] as? Int { return safeProviderCode(String(code)) }
        return nil
    }

    /// A provider code is shown only when it is 3 to 5 ASCII digits.
    static func safeProviderCode(_ code: String) -> String? {
        ZAIErrorParser.safeCode(code)
    }

    /// Secret-free one-line description: status, bounded code, fixed text.
    static func summary(_ outcome: CompletionProbeOutcome, provider: ModelProvider) -> String {
        switch outcome {
        case .healthy:
            return "\(provider.displayName) answered a 1-token completion."
        case .providerError(let status, let code):
            if let code {
                return "\(provider.displayName) error \(code) (HTTP \(status))."
            }
            return "\(provider.displayName) error (HTTP \(status))."
        case .unexpectedResponse(let status):
            return "\(provider.displayName) returned an unexpected response (HTTP \(status)); the key is not confirmed."
        }
    }
}

/// What one minimal Z.AI completion says about whether the account can pay.
enum ZAIBalanceProbeResult: Equatable, Sendable {
    /// A real completion came back.
    case canPay
    /// Z.AI answered with an error envelope.
    case providerError(ZAIError)
    /// No usable answer: transport failure, empty, non-JSON or malformed body.
    /// Carries a fixed, secret-free description.
    case inconclusive(String)

    static func classify(status: Int, body: Data) -> ZAIBalanceProbeResult {
        let bodyString = String(data: body, encoding: .utf8) ?? ""
        if let zaiError = ZAIErrorParser.parse(bodyString) {
            return .providerError(zaiError)
        }
        let outcome = CompletionProbeClassifier.classify(status: status, body: body)
        if outcome.isHealthy {
            return .canPay
        }
        return .inconclusive(CompletionProbeClassifier.summary(outcome, provider: .zaiStandard))
    }
}
