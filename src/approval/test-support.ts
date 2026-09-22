import { createContact, linkContactIdentity, updateContact } from "../contacts.js";
import { actorCanGrantRequestedPermission, type ApprovalGrantorInput } from "./grantor.js";

export const APPROVAL_TEST_WA_OWNER_PHONE = "5511987009601";
export const APPROVAL_TEST_SLACK_OWNER_PHONE = "5511987009602";
export const APPROVAL_TEST_FAMILY_PHONE = "5511987009603";
export const APPROVAL_TEST_LEAD_PHONE = "5511987009604";
export const APPROVAL_TEST_SUPERADMIN_PHONE = "5511987009605";
export const APPROVAL_TEST_STRANGER_PHONE = "5511987009606";
export const APPROVAL_TEST_SLACK_OWNER_USER = "UAPPR96DD";
export const APPROVAL_TEST_SLACK_STRANGER_USER = "UAPPR96D9";
export const APPROVAL_TEST_TIMEOUT_MS = 250;
export const APPROVAL_TEST_NOW_MS = 1_000;

export function seedApprovalContact(input: {
  phone: string;
  name: string;
  tags: string[];
  slack?: { userId: string; instanceId?: string };
}) {
  let contact;
  try {
    contact = createContact({
      phone: input.phone,
      name: input.name,
      tags: input.tags,
      status: "allowed",
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Contact already exists:")) {
      throw error;
    }
    contact = updateContact(input.phone, {
      name: input.name,
      tags: input.tags,
      status: "allowed",
    });
  }
  if (!contact?.id) {
    throw new Error(`Approval test contact was not created: ${input.phone}`);
  }
  if (input.slack) {
    linkContactIdentity(contact.id, {
      channel: "slack",
      platformUserId: input.slack.userId,
      instanceId: input.slack.instanceId ?? "main",
    });
  }
  return contact;
}

export function assertAuthorizedGrantor(input: ApprovalGrantorInput) {
  const result = actorCanGrantRequestedPermission(input);
  if (!result.allowed) {
    throw new Error(`expected authorized grantor for ${input.senderId} (${input.channel}): ${result.reason}`);
  }
  return result;
}
