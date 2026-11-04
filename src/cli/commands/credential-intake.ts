import "reflect-metadata";
import { z } from "zod";
import { actorCanGrantRequestedPermission } from "../../approval/grantor.js";
import { configStore } from "../../config-store.js";
import { SlackWebApiClient } from "../../channels/slack/client.js";
import { isSlackGatewayChannel, resolveSlackCredentialConfigFromEnv } from "../../channels/slack/credentials.js";
import { buildCredentialIntakeInvitation } from "../../channels/slack/credential-intake.js";
import {
  createIntakeRequest,
  cancelIntakeRequest,
  intakeMetadataSchema,
  normalizeIntakeTarget,
  IntakeError,
} from "../../credentials/intake.js";
import { getContext, type ToolContext } from "../context.js";
import { ContractError, contractDryRun, contractFail } from "../agent-contract.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import type { ChannelConfig } from "../../router/router-db.js";
import { errorDiagnostic } from "../../utils/error-diagnostic.js";
import { authorizeIntakeSubject } from "../../credentials/intake-authorization.js";

function failIntake(code: string, message: string, asJson?: boolean, exitCode?: 1 | 2 | 3): never {
  const op = "credentials request";
  contractFail(op, code, message, { asJson, exitCode, diagnostic: errorDiagnostic(message, { operation: op, code }) });
}

const requestResultSchema = z
  .object({
    requestId: z.string(),
    target: z.string(),
    expiresAt: z.number(),
    delivery: z.literal("ephemeral"),
  })
  .strict();

export interface CredentialIntakeCommandDeps {
  context(): ToolContext | undefined;
  channels(): Record<string, ChannelConfig>;
  authorize: typeof actorCanGrantRequestedPermission;
  client(channel: ChannelConfig): Promise<Pick<SlackWebApiClient, "authTest" | "postEphemeral">>;
  create: typeof createIntakeRequest;
  cancel: typeof cancelIntakeRequest;
}

const defaults: CredentialIntakeCommandDeps = {
  context: getContext,
  channels: () => configStore.getConfig().channels ?? {},
  authorize: (input) => {
    const actor = actorCanGrantRequestedPermission(input);
    if (
      actor.allowed &&
      actor.subjectType === "contact" &&
      actor.subjectId &&
      input.objectId &&
      authorizeIntakeSubject("contact", actor.subjectId, "credentials.secrets", input.objectId)
    )
      return actor;
    return { ...actor, allowed: false, reason: "unauthorized_grantor" };
  },
  client: async (channel) => {
    const config = await resolveSlackCredentialConfigFromEnv(process.env, {
      channel,
      action: "credentials.request",
    });
    if (!config || config.source !== "broker") throw new Error("INTAKE_TRANSPORT_UNSUPPORTED");
    // The sensitive path talks directly to Slack; a proxy can persist submissions.
    return new SlackWebApiClient({ appToken: config.appToken, botToken: config.botToken });
  },
  create: createIntakeRequest,
  cancel: cancelIntakeRequest,
};

@Group({
  name: "credentials",
  description: "Request protected credentials without exposing their values",
  scope: "open",
})
export class CredentialIntakeCommands {
  constructor(private readonly deps: CredentialIntakeCommandDeps = defaults) {}

  @Command({
    name: "request",
    description: "Send a private Slack button to add an API credential; accepts metadata only",
    helpAfter: `
Targets: env:<allowlisted secret key> or connection:<provider>:<connection>.
Runs in the current Slack conversation. The recipient needs
mutate:credentials.secrets:<target>; the caller needs
mutate:credentials.requests:<target>. No permission is granted by this command.
The recipient clicks the private button and submits a token in a native modal.
Only direct Socket Mode is supported. Passwords and long-lived OAuth tokens
belong in a native OAuth flow or a separately secured private intake.
Environment scope is the host; a connection is provider-scoped. This does not
create agent/session isolation, grant credential use, rotate an existing target,
restart services, or accept --value/--secret/--stdin.
Example: ravi credentials request connection:slack:secondary --user U123ABC
  --reason "Read the protected workspace" --label "Secondary Slack" --json --execute
`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "credentials.requests",
    action: "request",
    risk: "high",
    resourceId: "target",
    requireConcreteResource: true,
    requiresConfirmation: true,
    input: ["target"],
  })
  @Returns(requestResultSchema)
  async request(
    @Arg("target", { description: "env:<key> or connection:<provider>:<connection>" }) target: string,
    @Option({ flags: "--user <id>", description: "Slack user who will provide the credential privately" })
    user?: string,
    @Option({ flags: "--reason <text>", description: "Why the credential is needed (never include a secret)" })
    reason?: string,
    @Option({ flags: "--label <text>", description: "Human-readable credential label" }) label?: string,
    @Option({
      flags: "--backend <backend>",
      description: "Connection secret backend: file (default), keychain or vault",
      defaultValue: "file",
    })
    backend?: string,
    @Option({ flags: "--scopes <csv>", description: "Provider scopes, informational; does not grant Ravi permissions" })
    scopes?: string,
    @Option({ flags: "--json", description: "Print request receipt without secret values" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Send the private invitation; otherwise dry-run (exit 3)" })
    execute?: boolean,
  ) {
    const op = "credentials request";
    try {
      const normalized = normalizeIntakeTarget(target);
      if (normalized.target !== target) {
        failIntake("INTAKE_TARGET_INVALID", "Use the canonical credential target.", asJson, 2);
      }
      const ctx = this.deps.context();
      // Transport coordinates and issuer identity come from the authenticated
      // record, never getContext's legacy environment fallback/projection.
      const source = ctx?.context?.source;
      const issuerAgentId = ctx?.context?.agentId;
      if (!source || source.channel !== "slack" || !ctx?.context || !issuerAgentId) {
        failIntake(
          "INTAKE_SLACK_CONTEXT_REQUIRED",
          "Request a credential from an authenticated Slack turn.",
          asJson,
          3,
        );
      }
      const channel = this.deps.channels()[source.accountId];
      if (!channel || channel.enabled === false || channel.provider !== "slack" || isSlackGatewayChannel(channel)) {
        failIntake(
          "INTAKE_TRANSPORT_UNSUPPORTED",
          "Credential modals require a direct Slack Socket Mode account.",
          asJson,
          3,
        );
      }
      if (!user || !/^[UW][A-Z0-9]+$/.test(user) || !reason?.trim()) {
        failIntake("INTAKE_METADATA_INVALID", "Provide --user and a non-secret --reason.", asJson, 2);
      }
      const recipient = this.deps.authorize({
        channel: "slack",
        instanceId: source.accountId,
        senderId: user,
        permission: "mutate",
        objectType: "credentials.secrets",
        objectId: target,
      });
      if (!recipient.allowed || recipient.subjectType !== "contact" || !recipient.subjectId) {
        failIntake("INTAKE_RECIPIENT_DENIED", "The recipient cannot set this credential target.", asJson, 3);
      }
      // Validate metadata even on dry-run, but do not resolve a token or call Slack.
      const metadata = intakeMetadataSchema.parse({
        target,
        accountId: source.accountId,
        teamId: "TPENDING",
        userId: user,
        channelId: source.chatId,
        threadTs: source.threadId,
        issuerContextId: ctx.context.contextId,
        issuerAgentId,
        issuerSessionKey: ctx.context.sessionKey ?? undefined,
        reason: reason.trim(),
        label,
        ...(normalized.kind === "connection"
          ? {
              backend: backend ?? "file",
              scopes:
                scopes
                  ?.split(",")
                  .map((scope) => scope.trim())
                  .filter(Boolean) ?? [],
            }
          : {}),
      });
      if (execute !== true) {
        contractDryRun(
          op,
          { target, recipient: user, scope: normalized.scope, delivery: "ephemeral", expiresInSeconds: 600 },
          { asJson },
        );
      }
      const client = await this.deps.client(channel);
      const identity = await client.authTest();
      if (!identity.team_id || !/^T[A-Z0-9]+$/.test(identity.team_id)) throw new Error("INTAKE_WORKSPACE_UNRESOLVED");
      const request = this.deps.create({ ...metadata, teamId: identity.team_id });
      try {
        await client.postEphemeral({
          channel: metadata.channelId,
          user: metadata.userId,
          threadTs: metadata.threadTs,
          ...buildCredentialIntakeInvitation(request),
        });
      } catch {
        this.deps.cancel(request.id, {
          accountId: request.accountId,
          teamId: request.teamId,
          userId: request.userId,
          actorContactId: recipient.subjectId,
        });
        throw new Error("INTAKE_DELIVERY_FAILED");
      }
      const result = {
        requestId: request.id,
        target: request.target,
        expiresAt: request.expiresAt,
        delivery: "ephemeral" as const,
      };
      if (asJson) console.log(JSON.stringify(result));
      else console.log("Private credential invitation sent. The value will only be accepted in its modal.");
      return result;
    } catch (error) {
      if (error instanceof ContractError) throw error;
      // Do not serialize parser errors, Slack responses, backend errors or causes.
      const code =
        error instanceof IntakeError
          ? error.code
          : error instanceof z.ZodError
            ? "INTAKE_METADATA_INVALID"
            : "INTAKE_REQUEST_FAILED";
      failIntake(
        code,
        "Credential request could not be created. Check the target, recipient and direct Slack account.",
        asJson,
      );
    }
  }
}
