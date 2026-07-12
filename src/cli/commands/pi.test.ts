import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProviderExtensionSource, parseListModelsTable, PiAuthCommands, PiModelsCommands } from "./pi.js";

describe("parseListModelsTable", () => {
  const sample = [
    "provider            model                                          context  max-out  thinking  images",
    "google              gemini-2.5-flash                               1.0M     65.5K    yes       yes   ",
    "google              gemini-1.5-flash                               1M       8.2K     no        yes   ",
    "groq                llama-3.3-70b                                  128K     32K      no        no    ",
    "",
  ].join("\n");

  it("parses provider/model rows and skips the header", () => {
    const rows = parseListModelsTable(sample);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
      context: "1.0M",
      maxOut: "65.5K",
      thinking: true,
      images: true,
    });
  });

  it("maps yes/no columns to booleans", () => {
    const rows = parseListModelsTable(sample);
    const flash15 = rows.find((r) => r.model === "gemini-1.5-flash")!;
    expect(flash15.thinking).toBe(false);
    expect(flash15.images).toBe(true);
    const groq = rows.find((r) => r.provider === "groq")!;
    expect(groq.thinking).toBe(false);
    expect(groq.images).toBe(false);
  });

  it("returns an empty list for empty or malformed output", () => {
    expect(parseListModelsTable("")).toEqual([]);
    expect(parseListModelsTable("some error line")).toEqual([]);
  });
});

describe("buildProviderExtensionSource", () => {
  const source = buildProviderExtensionSource({
    providerId: "zai-glm",
    modelId: "glm-5.2",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    api: "openai-completions",
    label: "z.ai GLM",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 8192,
  });

  it("marks the extension as managed so removal is safe", () => {
    expect(source).toContain("ravi-pi:managed");
  });

  it("registers the provider and model", () => {
    expect(source).toContain('pi.registerProvider("zai-glm"');
    expect(source).toContain('id: "glm-5.2"');
    expect(source).toContain("contextWindow: 200000");
    expect(source).toContain("reasoning: true");
  });

  it("stores the env var NAME, never a secret value", () => {
    expect(source).toContain('apiKey: "ZAI_API_KEY"');
    // the source only ever references the variable name; a real key would look like sk-...
    expect(source).not.toContain("sk-");
  });
});

describe("pi models add/remove + auth check (isolated pi home)", () => {
  let piHome: string;
  let prevAgentDir: string | undefined;
  let prevCommand: string | undefined;

  beforeEach(() => {
    piHome = mkdtempSync(join(tmpdir(), "ravi-pi-test-"));
    mkdirSync(join(piHome, "extensions"), { recursive: true });
    prevAgentDir = process.env.RAVI_PI_AGENT_DIR;
    prevCommand = process.env.RAVI_PI_COMMAND;
    process.env.RAVI_PI_AGENT_DIR = piHome;
    // /bin/echo exists everywhere and returns 0 with no model table -> resolvesNow=false, no crash
    process.env.RAVI_PI_COMMAND = "/bin/echo";
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.RAVI_PI_AGENT_DIR;
    else process.env.RAVI_PI_AGENT_DIR = prevAgentDir;
    if (prevCommand === undefined) delete process.env.RAVI_PI_COMMAND;
    else process.env.RAVI_PI_COMMAND = prevCommand;
    rmSync(piHome, { recursive: true, force: true });
  });

  it("writes a managed extension on add and deletes it on remove", () => {
    const models = new PiModelsCommands();
    const added = models.add(
      "zai-glm",
      "glm-5.2",
      "https://api.z.ai/api/paas/v4",
      "ZAI_API_KEY",
      undefined,
      undefined,
      "200000",
      "8192",
      true,
      undefined,
      undefined,
      true,
    );
    expect(added.created).toBe(true);
    expect(existsSync(added.extensionPath)).toBe(true);
    expect(readFileSync(added.extensionPath, "utf-8")).toContain("ravi-pi:managed");

    const removed = models.remove("zai-glm", true);
    expect(removed.removed).toBe(true);
    expect(existsSync(added.extensionPath)).toBe(false);
  });

  it("auth check reports auth.json keys and env vars without reading secret values", () => {
    writeFileSync(join(piHome, "auth.json"), JSON.stringify({ zai: { token: "sk-should-not-be-read" } }), "utf-8");
    const auth = new PiAuthCommands();

    const zai = auth.check("zai", true);
    expect(zai.authenticated).toBe(true);
    expect(zai.source).toBe("auth.json");

    const unknown = auth.check("nope", true);
    expect(unknown.authenticated).toBe(false);
    expect(unknown.source).toBe("none");
  });
});
