import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildRuntimeCredentialProfileEnv } from "./runtime-request-builder.js";

describe("buildRuntimeCredentialProfileEnv", () => {
  it("leaves the default Claude profile implicit so the normal login is found", () => {
    expect(buildRuntimeCredentialProfileEnv("claude", { authProfileRef: "~/.claude" }, {})).toBeUndefined();
    expect(
      buildRuntimeCredentialProfileEnv("claude", { authProfileRef: join(homedir(), ".claude") }, {}),
    ).toBeUndefined();
    expect(
      buildRuntimeCredentialProfileEnv("claude", { authProfileRef: `${join(homedir(), ".claude")}/` }, {}),
    ).toBeUndefined();
  });

  it("names a non-default Claude profile explicitly", () => {
    expect(buildRuntimeCredentialProfileEnv("claude", { authProfileRef: "/tmp/claude-profile" }, {})).toEqual({
      CLAUDE_CONFIG_DIR: "/tmp/claude-profile",
    });
  });

  it("names the default profile when the daemon itself runs under another config dir", () => {
    expect(
      buildRuntimeCredentialProfileEnv(
        "claude",
        { authProfileRef: "~/.claude" },
        { CLAUDE_CONFIG_DIR: "/tmp/other-claude" },
      ),
    ).toEqual({ CLAUDE_CONFIG_DIR: join(homedir(), ".claude") });
  });

  it("keeps naming the Codex home", () => {
    expect(buildRuntimeCredentialProfileEnv("codex", { authProfileRef: "~/.codex" }, {})).toEqual({
      CODEX_HOME: join(homedir(), ".codex"),
    });
  });

  it("returns nothing without a profile reference", () => {
    expect(buildRuntimeCredentialProfileEnv("claude", undefined, {})).toBeUndefined();
    expect(buildRuntimeCredentialProfileEnv("claude", { authProfileRef: "  " }, {})).toBeUndefined();
  });
});
