import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { dbCreateTagDefinition, dbFindTagBindings } from "../../tags/index.js";
import { getContact, upsertContact } from "../../contacts.js";
import { getDb } from "../../router/router-db.js";
import { ContractError } from "../agent-contract.js";
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

// Positional call helpers: attach/detach/search carry one parameter per target
// flag, so tests fill the tuple and set only the meaningful positions.
function callAttach(commands: TagCommands, slug: string, targetSelector: string, asJson?: boolean) {
  const args = new Array(31).fill(undefined) as unknown as Parameters<TagCommands["attach"]>;
  args[0] = slug;
  args[27] = targetSelector;
  args[30] = asJson;
  return commands.attach(...args);
}

function callDetach(commands: TagCommands, slug: string, targetSelector: string, asJson?: boolean) {
  const args = new Array(30).fill(undefined) as unknown as Parameters<TagCommands["detach"]>;
  args[0] = slug;
  args[27] = targetSelector;
  args[29] = asJson;
  return commands.detach(...args);
}

function callSearch(commands: TagCommands, options: { slug?: string; asJson?: boolean; fields?: string }) {
  const args = new Array(36).fill(undefined) as unknown as Parameters<TagCommands["search"]>;
  args[0] = options.slug;
  args[30] = options.asJson;
  args[35] = options.fields;
  return commands.search(...args);
}

describe("tags agent-first contract", () => {
  let previousSessionKey: string | undefined;

  beforeEach(() => {
    // hasContext() true → the contract helpers (and fail()) throw instead of
    // calling process.exit, so tests can assert the ContractError envelope.
    previousSessionKey = process.env.RAVI_SESSION_KEY;
    process.env.RAVI_SESSION_KEY = "agent:test:main";
  });

  afterEach(() => {
    if (previousSessionKey === undefined) delete process.env.RAVI_SESSION_KEY;
    else process.env.RAVI_SESSION_KEY = previousSessionKey;
    previousSessionKey = undefined;
  });

  function expectContractError(run: () => unknown): InstanceType<typeof ContractError> {
    let thrown: unknown;
    try {
      withoutLogs(run);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    return thrown as InstanceType<typeof ContractError>;
  }

  it("emits TAG_NOT_FOUND envelope with suggestions on tags show --json (exit 1)", () => {
    dbCreateTagDefinition({ slug: "lifecycle:new", label: "Lifecycle New" });
    dbCreateTagDefinition({ slug: "lifecycle:qualified", label: "Lifecycle Qualified" });
    const commands = new TagCommands();
    const contractError = expectContractError(() => commands.show("lifecycle:nwe", true));
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("tags show");
    expect(envelope.error.code).toBe("TAG_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("lifecycle:new");
    expect((envelope.error.suggestions as string[]).length).toBeLessThanOrEqual(3);
  });

  it("maps the DB throw on tags set to the TAG_NOT_FOUND envelope (exit 1)", () => {
    dbCreateTagDefinition({ slug: "ghost-tag-real", label: "Ghost Real" });
    const commands = new TagCommands();
    const contractError = expectContractError(() => commands.set("ghost-tag", "label", "Ghost", true));
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("tags set");
    expect(envelope.error.code).toBe("TAG_NOT_FOUND");
    expect(envelope.error.suggestions).toContain("ghost-tag-real");
  });

  it("fails tags attach on an unknown tag with TAG_NOT_FOUND and writes no binding", () => {
    dbCreateTagDefinition({ slug: "ghost-tag-real", label: "Ghost Real" });
    upsertContact("5511990001111", "Contract Target", "allowed", "manual");
    const contactId = getContact("5511990001111")!.id;
    const commands = new TagCommands();
    const contractError = expectContractError(() => callAttach(commands, "ghost-tag", `contact:${contactId}`, true));
    expect(contractError.exitCode).toBe(1);
    const envelope = contractError.envelope();
    expect(envelope.op).toBe("tags attach");
    expect(envelope.error.code).toBe("TAG_NOT_FOUND");
    expect(dbFindTagBindings({})).toHaveLength(0);
  });

  it("fails tags detach on an unknown tag with TAG_NOT_FOUND, keeping the legacy path for a missing binding", () => {
    dbCreateTagDefinition({ slug: "present-tag", label: "Present" });
    upsertContact("5511990002222", "Detach Target", "allowed", "manual");
    const contactId = getContact("5511990002222")!.id;
    const commands = new TagCommands();

    const contractError = expectContractError(() => callDetach(commands, "ghost-tag", `contact:${contactId}`, true));
    expect(contractError.exitCode).toBe(1);
    expect(contractError.envelope().error.code).toBe("TAG_NOT_FOUND");

    // Known tag but no binding: declared legacy text path (plain Error via fail()).
    let thrown: unknown;
    try {
      withoutLogs(() => callDetach(commands, "present-tag", `contact:${contactId}`, true));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ContractError);
    expect((thrown as Error).message).toContain("Binding not found");
  });

  it("supports --fields compact mode on tags list", () => {
    dbCreateTagDefinition({ slug: "fields-a", label: "Fields A" });
    dbCreateTagDefinition({ slug: "fields-b", label: "Fields B" });
    const commands = new TagCommands();
    const payload = withoutLogs(() =>
      commands.list(undefined, undefined, "fields-", true, undefined, undefined, undefined, undefined, "slug,kind"),
    );
    expect(payload.items).toHaveLength(2);
    for (const item of payload.items) {
      expect(Object.keys(item as unknown as Record<string, unknown>).sort()).toEqual(["kind", "slug"]);
    }
  });

  it("supports --fields compact mode on tags search", () => {
    dbCreateTagDefinition({ slug: "search-fields", label: "Search Fields" });
    upsertContact("5511990003333", "Search Target", "allowed", "manual");
    const contactId = getContact("5511990003333")!.id;
    const commands = new TagCommands();
    withoutLogs(() => callAttach(commands, "search-fields", `contact:${contactId}`, true));

    const payload = withoutLogs(() => callSearch(commands, { slug: "search-fields", asJson: true, fields: "tagSlug" }));
    expect(payload.items).toHaveLength(1);
    expect(Object.keys(payload.items[0] as unknown as Record<string, unknown>)).toEqual(["tagSlug"]);
  });
});
