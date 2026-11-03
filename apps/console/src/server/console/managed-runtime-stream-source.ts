import { ConsoleApiError } from "./api-error";
import {
  assertManagedRaviSessionReadAccess,
  listManagedRaviSessionEvents,
  type ManagedRuntimeCommandsRepository,
} from "./managed-runtime-commands";
import type { ManagedRuntimeContentCodec } from "./managed-runtime-content";
import type { ConsoleWorkspace } from "./workspace";
import type { ProjectAccessWorkspace } from "./project-access";

type StreamWorkspace = ConsoleWorkspace & Pick<ProjectAccessWorkspace, "authorization">;

/** Server-only adapter. resolveWorkspace must re-read the current session and
 * installation availability, not return a cached workspace or client claims. */
export async function createManagedRuntimeStreamSource(input: {
  resolveWorkspace: () => Promise<StreamWorkspace | null>;
  projectRef: string;
  instanceId: string;
  sessionId: string;
  repository?: ManagedRuntimeCommandsRepository;
  codec?: ManagedRuntimeContentCodec;
}) {
  const initial = await input.resolveWorkspace();
  if (!initial) throw new ConsoleApiError(401, { error: "unauthenticated" });
  // This is a browser-only source. CLI delegation needs its own verified source;
  // it must not accidentally be flattened into a human-only workspace here.
  if (initial.authorization) throw new ConsoleApiError(403, { error: "project_forbidden" });
  const pinned = { userId: initial.user.id, organizationId: initial.organization.id, mode: initial.mode };
  const scope = await assertManagedRaviSessionReadAccess({ ...input, workspace: initial });
  const readInput = { instanceId: input.instanceId, sessionId: input.sessionId,
    projectRef: scope.projectId, repository: input.repository };
  const currentWorkspace = async () => {
    const current = await input.resolveWorkspace();
    if (!current) throw new ConsoleApiError(401, { error: "unauthenticated" });
    if (current.user.id !== pinned.userId || current.organization.id !== pinned.organizationId ||
        current.mode !== pinned.mode || current.authorization) {
      throw new ConsoleApiError(403, { error: "project_forbidden" });
    }
    return current;
  };
  return {
    async loadEvents(afterSequence: number) {
      return listManagedRaviSessionEvents({ ...readInput, afterSequence, limit: 100,
        codec: input.codec, workspace: await currentWorkspace() });
    },
    async authorizeEmission() {
      await assertManagedRaviSessionReadAccess({ ...readInput, workspace: await currentWorkspace() });
    },
  };
}
