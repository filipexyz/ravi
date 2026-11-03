// GENERATED FILE — DO NOT EDIT.
// Run `bun run console:sdk` to regenerate.
// Drift is detected by `bun run console:sdk:check` (CI).

/** Input shape for `associations.approve`. */
export type AssociationsApproveInput = {
  input: {
    associationId: string;
    challenge: string;
    fingerprint: string;
    name: string;
    operationId: string;
  };
};

/** Return shape for `associations.approve`. */
export type AssociationsApproveReturn = {
  id: string;
  lastSeenAt: string | null;
  name: string;
  platform: string | null;
  revision: number;
  status: "pending" | "online" | "offline" | "revoked";
};

/** Input shape for `associations.show`. */
export type AssociationsShowInput = {
  input: {
    associationId: string;
    challenge: string;
  };
};

/** Return shape for `associations.show`. */
export type AssociationsShowReturn = {
  expiresAt: string;
  fingerprint: string;
  id: string;
  installationId: string | null;
  name: string;
  platform: string;
  status: "pending" | "approved" | "expired" | "denied";
};

/** Input shape for `channels.list`. */
export type ChannelsListInput = {
  input: Record<string, never>;
};

/** Return shape for `channels.list`. */
export type ChannelsListReturn = {
  channels: Array<{
    credentialConnection: string;
    enabled: boolean;
    id: string;
    identity: {
      botUserId: string;
      teamId: string;
    };
    installationId: string;
    name: string;
    operationId: string;
    status: "queued" | "delivered" | "succeeded" | "failed" | "uncertain" | "cancelled";
  }>;
};

/** Input shape for `installations.list`. */
export type InstallationsListInput = {
  input: Record<string, never>;
};

/** Return shape for `installations.list`. */
export type InstallationsListReturn = {
  installations: Array<{
    id: string;
    lastSeenAt: string | null;
    name: string;
    platform: string | null;
    revision: number;
    status: "pending" | "online" | "offline" | "revoked";
  }>;
};

/** Input shape for `installations.revoke`. */
export type InstallationsRevokeInput = {
  input: {
    expectedRevision: number;
    installationId: string;
    operationId: string;
  };
};

/** Return shape for `installations.revoke`. */
export type InstallationsRevokeReturn = {
  id: string;
  lastSeenAt: string | null;
  name: string;
  platform: string | null;
  revision: number;
  status: "pending" | "online" | "offline" | "revoked";
};

/** Input shape for `onboarding.finish`. */
export type OnboardingFinishInput = {
  input: {
    operationId: string;
    snapshot: string;
  };
};

/** Return shape for `onboarding.finish`. */
export type OnboardingFinishReturn = {
  completed: boolean;
  installations: Array<{
    id: string;
    lastSeenAt: string | null;
    name: string;
    platform: string | null;
    revision: number;
    status: "pending" | "online" | "offline" | "revoked";
  }>;
  ready: boolean;
  snapshot: string;
};

/** Input shape for `onboarding.state`. */
export type OnboardingStateInput = {
  input: Record<string, never>;
};

/** Return shape for `onboarding.state`. */
export type OnboardingStateReturn = {
  completed: boolean;
  installations: Array<{
    id: string;
    lastSeenAt: string | null;
    name: string;
    platform: string | null;
    revision: number;
    status: "pending" | "online" | "offline" | "revoked";
  }>;
  ready: boolean;
  snapshot: string;
};

/** Input shape for `operations.enqueue`. */
export type OperationsEnqueueInput = {
  input: {
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
  };
};

/** Return shape for `operations.enqueue`. */
export type OperationsEnqueueReturn = {
  createdAt: string;
  error: string | null;
  id: string;
  installationId: string;
  result: (({
    health: {
      channels: Array<{
        credentialConnection: string | null;
        enabled: boolean;
        name: string;
        provider: string;
      }>;
      platform: string;
      version: string;
    };
    kind: "health";
  }) | ({
    channels: Array<{
      credentialConnection: string | null;
      enabled: boolean;
      name: string;
      provider: string;
    }>;
    connections: Array<{
      available: boolean;
      connection: string;
      identity: ({
        botUserId: string;
        teamId: string;
      }) | null;
    }>;
    kind: "channels.inspect";
  }) | ({
    channel: {
      credentialConnection: string | null;
      enabled: boolean;
      name: string;
      provider: string;
    };
    kind: "channel.configure";
  })) | null;
  status: "queued" | "delivered" | "succeeded" | "failed" | "uncertain" | "cancelled";
};

/** Input shape for `operations.latest`. */
export type OperationsLatestInput = {
  input: {
    installationId: string;
  };
};

/** Return shape for `operations.latest`. */
export type OperationsLatestReturn = {
  operation: ({
    createdAt: string;
    error: string | null;
    id: string;
    installationId: string;
    result: (({
      health: {
        channels: Array<{
          credentialConnection: string | null;
          enabled: boolean;
          name: string;
          provider: string;
        }>;
        platform: string;
        version: string;
      };
      kind: "health";
    }) | ({
      channels: Array<{
        credentialConnection: string | null;
        enabled: boolean;
        name: string;
        provider: string;
      }>;
      connections: Array<{
        available: boolean;
        connection: string;
        identity: ({
          botUserId: string;
          teamId: string;
        }) | null;
      }>;
      kind: "channels.inspect";
    }) | ({
      channel: {
        credentialConnection: string | null;
        enabled: boolean;
        name: string;
        provider: string;
      };
      kind: "channel.configure";
    })) | null;
    status: "queued" | "delivered" | "succeeded" | "failed" | "uncertain" | "cancelled";
  }) | null;
};

/** Input shape for `operations.show`. */
export type OperationsShowInput = {
  input: {
    operationId: string;
  };
};

/** Return shape for `operations.show`. */
export type OperationsShowReturn = {
  createdAt: string;
  error: string | null;
  id: string;
  installationId: string;
  result: (({
    health: {
      channels: Array<{
        credentialConnection: string | null;
        enabled: boolean;
        name: string;
        provider: string;
      }>;
      platform: string;
      version: string;
    };
    kind: "health";
  }) | ({
    channels: Array<{
      credentialConnection: string | null;
      enabled: boolean;
      name: string;
      provider: string;
    }>;
    connections: Array<{
      available: boolean;
      connection: string;
      identity: ({
        botUserId: string;
        teamId: string;
      }) | null;
    }>;
    kind: "channels.inspect";
  }) | ({
    channel: {
      credentialConnection: string | null;
      enabled: boolean;
      name: string;
      provider: string;
    };
    kind: "channel.configure";
  })) | null;
  status: "queued" | "delivered" | "succeeded" | "failed" | "uncertain" | "cancelled";
};
