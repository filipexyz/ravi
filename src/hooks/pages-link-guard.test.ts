import { describe, expect, it } from "bun:test";

import { createPagesLinkGuardHook, pagesLinkGuardReason } from "./pages-link-guard.js";

describe("pagesLinkGuardReason", () => {
  it("denies WebFetch and browser navigation to a Ravi Page", () => {
    expect(pagesLinkGuardReason("WebFetch", { url: "https://acme.ravi.page/x", prompt: "read" })).toContain(
      "ravi pages read https://acme.ravi.page/x",
    );
    expect(pagesLinkGuardReason("mcp__playwright__browser_navigate", { url: "https://acme.ravi.page/" })).toContain(
      "ravi pages read",
    );
  });

  it("denies a shell fetch of a Ravi Page in command position", () => {
    expect(pagesLinkGuardReason("Bash", { command: "curl -s https://acme.ravi.page/weekly | head" })).toContain(
      "ravi pages read https://acme.ravi.page/weekly",
    );
    expect(pagesLinkGuardReason("Bash", { command: "cd /tmp && sudo wget https://acme.ravi.page/x" })).not.toBeNull();
    expect(pagesLinkGuardReason("Bash", { command: "echo $(curl https://acme.ravi.page/x)" })).not.toBeNull();
  });

  it("leaves everything else alone", () => {
    expect(pagesLinkGuardReason("WebFetch", { url: "https://example.com/" })).toBeNull();
    expect(pagesLinkGuardReason("Bash", { command: "ravi pages read https://acme.ravi.page/weekly" })).toBeNull();
    expect(pagesLinkGuardReason("Bash", { command: "echo https://acme.ravi.page/" })).toBeNull();
    expect(pagesLinkGuardReason("Bash", { command: "echo 'curl https://acme.ravi.page/'" })).toBeNull();
    expect(pagesLinkGuardReason("Bash", { command: "ls # curl https://acme.ravi.page/" })).toBeNull();
    expect(pagesLinkGuardReason("Read", { url: "https://acme.ravi.page/" })).toBeNull();
  });
});

describe("createPagesLinkGuardHook", () => {
  it("answers a PreToolUse deny for a Page fetch and nothing otherwise", async () => {
    const [hook] = createPagesLinkGuardHook().hooks;
    const call = (tool_name: string, tool_input: unknown) =>
      hook({ hook_event_name: "PreToolUse", tool_name, tool_input } as never, null, {
        signal: new AbortController().signal,
      });
    expect(await call("WebFetch", { url: "https://acme.ravi.page/x" })).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect(await call("WebFetch", { url: "https://example.com/" })).toEqual({});
  });
});
