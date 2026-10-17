import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractError } from "../../cli/agent-contract.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { DAEMON_KNOWLEDGE_TURN, type KnowledgeClient } from "../client.js";
import type { ConsoleProposalCreate } from "../types.js";
import { planKnowledgeProposal, submitKnowledgeProposal, type ProposalPlanDeps } from "./propose.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-propose-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

const deps: ProposalPlanDeps = {
  defaultProject: () => null,
  instanceChannel: (name) => (name === "wa-main" ? "whatsapp" : null),
  localTextHash: (ref) => (ref === "km:12" ? "hash12" : null),
  meetingsDir: () => join(stateDir, "meetings"),
};

function failure(run: () => unknown): { code: string; exitCode: number; message: string } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ContractError) return { code: error.code, exitCode: error.exitCode, message: error.message };
    throw error;
  }
}

function writeTranscript(key: string, bytes: number | string) {
  const dir = join(stateDir, "meetings", key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transcription.json"), typeof bytes === "string" ? bytes : "x".repeat(bytes));
}

describe("planKnowledgeProposal", () => {
  it("summarizes bytes, project and audience, never the body", () => {
    const body = "Vocês dão desconto pra ONG? (secreto)";
    const { plan, summary } = planKnowledgeProposal(
      { kind: "gap", text: body, project: "acme", audience: "contacts:wa-main", from: ["km:12", "kc:0123abcd-0000"] },
      deps,
    );
    expect(summary).toEqual({
      kind: "gap",
      bytes: Buffer.byteLength(body),
      project: "acme",
      audience: "contacts:wa-main",
    });
    expect(JSON.stringify(summary)).not.toContain("secreto");
    expect(plan.requestedAudience).toEqual({ kind: "contacts", instanceId: "wa-main", label: "wa-main (whatsapp)" });
    expect(plan.evidence).toEqual([
      { ref: "km:12", textHash: "hash12" },
      { ref: "kc:0123abcd-0000", textHash: "" },
    ]);
    expect(plan.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has a stable idempotencyKey", () => {
    const a = planKnowledgeProposal({ kind: "note", text: "Horário: 9h às 18h", project: "acme" }, deps).plan;
    const b = planKnowledgeProposal({ kind: "note", text: "  Horário: 9h às 18h ", project: "acme" }, deps).plan;
    const c = planKnowledgeProposal({ kind: "note", text: "Horário: 9h às 18h", project: "other" }, deps).plan;
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).not.toBe(c.idempotencyKey);
    expect(a.requestedAudience).toEqual({ kind: "members" });
    expect(a.dedupeKey).toBeNull();
  });

  it("falls back to knowledge.project and is a usage error with neither", () => {
    const plan = planKnowledgeProposal({ kind: "note", text: "x" }, { ...deps, defaultProject: () => "from-setting" });
    expect(plan.plan.project).toBe("from-setting");
    expect(failure(() => planKnowledgeProposal({ kind: "note", text: "x" }, deps))).toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  });

  it("reads a local transcript and refuses cloud meetings and files over 2 MB", () => {
    writeTranscript("2026-10-01-weekly", '{"segments":[]}');
    const ok = planKnowledgeProposal({ kind: "transcript", transcriptKey: "2026-10-01-weekly", project: "acme" }, deps);
    expect(ok.plan.body).toBe('{"segments":[]}');
    expect(ok.plan.title).toBe("2026-10-01-weekly");

    writeTranscript("cloud/abc", '{"segments":[]}');
    const cloud = failure(() =>
      planKnowledgeProposal({ kind: "transcript", transcriptKey: "cloud/abc", project: "acme" }, deps),
    );
    expect(cloud?.exitCode).toBe(2);
    expect(cloud?.message).toContain("already in the Console");

    writeTranscript("big", 2 * 1024 * 1024 + 1);
    expect(
      failure(() => planKnowledgeProposal({ kind: "transcript", transcriptKey: "big", project: "acme" }, deps))
        ?.exitCode,
    ).toBe(2);
    expect(
      failure(() => planKnowledgeProposal({ kind: "transcript", transcriptKey: "../etc", project: "acme" }, deps))
        ?.exitCode,
    ).toBe(2);
  });

  it("checks audiences, body limits and refs", () => {
    expect(failure(() => planKnowledgeProposal({ kind: "gap", text: "q", project: "p" }, deps))?.exitCode).toBe(2);
    expect(
      failure(() => planKnowledgeProposal({ kind: "gap", text: "q", project: "p", audience: "contacts:nope" }, deps))
        ?.exitCode,
    ).toBe(2);
    expect(
      failure(() =>
        planKnowledgeProposal({ kind: "note", text: "q", project: "p", audience: "contacts:wa-main" }, deps),
      )?.exitCode,
    ).toBe(2);
    expect(
      failure(() =>
        planKnowledgeProposal(
          { kind: "gap", text: "x".repeat(1001), project: "p", audience: "contacts:wa-main" },
          deps,
        ),
      )?.exitCode,
    ).toBe(2);
    expect(
      failure(() => planKnowledgeProposal({ kind: "note", text: "q", project: "p", from: ["bad"] }, deps))?.exitCode,
    ).toBe(2);
    expect(
      failure(() => planKnowledgeProposal({ kind: "note", text: "q", project: "p", from: ["km:99"] }, deps)),
    ).toMatchObject({
      code: "KNOWLEDGE_NOT_FOUND",
      exitCode: 1,
    });
  });
});

describe("submitKnowledgeProposal", () => {
  it("posts the plan with the turn and needs a login", async () => {
    const calls: ConsoleProposalCreate[] = [];
    const client = {
      createProposal: async (body: ConsoleProposalCreate) => {
        calls.push(body);
        return { proposal: { id: "p1" }, deduped: false };
      },
    } as unknown as KnowledgeClient;
    const { plan } = planKnowledgeProposal({ kind: "note", text: "hello", project: "acme" }, deps);
    const result = await submitKnowledgeProposal({ plan, turn: DAEMON_KNOWLEDGE_TURN }, { client });
    expect(result.deduped).toBe(false);
    expect(calls).toEqual([plan]);
    await expect(submitKnowledgeProposal({ plan, turn: DAEMON_KNOWLEDGE_TURN }, { client: null })).rejects.toThrow(
      /ravi login/,
    );
  });
});
