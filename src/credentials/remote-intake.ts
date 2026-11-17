import { createHash } from "node:crypto";
import { z } from "zod";
import { actorCanGrantRequestedPermission } from "../approval/grantor.js";
import type { IntakeRequest } from "./intake.js";
import { authorizeIntakeSubject } from "./intake-authorization.js";
import { getDestination, type Destination } from "./remote/destinations.js";
import { preflightRemote, remoteRequestStatus, storeRemoteSecret, RemoteCredentialError } from "./remote/ssh.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
/** Only destination metadata and opaque versions; never a secret or secret hash. */
export const remoteIntakeSnapshotSchema = z
  .object({
    destinationVersion: z.string().uuid(),
    bindingHash: hex,
    label: z.string().min(1).max(120),
    sshAlias: z.string().min(1).max(160),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1).max(64),
    envPath: z.string().min(1).max(4096),
    remoteTarget: z.string().min(1).max(160),
    profile: z.literal("dotenv-single-line-v1"),
    expectedVersion: hex,
  })
  .strict();
export type RemoteIntakeSnapshot = z.infer<typeof remoteIntakeSnapshotSchema>;

export interface RemoteIntakeDependencies {
  destination: typeof getDestination;
  preflight: typeof preflightRemote;
  store: typeof storeRemoteSecret;
  status: typeof remoteRequestStatus;
  authorize: (request: IntakeRequest) => boolean;
}

/** The bounded human handoff survives its issuing turn, but not live revocation. */
export function authorizeRemoteIntake(request: IntakeRequest): boolean {
  if (!request.issuerAgentId || !request.actorContactId) return false;
  if (!authorizeIntakeSubject("agent", request.issuerAgentId, "credentials.requests", request.target)) return false;
  const actor = actorCanGrantRequestedPermission({
    channel: "slack",
    accountId: request.accountId,
    instanceId: request.accountId,
    senderId: request.userId,
    permission: "mutate",
    objectType: "credentials.secrets",
    objectId: request.target,
  });
  return (
    actor.allowed &&
    actor.subjectType === "contact" &&
    actor.subjectId === request.actorContactId &&
    authorizeIntakeSubject("contact", request.actorContactId, "credentials.secrets", request.target)
  );
}

const defaults: RemoteIntakeDependencies = {
  destination: getDestination,
  preflight: preflightRemote,
  store: storeRemoteSecret,
  status: remoteRequestStatus,
  authorize: authorizeRemoteIntake,
};

function bindingHash(destination: Destination): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        destination.id,
        destination.version,
        destination.label,
        destination.sshAlias,
        destination.host,
        destination.port,
        destination.user,
        destination.identityFile,
        destination.hostKey,
        destination.envPath,
        destination.remoteTarget,
        destination.keys,
        destination.profile,
      ]),
    )
    .digest("hex");
}

export async function prepareRemoteIntake(
  destinationId: string,
  key: string,
  dependencies: Partial<RemoteIntakeDependencies> = {},
): Promise<RemoteIntakeSnapshot> {
  const deps = { ...defaults, ...dependencies };
  const destination = deps.destination(destinationId);
  if (!destination || !destination.keys.includes(key)) throw new RemoteCredentialError("TARGET_NOT_ALLOWED");
  const preflight = await deps.preflight(destination, key);
  // Registry mutation during remote I/O cannot change what the human confirms.
  const current = deps.destination(destinationId);
  if (!current || bindingHash(current) !== bindingHash(destination))
    throw new RemoteCredentialError("VERSION_CONFLICT");
  return remoteIntakeSnapshotSchema.parse({
    destinationVersion: destination.version,
    bindingHash: bindingHash(destination),
    label: destination.label,
    sshAlias: destination.sshAlias,
    host: destination.host,
    port: destination.port,
    user: destination.user,
    envPath: destination.envPath,
    remoteTarget: destination.remoteTarget,
    profile: destination.profile,
    expectedVersion: preflight.version,
  });
}

function resolveBoundDestination(request: IntakeRequest, deps: RemoteIntakeDependencies): Destination {
  const parts = request.target.split(":");
  const snapshot = request.remote;
  if (parts.length !== 3 || parts[0] !== "remote" || !snapshot) throw new RemoteCredentialError("INVALID_REQUEST");
  const destination = deps.destination(parts[1]!);
  if (
    !destination ||
    !destination.keys.includes(parts[2]!) ||
    destination.version !== snapshot.destinationVersion ||
    bindingHash(destination) !== snapshot.bindingHash
  ) {
    throw new RemoteCredentialError("VERSION_CONFLICT");
  }
  if (!deps.authorize(request)) throw new RemoteCredentialError("TARGET_NOT_ALLOWED");
  return destination;
}

export async function storeRemoteIntake(
  request: IntakeRequest,
  secret: string,
  dependencies: Partial<RemoteIntakeDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies };
  const destination = resolveBoundDestination(request, deps);
  if (request.expiresAt <= Date.now()) throw new RemoteCredentialError("REQUEST_EXPIRED");
  return deps.store(
    destination,
    {
      requestId: request.id,
      key: request.target.split(":")[2]!,
      expectedVersion: request.remote!.expectedVersion,
      expiresAt: request.expiresAt,
      destinationVersion: request.remote!.destinationVersion,
    },
    secret,
    {
      beforeCommit: () => {
        resolveBoundDestination(request, deps);
        if (request.expiresAt <= Date.now()) throw new RemoteCredentialError("REQUEST_EXPIRED");
      },
    },
  );
}

/** Status is authenticated, carries no secret and remains available after TTL. */
export async function inspectRemoteIntake(
  request: IntakeRequest,
  dependencies: Partial<RemoteIntakeDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies };
  const result = await deps.status(resolveBoundDestination(request, deps), request.id);
  resolveBoundDestination(request, deps);
  return result;
}
