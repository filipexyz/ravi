import { z } from "zod";
import { idSchema, issuerSchema } from "./contract";

export const admissionGroupsSchema = z.array(z.string().trim().min(1).max(200)).max(30)
  .refine(groups => new Set(groups).size === groups.length);
export type AdmissionGroups = z.infer<typeof admissionGroupsSchema>;
export function admissionGroupsAllow(required: AdmissionGroups, groups: string[]) {
  return required.length === 0 || required.some(group => groups.includes(group));
}
export const ssoConfigSchema = z.object({ label: z.string().trim().min(1).max(100),
  allowPrivateNetwork: z.boolean(), admissionGroups: admissionGroupsSchema }).strict();
export const ssoWriteSchema = z.object({
  operationId: idSchema, id: idSchema, expectedRevision: z.number().int().min(0),
  label: z.string().trim().min(1).max(100), issuer: issuerSchema,
  clientId: z.string().trim().min(1).max(200), credentialId: idSchema,
  allowPrivateNetwork: z.boolean(), admissionGroups: admissionGroupsSchema,
}).strict();
export const ssoActivateSchema = z.object({ operationId: idSchema, id: idSchema,
  expectedRevision: z.number().int().positive(), acknowledgeIdentityChange: z.literal(true) }).strict();
export type SsoConnection = {
  id: string; label: string; revision: number; status: "draft" | "tested" | "active" | "retired";
  issuer: string; clientId: string; credentialId: string; credentialVersion: number;
  allowPrivateNetwork: boolean; admissionGroups: AdmissionGroups; testedAt: string | null;
  testedBy: string | null; updatedAt: string;
};
export type SsoState = { connections: SsoConnection[]; source: "bootstrap" | "database" };
