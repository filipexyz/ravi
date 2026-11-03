import { createHash, randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import {
  CONSOLE_PROTOCOL,
  CONSOLE_STREAM_PATH,
  consoleRequestMaterial,
  type InvocationOrigin,
} from "@/shared/console-gateway";
import { canonicalBridgeJson } from "@/shared/human-bridge";
import { FleetError, parseFleet, type FleetActor } from "./contract";
import { gatewayAuthority } from "./gateway-authority";
import { gatewayOverSsh, type GatewayHttpCall, type GatewayCommand } from "./gateway-ssh";
import { Kv2Vault, vaultConfig } from "./vault";
import { dbClient } from "@/server/db";
import { gatewayDelivery } from "./gateway-delivery";

export const gatewayRequestSchema = z
  .object({
    installationId: z.string().uuid(),
    projectId: z.string().uuid(),
    operationId: z.string().uuid(),
    createdAt: z.number().int().positive(),
    command: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export type GatewayInput = z.infer<typeof gatewayRequestSchema>;
export function commandDecision(command: GatewayCommand): "read" | "send" | "approve" | "configure" | "team-create" | "installation-read" | "installation-manage" {
  const desktop = {
    "desktop.work.list": {resource:"desktop.work",kind:"read",scope:"session",action:"list"},
    "desktop.session.read": {resource:"desktop.session",kind:"read",scope:"session",action:"read"},
    "desktop.session.configure": {resource:"desktop.session",kind:"mutate",scope:"session",action:"configure"},
    "desktop.computer.read": {resource:"desktop.computer",kind:"read",scope:"session",action:"read"},
    "desktop.loops.list": {resource:"desktop.loops",kind:"read",scope:"installation",action:"list"},
    "desktop.loops.set-enabled": {resource:"desktop.loops",kind:"mutate",scope:"installation",action:"set-enabled"},
    "desktop.channels.list": {resource:"desktop.channels",kind:"read",scope:"installation",action:"list"},
    "desktop.channels.set-enabled": {resource:"desktop.channels",kind:"mutate",scope:"installation",action:"set-enabled"},
  }[command.fullName];
  if (desktop) {
    if (command.access.resource !== desktop.resource || command.access.kind !== desktop.kind || command.access.consoleScope !== desktop.scope || command.access.action !== desktop.action) throw new FleetError("gateway_access_denied",403);
    return ["desktop.session","desktop.work"].includes(desktop.resource) ? (desktop.kind === "read" ? "read" : "configure") : desktop.kind === "read" ? "installation-read" : "installation-manage";
  }
  // This product surface is private conversations. Other catalog entries require
  // an explicit installation/resource policy adapter before they become reachable.
  if (
    command.access.resource === "sessions" &&
    command.access.consoleScope === "session" &&
    command.access.kind === "mutate"
  )
    return "configure";
  if (
    command.access.resource !== "sessions.conversations" ||
    !command.fullName.startsWith("sessions.conversations.")
  )
    throw new FleetError("gateway_access_denied", 403);
  return command.access.action === "team-create" ? "team-create" : command.access.action === "decide" ? "approve" : command.access.kind === "mutate" ? "send" : "read";
}
export async function gatewayRequest(
  actor: FleetActor,
  input: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const value = parseFleet(gatewayRequestSchema, input);
  const path = `/api/v1/${value.command.replaceAll(".", "/")}`;
  const call: GatewayHttpCall = {
    method: "POST",
    path,
    body: JSON.stringify(
      value.command.startsWith("sessions.conversations.")
        ? {
            ...value.input,
            projectId: value.projectId,
            requestId: value.operationId,
            createdAt: value.createdAt,
          }
        : value.input,
    ),
    operationId: value.operationId,
    createdAt: value.createdAt,
  };
  const response = await invoke(actor, value, call, signal);
  if (response.ok) return response;
  const error = await response.json().catch(() => ({}));
  return Response.json(
    {
      error: typeof error.error?.code === "string" ? error.error.code : "gateway_unavailable",
      effectState:
        error.effectState ?? error.error?.effectState ?? (response.status >= 500 ? "unknown" : "none"),
    },
    { status: response.status, headers: { "cache-control": "no-store" } },
  );
}
export async function gatewayStream(
  actor: FleetActor,
  url: URL,
  signal: AbortSignal,
  lastEventId: string | null,
): Promise<Response> {
  const query = parseFleet(
    z.object({
      installationId: z.string().uuid(),
      projectId: z.string().uuid(),
      conversationId: z.string().uuid(),
      cursor: z.string().max(1500).nullable(),
    }),
    {
      installationId: url.searchParams.get("installationId"),
      projectId: url.searchParams.get("projectId"),
      conversationId: url.searchParams.get("conversationId"),
      cursor: lastEventId || url.searchParams.get("cursor"),
    },
  );
  const value: GatewayInput = {
    installationId: query.installationId,
    projectId: query.projectId,
    command: "sessions.conversations.events",
    operationId: randomUUID(),
    createdAt: Date.now(),
    input: { conversationId: query.conversationId },
  };
  const params = new URLSearchParams({
    projectId: query.projectId,
    conversationId: query.conversationId,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  return invoke(
    actor,
    value,
    {
      method: "GET",
      path: `${CONSOLE_STREAM_PATH}?${params}`,
      body: "",
      operationId: value.operationId,
      createdAt: value.createdAt,
    },
    signal,
  );
}
async function invoke(actor: FleetActor, value: GatewayInput, call: GatewayHttpCall, signal?: AbortSignal) {
  // Browser is just this HTTP adapter's origin. The runtime contract also accepts
  // separately verified channel and automation principals; no live connector is moved.
  if (!actor.sessionId) throw new FleetError("auth_required", 401);
  const origin: InvocationOrigin = { kind: "browser", sessionId: actor.sessionId };
  const initial = await gatewayAuthority(
    actor,
    value.installationId,
    value.projectId,
    "read",
    value.operationId,
  );
  const vault = new Kv2Vault(vaultConfig());
  const key = await vault.read({
    organizationId: actor.organizationId,
    credentialId: initial.credential.id,
    version: initial.credential.secretVersion,
  });
  let recorded = false;
  const response = await gatewayOverSsh(
    initial.installation,
    key,
    initial.binding,
    call,
    async (proof) => {
      const command = proof.registry.commands.find((c) => c.fullName === value.command);
      if (
        !command ||
        command.scope === "superadmin" ||
        (call.method === "POST" && command.path !== call.path)
      )
        throw new FleetError("gateway_command_unavailable", 403);
      const action = commandDecision(command);
      const team = action === "team-create" ? parseFleet(z.object({agentIds:z.array(z.string()).min(2).max(6),personIds:z.array(z.string().uuid()).max(29)}),value.input) : undefined;
      let live = await gatewayAuthority(
        actor,
        value.installationId,
        value.projectId,
        action,
        value.operationId,
        false,
        team,
      );
      if (
        canonicalBridgeJson(live.binding) !== canonicalBridgeJson(initial.binding) ||
        live.credential.revision !== initial.credential.revision
      )
        throw new FleetError("bridge_enrollment_stale", 409);
      const scope =
        command.access.consoleScope === "session"
          ? {
              kind: "session" as const,
              conversationId: parseFleet(
                z.string().uuid(),
                value.input[command.access.resourceId ?? "conversationId"],
              ),
            }
          : { kind: command.access.consoleScope };
      if (scope.kind === "installation" && !action.startsWith("installation-")) throw new FleetError("gateway_access_denied", 403);
      const signer = await vault.read({
        organizationId: actor.organizationId,
        ...live.binding.signingKeyRef,
      });
      // Vault I/O cannot hold policy locks. Re-read authority immediately before
      // signing; a revoked identity or rotated binding cannot reuse the old read.
      live = await gatewayAuthority(
        actor,
        value.installationId,
        value.projectId,
        action,
        value.operationId,
        true,
        team,
      );
      if (
        canonicalBridgeJson(live.binding) !== canonicalBridgeJson(initial.binding) ||
        live.credential.revision !== initial.credential.revision
      )
        throw new FleetError("bridge_enrollment_stale", 409);
      if (command.access.kind === "mutate") {
        await gatewayDelivery(dbClient, actor, value, origin, "pending");
        recorded = true;
      }
      return new SignJWT({
        protocol: CONSOLE_PROTOCOL,
        orgId: actor.organizationId,
        installationId: value.installationId,
        enrollmentId: live.binding.enrollmentId,
        epoch: live.binding.epoch,
        projectId: value.projectId,
        connectionId: proof.connectionId,
        policyRevision: live.policyRevision,
        policyDigest: live.policyDigest,
        origin,
        operationId: value.operationId,
        createdAt: value.createdAt,
        requestDigest: createHash("sha256")
          .update(
            consoleRequestMaterial(call.method, call.path, call.body, value.operationId, value.createdAt),
          )
          .digest("hex"),
        command: command.fullName,
        access: {
          kind: command.access.kind,
          resource: command.access.resource,
          action: command.access.action,
        },
        scope,
        agents: live.agents,
        canSend: live.canSend,
        canApprove: live.canApprove,
        ...(live.teamParticipants ? {teamParticipants:live.teamParticipants} : {}),
      })
        .setProtectedHeader({ alg: "EdDSA", kid: live.binding.issuerKeyId, typ: "JWT" })
        .setIssuer(live.binding.issuer)
        .setSubject(actor.userId)
        .setAudience(`ravi:${live.binding.runtimeId}:gateway:v1`)
        .setIssuedAt()
        .setExpirationTime("30s")
        .setJti(randomUUID())
        .sign(await importPKCS8(signer, "EdDSA"));
    },
    signal,
  );
  if (recorded) {
    const error = response.ok
      ? null
      : await response
          .clone()
          .json()
          .catch(() => null);
    const unknown =
      response.status >= 500 || error?.effectState === "unknown" || error?.error?.effectState === "unknown";
    await gatewayDelivery(
      dbClient,
      actor,
      value,
      origin,
      response.ok ? "acknowledged" : unknown ? "pending" : "rejected",
    );
  }
  return response;
}
