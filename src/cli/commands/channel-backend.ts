import "reflect-metadata";
import {
  acceptChannelIngress,
  CHANNEL_BACKEND_PROTOCOL,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  ChannelBackendOpaqueIdSchema,
  ChannelIngressRequestSchema,
  ChannelIngressResultSchema,
  type ChannelIngressRequest,
  type ChannelIngressResult,
} from "../../channels/backend.js";
import {
  CHANNEL_RUNTIME_EVENTS_PROTOCOL,
  CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
  ChannelInterruptRequestSchema,
  ChannelInterruptResultSchema,
  ChannelRuntimeReadbackRequestSchema,
  ChannelRuntimeReadbackResultSchema,
  readChannelRuntime,
  requestChannelRuntimeInterrupt,
  type ChannelInterruptRequest,
  type ChannelInterruptResult,
  type ChannelRuntimeReadbackRequest,
  type ChannelRuntimeReadbackResult,
} from "../../channels/runtime-events.js";
import { getContext } from "../context.js";
import { Arg, Command, CommandAccess, Group, Option, Scope } from "../decorators.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

const OPAQUE_ID_PATTERN_SOURCE = "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$";

@Group({
  name: "channels.backend",
  description: "Accept provider-neutral input from native channel backends",
})
export class ChannelBackendCommands {
  @Scope("admin")
  @Command({
    name: "ingress",
    description: "Accept one idempotent external channel message into a local agent session",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "agent",
    action: "channel-ingress",
    risk: "high",
    resourceId: "agentId",
    requireConcreteResource: true,
    resourceIdPattern: OPAQUE_ID_PATTERN_SOURCE,
    input: ["agentId", "request"],
    redactions: ["request"],
  })
  async ingress(
    @Arg("agentId", {
      description: "Concrete local agent id used for authorization",
      schema: ChannelBackendOpaqueIdSchema,
    })
    agentId: string,
    @Arg("request", {
      description: "Channel ingress request object (JSON when invoked from the CLI)",
      schema: ChannelIngressRequestSchema,
    })
    requestInput: ChannelIngressRequest | string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): Promise<ChannelIngressResult> {
    const request = parseIngressRequest(requestInput);
    const result =
      request.agentId === agentId
        ? await acceptChannelIngress(request)
        : ChannelIngressResultSchema.parse({
            protocol: CHANNEL_BACKEND_PROTOCOL,
            schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
            requestId: request.requestId,
            disposition: "rejected",
            error: {
              code: "LOCAL_PERMISSION_DENIED",
              category: "authorization",
              retryable: false,
              correlationId: request.requestId,
            },
            acceptedAt: new Date().toISOString(),
          });

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!getContext({ localOnly: true })?.suppressCliOutput) {
      console.log(
        `${result.disposition === "rejected" ? "Rejected" : "Accepted"} channel ingress ${result.requestId}.`,
      );
    }
    return result;
  }
}

function parseIngressRequest(input: ChannelIngressRequest | string): ChannelIngressRequest {
  if (typeof input !== "string") return ChannelIngressRequestSchema.parse(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("request must be valid JSON");
  }
  return ChannelIngressRequestSchema.parse(parsed);
}

declareCommandReturns(ChannelBackendCommands, {
  ingress: ChannelIngressResultSchema,
});

@Group({
  name: "channels.backend.runtime",
  description: "Read and interrupt turns accepted through native channel backends",
})
export class ChannelBackendRuntimeCommands {
  @Scope("admin")
  @Command({
    name: "readback",
    description: "Read the provider-neutral state of an accepted channel turn",
  })
  @CommandAccess({
    kind: "read",
    resource: "agent",
    action: "channel-runtime-readback",
    risk: "medium",
    resourceId: "agentId",
    requireConcreteResource: true,
    resourceIdPattern: OPAQUE_ID_PATTERN_SOURCE,
    input: ["agentId", "request"],
    redactions: ["request"],
  })
  readback(
    @Arg("agentId", {
      description: "Concrete local agent id used for authorization",
      schema: ChannelBackendOpaqueIdSchema,
    })
    agentId: string,
    @Arg("request", {
      description: "Channel runtime readback request object (JSON when invoked from the CLI)",
      schema: ChannelRuntimeReadbackRequestSchema,
    })
    requestInput: ChannelRuntimeReadbackRequest | string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): ChannelRuntimeReadbackResult {
    const request = parseRuntimeRequest(requestInput, ChannelRuntimeReadbackRequestSchema, "request");
    if (request.binding.agentId !== agentId) {
      throw new Error("Channel runtime binding was not found");
    }
    const result = readChannelRuntime(request);
    printRuntimeResult(result, asJson, `Channel turn ${result.binding.turnId} is ${result.state}.`);
    return result;
  }

  @Scope("admin")
  @Command({
    name: "interrupt",
    description: "Idempotently request interruption of an accepted channel turn",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "agent",
    action: "channel-runtime-interrupt",
    risk: "high",
    resourceId: "agentId",
    requireConcreteResource: true,
    resourceIdPattern: OPAQUE_ID_PATTERN_SOURCE,
    input: ["agentId", "request"],
    redactions: ["request"],
  })
  async interrupt(
    @Arg("agentId", {
      description: "Concrete local agent id used for authorization",
      schema: ChannelBackendOpaqueIdSchema,
    })
    agentId: string,
    @Arg("request", {
      description: "Channel runtime interrupt request object (JSON when invoked from the CLI)",
      schema: ChannelInterruptRequestSchema,
    })
    requestInput: ChannelInterruptRequest | string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): Promise<ChannelInterruptResult> {
    const request = parseRuntimeRequest(requestInput, ChannelInterruptRequestSchema, "request");
    const result =
      request.binding.agentId === agentId
        ? await requestChannelRuntimeInterrupt(request)
        : ChannelInterruptResultSchema.parse({
            protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
            schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
            requestId: request.requestId,
            disposition: "rejected",
            error: {
              code: "LOCAL_PERMISSION_DENIED",
              category: "authorization",
              retryable: false,
              correlationId: request.requestId,
            },
            acceptedAt: new Date().toISOString(),
          });
    printRuntimeResult(
      result,
      asJson,
      `${result.disposition === "rejected" ? "Rejected" : "Accepted"} channel interrupt ${result.requestId}.`,
    );
    return result;
  }
}

function parseRuntimeRequest<T>(input: T | string, schema: { parse(value: unknown): T }, label: string): T {
  if (typeof input !== "string") return schema.parse(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return schema.parse(parsed);
}

function printRuntimeResult(result: unknown, asJson: boolean | undefined, summary: string): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!getContext({ localOnly: true })?.suppressCliOutput) {
    console.log(summary);
  }
}

declareCommandReturns(ChannelBackendRuntimeCommands, {
  interrupt: ChannelInterruptResultSchema,
  readback: ChannelRuntimeReadbackResultSchema,
});
