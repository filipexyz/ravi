import { describe, expect, it } from "bun:test";

import { shouldSuppressCodexStderrLine } from "./codex-transport.js";

describe("codex transport stderr filtering", () => {
  it("suppresses known benign Codex skill icon warnings", () => {
    expect(
      shouldSuppressCodexStderrLine(
        "2026-05-31T16:28:00.000Z WARN codex_core_skills::loader: ignoring interface.icon_small: icon path must not contain '..'",
      ),
    ).toBe(true);
    expect(
      shouldSuppressCodexStderrLine(
        "2026-05-31T16:28:00.000Z WARN codex_core_skills::loader: ignoring interface.icon_large: icon path must not contain '..'",
      ),
    ).toBe(true);
  });

  it("keeps unrelated WARN and ERROR lines visible", () => {
    expect(shouldSuppressCodexStderrLine("WARN codex_core: provider request failed")).toBe(false);
    expect(shouldSuppressCodexStderrLine("ERROR codex_core: transport closed")).toBe(false);
  });

  it("suppresses benign Codex MCP process group cleanup warnings", () => {
    expect(
      shouldSuppressCodexStderrLine(
        "2026-05-31T16:42:03.973649Z  WARN codex_rmcp_client::stdio_server_launcher: Failed to terminate MCP process group 23646: Operation not permitted (os error 1)",
      ),
    ).toBe(true);
    expect(
      shouldSuppressCodexStderrLine(
        "2026-05-31T16:42:42.751501Z  WARN codex_rmcp_client::stdio_server_launcher: Failed to kill MCP process group 25383: No such process (os error 3)",
      ),
    ).toBe(true);
  });
});
