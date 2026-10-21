import { describe, expect, it } from "bun:test";

import {
  isCloudCron,
  isCloudModel,
  isCloudTimezone,
  readCloudBlockFromManifest,
  validateCloudBlock,
} from "./definition.js";

function issuesOf(value: unknown) {
  const result = validateCloudBlock(value);
  return result.ok ? [] : result.issues;
}

describe("cloud block validation", () => {
  it("accepts a full block and keeps only its fields", () => {
    const result = validateCloudBlock({
      model: "sonnet",
      effort: "high",
      budgetUsd: 10,
      environment: {
        networking: "limited",
        allowedHosts: ["api.github.com", "pypi.org"],
        packages: { apt: ["ripgrep"], pip: ["pandas==2.2.0"], npm: ["@scope/pkg"] },
      },
      mcp: { ravi: true, servers: [{ name: "linear", url: "https://mcp.linear.app/sse" }] },
      tools: { webSearch: true, writes: "ask" },
      repositories: [{ repo: "acme/api", branch: "main" }],
      schedule: { cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cloud.model).toBe("sonnet");
    expect(result.cloud.environment?.allowedHosts).toEqual(["api.github.com", "pypi.org"]);
    expect(result.cloud.repositories).toEqual([{ repo: "acme/api", branch: "main" }]);
  });

  it("accepts an empty block", () => {
    expect(validateCloudBlock({})).toEqual({ ok: true, cloud: {} });
  });

  it("refuses keys that look like credentials anywhere", () => {
    const issues = issuesOf({ mcp: { servers: [{ name: "x", url: "https://x.example/mcp", apiKey: "nope" }] } });
    expect(issues.some((issue) => issue.code === "credential_refused")).toBe(true);
    expect(issuesOf({ environment: { GITHUB_TOKEN: "x" } }).some((issue) => issue.code === "credential_refused")).toBe(
      true,
    );
  });

  it("refuses URLs with userinfo or a query string, and non-https servers", () => {
    expect(issuesOf({ mcp: { servers: [{ name: "a", url: "https://user:pw@x.example/mcp" }] } })).not.toHaveLength(0);
    expect(issuesOf({ mcp: { servers: [{ name: "a", url: "https://x.example/mcp?key=1" }] } })).not.toHaveLength(0);
    expect(issuesOf({ mcp: { servers: [{ name: "a", url: "http://x.example/mcp" }] } })).not.toHaveLength(0);
    expect(issuesOf({ mcp: { servers: [{ name: "ravi", url: "https://x.example/mcp" }] } })).not.toHaveLength(0);
  });

  it("refuses unknown keys, bad values and out-of-range budgets", () => {
    const paths = (value: unknown) => issuesOf(value).map((issue) => issue.path.join("."));
    expect(paths({ routes: [] })).toContain("cloud.routes");
    expect(paths({ model: "gpt-5" })).toContain("cloud.model");
    expect(paths({ effort: "extreme" })).toContain("cloud.effort");
    expect(paths({ budgetUsd: 0.1 })).toContain("cloud.budgetUsd");
    expect(paths({ budgetUsd: 500 })).toContain("cloud.budgetUsd");
    expect(paths({ environment: { networking: "open" } })).toContain("cloud.environment.networking");
    expect(paths({ environment: { allowedHosts: ["https://x.example"] } })).toContain(
      "cloud.environment.allowedHosts.0",
    );
    expect(paths({ repositories: [{ repo: "not a repo" }] })).toContain("cloud.repositories.0.repo");
    expect(paths({ schedule: { cron: "* * *" } })).toContain("cloud.schedule.cron");
    expect(paths({ schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" } })).toContain("cloud.schedule.timezone");
    expect(paths({ tools: { writes: "always" } })).toContain("cloud.tools.writes");
    expect(paths("cloud")).toHaveLength(1);
  });

  it("caps list sizes", () => {
    const hosts = Array.from({ length: 26 }, (_, index) => `h${index}.example.com`);
    expect(issuesOf({ environment: { allowedHosts: hosts } })).not.toHaveLength(0);
    const servers = Array.from({ length: 11 }, (_, index) => ({
      name: `s${index}`,
      url: `https://s${index}.example/mcp`,
    }));
    expect(issuesOf({ mcp: { servers } })).not.toHaveLength(0);
  });

  it("reads the block from an agent.json text", () => {
    expect(readCloudBlockFromManifest(null)).toEqual({ cloud: null, issues: [] });
    expect(readCloudBlockFromManifest('{"name":"x"}')).toEqual({ cloud: null, issues: [] });
    expect(readCloudBlockFromManifest('{"cloud":{"model":"haiku"}}').cloud).toEqual({ model: "haiku" });
    expect(readCloudBlockFromManifest("{nope").issues[0]?.code).toBe("invalid_json");
    expect(readCloudBlockFromManifest('{"cloud":{"model":"x"}}').issues).toHaveLength(1);
  });

  it("checks models, cron and time zones", () => {
    expect(isCloudModel("opus")).toBe(true);
    expect(isCloudModel("claude-opus-4-1")).toBe(true);
    expect(isCloudModel("gpt-4o")).toBe(false);
    expect(isCloudCron("0 9 * * 1-5")).toBe(true);
    expect(isCloudCron("0 9 * *")).toBe(false);
    expect(isCloudTimezone("America/Sao_Paulo")).toBe(true);
    expect(isCloudTimezone("UTC")).toBe(true);
    expect(isCloudTimezone("Nowhere/City")).toBe(false);
  });
});
