import { z } from "zod";

const manifestSchema = z.object({
  issuer: z.string().url(),
  organization: z.object({ id: z.string().uuid(), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), name: z.string().trim().min(1) }),
  users: z.array(z.object({
    id: z.string().uuid(), subject: z.string().min(1), email: z.string().email().transform((value) => value.toLowerCase()),
    name: z.string().trim().min(1), role: z.enum(["owner", "admin", "developer", "viewer", "billing"]),
  })).min(1),
}).strict();

export function parseOidcBootstrap(value: unknown, expected: { issuer: string; organizationId: string }) {
  const manifest = manifestSchema.parse(value);
  if (manifest.issuer !== expected.issuer || manifest.organization.id !== expected.organizationId) {
    throw new Error("Bootstrap does not match installation issuer/organization.");
  }
  for (const key of ["id", "subject", "email"] as const) {
    if (new Set(manifest.users.map((user) => user[key])).size !== manifest.users.length) {
      throw new Error(`Duplicate bootstrap ${key}.`);
    }
  }
  if (!manifest.users.some((user) => user.role === "owner")) throw new Error("Bootstrap must explicitly provision an owner.");
  return manifest;
}
