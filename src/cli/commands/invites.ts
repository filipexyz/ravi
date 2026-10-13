/**
 * Invites Commands - bring someone into the Console organization of the
 * current `ravi login` with a single-use link for one email and one role.
 */

import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { contractDryRun } from "../agent-contract.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { strictCliOffsetPaginationSchema } from "../return-schemas.js";
import {
  ACCESS_REASON_MAX_CHARS,
  accessDryRunPlan,
  buildInviteBody,
  createInvite,
  listInvites,
  normalizeAccessEmail,
  normalizeAccessText,
  normalizeOrganizationRole,
  ORGANIZATION_ROLES,
  requireAccessActor,
  revokeInvite,
  type AccessDeps,
  type InviteCreateResult,
  type InviteListResult,
} from "../../access/client.js";
import { actedBySchema, organizationInviteSchema, runAccessCommand } from "../../access/command-support.js";

const inviteCreateReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  actedBy: actedBySchema,
  invite: organizationInviteSchema,
  url: z.string(),
});

const inviteListReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  total: z.number(),
  pagination: strictCliOffsetPaginationSchema,
  invites: z.array(organizationInviteSchema),
});

const inviteRevokeReturnSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  actedBy: actedBySchema,
  revoked: z.boolean(),
});

const INVITES_CREATE_HELP = `
Examples:
  ravi invites create --email ana@example.com
  ravi invites create --email ana@example.com --role developer --reason "Joins the data team" --execute

Creates a single-use link for one email and one role in the organization of
the current ravi login. It lasts 7 days; creating another for the same email
replaces the previous link. Ravi does not email it: send the printed URL to
the person. Only that email (verified, signed in) can accept it.

Roles: viewer (default), developer, admin, billing, owner. Only an owner or
admin can invite, and only an owner can invite an owner.

To show one private page to someone without making them a member, use
ravi pages share <url> --with <email> instead.

Write brake:
  Without --execute nothing is created: the plan is printed and the command
  exits 3. Re-run with --execute.

Who acts:
  On the operator's own turns the ravi login user invites. When someone else
  wrote the chat message, Console acts for that person through their ravi
  link, and both they and the ravi login user must be allowed to invite.
  ACTOR_NOT_LINKED (exit 3): run ravi link in their chat.
`;

const INVITES_LIST_HELP = `
Lists pending invites of the current ravi login's organization (owner or admin
only). Only on the operator's own turns.
`;

const INVITES_REVOKE_HELP = `
Examples:
  ravi invites revoke <invite-id>

The link stops working at once. Only reduces access, so no --execute.
`;

@Group({
  name: "invites",
  description: "Invite people into the Console organization by email",
  scope: "open",
})
export class InvitesCommands {
  constructor(private readonly deps: AccessDeps = {}) {}

  @Command({
    name: "create",
    description: "Create a single-use organization invite link",
    helpAfter: INVITES_CREATE_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "invites", action: "create", risk: "high", requiresConfirmation: true })
  @Returns(inviteCreateReturnSchema)
  async create(
    @Option({ flags: "--email <email>", description: "Email of the person to invite" }) email?: string,
    @Option({
      flags: "--role <role>",
      description: `Organization role: ${ORGANIZATION_ROLES.join("|")} (default viewer)`,
    })
    role?: string,
    @Option({ flags: "--reason <text>", description: "Why this person is invited (audit note, max 500)" })
    reason?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Create the invite. Without it, prints the plan and exits 3" })
    execute?: boolean,
  ) {
    return runAccessCommand("invites create", asJson, async () => {
      const options = {
        email: normalizeAccessEmail(email, "--email"),
        role: normalizeOrganizationRole(role),
        reason: normalizeAccessText(reason, "--reason", ACCESS_REASON_MAX_CHARS),
        console: consoleUrl,
      };
      const actor = requireAccessActor(this.deps);
      if (execute !== true) {
        contractDryRun(
          "invites create",
          accessDryRunPlan(buildInviteBody(options, actor), actor, { role: options.role ?? "viewer" }),
          { asJson },
        );
      }
      const result = await createInvite(options, { ...this.deps, actor });
      print(result, asJson, () => printInvite(result));
      return result;
    });
  }

  @Command({ name: "list", description: "List pending organization invites", helpAfter: INVITES_LIST_HELP })
  @CommandAccess({ kind: "read", resource: "invites", action: "list", risk: "low" })
  @Returns(inviteListReturnSchema)
  async list(
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum invites to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of invites to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runAccessCommand("invites list", asJson, async () => {
      const listed = await listInvites({ console: consoleUrl }, this.deps);
      const page = paginateCliItems(listed.invites, { limit, offset });
      const result = {
        ...listed,
        total: page.total,
        pagination: buildCliOffsetPagination({
          baseCommand: ["ravi", "invites", "list"],
          limit: page.limit,
          offset: page.offset,
          returned: page.items.length,
          total: page.total,
          options: [consoleUrl ? "--console" : null, consoleUrl],
        }),
        invites: page.items,
      };
      print(result, asJson, () => printInviteList(result));
      return result;
    });
  }

  @Command({ name: "revoke", description: "Revoke a pending invite link", helpAfter: INVITES_REVOKE_HELP })
  @CommandAccess({ kind: "mutate", resource: "invites", action: "revoke", risk: "medium" })
  @Returns(inviteRevokeReturnSchema)
  async revoke(
    @Arg("inviteId", { description: "Invite id from ravi invites list" }) inviteId: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runAccessCommand("invites revoke", asJson, async () => {
      const result = await revokeInvite({ inviteId, console: consoleUrl }, this.deps);
      print(result, asJson, () =>
        console.log(result.revoked ? "Invite revoked: the link no longer works." : "Nothing to revoke: not pending."),
      );
      return result;
    });
  }
}

function print(result: unknown, asJson: boolean | undefined, human: () => void): void {
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else human();
}

function printInvite(result: InviteCreateResult): void {
  const invite = result.invite;
  console.log(`Invite created for ${invite.email} as ${invite.role}, valid until ${invite.expiresAt}.`);
  console.log(`Send this link to ${invite.email}. Only that email can accept it, once:`);
  console.log(`  ${result.url}`);
}

function printInviteList(result: InviteListResult): void {
  if (result.invites.length === 0) {
    console.log("No pending invites.");
    return;
  }
  for (const invite of result.invites) {
    const by = invite.invitedBy ? `, by ${invite.invitedBy}` : "";
    console.log(`- ${invite.email} (${invite.role}) until ${invite.expiresAt}${by} [${invite.id}]`);
  }
}
