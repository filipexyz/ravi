/**
 * Identity Commands - link the author of the current chat message to their
 * Ravi Console account.
 */

import "reflect-metadata";
import { z } from "zod";
import { Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { getContext } from "../context.js";
import { requestIdentityLink, unlinkIdentity } from "../../identity-link/link-service.js";
import { wakeLinkRequestWatcher } from "../../identity-link/link-watcher.js";

const identityLinkReturnSchema = z.discriminatedUnion("status", [
  z.object({ success: z.literal(true), status: z.literal("already_linked"), linked: z.literal(true) }),
  z.object({
    success: z.literal(true),
    status: z.literal("dm_sent"),
    linked: z.literal(false),
    expiresAt: z.string(),
  }),
]);

const identityUnlinkReturnSchema = z.object({
  success: z.literal(true),
  status: z.enum(["unlinked", "not_linked"]),
  linked: z.literal(false),
});

const LINK_HELP = `
Links the author of the current chat message, and only that person, to their
Ravi Console account. There is no flag to name someone else.

  1. Ravi sends the author a private message with a single-use link (10 min).
  2. The author signs in to the Console and approves.
  3. Ravi confirms in the private chat and where the request was made.

Output never contains the link, tokens, emails or ids. Repeating the command
reports an existing link without changing anything; while a link is pending it
sends a fresh one and the previous link stops working.

Errors:
  CONTACT_REQUIRED     the message author is not a resolved person (or no chat turn)
  LINK_DM_UNSUPPORTED  this channel cannot reach the author privately (Slack and WhatsApp can)
  LINK_DM_FAILED       the private message could not be delivered; nothing was linked
  AUTH_REQUIRED        the daemon host has no \`ravi login\`
`;

const UNLINK_HELP = `
Removes the Console link of the author of the current chat message on this
installation and cancels any pending link for them. People can also revoke
links themselves on the Console /link page.
`;

@Group({
  name: "identity",
  description: "Link chat people to their Ravi Console account",
  scope: "open",
})
export class IdentityCommands {
  @Command({
    name: "link",
    description: "Send the message author a private link to approve in the Console",
    helpAfter: LINK_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "identity", action: "link", risk: "low" })
  @Returns(identityLinkReturnSchema)
  async link(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const result = await requestIdentityLink(getContext()?.context);
    if (result.status === "dm_sent") wakeLinkRequestWatcher();
    print(result, asJson, () =>
      result.status === "already_linked"
        ? "✓ Already linked. Nothing changed."
        : `✓ Sent a private approval link to the message author (expires ${result.expiresAt}).`,
    );
    return result;
  }

  @Command({
    name: "unlink",
    description: "Remove the message author's Console link on this installation",
    helpAfter: UNLINK_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "identity", action: "unlink", risk: "low" })
  @Returns(identityUnlinkReturnSchema)
  async unlink(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const result = await unlinkIdentity(getContext()?.context);
    print(result, asJson, () =>
      result.status === "unlinked" ? "✓ Link removed." : "Nothing to remove: this person was not linked.",
    );
    return result;
  }
}

function print(result: unknown, asJson: boolean | undefined, human: () => string): void {
  console.log(asJson ? JSON.stringify(result, null, 2) : human());
}
