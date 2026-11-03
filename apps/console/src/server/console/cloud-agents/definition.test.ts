import { describe, expect, test } from "bun:test";

import { CLOUD_BUDGET_DEFAULT_USD, CloudDefinitionError, defaultCloudBlock, parseBudgetUsd, parseCloudBlock, parseRepositories } from "./definition";

function rejects(raw: unknown, message: RegExp) {
  expect(() => parseCloudBlock(raw)).toThrow(CloudDefinitionError);
  expect(() => parseCloudBlock(raw)).toThrow(message);
}

describe("agent.json cloud block", () => {
  test("defaults when absent, and fills a full block", () => {
    expect(parseCloudBlock(undefined)).toEqual(defaultCloudBlock());
    expect(defaultCloudBlock().budgetUsd).toBe(CLOUD_BUDGET_DEFAULT_USD);
    const block = parseCloudBlock({
      model: "sonnet",
      effort: "medium",
      budgetUsd: 5,
      environment: { networking: "limited", allowedHosts: ["api.example.com", "*.example.org"], packages: { pip: ["pandas==2.2.0"], npm: ["@scope/pkg"] } },
      mcp: { ravi: true, servers: [{ name: "linear", url: "https://mcp.linear.app/sse" }] },
      tools: { webSearch: true, writes: "auto" },
      repositories: ["acme/site", { repo: "acme/api", branch: "main" }],
      schedule: { cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" },
    });
    expect(block.environment.packages).toEqual({ apt: [], pip: ["pandas==2.2.0"], npm: ["@scope/pkg"] });
    expect(block.repositories).toEqual([
      { repo: "acme/site", branch: null },
      { repo: "acme/api", branch: "main" },
    ]);
    expect(block.tools).toEqual({ webSearch: true, writes: "auto" });
    expect(block.schedule).toEqual({ cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" });
  });

  test("refuses credentials anywhere in the block", () => {
    rejects({ mcp: { servers: [{ name: "x", url: "https://x.example.com", token: "abc" }] } }, /token|credential|secret/i);
    rejects({ environment: { apiKey: "abc" } }, /apiKey|credential|secret/i);
    rejects({ mcp: { servers: [{ name: "x", url: "https://user:pass@x.example.com/mcp" }] } }, /url/);
    rejects({ mcp: { servers: [{ name: "x", url: "https://x.example.com/mcp?key=1" }] } }, /url/);
    rejects({ mcp: { servers: [{ name: "x", url: "http://x.example.com/mcp" }] } }, /url/);
  });

  test("refuses unknown keys, bad values and limits", () => {
    rejects({ surprise: true }, /surprise/);
    rejects({ effort: "huge" }, /effort/);
    rejects({ budgetUsd: 0.1 }, /budgetUsd/);
    rejects({ budgetUsd: 500 }, /budgetUsd/);
    rejects({ environment: { networking: "open" } }, /networking/);
    rejects({ environment: { allowedHosts: ["not a host"] } }, /allowedHosts/);
    rejects({ mcp: { servers: [{ name: "ravi", url: "https://x.example.com/mcp" }] } }, /ravi/);
    rejects(
      {
        mcp: {
          servers: [
            { name: "a", url: "https://a.example.com/mcp" },
            { name: "a", url: "https://b.example.com/mcp" },
          ],
        },
      },
      /repeated/,
    );
    rejects({ mcp: { servers: Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, url: `https://s${i}.example.com/mcp` })) } }, /at most 10/);
    rejects({ tools: { writes: "always" } }, /writes/);
    rejects({ repositories: ["not-a-repo"] }, /repositories/);
    rejects({ schedule: { cron: "every day", timezone: "UTC" } }, /schedule/);
    rejects({ schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" } }, /schedule|timezone/);
  });

  test("budgets and per-run repositories parse on their own", () => {
    expect(parseBudgetUsd(0.5)).toBe(0.5);
    expect(() => parseBudgetUsd("5")).toThrow(CloudDefinitionError);
    expect(parseRepositories(undefined)).toEqual([]);
    expect(() => parseRepositories(["a/b", { repo: "a/c", branch: "../x" }])).toThrow(CloudDefinitionError);
  });
});
