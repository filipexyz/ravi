import { describe, expect, test } from "bun:test";

import {
  CLI_ACTOR_CONTACT_HEADER,
  lesserRole,
  resolveCliActor,
  type CliActorBinding,
  type CliActorDeps,
  type CliActorMember,
} from "./actor";
import type { CliAuthRecords } from "./state";

const now = new Date("2026-10-18T12:00:00.000Z");

function records(role = "owner"): CliAuthRecords {
  return {
    user: { id: "user-owner", primaryEmail: "owner@ravi.bot", displayName: "Owner", avatarUrl: null, status: "active" },
    organization: { id: "org-1", slug: "ravi", name: "Ravi", status: "active" },
    membership: { id: "membership-owner", role, status: "active" },
    localInstallation: {
      id: "installation-1",
      name: "Mac",
      hostname: null,
      platform: null,
      raviVersion: null,
      status: "active",
      lastSeenAt: now,
    },
    cliSession: { id: "session-1", status: "active", expiresAt: now, lastUsedAt: null },
    scopes: ["console.projects.link"],
  };
}

const ana: CliActorMember = {
  user: { id: "user-ana", primaryEmail: "ana@ravi.bot", displayName: "Ana", avatarUrl: null, status: "active" },
  membership: { id: "membership-ana", role: "developer", status: "active" },
};

function request(method: string, contact?: string): Request {
  const headers = new Headers();
  if (contact !== undefined) headers.set(CLI_ACTOR_CONTACT_HEADER, contact);
  return new Request("https://console.ravi.bot/api/cli/artifacts/publish", { method, headers });
}

function deps(options: { binding?: CliActorBinding | null; member?: CliActorMember | null } = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const lookups: Array<Record<string, unknown>> = [];
  const value: CliActorDeps = {
    findBinding: async (input) => {
      lookups.push(input);
      return options.binding === undefined
        ? { id: "binding-ana", consoleUserId: "user-ana", linkedBy: "user-ana" }
        : options.binding;
    },
    findMember: async () => (options.member === undefined ? ana : options.member),
    audit: async (values) => {
      audits.push(values as Record<string, unknown>);
    },
  };
  return { value, audits, lookups };
}

describe("resolveCliActor", () => {
  test("without the header the session user acts and nothing is looked up", async () => {
    const d = deps();
    const result = await resolveCliActor(records(), request("POST"), "req-1", d.value);
    expect(result.user.id).toBe("user-owner");
    expect(result.delegation).toBeNull();
    expect(d.lookups).toHaveLength(0);
    expect(d.audits).toHaveLength(0);
  });

  test("a linked member becomes the actor, with the executor kept and both recorded", async () => {
    const d = deps();
    const result = await resolveCliActor(records("owner"), request("POST", " c_ana "), "req-1", d.value);
    expect(result.user.id).toBe("user-ana");
    expect(result.membership).toEqual({ id: "membership-ana", role: "developer", status: "active" });
    expect(result.delegation).toEqual({
      contactId: "c_ana",
      bindingId: "binding-ana",
      executor: { user: records().user, membership: records().membership },
    });
    expect(result.localInstallation.id).toBe("installation-1");
    expect(result.scopes).toEqual(["console.projects.link"]);
    expect(d.lookups).toEqual([{ installationId: "installation-1", organizationId: "org-1", contactId: "c_ana" }]);
    expect(d.audits).toHaveLength(1);
    expect(d.audits[0]).toMatchObject({
      action: "cli.actor.delegated",
      actorType: "agent",
      actorId: "user-owner",
      targetType: "user",
      targetId: "user-ana",
      requestId: "req-1",
      metadataJson: {
        executorUserId: "user-owner",
        actorUserId: "user-ana",
        role: "developer",
        contactId: "c_ana",
        bindingId: "binding-ana",
        method: "POST",
        path: "/api/cli/artifacts/publish",
        localInstallationId: "installation-1",
      },
    });
  });

  test("the acting role never exceeds the executor's", async () => {
    const d = deps({ member: { ...ana, membership: { ...ana.membership, role: "owner" } } });
    const result = await resolveCliActor(records("viewer"), request("POST", "c_ana"), "req-1", d.value);
    expect(result.user.id).toBe("user-ana");
    expect(result.membership.role).toBe("viewer");
  });

  test("reads delegate without writing audit", async () => {
    const d = deps();
    const result = await resolveCliActor(records(), request("GET", "c_ana"), "req-1", d.value);
    expect(result.user.id).toBe("user-ana");
    expect(d.audits).toHaveLength(0);
  });

  test("no binding: the write is refused with ACTOR_NOT_LINKED and the denial is recorded", async () => {
    const d = deps({ binding: null });
    const error = await refusal(resolveCliActor(records(), request("POST", "c_bob"), "req-1", d.value));
    expect(error).toMatchObject({ status: 403, code: "ACTOR_NOT_LINKED", details: { reason: "not_linked" } });
    expect(d.audits).toHaveLength(1);
    expect(d.audits[0]).toMatchObject({
      action: "cli.actor.denied",
      actorType: "agent",
      actorId: "user-owner",
      metadataJson: { reason: "not_linked", contactId: "c_bob" },
    });
  });

  test("no binding: a read refuses the named human and audits instead of becoming executor", async () => {
    const d = deps({ binding: null });
    await expect(resolveCliActor(records(), request("GET", "c_bob"), "req-1", d.value)).rejects.toMatchObject({ status: 403, code: "ACTOR_NOT_LINKED" });
    expect(d.audits).toHaveLength(1);
    expect(d.audits[0]).toMatchObject({ action: "cli.actor.denied" });
  });

  test("access: read cannot restore the executor fallback even with the legacy option", async () => {
    const d = deps({ binding: null });
    await expect(resolveCliActor(records(), request("POST", "c_bob"), "req-1", d.value, { access: "read", unlinkedReads: "executor" })).rejects.toMatchObject({ status: 403, code: "ACTOR_NOT_LINKED" });
    expect(d.audits).toHaveLength(1);
  });

  test("access: read still delegates a linked person, without writing audit", async () => {
    const d = deps();
    const result = await resolveCliActor(records(), request("POST", "c_ana"), "req-1", d.value, { access: "read" });
    expect(result.user.id).toBe("user-ana");
    expect(result.delegation).toMatchObject({ contactId: "c_ana" });
    expect(d.audits).toHaveLength(0);
  });

  test("access: write refuses an unlinked person even on GET", async () => {
    const d = deps({ binding: null });
    const error = await refusal(resolveCliActor(records(), request("GET", "c_bob"), "req-1", d.value, { access: "write" }));
    expect(error).toMatchObject({ status: 403, code: "ACTOR_NOT_LINKED" });
    expect(d.audits).toHaveLength(1);
  });

  test("unlinkedReads: refuse refuses an unlinked person's read like a write, with the denial recorded", async () => {
    for (const access of [undefined, "read"] as const) {
      const d = deps({ binding: null });
      const method = access ? "POST" : "GET";
      const error = await refusal(
        resolveCliActor(records(), request(method, "c_bob"), "req-1", d.value, { access, unlinkedReads: "refuse" }),
      );
      expect(error).toMatchObject({ status: 403, code: "ACTOR_NOT_LINKED", details: { reason: "not_linked" } });
      expect(d.audits).toHaveLength(1);
      expect(d.audits[0]).toMatchObject({ action: "cli.actor.denied", metadataJson: { reason: "not_linked", method } });
    }
  });

  test("unlinkedReads: refuse refuses every unusable person on reads", async () => {
    const cases: Array<{ contact: string; deps: ReturnType<typeof deps>; status: number; code: string; reason: string }> = [
      { contact: "c ana; drop", deps: deps(), status: 400, code: "PAYLOAD_INVALID", reason: "invalid_contact" },
      {
        contact: "c_ana",
        deps: deps({ binding: { id: "binding-old", consoleUserId: "user-ana", linkedBy: "user-owner" } }),
        status: 403,
        code: "ACTOR_NOT_LINKED",
        reason: "not_approved_by_person",
      },
      { contact: "c_ana", deps: deps({ member: null }), status: 403, code: "PROJECT_ACCESS_DENIED", reason: "not_member" },
    ];
    for (const item of cases) {
      const error = await refusal(
        resolveCliActor(records(), request("GET", item.contact), "req-1", item.deps.value, { unlinkedReads: "refuse" }),
      );
      expect(error).toMatchObject({ status: item.status, code: item.code, details: { reason: item.reason } });
      expect(item.deps.audits[0]).toMatchObject({ action: "cli.actor.denied", metadataJson: { reason: item.reason } });
    }
  });

  test("unlinkedReads: refuse keeps a linked member reading as themselves, and the owner's turn unchanged", async () => {
    const linked = deps();
    const asAna = await resolveCliActor(records(), request("GET", "c_ana"), "req-1", linked.value, { unlinkedReads: "refuse" });
    expect(asAna.user.id).toBe("user-ana");
    expect(linked.audits).toHaveLength(0);

    const none = deps({ binding: null });
    const own = await resolveCliActor(records(), request("GET"), "req-1", none.value, { unlinkedReads: "refuse" });
    expect(own.user.id).toBe("user-owner");
    expect(none.lookups).toHaveLength(0);

    const owner = deps({ binding: { id: "binding-owner", consoleUserId: "user-owner", linkedBy: "user-owner" } });
    const ownContact = await resolveCliActor(records(), request("GET", "c_owner"), "req-1", owner.value, {
      unlinkedReads: "refuse",
    });
    expect(ownContact.user.id).toBe("user-owner");
    expect(ownContact.delegation).toMatchObject({ bindingId: "binding-owner", contactId: "c_owner" });
    expect(owner.audits).toHaveLength(0);
  });

  test("a binding the person did not approve refuses the write", async () => {
    const d = deps({ binding: { id: "binding-old", consoleUserId: "user-ana", linkedBy: "user-owner" } });
    const error = await refusal(resolveCliActor(records(), request("POST", "c_ana"), "req-1", d.value));
    expect(error).toMatchObject({ status: 403, code: "ACTOR_NOT_LINKED" });
    expect(d.audits[0]).toMatchObject({ metadataJson: { reason: "not_approved_by_person" } });
  });

  test("a person who is not an active member of the organization is refused", async () => {
    const d = deps({ member: null });
    const error = await refusal(resolveCliActor(records(), request("PATCH", "c_ana"), "req-1", d.value));
    expect(error).toMatchObject({ status: 403, code: "PROJECT_ACCESS_DENIED", details: { reason: "not_member" } });
    expect(error).toMatchObject({ message: expect.stringContaining("will not act on their behalf") });
    expect(d.audits[0]).toMatchObject({ metadataJson: { reason: "not_member" } });
  });

  test("the owner's own contact retains its binding for authoritative revocation", async () => {
    const d = deps({ binding: { id: "binding-owner", consoleUserId: "user-owner", linkedBy: "user-owner" } });
    const result = await resolveCliActor(records(), request("POST", "c_owner"), "req-1", d.value);
    expect(result.user.id).toBe("user-owner");
    expect(result.delegation).toMatchObject({ bindingId: "binding-owner", contactId: "c_owner" });
    expect(d.audits).toHaveLength(1);
  });

  test("a malformed contact refuses the write without a lookup", async () => {
    const d = deps();
    const error = await refusal(resolveCliActor(records(), request("POST", "c ana; drop"), "req-1", d.value));
    expect(error).toMatchObject({ status: 400, code: "PAYLOAD_INVALID" });
    expect(d.lookups).toHaveLength(0);
    expect(d.audits[0]).toMatchObject({ metadataJson: { reason: "invalid_contact" } });
  });
});

describe("lesserRole", () => {
  test("orders owner > admin > developer > viewer > billing and fails closed on unknown roles", () => {
    expect(lesserRole("owner", "developer")).toBe("developer");
    expect(lesserRole("viewer", "admin")).toBe("viewer");
    expect(lesserRole("developer", "billing")).toBe("billing");
    expect(lesserRole("owner", "member")).toBe("member");
  });
});

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to be refused");
}
