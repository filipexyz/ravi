import type { RuntimeCapabilities, RuntimeEffort, RuntimeThinking, RuntimeUsage } from "./types.js";

export type ProductRuntimeExecutionMode = "interactive" | "background" | "event_driven";
export type ProductRuntimeApprovalMode = "none" | "may_request" | "required";
export type ProductRuntimeEventType =
  | "product_runtime.accepted"
  | "product_runtime.context_loaded"
  | "product_runtime.approval_requested"
  | "product_runtime.response_delta"
  | "product_runtime.response_completed"
  | "product_runtime.failed";

export interface ProductRuntimeActor {
  readonly id: string;
  readonly kind: "user" | "agent" | "system";
  readonly displayName?: string;
}

export interface ProductRuntimeProductRef {
  readonly productId: string;
  readonly productVersion?: string;
  readonly instanceId?: string;
}

export interface ProductRuntimeBridgeContractRef {
  readonly contractId: string;
  readonly contractVersion: string;
  readonly sourceContextId: string;
  readonly targetContextId?: string;
}

export interface ProductRuntimeSemanticAbstractionLayerRef {
  readonly layerId: string;
  readonly layerVersion: string;
  readonly ownerProduct: ProductRuntimeProductRef;
  readonly projectionName?: string;
}

export interface ProductRuntimeSemanticEventRef {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly sourceProduct: ProductRuntimeProductRef;
  readonly occurredAt?: string;
}

export interface ProductRuntimeLanguageTerm {
  readonly term: string;
  readonly meaning: string;
  readonly aliases?: readonly string[];
}

export interface ProductRuntimeSemanticClaim {
  readonly kind: "fact" | "inference" | "recommendation" | "decision" | "policy";
  readonly statement: string;
  readonly confidence?: number;
  readonly evidenceRefs?: readonly string[];
}

export interface ProductRuntimeUbiquitousLanguage {
  readonly languageId: string;
  readonly version: string;
  readonly terms: readonly ProductRuntimeLanguageTerm[];
}

export interface ProductRuntimeCognitiveBoundedContext {
  readonly contextId: string;
  readonly contextVersion: string;
  readonly ownerProduct: ProductRuntimeProductRef;
  readonly name?: string;
  readonly ubiquitousLanguage: ProductRuntimeUbiquitousLanguage;
  readonly bridgeContract?: ProductRuntimeBridgeContractRef;
  readonly semanticAbstractionLayer?: ProductRuntimeSemanticAbstractionLayerRef;
  readonly semanticEventRefs?: readonly ProductRuntimeSemanticEventRef[];
  readonly assumptions?: readonly string[];
  readonly constraints?: readonly string[];
  readonly claims?: readonly ProductRuntimeSemanticClaim[];
  readonly provenanceRefs?: readonly string[];
}

export interface ProductRuntimeTraceRef {
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly semanticEventId?: string;
}

export interface ProductRuntimeExecutionOptions {
  readonly mode: ProductRuntimeExecutionMode;
  readonly approvalMode: ProductRuntimeApprovalMode;
  readonly model?: string;
  readonly effort?: RuntimeEffort;
  readonly thinking?: RuntimeThinking;
  readonly timeoutMs?: number;
}

export interface ProductRuntimeRequest<TInput extends Record<string, unknown> = Record<string, unknown>> {
  readonly requestId: string;
  readonly sourceProduct: ProductRuntimeProductRef;
  readonly targetRuntime: "ravi";
  readonly actor: ProductRuntimeActor;
  readonly intent: string;
  readonly input: TInput;
  readonly cognitiveContext: ProductRuntimeCognitiveBoundedContext;
  readonly execution: ProductRuntimeExecutionOptions;
  readonly trace?: ProductRuntimeTraceRef;
}

export interface ProductRuntimeEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly eventId: string;
  readonly requestId: string;
  readonly type: ProductRuntimeEventType;
  readonly occurredAt: string;
  readonly payload: TPayload;
  readonly trace?: ProductRuntimeTraceRef;
}

export interface ProductRuntimeResult<TOutput extends Record<string, unknown> = Record<string, unknown>> {
  readonly requestId: string;
  readonly status: "completed" | "failed" | "interrupted";
  readonly output?: TOutput;
  readonly responseText?: string;
  readonly events: readonly ProductRuntimeEvent[];
  readonly usage?: RuntimeUsage;
  readonly error?: string;
  readonly trace?: ProductRuntimeTraceRef;
}

export interface ProductRuntimeCapabilities {
  readonly supportsInteractiveExecution: boolean;
  readonly supportsBackgroundExecution: boolean;
  readonly supportsEventDrivenExecution: boolean;
  readonly supportsApprovals: boolean;
  readonly supportsTools: boolean;
  readonly supportsTrace: boolean;
  readonly supportsConversationMemory: boolean;
}

export interface ProductRuntimePort {
  readonly id: "ravi";
  getCapabilities(): ProductRuntimeCapabilities;
  execute<TInput extends Record<string, unknown>, TOutput extends Record<string, unknown>>(
    request: ProductRuntimeRequest<TInput>,
  ): Promise<ProductRuntimeResult<TOutput>>;
}

export interface ProductRuntimeValidationIssue {
  readonly code:
    | "missing_request_id"
    | "missing_intent"
    | "missing_actor"
    | "missing_source_product"
    | "missing_cognitive_context"
    | "missing_ubiquitous_language"
    | "missing_ubiquitous_language_terms"
    | "invalid_bridge_contract_ref"
    | "invalid_semantic_abstraction_layer_ref"
    | "invalid_semantic_event_ref"
    | "unsupported_target_runtime";
  readonly message: string;
}

export function productRuntimeCapabilitiesFromRuntimeCapabilities(
  capabilities: RuntimeCapabilities,
): ProductRuntimeCapabilities {
  return {
    supportsInteractiveExecution: true,
    supportsBackgroundExecution: true,
    supportsEventDrivenExecution: true,
    supportsApprovals: capabilities.dynamicTools.mode === "host" || capabilities.supportsToolHooks,
    supportsTools: capabilities.dynamicTools.mode === "host" || capabilities.tools.permissionMode === "ravi-host",
    supportsTrace: true,
    supportsConversationMemory: capabilities.sessionState.mode !== "none",
  };
}

export function validateProductRuntimeRequest(request: ProductRuntimeRequest): ProductRuntimeValidationIssue[] {
  const issues: ProductRuntimeValidationIssue[] = [];

  if (!request.requestId.trim()) {
    issues.push({ code: "missing_request_id", message: "Product runtime request id is required." });
  }
  if (!request.intent.trim()) {
    issues.push({ code: "missing_intent", message: "Product runtime intent is required." });
  }
  if (!request.actor.id.trim()) {
    issues.push({ code: "missing_actor", message: "Product runtime actor id is required." });
  }
  if (!request.sourceProduct.productId.trim()) {
    issues.push({ code: "missing_source_product", message: "Source product id is required." });
  }
  if (request.targetRuntime !== "ravi") {
    issues.push({ code: "unsupported_target_runtime", message: "Only the Ravi runtime target is supported." });
  }
  if (!request.cognitiveContext.contextId.trim()) {
    issues.push({ code: "missing_cognitive_context", message: "Cognitive bounded context id is required." });
  }
  if (
    !request.cognitiveContext.ubiquitousLanguage.languageId.trim() ||
    !request.cognitiveContext.ubiquitousLanguage.version.trim()
  ) {
    issues.push({
      code: "missing_ubiquitous_language",
      message: "Cognitive bounded context must include ubiquitous language id and version.",
    });
  }
  if (request.cognitiveContext.ubiquitousLanguage.terms.length === 0) {
    issues.push({
      code: "missing_ubiquitous_language_terms",
      message: "Cognitive bounded context must include ubiquitous language terms.",
    });
  }
  if (
    request.cognitiveContext.bridgeContract &&
    (!request.cognitiveContext.bridgeContract.contractId.trim() ||
      !request.cognitiveContext.bridgeContract.contractVersion.trim() ||
      !request.cognitiveContext.bridgeContract.sourceContextId.trim())
  ) {
    issues.push({
      code: "invalid_bridge_contract_ref",
      message: "Bridge contract refs must include contract id, contract version and source context id.",
    });
  }
  if (
    request.cognitiveContext.semanticAbstractionLayer &&
    (!request.cognitiveContext.semanticAbstractionLayer.layerId.trim() ||
      !request.cognitiveContext.semanticAbstractionLayer.layerVersion.trim() ||
      !request.cognitiveContext.semanticAbstractionLayer.ownerProduct.productId.trim())
  ) {
    issues.push({
      code: "invalid_semantic_abstraction_layer_ref",
      message: "Semantic abstraction layer refs must include layer id, layer version and owner product.",
    });
  }
  for (const semanticEventRef of request.cognitiveContext.semanticEventRefs ?? []) {
    if (
      !semanticEventRef.eventId.trim() ||
      !semanticEventRef.eventType.trim() ||
      !semanticEventRef.eventVersion.trim() ||
      !semanticEventRef.sourceProduct.productId.trim()
    ) {
      issues.push({
        code: "invalid_semantic_event_ref",
        message: "Semantic event refs must include event id, event type, event version and source product.",
      });
      break;
    }
  }

  return issues;
}
