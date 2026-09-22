import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import {
  buildAuthorizationGuidance,
  buildRecurringAllowCommand,
  formatAuthorizationGuidanceLines,
} from "./authorization-guidance.js";

let stateDir: string | null = null;

describe("authorization guidance", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-authorization-guidance-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("lists the full candidate set and a concrete permissions allow command", () => {
    const guidance = buildAuthorizationGuidance({
      capability: { permission: "mutate", objectType: "pages", objectId: "ship" },
      candidates: [
        { permission: "mutate", objectType: "pages", objectId: "ship" },
        { permission: "mutate", objectType: "pages", objectId: "*" },
        { permission: "execute", objectType: "group", objectId: "pages" },
      ],
      subject: { type: "agent", id: "dev" },
      scope: "recurring",
      includeProviderOwnedTags: true,
    });

    expect(guidance.canonicalCapability).toBe("mutate:pages:ship");
    expect(guidance.candidateCapabilities).toEqual(["mutate:pages:ship", "mutate:pages:*", "execute:group:pages"]);
    expect(guidance.preferredPath.allowCommand).toBe(
      "ravi permissions allow permission-mutate-pages-ship --to agent:dev --capabilities mutate:pages:ship --apply",
    );
    expect(formatAuthorizationGuidanceLines(guidance)).toEqual([
      "Missing capability: mutate:pages:ship",
      "Required candidates: mutate:pages:ship, mutate:pages:*, execute:group:pages",
      "Inspect: ravi permissions materialize --subject-type agent --subject-id dev --json",
      "Recurring access: Use ravi permissions allow permission-mutate-pages-ship --to agent:dev --capabilities mutate:pages:ship --apply for recurring access.",
      "Fallback: Use raw capability mutate:pages:ship only as temporary/bootstrap material when no profile/tag exists yet.",
      "Break-glass: full-access is break-glass and requires explicit operator approval.",
    ]);
  });

  it("names a matching provider-owned tag in the allow command", () => {
    dbCreateTagDefinition({
      slug: "permission-pages-publisher",
      label: "Pages Publisher",
      kind: "system",
      source: "permissions",
      metadata: {
        permissions: {
          capabilities: ["execute:group:pages"],
        },
      },
    });

    const guidance = buildAuthorizationGuidance({
      capability: { permission: "mutate", objectType: "pages", objectId: "ship" },
      candidates: [
        { permission: "mutate", objectType: "pages", objectId: "ship" },
        { permission: "execute", objectType: "group", objectId: "pages" },
      ],
      subject: { type: "agent", id: "dev" },
      scope: "recurring",
      includeProviderOwnedTags: true,
    });

    expect(guidance.preferredPath.suggestedTags.map((tag) => tag.slug)).toEqual(["permission-pages-publisher"]);
    expect(guidance.preferredPath.allowCommand).toBe(
      "ravi permissions allow permission-pages-publisher --to agent:dev --apply",
    );
    expect(guidance.preferredPath.message).toContain("Pages Publisher");
  });

  it("builds an allow command without a subject when none is known", () => {
    expect(
      buildRecurringAllowCommand({
        capability: { permission: "execute", objectType: "group", objectId: "daemon" },
      }),
    ).toBe("ravi permissions allow permission-execute-group-daemon --capabilities execute:group:daemon --apply");
  });
});
