import { z } from "zod";
import type { OrganizationAction } from "../authorization/policy";

export class FleetError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export const idSchema = z.string().uuid();
const revision = z.number().int().positive();
const label = z.string().trim().min(1).max(100);
export const secretKindSchema = z.enum(["ssh_private_key", "oidc_client_secret"]);
export type SecretKind = z.infer<typeof secretKindSchema>;
export const issuerSchema = z.string().trim().url().max(2048).refine(value => {
  const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
});
export const oidcBindingSchema = z.object({ issuer: issuerSchema, clientId: z.string().trim().min(1).max(200) }).strict();
export type OidcBinding = z.infer<typeof oidcBindingSchema>;
export type FleetActor = { userId: string; organizationId: string; mode: string; role: string; sessionId?: string };
export function assertFleetActor(actor: FleetActor, organizationId: string) {
  // Identity boundary only. Names (including owner/admin) never confer power.
  // Each consumer MUST obtain a current policy decision in its transaction.
  if (actor.mode !== "oidc" || actor.organizationId !== organizationId || !idSchema.safeParse(actor.userId).success) {
    throw new FleetError("forbidden", 403);
  }
}
export function parseFleet<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  // Do not return Zod input or error values; credential schemas contain secrets.
  if (!result.success) throw new FleetError("invalid_request");
  return result.data;
}

export const credentialWriteSchema = z.object({
  operationId: idSchema, id: idSchema, label, kind: secretKindSchema,
  expectedRevision: z.number().int().min(0), value: z.string().min(1).max(32_768),
  binding: oidcBindingSchema.nullable().default(null),
}).strict().refine(value => value.kind === "oidc_client_secret" ? value.binding !== null : value.binding === null);
export const revisionActionSchema = z.object({ operationId: idSchema, id: idSchema, expectedRevision: revision }).strict();
export const installationWriteSchema = z.object({
  operationId: idSchema, id: idSchema, expectedRevision: z.number().int().min(0), label,
  hostname: z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(32).regex(/^[a-z_][a-z0-9_-]*$/).refine(v => v !== "root"),
  hostFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/), credentialId: idSchema,
}).strict();

export type Credential = {
  id: string; label: string; kind: SecretKind; revision: number; secretVersion: number;
  binding: OidcBinding | null;
  status: "active" | "revoked"; createdAt: string; updatedAt: string;
};
export type Installation = {
  id: string; label: string; hostname: string; port: number; username: string;
  hostFingerprint: string; credentialId: string; revision: number;
  status: "draft" | "tested" | "active" | "failed";
  testedCredentialRevision: number | null; testedAt: string | null;
  cliVersion: string | null; failureCode: string | null; createdAt: string; updatedAt: string;
};
export type SafeResult = Credential | Installation;
export type ProbeResult = { ok: true; cliVersion: string } | { ok: false; code: string };
export type FleetState = { credentials: Credential[]; installations: Installation[] };
export type MutationReceipt = { inputHash: string; result: SafeResult };

export interface FleetTransaction {
  reservation(operationId: string): Promise<import("./io-reservation").IoReservation | null>;
  putReservation(operationId: string, value: import("./io-reservation").IoReservation): Promise<void>;
  /** Replaces an expired, unfinished lease; false when another caller already took it. */
  renewReservation(operationId: string, previousLeaseId: string, value: import("./io-reservation").IoReservation): Promise<boolean>;
  finishReservation(operationId: string): Promise<void>;
  credential(id: string): Promise<Credential | null>;
  credentials(): Promise<Credential[]>;
  putCredential(value: Credential): Promise<void>;
  installation(id: string): Promise<Installation | null>;
  installations(): Promise<Installation[]>;
  putInstallation(value: Installation): Promise<void>;
  credentialInActiveSso(id: string): Promise<boolean>;
  receipt(operationId: string): Promise<MutationReceipt | null>;
  putReceipt(operationId: string, value: MutationReceipt): Promise<void>;
  audit(action: string, targetId: string, metadata: Record<string, string | number | boolean | null>): Promise<void>;
}
export interface FleetStore {
  // Implementations revalidate current policy/membership and lock through effects.
  transaction<T>(actor: FleetActor, actions: readonly OrganizationAction[], run: (tx: FleetTransaction) => Promise<T>, requestId?: string): Promise<T>;
}
export interface SecretVault {
  put(reference: { organizationId: string; credentialId: string; version: number }, value: string, operationHash: string, legacyOperationHash?: string): Promise<void>;
  read(reference: { organizationId: string; credentialId: string; version: number }): Promise<string>;
}
