import "reflect-metadata";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { Arg, CliOnly, Command, CommandAccess, Group, Option } from "../decorators.js";
import { cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import { LinkStepUpRequiredError } from "../../link/client.js";
import { execCapability, listConnectors } from "../../link/connectors.js";
import { hasContext } from "../context.js";
import { jsonValueSchema } from "../return-schemas.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

@Group({
  name: "gmail",
  description: "Operate Gmail through a connected Google connector",
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
    @Option({ flags: "--connector <id>", description: "Connector id (defaults to first active Google)" })
    connector?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runGmailCommand(asJson, async () => {
      const connectorId = connector ?? (await resolveDefaultGoogleConnector());
      const max = Math.min(Math.max(Number.parseInt(maxOpt ?? "25", 10) || 25, 1), 100);
      const labelIds = label
        ? label
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const exec = await execCapability({
        connectorId,
        capability: "gmail.message.list",
        parameters: { q: query, labelIds, maxResults: max, pageToken: cursor },
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
    @Option({ flags: "--connector <id>", description: "Connector id (defaults to first active Google)" })
    connector?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runGmailCommand(asJson, async () => {
      const connectorId = connector ?? (await resolveDefaultGoogleConnector());
      const exec = await execCapability({
        connectorId,
        capability: "gmail.message.read",
        parameters: { id, format: (format ?? "full") as "full" | "metadata" | "raw" },
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
  @CliOnly()
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
    @Option({ flags: "--connector <id>", description: "Connector id (defaults to first active Google)" })
    connector?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runGmailCommand(asJson, async () => {
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

      const exec = await execWithStepUp({
        connectorId,
        capability: "gmail.message.send",
        parameters,
        asJson,
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
});

async function execWithStepUp(input: {
  connectorId: string;
  capability: string;
  parameters: unknown;
  asJson: boolean | undefined;
}) {
  try {
    return await execCapability({
      connectorId: input.connectorId,
      capability: input.capability,
      parameters: input.parameters,
    });
  } catch (error) {
    if (!(error instanceof LinkStepUpRequiredError)) throw error;
    if (input.asJson) {
      console.log(
        JSON.stringify(
          {
            status: "stepup_required",
            challengeId: error.details.challengeId,
            verificationUrl: error.details.verificationUrl,
            expiresAt: error.details.expiresAt,
          },
          null,
          2,
        ),
      );
    } else {
      console.log("Step-up authentication required for this destructive action.");
      console.log(`Open: ${error.details.verificationUrl}`);
      console.log(`(expires at ${error.details.expiresAt})`);
    }
    try {
      await openExternal(error.details.verificationUrl);
    } catch {
      // Best-effort browser open
    }
    const token = await promptStepUpToken(input.asJson);
    if (!token) throw new Error("Step-up cancelled.");
    return execCapability({
      connectorId: input.connectorId,
      capability: input.capability,
      parameters: input.parameters,
      stepUpToken: token,
    });
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

function openExternal(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function resolveDefaultGoogleConnector(): Promise<string> {
  const connectors = await listConnectors({ provider: "google" });
  const active = connectors.find((conn) => conn.status === "active" && !conn.requiresReauth);
  if (!active) {
    throw new Error(
      "No active Google connector found. Run `ravi connectors connect google` first, or pass --connector <id>.",
    );
  }
  return active.id;
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function runGmailCommand<T>(asJson: boolean | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      console.log(JSON.stringify(formatCloudAuthError(cloudError), null, 2));
    } else {
      console.error(`${cloudError.code}: ${cloudError.message}`);
      if (cloudError.code === "AUTH_REQUIRED" || cloudError.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    if (hasContext()) throw cloudError;
    process.exit(cloudError.exitCode);
  }
}
