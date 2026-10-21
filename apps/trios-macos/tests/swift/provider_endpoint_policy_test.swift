import Foundation

// Standalone check of .trinity/specs/provider-endpoint-policy.md (gHashTag/trios#2051).
// Compiled with ModelProvider, ProviderEndpointPolicy, ZAIErrorParser,
// ModelKeyRotation and ModelCatalogService only; see trios-swift.yml.
@main
struct ProviderEndpointPolicyTest {
    static func main() {
        let coding = "https://api.z.ai/api/coding/paas/v4"
        let general = "https://api.z.ai/api/paas/v4"
        let nvidia = "https://integrate.api.nvidia.com/v1"

        for provider in ModelProvider.allCases {
            expect(!provider.displayName.isEmpty, "display name \(provider.rawValue)")
            expect(!provider.suggestedModels.isEmpty, "suggested models \(provider.rawValue)")
            expect(URL(string: provider.defaultBaseURL) != nil, "base URL \(provider.rawValue)")
        }
        expect(ModelProvider.nvidia.wireProvider == "openai-compatible", "NVIDIA wire provider")
        expect(ModelProvider.zaiStandard.wireProvider == "zai", "Z.AI API wire provider")
        expect(ModelProvider.zaiStandard.rawValue == "zai-standard", "Z.AI API Keychain scope")
        expect(ModelProvider.zai.defaultBaseURL == coding, "legacy default not rewritten")

        var body: [String: Any] = [:]
        ModelRuntimeConfiguration(provider: .nvidia, model: "m", baseURL: nvidia, apiKey: "k").apply(to: &body)
        expect(body["provider"] as? String == "openai-compatible", "apply writes wire provider")
        expect(body["baseUrl"] as? String == nvidia, "apply keeps base URL")

        expect(ZAIEndpointKind.classify(coding + "/") == .codingPlan, "coding host with slash")
        expect(ZAIEndpointKind.classify("HTTPS://API.Z.AI/API/CODING/PAAS/V4") == .codingPlan, "coding host upper case")
        expect(ZAIEndpointKind.classify(general) == .general, "general host")
        expect(ZAIEndpointKind.classify("https://example.test/api/coding/paas/v4") == .other, "other host")

        expect(ProviderEndpointPolicy.usageBlockReason(provider: .zai, baseURL: coding) != nil, "legacy coding refused")
        expect(ProviderEndpointPolicy.usageBlockReason(provider: .zaiStandard, baseURL: coding) != nil, "standard on coding refused")
        expect(ProviderEndpointPolicy.usageBlockReason(provider: .zai, baseURL: general) == nil, "legacy general kept (regression)")
        expect(ProviderEndpointPolicy.usageBlockReason(provider: .nvidia, baseURL: nvidia) == nil, "NVIDIA allowed")

        func outcome(_ status: Int, _ text: String) -> CompletionProbeOutcome {
            CompletionProbeClassifier.classify(status: status, body: Data(text.utf8))
        }
        expect(!outcome(200, "").isHealthy, "empty 200")
        expect(!outcome(200, "{}").isHealthy, "object without choices")
        expect(!outcome(200, #"{"choices":[null]}"#).isHealthy, "choices [null]")
        expect(!outcome(200, #"{"choices":[{}]}"#).isHealthy, "choice without message")
        expect(outcome(200, #"{"error":{"message":"busy"}}"#) == .providerError(status: 200, code: nil), "error inside 200")
        expect(outcome(502, "<html></html>") == .providerError(status: 502, code: nil), "HTML 502")
        expect(outcome(429, #"{"error":{"code":"x<y"}}"#) == .providerError(status: 429, code: nil), "unsafe code dropped")
        expect(outcome(200, #"{"choices":[{"message":{"role":"assistant","content":"p"}}]}"#).isHealthy, "real completion")

        expect(ZAIBalanceProbeResult.classify(status: 200, body: Data()) != .canPay, "empty balance probe is not canPay")
        if case .providerError(let error) = ZAIBalanceProbeResult.classify(
            status: 429, body: Data(#"{"error":{"code":"1310","message":"m"}}"#.utf8)
        ) {
            expect(ZAIErrorParser.isPlanLimit(error.code) && error.isTerminal, "1310 plan limit terminal")
        } else {
            expect(false, "1310 parsed")
        }
        expect(ModelKeyRotation.reason(forHTTPStatus: 429, providerErrorCode: "1316") == .depleted, "plan limit parks key")
        expect(ModelKeyRotation.reason(forHTTPStatus: 429, providerErrorCode: "1302") == .rateLimited, "rate limit cools down")

        let catalog = Data(#"{"data":[{"id":"nvidia/nemotron-3-super-120b-a12b"},{"id":"nvidia/nemotron-3.5-embed-8b"},{"id":"meta/llama-guard-4-12b"},{"id":"nvidia/nemotron-parse"}]}"#.utf8)
        expect(ModelCatalogParser.parse(data: catalog, provider: .nvidia) == ["nvidia/nemotron-3-super-120b-a12b"], "NVIDIA chat filter")

        print("All ProviderEndpointPolicy tests passed.")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data("FAIL: \(label)\n".utf8))
            exit(1)
        }
    }
}
