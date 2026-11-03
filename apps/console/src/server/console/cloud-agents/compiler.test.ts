import { describe, expect, test } from "bun:test";

import { canonicalInputHash } from "@/server/mcp/console-tools";

import { toolInputHash } from "./approvals";
import { mcpToolName } from "./mcp";
import {
  canonicalJson,
  CLOUD_DEFAULT_MODEL,
  CLOUD_PREAMBLE,
  cloudSkillRefs,
  compileCloudAgent,
  resolveModel,
  type CloudSkillSource,
  type CloudSourceFile,
} from "./compiler";
import { isCloudAgentsError } from "./errors";

function files(manifest: Record<string, unknown> | null, extra: CloudSourceFile[] = []): CloudSourceFile[] {
  return [
    { path: "AGENTS.md", content: "# Reporter\n\nWrite the weekly report.\n" },
    ...(manifest ? [{ path: "agent.json", content: JSON.stringify(manifest) }] : []),
    ...extra,
  ];
}

function skill(ref: string, hash = "h1"): CloudSkillSource {
  return {
    ref,
    itemId: "item-1",
    versionId: "ver-1",
    versionNumber: 3,
    slug: ref.split("/").pop()!,
    name: "Reports",
    description: "Writes reports",
    contentHash: hash,
    files: [{ path: "SKILL.md", content: "---\nname: reports\n---\nBody" }],
  };
}

function codeOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (isCloudAgentsError(error)) return { code: error.code, details: error.details };
    throw error;
  }
  return null;
}

describe("cloud agent compiler", () => {
  test("compiles AGENTS.md behind the preamble with the block's defaults", () => {
    const compiled = compileCloudAgent({ files: files(null) });
    expect(compiled.system.startsWith(CLOUD_PREAMBLE)).toBe(true);
    expect(compiled.system).toContain("Write the weekly report.");
    expect(compiled.model).toBe(CLOUD_DEFAULT_MODEL);
    expect(compiled.budgetUsd).toBe(5);
    expect(compiled.writes).toBe("ask");
    expect(compiled.raviMcp).toBe(true);
    expect(compiled.heartbeat).toBeNull();
    expect(compiled.compiledHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the hash is stable across key order and changes with the definition", () => {
    const a = compileCloudAgent({ files: files({ model: "opus", cloud: { budgetUsd: 3, tools: { writes: "auto", webSearch: true } } }) });
    const b = compileCloudAgent({ files: files({ cloud: { tools: { webSearch: true, writes: "auto" }, budgetUsd: 3 }, model: "opus" }) });
    const c = compileCloudAgent({ files: files({ model: "opus", cloud: { budgetUsd: 4, tools: { writes: "auto", webSearch: true } } }) });
    expect(a.model).toBe("claude-opus-5-5");
    expect(a.compiledHash).toBe(b.compiledHash);
    expect(a.compiledHash).not.toBe(c.compiledHash);
    const heartbeat = compileCloudAgent({ files: files(null, [{ path: "HEARTBEAT.md", content: "Check the inbox.\n" }]) });
    expect(heartbeat.heartbeat).toBe("Check the inbox.");
  });

  test("models: aliases, claude ids, and anything else is unsupported", () => {
    expect(resolveModel(null)).toBe(CLOUD_DEFAULT_MODEL);
    expect(resolveModel("haiku")).toBe("claude-haiku-5-5");
    expect(resolveModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(codeOf(() => resolveModel("gpt-5"))).toEqual({ code: "cloud_agent_provider_unsupported", details: { reason: "model", model: "gpt-5" } });
    expect(codeOf(() => compileCloudAgent({ files: files({ provider: "codex" }) }))?.code).toBe("cloud_agent_provider_unsupported");
    expect(codeOf(() => compileCloudAgent({ files: files({ cloud: { model: "gemini-pro" } }) }))?.details).toMatchObject({ reason: "model" });
  });

  test("skills: Library refs must resolve, bare CLI skills only warn", () => {
    const manifest = { skills: ["acme/reports", "pages"] };
    expect(cloudSkillRefs(files(manifest))).toEqual(["acme/reports"]);
    expect(codeOf(() => compileCloudAgent({ files: files(manifest) }))?.code).toBe("cloud_agent_definition_invalid");
    const compiled = compileCloudAgent({ files: files(manifest), skills: new Map([["acme/reports", skill("acme/reports")]]) });
    expect(compiled.skills).toEqual([
      { ref: "acme/reports", itemId: "item-1", versionId: "ver-1", versionNumber: 3, slug: "reports", name: "Reports", contentHash: "h1" },
    ]);
    expect(compiled.warnings).toEqual(["Skill pages ships with the Ravi CLI and is not available in cloud runs."]);
    const changed = compileCloudAgent({ files: files(manifest), skills: new Map([["acme/reports", skill("acme/reports", "h2")]]) });
    expect(changed.compiledHash).not.toBe(compiled.compiledHash);
  });

  test("invalid definitions", () => {
    expect(codeOf(() => compileCloudAgent({ files: [{ path: "agent.json", content: "{}" }] }))?.code).toBe("cloud_agent_definition_invalid");
    expect(codeOf(() => compileCloudAgent({ files: [{ path: "AGENTS.md", content: "x" }, { path: "agent.json", content: "[1]" }] }))?.code).toBe(
      "cloud_agent_definition_invalid",
    );
    expect(codeOf(() => compileCloudAgent({ files: files({ cloud: { mcp: { servers: [{ name: "x", url: "https://x.example.com", secret: "s" }] } } }) }))?.code).toBe(
      "cloud_agent_definition_invalid",
    );
  });

  test("canonical JSON and the approval input hash match the MCP confirmation hash", () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: "x" }], e: null })).toBe('{"a":[{"c":"x"}],"b":1,"e":null}');
    const input = { viewId: "v1", values: { b: 2, a: "é" }, project: "demo" };
    expect(toolInputHash({ ...input, confirmationToken: "rmc1.x.y" })).toBe(canonicalInputHash(input));
    expect(toolInputHash({ values: { a: "é", b: 2 }, project: "demo", viewId: "v1" })).toBe(canonicalInputHash(input));
  });
});

describe("mcpToolName", () => {
  test("matches the Worker's reversible encoding: _ doubles, . becomes _", () => {
    expect(mcpToolName("ravi.bases.views.rows.create")).toBe("ravi_bases_views_rows_create");
    expect(mcpToolName("ravi.cloud_agents.runs.start")).toBe("ravi_cloud__agents_runs_start");
  });
});
