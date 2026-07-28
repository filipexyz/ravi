import { describe, expect, it } from "bun:test";
import { buildRuntimeToolPresentation } from "./tool-presentation.js";

describe("runtime tool presentation", () => {
  it("uses canonical built-in metadata and sanitizes local command context", () => {
    const presentation = buildRuntimeToolPresentation("shell", {
      command: "git -C /Users/operator/private status --short token=provider-secret-value",
    });

    expect(presentation).toMatchObject({
      title: "Run a local shell command",
      category: "exec.shell",
      operation: "execute",
      risk: "high",
    });
    expect(presentation.summary).toContain("git");
    expect(presentation.summary).toContain("[local path]");
    expect(presentation.summary).toContain("token=[redacted]");
    expect(JSON.stringify(presentation)).not.toContain("/Users/operator");
    expect(JSON.stringify(presentation)).not.toContain("provider-secret-value");
  });

  it("uses the registered dynamic tool description and semantic access metadata", () => {
    const presentation = buildRuntimeToolPresentation("sessions_read", {
      name: "sessions_read",
      args: {
        nameOrKey: "ravi-message",
        count: 20,
        workspace: true,
      },
    });

    expect(presentation).toMatchObject({
      title: "Read message history of a session (normalized)",
      category: "sessions",
      operation: "read",
      risk: "low",
    });
    expect(presentation.parameters).toEqual(
      expect.arrayContaining([
        {
          name: "nameOrKey",
          value: "ravi-message",
        },
        {
          name: "count",
          value: "20",
        },
        {
          name: "workspace",
          value: "true",
        },
      ]),
    );
    expect(presentation.summary).toContain("nameOrKey=ravi-message");
    expect(presentation.summary).toContain("count=20");
  });

  it("fails closed for sensitive and local-path built-in parameters", () => {
    const presentation = buildRuntimeToolPresentation("shell", {
      apiKey: "sk-sensitive-value",
      workspacePath: "/Users/operator/project",
      visible: "safe",
    });

    expect(presentation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "apiKey",
          redacted: true,
        }),
        expect.objectContaining({
          name: "workspacePath",
          redacted: true,
        }),
        expect.objectContaining({
          name: "visible",
          value: "safe",
        }),
      ]),
    );
    expect(JSON.stringify(presentation)).not.toContain("sk-sensitive-value");
    expect(JSON.stringify(presentation)).not.toContain("/Users/operator/project");
  });

  it("does not project invocation values for an unregistered tool", () => {
    const presentation = buildRuntimeToolPresentation("Unknown Tool", {
      visible: "must-not-cross-without-metadata",
    });

    expect(presentation).toEqual({
      title: "unknown-tool",
    });
    expect(JSON.stringify(presentation)).not.toContain("must-not-cross-without-metadata");
  });
});
