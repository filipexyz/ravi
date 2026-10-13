/**
 * Access Commands - ask a page's managers for access, and follow the request.
 */

import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { contractDryRun } from "../agent-contract.js";
import {
  ACCESS_APPROVAL_LINK_NOTE,
  ACCESS_REQUEST_MESSAGE_MAX_CHARS,
  accessDryRunPlan,
  buildAccessRequestBody,
  createAccessRequest,
  getAccessRequest,
  normalizeAccessText,
  requireAccessActor,
  type AccessDeps,
  type AccessRequestCreateResult,
  type AccessRequestStatusResult,
} from "../../access/client.js";
import { accessRequestSchema, actedBySchema, runAccessCommand } from "../../access/command-support.js";

const accessRequestReturnSchema = z.discriminatedUnion("status", [
  z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    actedBy: actedBySchema,
    status: z.literal("requested"),
    request: accessRequestSchema,
    approvalUrl: z.string(),
    approvalNote: z.string(),
  }),
  z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    actedBy: actedBySchema,
    status: z.literal("already_allowed"),
    url: z.string(),
  }),
]);

const accessStatusReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  request: accessRequestSchema,
  approvalUrl: z.string(),
  approvalNote: z.string(),
});

const ACCESS_REQUEST_HELP = `
Examples:
  ravi access request https://other-org.ravi.page/report
  ravi access request https://other-org.ravi.page/report --message "For the Q3 review" --execute

Use it when a Ravi Page answers that you (or the person asking) have no
access. Console records the request and tells the page's organization, whose
managers approve or deny it. The answer carries an approval link:
${ACCESS_APPROVAL_LINK_NOTE}
Asking again for the same page refreshes the message and returns the same
request. Someone who can already open the page gets status already_allowed.
Follow it with ravi access status <request-id>.

Write brake:
  Without --execute nothing is sent: the plan is printed and the command exits
  3. Re-run with --execute (it notifies another organization's admins).

Who asks:
  On the operator's own turns the request is made in the ravi login user's
  name. When someone else wrote the chat message, it is made in that person's
  name through their ravi link (ACTOR_NOT_LINKED, exit 3: run ravi link in
  their chat). The running agent is named on the request.
`;

const ACCESS_STATUS_HELP = `
Examples:
  ravi access status <request-id>
  ravi access status <request-id> --json

Status is pending, approved, denied or cancelled; pending requests expire
after 30 days. After approved, read the page again (ravi pages read <url>).
`;

@Group({
  name: "access",
  description: "Ask a Ravi Page's managers for access and follow the request",
  scope: "open",
})
export class AccessCommands {
  constructor(private readonly deps: AccessDeps = {}) {}

  @Command({
    name: "request",
    description: "Ask the managers of a Ravi Page for access",
    helpAfter: ACCESS_REQUEST_HELP,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "access.requests",
    action: "create",
    risk: "medium",
    requiresConfirmation: true,
  })
  @Returns(accessRequestReturnSchema)
  async request(
    @Arg("url", { description: "The Ravi Page URL that was denied" }) url: string,
    @Option({ flags: "--message <text>", description: "Why access is needed (shown to the managers, max 500)" })
    message?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Send the request. Without it, prints the plan and exits 3" })
    execute?: boolean,
  ) {
    return runAccessCommand("access request", asJson, async () => {
      const options = {
        url,
        message: normalizeAccessText(message, "--message", ACCESS_REQUEST_MESSAGE_MAX_CHARS),
        console: consoleUrl,
      };
      const actor = requireAccessActor(this.deps);
      if (execute !== true) {
        contractDryRun("access request", accessDryRunPlan(buildAccessRequestBody(options, actor), actor), { asJson });
      }
      const result = await createAccessRequest(options, { ...this.deps, actor });
      print(result, asJson, () => printRequest(result));
      return result;
    });
  }

  @Command({ name: "status", description: "Show an access request's status", helpAfter: ACCESS_STATUS_HELP })
  @CommandAccess({ kind: "read", resource: "access.requests", action: "show", risk: "low" })
  @Returns(accessStatusReturnSchema)
  async status(
    @Arg("requestId", { description: "Request id printed by ravi access request" }) requestId: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runAccessCommand("access status", asJson, async () => {
      const result = await getAccessRequest({ requestId, console: consoleUrl }, this.deps);
      print(result, asJson, () => printStatus(result));
      return result;
    });
  }
}

function print(result: unknown, asJson: boolean | undefined, human: () => void): void {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else human();
}

function printRequest(result: AccessRequestCreateResult): void {
  if (result.status === "already_allowed") {
    console.log(`Already allowed: ${result.url} opens for this account. Read it with: ravi pages read ${result.url}`);
    return;
  }
  const request = result.request;
  console.log(`Access requested for ${request.host + request.path} (request ${request.id}, ${request.status}).`);
  console.log(`Approval link: ${result.approvalUrl}`);
  console.log(result.approvalNote);
  console.log(`Check it with: ravi access status ${request.id}`);
}

function printStatus(result: AccessRequestStatusResult): void {
  const request = result.request;
  console.log(`Request ${request.id}: ${request.status}`);
  console.log(`Page: ${request.host + request.path}`);
  if (request.decidedAt) console.log(`Decided: ${request.decidedAt}`);
  else if (request.expiresAt) console.log(`Expires: ${request.expiresAt}`);
  if (request.status === "pending") {
    console.log(`Approval link: ${result.approvalUrl}`);
    console.log(result.approvalNote);
  }
}
