import { describe, expect, test } from "bun:test";

import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";

import type { KnowledgeOperatorCaller } from "./caller";
import {
  handleKnowledgeDigest,
  handleKnowledgeMirror,
  handleKnowledgeProposalCreate,
  handleKnowledgeProposalGet,
  type KnowledgeF2HandlerInput,
} from "./f2-cli";

// Validation paths that answer before any database read.

const caller: KnowledgeOperatorCaller = {
  audience: "operator",
  workspace: {
    mode: "workos",
    user: { id: "00000000-0000-4000-8000-000000000001" },
    organization: { id: "00000000-0000-4000-8000-000000000002" },
    membership: { role: "owner" },
  },
  localInstallationId: "00000000-0000-4000-8000-000000000003",
  turnKey: null,
  callerJson: { surface: "cli" },
};

function input(overrides: Partial<KnowledgeF2HandlerInput>): KnowledgeF2HandlerInput {
  return {
    caller,
    auth: {} as CliAuthContext,
    segments: ["proposals"],
    searchParams: new URLSearchParams(),
    body: null,
    requestId: "req",
    requestUrl: "https://console.ravi.bot/api/cli/knowledge/proposals",
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CliApiError);
  return error as CliApiError;
}

const gap = {
  kind: "gap",
  project: "acme",
  title: null,
  evidence: [],
  supersedes: null,
  requestedAudience: { kind: "contacts", instanceId: "wa-main", label: "WhatsApp" },
  dedupeKey: "a".repeat(64),
  idempotencyKey: "gap:1",
};

describe("F2 CLI handlers", () => {
  test("a body over its kind's limit is 400 PAYLOAD_INVALID", async () => {
    const error = await failure(handleKnowledgeProposalCreate(input({ body: { ...gap, body: "q".repeat(1001) } })));
    expect(error.status).toBe(400);
    expect(error.code).toBe("PAYLOAD_INVALID");
  });

  test("a request over the route cap is 413", async () => {
    const proposals = await failure(
      handleKnowledgeProposalCreate(input({ body: { ...gap, kind: "transcript", body: "x".repeat(Math.ceil(2.5 * 1024 * 1024) + 10) } })),
    );
    expect(proposals.status).toBe(413);
    expect(proposals.code).toBe("PAYLOAD_INVALID");

    const mirror = await failure(
      handleKnowledgeMirror(input({ segments: ["mirror"], body: { instances: [{ id: "wa-main", label: "x".repeat(300 * 1024) }] } })),
    );
    expect(mirror.status).toBe(413);
  });

  test("an invalid mirror body is 400", async () => {
    const error = await failure(handleKnowledgeMirror(input({ segments: ["mirror"], body: { instances: [{ id: "bad id!" }] } })));
    expect(error.status).toBe(400);
  });

  test("a malformed proposal id is 404 NOT_FOUND", async () => {
    const error = await failure(handleKnowledgeProposalGet(input({ segments: ["proposals", "not-a-uuid"] })));
    expect(error.status).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
  });

  test("digest since must be ISO", async () => {
    const error = await failure(handleKnowledgeDigest(input({ segments: ["digest"], searchParams: new URLSearchParams({ since: "yesterday" }) })));
    expect(error.status).toBe(400);
  });
});
