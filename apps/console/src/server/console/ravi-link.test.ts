import { describe, expect, test } from "bun:test";

import { resolveRaviLink, unlinkRaviLink, upsertRaviLink } from "./ravi-link";
import {
  CONTACT_ONE,
  CONTACT_TWO,
  INSTALLATION_A,
  INSTALLATION_B,
  ORG_A,
  ORG_B,
  USER_A,
  USER_B,
  caller,
  inMemoryRaviLinkRepository,
} from "./ravi-link.test-helpers";

describe("Ravi link actor bindings", () => {
  test("the direct binding POST is closed and audited", async () => {
    const repository = inMemoryRaviLinkRepository();

    await expect(
      upsertRaviLink({ caller: caller(USER_A), repository, requestId: "req_direct_post" }),
    ).rejects.toMatchObject({ code: "LINK_APPROVAL_REQUIRED", status: 410 });

    expect(repository.bindings).toHaveLength(0);
    expect(repository.audits.at(-1)).toMatchObject({
      action: "ravi_link.binding.denied",
      metadata: { reason: "approval_required", installationId: INSTALLATION_A },
    });
  });

  test("the closed POST answers 410 even when the audit write fails", async () => {
    const repository = inMemoryRaviLinkRepository();
    repository.insertAudit = async () => {
      throw new Error("audit store down");
    };

    await expect(
      upsertRaviLink({ caller: caller(USER_A), repository, requestId: "req_direct_post_audit_down" }),
    ).rejects.toMatchObject({ code: "LINK_APPROVAL_REQUIRED", status: 410 });
  });

  test("every call is pinned to the CLI session's installation", async () => {
    const repository = inMemoryRaviLinkRepository();
    repository.seedBinding({ consoleUserId: USER_B, contactId: CONTACT_ONE, installationId: INSTALLATION_B, organizationId: ORG_B });

    await expect(
      resolveRaviLink({
        caller: caller(USER_A),
        query: { contactId: CONTACT_ONE, installationId: INSTALLATION_B },
        repository,
        requestId: "req_resolve_other",
      }),
    ).rejects.toMatchObject({ code: "INSTALLATION_MISMATCH", status: 403 });

    await expect(
      unlinkRaviLink({
        body: { contactId: CONTACT_ONE, installationId: INSTALLATION_B },
        caller: caller(USER_A),
        repository,
        requestId: "req_unlink_other",
      }),
    ).rejects.toMatchObject({ code: "INSTALLATION_MISMATCH", status: 403 });

    expect(repository.bindings[0]?.status).toBe("active");
    expect(repository.audits.every((event) => event.metadata.reason === "installation_mismatch")).toBeTrue();
  });

  test("an unknown session installation is LOCAL_INSTALLATION_MISSING, not PAYLOAD_INVALID", async () => {
    const repository = inMemoryRaviLinkRepository();

    await expect(
      resolveRaviLink({
        caller: caller(USER_A, { sessionInstallationId: "40000000-0000-4000-8000-0000000000ff" }),
        query: { contactId: CONTACT_ONE },
        repository,
        requestId: "req_missing_installation",
      }),
    ).rejects.toMatchObject({ code: "LOCAL_INSTALLATION_MISSING", status: 404 });
    expect(repository.audits.at(-1)?.metadata.reason).toBe("installation_missing");
  });

  test("rejects org mismatch, inactive members and revoked installations", async () => {
    const repository = inMemoryRaviLinkRepository();

    await expect(
      resolveRaviLink({
        caller: caller(USER_A),
        query: { contactId: CONTACT_ONE, organizationId: ORG_B },
        repository,
        requestId: "req_org_mismatch",
      }),
    ).rejects.toMatchObject({ code: "INSTALLATION_ORG_MISMATCH", status: 409 });

    await expect(
      resolveRaviLink({
        caller: caller(USER_A, { membershipStatus: "suspended" }),
        query: { contactId: CONTACT_ONE },
        repository,
        requestId: "req_not_member",
      }),
    ).rejects.toMatchObject({ code: "NOT_MEMBER", status: 403 });

    repository.installations[0]!.status = "revoked";
    await expect(
      resolveRaviLink({
        caller: caller(USER_A),
        query: { contactId: CONTACT_ONE },
        repository,
        requestId: "req_revoked",
      }),
    ).rejects.toMatchObject({ code: "INSTALLATION_REVOKED", status: 403 });
  });

  test("resolve returns the active binding of this installation only", async () => {
    const repository = inMemoryRaviLinkRepository();
    const binding = repository.seedBinding({ consoleUserId: USER_B, contactId: CONTACT_ONE });
    repository.seedBinding({ consoleUserId: USER_B, contactId: CONTACT_TWO, installationId: INSTALLATION_B, organizationId: ORG_B });

    await expect(
      resolveRaviLink({ caller: caller(USER_A), query: {}, repository, requestId: "req_resolve_missing" }),
    ).rejects.toMatchObject({ code: "PAYLOAD_INVALID", status: 400 });

    const byContact = await resolveRaviLink({
      caller: caller(USER_A),
      query: { contact_id: CONTACT_ONE },
      repository,
      requestId: "req_resolve_contact",
    });
    const byPair = await resolveRaviLink({
      caller: caller(USER_A),
      query: { contactId: CONTACT_ONE, consoleUserId: USER_B },
      repository,
      requestId: "req_resolve_pair",
    });
    const wrongPair = await resolveRaviLink({
      caller: caller(USER_A),
      query: { contactId: CONTACT_ONE, consoleUserId: USER_A },
      repository,
      requestId: "req_resolve_wrong_pair",
    });
    const byUser = await resolveRaviLink({
      caller: caller(USER_A),
      query: { consoleUserId: USER_B },
      repository,
      requestId: "req_resolve_user",
    });
    const otherInstallation = await resolveRaviLink({
      caller: caller(USER_A),
      query: { contactId: CONTACT_TWO },
      repository,
      requestId: "req_resolve_other_installation",
    });

    expect("binding" in byContact && byContact.binding?.id).toBe(binding.id);
    expect("binding" in byPair && byPair.binding?.id).toBe(binding.id);
    expect("binding" in wrongPair && wrongPair.binding).toBeNull();
    expect("bindings" in byUser && byUser.bindings?.map((row) => row.id)).toEqual([binding.id]);
    expect("binding" in otherInstallation && otherInstallation.binding).toBeNull();
    expect(byContact).toMatchObject({ binding: { installationId: INSTALLATION_A, organizationId: ORG_A } });
  });

  test("the installation can revoke a binding of its own, idempotently", async () => {
    const repository = inMemoryRaviLinkRepository();
    const binding = repository.seedBinding({ consoleUserId: USER_B, contactId: CONTACT_ONE });

    const revoked = await unlinkRaviLink({
      body: { contactId: CONTACT_ONE },
      caller: caller(USER_A),
      repository,
      requestId: "req_unlink",
    });
    const again = await unlinkRaviLink({
      body: { bindingId: binding.id },
      caller: caller(USER_A),
      repository,
      requestId: "req_unlink_again",
    });
    const resolved = await resolveRaviLink({
      caller: caller(USER_A),
      query: { contactId: CONTACT_ONE },
      repository,
      requestId: "req_resolve_after",
    });

    expect(revoked.binding).toMatchObject({ id: binding.id, status: "revoked" });
    expect(revoked.binding?.revokedAt).toBeTruthy();
    expect(again.binding).toMatchObject({ id: binding.id, status: "revoked" });
    expect("binding" in resolved && resolved.binding).toBeNull();
    expect(repository.audits.filter((event) => event.action === "ravi_link.binding.revoked")).toHaveLength(1);
    expect(repository.audits.at(-1)).toMatchObject({
      action: "ravi_link.binding.revoked",
      actorId: USER_A,
      metadata: { consoleUserId: USER_B, revokedBy: USER_A, scope: "installation" },
    });
  });

  test("unlink never reaches bindings of another installation", async () => {
    const repository = inMemoryRaviLinkRepository();
    const foreign = repository.seedBinding({
      consoleUserId: USER_A,
      contactId: CONTACT_ONE,
      installationId: INSTALLATION_B,
      organizationId: ORG_B,
    });

    const byId = await unlinkRaviLink({
      body: { bindingId: foreign.id },
      caller: caller(USER_A),
      repository,
      requestId: "req_unlink_foreign",
    });
    const byContact = await unlinkRaviLink({
      body: { contactId: CONTACT_ONE },
      caller: caller(USER_A),
      repository,
      requestId: "req_unlink_foreign_contact",
    });

    expect(byId.binding).toBeNull();
    expect(byContact.binding).toBeNull();
    expect(repository.bindings[0]?.status).toBe("active");
  });

  test("unlink requires a contact or binding id", async () => {
    const repository = inMemoryRaviLinkRepository();
    await expect(
      unlinkRaviLink({ body: {}, caller: caller(USER_A), repository, requestId: "req_unlink_empty" }),
    ).rejects.toMatchObject({ code: "CONTACT_REQUIRED", status: 400 });
  });
});
