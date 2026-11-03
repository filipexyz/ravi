import {
  createBridge,
  revokeBridge,
  rotateBridgeUrl,
  type CreateBridgeResult,
} from "./write";
import { getBridge, listBridges, type McpBridgeDetail, type McpBridgeListItem } from "./read-model";

export type ConsoleMcpActorContext = {
  userId: string;
  organizationId: string;
};

export type ConsoleMcpCreateBridgeInput = {
  projectId: string;
  name: string;
  description?: string | null;
  allowedCapabilityClasses?: string[];
};

export async function listConsoleMcpBridges(
  actor: ConsoleMcpActorContext,
  input: { projectId: string },
): Promise<McpBridgeListItem[]> {
  return listBridges({ organizationId: actor.organizationId, projectId: input.projectId });
}

export async function getConsoleMcpBridge(
  actor: ConsoleMcpActorContext,
  input: { projectId: string; bridgeId: string },
): Promise<McpBridgeDetail | null> {
  return getBridge({
    organizationId: actor.organizationId,
    projectId: input.projectId,
    bridgeId: input.bridgeId,
  });
}

export async function createConsoleMcpBridge(
  actor: ConsoleMcpActorContext,
  input: ConsoleMcpCreateBridgeInput,
): Promise<CreateBridgeResult> {
  return createBridge({
    organizationId: actor.organizationId,
    projectId: input.projectId,
    createdByUserId: actor.userId,
    name: input.name,
    description: input.description,
    allowedCapabilityClasses: input.allowedCapabilityClasses,
  });
}

export async function revokeConsoleMcpBridge(
  actor: ConsoleMcpActorContext,
  input: { bridgeId: string },
) {
  return revokeBridge({
    organizationId: actor.organizationId,
    bridgeId: input.bridgeId,
    userId: actor.userId,
  });
}

export async function rotateConsoleMcpBridgeUrl(
  actor: ConsoleMcpActorContext,
  input: { bridgeId: string; overlapPrevious?: boolean },
) {
  return rotateBridgeUrl({
    organizationId: actor.organizationId,
    bridgeId: input.bridgeId,
    overlapPrevious: input.overlapPrevious,
  });
}
