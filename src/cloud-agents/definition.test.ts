import { describe, expect, it } from "bun:test";

import {
  CLOUD_OFFICE_SKILLS,
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

describe("cloud block product fields (mirror of the Console's definition.ts)", () => {
  const paths = (value: unknown) => issuesOf(value).map((issue) => issue.path.join("."));

  it("accepts every product field and keeps them", () => {
    const result = validateCloudBlock({
      environment: {
        packages: { cargo: ["ripgrep@14.1.0"], gem: ["rake"], go: ["github.com/acme/tool@v1.2.3"] },
        placement: "installation",
      },
      tools: {
        webSearch: true,
        webFetch: false,
        web: { allowedDomains: ["docs.example.com", "*.example.org/api"] },
        office: ["xlsx", "pdf"],
        askHuman: false,
        workflows: false,
      },
      secrets: ["STRIPE_API_KEY", "CRM_TOKEN", "STRIPE_API_KEY"],
      memory: "person",
      outcome: { rubric: "  A table with every open invoice.  ", maxIterations: 2 },
      monthlyCapUsd: 49.999,
      provider: "ravi",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cloud.environment).toEqual({
      packages: { cargo: ["ripgrep@14.1.0"], gem: ["rake"], go: ["github.com/acme/tool@v1.2.3"] },
      placement: "installation",
    });
    expect(result.cloud.tools).toEqual({
      webSearch: true,
      webFetch: false,
      askHuman: false,
      workflows: false,
      web: { allowedDomains: ["docs.example.com", "*.example.org/api"] },
      office: ["xlsx", "pdf"],
    });
    expect(result.cloud.secrets).toEqual(["STRIPE_API_KEY", "CRM_TOKEN"]);
    expect(result.cloud.memory).toBe("person");
    expect(result.cloud.outcome).toEqual({ rubric: "A table with every open invoice.", maxIterations: 2 });
    expect(result.cloud.monthlyCapUsd).toBe(50);
    expect(result.cloud.provider).toBe("ravi");
  });

  it("names secrets without being refused as a credential, and refuses values", () => {
    expect(issuesOf({ secrets: ["STRIPE_API_KEY"] })).toHaveLength(0);
    expect(paths({ secrets: ["lower-case-value"] })).toContain("cloud.secrets.0");
    expect(paths({ secrets: ["A"] })).toContain("cloud.secrets.0");
    expect(paths({ secrets: Array.from({ length: 21 }, (_, index) => `S${index}X`) })).toContain("cloud.secrets");
    // A nested `secrets` key is still a credential-looking key.
    expect(issuesOf({ tools: { secrets: ["X"] } }).some((issue) => issue.code === "credential_refused")).toBe(true);
    expect(
      issuesOf({ environment: { credentialFile: "x" } }).some((issue) => issue.code === "credential_refused"),
    ).toBe(true);
  });

  it("office true means all four skills, false none", () => {
    const all = validateCloudBlock({ tools: { office: true } });
    expect(all.ok && all.cloud.tools?.office).toEqual([...CLOUD_OFFICE_SKILLS]);
    const none = validateCloudBlock({ tools: { office: false } });
    expect(none.ok && none.cloud.tools?.office).toEqual([]);
    expect(paths({ tools: { office: ["xlsx", "keynote"] } })).toContain("cloud.tools.office.1");
  });

  it("refuses bad product values like the Console", () => {
    expect(paths({ environment: { placement: "edge" } })).toContain("cloud.environment.placement");
    expect(paths({ environment: { packages: { brew: ["x"] } } })).toContain("cloud.environment.packages.brew");
    expect(paths({ environment: { packages: { go: ["bad name"] } } })).toContain("cloud.environment.packages.go.0");
    expect(paths({ tools: { webFetch: "yes" } })).toContain("cloud.tools.webFetch");
    expect(paths({ tools: { askHuman: 1 } })).toContain("cloud.tools.askHuman");
    expect(
      paths({ tools: { web: { allowedDomains: ["a.example.com"], blockedDomains: ["b.example.com"] } } }),
    ).toContain("cloud.tools.web");
    expect(paths({ tools: { web: { allowedDomains: ["https://a.example.com"] } } })).not.toHaveLength(0);
    expect(paths({ tools: { web: { allowedDomains: ["A.Example.com"] } } })).toContain(
      "cloud.tools.web.allowedDomains.0",
    );
    expect(
      paths({ tools: { web: { blockedDomains: Array.from({ length: 51 }, (_, i) => `d${i}.example.com`) } } }),
    ).toContain("cloud.tools.web.blockedDomains");
    expect(paths({ tools: { web: { onlyHttps: true } } })).toContain("cloud.tools.web.onlyHttps");
    expect(paths({ memory: "team" })).toContain("cloud.memory");
    expect(paths({ outcome: { rubric: "" } })).toContain("cloud.outcome.rubric");
    expect(paths({ outcome: { rubric: "x".repeat(8001) } })).toContain("cloud.outcome.rubric");
    expect(paths({ outcome: { rubric: "ok", maxIterations: 6 } })).toContain("cloud.outcome.maxIterations");
    expect(paths({ outcome: { rubric: "ok", maxIterations: 1.5 } })).toContain("cloud.outcome.maxIterations");
    expect(paths({ outcome: { rubric: "ok", grader: "x" } })).toContain("cloud.outcome.grader");
    expect(paths({ monthlyCapUsd: 0 })).toContain("cloud.monthlyCapUsd");
    expect(paths({ monthlyCapUsd: 100_001 })).toContain("cloud.monthlyCapUsd");
    expect(paths({ monthlyCapUsd: "10" })).toContain("cloud.monthlyCapUsd");
    expect(paths({ provider: "openai" })).toContain("cloud.provider");
  });

  it("refuses workflows on an installation placement", () => {
    expect(paths({ environment: { placement: "installation" }, tools: { workflows: true } })).toContain(
      "cloud.tools.workflows",
    );
    expect(issuesOf({ environment: { placement: "cloud" }, tools: { workflows: true } })).toHaveLength(0);
  });

  it("keeps explicit nulls for memory, outcome and the cap, and defaults outcome iterations to 3", () => {
    const result = validateCloudBlock({ memory: null, outcome: null, monthlyCapUsd: null, provider: null });
    expect(result).toEqual({ ok: true, cloud: { memory: null, outcome: null, monthlyCapUsd: null } });
    const outcome = validateCloudBlock({ outcome: { rubric: "Done when the PR is green." } });
    expect(outcome.ok && outcome.cloud.outcome).toEqual({ rubric: "Done when the PR is green.", maxIterations: 3 });
  });
});
