import { describe, expect, it } from "bun:test";
import {
  productRuntimeCapabilitiesFromRuntimeCapabilities,
  validateProductRuntimeRequest,
  type ProductRuntimeRequest,
} from "./product-runtime-contract.js";
import type { RuntimeCapabilities } from "./types.js";

function baseRequest(overrides: Partial<ProductRuntimeRequest> = {}): ProductRuntimeRequest {
  return {
    requestId: "req_1",
    sourceProduct: {
      productId: "jarvis",
      productVersion: "0.1.0",
    },
    targetRuntime: "ravi",
    actor: {
      id: "user_1",
      kind: "user",
    },
    intent: "ask_status",
    input: {
      text: "status executivo",
    },
    cognitiveContext: {
      contextId: "cbc_exec",
      contextVersion: "1.0.0",
      ownerProduct: {
        productId: "jarvis",
      },
      ubiquitousLanguage: {
        languageId: "jarvis-executive",
        version: "1.0.0",
        terms: [
          {
            term: "risco",
            meaning: "condicao que pode exigir atencao executiva",
          },
        ],
      },
      bridgeContract: {
        contractId: "jarvis-exec-v1",
        contractVersion: "1.0.0",
        sourceContextId: "cbc_exec",
        targetContextId: "cbc_runtime",
      },
      semanticAbstractionLayer: {
        layerId: "jarvis-executive-sal",
        layerVersion: "1.0.0",
        ownerProduct: {
          productId: "jarvis",
        },
        projectionName: "executive-summary",
      },
      semanticEventRefs: [
        {
          eventId: "evt_1",
          eventType: "jarvis.intent.received",
          eventVersion: "1.0.0",
          sourceProduct: {
            productId: "jarvis",
          },
        },
      ],
    },
    execution: {
      mode: "interactive",
      approvalMode: "may_request",
    },
    ...overrides,
  };
}

describe("product runtime contract", () => {
  it("requires cognitive bounded context and ubiquitous language metadata", () => {
    const issues = validateProductRuntimeRequest(
      baseRequest({
        cognitiveContext: {
          contextId: "",
          contextVersion: "1.0.0",
          ownerProduct: {
            productId: "jarvis",
          },
          ubiquitousLanguage: {
            languageId: "",
            version: "",
            terms: [],
          },
        },
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual([
      "missing_cognitive_context",
      "missing_ubiquitous_language",
      "missing_ubiquitous_language_terms",
    ]);
  });

  it("does not treat semantic context as provider-specific runtime state", () => {
    const issues = validateProductRuntimeRequest(baseRequest());

    expect(issues).toEqual([]);
  });

  it("validates bridge, semantic abstraction layer and semantic event refs as envelope metadata", () => {
    const issues = validateProductRuntimeRequest(
      baseRequest({
        cognitiveContext: {
          ...baseRequest().cognitiveContext,
          bridgeContract: {
            contractId: "",
            contractVersion: "",
            sourceContextId: "",
          },
          semanticAbstractionLayer: {
            layerId: "",
            layerVersion: "",
            ownerProduct: {
              productId: "",
            },
          },
          semanticEventRefs: [
            {
              eventId: "",
              eventType: "",
              eventVersion: "",
              sourceProduct: {
                productId: "",
              },
            },
          ],
        },
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual([
      "invalid_bridge_contract_ref",
      "invalid_semantic_abstraction_layer_ref",
      "invalid_semantic_event_ref",
    ]);
  });

  it("derives product runtime capabilities from the generic runtime capability matrix", () => {
    const runtimeCapabilities: RuntimeCapabilities = {
      runtimeControl: { supported: false, operations: [] },
      dynamicTools: { mode: "host" },
      execution: { mode: "sdk" },
      sessionState: { mode: "provider-session-id" },
      usage: { semantics: "terminal-event" },
      tools: {
        permissionMode: "ravi-host",
        accessRequirement: "tool_and_executable",
        supportsParallelCalls: false,
      },
      systemPrompt: { mode: "append" },
      terminalEvents: { guarantee: "adapter" },
      skillVisibility: { availability: "none", loadedState: "none" },
      supportsSessionResume: true,
      supportsSessionFork: false,
      supportsPartialText: true,
      supportsToolHooks: true,
      supportsPlugins: false,
      supportsMcpServers: false,
      supportsRemoteSpawn: false,
    };

    const capabilities = productRuntimeCapabilitiesFromRuntimeCapabilities(runtimeCapabilities);

    expect(capabilities).toMatchObject({
      supportsInteractiveExecution: true,
      supportsBackgroundExecution: true,
      supportsEventDrivenExecution: true,
      supportsApprovals: true,
      supportsTools: true,
      supportsTrace: true,
      supportsConversationMemory: true,
    });
  });
});
