import { describe, expect, test } from "bun:test";

import { isRedesignedPath, orgSectionFromPath, projectSectionFromPath, projectSwitchHref } from "./routes";

describe("console shell routes", () => {
  test("only hidden legacy screens keep the legacy frame", () => {
    for (const path of ["/projects", "/connectors", "/bugs/1", "/mcp/authorize", "/org/settings", "/org/members", "/org/billing"]) {
      expect(isRedesignedPath(path)).toBe(true);
    }
    for (const path of ["/p/a", "/p/a/pages", "/p/a/bases/tasks/schema", "/p/a/meetings/m1", "/p/a/cloud/runs/r1", "/p/a/settings/activity"]) {
      expect(isRedesignedPath(path)).toBe(true);
    }
    for (const path of ["/p/a/knowledge", "/p/a/mail/inbox", "/p/a/runs", "/org/control"]) {
      expect(isRedesignedPath(path)).toBe(false);
    }
  });

  test("unknown paths render on the new UI so they get its not-found", () => {
    expect(isRedesignedPath("/p/a/nope")).toBe(true);
    expect(isRedesignedPath("/org/nope")).toBe(true);
  });

  test("switching projects keeps the section when every project has it", () => {
    expect(projectSectionFromPath("/p/a")).toBe("overview");
    expect(projectSwitchHref("/p/a/bases/tasks", "b")).toBe("/p/b/bases");
    expect(projectSwitchHref("/p/a/meetings/m1", "b")).toBe("/p/b/meetings");
    expect(projectSwitchHref("/p/a/library/org/tom", "b")).toBe("/p/b/library");
    expect(projectSwitchHref("/p/a/cloud/runs/r1", "b")).toBe("/p/b/cloud");
    expect(projectSwitchHref("/p/a/settings/activity", "b")).toBe("/p/b/settings");
    expect(projectSwitchHref("/p/a/knowledge", "b")).toBe("/p/b");
  });

  test("organization tabs: projects, members, library and settings", () => {
    expect(orgSectionFromPath("/projects")).toBe("projects");
    expect(orgSectionFromPath("/projects/new")).toBe("projects");
    expect(orgSectionFromPath("/org/members")).toBe("members");
    expect(orgSectionFromPath("/org/library")).toBe("library");
    expect(orgSectionFromPath("/org/library/org/tom-de-voz")).toBe("library");
    for (const path of ["/org/settings", "/org/onboarding", "/org/sso", "/org/credentials", "/org/installations", "/org/permissions", "/org/domains", "/org/connectors", "/org/billing", "/org/audit"]) {
      expect(orgSectionFromPath(path)).toBe("settings");
    }
    for (const path of ["/org", "/connectors", "/p/a", "/bugs"]) {
      expect(orgSectionFromPath(path)).toBeUndefined();
    }
  });
});
