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
    } else if (!getContext()?.suppressCliOutput) {
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
