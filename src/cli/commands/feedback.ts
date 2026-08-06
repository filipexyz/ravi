import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { hasContext } from "../context.js";
import { ContractError, contractDryRun } from "../agent-contract.js";
import { CloudAuthError, cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import {
  normalizeFeedbackKind,
  normalizeFeedbackSeverity,
  normalizeTags,
  submitFeedback,
  type FeedbackClientDeps,
  type FeedbackSubmitResult,
} from "../../feedback/client.js";
import { jsonObjectSchema } from "../return-schemas.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

export interface FeedbackCommandDeps extends FeedbackClientDeps {
  client?: ConsoleApiClient;
}

@Group({
  name: "feedback",
  description: "Send structured feedback to Ravi Console",
  scope: "open",
})
export class FeedbackCommands {
  constructor(private readonly deps: FeedbackCommandDeps = {}) {}

  @Command({
    name: "send",
    aliases: ["create"],
    description: "Submit structured feedback to Ravi Console (dry-run by default; requires --execute)",
  })
  @CommandAccess({ kind: "mutate", resource: "feedback", action: "send", risk: "low" })
  async send(
    @Arg("message", { variadic: true, description: "Feedback message" }) messageParts: string[],
    @Option({ flags: "--kind <kind>", description: "bug|idea|ux|docs|performance|security|other" }) kind?: string,
    @Option({ flags: "--severity <severity>", description: "low|medium|high|critical" }) severity?: string,
    @Option({ flags: "--title <text>", description: "Short feedback title" }) title?: string,
    @Option({ flags: "--surface <name>", description: "Product surface, e.g. console/pages" }) surface?: string,
    @Option({ flags: "--project <ref>", description: "Console project id or slug" }) project?: string,
    @Option({ flags: "--url <url>", description: "Relevant URL" }) url?: string,
    @Option({ flags: "--tag <tags>", description: "Comma-separated tags; can be repeated" }) tags?: string | string[],
    @Option({ flags: "--metadata-json <json>", description: "Small JSON object with extra structured context" })
    metadataJson?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description:
        "Actually submit the feedback to Ravi Console; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    return runFeedbackCommand(asJson, async () => {
      const message = messageParts.join(" ");
      if (!message.trim()) {
        throw new CloudAuthError("PAYLOAD_INVALID", "Missing message.");
      }
      const options = {
        console: consoleUrl,
        kind,
        message,
        metadata: parseMetadataJson(metadataJson),
        project,
        severity,
        surface,
        tags: normalizeTagOption(tags),
        title,
        url,
      };
      if (execute !== true) {
        // Write brake (Manual v2 7.8): `send` publishes OUTSIDE the local runtime
        // (POST to the Ravi Console), so it is dry-run by default, exit 3. The
        // plan mirrors the normalized payload that --execute would submit.
        contractDryRun(
          "feedback send",
          {
            kind: normalizeFeedbackKind(kind),
            severity: normalizeFeedbackSeverity(severity),
            title: title?.trim() || null,
            message,
            surface: surface?.trim() || null,
            project: project?.trim() || null,
            url: url?.trim() || null,
            tags: normalizeTags(options.tags),
            metadata: options.metadata ?? null,
            console: consoleUrl?.trim() || null,
          },
          { asJson },
        );
      }
      const result = await submitFeedback(options, this.deps);
      printPayload(result, asJson, () => printFeedbackResult(result));
      return result;
    });
  }
}

const feedbackSendReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  feedback: jsonObjectSchema,
  url: z.string(),
});

declareCommandReturns(FeedbackCommands, {
  send: feedbackSendReturnSchema,
});

function parseMetadataJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("metadata must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `Invalid --metadata-json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeTagOption(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function runFeedbackCommand<T>(asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // The write brake is not a failure: let ContractError (exit 3) bubble to the
    // dispatcher untouched instead of wrapping it as SERVER_UNAVAILABLE.
    if (error instanceof ContractError) throw error;
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      printJson(formatCloudAuthError(cloudError));
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

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    printJson(payload);
    return;
  }
  printHuman();
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printFeedbackResult(result: FeedbackSubmitResult): void {
  const feedback = result.feedback;
  const id = stringValue(feedback.id) ?? stringValue(feedback.targetId) ?? "submitted";
  const kind = stringValue(feedback.kind) ?? "other";
  const severity = stringValue(feedback.severity) ?? "medium";
  console.log(`Feedback submitted: ${id}`);
  console.log(`Kind: ${kind} | severity: ${severity}`);
  console.log(`Console: ${result.url}`);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
