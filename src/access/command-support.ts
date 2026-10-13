import { z } from "zod";

import { contractFail, ContractError } from "../cli/agent-contract.js";
import { cloudAuthErrorFromUnknown } from "../cloud-auth/errors.js";
import { describeAccessFailure, type AccessOperation } from "./client.js";

/** Shared by `ravi pages share|unshare|access`, `ravi invites` and `ravi access`. */
export const actedBySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator") }),
  z.object({ kind: z.literal("contact"), contactId: z.string() }),
]);

export const accessGrantSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  userId: z.string(),
  scope: z.enum(["route", "site"]),
  routeId: z.string().nullable(),
  routePath: z.string().nullable(),
  url: z.string(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});

export const organizationInviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  invitedBy: z.string().nullable(),
});

export const accessRequestSchema = z.object({
  id: z.string(),
  status: z.string(),
  url: z.string(),
  path: z.string(),
  host: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

/**
 * Runs an access command: Console refusals and local actor refusals get their
 * own agent-facing copy (`describeAccessFailure`); anything else keeps the
 * cloud error funnel.
 */
export async function runAccessCommand<T>(
  op: AccessOperation,
  asJson: boolean | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    const failure = describeAccessFailure(error, op);
    if (failure) {
      contractFail(op, failure.code, failure.message, {
        asJson,
        exitCode: failure.exitCode,
        details: failure.details,
      });
    }
    throw cloudAuthErrorFromUnknown(error);
  }
}
