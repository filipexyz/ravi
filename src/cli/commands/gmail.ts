import "reflect-metadata";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { CONTRACT_EXIT_POLICY, ContractError, contractDryRun, contractFail } from "../agent-contract.js";
import { CloudAuthError, cloudAuthErrorFromUnknown } from "../../cloud-auth/errors.js";
import { APPROVAL_ID_PATTERN } from "../../link/client.js";
import { currentConnectorRuntimeContext } from "../../link/connector-turn.js";
import {
  connectorReconnectError,
  execCapabilityWithApproval,
  listConnectors,
  pickDefaultConnector,
  type StepUpHandler,
} from "../../link/connectors.js";
import { openExternal } from "../../link/open-external.js";
import { jsonValueSchema } from "../return-schemas.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

const APPROVAL_FLAG_DESCRIPTION =
  "Approval id the account owner approved for this exact action (from a CONNECTOR_APPROVAL_REQUIRED answer)";

@Group({
  name: "gmail",
  description: "Operate your Gmail through your connected Google account",
  scope: "open",
})
export class GmailCommands {
  @Command({ name: "list", description: "List messages in the connected Gmail mailbox" })
  @CommandAccess({ kind: "read", resource: "gmail", action: "list", risk: "low" })
  async list(
    @Option({ flags: "--q <query>", description: "Gmail search query (same as the web search bar)" }) query?: string,
    @Option({ flags: "--label <id>", description: "Filter by label id (repeat for multiple)" }) label?: string,
    @Option({ flags: "--max <n>", description: "Max messages to return (1-100, default 25)" }) maxOpt?: string,
    @Option({ flags: "--cursor <token>", description: "Page token for the next page (Gmail nextPageToken)" })
    cursor?: string,
    @Option({
      flags: "--connector <id>",
      description: "Connection id (defaults to your default Google connection, else the newest active one)",
    })
    connector?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--approval <id>", description: APPROVAL_FLAG_DESCRIPTION }) approval?: string,
  ) {
    return runGmailCommand(asJson, async () => {
      assertApprovalId(approval);
      const connectorId = connector ?? (await resolveDefaultGoogleConnector());
      const max = Math.min(Math.max(Number.parseInt(maxOpt ?? "25", 10) || 25, 1), 100);
      const labelIds = label
        ? label
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const exec = await execWithApproval({
        connectorId,
        capability: "gmail.message.list",
        parameters: { q: query, labelIds, maxResults: max, pageToken: cursor },
        asJson,
        approvalId: approval,
      });
      const result = (exec.result ?? {}) as {
        messages?: Array<{ id: string; threadId: string }>;
        nextPageToken?: string;
        resultSizeEstimate?: number;
      };
      if (asJson) {
        console.log(JSON.stringify(exec, null, 2));
      } else {
        const messages = result.messages ?? [];
        if (messages.length === 0) {
          console.log("No messages match the query.");
        } else {
          console.log(`Messages (${messages.length}):`);
          for (const message of messages) {
            console.log(`- ${message.id} (thread ${message.threadId})`);
          }
        }
        if (result.nextPageToken) console.log(`Next page: ${result.nextPageToken}`);
      }
      return exec;
    });
  }

  @Command({ name: "read", description: "Read a single Gmail message" })
  @CommandAccess({ kind: "read", resource: "gmail", action: "read", risk: "low" })
  async read(
    @Arg("id", { description: "Gmail message id (from `ravi gmail list`)" }) id: string,
    @Option({ flags: "--format <format>", description: "full | metadata | raw (default full)" }) format?: string,
    @Option({
      flags: "--connector <id>",
      description: "Connection id (defaults to your default Google connection, else the newest active one)",
    })
    connector?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--approval <id>", description: APPROVAL_FLAG_DESCRIPTION }) approval?: string,
  ) {
    return runGmailCommand(asJson, async () => {
      assertApprovalId(approval);
      const connectorId = connector ?? (await resolveDefaultGoogleConnector());
      const exec = await execWithApproval({
        connectorId,
        capability: "gmail.message.read",
        parameters: { id, format: (format ?? "full") as "full" | "metadata" | "raw" },
        asJson,
        approvalId: approval,
      });
      if (asJson) {
        console.log(JSON.stringify(exec, null, 2));
      } else {
        const message = (exec.result ?? {}) as {
          id: string;
          threadId: string;
          snippet?: string;
          internalDate?: string;
          headers?: Record<string, string | undefined>;
          body?: { text?: string; html?: string };
        };
        const headers = message.headers ?? {};
        console.log(`From:    ${headers.from ?? "(unknown)"}`);
        if (headers.to) console.log(`To:      ${headers.to}`);
        if (headers.cc) console.log(`Cc:      ${headers.cc}`);
        if (headers.subject) console.log(`Subject: ${headers.subject}`);
        if (headers.date) console.log(`Date:    ${headers.date}`);
        if (message.snippet) {
          console.log(`Snippet: ${message.snippet}`);
        }
        const text = message.body?.text ?? "";
        const html = message.body?.html ?? "";
        if (text) {
          console.log("");
          console.log(text);
        } else if (html) {
          console.log("");
          console.log("(HTML body — pass --json for raw)");
          console.log(html.slice(0, 500));
        }
      }
      return exec;
    });
  }

  @Command({ name: "send", description: "Send an email through Gmail" })
  @CommandAccess({
    kind: "mutate",
    resource: "gmail",
    action: "send",
    risk: "high",
    requiresConfirmation: true,
    input: ["to", "cc", "bcc", "subject", "body", "html", "connector", "approval"],
    redactions: ["body", "html"],
  })
  async send(
    @Option({ flags: "--to <addr>", description: "Recipient address; repeat or comma-separate for multiple" })
    to?: string,
    @Option({ flags: "--cc <addr>", description: "Cc recipients; comma-separated" }) cc?: string,
    @Option({ flags: "--bcc <addr>", description: "Bcc recipients; comma-separated" }) bcc?: string,
    @Option({ flags: "--subject <subject>", description: "Email subject" }) subject?: string,
    @Option({ flags: "--body <body>", description: "Plain text body" }) body?: string,
    @Option({ flags: "--html <body>", description: "Optional HTML body" }) html?: string,
    @Option({ flags: "--in-reply-to <messageId>", description: "Message-Id this email replies to" })
    inReplyTo?: string,
    @Option({
      flags: "--connector <id>",
      description: "Connection id (defaults to your default Google connection, else the newest active one)",
    })
    connector?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--approval <id>", description: APPROVAL_FLAG_DESCRIPTION }) approval?: string,
    @Option({
      flags: "--execute",
      description: "Actually send the email; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runGmailCommand(asJson, async () => {
      assertApprovalId(approval);
      const recipients = parseAddressList(to);
      if (!recipients.length) {
        throw new Error("--to is required");
      }
      if (!subject) {
        throw new Error("--subject is required");
      }
      if (!body && !html) {
        throw new Error("Provide --body or --html");
      }

      if (execute !== true) {
        // Write brake (Manual v2 7.8): external e-mail to real recipients is
        // irreversible, so dry-run by default and exit 3 before any connector
        // resolution or provider call.
        contractDryRun(
          "gmail send",
          {
            fromPresent: false,
            toCount: recipients.length,
            ccCount: parseAddressList(cc).length,
            bccCount: parseAddressList(bcc).length,
            subjectChars: subject.length,
            bodyChars: (body ?? html ?? "").length,
            inReplyToPresent: Boolean(inReplyTo),
          },
          { asJson },
        );
      }

      const connectorId = connector ?? (await resolveDefaultGoogleConnector());
      const parameters = {
        to: recipients,
        cc: parseAddressList(cc) || undefined,
        bcc: parseAddressList(bcc) || undefined,
        subject,
        body: body ?? html!,
        bodyHtml: html,
        inReplyTo,
      };

      const exec = await execWithApproval({
        connectorId,
        capability: "gmail.message.send",
        parameters,
        asJson,
        approvalId: approval,
        stepUp: true,
      });

      if (asJson) {
        console.log(JSON.stringify(exec, null, 2));
      } else {
        const result = (exec.result ?? {}) as { messageId?: string; threadId?: string };
        console.log(`Sent. messageId: ${result.messageId ?? "(unknown)"}`);
        if (result.threadId) console.log(`Thread: ${result.threadId}`);
        if (exec.refreshed) console.log("(Access token refreshed during send.)");
      }
      return exec;
    });
  }
}

const gmailExecResultSchema = z.object({
  result: jsonValueSchema.optional(),
  capability: z.string(),
  refreshed: z.boolean(),
});

declareCommandReturns(GmailCommands, {
  list: gmailExecResultSchema,
  read: gmailExecResultSchema,
  send: gmailExecResultSchema,
});

/**
 * Answer a step-up challenge in the operator's own terminal: show the page,
 * open it and read the code back. A runtime turn (an agent, the gateway)
 * never opens a browser on this machine or waits on the daemon's stdin.
 */
function stepUpPrompt(op: string, asJson: boolean | undefined): StepUpHandler {
  return async (challenge) => {
    if (currentConnectorRuntimeContext().present) {
      contractFail(
        op,
        "INTERACTIVE_ONLY",
        "This action needs a step-up check in the browser, which only the account owner can do in their own terminal, so it was not done.",
        {
          asJson,
          exitCode: CONTRACT_EXIT_POLICY,
          details: { suggestedAction: "ask the account owner to run the same command in their own terminal" },
        },
      );
    }
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            status: "stepup_required",
            challengeId: challenge.challengeId,
            verificationUrl: challenge.verificationUrl,
            expiresAt: challenge.expiresAt,
          },
          null,
          2,
        ),
      );
    } else {
      console.log("Step-up authentication required for this destructive action.");
      console.log(`Open: ${challenge.verificationUrl}`);
      console.log(`(expires at ${challenge.expiresAt})`);
    }
    try {
      await openExternal(challenge.verificationUrl);
    } catch {
      // Best-effort browser open
    }
    return promptStepUpToken(asJson);
  };
}

/**
 * Run the action. When the owner must approve it first: at the operator's
 * own terminal (stdin and stdout are TTYs, no runtime context, no --json)
 * open the approval page, wait for the decision and run it once more with
 * the approval. Anywhere else the approval answer goes back to the caller
 * (exit 3) with the link to send the owner and the `--approval <id>` to
 * re-run with. `stepUp` answers a step-up challenge (send only), keeping
 * the approval on the retry.
 */
async function execWithApproval(input: {
  connectorId: string;
  capability: string;
  parameters: unknown;
  asJson: boolean | undefined;
  approvalId?: string;
  stepUp?: boolean;
}) {
  return execCapabilityWithApproval(
    {
      connectorId: input.connectorId,
      capability: input.capability,
      parameters: input.parameters,
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    },
    {},
    isOperatorTerminal(input.asJson) ? { openExternal } : null,
    input.stepUp ? stepUpPrompt("gmail send", input.asJson) : null,
  );
}

function isOperatorTerminal(asJson: boolean | undefined): boolean {
  if (asJson || process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  return !currentConnectorRuntimeContext().present;
}

function assertApprovalId(approval: string | undefined): void {
  if (approval !== undefined && !APPROVAL_ID_PATTERN.test(approval)) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--approval must be the approval id from the approval answer.");
  }
}

async function promptStepUpToken(asJson: boolean | undefined): Promise<string | null> {
  if (asJson || !process.stdin.isTTY) {
    // Non-interactive path: read a single line from stdin.
    const chunks: string[] = [];
    return new Promise((resolve) => {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string | Buffer) =>
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
      );
      process.stdin.on("end", () => resolve(chunks.join("").trim() || null));
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Paste the step-up code from the browser and press enter: ");
    return answer.trim() || null;
  } finally {
    rl.close();
  }
}

async function resolveDefaultGoogleConnector(): Promise<string> {
  const connectors = await listConnectors({ provider: "google" });
  const { connector, needsReconnect } = pickDefaultConnector(connectors, "google");
  if (connector) return connector.id;
  if (needsReconnect) throw connectorReconnectError();
  throw new CloudAuthError(
    "CONNECTOR_CONNECTION_REQUIRED",
    "You have no active Google connection. Run `ravi connectors connect google` first, or pass --connector <id>.",
    { details: { source: "connector-turn" } },
  );
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function runGmailCommand<T>(_asJson: boolean | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    // Manual v2 contract: contractDryRun/contractFail already emitted their
    // envelope and carry the exit taxonomy; never wrap them as cloud errors.
    if (error instanceof ContractError) throw error;
    throw cloudAuthErrorFromUnknown(error);
  }
}
