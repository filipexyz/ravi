// GENERATED FILE — DO NOT EDIT.
// Run `bun run console:sdk` to regenerate.
// Drift is detected by `bun run console:sdk:check` (CI).

import type { Transport } from "./transport/types.js";
import type { AssociationsApproveReturn, AssociationsShowReturn, ChannelsListReturn, InstallationsListReturn, InstallationsRevokeReturn, OnboardingFinishReturn, OnboardingStateReturn, OperationsEnqueueReturn, OperationsLatestReturn, OperationsShowReturn } from "./types.js";

/**
 * `RaviClient` exposes every registry command as a typed method.
 *
 * The class is generated 1:1 from `getRegistry()`. Every method calls into
 * the supplied `Transport`, which is responsible for validation, scope
 * enforcement, and audit (see `transport/http.ts` and
 * `transport/in-process.ts`).
 */
export class RaviClient {
  constructor(private readonly transport: Transport) {}

  readonly associations = {
    /** associations approve */
    approve: async (input: {
  associationId: string;
  challenge: string;
  fingerprint: string;
  name: string;
  operationId: string;
}): Promise<AssociationsApproveReturn> => {
      return this.transport.call({
        groupSegments: ["associations"],
        command: "approve",
        body: { input },
      });
    },
    /** associations show */
    show: async (input: {
  associationId: string;
  challenge: string;
}): Promise<AssociationsShowReturn> => {
      return this.transport.call({
        groupSegments: ["associations"],
        command: "show",
        body: { input },
      });
    }
  };

  readonly channels = {
    /** channels list */
    list: async (input: Record<string, never>): Promise<ChannelsListReturn> => {
      return this.transport.call({
        groupSegments: ["channels"],
        command: "list",
        body: { input },
      });
    }
  };

  readonly installations = {
    /** installations list */
    list: async (input: Record<string, never>): Promise<InstallationsListReturn> => {
      return this.transport.call({
        groupSegments: ["installations"],
        command: "list",
        body: { input },
      });
    },
    /** installations revoke */
    revoke: async (input: {
  expectedRevision: number;
  installationId: string;
  operationId: string;
}): Promise<InstallationsRevokeReturn> => {
      return this.transport.call({
        groupSegments: ["installations"],
        command: "revoke",
        body: { input },
      });
    }
  };

  readonly onboarding = {
    /** onboarding finish */
    finish: async (input: {
  operationId: string;
  snapshot: string;
}): Promise<OnboardingFinishReturn> => {
      return this.transport.call({
        groupSegments: ["onboarding"],
        command: "finish",
        body: { input },
      });
    },
    /** onboarding state */
    state: async (input: Record<string, never>): Promise<OnboardingStateReturn> => {
      return this.transport.call({
        groupSegments: ["onboarding"],
        command: "state",
        body: { input },
      });
    }
  };

  readonly operations = {
    /** operations enqueue */
    enqueue: async (input: {
  command: ({
    kind: "health";
  }) | ({
    kind: "channels.inspect";
  }) | ({
    credentialConnection: string;
    enabled: boolean;
    identity: {
      botUserId: string;
      teamId: string;
    };
    kind: "channel.configure";
    name: string;
    provider: "slack";
  });
  installationId: string;
  operationId: string;
}): Promise<OperationsEnqueueReturn> => {
      return this.transport.call({
        groupSegments: ["operations"],
        command: "enqueue",
        body: { input },
      });
    },
    /** operations latest */
    latest: async (input: {
  installationId: string;
}): Promise<OperationsLatestReturn> => {
      return this.transport.call({
        groupSegments: ["operations"],
        command: "latest",
        body: { input },
      });
    },
    /** operations show */
    show: async (input: {
  operationId: string;
}): Promise<OperationsShowReturn> => {
      return this.transport.call({
        groupSegments: ["operations"],
        command: "show",
        body: { input },
      });
    }
  };
}
