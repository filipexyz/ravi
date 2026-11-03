import { randomUUID } from "node:crypto";

import type {
  RaviActorBindingRecord,
  RaviLinkAuditInput,
  RaviLinkCaller,
  RaviLinkInstallationRecord,
  RaviLinkMembershipRecord,
} from "./ravi-link";
import type {
  RaviLinkApprover,
  RaviLinkRequestCaller,
  RaviLinkRequestRecord,
  RaviLinkRequestRepository,
} from "./ravi-link-requests";

export const ORG_A = "10000000-0000-4000-8000-000000000001";
export const ORG_B = "10000000-0000-4000-8000-000000000002";
export const USER_A = "30000000-0000-4000-8000-000000000001";
export const USER_B = "30000000-0000-4000-8000-000000000002";
export const USER_C = "30000000-0000-4000-8000-000000000003";
export const INSTALLATION_A = "40000000-0000-4000-8000-000000000001";
export const INSTALLATION_B = "40000000-0000-4000-8000-000000000002";
export const CLI_SESSION_A = "50000000-0000-4000-8000-000000000001";
export const CONTACT_ONE = "contact:local:alice";
export const CONTACT_TWO = "contact:local:bob";

export function caller(userId: string, overrides: Partial<RaviLinkCaller> = {}): RaviLinkRequestCaller {
  return {
    cliSessionId: CLI_SESSION_A,
    membershipStatus: "active",
    sessionInstallationId: INSTALLATION_A,
    sessionOrganizationId: ORG_A,
    userId,
    ...overrides,
  };
}

export function approver(userId: string, overrides: Partial<RaviLinkApprover> = {}): RaviLinkApprover {
  return {
    actorType: "user",
    email: null,
    emailVerified: false,
    impersonated: false,
    userId,
    ...overrides,
  };
}

export type InMemoryRaviLinkRepository = RaviLinkRequestRepository & {
  audits: RaviLinkAuditInput[];
  bindings: RaviActorBindingRecord[];
  installations: (RaviLinkInstallationRecord & { name: string })[];
  memberships: RaviLinkMembershipRecord[];
  requests: RaviLinkRequestRecord[];
  seedBinding(values: Partial<RaviActorBindingRecord> & { consoleUserId: string; contactId: string }): RaviActorBindingRecord;
};

/**
 * In-memory stand-in for the Postgres repository, including the two partial
 * unique indexes (one active binding and one pending request per contact).
 * `transaction` rolls state back when the callback throws.
 */
export function inMemoryRaviLinkRepository(): InMemoryRaviLinkRepository {
  const baseNow = new Date("2026-09-16T14:00:00.000Z");
  const state = {
    audits: [] as RaviLinkAuditInput[],
    bindings: [] as RaviActorBindingRecord[],
    requests: [] as RaviLinkRequestRecord[],
  };
  const installations: (RaviLinkInstallationRecord & { name: string })[] = [
    { id: INSTALLATION_A, organizationId: ORG_A, status: "active", name: "luis-mac" },
    { id: INSTALLATION_B, organizationId: ORG_B, status: "active", name: "other-mac" },
  ];
  const memberships: RaviLinkMembershipRecord[] = [
    { organizationId: ORG_A, status: "active", userId: USER_A },
    { organizationId: ORG_A, status: "active", userId: USER_B },
  ];

  const uniqueViolation = () => {
    const error = new Error("duplicate");
    (error as { code?: string }).code = "23505";
    return error;
  };

  const repository: InMemoryRaviLinkRepository = {
    get audits() {
      return state.audits;
    },
    get bindings() {
      return state.bindings;
    },
    get requests() {
      return state.requests;
    },
    installations,
    memberships,
    async lockIssuance() {},
    async assertCurrentCaller() {},
    async assertCurrentApprover() {},

    seedBinding(values) {
      const row: RaviActorBindingRecord = {
        id: values.id ?? randomUUID(),
        installationId: values.installationId ?? INSTALLATION_A,
        organizationId: values.organizationId ?? ORG_A,
        consoleUserId: values.consoleUserId,
        contactId: values.contactId,
        platformIdentitiesJson: values.platformIdentitiesJson ?? {},
        status: values.status ?? "active",
        linkedBy: values.linkedBy ?? values.consoleUserId,
        linkedAt: values.linkedAt ?? baseNow,
        revokedAt: values.revokedAt ?? null,
        createdAt: values.createdAt ?? baseNow,
        updatedAt: values.updatedAt ?? baseNow,
      };
      state.bindings.push(row);
      return row;
    },

    async transaction(fn) {
      const snapshot = {
        audits: [...state.audits],
        bindings: state.bindings.map((row) => ({ ...row })),
        requests: state.requests.map((row) => ({ ...row })),
      };
      try {
        return await fn(repository);
      } catch (error) {
        state.audits = snapshot.audits;
        state.bindings = snapshot.bindings;
        state.requests = snapshot.requests;
        throw error;
      }
    },

    async findInstallation(installationId) {
      const row = installations.find((entry) => entry.id === installationId);
      return row ? { id: row.id, organizationId: row.organizationId, status: row.status } : null;
    },

    async findInstallationDetails(installationId) {
      const row = installations.find((entry) => entry.id === installationId);
      return row
        ? {
            id: row.id,
            name: row.name,
            organizationId: row.organizationId,
            organizationName: row.organizationId === ORG_A ? "Org A" : "Org B",
            status: row.status,
          }
        : null;
    },

    async findActiveMembership(organizationId, userId) {
      return (
        memberships.find(
          (row) => row.organizationId === organizationId && row.userId === userId && row.status === "active",
        ) ?? null
      );
    },

    async findActiveBindingByContact(installationId, contactId) {
      return (
        state.bindings.find(
          (row) => row.installationId === installationId && row.contactId === contactId && row.status === "active",
        ) ?? null
      );
    },

    async findLatestBindingForUserContact(installationId, contactId, consoleUserId) {
      return (
        state.bindings
          .filter(
            (row) =>
              row.installationId === installationId &&
              row.contactId === contactId &&
              row.consoleUserId === consoleUserId,
          )
          .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0] ?? null
      );
    },

    async findBindingById(bindingId) {
      return state.bindings.find((row) => row.id === bindingId) ?? null;
    },

    async listActiveBindingsByUser(installationId, consoleUserId) {
      return state.bindings
        .filter(
          (row) =>
            row.installationId === installationId && row.consoleUserId === consoleUserId && row.status === "active",
        )
        .sort((left, right) => right.linkedAt.getTime() - left.linkedAt.getTime());
    },

    async listActiveBindingsForConsoleUser(consoleUserId) {
      return state.bindings
        .filter((row) => row.consoleUserId === consoleUserId && row.status === "active")
        .map((row) => ({
          id: row.id,
          channel: null,
          installationName: installations.find((entry) => entry.id === row.installationId)?.name ?? "",
          linkedAt: row.linkedAt.toISOString(),
          organizationName: row.organizationId === ORG_A ? "Org A" : "Org B",
        }));
    },

    async insertBinding(values) {
      if (
        values.status === "active" &&
        state.bindings.some(
          (row) =>
            row.installationId === values.installationId &&
            row.contactId === values.contactId &&
            row.status === "active",
        )
      ) {
        throw uniqueViolation();
      }
      return repository.seedBinding({
        ...values,
        id: values.id ?? randomUUID(),
        consoleUserId: values.consoleUserId,
        contactId: values.contactId,
      });
    },

    async updateBinding(bindingId, values) {
      const index = state.bindings.findIndex((row) => row.id === bindingId);
      const current = state.bindings[index];
      if (index < 0 || !current) throw new Error("missing binding");
      const next = { ...current, ...values };
      state.bindings[index] = next;
      return next;
    },

    async insertAudit(input) {
      state.audits.push(input);
    },

    async findRequestByTokenHash(tokenHash) {
      return state.requests.find((row) => row.tokenHash === tokenHash) ?? null;
    },

    async findRequestById(requestId) {
      return state.requests.find((row) => row.id === requestId) ?? null;
    },

    async findPendingRequestForContact(installationId, contactId) {
      return (
        state.requests.find(
          (row) => row.installationId === installationId && row.contactId === contactId && row.status === "pending",
        ) ?? null
      );
    },

    async countRequestsSince(installationId, contactId, since) {
      return state.requests.filter(
        (row) =>
          row.installationId === installationId &&
          row.contactId === contactId &&
          row.createdAt.getTime() >= since.getTime(),
      ).length;
    },

    async insertRequest(values) {
      if (
        (values.status ?? "pending") === "pending" &&
        state.requests.some(
          (row) =>
            row.installationId === values.installationId &&
            row.contactId === values.contactId &&
            row.status === "pending",
        )
      ) {
        throw uniqueViolation();
      }
      if (state.requests.some((row) => row.tokenHash === values.tokenHash)) throw uniqueViolation();
      const createdAt = values.createdAt ?? baseNow;
      const row: RaviLinkRequestRecord = {
        id: values.id ?? randomUUID(),
        tokenHash: values.tokenHash,
        installationId: values.installationId,
        organizationId: values.organizationId,
        requestedByUserId: values.requestedByUserId ?? null,
        cliSessionId: values.cliSessionId ?? null,
        contactId: values.contactId,
        platformIdentitiesJson: values.platformIdentitiesJson ?? {},
        requesterDisplayName: values.requesterDisplayName ?? null,
        expectedEmailHash: values.expectedEmailHash ?? null,
        status: values.status ?? "pending",
        expiresAt: values.expiresAt,
        approvedByUserId: values.approvedByUserId ?? null,
        approvedAt: values.approvedAt ?? null,
        deniedAt: values.deniedAt ?? null,
        cancelledAt: values.cancelledAt ?? null,
        bindingId: values.bindingId ?? null,
        failureReason: values.failureReason ?? null,
        createdAt,
        updatedAt: values.updatedAt ?? createdAt,
      };
      state.requests.push(row);
      return row;
    },

    async updateRequest(requestId, whenStatus, values) {
      const index = state.requests.findIndex((row) => row.id === requestId && row.status === whenStatus);
      const current = state.requests[index];
      if (index < 0 || !current) return null;
      const next = { ...current, ...values };
      state.requests[index] = next;
      return next;
    },
  };
  return repository;
}
