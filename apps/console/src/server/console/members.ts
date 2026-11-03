import { z } from "zod";
import { ConsoleApiError } from "./api-error";
import type { ConsoleWorkspace } from "./workspace";

/** Retired entrypoints are deliberately not aliases: their role/body contracts
 * can provision users or grant nominal authority. Use Fleet admission + policies. */
export async function upsertConsoleOrganizationMember(_input: { body: unknown; requestId: string; workspace: ConsoleWorkspace }): Promise<never> {
  throw new ConsoleApiError(403, { error: "legacy_membership_unsupported" });
}
export async function removeConsoleOrganizationMember(_input: { body: unknown; requestId: string; workspace: ConsoleWorkspace }): Promise<never> {
  throw new ConsoleApiError(403, { error: "legacy_membership_unsupported" });
}

// Historical input parsing tests remain useful, but neither parser can mutate.
const legacyUpsert = z.object({ email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(["owner", "admin", "developer", "viewer", "billing"]).default("developer") });
const legacyRemove = z.object({ userRef: z.string().trim().min(1).max(320) });
export function parseConsoleMemberUpsertInput(body: unknown) {
  const result = legacyUpsert.safeParse(body);
  if (!result.success) throw new ConsoleApiError(400, { error: "validation_failed" });
  return result.data;
}
export function parseConsoleMemberRemoveInput(body: unknown) {
  const result = legacyRemove.safeParse(body);
  if (!result.success) throw new ConsoleApiError(400, { error: "validation_failed" });
  return result.data;
}
