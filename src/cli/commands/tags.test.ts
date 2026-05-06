import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbCreateTagDefinition } from "../../tags/index.js";
import { getDb } from "../../router/router-db.js";
import { TagCommands } from "./tags.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("tags-cli-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function withoutLogs<T>(run: () => T): T {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return run();
  } finally {
    console.log = originalLog;
  }
}

describe("TagCommands", () => {
  it("returns bounded list pages with next cursor metadata", () => {
    const tags = ["cli-page-test-a", "cli-page-test-b", "cli-page-test-c"].map((slug) =>
      dbCreateTagDefinition({
        slug,
        label: slug,
      }),
    );

    const db = getDb();
    tags.forEach((tag, index) => {
      db.prepare("UPDATE tag_definitions SET updated_at = ? WHERE slug = ?").run(2000 + index, tag.slug);
    });

    const commands = new TagCommands();
    const pageOne = withoutLogs(() =>
      commands.list(undefined, undefined, "cli-page-test-", true, "2", undefined, "updated", "asc"),
    );

    expect(pageOne.page).toMatchObject({
      limit: 2,
      count: 2,
      hasMore: true,
      sort: "updated",
      order: "asc",
    });
    expect(pageOne.tags.map((tag) => tag.slug)).toEqual(["cli-page-test-a", "cli-page-test-b"]);
    expect(typeof pageOne.page.nextCursor).toBe("string");

    const pageTwo = withoutLogs(() =>
      commands.list(
        undefined,
        undefined,
        "cli-page-test-",
        true,
        "2",
        pageOne.page.nextCursor ?? undefined,
        "updated",
        "asc",
      ),
    );

    expect(pageTwo.page.hasMore).toBe(false);
    expect(pageTwo.tags.map((tag) => tag.slug)).toEqual(["cli-page-test-c"]);
  });
});
