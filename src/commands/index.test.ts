import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverRaviCommands,
  expandRaviCommandPrompt,
  parseRaviCommandInvocation,
  renderRaviCommand,
  resolveRaviCommand,
  RaviCommandError,
} from "./index.js";
import type { AgentConfig } from "../router/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ravi-commands-test-"));
}

function writeCommand(root: string, relativePath: string, content: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("Ravi Commands", () => {
  it("parses only command invocations at the first non-whitespace character", () => {
    expect(parseRaviCommandInvocation("  #review-pr 123 high")).toMatchObject({
      kind: "command",
      id: "review-pr",
      rawArguments: "123 high",
    });
    expect(parseRaviCommandInvocation("please #review-pr 123")).toEqual({ kind: "none" });
    expect(parseRaviCommandInvocation("#bad_name")).toMatchObject({
      kind: "invalid",
    });
  });

  it("discovers agent and global commands with agent shadowing", () => {
    const agentCwd = tempDir();
    const raviHome = tempDir();
    writeCommand(agentCwd, ".ravi/commands/review.md", "---\ndescription: Agent review\n---\nAgent body");
    writeCommand(raviHome, "commands/review.md", "---\ndescription: Global review\n---\nGlobal body");
    writeCommand(raviHome, "commands/notes.md", "Global notes");

    const registry = discoverRaviCommands({ agentCwd, env: { RAVI_HOME: raviHome } as NodeJS.ProcessEnv });

    expect(registry.commands.map((command) => `${command.scope}:${command.id}`)).toEqual([
      "global:notes",
      "agent:review",
    ]);
    const review = registry.commands.find((command) => command.id === "review");
    expect(review?.description).toBe("Agent review");
    expect(review?.shadows).toHaveLength(1);
  });

  it("reports duplicate command ids inside the same scope", () => {
    const agentCwd = tempDir();
    const raviHome = tempDir();
    writeCommand(agentCwd, ".ravi/commands/review.md", "Root review");
    writeCommand(agentCwd, ".ravi/commands/nested/review.md", "Nested review");

    const registry = discoverRaviCommands({ agentCwd, env: { RAVI_HOME: raviHome } as NodeJS.ProcessEnv });

    expect(registry.issues.some((issue) => issue.code === "duplicate_command" && issue.level === "error")).toBe(true);
    expect(() => resolveRaviCommand(registry, "review")).toThrow(RaviCommandError);
  });

  it("renders raw, positional and named arguments", () => {
    const agentCwd = tempDir();
    const raviHome = tempDir();
    writeCommand(
      agentCwd,
      ".ravi/commands/review.md",
      "---\narguments:\n  - pr\n  - priority\n---\nReview $pr as $priority. Raw=$ARGUMENTS first=$ARGUMENTS[0] shorthand=$1",
    );
    const registry = discoverRaviCommands({ agentCwd, env: { RAVI_HOME: raviHome } as NodeJS.ProcessEnv });
    const command = resolveRaviCommand(registry, "review")!;
    const rendered = renderRaviCommand(command, {
      id: "review",
      token: "#review",
      rawArguments: '123 "very high"',
      originalText: '#review 123 "very high"',
    });

    expect(rendered.prompt).toContain("Review 123 as very high.");
    expect(rendered.prompt).toContain('Raw=123 "very high"');
    expect(rendered.prompt).toContain("first=123");
    expect(rendered.prompt).toContain("shorthand=very high");
    expect(rendered.metadata.id).toBe("review");
    expect(rendered.metadata.renderedPromptSha256).toHaveLength(64);
  });

  it("expands command prompts and leaves normal prompts unchanged", () => {
    const agentCwd = tempDir();
    const raviHome = tempDir();
    writeCommand(agentCwd, ".ravi/commands/summarize.md", "Summarize $ARGUMENTS");
    const agent: AgentConfig = { id: "dev", cwd: agentCwd };

    const normal = { prompt: "hello" };
    expect(expandRaviCommandPrompt(normal, { agent, env: { RAVI_HOME: raviHome } as NodeJS.ProcessEnv })).toBe(normal);

    const expanded = expandRaviCommandPrompt(
      { prompt: "#summarize logs" },
      { agent, env: { RAVI_HOME: raviHome } as NodeJS.ProcessEnv },
    );
    expect(expanded.prompt).toContain("## Ravi Command: #summarize");
    expect(expanded.prompt).toContain("Summarize logs");
    expect(expanded.commands?.[0]?.id).toBe("summarize");
  });

  it("passes unknown commands through as normal prompts", () => {
    const agentCwd = tempDir();
    const raviHome = tempDir();
    const agent: AgentConfig = { id: "dev", cwd: agentCwd };
    const prompt = { prompt: "#missing-command keep this as chat" };

    expect(expandRaviCommandPrompt(prompt, { agent, env: { RAVI_HOME: raviHome } as NodeJS.ProcessEnv })).toBe(prompt);
  });
});
