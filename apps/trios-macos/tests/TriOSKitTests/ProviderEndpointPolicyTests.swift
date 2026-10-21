import XCTest
@testable import TriOSKit

/// Spec: .trinity/specs/provider-endpoint-policy.md (gHashTag/trios#2051).
final class ProviderEndpointPolicyTests: XCTestCase {
    private let codingHost = "https://api.z.ai/api/coding/paas/v4"
    private let generalHost = "https://api.z.ai/api/paas/v4"
    private let nvidiaHost = "https://integrate.api.nvidia.com/v1"

    // Spec test 1
    func testEveryProviderHasUsableDefaults() {
        for provider in ModelProvider.allCases {
            XCTAssertFalse(provider.displayName.isEmpty, provider.rawValue)
            XCTAssertFalse(provider.defaultModel.isEmpty, provider.rawValue)
            XCTAssertFalse(provider.suggestedModels.isEmpty, provider.rawValue)
            XCTAssertNotNil(URL(string: provider.defaultBaseURL), provider.rawValue)
        }
    }

    // Spec test 2
    func testNewProvidersKeepDistinctRawValuesAndRequireKeys() {
        XCTAssertEqual(ModelProvider.nvidia.rawValue, "nvidia")
        XCTAssertEqual(ModelProvider.zaiStandard.rawValue, "zai-standard")
        XCTAssertEqual(ModelProvider.zai.rawValue, "zai")
        XCTAssertTrue(ModelProvider.nvidia.requiresAPIKey)
        XCTAssertTrue(ModelProvider.zaiStandard.requiresAPIKey)
        XCTAssertEqual(ModelProvider.nvidia.defaultBaseURL, nvidiaHost)
        XCTAssertEqual(ModelProvider.zaiStandard.defaultBaseURL, generalHost)
        // The legacy default is not rewritten to the billed general host.
        XCTAssertEqual(ModelProvider.zai.defaultBaseURL, codingHost)
    }

    // Spec test 3
    func testWireProvidersMatchTheAgentServerSchema() {
        XCTAssertEqual(ModelProvider.nvidia.wireProvider, "openai-compatible")
        XCTAssertEqual(ModelProvider.zaiStandard.wireProvider, "zai")
        XCTAssertEqual(ModelProvider.zai.wireProvider, "zai")
        for provider in [ModelProvider.ollama, .openai, .anthropic, .openrouter] {
            XCTAssertEqual(provider.wireProvider, provider.rawValue)
        }

        let runtime = ModelRuntimeConfiguration(
            provider: .nvidia,
            model: "nvidia/nemotron-3-super-120b-a12b",
            baseURL: nvidiaHost,
            apiKey: "test-only-not-a-key"
        )
        var body: [String: Any] = [:]
        runtime.apply(to: &body)
        XCTAssertEqual(body["provider"] as? String, "openai-compatible")
        XCTAssertEqual(body["baseUrl"] as? String, nvidiaHost)
        XCTAssertEqual(body["model"] as? String, "nvidia/nemotron-3-super-120b-a12b")
        XCTAssertEqual(body["apiKey"] as? String, "test-only-not-a-key")
    }

    // Spec test 4
    func testEndpointClassification() {
        XCTAssertEqual(ZAIEndpointKind.classify(codingHost), .codingPlan)
        XCTAssertEqual(ZAIEndpointKind.classify(codingHost + "/"), .codingPlan)
        XCTAssertEqual(ZAIEndpointKind.classify("HTTPS://API.Z.AI/API/CODING/PAAS/V4"), .codingPlan)
        XCTAssertEqual(ZAIEndpointKind.classify(" \(codingHost) "), .codingPlan)
        XCTAssertEqual(ZAIEndpointKind.classify("https://open.bigmodel.cn/api/coding/paas/v4"), .codingPlan)
        XCTAssertEqual(ZAIEndpointKind.classify(generalHost), .general)
        XCTAssertEqual(ZAIEndpointKind.classify(generalHost + "/"), .general)
        XCTAssertEqual(ZAIEndpointKind.classify(nvidiaHost), .other)
        XCTAssertEqual(ZAIEndpointKind.classify("https://example.test/api/coding/paas/v4"), .other)
        XCTAssertEqual(ZAIEndpointKind.classify("not a url"), .other)
    }

    // Spec test 5
    func testUsageBlockIsDecidedByRouteNotBucket() {
        XCTAssertNotNil(ProviderEndpointPolicy.usageBlockReason(provider: .zai, baseURL: codingHost))
        XCTAssertNotNil(ProviderEndpointPolicy.usageBlockReason(provider: .zai, baseURL: ModelProvider.zai.defaultBaseURL))
        XCTAssertNotNil(ProviderEndpointPolicy.usageBlockReason(provider: .zaiStandard, baseURL: codingHost))
        XCTAssertNotNil(ProviderEndpointPolicy.usageBlockReason(provider: .openai, baseURL: codingHost))

        // Regression: a legacy `zai` setup already on the general API keeps working.
        XCTAssertNil(ProviderEndpointPolicy.usageBlockReason(provider: .zai, baseURL: generalHost))
        XCTAssertNil(ProviderEndpointPolicy.usageBlockReason(provider: .zaiStandard, baseURL: generalHost))
        XCTAssertNil(ProviderEndpointPolicy.usageBlockReason(provider: .nvidia, baseURL: nvidiaHost))
        XCTAssertNil(ProviderEndpointPolicy.usageBlockReason(provider: .openai, baseURL: "https://api.openai.com/v1"))

        let reason = ProviderEndpointPolicy.codingPlanBlockReason
        XCTAssertFalse(reason.contains("Bearer"))
        XCTAssertFalse(reason.contains("nvapi-"))
        XCTAssertTrue(reason.contains("Z.AI API"))
    }

    // Spec test 6
    func testKeychainScopesDoNotLeakAcrossBuckets() {
        XCTAssertNil(ModelCredentialStore.entryID(fromAccount: "zai-standard", provider: .zai))
        XCTAssertNil(ModelCredentialStore.entryID(fromAccount: "zai-standard#a", provider: .zai))
        XCTAssertNil(ModelCredentialStore.entryID(fromAccount: "zai-standard_a", provider: .zai))
        XCTAssertNil(ModelCredentialStore.entryID(fromAccount: "zai", provider: .zaiStandard))
        XCTAssertNil(ModelCredentialStore.entryID(fromAccount: "zai#a", provider: .zaiStandard))
        XCTAssertNil(ModelCredentialStore.entryID(fromAccount: "zai_a", provider: .zaiStandard))
        XCTAssertNil(ModelCredentialStore.entryID(fromAccount: "nvidia#a", provider: .openai))

        XCTAssertEqual(ModelCredentialStore.entryID(fromAccount: "zai#a", provider: .zai), "a")
        XCTAssertEqual(ModelCredentialStore.entryID(fromAccount: "zai", provider: .zai), ModelCredentialStore.legacyEntryID)
        XCTAssertEqual(ModelCredentialStore.entryID(fromAccount: "zai-standard#b", provider: .zaiStandard), "b")
        XCTAssertEqual(ModelCredentialStore.entryID(fromAccount: "zai-standard_b", provider: .zaiStandard), "b")
        XCTAssertEqual(ModelCredentialStore.entryID(fromAccount: "nvidia#c", provider: .nvidia), "c")
    }

    // Spec test 7
    func testCompletionClassifierNeverCallsAnUnreadBodyHealthy() {
        func outcome(_ status: Int, _ body: String) -> CompletionProbeOutcome {
            CompletionProbeClassifier.classify(status: status, body: Data(body.utf8))
        }
        XCTAssertEqual(outcome(200, ""), .unexpectedResponse(status: 200))
        XCTAssertEqual(outcome(200, "<html>ok</html>"), .unexpectedResponse(status: 200))
        XCTAssertEqual(outcome(200, "{}"), .unexpectedResponse(status: 200))
        XCTAssertEqual(outcome(200, #"{"choices":[]}"#), .unexpectedResponse(status: 200))
        XCTAssertEqual(outcome(200, #"{"error":{"message":"overloaded"}}"#), .providerError(status: 200, code: nil))
        XCTAssertEqual(outcome(502, "<html>Bad Gateway</html>"), .providerError(status: 502, code: nil))
        XCTAssertEqual(outcome(429, #"{"error":{"code":"1302","message":"rate"}}"#), .providerError(status: 429, code: "1302"))
        XCTAssertEqual(outcome(429, #"{"error":{"code":1310,"message":"weekly"}}"#), .providerError(status: 429, code: "1310"))
        XCTAssertEqual(outcome(500, ""), .providerError(status: 500, code: nil))
        XCTAssertEqual(outcome(200, #"{"choices":[null]}"#), .unexpectedResponse(status: 200))
        XCTAssertEqual(outcome(200, #"{"choices":[{}]}"#), .unexpectedResponse(status: 200))
        XCTAssertEqual(outcome(200, #"{"choices":[{"message":"text"}]}"#), .unexpectedResponse(status: 200))
        // Arbitrary upstream codes are dropped, not reflected.
        XCTAssertEqual(outcome(400, #"{"error":{"code":"<script>","message":"x"}}"#), .providerError(status: 400, code: nil))
        XCTAssertEqual(outcome(400, #"{"error":{"code":"123456","message":"x"}}"#), .providerError(status: 400, code: nil))
        XCTAssertEqual(
            outcome(200, #"{"id":"x","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"p"}}]}"#),
            .healthy
        )

        let summary = CompletionProbeClassifier.summary(.providerError(status: 429, code: "1310"), provider: .zaiStandard)
        XCTAssertEqual(summary, "Z.AI API error 1310 (HTTP 429).")
    }

    // Spec test 8
    func testZAIErrorCodesFollowTheOfficialTable() {
        func parse(_ code: String) -> ZAIError? {
            ZAIErrorParser.parse(#"{"error":{"code":"\#(code)","message":"m"}}"#)
        }
        XCTAssertEqual(parse("1113")?.isBalanceExhausted, true)
        XCTAssertEqual(parse("1113")?.isTerminal, true)
        for code in ["1000", "1001", "1002", "1003", "1005"] {
            XCTAssertEqual(parse(code)?.isTerminal, true, code)
        }
        for code in ["1302", "1305"] {
            XCTAssertEqual(parse(code)?.isTerminal, false, code)
            XCTAssertTrue(ZAIErrorParser.isRetryable(code), code)
            XCTAssertFalse(ZAIErrorParser.isPlanLimit(code), code)
        }
        for code in ["1308", "1309", "1310", "1311", "1313", "1314", "1315", "1316", "1321"] {
            XCTAssertEqual(parse(code)?.isTerminal, true, code)
            XCTAssertTrue(ZAIErrorParser.isPlanLimit(code), code)
            XCTAssertEqual(parse(code)?.isBalanceExhausted, false, code)
        }
        XCTAssertFalse(ZAIErrorParser.isPlanLimit("1312"))
        XCTAssertEqual(ZAIErrorParser.displayCode("1310"), "1310")
        XCTAssertEqual(ZAIErrorParser.displayCode("<b>bad</b>"), "unknown")
        if let odd = ZAIErrorParser.parse(#"{"error":{"code":"x<y","message":"m"}}"#) {
            XCTAssertFalse(ZAIErrorParser.summary(for: odd).contains("x<y"))
        } else {
            XCTFail("error envelope not parsed")
        }

        // A plan limit parks the key instead of rotating around a 429.
        XCTAssertEqual(ModelKeyRotation.reason(forHTTPStatus: 429, providerErrorCode: "1310"), .depleted)
        XCTAssertEqual(ModelKeyRotation.reason(forHTTPStatus: 429, providerErrorCode: "1302"), .rateLimited)
        XCTAssertEqual(ModelKeyRotation.reason(forHTTPStatus: 429, providerErrorCode: "1113"), .depleted)
    }

    // Spec test 9
    func testNVIDIACatalogKeepsOnlyChatModels() {
        let catalog = Data(#"""
        {"object":"list","data":[
          {"id":"nvidia/nemotron-3-super-120b-a12b"},
          {"id":"z-ai/glm-5.3-flash"},
          {"id":"z-ai/glm-5.3-flash"},
          {"id":"nvidia/nemotron-3.5-embed-8b"},
          {"id":"nvidia/llama-3.2-nv-embedqa-1b-v1"},
          {"id":"nvidia/nemotron-3.5-content-safety"},
          {"id":"meta/llama-guard-4-12b"},
          {"id":"nvidia/nemotron-4-340b-reward"},
          {"id":"nvidia/nemotron-parse-2.0"},
          {"id":"nvidia/nvclip"},
          {"id":"nvidia/ai-synthetic-video-detector"},
          {"id":"google/deplot"},
          {"id":"nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1"}
        ]}
        """#.utf8)
        XCTAssertEqual(
            ModelCatalogParser.parse(data: catalog, provider: .nvidia),
            ["nvidia/nemotron-3-super-120b-a12b", "z-ai/glm-5.3-flash"]
        )
        // Other providers are not filtered.
        let openAI = Data(#"{"data":[{"id":"text-embedding-3-small"},{"id":"gpt-a"}]}"#.utf8)
        XCTAssertEqual(ModelCatalogParser.parse(data: openAI, provider: .openai), ["gpt-a", "text-embedding-3-small"])
    }

    // Spec test 10
    func testRequestBuilderRefusesCodingPlanRouteAndMapsNVIDIA() throws {
        let refused = ModelRuntimeConfiguration(provider: .zai, model: "glm-5.2", baseURL: codingHost, apiKey: "k")
        XCTAssertThrowsError(try builder(refused).build()) { error in
            XCTAssertEqual(
                error as? ChatRequestBuildError,
                .providerRefused(ProviderEndpointPolicy.codingPlanBlockReason)
            )
        }

        let legacyGeneral = ModelRuntimeConfiguration(provider: .zai, model: "glm-5.2", baseURL: generalHost, apiKey: "k")
        let legacyJSON = try JSONSerialization.jsonObject(with: try builder(legacyGeneral).build()) as? [String: Any]
        XCTAssertEqual(legacyJSON?["provider"] as? String, "zai")
        XCTAssertEqual(legacyJSON?["baseUrl"] as? String, generalHost)

        let nvidia = ModelRuntimeConfiguration(provider: .nvidia, model: "z-ai/glm-5.3-flash", baseURL: nvidiaHost, apiKey: "k")
        let nvidiaJSON = try JSONSerialization.jsonObject(with: try builder(nvidia).build()) as? [String: Any]
        XCTAssertEqual(nvidiaJSON?["provider"] as? String, "openai-compatible")
        XCTAssertEqual(nvidiaJSON?["baseUrl"] as? String, nvidiaHost)
        XCTAssertEqual(nvidiaJSON?["model"] as? String, "z-ai/glm-5.3-flash")
    }

    func testEnvironmentFallbackIsCheckedBeforeSerialising() throws {
        func fallbackBuilder(_ environment: [String: String]) -> ChatRequestBuilder {
            ChatRequestBuilder(
                conversationId: UUID(),
                message: "ping",
                mode: "chat",
                origin: "test",
                userSystemPrompt: nil,
                previousConversation: [],
                browserContext: nil,
                modelConfiguration: nil,
                fallbackEnvironment: environment
            )
        }
        // Explicit Coding Plan base URL through the environment.
        XCTAssertThrowsError(try fallbackBuilder(["TRIOS_PROVIDER": "zai-standard", "TRIOS_BASE_URL": codingHost]).build())
        // Legacy provider with no base URL falls back to the legacy default.
        XCTAssertThrowsError(try fallbackBuilder(["TRIOS_PROVIDER": "zai"]).build())
        // Legacy provider with an explicit general base URL keeps working.
        let legacy = try JSONSerialization.jsonObject(
            with: try fallbackBuilder(["TRIOS_PROVIDER": "zai", "TRIOS_BASE_URL": generalHost]).build()
        ) as? [String: Any]
        XCTAssertEqual(legacy?["baseUrl"] as? String, generalHost)
        // NVIDIA through the fallback is serialised with the wire provider.
        let nvidia = try JSONSerialization.jsonObject(
            with: try fallbackBuilder(["TRIOS_PROVIDER": "nvidia"]).build()
        ) as? [String: Any]
        XCTAssertEqual(nvidia?["provider"] as? String, "openai-compatible")
        XCTAssertEqual(nvidia?["baseUrl"] as? String, nvidiaHost)
    }

    func testZAIStandardSharesTheZAIModelCostIdentity() async {
        let service = ModelCostService.shared
        for model in ModelProvider.zaiStandard.suggestedModels {
            let legacyCost = await service.cost(for: model, provider: .zai)
            let standardCost = await service.cost(for: model, provider: .zaiStandard)
            XCTAssertEqual(legacyCost, standardCost, model)
            let legacyTier = await service.tier(for: model, provider: .zai)
            let standardTier = await service.tier(for: model, provider: .zaiStandard)
            XCTAssertEqual(legacyTier, standardTier, model)
        }
        // A catalogued Z.AI model is not treated as unknown/premium in the new scope.
        let known = await service.cost(for: "glm-4.7-flash", provider: .zaiStandard)
        XCTAssertNotNil(known)
    }

    // MARK: - Full validateKey path (network stubbed by StubURLProtocol)

    private let completionBody = #"{"id":"c","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"p"},"finish_reason":"length"}]}"#

    private func healthService() -> ModelHealthService {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return ModelHealthService(session: URLSession(configuration: configuration))
    }

    func testNVIDIAKeyTestSendsEachKeyAndNeverReusesAnotherKeysResult() async {
        StubURLProtocol.reset { request in
            guard request.url?.path.hasSuffix("/chat/completions") == true else {
                return (200, #"{"data":[]}"#)
            }
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer valid-test-key-1234" {
                return (200, self.completionBody)
            }
            return (401, #"{"error":{"message":"Unauthorized"}}"#)
        }
        let service = healthService()

        let valid = await service.validateKey(provider: .nvidia, baseURL: nvidiaHost, apiKey: "valid-test-key-1234")
        XCTAssertTrue(valid.isValid)
        let invalid = await service.validateKey(provider: .nvidia, baseURL: nvidiaHost, apiKey: "other-test-key-5678")
        XCTAssertFalse(invalid.isValid)

        let completions = StubURLProtocol.requests.filter { $0.path.hasSuffix("/chat/completions") }
        XCTAssertEqual(completions.count, 2, "each key test must send its own authenticated request")
        XCTAssertEqual(completions.map(\.authorization), [
            "Bearer valid-test-key-1234",
            "Bearer other-test-key-5678"
        ])
        XCTAssertFalse(StubURLProtocol.requests.contains { $0.path.hasSuffix("/models") },
                       "the public catalog must not be used to validate a key")
        XCTAssertFalse(invalid.message.contains("other-test-key-5678"))
    }

    func testZAIStandardKeyTestNeedsARealCompletion() async {
        let cases: [(name: String, status: Int, body: String, valid: Bool, depleted: Bool)] = [
            ("empty 200", 200, "", false, false),
            ("HTML 502", 502, "<html><body>Bad Gateway</body></html>", false, false),
            ("choices [null]", 200, #"{"choices":[null]}"#, false, false),
            ("error envelope in 200", 200, #"{"error":{"code":"1211","message":"Unknown Model"}}"#, false, false),
            ("auth code in completion", 401, #"{"error":{"code":"1000","message":"Authentication Failed"}}"#, false, false),
            ("plan quota 1310", 429, #"{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted."}}"#, true, true),
            ("balance 1113", 429, #"{"error":{"code":"1113","message":"Insufficient balance"}}"#, true, true),
            ("real completion", 200, completionBody, true, false)
        ]
        for testCase in cases {
            StubURLProtocol.reset { request in
                if request.url?.path.hasSuffix("/models") == true {
                    return (200, #"{"data":[{"id":"glm-5.2"}]}"#)
                }
                return (testCase.status, testCase.body)
            }
            let result = await healthService().validateKey(
                provider: .zaiStandard,
                baseURL: generalHost,
                apiKey: "zai-standard-test-key"
            )
            XCTAssertEqual(result.isValid, testCase.valid, testCase.name)
            if case .depleted = result.quota {
                XCTAssertTrue(testCase.depleted, testCase.name)
            } else {
                XCTAssertFalse(testCase.depleted, testCase.name)
            }
            XCTAssertEqual(StubURLProtocol.requests.map(\.path), ["/api/paas/v4/models", "/api/paas/v4/chat/completions"], testCase.name)
            XCTAssertFalse(result.message.contains("zai-standard-test-key"), testCase.name)
        }
    }

    func testZAIKeyTestNeverReflectsUpstreamErrorText() async {
        let sentinel = "SENTINEL-sk-zai-0000-leak-check"
        let bodies: [(status: Int, body: String)] = [
            (429, #"{"error":{"code":"1310","message":"limit for key \#(sentinel)"}}"#),
            (429, #"{"error":{"code":"1113","message":"no balance for \#(sentinel)"}}"#),
            (200, #"{"error":{"code":"1211","message":"unknown model, key=\#(sentinel)"}}"#),
            (401, #"{"error":{"code":"1000","message":"bad key \#(sentinel)"}}"#),
            (429, #"{"error":{"code":"1302","message":"slow down \#(sentinel)"}}"#),
            (400, #"{"error":{"code":"\#(sentinel)","message":"\#(sentinel)"}}"#)
        ]
        for fixture in bodies {
            StubURLProtocol.reset { request in
                if request.url?.path.hasSuffix("/models") == true {
                    return (200, #"{"data":[{"id":"glm-5.2"}]}"#)
                }
                return (fixture.status, fixture.body)
            }
            let result = await healthService().validateKey(
                provider: .zaiStandard,
                baseURL: generalHost,
                apiKey: "zai-standard-test-key"
            )
            let exposed = [
                result.message,
                result.responseBody,
                result.balanceWarning ?? "",
                String(describing: result.quota)
            ] + result.logs + Array(result.responseHeaders.values) + Array(result.responseHeaders.keys)
            XCTAssertFalse(exposed.contains { $0.contains(sentinel) }, "\(fixture.status) \(fixture.body)")
            XCTAssertFalse(exposed.contains { $0.contains("zai-standard-test-key") }, "key echoed")
        }

        // The same holds for the health probe of the selected model.
        StubURLProtocol.reset { _ in (429, #"{"error":{"code":"1310","message":"\#(sentinel)"}}"#) }
        let health = await healthService().probe(
            model: "glm-5.2",
            provider: .zaiStandard,
            baseURL: generalHost,
            apiKey: "zai-standard-test-key"
        )
        XCTAssertFalse(String(describing: health).contains(sentinel))
    }

    func testCodingPlanRouteIsRefusedBeforeAnyRequest() async {
        StubURLProtocol.reset { _ in (200, self.completionBody) }
        let service = healthService()
        let keyTest = await service.validateKey(provider: .zai, baseURL: codingHost, apiKey: "legacy-test-key")
        XCTAssertFalse(keyTest.isValid)
        XCTAssertEqual(keyTest.message, ProviderEndpointPolicy.codingPlanBlockReason)
        let health = await service.probe(model: "glm-5.2", provider: .zaiStandard, baseURL: codingHost, apiKey: "k")
        XCTAssertEqual(health.health, .unavailable(reason: ProviderEndpointPolicy.codingPlanBlockReason))
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    private func builder(_ configuration: ModelRuntimeConfiguration) -> ChatRequestBuilder {
        ChatRequestBuilder(
            conversationId: UUID(),
            message: "ping",
            mode: "chat",
            origin: "test",
            userSystemPrompt: nil,
            previousConversation: [],
            browserContext: nil,
            modelConfiguration: configuration
        )
    }
}

/// Records every request and answers from a per-test handler. No real network.
final class StubURLProtocol: URLProtocol {
    struct Recorded: Equatable {
        let path: String
        let authorization: String?
    }

    private static let lock = NSLock()
    private static var handler: ((URLRequest) -> (Int, String))?
    private static var recorded: [Recorded] = []

    static var requests: [Recorded] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    static func reset(_ newHandler: @escaping (URLRequest) -> (Int, String)) {
        lock.lock(); defer { lock.unlock() }
        handler = newHandler
        recorded = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.recorded.append(Recorded(
            path: request.url?.path ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization")
        ))
        let current = Self.handler
        Self.lock.unlock()

        let (status, body) = current?(request) ?? (500, "")
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "https://stub.invalid")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
