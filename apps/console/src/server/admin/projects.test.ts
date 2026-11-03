import { describe, expect, it } from "bun:test";

import { projectMoveProjectScopedTables } from "./projects";

describe("projectMoveProjectScopedTables", () => {
  it("covers project-owned denormalized tables without rewriting audit history", () => {
    expect(projectMoveProjectScopedTables).toContain("page_sites");
    expect(projectMoveProjectScopedTables).toContain("page_comments");
    expect(projectMoveProjectScopedTables).toContain("knowledge_sources");
    expect(projectMoveProjectScopedTables).toContain("knowledge_proposals");
    expect(projectMoveProjectScopedTables).toContain("managed_execution_harnesses");
    expect(projectMoveProjectScopedTables).toContain("mcp_bridges");
    expect(projectMoveProjectScopedTables).not.toContain("audit_events");
  });
});
