import { describe, expect, test } from "bun:test";

import { projectOwnedPagesSlug } from "./project-owned";

describe("project-owned Ravi Pages slug", () => {
  test("uses organization-project ordering for the default hosted slug", () => {
    expect(projectOwnedPagesSlug({ organizationSlug: "rbbt", projectSlug: "core" })).toBe("rbbt-core");
    expect(projectOwnedPagesSlug({ organizationSlug: "luis", projectSlug: "core" })).toBe("luis-core");
  });
});
