import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  RAVI_LINK_REQUEST_RATE_LIMIT,
  RAVI_LINK_REQUEST_TTL_MS,
  approveRaviLinkRequest,
  cancelRaviLinkRequestForCli,
  createRaviLinkRequest,
  denyRaviLinkRequest,
  emailHintHash,
  getRaviLinkRequestForCli,
  getRaviLinkRequestView,
  linkRequestTokenHash,
  revokeRaviLinkBindingForUser,
} from "./ravi-link-requests";
import {
  CONTACT_ONE,
  CONTACT_TWO,
  INSTALLATION_A,
  INSTALLATION_B,
  ORG_A,
  ORG_B,
  USER_A,
  USER_B,
  USER_C,
  approver,
  caller,
  inMemoryRaviLinkRepository,
  type InMemoryRaviLinkRepository,
} from "./ravi-link.test-helpers";

const ORIGIN = "https://console.ravi.bot";
const NOW = new Date("2026-10-09T12:00:00.000Z");
const SLACK_IDENTITY = { channel: "slack", accountId: "T0NBA", platformUserId: "U0ALICE" };

let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.RAVI_CLI_ACCESS_TOKEN_SECRET;
  process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = "link-request-test-secret-with-32-plus-chars";
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.RAVI_CLI_ACCESS_TOKEN_SECRET;
  else process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = previousSecret;
});

async function createPending(
  repository: InMemoryRaviLinkRepository,
  body: Record<string, unknown> = {},
  now = NOW,
) {
  const result = await createRaviLinkRequest({
    body: { contactId: CONTACT_ONE, platformIdentities: SLACK_IDENTITY, ...body },
    caller: caller(USER_A),
    now,
    origin: ORIGIN,
    repository,
    requestId: "req_create",
  });
  if (result.payload.status !== "pending") throw new Error("expected a pending request");
  const token = result.payload.approveUrl.slice(`${ORIGIN}/link/`.length);
  return { ...result, payload: result.payload, token };
}

describe("Ravi link requests (CLI side)", () => {
  test("creates a single-use request whose raw token is never stored or audited", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository, {
      requester: { displayName: "Alice\u0000 Silva" },
      expectedEmail: "Alice@Example.com",
    });

    expect(created.httpStatus).toBe(201);
    expect(created.payload.request).toEqual({
      id: repository.requests[0]!.id,
      status: "pending",
      expiresAt: new Date(NOW.getTime() + RAVI_LINK_REQUEST_TTL_MS).toISOString(),
    });
    expect(created.token).toMatch(/^ravi_lr_[A-Za-z0-9_-]{43}$/);

    const row = repository.requests[0]!;
    expect(row).toMatchObject({
      installationId: INSTALLATION_A,
      organizationId: ORG_A,
      requestedByUserId: USER_A,
      contactId: CONTACT_ONE,
      platformIdentitiesJson: SLACK_IDENTITY,
      requesterDisplayName: "Alice Silva",
      status: "pending",
    });
    expect(row.tokenHash).toBe(linkRequestTokenHash(created.token));
    expect(row.expectedEmailHash).toBe(emailHintHash("alice@example.com"));

    const stored = JSON.stringify({ requests: repository.requests, audits: repository.audits });
    expect(stored).not.toContain(created.token);
    expect(stored.toLowerCase()).not.toContain("alice@example.com");
    expect(repository.audits.at(-1)).toMatchObject({
      action: "ravi_link.request.created",
      targetType: "ravi_link_request",
      metadata: { contactId: CONTACT_ONE, emailHint: true },
    });
  });

  test("an already linked contact gets already_linked and no new state", async () => {
    const repository = inMemoryRaviLinkRepository();
    const binding = repository.seedBinding({ consoleUserId: USER_B, contactId: CONTACT_ONE });

    const result = await createRaviLinkRequest({
      body: { contactId: CONTACT_ONE },
      caller: caller(USER_A),
      now: NOW,
      origin: ORIGIN,
      repository,
      requestId: "req_already",
    });

    expect(result.httpStatus).toBe(200);
    expect(result.payload).toMatchObject({ version: 1, status: "already_linked", binding: { id: binding.id } });
    expect(repository.requests).toHaveLength(0);
    expect(repository.audits).toHaveLength(0);
  });

  test("asking again while pending rotates the link and keeps one pending request", async () => {
    const repository = inMemoryRaviLinkRepository();
    const first = await createPending(repository);
    const second = await createPending(repository, {}, new Date(NOW.getTime() + 1000));

    expect(second.token).not.toBe(first.token);
    expect(repository.requests.map((row) => row.status)).toEqual(["cancelled", "pending"]);
    expect(repository.requests[0]!.failureReason).toBe("rotated");
    expect(repository.audits.at(-1)?.metadata.rotatedRequestId).toBe(first.payload.request.id);

    await expect(
      approveRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_old", token: first.token }),
    ).rejects.toMatchObject({ code: "LINK_REQUEST_USED", status: 409 });
  });

  test("rate limits repeated requests for the same person", async () => {
    const repository = inMemoryRaviLinkRepository();
    for (let index = 0; index < RAVI_LINK_REQUEST_RATE_LIMIT; index += 1) {
      await createPending(repository, {}, new Date(NOW.getTime() + index * 1000));
    }

    await expect(createPending(repository, {}, new Date(NOW.getTime() + 60_000))).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
    expect(repository.audits.at(-1)?.action).toBe("ravi_link.request.rate_limited");

    // Other people are not affected.
    const other = await createRaviLinkRequest({
      body: { contactId: CONTACT_TWO },
      caller: caller(USER_A),
      now: new Date(NOW.getTime() + 60_000),
      origin: ORIGIN,
      repository,
      requestId: "req_other_contact",
    });
    expect(other.httpStatus).toBe(201);
  });

  test("validates the body and pins the session installation", async () => {
    const repository = inMemoryRaviLinkRepository();
    const create = (body: unknown) =>
      createRaviLinkRequest({ body, caller: caller(USER_A), now: NOW, origin: ORIGIN, repository, requestId: "req_bad" });

    await expect(create({})).rejects.toMatchObject({ code: "CONTACT_REQUIRED", status: 400 });
    await expect(create({ contactId: "   " })).rejects.toMatchObject({ code: "CONTACT_REQUIRED", status: 400 });
    await expect(create({ contactId: CONTACT_ONE, consoleUserId: USER_B })).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });
    await expect(create({ contactId: CONTACT_ONE, expectedEmail: "not-an-email" })).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });
    await expect(
      create({ contactId: CONTACT_ONE, platformIdentities: { access_token: "secret" } }),
    ).rejects.toMatchObject({ code: "PAYLOAD_INVALID" });
    await expect(create({ contactId: CONTACT_ONE, installationId: INSTALLATION_B })).rejects.toMatchObject({
      code: "INSTALLATION_MISMATCH",
      status: 403,
    });
    expect(repository.requests).toHaveLength(0);
  });

  test("polling reports approval with the binding, and expiry once it passes", async () => {
    const repository = inMemoryRaviLinkRepository();
    const approvedReq = await createPending(repository);
    const expiring = await createPending(repository, { contactId: CONTACT_TWO });

    await approveRaviLinkRequest({
      approver: approver(USER_B),
      now: NOW,
      repository,
      requestId: "req_approve",
      token: approvedReq.token,
    });

    const approved = await getRaviLinkRequestForCli({
      caller: caller(USER_A),
      linkRequestId: approvedReq.payload.request.id,
      now: NOW,
      repository,
      requestId: "req_poll",
    });
    expect(approved.request.status).toBe("approved");
    expect(approved.binding).toMatchObject({ consoleUserId: USER_B, contactId: CONTACT_ONE, status: "active" });

    const later = new Date(NOW.getTime() + RAVI_LINK_REQUEST_TTL_MS + 1);
    const expired = await getRaviLinkRequestForCli({
      caller: caller(USER_A),
      linkRequestId: expiring.payload.request.id,
      now: later,
      repository,
      requestId: "req_poll_expired",
    });
    expect(expired.request).toMatchObject({ status: "expired", failureReason: "expired" });
    expect(expired.binding).toBeUndefined();
    expect(repository.requests.find((row) => row.id === expiring.payload.request.id)?.status).toBe("expired");
  });

  test("another installation cannot poll or cancel a request", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);
    const foreign = caller(USER_A, { sessionInstallationId: INSTALLATION_B, sessionOrganizationId: ORG_B });

    await expect(
      getRaviLinkRequestForCli({
        caller: foreign,
        linkRequestId: created.payload.request.id,
        repository,
        requestId: "req_foreign_poll",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      cancelRaviLinkRequestForCli({
        caller: foreign,
        linkRequestId: created.payload.request.id,
        repository,
        requestId: "req_foreign_cancel",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      getRaviLinkRequestForCli({ caller: caller(USER_A), linkRequestId: "nope", repository, requestId: "req_bad_id" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  test("cancel closes a pending request and is idempotent", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);
    const cancel = () =>
      cancelRaviLinkRequestForCli({
        caller: caller(USER_A),
        linkRequestId: created.payload.request.id,
        now: NOW,
        repository,
        requestId: "req_cancel",
      });

    expect((await cancel()).request.status).toBe("cancelled");
    expect((await cancel()).request.status).toBe("cancelled");
    expect(repository.audits.filter((event) => event.action === "ravi_link.request.cancelled")).toHaveLength(1);
    await expect(
      approveRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_late", token: created.token }),
    ).rejects.toMatchObject({ code: "LINK_REQUEST_USED" });
  });
});

describe("Ravi link requests (browser approval)", () => {
  test("approval binds the contact to the approver, never to the operator", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);

    const result = await approveRaviLinkRequest({
      approver: approver(USER_B),
      now: NOW,
      repository,
      requestId: "req_approve",
      token: created.token,
    });

    expect(result.reused).toBeFalse();
    expect(result.binding).toMatchObject({
      installationId: INSTALLATION_A,
      organizationId: ORG_A,
      consoleUserId: USER_B,
      linkedBy: USER_B,
      contactId: CONTACT_ONE,
      platformIdentities: SLACK_IDENTITY,
      status: "active",
    });
    expect(repository.requests[0]).toMatchObject({
      status: "approved",
      approvedByUserId: USER_B,
      bindingId: result.binding.id,
    });
    const actions = repository.audits.map((event) => [event.action, event.actorType, event.actorId]);
    expect(actions).toContainEqual(["ravi_link.binding.created", "user", USER_B]);
    expect(actions).toContainEqual(["ravi_link.request.approved", "user", USER_B]);
    expect(
      repository.audits.find((event) => event.action === "ravi_link.binding.created")?.metadata.viaRequestId,
    ).toBe(created.payload.request.id);
  });

  test("a link works once", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);
    await approveRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_1", token: created.token });

    await expect(
      approveRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_2", token: created.token }),
    ).rejects.toMatchObject({ code: "LINK_REQUEST_USED", status: 409 });
    await expect(
      denyRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_3", token: created.token }),
    ).rejects.toMatchObject({ code: "LINK_REQUEST_USED", status: 409 });
    expect(repository.bindings).toHaveLength(1);
    expect(repository.audits.at(-1)).toMatchObject({
      action: "ravi_link.request.rejected",
      metadata: { reason: "already_used" },
    });
  });

  test("an expired link fails and is marked expired", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);
    const later = new Date(NOW.getTime() + RAVI_LINK_REQUEST_TTL_MS);

    await expect(
      approveRaviLinkRequest({ approver: approver(USER_B), now: later, repository, requestId: "req_late", token: created.token }),
    ).rejects.toMatchObject({ code: "LINK_REQUEST_EXPIRED", status: 410 });
    expect(repository.requests[0]!.status).toBe("expired");
    expect(repository.bindings).toHaveLength(0);
    await expect(
      approveRaviLinkRequest({ approver: approver(USER_B), now: later, repository, requestId: "req_later", token: created.token }),
    ).rejects.toMatchObject({ code: "LINK_REQUEST_EXPIRED", status: 410 });
  });

  test("unknown or malformed tokens are invalid", async () => {
    const repository = inMemoryRaviLinkRepository();
    for (const token of [null, "", "ravi_lr_short", `ravi_lr_${"A".repeat(43)}`]) {
      await expect(
        approveRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_bad", token }),
      ).rejects.toMatchObject({ code: "LINK_REQUEST_INVALID", status: 404 });
    }
    expect(repository.audits.every((event) => event.action === "ravi_link.request.rejected")).toBeTrue();
  });

  test("someone outside the organization cannot approve", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);

    await expect(
      approveRaviLinkRequest({ approver: approver(USER_C), now: NOW, repository, requestId: "req_outsider", token: created.token }),
    ).rejects.toMatchObject({ code: "NOT_MEMBER", status: 403 });
    expect(repository.requests[0]!.status).toBe("pending");
    expect(repository.bindings).toHaveLength(0);
  });

  test("an impersonated session cannot approve", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);

    await expect(
      approveRaviLinkRequest({
        approver: approver(USER_B, { impersonated: true }),
        now: NOW,
        repository,
        requestId: "req_impersonated",
        token: created.token,
      }),
    ).rejects.toMatchObject({ code: "LINK_USER_MISMATCH", status: 403 });
    expect(repository.audits.at(-1)?.metadata.reason).toBe("impersonation");
  });

  test("the email hint must match a verified Console email", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository, { expectedEmail: "alice@example.com" });
    const attempt = (overrides: Parameters<typeof approver>[1]) =>
      approveRaviLinkRequest({
        approver: approver(USER_B, overrides),
        now: NOW,
        repository,
        requestId: "req_email",
        token: created.token,
      });

    await expect(attempt({ email: "mallory@example.com", emailVerified: true })).rejects.toMatchObject({
      code: "LINK_USER_MISMATCH",
    });
    expect(repository.audits.at(-1)?.metadata.reason).toBe("email_mismatch");
    await expect(attempt({ email: "alice@example.com", emailVerified: false })).rejects.toMatchObject({
      code: "LINK_USER_MISMATCH",
    });
    expect(repository.audits.at(-1)?.metadata.reason).toBe("email_unverified");
    expect(JSON.stringify(repository.audits)).not.toContain("mallory");

    const ok = await attempt({ email: "  Alice@Example.COM ", emailVerified: true });
    expect(ok.binding.consoleUserId).toBe(USER_B);
  });

  test("a contact linked to someone else is a conflict and leaves the request pending", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);
    repository.seedBinding({ consoleUserId: USER_A, contactId: CONTACT_ONE });

    await expect(
      approveRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_conflict", token: created.token }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(repository.requests[0]!.status).toBe("pending");
    expect(repository.bindings.filter((row) => row.status === "active")).toHaveLength(1);
  });

  test("approving again after the same person was bound in between reuses the binding", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);
    const existing = repository.seedBinding({ consoleUserId: USER_B, contactId: CONTACT_ONE });

    const result = await approveRaviLinkRequest({
      approver: approver(USER_B),
      now: NOW,
      repository,
      requestId: "req_reuse",
      token: created.token,
    });
    expect(result.reused).toBeTrue();
    expect(result.binding.id).toBe(existing.id);
    expect(repository.bindings).toHaveLength(1);
  });

  test("a revoked binding is reactivated for the same person", async () => {
    const repository = inMemoryRaviLinkRepository();
    const revoked = repository.seedBinding({
      consoleUserId: USER_B,
      contactId: CONTACT_ONE,
      status: "revoked",
      revokedAt: NOW,
    });
    const created = await createPending(repository);

    const result = await approveRaviLinkRequest({
      approver: approver(USER_B),
      now: NOW,
      repository,
      requestId: "req_reactivate",
      token: created.token,
    });
    expect(result.binding).toMatchObject({ id: revoked.id, status: "active", revokedAt: null });
    expect(repository.audits.map((event) => event.action)).toContain("ravi_link.binding.reactivated");
  });

  test("approval fails on a revoked installation", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);
    repository.installations[0]!.status = "revoked";

    await expect(
      approveRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_revoked", token: created.token }),
    ).rejects.toMatchObject({ code: "INSTALLATION_REVOKED", status: 403 });
    expect(repository.bindings).toHaveLength(0);
  });

  test("a binding write that loses a race rolls back and reports a conflict", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);
    const insertBinding = repository.insertBinding.bind(repository);
    repository.insertBinding = async (values) => {
      repository.seedBinding({ consoleUserId: USER_A, contactId: values.contactId });
      return insertBinding(values);
    };

    await expect(
      approveRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_race", token: created.token }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(repository.requests[0]!.status).toBe("pending");
    expect(repository.audits.at(-1)?.metadata.reason).toBe("contact_linked_to_another_user");
  });

  test("“This wasn't me” denies the request", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository);

    await denyRaviLinkRequest({ approver: approver(USER_B), now: NOW, repository, requestId: "req_deny", token: created.token });
    expect(repository.requests[0]).toMatchObject({ status: "denied", failureReason: "denied" });
    expect(repository.audits.at(-1)).toMatchObject({ action: "ravi_link.request.denied", actorType: "user" });

    const polled = await getRaviLinkRequestForCli({
      caller: caller(USER_A),
      linkRequestId: created.payload.request.id,
      now: NOW,
      repository,
      requestId: "req_poll_denied",
    });
    expect(polled.request.status).toBe("denied");
  });
});

describe("Ravi link request page view", () => {
  test("shows what is being linked without changing anything", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository, { requester: { displayName: "Alice" } });
    const before = JSON.stringify(repository.requests);

    const view = await getRaviLinkRequestView({ approver: approver(USER_B), now: NOW, repository, token: created.token });
    const expiredView = await getRaviLinkRequestView({
      approver: approver(USER_B),
      now: new Date(NOW.getTime() + RAVI_LINK_REQUEST_TTL_MS + 1),
      repository,
      token: created.token,
    });

    expect(view).toEqual({
      state: "pending",
      channel: "Slack",
      expiresAt: new Date(NOW.getTime() + RAVI_LINK_REQUEST_TTL_MS).toISOString(),
      installationName: "luis-mac",
      organizationName: "Org A",
      requesterDisplayName: "Alice",
    });
    expect(JSON.stringify(view)).not.toContain(CONTACT_ONE);
    expect(expiredView).toEqual({ state: "expired" });
    expect(JSON.stringify(repository.requests)).toBe(before);
    expect(repository.audits.filter((event) => event.action !== "ravi_link.request.created")).toHaveLength(0);
  });

  test("reports invalid, not member, mismatch, approved and used states", async () => {
    const repository = inMemoryRaviLinkRepository();
    const created = await createPending(repository, { expectedEmail: "alice@example.com" });
    const view = (userId: string, overrides: Parameters<typeof approver>[1] = {}) =>
      getRaviLinkRequestView({ approver: approver(userId, overrides), now: NOW, repository, token: created.token });

    expect(await getRaviLinkRequestView({ approver: approver(USER_B), repository, token: "garbage" })).toEqual({
      state: "invalid",
    });
    expect(await view(USER_C)).toEqual({ state: "not_member" });
    expect(await view(USER_B, { email: "bob@example.com", emailVerified: true })).toEqual({ state: "user_mismatch" });

    await approveRaviLinkRequest({
      approver: approver(USER_B, { email: "alice@example.com", emailVerified: true }),
      now: NOW,
      repository,
      requestId: "req_ok",
      token: created.token,
    });
    expect(await view(USER_B)).toEqual({ state: "approved" });
    expect(await view(USER_A)).toEqual({ state: "used" });
  });
});

describe("Ravi link revoke from the Console", () => {
  test("a person can revoke only their own links", async () => {
    const repository = inMemoryRaviLinkRepository();
    const mine = repository.seedBinding({ consoleUserId: USER_B, contactId: CONTACT_ONE });
    const theirs = repository.seedBinding({ consoleUserId: USER_A, contactId: CONTACT_TWO });

    await expect(
      revokeRaviLinkBindingForUser({ approver: approver(USER_B), bindingId: theirs.id, repository, requestId: "req_theirs" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      revokeRaviLinkBindingForUser({ approver: approver(USER_B), bindingId: "not-a-uuid", repository, requestId: "req_bad" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const result = await revokeRaviLinkBindingForUser({
      approver: approver(USER_B),
      bindingId: mine.id,
      repository,
      requestId: "req_mine",
    });
    expect(result.binding).toMatchObject({ id: mine.id, status: "revoked" });
    expect(repository.bindings.find((row) => row.id === theirs.id)?.status).toBe("active");
    expect(repository.audits.at(-1)).toMatchObject({
      action: "ravi_link.binding.revoked",
      actorType: "user",
      metadata: { scope: "self", source: "console" },
    });
  });
});
