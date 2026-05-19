import "reflect-metadata";
import { CliOnly, Command, Group, Option } from "../decorators.js";
import { cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import { execCapability, listConnectors } from "../../link/connectors.js";

@Group({
  name: "gmail",
  description: "Operate Gmail through a connected Google connector",
  scope: "open",
})
export class GmailCommands {
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

      const exec = await execCapability({
        connectorId,
        capability: "gmail.message.send",
        parameters,
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
    process.exit(cloudError.exitCode);
  }
}
