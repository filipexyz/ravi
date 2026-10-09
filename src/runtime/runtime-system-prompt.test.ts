import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildRuntimeSystemPrompt, type RuntimeSystemPromptInput } from "./runtime-system-prompt.js";
import { addSticker } from "../stickers/catalog.js";
import { dbCreateAgent, dbUpdateAgent, type ContextCapability } from "../router/router-db.js";
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

describe("buildRuntimeSystemPrompt", () => {
  it("renders workspace and agent contexts as plain Markdown sections", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    try {
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n\nUse the local project rules.\n");

      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        sessionName: "dev",
        agent: {
          id: "main",
          cwd,
          systemPromptAppend: "Prefer concise operational answers.",
        },
        ctx: {
          channelId: "whatsapp-baileys",
          channelName: "WhatsApp",
          isGroup: false,
        },
      });

      expect(prompt.sections.map((section) => section.id)).toContain("workspace.instructions");
      expect(prompt.sections.map((section) => section.id)).toContain("agent.system_prompt_append");
      expect(prompt.sections.map((section) => section.id)).toContain("runtime.operational_context");
      expect(prompt.text).toContain("## Ravi Operational Context");
      expect(prompt.text).toContain("- agent: `main`");
      expect(prompt.text).toContain("- session: `dev`");
      expect(prompt.text).toContain("`ravi self permissions --json`");
      expect(prompt.text).toContain("## Workspace Instructions");
      expect(prompt.text).toContain(`Workspace instructions loaded from ${join(cwd, "AGENTS.md")}`);
      expect(prompt.text).toContain("Use the local project rules.");
      expect(prompt.text).toContain("## Agent Instructions");
      expect(prompt.text).toContain("Prefer concise operational answers.");
      expect(prompt.text).toContain("## Session Boundary");
      expect(prompt.text).not.toContain('"workspace.instructions"');
      expect(prompt.text).not.toContain('"agent.system_prompt_append"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("renders bounded runtime capabilities without exposing context keys", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    try {
      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        sessionName: "ops",
        agent: { id: "main", cwd },
        runtimeContext: {
          contextId: "ctx_visible",
          kind: "agent-runtime",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionName: "ops",
          source: { channel: "whatsapp", accountId: "main", chatId: "chat_123" },
          capabilities: [
            { permission: "use", objectType: "tool", objectId: "Bash", source: "test" },
            { permission: "execute", objectType: "group", objectId: "sessions", source: "test" },
          ],
        },
      });

      expect(prompt.text).toContain("`ctx_visible` (agent-runtime)");
      expect(prompt.text).toContain("- capabilities: 2");
      expect(prompt.text).toContain("`use:tool:Bash source=test`");
      expect(prompt.text).toContain("`execute:group:sessions source=test`");
      expect(prompt.text).not.toContain("rctx_");
      expect(prompt.text).not.toContain("contextKey");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("injects .ravi/rules as an ordered Ravi Rules section", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    try {
      const rulesDir = join(cwd, ".ravi", "rules");
      mkdirSync(join(rulesDir, "vault"), { recursive: true });
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n\nUse the local project rules.\n");
      writeFileSync(join(rulesDir, ".gitkeep"), "");
      writeFileSync(join(rulesDir, "01-project-tracking.md"), "Always update project tracking.\n");
      writeFileSync(join(rulesDir, "02-task-profiles.md"), "Honor task profiles.\n");
      writeFileSync(join(rulesDir, "03-extensionless"), "Accept extensionless text rules.\n");
      writeFileSync(join(rulesDir, "04-binary.md"), Buffer.from([0, 1, 2, 3]));
      writeFileSync(join(rulesDir, "05-generated.json"), '{"ignored":true}\n');
      writeFileSync(join(rulesDir, "vault", "frontmatter-standard.md"), "Validate vault frontmatter.\n");

      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: {
          id: "main",
          cwd,
          systemPromptAppend: "Prefer concise operational answers.",
        },
      });

      const sectionIds = prompt.sections.map((section) => section.id);
      expect(sectionIds).toContain("workspace.instructions");
      expect(sectionIds).toContain("ravi.rules");
      expect(sectionIds).toContain("agent.system_prompt_append");

      const rulesSection = prompt.sections.find((section) => section.id === "ravi.rules");
      expect(rulesSection).toMatchObject({
        title: "Ravi Rules",
        priority: 30,
        source: rulesDir,
      });

      expect(prompt.text).toContain("## Ravi Rules");
      expect(prompt.text).toContain(`Ravi rules loaded from ${rulesDir}.`);
      expect(prompt.text).toContain("### 01-project-tracking.md");
      expect(prompt.text).toContain("Always update project tracking.");
      expect(prompt.text).toContain("### 02-task-profiles.md");
      expect(prompt.text).toContain("Honor task profiles.");
      expect(prompt.text).toContain("### 03-extensionless");
      expect(prompt.text).toContain("Accept extensionless text rules.");
      expect(prompt.text).toContain("### vault/frontmatter-standard.md");
      expect(prompt.text).toContain("Validate vault frontmatter.");
      expect(prompt.text).not.toContain(".gitkeep");
      expect(prompt.text).not.toContain("04-binary.md");
      expect(prompt.text).not.toContain("05-generated.json");

      expect(prompt.text.indexOf("## Workspace Instructions")).toBeLessThan(prompt.text.indexOf("## Ravi Rules"));
      expect(prompt.text.indexOf("## Ravi Rules")).toBeLessThan(prompt.text.indexOf("## Agent Instructions"));
      expect(prompt.text).not.toContain('"ravi.rules"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not inject Ravi Rules when .ravi/rules is missing or empty", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    try {
      const missingPrompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd },
      });
      expect(missingPrompt.sections.map((section) => section.id)).not.toContain("ravi.rules");
      expect(missingPrompt.text).not.toContain("## Ravi Rules");

      mkdirSync(join(cwd, ".ravi", "rules"), { recursive: true });
      const emptyPrompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd },
      });
      expect(emptyPrompt.sections.map((section) => section.id)).not.toContain("ravi.rules");
      expect(emptyPrompt.text).not.toContain("## Ravi Rules");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("buildRuntimeSystemPrompt stickers", () => {
  it("includes sticker ids only for sticker-capable channels with agent opt-in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-runtime-stickers-"));
    const previousStateDir = process.env.RAVI_STATE_DIR;
    const mediaPath = join(stateDir, "wave.webp");
    try {
      process.env.RAVI_STATE_DIR = stateDir;
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n");
      writeFileSync(mediaPath, "webp");
      addSticker({
        id: "wave",
        label: "Wave",
        description: "Use for a friendly hello.",
        avoid: "Avoid during serious incidents.",
        channels: ["whatsapp"],
        agents: ["main"],
        media: { kind: "file", path: mediaPath },
        enabled: true,
      });

      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        sessionName: "dev",
        agent: {
          id: "main",
          cwd,
          defaults: { stickers: { enabled: true } },
        },
        ctx: {
          channelId: "whatsapp-baileys",
          channelName: "WhatsApp",
          isGroup: false,
        },
      });

      const sectionIds = prompt.sections.map((section) => section.id);
      expect(sectionIds).toContain("channel.stickers");
      expect(sectionIds).toEqual(
        expect.arrayContaining(["channel.output_formatting", "channel.reactions", "channel.stickers"]),
      );
      expect(sectionIds.indexOf("channel.reactions")).toBeLessThan(sectionIds.indexOf("channel.stickers"));
      expect(prompt.text).toContain("## Stickers");
      expect(prompt.text).toContain("`wave`");
      expect(prompt.text).toContain("ravi stickers send <id>");
      expect(prompt.text).not.toContain(mediaPath);
      expect(prompt.text).not.toContain('"media"');
      expect(prompt.text).not.toContain("base64");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.RAVI_STATE_DIR;
      } else {
        process.env.RAVI_STATE_DIR = previousStateDir;
      }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("excludes stickers when the channel lacks capability or the agent has not opted in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-runtime-stickers-"));
    const previousStateDir = process.env.RAVI_STATE_DIR;
    const mediaPath = join(stateDir, "wave.webp");
    try {
      process.env.RAVI_STATE_DIR = stateDir;
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n");
      writeFileSync(mediaPath, "webp");
      addSticker({
        id: "wave",
        label: "Wave",
        description: "Use for a friendly hello.",
        channels: ["whatsapp"],
        agents: [],
        media: { kind: "file", path: mediaPath },
        enabled: true,
      });

      const matrixPrompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd, defaults: { stickers: { enabled: true } } },
        ctx: {
          channelId: "matrix",
          channelName: "Matrix",
          isGroup: false,
        },
      });
      const disabledPrompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd },
        ctx: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          isGroup: false,
        },
      });

      expect(matrixPrompt.sections.map((section) => section.id)).not.toContain("channel.stickers");
      expect(matrixPrompt.text).not.toContain("ravi stickers send");
      expect(disabledPrompt.sections.map((section) => section.id)).not.toContain("channel.stickers");
      expect(disabledPrompt.text).not.toContain("ravi stickers send");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.RAVI_STATE_DIR;
      } else {
        process.env.RAVI_STATE_DIR = previousStateDir;
      }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("allows session runtime params to opt in to sticker prompts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-runtime-stickers-"));
    const previousStateDir = process.env.RAVI_STATE_DIR;
    const mediaPath = join(stateDir, "wave.webp");
    try {
      process.env.RAVI_STATE_DIR = stateDir;
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n");
      writeFileSync(mediaPath, "webp");
      addSticker({
        id: "wave",
        label: "Wave",
        description: "Use for a friendly hello.",
        channels: ["whatsapp"],
        agents: [],
        media: { kind: "file", path: mediaPath },
        enabled: true,
      });

      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd },
        sessionRuntimeParams: { stickers: { enabled: true } },
        ctx: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          isGroup: false,
        },
      });

      expect(prompt.sections.map((section) => section.id)).toContain("channel.stickers");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.RAVI_STATE_DIR;
      } else {
        process.env.RAVI_STATE_DIR = previousStateDir;
      }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("buildRuntimeSystemPrompt Building Solutions", () => {
  const ROUTING_LINE =
    "- A screen, intake or approval over shared data (more than one piece) → Building Solutions above; cron is one piece of it.";
  let stateDir: string | null = null;
  let cwd = "";

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-building-solutions-");
    cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
  });

  afterEach(async () => {
    rmSync(cwd, { recursive: true, force: true });
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function profileCapabilities(agentId: string, profile?: "chat-only" | "full-access"): ContextCapability[] {
    dbCreateAgent({ id: agentId, cwd });
    if (profile) {
      dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile } } });
    }
    return materializeSubjectCapabilities("agent", agentId);
  }

  async function promptFor(
    capabilities: ContextCapability[] | null,
    overrides: Partial<Pick<RuntimeSystemPromptInput, "allowedSkills">> & { mode?: "active" | "sentinel" } = {},
  ) {
    return buildRuntimeSystemPrompt({
      cwd,
      sessionName: "builder",
      agent: { id: "builder", cwd, ...(overrides.mode ? { mode: overrides.mode } : {}) },
      ctx: { channelId: "whatsapp-baileys", channelName: "WhatsApp", isGroup: false },
      ...(capabilities
        ? { runtimeContext: { contextId: "ctx_builder", kind: "agent-runtime", agentId: "builder", capabilities } }
        : {}),
      ...(overrides.allowedSkills ? { allowedSkills: overrides.allowedSkills } : {}),
    });
  }

  function expectMounted(prompt: { text: string; sections: { id: string }[] }, mounted: boolean): void {
    expect(prompt.sections.some((section) => section.id === "solutions.building")).toBe(mounted);
    expect(prompt.text.includes("## Building Solutions\n\nWhen a request combines pieces")).toBe(mounted);
    expect(prompt.text.includes(ROUTING_LINE)).toBe(mounted);
  }

  it("mounts the section and its Routing line for a full-access agent", async () => {
    const prompt = await promptFor(profileCapabilities("builder", "full-access"));

    expectMounted(prompt, true);
    const ids = prompt.sections.map((section) => section.id);
    expect(ids.indexOf("solutions.building")).toBe(ids.indexOf("automation.background_followups") - 1);
    expect(prompt.text.indexOf("## Building Solutions")).toBeLessThan(
      prompt.text.indexOf("## Background Followup Automation"),
    );
  });

  it("mounts it for one specific bases, pages, triggers or cron capability, including subcommand groups", async () => {
    const skillsShow = { permission: "read", objectType: "skills", objectId: "show" };
    for (const capability of [
      { permission: "execute", objectType: "group", objectId: "bases_rows" },
      { permission: "execute", objectType: "group", objectId: "pages" },
      { permission: "execute", objectType: "group", objectId: "triggers_add" },
      { permission: "execute", objectType: "group", objectId: "cron" },
    ]) {
      expectMounted(await promptFor([capability, skillsShow]), true);
    }
    expectMounted(await promptFor([{ permission: "execute", objectType: "group", objectId: "*" }]), true);
  });

  it("leaves it out when the context cannot run ravi skills show", async () => {
    expectMounted(
      await promptFor([
        { permission: "use", objectType: "tool", objectId: "Bash" },
        { permission: "execute", objectType: "executable", objectId: "ravi" },
        { permission: "execute", objectType: "group", objectId: "bases_rows" },
      ]),
      false,
    );
  });

  it("leaves it out for a sentinel even with full access", async () => {
    expectMounted(await promptFor(profileCapabilities("builder", "full-access"), { mode: "sentinel" }), false);
  });

  it("leaves it out for chat-only, bootstrap and unrelated capabilities", async () => {
    expectMounted(await promptFor(profileCapabilities("reception", "chat-only")), false);
    expectMounted(await promptFor(profileCapabilities("plain")), false);
    expectMounted(
      await promptFor([
        { permission: "use", objectType: "tool", objectId: "Bash" },
        { permission: "execute", objectType: "group", objectId: "sessions" },
        { permission: "execute", objectType: "group", objectId: "contacts" },
      ]),
      false,
    );
  });

  it("leaves it out when the context carries no capabilities at all", async () => {
    expectMounted(await promptFor([]), false);
    expectMounted(await promptFor(null), false);
  });

  it("follows solucoes visibility in the skill allowlist", async () => {
    const capabilities = profileCapabilities("builder", "full-access");

    expectMounted(await promptFor(capabilities, { allowedSkills: ["ravi-system-bases", "bases"] }), false);
    expectMounted(await promptFor(capabilities, { allowedSkills: ["bases", "solucoes"] }), true);
    expectMounted(await promptFor(capabilities, { allowedSkills: ["ravi-system-solucoes"] }), true);
  });
});
