import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CONSOLE_TOP_LEVEL_SEGMENTS,
  isOrgScopedAppPath,
  orgFromPath,
  orgPath,
  orgSegment,
  parseOrgPath,
} from "./console-paths";

describe("console paths", () => {
  test("app paths become URLs of the organization", () => {
    expect(orgPath("acme", "/projects")).toBe("/acme");
    expect(orgPath("acme", "/projects?githubSetup=invalid_state")).toBe("/acme?githubSetup=invalid_state");
    expect(orgPath("acme", "/projects/new")).toBe("/acme/projects/new");
    expect(orgPath("acme", "/org/members")).toBe("/acme/members");
    expect(orgPath("acme", "/org/library/org/rounds/proposals/1?kind=agent")).toBe(
      "/acme/library/org/rounds/proposals/1?kind=agent",
    );
    expect(orgPath("acme", "/p/123/pages?page=r1#top")).toBe("/acme/p/123/pages?page=r1#top");
    expect(orgPath("acme", "/p/123/meetings/m1?t=83.4")).toBe("/acme/p/123/meetings/m1?t=83.4");
  });

  test("paths outside an organization stay as they are", () => {
    for (const path of ["/org", "/org?select=denied", "/bugs/1", "/connectors", "/link", "/logout", "https://docs.ravi.bot"]) {
      expect(orgPath("acme", path)).toBe(path);
    }
  });

  test("organization URLs are not prefixed twice", () => {
    for (const url of ["/acme", "/acme/members", "/acme/p/123/pages", "/other/p/1"]) {
      expect(orgPath("acme", url)).toBe(url);
    }
  });

  test("URLs read back into the organization and the app path", () => {
    expect(parseOrgPath("/acme")).toEqual({ org: "acme", path: "/projects" });
    expect(parseOrgPath("/acme?x=1")).toEqual({ org: "acme", path: "/projects?x=1" });
    expect(parseOrgPath("/acme/projects/new")).toEqual({ org: "acme", path: "/projects/new" });
    expect(parseOrgPath("/acme/members")).toEqual({ org: "acme", path: "/org/members" });
    expect(parseOrgPath("/acme/p/1/settings/activity")).toEqual({ org: "acme", path: "/p/1/settings/activity" });
    expect(parseOrgPath("/p/1/pages")).toEqual({ org: null, path: "/p/1/pages" });
    expect(parseOrgPath("/bugs/1")).toEqual({ org: null, path: "/bugs/1" });
    expect(parseOrgPath("/")).toEqual({ org: null, path: "/" });
    expect(orgFromPath("/acme/library")).toBe("acme");
  });

  test("every app path survives the round trip", () => {
    for (const path of ["/projects", "/projects/new", "/org/settings", "/org/library/directory", "/p/1", "/p/1/bases/tasks/schema"]) {
      expect(parseOrgPath(orgPath("acme", path))).toEqual({ org: "acme", path });
      expect(isOrgScopedAppPath(path)).toBe(true);
    }
    expect(isOrgScopedAppPath("/org")).toBe(false);
    expect(isOrgScopedAppPath("/bugs")).toBe(false);
  });

  test("an organization whose slug is a Console path is addressed by id", () => {
    expect(orgSegment({ id: "0b5c", slug: "acme" })).toBe("acme");
    expect(orgSegment({ id: "0b5c", slug: "connectors" })).toBe("0b5c");
    expect(orgSegment({ id: "0b5c", slug: "bugs" })).toBe("0b5c");
    expect(orgSegment({ id: "0b5c" })).toBe("0b5c");
  });

  test("every first segment the app serves is reserved from organizations", () => {
    const appDir = join(import.meta.dir, "..", "app");
    const served = new Set<string>();
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (!statSync(join(dir, entry)).isDirectory()) continue;
        if (entry.startsWith("(") && entry.endsWith(")")) collect(join(dir, entry));
        else if (!entry.startsWith("[") && !entry.startsWith("_")) served.add(entry);
      }
    };
    collect(appDir);
    expect([...served].filter((segment) => !CONSOLE_TOP_LEVEL_SEGMENTS.has(segment))).toEqual([]);
  });
});
